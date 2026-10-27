/**
 * SYNTHETIC DEVELOPMENT FIXTURE — NOT REAL FORMULA 1 DATA.
 * A fictional practice weekend with known ground-truth pace, degradation and fuel effect.
 */
import type { ContextLap } from "@lemon-tea/telemetry-core";
import { Rng } from "@lemon-tea/telemetry-core";

export interface SyntheticDriver {
  driverNumber: number;
  code: string;
  teamName: string;
  /** True qualifying-trim lap time on fresh softs (s). */
  truePace: number;
  /** True degradation (s/lap) on MEDIUM. */
  trueDeg: number;
}

export const FIELD: SyntheticDriver[] = Array.from({ length: 20 }, (_, i) => ({
  driverNumber: i + 1,
  code: `D${String(i + 1).padStart(2, "0")}`,
  teamName: `Team ${String.fromCharCode(65 + Math.floor(i / 2))}`,
  truePace: 80 + i * 0.08,
  trueDeg: 0.05 + (i % 5) * 0.01,
}));

export const TRUE_FUEL_EFFECT = 0.06;
const SOFT_TO_MEDIUM = 0.45;

/**
 * Each driver: a quali sim (out, push, cool, push) on softs and a 12-lap long run on mediums
 * with fuel burn and degradation. Session evolution: later sessions are 0.4 s faster.
 */
export function syntheticPractice(sessionIds = ["synthetic:fp1", "synthetic:fp2", "synthetic:fp3"], seed = 3): ContextLap[] {
  const rng = new Rng(seed);
  const laps: ContextLap[] = [];
  sessionIds.forEach((sid, si) => {
    const evo = (sessionIds.length - 1 - si) * 0.4;
    for (const d of FIELD) {
      let lapNo = 1;
      let t = 60_000 + d.driverNumber * 7_000;
      const push = (lapTime: number | null, compound: ContextLap["compound"], stint: number, age: number, out = false) => {
        laps.push({
          sessionId: sid,
          driverNumber: d.driverNumber,
          lapNumber: lapNo++,
          startMs: t,
          lapTime,
          sector1: lapTime ? lapTime * 0.3 : null,
          sector2: lapTime ? lapTime * 0.4 : null,
          sector3: lapTime ? lapTime * 0.3 : null,
          isPitOutLap: out,
          compound,
          stintNumber: stint,
          tyreAge: age,
        });
        t += (lapTime ?? 100) * 1000;
      };
      // quali sim on softs (+0.9 s practice fuel/engine trim)
      push(110, "SOFT", 1, 0, true);
      push(d.truePace + evo + 0.9 + rng.normal(0, 0.08), "SOFT", 1, 1);
      push(d.truePace * 1.2, "SOFT", 1, 2);
      push(d.truePace + evo + 0.95 + rng.normal(0, 0.08), "SOFT", 1, 3);
      if (si === 1) {
        // long run on mediums with ~70 kg fuel
        push(112, "MEDIUM", 2, 0, true);
        for (let k = 0; k < 12; k++) {
          const lt = d.truePace + 4 + SOFT_TO_MEDIUM + evo + d.trueDeg * (k + 1) - TRUE_FUEL_EFFECT * k + rng.normal(0, 0.12);
          push(lt, "MEDIUM", 2, k + 1);
        }
      }
    }
  });
  return laps;
}
