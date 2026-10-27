import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  carSamplesFromStream,
  F1LiveTimingProvider,
  F1LiveFeed,
  lapsForDriver,
  localToUtc,
  parseDrivers,
  parseFrontendConfig,
  parseGap,
  parseJsonStream,
  parseLapTime,
  parseOffset,
  parseStints,
  positionSamplesFromStream,
  signIn,
  splitTimingByDriver,
  subscriptionTokenFromJwt,
  timeOrigin,
  type JsonObject,
  type WebSocketLike,
} from "./index.ts";

// All records below are hand-written in the live timing feed shape; values are synthetic.

const z = (o: unknown) => `"${deflateRawSync(Buffer.from(JSON.stringify(o))).toString("base64")}"`;
const line = (offset: string, payload: string) => `${offset}${payload}`;
const stream = (...lines: string[]) => "﻿" + lines.join("\r\n") + "\r\n";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;

describe("stream decoding", () => {
  it("parses offsets and lap times", () => {
    expect(parseOffset("01:02:03.456")).toBe(3_723_456);
    expect(parseLapTime("1:18.792")).toBeCloseTo(78.792);
    expect(parseLapTime("26.123")).toBeCloseTo(26.123);
    expect(parseLapTime("")).toBeNull();
    expect(parseLapTime("abc")).toBeUndefined();
  });

  it("decodes .jsonStream and raw-deflated .z records, counting bad lines", async () => {
    const plain = await parseJsonStream(stream(line("00:00:01.000", '{"a":1}'), line("00:00:03.000", "{broken")));
    expect(plain.records).toEqual([{ offsetMs: 1000, data: { a: 1 } }]);
    expect(plain.decodeErrors).toBe(1);
    const zipped = await parseJsonStream(stream(line("00:00:02.500", z({ b: 2 }))), true);
    expect(zipped.records).toEqual([{ offsetMs: 2500, data: { b: 2 } }]);
  });

  it("converts local session times with GMT offset to UTC", () => {
    expect(localToUtc("2025-09-06T16:00:00", "02:00:00")).toBe("2025-09-06T14:00:00.000Z");
    expect(localToUtc("2025-12-07T17:00:00", "-03:00:00")).toBe("2025-12-07T20:00:00.000Z");
  });

  it("derives the time origin from the least delayed record", () => {
    expect(timeOrigin([{ offsetMs: 1000, utc: 10_000 }, { offsetMs: 2000, utc: 11_200 }])).toBe(9200);
  });

  it("parses gaps", () => {
    expect(parseGap("+1.234")).toEqual({ seconds: 1.234, lapsDown: null });
    expect(parseGap("1L")).toEqual({ seconds: null, lapsDown: 1 });
    expect(parseGap("LAP 12")).toEqual({ seconds: 0, lapsDown: null });
  });
});

