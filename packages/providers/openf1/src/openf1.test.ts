import { describe, expect, it, vi } from "vitest";
import { OpenF1Provider, sessionTypeFromOpenF1, toCarSamples, toPositionSamples } from "./index.ts";
import { assertSafeUrl } from "@lemon-tea/provider-sdk";

// Rows below are hand-written in the OpenF1 response shape; values are synthetic.
describe("OpenF1 normalisation", () => {
  it("sorts, de-duplicates, normalises brake and drops incomplete samples", () => {
    const s = toCarSamples([
      { date: "2025-01-01T00:00:00.500Z", speed: 200, throttle: 100, brake: 0, rpm: 11000, n_gear: 7, drs: 8 },
      { date: "2025-01-01T00:00:00.250Z", speed: 198, throttle: 104, brake: 100, rpm: 10900, n_gear: 7, drs: 8 },
      { date: "2025-01-01T00:00:00.250Z", speed: 198, throttle: 99, brake: 0, rpm: 10900, n_gear: 7, drs: 8 },
      { date: "2025-01-01T00:00:00.750Z", speed: null, throttle: 50, brake: 0 },
    ]);
    expect(s.t).toEqual([Date.parse("2025-01-01T00:00:00.250Z"), Date.parse("2025-01-01T00:00:00.500Z")]);
    expect(s.throttle[0]).toBe(100); // clipped
    expect(s.brake).toEqual([1, 0]);
    expect(s.drs).toEqual([8, 8]);
  });

  it("omits the DRS channel when the source has none (2026)", () => {
    const s = toCarSamples([{ date: "2026-03-07T05:03:30.418Z", speed: 300, throttle: 100, brake: 0, rpm: 10919, n_gear: 8, drs: null }]);
    expect(s.drs).toBeUndefined();
  });

  it("converts decimetres to metres and skips (0,0,0) no-fix samples", () => {
    const p = toPositionSamples([
      { date: "2025-01-01T00:00:00Z", x: 0, y: 0, z: 0 },
      { date: "2025-01-01T00:00:01Z", x: 10118, y: 12077, z: 1925 },
    ]);
    expect(p.t).toHaveLength(1);
    expect(p.x[0]).toBeCloseTo(1011.8);
    expect(p.y[0]).toBeCloseTo(1207.7);
    expect(p.z[0]).toBeCloseTo(192.5);
  });

  it("maps session types", () => {
    expect(sessionTypeFromOpenF1("Practice", "Practice 2")).toBe("practice");
    expect(sessionTypeFromOpenF1("Qualifying", "Sprint Qualifying")).toBe("sprint_qualifying");
    expect(sessionTypeFromOpenF1("Race", "Sprint")).toBe("sprint");
    expect(sessionTypeFromOpenF1("Race", "Race")).toBe("race");
  });

  it("retries after 429", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      const row = { session_key: 1, meeting_key: 2, year: 2025, session_name: "Race", session_type: "Race", circuit_short_name: "X", country_name: "Y", date_start: "2025-01-01T00:00:00Z", date_end: null };
      return new Response(JSON.stringify([row]), { status: 200 });
    });
    const p = new OpenF1Provider({ fetchImpl: fetchImpl as unknown as typeof fetch, requestsPerSecond: 100 });
    expect(await p.listSessions(2025)).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("treats 404 (no matching rows) as an empty sample window", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: "No results found." }), { status: 404 }));
    const p = new OpenF1Provider({ fetchImpl: fetchImpl as unknown as typeof fetch, requestsPerSecond: 100 });
    const s = await p.fetchCarSamples("1", 1, "2025-01-01T00:00:00Z", "2025-01-01T00:20:00Z");
    expect(s.t).toEqual([]);
  });

  it("does not advertise live access without credentials and refuses to poll", async () => {
    const p = new OpenF1Provider();
    expect(p.capabilities().live).toBe(false);
    await expect(p.pollLive("1", null)).rejects.toThrow(/credentials/);
  });
});

describe("SSRF protection", () => {
  it("allows only https to allow-listed hosts", () => {
    expect(assertSafeUrl("https://api.openf1.org/v1/x", ["api.openf1.org"]).hostname).toBe("api.openf1.org");
    expect(() => assertSafeUrl("http://api.openf1.org/v1/x", ["api.openf1.org"])).toThrow(/protocol/);
    expect(() => assertSafeUrl("https://evil.example/x", ["api.openf1.org"])).toThrow(/allow-listed/);
    expect(() => assertSafeUrl("https://169.254.169.254/latest", ["api.openf1.org"])).toThrow();
    expect(() => assertSafeUrl("https://user:pw@api.openf1.org/", ["api.openf1.org"])).toThrow(/Credentials/);
  });
});
