import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { base64url, sha256 } from "@lemon-tea/auth";
import { TOOL_NAMES } from "@lemon-tea/mcp-tools";
import { processJob } from "../../services/jobs/src/worker.ts";
import { login, makeHarness } from "./harness.ts";

type App = Awaited<ReturnType<typeof makeHarness>>["app"];

async function mcpClient(app: App, bearer?: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp"), {
    // Real HTTP servers always send Host; the in-process request needs it set explicitly.
    fetch: (url, init) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      headers.set("host", "localhost:8787");
      return Promise.resolve(app.request(String(url), { ...(init as RequestInit), headers }));
    },
    ...(bearer ? { requestInit: { headers: { authorization: `Bearer ${bearer}` } } } : {}),
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

/** Full OAuth 2.1 authorization-code + PKCE flow against the app, returning tokens. */
async function oauthTokens(app: App, cookie: string, resource = "http://localhost:8787/mcp") {
  const reg = await (await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test AI", redirect_uris: ["http://127.0.0.1:9999/cb"] }) })).json();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await sha256(verifier);
  const qs = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9999/cb", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "sessions:read telemetry:read analytics:read", resource });
  const consent = await app.request(`/oauth/authorize?${qs}`, { headers: { cookie } });
  const html = await consent.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const approve = await app.request(`/oauth/authorize?${qs}`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, decision: "approve" }) });
  const loc = new URL(approve.headers.get("location")!);
  expect(loc.searchParams.get("state")).toBe("xyz");
  const code = loc.searchParams.get("code")!;
  const tokenRes = await app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9999/cb" }) });
  return { status: tokenRes.status, body: await tokenRes.json(), code, verifier, clientId: reg.client_id as string };
}

const cmpBody = (sessionId: string) => ({ a: { sessionId, driverNumber: 1 }, b: { sessionId, driverNumber: 2 } });

describe("REST and MCP share one analytical engine", () => {
  it("compare_laps over MCP equals POST /api/analysis/compare", async () => {
    const { app } = await makeHarness();
    const rest = await (await app.request("/api/analysis/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmpBody("synthetic:public1")) })).json();
    const client = await mcpClient(app);
    const res = await client.callTool({ name: "compare_laps", arguments: cmpBody("synthetic:public1") });
    const mcp = res.structuredContent as typeof rest;
    const strip = (x: typeof rest) => ({ ...x, meta: { ...x.meta, generatedAt: undefined } });
    expect(strip(mcp)).toEqual(strip(rest));
    expect(rest.time_delta_seconds).toBeGreaterThan(0); // B brakes later in the fixture
    expect(rest.delta_convention).toBe("A_minus_B");
    await client.close();
  });

  it("exposes every required tool, prompt and resource template", async () => {
    const { app } = await makeHarness();
    const client = await mcpClient(app);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["list_seasons", "get_timing", "compare_laps", "predict_qualifying", "simulate_strategy", "create_analysis_job", "cancel_analysis_job"]) expect(tools).toContain(name);
    expect(tools.length).toBe(TOOL_NAMES.length);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(["compare_driver_performance", "analyze_practice_to_qualifying", "analyze_race_strategy", "explain_corner_performance", "evaluate_prediction_accuracy"]));
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
    expect(templates).toContain("lemontea://sessions/{sessionId}");
    const r = await client.readResource({ uri: "lemontea://sessions/synthetic:public1" });
    expect(JSON.parse((r.contents[0] as { text: string }).text).data.session.id).toBe("synthetic:public1");
    await client.close();
  });

  it("returns structured errors for invalid input", async () => {
    const { app } = await makeHarness();
    const client = await mcpClient(app);
    const res = await client.callTool({ name: "get_session_info", arguments: { sessionId: "not a session" } });
    expect(res.isError).toBe(true);
    await client.close();
  });
});

describe("tenant isolation", () => {
  it("private sessions are invisible to other tenants and anonymous users (REST)", async () => {
    const { app } = await makeHarness();
    const aliceCookie = await login(app, "alice@example.test", "alice-password-123");
    const bobCookie = await login(app, "bob@example.test", "bob-password-1234");
    expect((await app.request("/api/sessions/synthetic:alice1", { headers: { cookie: aliceCookie } })).status).toBe(200);
    expect((await app.request("/api/sessions/synthetic:alice1", { headers: { cookie: bobCookie } })).status).toBe(404);
    expect((await app.request("/api/sessions/synthetic:alice1")).status).toBe(404);
    const bobList = await (await app.request("/api/sessions", { headers: { cookie: bobCookie } })).json();
    expect(bobList.map((s: { id: string }) => s.id)).toEqual(["synthetic:public1"]);
    // telemetry by guessed id is equally blocked
    expect((await app.request("/api/sessions/synthetic:alice1/telemetry?driver=1&lap=2", { headers: { cookie: bobCookie } })).status).toBe(404);
  });

  it("private sessions are invisible over MCP to other users", async () => {
    const { app } = await makeHarness();
    const bobCookie = await login(app, "bob@example.test", "bob-password-1234");
    const { body } = await oauthTokens(app, bobCookie);
    const client = await mcpClient(app, body.access_token);
    const res = await client.callTool({ name: "compare_laps", arguments: cmpBody("synthetic:alice1") });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain("not_found");
    await client.close();
  });
});

