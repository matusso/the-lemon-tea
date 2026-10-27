import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { anonymousContext, userContext } from "@lemon-tea/auth";
import { F1LiveTimingProvider, subscriptionTokenFromJwt } from "@lemon-tea/provider-f1-livetiming";
import type { AccountProviderTools } from "@lemon-tea/domain";
import { login, makeHarness } from "./harness.ts";

// SYNTHETIC live timing archive in the feed's shape (not real F1 data).
const z = (o: unknown) => `"${deflateRawSync(Buffer.from(JSON.stringify(o))).toString("base64")}"`;
const stream = (...lines: string[]) => "﻿" + lines.join("\r\n") + "\r\n";
const index = {
  Year: 2025,
  Meetings: [
    {
      Key: 9000,
      Name: "Synthetic Grand Prix",
      Location: "Nowhere",
      Country: { Name: "Synthetica" },
      Circuit: { Key: 77, ShortName: "Synth" },
      Sessions: [{ Key: 9001, Type: "Qualifying", Name: "Qualifying", StartDate: "2025-05-01T15:00:00", EndDate: "2025-05-01T16:00:00", GmtOffset: "01:00:00", Path: "2025/synthetic/q/" }],
    },
  ],
};
const carEntries = Array.from({ length: 20 }, (_, i) => ({ Utc: new Date(Date.UTC(2025, 4, 1, 14, 2, 31) + i * 250).toISOString(), Cars: { "1": { Channels: { "0": 11000, "2": 280 + i, "3": 7, "4": 100, "5": 0 } } } }));
const FILES: Record<string, string> = {
  "Index.json": JSON.stringify(index),
  "Heartbeat.jsonStream": stream('00:00:10.000{"Utc":"2025-05-01T14:00:10.000Z"}'),
  "DriverList.jsonStream": stream('00:00:00.100{"1":{"Tla":"SYN","FullName":"Synthetic Driver","TeamName":"Synthetic","TeamColour":"E8D44D"}}'),
  "TimingData.jsonStream": stream(
    '00:01:00.000{"Lines":{"1":{"InPit":false}}}',
    '00:02:30.000{"Lines":{"1":{"NumberOfLaps":1,"Sectors":{"2":{"Value":"40.000"}}}}}',
    '00:04:00.000{"Lines":{"1":{"NumberOfLaps":2,"LastLapTime":{"Value":"1:30.000"},"Position":"1"}}}',
  ),
  "CarData.z.jsonStream": stream(`00:02:31.000${z({ Entries: carEntries })}`),
};

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (exp: number) => `${b64url({ alg: "RS256" })}.${b64url({ exp })}.sig`;
const ENC_KEY = randomBytes(32).toString("base64url");
const VALID = fakeJwt(Math.floor(Date.now() / 1000) + 3600);

async function setup() {
  const seenTokens: string[] = [];
  let reject = false;
  const signIn = vi.fn(async (u: string, p: string) => {
    if (u !== "fan@example.test" || p !== "correct horse") throw new Error("Invalid username or password");
    return subscriptionTokenFromJwt(VALID);
  });
  const tools: AccountProviderTools = { name: "Formula 1 account", signIn, parseToken: subscriptionTokenFromJwt };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenTokens.push(String((init?.headers as Record<string, string>).authorization));
    if (reject) return new Response("", { status: 401 });
    const body = FILES[String(url).split("/").at(-1)!];
    return body ? new Response(body) : new Response("", { status: 404 });
  }) as typeof fetch;
  const h = await makeHarness({
    encryptionKey: ENC_KEY,
    accountProviders: { f1lt: tools },
    configure: (providers, services) =>
      providers.registerScoped(
        "f1lt",
        (tenantId) =>
          new F1LiveTimingProvider({
            token: () => services.connections.tokenFor(tenantId, "f1lt"),
            onUnauthorized: () => services.connections.markExpired(tenantId, "f1lt"),
            fetchImpl,
            requestsPerSecond: 1000,
          }),
      ),
  });
  h.store.sources.push({ ...h.store.sources[0]!, id: "f1lt", publicDisplayAllowed: false, redistribution: "forbidden" });
  return { ...h, signIn, seenTokens, rejectTokens: () => (reject = true) };
}