describe("timing reconstruction (FastF1 rules)", () => {
  const rec = (offsetMs: number, data: JsonObject) => ({ offsetMs, data: { Lines: { "1": data } } as JsonObject });

  it("builds laps with sectors, speed traps, pit out flag and synchronised end times", () => {
    const records = [
      rec(0, { InPit: true }),
      rec(10_000, { InPit: false, PitOut: true }),
      rec(100_000, { NumberOfLaps: 1, Sectors: { "2": { Value: "30.000" } } }), // out lap ends
      rec(130_000, { Sectors: { "0": { Value: "30.000" } }, Speeds: { I1: { Value: "300" } } }),
      rec(160_000, { Sectors: { "1": { Value: "30.000" } } }),
      rec(190_100, { NumberOfLaps: 2, Sectors: { "2": { Value: "30.000" } }, LastLapTime: { Value: "1:30.000" }, Speeds: { ST: { Value: "320" } } }),
      rec(195_000, { Position: "1", GapToLeader: "LAP 2" }),
    ];
    const t = lapsForDriver(splitTimingByDriver(records).get("1")!)!;
    expect(t.laps).toHaveLength(2);
    const [l1, l2] = t.laps;
    expect(l1!.numberOfLaps).toBe(1);
    expect(l1!.pitOutTime).toBe(10_000);
    expect(l2!.lapTime).toBe(90_000);
    expect(l2!.sector).toEqual([30_000, 30_000, 30_000]);
    expect(l2!.speedI1).toBe(300);
    // Lap end is the earliest sector-derived candidate: 130 000 + 30 000 + 30 000 = 190 000.
    expect(l2!.time).toBe(190_000);
    expect(l1!.time).toBe(100_000);
    expect(t.stream.at(-1)).toMatchObject({ position: 1, gapToLeader: "LAP 2" });
  });

  it("rejects a >150 s 'lap time' between qualifying segments unless the sectors add up to it", () => {
    const records = [
      rec(0, { InPit: false }),
      rec(80_000, { NumberOfLaps: 1, LastLapTime: { Value: "1:20.000" } }),
      rec(500_000, { NumberOfLaps: 2, LastLapTime: { Value: "7:00.000" } }),
    ];
    const t = lapsForDriver(splitTimingByDriver(records).get("1")!)!;
    expect(t.laps.map((l) => l.lapTime)).toEqual([80_000, NaN]);
  });

  it("drops a lap time that is shorter than its sectors (integrity error)", () => {
    const records = [
      rec(0, { InPit: false }),
      rec(90_000, { NumberOfLaps: 1, Sectors: { "0": { Value: "40.000" }, "1": { Value: "40.000" }, "2": { Value: "40.000" } }, LastLapTime: { Value: "1:30.000" } }),
    ];
    const t = lapsForDriver(splitTimingByDriver(records).get("1")!)!;
    expect(Number.isNaN(t.laps[0]!.lapTime)).toBe(true);
    expect(t.integrityErrors).toContain(1);
  });
});

describe("normalisation", () => {
  it("parses drivers, ignoring late declarations", () => {
    const d = parseDrivers([
      { offsetMs: 0, data: { "1": { Tla: "VER", FullName: "Max VERSTAPPEN", TeamName: "Red Bull Racing", TeamColour: "3671c6" } } },
      { offsetMs: 2 * 3600_000, data: { "99": { Tla: "LAT" } } },
    ]);
    expect(d).toEqual([{ driverNumber: 1, code: "VER", fullName: "Max VERSTAPPEN", teamName: "Red Bull Racing", teamColour: "3671C6" }]);
  });

  it("merges stints from list and index-keyed forms", () => {
    const s = parseStints([
      { offsetMs: 0, data: { Lines: { "4": { Stints: [{ Compound: "MEDIUM", New: "true", StartLaps: 0 }] } } } },
      { offsetMs: 5000, data: { Lines: { "4": { Stints: { "1": { Compound: "HARD", StartLaps: 3 } } } } } },
    ]);
    expect(s.get("4")).toEqual([
      { firstSeen: 0, compound: "MEDIUM", startLaps: 0 },
      { firstSeen: 5000, compound: "HARD", startLaps: 3 },
    ]);
  });

  it("decodes car data channels and positions (1/10 m → m), skipping no-fix samples", () => {
    const car = carSamplesFromStream([
      { offsetMs: 1000, data: { Entries: [{ Utc: "2025-09-06T14:00:01.1234567Z", Cars: { "1": { Channels: { "0": 11000, "2": 300, "3": 8, "4": 104, "5": 100, "45": 12 } } } }] } },
    ]);
    expect(car.t0).toBe(Date.parse("2025-09-06T14:00:00.123Z"));
    expect(car.car.get(1)).toMatchObject({ speed: [300], throttle: [100], brake: [1], rpm: [11000], gear: [8], drs: [12] });
    const pos = positionSamplesFromStream([
      { offsetMs: 0, data: { Position: [{ Timestamp: "2025-09-06T14:00:01.000Z", Entries: { "1": { Status: "OnTrack", X: 10118, Y: 12077, Z: 1925 }, "4": { X: 0, Y: 0, Z: 0 } } }] } },
    ]);
    expect(pos.get(1)!.x[0]).toBeCloseTo(1011.8);
    expect(pos.has(4)).toBe(false);
  });

  it("omits DRS when the channel is absent (2026)", () => {
    const car = carSamplesFromStream([{ offsetMs: 0, data: { Entries: [{ Utc: "2026-03-07T05:00:00Z", Cars: { "1": { Channels: { "0": 10000, "2": 290, "3": 8, "4": 100, "5": 0 } } } }] } }]);
    expect(car.car.get(1)!.drs).toBeUndefined();
  });
});