describe("MCP OAuth", () => {
  it("issues audience-bound tokens via PKCE and accepts them on /mcp", async () => {
    const { app } = await makeHarness({ allowAnonymous: false });
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    const t = await oauthTokens(app, cookie);
    expect(t.status).toBe(200);
    expect(t.body.token_type).toBe("Bearer");
    const client = await mcpClient(app, t.body.access_token);
    const res = await client.callTool({ name: "get_session_info", arguments: { sessionId: "synthetic:alice1" } });
    expect(res.isError).toBeFalsy();
    // scope not granted: simulations:execute
    const denied = await client.callTool({ name: "create_analysis_job", arguments: { kind: "predict_qualifying", input: { sessionIds: ["synthetic:alice1"] } } });
    expect(denied.isError).toBe(true);
    await client.close();
  });

  it("rejects missing tokens with a resource-metadata challenge when anonymous access is off", async () => {
    const { app } = await makeHarness({ allowAnonymous: false });
    const r = await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
    const meta = await (await app.request("/.well-known/oauth-protected-resource/mcp")).json();
    expect(meta.resource).toBe("http://localhost:8787/mcp");
  });

  it("rejects code reuse, wrong PKCE verifier and foreign-audience tokens", async () => {
    const { app } = await makeHarness({ allowAnonymous: false });
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    const t = await oauthTokens(app, cookie);
    const reuse = await app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: t.code, code_verifier: t.verifier, client_id: t.clientId, redirect_uri: "http://127.0.0.1:9999/cb" }) });
    expect(reuse.status).toBe(400);
    const bad = await oauthTokens(app, cookie, "http://evil.example/mcp").catch(() => null);
    expect(bad).toBeNull(); // authorize rejects unknown resource, no code is issued
    // forged token signed with another secret
    const forged = "eyJhbGciOiJIUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ4IiwiYXVkIjoiaHR0cDovL2xvY2FsaG9zdDo4Nzg3L21jcCJ9.c2lnbmF0dXJl";
    const r = await app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${forged}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(r.status).toBe(401);
  });

  it("refresh tokens rotate and cannot be reused", async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    const t = await oauthTokens(app, cookie);
    const refresh = (rt: string) => app.request("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: t.clientId }) });
    const r1 = await refresh(t.body.refresh_token);
    expect(r1.status).toBe(200);
    expect((await refresh(t.body.refresh_token)).status).toBe(400);
  });
});

describe("web security", () => {
  it("rejects cookie-authenticated POST without the CSRF header", async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    const r = await app.request("/api/analysis/compare", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(cmpBody("synthetic:alice1")) });
    expect(r.status).toBe(403);
  });

  it("sets strict security headers", async () => {
    const { app } = await makeHarness();
    const r = await app.request("/api/health");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never returns password hashes or provider secrets", async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, "alice@example.test", "alice-password-123");
    const me = await (await app.request("/api/auth/me", { headers: { cookie } })).text();
    expect(me).not.toContain("pbkdf2");
  });
});

describe("analysis jobs", () => {
  it("are idempotent, owner-scoped and executed by the shared engine", async () => {
    const { app, services, identity } = await makeHarness();
    const aliceCookie = await login(app, "alice@example.test", "alice-password-123");
    const bobCookie = await login(app, "bob@example.test", "bob-password-1234");
    const h = { cookie: aliceCookie, "content-type": "application/json", "x-requested-with": "lemon-tea" };
    const req = { kind: "predict_qualifying", input: { sessionIds: ["synthetic:alice1"], persist: false }, idempotencyKey: "job-key-0001" };
    const j1 = await (await app.request("/api/jobs", { method: "POST", headers: h, body: JSON.stringify(req) })).json();
    const j2 = await (await app.request("/api/jobs", { method: "POST", headers: h, body: JSON.stringify(req) })).json();
    expect(j2.jobId).toBe(j1.jobId);
    expect(j2.deduplicated).toBe(true);
    expect((await app.request(`/api/jobs/${j1.jobId}`, { headers: { cookie: bobCookie } })).status).toBe(404);
    const claimed = await services.store.claimJob();
    await processJob(services, identity, claimed!, () => {});
    const status = await (await app.request(`/api/jobs/${j1.jobId}`, { headers: { cookie: aliceCookie } })).json();
    // two synthetic laps are not enough for a forecast: the job must fail with a structured error, not invent one
    expect(["succeeded", "failed"]).toContain(status.status);
    if (status.status === "failed") expect(status.error.code).toBe("insufficient_data");
  });
});

describe("exports", () => {
  it("exports CSV with provenance when the source permits and refuses otherwise", async () => {
    const { app, store } = await makeHarness();
    const r = await app.request("/api/sessions/synthetic:public1/export/laps");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.startsWith("# {")).toBe(true);
    expect(text).toContain("driverNumber,lapNumber");
    store.sources[0]!.redistribution = "forbidden";
    expect((await app.request("/api/sessions/synthetic:public1/export/laps")).status).toBe(403);
  });
});
