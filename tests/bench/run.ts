/**
 * Benchmarks. Synthetic micro-benchmarks need no database; database benchmarks run when
 * DATABASE_URL is set and --session is given:  npm run bench -- --session openf1:9908
 * Reports median / p95 wall time per operation as JSON lines.
 */
import { parseArgs } from "node:util";
import { systemContext } from "@lemon-tea/auth";
import { buildRuntime } from "@lemon-tea/api/container";
import { timingTower } from "@lemon-tea/synchronization";
import { bestDeterministicStrategy, compareLaps, DEFAULT_SIM_PARAMS, forecastRaceResult, quantile } from "@lemon-tea/telemetry-core";
import { syntheticLap } from "../fixtures/synthetic.ts";

async function time(label: string, runs: number, fn: () => Promise<unknown> | unknown) {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  const r = { label, runs, median_ms: +quantile(ms, 0.5).toFixed(2), p95_ms: +quantile(ms, 0.95).toFixed(2) };
  console.log(JSON.stringify(r));
  return r;
}

const { values } = parseArgs({ options: { session: { type: "string" }, runs: { type: "string", default: "10" } } });
const runs = Number(values.runs);

// --- synthetic (no database)
const a = syntheticLap(1, 1, 0, {}, 1);
const b = syntheticLap(2, 1, 0, { corners: [{}, { brakeDistance: 90 }] }, 2);
await time("synthetic.compareLaps (5 m grid)", runs, () => compareLaps({ sessionId: "s:1", driverCode: "A", ...a }, { sessionId: "s:1", driverCode: "B", ...b }));
const p = { ...DEFAULT_SIM_PARAMS, totalLaps: 57 };
const field = Array.from({ length: 20 }, (_, i) => ({ driverNumber: i + 1, code: `D${i}`, grid: i + 1, basePace: 90 + i * 0.1, paceSd: 0.2, strategy: bestDeterministicStrategy(p).stints }));
await time("synthetic.forecastRaceResult 20 cars x 57 laps x 2000 iterations", 3, () => forecastRaceResult(field, p, 2000, 1));

// --- database-backed
if (values.session && process.env.DATABASE_URL) {
  const rt = buildRuntime({ DATABASE_URL: process.env.DATABASE_URL, publicSources: [] });
  const ctx = systemContext();
  const s = await rt.services.access.session(ctx, values.session);
  await time("db.timingBundle (first call cold, then cached)", runs, () => rt.services.timing.bundleFor(s));
  const bundle = await rt.services.timing.bundleFor(s);
  await time("timingTower (all drivers)", runs * 10, () => timingTower(bundle, 1800_000));
  const drivers = bundle.drivers.map((d) => d.driverNumber);
  await time("db.carSamples one lap", runs, () => rt.services.telemetry.lapInput(s, drivers[0]!, undefined, false));
  await time("service.compareLaps (db + analysis)", runs, () =>
    rt.services.laps.compare(ctx, {
      a: { sessionId: values.session!, driverNumber: drivers[0]! },
      b: { sessionId: values.session!, driverNumber: drivers[1]! },
      stepMetres: 5,
      includeTraces: false,
      traceResolutionMetres: 25,
    }),
  );
  await time("db.replayWindow 60 s, all cars", runs, () => rt.services.timing.replayWindow(ctx, values.session!, 600_000, 660_000));
  await time("db.carSamples full session, one driver", 3, () => rt.store.carSamples(s, drivers[0]!));
  await rt.close();
} else {
  console.log(JSON.stringify({ note: "Pass --session <id> with DATABASE_URL set for database benchmarks" }));
}