describe("F1 account sign-in", () => {
  it("reads the public client config from the account frontend", () => {
    expect(parseFrontendConfig('x={davinci:{clientId:"abc",acrValues:"pol1",region:"eu"}}')).toEqual({ clientId: "abc", policyId: "pol1" });
    expect(() => parseFrontendConfig("nothing")).toThrow(/not found/);
  });

  it("runs the PKCE flow, sends credentials only to id.formula1.com and returns the subscription token", async () => {
    const sub = jwt({ exp: 2_000_000_000 });
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const u = new URL(url);
      if (u.pathname === "/scripts/main.min.js") return new Response('a={davinci:{clientId:"cid",acrValues:"pol"}}');
      if (u.pathname === "/as/authorize") {
        return new Response(JSON.stringify({ id: "flow", eventName: "continue", interactionId: "ix", _links: { next: { href: "https://id.formula1.com/davinci/next" } } }), {
          headers: { "set-cookie": "ST=abc; Path=/; Secure" },
        });
      }
      if (u.pathname.startsWith("/davinci")) {
        const state = new URL(calls.find((c) => c.url.includes("/as/authorize"))!.url).searchParams.get("state");
        return new Response(JSON.stringify({ status: "COMPLETED", authorizeResponse: { state, code: "code123" } }));
      }
      if (u.pathname === "/as/token") return new Response(JSON.stringify({ access_token: jwt({ subscriptionToken: sub }) }));
      return new Response("", { status: 404 });
    });
    const t = await signIn("me@example.com", "pw", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(t).toEqual({ value: sub, expiresAt: 2_000_000_000_000 });
    const withPassword = calls.filter((c) => String(c.init.body ?? "").includes('"pw"'));
    expect(withPassword.map((c) => new URL(c.url).hostname)).toEqual(["id.formula1.com"]);
    expect((calls[2]!.init.headers as Record<string, string>).cookie).toBe("ST=abc");
    expect(new URL(calls[1]!.url).searchParams.get("code_challenge_method")).toBe("S256");
    expect(String(calls[3]!.init.body)).toContain("code_verifier=");
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("refuses a submit URL outside the identity provider", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("main.min.js")) return new Response('{davinci:{clientId:"c",acrValues:"p"}}');
      return new Response(JSON.stringify({ id: "f", eventName: "e", interactionId: "i", _links: { next: { href: "https://evil.example/collect" } } }));
    });
    await expect(signIn("a", "b", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/Unexpected sign-in URL/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces the identity provider's failure message", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("main.min.js")) return new Response('{davinci:{clientId:"c",acrValues:"p"}}');
      if (url.includes("/as/authorize")) return new Response(JSON.stringify({ id: "f", eventName: "e", interactionId: "i", _links: { next: { href: "https://id.formula1.com/next" } } }));
      return new Response(JSON.stringify({ status: "FAILED", message: "Invalid username or password" }));
    });
    await expect(signIn("a", "b", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/Invalid username or password/);
  });

  it("reports an account without an F1 TV subscription", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("main.min.js")) return new Response('{davinci:{clientId:"c",acrValues:"p"}}');
      if (url.includes("/as/authorize")) return new Response(JSON.stringify({ id: "f", eventName: "e", interactionId: "i", _links: { next: { href: "https://id.formula1.com/next" } } }));
      if (url.includes("/as/token")) return new Response(JSON.stringify({ access_token: jwt({ sub: "x" }) }));
      const state = "";
      return new Response(JSON.stringify({ status: "COMPLETED", authorizeResponse: { state, code: "c" } }));
    });
    await expect(signIn("a", "b", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/state mismatch|F1 TV subscription/);
  });

  it("reads expiry and only the entitlement claims of a pasted token", () => {
    const t = subscriptionTokenFromJwt(` ${jwt({ exp: 1_900_000_000, SubscriptionStatus: "active", SubscribedProduct: "F1 TV Pro", Email: "someone@example.test", FirstName: "X" })} `);
    expect(t.expiresAt).toBe(1_900_000_000_000);
    expect(t.details).toEqual({ SubscriptionStatus: "active", SubscribedProduct: "F1 TV Pro" });
    expect(() => subscriptionTokenFromJwt("nope")).toThrow();
  });
});

