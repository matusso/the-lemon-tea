import { describe, expect, it, vi } from "vitest";
import { LemonTeaError, type AuthContext } from "@lemon-tea/shared-types";
import type { SessionListing } from "@lemon-tea/provider-sdk";
import { IngestionService, type IngestResult } from "./ingestion.ts";

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
