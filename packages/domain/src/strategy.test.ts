import { describe, expect, it } from "vitest";
import { systemContext } from "@lemon-tea/auth";
import { ProviderRegistry } from "@lemon-tea/provider-sdk";
import type { SessionBundle, SessionType } from "@lemon-tea/shared-types";
import { createServices } from "./container.ts";
import { MemoryStore } from "./memory-store.ts";

/** SYNTHETIC weekend (not real data): practice and qualifying ingested, race not started. */
const MEETING = { id: "synthetic:m1", year: 2026, name: "Synthetic GP (NOT REAL DATA)", countryName: null, location: null, circuitId: "synthetic:oval", circuitShortName: "Synthetic Oval", dateStart: "2026-05-01T10:00:00.000Z" };
const DRIVERS = [1, 2, 3, 4].map((n) => ({ driverNumber: n, code: `D${n}X`, fullName: `Synthetic ${n}`, teamName: "Team", teamColour: "888888" }));

function bundle(id: string, name: string, type: SessionType, day: number, ingested: boolean, gridOrder: number[] = []): SessionBundle {
  const start = new Date(Date.UTC(2026, 4, day, 12)).toISOString();
  const laps = ingested
    ? DRIVERS.flatMap((d, i) =>
        [1, 2, 3].map((lap) => ({
          driverNumber: d.driverNumber, lapNumber: lap, dateStart: new Date(Date.parse(start) + lap * 90_000).toISOString(), lapTime: 90 + i * 0.3 + lap * 0.05,
          sector1: null, sector2: null, sector3: null, i1Speed: null, i2Speed: null, stSpeed: null, isPitOutLap: lap === 1, miniSectors: [],
        })),
      )
    : [];
  return {
    meeting: MEETING,
    session: { id, meetingId: MEETING.id, year: 2026, name, type, circuitId: MEETING.circuitId, circuitShortName: MEETING.circuitShortName, countryName: null, dateStart: start, dateEnd: null, regulationEra: "active_aero_2026", source: "synthetic" },
    drivers: ingested ? DRIVERS : [],
    laps,
    stints: [], pitEvents: [], raceControl: [], weather: [], teamRadio: [], positionHistory: [], intervals: [],
    results: gridOrder.map((d, i) => ({ driverNumber: d, position: i + 1, laps: null, status: "finished" as const, duration: null, gapToLeader: null, points: null })),
  };
}

async function weekend(withQualifying: boolean) {
  const store = new MemoryStore();
  const load = async (b: SessionBundle, ingested: boolean) => {
    const uid = await store.upsertSession(null, b);
    if (ingested) {
      await store.writeTiming(uid, b);
      await store.markIngested(uid, "complete", ["timing"]);
    }
  };
  await load(bundle("synthetic:fp1", "Practice 1", "practice", 1, true), true);
  if (withQualifying) await load(bundle("synthetic:q", "Qualifying", "qualifying", 2, true, [3, 1, 4, 2]), true);
  await load(bundle("synthetic:race", "Race", "race", 3, false), false);
  return createServices({ store, providers: new ProviderRegistry() });
}

const strategies = [
  { name: "1-stop", stints: [{ compound: "MEDIUM" as const, laps: 25 }, { compound: "HARD" as const, laps: 25 }] },
  { name: "2-stop", stints: [{ compound: "SOFT" as const, laps: 15 }, { compound: "MEDIUM" as const, laps: 20 }, { compound: "SOFT" as const, laps: 15 }] },
];

describe("StrategySimulationService before the race", () => {
  it("simulates with the entry list from the weekend and the grid from qualifying", async () => {
    const s = await weekend(true);
    const r = await s.strategy.simulate(systemContext(), { sessionId: "synthetic:race", paceSessionIds: ["synthetic:fp1"], driverNumber: 2, totalLaps: 50, strategies, iterations: 200, seed: 1, scenario: {} });
    expect(r.results).toHaveLength(2);
    expect(r.totalLaps).toBe(50);
    expect(r.notes.join(" ")).toMatch(/Pre-race simulation: entry list from Qualifying, grid from Qualifying/);
    const f = await s.strategy.buildField(systemContext(), "synthetic:race", [], undefined, 50);
    expect(f.field.map((c) => c.driverNumber)).toEqual([3, 1, 4, 2]);
  });

  it("uses best practice laps for the grid when qualifying has not run yet", async () => {
    const s = await weekend(false);
    const f = await s.strategy.buildField(systemContext(), "synthetic:race", ["synthetic:fp1"], undefined, 50);
    expect(f.field.map((c) => c.driverNumber)).toEqual([1, 2, 3, 4]);
    expect(f.notes.join(" ")).toMatch(/no qualifying ingested yet/);
  });

  it("explains what is missing when nothing of the weekend is ingested", async () => {
    const store = new MemoryStore();
    await store.upsertSession(null, bundle("synthetic:race", "Race", "race", 3, false));
    const s = createServices({ store, providers: new ProviderRegistry() });
    await expect(s.strategy.buildField(systemContext(), "synthetic:race", [], undefined, 50)).rejects.toThrow(/ingest a practice or qualifying session first/);
  });
});