describe("F1LiveTimingProvider", () => {
  const index = {
    Year: 2025,
    Meetings: [
      {
        Key: 1,
        Name: "Test Grand Prix",
        Location: "Testville",
        Country: { Name: "Nowhere" },
        Circuit: { Key: 7, ShortName: "Test" },
        Sessions: [{ Key: 42, Type: "Qualifying", Name: "Qualifying", StartDate: "2025-05-01T15:00:00", EndDate: "2025-05-01T16:00:00", GmtOffset: "01:00:00", Path: "2025/2025-05-02_Test_Grand_Prix/2025-05-01_Qualifying/" }],
      },
    ],
  };
  const files: Record<string, string> = {
    "Index.json": "﻿" + JSON.stringify(index),
    "Heartbeat.jsonStream": stream(line("00:00:10.000", '{"Utc":"2025-05-01T14:00:10.000Z"}')),
    "DriverList.jsonStream": stream(line("00:00:00.100", '{"1":{"Tla":"AAA","FullName":"Driver A","TeamName":"Team","TeamColour":"FF0000"}}')),
    "TimingData.jsonStream": stream(
      line("00:01:00.000", '{"Lines":{"1":{"InPit":false}}}'),
      line("00:02:30.000", '{"Lines":{"1":{"NumberOfLaps":1,"Sectors":{"2":{"Value":"40.000"}}}}}'),
      line("00:04:00.000", '{"Lines":{"1":{"NumberOfLaps":2,"LastLapTime":{"Value":"1:30.000"},"Position":"1"}}}'),
    ),
    "TimingAppData.jsonStream": stream(line("00:00:59.000", '{"Lines":{"1":{"Stints":[{"Compound":"SOFT","StartLaps":0}]}}}')),
  };
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    const name = String(url).split("/").at(-1)!;
    return files[name] ? new Response(files[name]) : new Response("", { status: 404 });
  });

  it("refuses to fetch without a connected account", async () => {
    const p = new F1LiveTimingProvider({ token: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch, requestsPerSecond: 1000 });
    await expect(p.listSessions(2025)).rejects.toThrow(/No Formula 1 account is connected/);
  });

  it("lists sessions and builds a bundle with absolute lap times", async () => {
    const p = new F1LiveTimingProvider({ token: async () => "TOKEN", fetchImpl: fetchImpl as unknown as typeof fetch, requestsPerSecond: 1000 });
    const sessions = await p.listSessions(2025);
    expect(sessions[0]).toMatchObject({ sessionKey: "2025-42", type: "qualifying", dateStart: "2025-05-01T14:00:00.000Z" });
    const b = await p.fetchSession("2025-42");
    expect(b.session).toMatchObject({ id: "f1lt:2025-42", source: "f1lt", circuitId: "f1lt:7" });
    expect(b.drivers.map((d) => d.code)).toEqual(["AAA"]);
    const lap2 = b.laps.find((l) => l.lapNumber === 2)!;
    expect(lap2.lapTime).toBe(90);
    // origin = 14:00:10 - 10 s = 14:00:00; lap 2 starts when lap 1 ended (offset 2:30).
    expect(lap2.dateStart).toBe("2025-05-01T14:02:30.000Z");
    expect(b.stints[0]).toMatchObject({ compound: "SOFT", lapStart: 1, lapEnd: 2 });
    expect(b.results[0]).toMatchObject({ driverNumber: 1, duration: 90, status: "finished" });
  });

  it("turns a rejected token into a sign-in prompt and notifies the connection store", async () => {
    const onUnauthorized = vi.fn(async () => {});
    const p = new F1LiveTimingProvider({ token: async () => "TOKEN", onUnauthorized, requestsPerSecond: 1000, fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch });
    await expect(p.listSessions(2025)).rejects.toThrow(/Sign in again/);
    expect(onUnauthorized).toHaveBeenCalled();
  });
});

