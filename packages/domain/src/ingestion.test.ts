import { describe, expect, it, vi } from "vitest";
import { LemonTeaError, type AuthContext } from "@lemon-tea/shared-types";
import type { SessionListing } from "@lemon-tea/provider-sdk";
import { ProviderRegistry, type ProviderAdapter } from "@lemon-tea/provider-sdk";
import type { SessionBundle } from "@lemon-tea/shared-types";
import { IngestionService, type IngestResult } from "./ingestion.ts";
import { AccessPolicy } from "./access.ts";
import { MemoryStore } from "./memory-store.ts";

const ctx = { tenantId: "t1" } as AuthContext;
const day = 24 * 3600_000;
const listing = (sessionKey: string, meetingKey: string, name: string, dateStart: string): SessionListing => ({
  sessionKey, meetingKey, name, dateStart, year: 2025, type: "practice", circuitShortName: "X", countryName: null, dateEnd: null,
});

function service(listings: SessionListing[], fail: Record<string, Error> = {}) {
  const svc = new IngestionService(null as never, null as never, null as never);
  vi.spyOn(svc, "discover").mockResolvedValue(listings);
  const ingest = vi.spyOn(svc, "ingest").mockImplementation(async (_c, q) => {
    if (fail[q.sessionId]) throw fail[q.sessionId];
    return { sessionId: q.sessionId } as IngestResult;
  });
  return { svc, ingest };
}

const q = { source: "f1lt", year: 2025, meetingKey: "m1", channels: ["timing" as const], visibility: "private" as const };

describe("IngestionService.ingestWeekend", () => {
  it("loads every started session of the meeting in calendar order", async () => {
    const { svc, ingest } = service([
      listing("2025-3", "m1", "Race", "2025-03-16T04:00:00Z"),
      listing("2025-1", "m1", "Practice 1", "2025-03-14T01:30:00Z"),
      listing("2025-9", "m2", "Practice 1", "2025-03-21T01:30:00Z"),
      listing("2025-2", "m1", "Qualifying", "2025-03-15T05:00:00Z"),
    ]);
    const r = await svc.ingestWeekend(ctx, q);
    expect(ingest.mock.calls.map((c) => c[1].sessionId)).toEqual(["f1lt:2025-1", "f1lt:2025-2", "f1lt:2025-3"]);
    expect(r.sessions.every((s) => s.ok)).toBe(true);
  });

  it("skips sessions that have not started and reports per-session failures", async () => {
    const { svc } = service(
      [
        listing("2025-1", "m1", "Practice 1", "2025-03-14T01:30:00Z"),
        listing("2025-2", "m1", "Qualifying", "2025-03-15T05:00:00Z"),
        listing("2025-3", "m1", "Race", new Date(Date.now() + day).toISOString()),
      ],
      { "f1lt:2025-1": new Error("No timing data published") },
    );
    const r = await svc.ingestWeekend(ctx, q);
    expect(r.sessions.map((s) => [s.name, s.ok])).toEqual([["Practice 1", false], ["Qualifying", true]]);
  });

  it("fails when nothing could be loaded", async () => {
    const { svc } = service([listing("2025-1", "m1", "Practice 1", "2025-03-14T01:30:00Z")], { "f1lt:2025-1": new Error("boom") });
    await expect(svc.ingestWeekend(ctx, q)).rejects.toBeInstanceOf(LemonTeaError);
    await expect(service([]).svc.ingestWeekend(ctx, q)).rejects.toThrow(/No started sessions/);
  });
});

describe("IngestionService.ingest", () => {
  it("adds the meeting's not-yet-started sessions as selectable calendar rows (SYNTHETIC)", async () => {
    const future = new Date(Date.now() + day).toISOString();
    const past = new Date(Date.now() - day).toISOString();
    const bundle: SessionBundle = {
      meeting: { id: "syn:m1", year: 2026, name: "Synthetic GP", countryName: null, location: null, circuitId: "syn:c1", circuitShortName: "Oval", dateStart: past },
      session: { id: "syn:q", meetingId: "syn:m1", year: 2026, name: "Qualifying", type: "qualifying", circuitId: "syn:c1", circuitShortName: "Oval", countryName: null, dateStart: past, dateEnd: null, regulationEra: "active_aero_2026", source: "syn" },
      drivers: [], laps: [], stints: [], pitEvents: [], raceControl: [], weather: [], teamRadio: [], positionHistory: [], intervals: [], results: [],
    };
    const provider = {
      id: "syn",
      capabilities: () => ({}),
      health: async () => ({ ok: true }),
      listSessions: async () => [
        { sessionKey: "q", meetingKey: "m1", year: 2026, name: "Qualifying", type: "qualifying", circuitShortName: "Oval", countryName: null, dateStart: past, dateEnd: null },
        { sessionKey: "r", meetingKey: "m1", year: 2026, name: "Race", type: "race", circuitShortName: "Oval", countryName: null, dateStart: future, dateEnd: null },
        { sessionKey: "x", meetingKey: "m2", year: 2026, name: "Race", type: "race", circuitShortName: "Other", countryName: null, dateStart: future, dateEnd: null },
      ],
      fetchSession: async () => bundle,
    } as unknown as ProviderAdapter;
    const store = new MemoryStore();
    const svc = new IngestionService(new ProviderRegistry().register(provider), store, new AccessPolicy(store));
    const admin = { anonymous: false, userId: "u", tenantId: "t1", scopes: new Set(["admin"]), via: "web" } as unknown as AuthContext;
    await svc.ingest(admin, { sessionId: "syn:q", channels: ["timing"], visibility: "public" });
    const rows = await store.listSessions({ tenantId: null }, { meetingId: "syn:m1", limit: 10 });
    const race = rows.find((r) => r.id === "syn:r");
    expect(race).toMatchObject({ type: "race", name: "Race", ingestStatus: "not_ingested", circuitId: "syn:c1", dateStart: future });
    expect(rows.some((r) => r.id === "syn:x")).toBe(false);
  });
});