type App = Awaited<ReturnType<typeof setup>>["app"];
const post = (app: App, path: string, cookie: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json", "x-requested-with": "lemon-tea" }, body: JSON.stringify(body) });

describe("Formula 1 account connection", () => {
  it("signs in through the provider, stores only an encrypted token and returns status only", async () => {
    const { app, store, signIn, alice } = await setup();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    const r = await post(app, "/api/connections/f1lt/sign-in", cookie, { username: "fan@example.test", password: "correct horse" });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ provider: "f1lt", status: "connected", method: "password" });
    expect(text).not.toContain(VALID);
    expect(text).not.toContain("correct horse");
    expect(signIn).toHaveBeenCalledWith("fan@example.test", "correct horse");

    const row = store.connections.get(`${alice.tenantId}:f1lt`)!;
    expect(Buffer.from(row.secret!).toString("utf8")).not.toContain(VALID.slice(0, 20));
    expect(JSON.stringify(row.config)).not.toContain("correct horse");
    expect(JSON.stringify(store.auditLog)).not.toContain("correct horse");
  });

  it("surfaces a failed sign-in without storing anything", async () => {
    const { app, store } = await setup();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    const r = await post(app, "/api/connections/f1lt/sign-in", cookie, { username: "fan@example.test", password: "wrong" });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/Invalid username or password/);
    expect(store.connections.size).toBe(0);
  });

  it("is per tenant, unavailable to anonymous callers and MCP, and bound to its tenant", async () => {
    const { app, services, store, alice, bob } = await setup();
    const aliceCookie = await login(app, "alice@example.test", "alice-password-123");
    const bobCookie = await login(app, "bob@example.test", "bob-password-1234");
    await post(app, "/api/connections/f1lt/token", aliceCookie, { token: VALID });

    expect(await (await app.request("/api/connections/f1lt", { headers: { cookie: bobCookie } })).json()).toMatchObject({ status: "not_connected" });
    expect((await app.request("/api/connections/f1lt")).status).toBe(401);
    await expect(services.connections.status(userContext(alice, "mcp", ["sessions:read"]), "f1lt")).rejects.toThrow(/web app or REST API/);
    await expect(services.connections.status(anonymousContext("web"), "f1lt")).rejects.toThrow(/Sign in/);

    expect(await services.connections.tokenFor(alice.tenantId, "f1lt")).toBe(VALID);
    expect(await services.connections.tokenFor(bob.tenantId, "f1lt")).toBeNull();
    // A ciphertext copied into another tenant's row does not decrypt (AES-GCM associated data).
    const row = store.connections.get(`${alice.tenantId}:f1lt`)!;
    store.connections.set(`${bob.tenantId}:f1lt`, { ...row });
    expect(await services.connections.tokenFor(bob.tenantId, "f1lt")).toBeNull();
  });

  it("rejects expired or malformed pasted tokens and rate-limits attempts", async () => {
    const { app } = await setup();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    expect((await post(app, "/api/connections/f1lt/token", cookie, { token: fakeJwt(1_000_000) })).status).toBe(400);
    expect((await post(app, "/api/connections/f1lt/token", cookie, { token: "x".repeat(40) })).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(app, "/api/connections/f1lt/token", cookie, { token: "y".repeat(40) })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("disconnects", async () => {
    const { app, services, alice } = await setup();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    await post(app, "/api/connections/f1lt/token", cookie, { token: VALID });
    const r = await app.request("/api/connections/f1lt", { method: "DELETE", headers: { cookie, "x-requested-with": "lemon-tea" } });
    expect(await r.json()).toEqual({ disconnected: true });
    expect(await services.connections.tokenFor(alice.tenantId, "f1lt")).toBeNull();
  });
});

describe("F1 live timing ingestion", () => {
  it("uses the tenant's own token, is private-only and invisible to other tenants", async () => {
    const { app, services, alice, seenTokens } = await setup();
    const aliceCookie = await login(app, "alice@example.test", "alice-password-123");
    const bobCookie = await login(app, "bob@example.test", "bob-password-1234");
    const ctx = userContext({ ...alice, role: "admin" }, "web");

    await expect(services.ingestion!.ingest(ctx, { sessionId: "f1lt:2025-9001", channels: ["timing"], visibility: "private" })).rejects.toThrow(/No Formula 1 account is connected/);
    await post(app, "/api/connections/f1lt/token", aliceCookie, { token: VALID });
    await expect(services.ingestion!.ingest(ctx, { sessionId: "f1lt:2025-9001", channels: ["timing"], visibility: "public" })).rejects.toThrow(/only be ingested privately/);

    const r = await services.ingestion!.ingest(ctx, { sessionId: "f1lt:2025-9001", channels: ["timing", "car_data"], visibility: "private" });
    expect(r).toMatchObject({ owner: "private", drivers: 1, laps: 2, carSamples: 20 });
    expect(new Set(seenTokens.slice(-3))).toEqual(new Set([`Bearer ${VALID}`]));

    const laps = await app.request("/api/sessions/f1lt%3A2025-9001/laps/1", { headers: { cookie: aliceCookie } });
    expect(laps.status).toBe(200);
    expect(JSON.stringify(await laps.json())).toContain("90");
    expect((await app.request("/api/sessions/f1lt%3A2025-9001/laps/1", { headers: { cookie: bobCookie } })).status).toBe(404);
    expect((await app.request("/api/sessions/f1lt%3A2025-9001/laps/1")).status).toBe(404);
  });

  it("marks the connection expired when live timing rejects the token", async () => {
    const { app, services, alice, rejectTokens } = await setup();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    await post(app, "/api/connections/f1lt/token", cookie, { token: VALID });
    rejectTokens();
    await expect(services.ingestion!.discover(userContext({ ...alice, role: "admin" }, "web"), "f1lt", 2025)).rejects.toThrow(/Sign in again/);
    expect(await (await app.request("/api/connections/f1lt", { headers: { cookie } })).json()).toMatchObject({ status: "expired" });
  });
});