describe("F1LiveFeed (SignalR Core JSON protocol)", () => {
  it("negotiates with the token, handshakes, subscribes and buffers feed updates", async () => {
    const sent: string[] = [];
    let sock!: WebSocketLike;
    const connect = vi.fn(async (url: string, headers: Record<string, string>) => {
      expect(url).toBe("wss://hub.test/signalrcore?id=tok%2F1");
      expect(headers.authorization).toBe("Bearer TOKEN");
      sock = { send: (d: string) => void sent.push(d), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
      setTimeout(() => {
        sock.onopen!();
        sock.onmessage!({ data: "{}\u001e" });
      }, 0);
      return sock;
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "OPTIONS") return new Response(null, { headers: { "set-cookie": "AWSALBCORS=lb1; Path=/" } });
      expect((init?.headers as Record<string, string>).cookie).toBe("AWSALBCORS=lb1");
      return new Response(JSON.stringify({ connectionToken: "tok/1" }));
    });
    const feed = new F1LiveFeed({ token: async () => "TOKEN", fetchImpl: fetchImpl as unknown as typeof fetch, connect, hubUrl: "wss://hub.test/signalrcore", negotiateUrl: "https://hub.test/negotiate" });
    await feed.start();
    expect(JSON.parse(sent[0]!.replace("\u001e", ""))).toEqual({ protocol: "json", version: 1 });
    expect(JSON.parse(sent[1]!.replace("\u001e", ""))).toMatchObject({ type: 1, target: "Subscribe" });

    const frame = (o: unknown) => JSON.stringify(o) + "\u001e";
    sock.onmessage!({ data: frame({ type: 3, invocationId: "0", result: { SessionInfo: { Key: 42 }, TimingData: { Lines: { "1": { NumberOfLaps: 3, Sectors: { "0": { Value: "30.000" }, "1": { Value: "30.000" } } } } } } }) });
    const carZ = JSON.parse(z({ Entries: [{ Utc: "2025-05-01T14:05:00.000Z", Cars: { "1": { Channels: { "0": 11000, "2": 310, "3": 8, "4": 100, "5": 0 } } } }] }));
    sock.onmessage!({ data: frame({ type: 1, target: "feed", arguments: ["CarData.z", carZ, "2025-05-01T14:05:00.100Z"] }) });
    sock.onmessage!({ data: frame({ type: 1, target: "feed", arguments: ["TimingData", { Lines: { "1": { NumberOfLaps: 4, LastLapTime: { Value: "1:30.000" }, Sectors: { "2": { Value: "30.000" } }, Position: "2", GapToLeader: "+0.500" } } }, "2025-05-01T14:05:01.000Z"] }) });
    await new Promise((r) => setTimeout(r, 30));

    await expect(feed.drain(41)).rejects.toThrow(/not the session currently live/);
    const d = await feed.drain(42);
    expect(d.car.get(1)!.speed).toEqual([310]);
    expect(d.bundle.positionHistory).toEqual([{ date: "2025-05-01T14:05:01.000Z", driverNumber: 1, position: 2 }]);
    expect(d.bundle.intervals![0]).toMatchObject({ gapToLeader: 0.5 });
    expect(d.bundle.laps![0]).toMatchObject({ lapNumber: 4, lapTime: 90, sector1: 30, sector2: 30, sector3: 30 });
    expect((await feed.drain(42)).car.size).toBe(0);
    await feed.stop();
  });
});
