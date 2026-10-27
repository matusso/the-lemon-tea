import type { CornerComparison } from "./corners.ts";
import { round } from "./stats.ts";

export const EXPLANATION_VERSION = "explain-v1";

/**
 * Deterministic, evidence-linked explanations. Every sentence is produced from a template
 * filled with numbers computed from telemetry; nothing here guesses at quantities the data
 * does not contain (brake pressure, steering, tyre slip, setup).
 */
export interface Finding {
  scope: string;
  /** A_minus_B seconds; negative = A gained. */
  deltaChange: number;
  factor:
    | "braking_point"
    | "entry_speed"
    | "minimum_speed"
    | "throttle_application"
    | "exit_acceleration"
    | "straight_line_speed"
    | "mixed";
  text: string;
  evidence: Record<string, number | string | null>;
}

const fmtS = (s: number) => `${round(Math.abs(s), 3).toFixed(3)} s`;
const fmtM = (m: number) => `${Math.round(Math.abs(m))} m`;
const fmtK = (k: number) => `${Math.round(Math.abs(k))} km/h`;

export function explainCorner(cc: CornerComparison, nameA: string, nameB: string): Finding {
  const gainer = cc.deltaChange <= 0 ? nameA : nameB;
  const loser = cc.deltaChange <= 0 ? nameB : nameA;
  const g = cc.deltaChange <= 0 ? cc.a : cc.b; // gainer metrics
  const l = cc.deltaChange <= 0 ? cc.b : cc.a;
  const phase = cc.phases.find((p) => p.phase === cc.dominantPhase)!;
  // Share of the gross (absolute) phase movement, so offsetting phases cannot exceed 100%.
  const gross = cc.phases.reduce((a, p) => a + Math.abs(p.deltaChange), 0);
  const share = gross > 1e-6 ? Math.abs(phase.deltaChange) / gross : 0;
  const offsetting = gross > 2 * Math.abs(cc.deltaChange) + 0.02;
  const where = cc.corner.officialLabel ?? `corner ${cc.corner.label}`;
  const parts: string[] = [`${gainer} gained approximately ${fmtS(cc.deltaChange)} in ${where} (${cc.corner.band}-speed, detected).`];
  let factor: Finding["factor"] = "mixed";

  const brakeLater = g.brakeStart !== null && l.brakeStart !== null ? g.brakeStart - l.brakeStart : null;
  const minDiff = g.minSpeed - l.minSpeed;
  const thrOnEarlier = g.throttleOn !== null && l.throttleOn !== null ? l.throttleOn - g.throttleOn : null;
  const exitDiff = g.exitSpeed - l.exitSpeed;
  const accelDiff = g.exitAcceleration - l.exitAcceleration;

  const phaseText = `${Math.round(share * 100)}% of the time movement in this corner came in the ${cc.dominantPhase} phase`;
  if (cc.dominantPhase === "entry") {
    if (brakeLater !== null && brakeLater > 4) {
      factor = "braking_point";
      parts.push(`${phaseText}: ${gainer} started braking ${fmtM(brakeLater)} later than ${loser}.`);
    } else {
      factor = "entry_speed";
      parts.push(`${phaseText}, with ${gainer} carrying ${fmtK(g.entrySpeed - l.entrySpeed)} ${g.entrySpeed >= l.entrySpeed ? "more" : "less"} speed at the start of braking/lift.`);
    }
  } else if (cc.dominantPhase === "mid") {
    factor = "minimum_speed";
    parts.push(`${phaseText}: minimum speed ${Math.round(g.minSpeed)} vs ${Math.round(l.minSpeed)} km/h (${minDiff >= 0 ? "+" : "-"}${fmtK(minDiff)}).`);
  } else {
    if (thrOnEarlier !== null && thrOnEarlier > 4) {
      factor = "throttle_application";
      parts.push(`${phaseText}, where ${gainer} reapplied throttle ${fmtM(thrOnEarlier)} earlier and accelerated at ${round(g.exitAcceleration, 1)} vs ${round(l.exitAcceleration, 1)} m/s².`);
    } else {
      factor = "exit_acceleration";
      parts.push(`${phaseText}: exit speed ${Math.round(g.exitSpeed)} vs ${Math.round(l.exitSpeed)} km/h, mean exit acceleration ${accelDiff >= 0 ? "+" : ""}${round(accelDiff, 2)} m/s².`);
    }
  }

  if (offsetting) {
    const other = cc.phases.filter((p) => Math.sign(p.deltaChange) !== Math.sign(cc.deltaChange) && Math.abs(p.deltaChange) > 0.02);
    if (other.length) parts.push(`Phases partly offset: ${other.map((p) => `${p.phase} ${p.deltaChange > 0 ? "+" : ""}${round(p.deltaChange, 3)} s`).join(", ")} in the other direction, so the net corner delta is small relative to the phase swings.`);
  }
  return {
    scope: cc.corner.label,
    deltaChange: cc.deltaChange,
    factor,
    text: parts.join(" "),
    evidence: {
      brake_start_difference_m: brakeLater === null ? null : round(brakeLater, 1),
      min_speed_difference_kmh: round(minDiff, 1),
      throttle_on_difference_m: thrOnEarlier === null ? null : round(thrOnEarlier, 1),
      exit_speed_difference_kmh: round(exitDiff, 1),
      exit_acceleration_difference_ms2: round(accelDiff, 2),
      dominant_phase: cc.dominantPhase,
      dominant_phase_share: round(share, 2),
      phases_offsetting: offsetting ? "yes" : "no",
    },
  };
}

export function explainStraight(
  label: string,
  deltaChange: number,
  topA: number,
  topB: number,
  nameA: string,
  nameB: string,
): Finding {
  const gainer = deltaChange <= 0 ? nameA : nameB;
  const gTop = deltaChange <= 0 ? topA : topB;
  const lTop = deltaChange <= 0 ? topB : topA;
  return {
    scope: label,
    deltaChange,
    factor: "straight_line_speed",
    text:
      `${gainer} gained approximately ${fmtS(deltaChange)} on ${label} with a peak speed of ${Math.round(gTop)} vs ${Math.round(lTop)} km/h. ` +
      `Straight-line differences can come from power deployment, drag level, slipstream or DRS/active aero and are not separable from this data alone.`,
    evidence: { peak_speed_a_kmh: Math.round(topA), peak_speed_b_kmh: Math.round(topB) },
  };
}

export function summarize(findings: Finding[], finalDelta: number, nameA: string, nameB: string): string {
  if (!findings.length) return "No significant differences found.";
  const faster = finalDelta <= 0 ? nameA : nameB;
  const top = [...findings].sort((x, y) => Math.abs(y.deltaChange) - Math.abs(x.deltaChange)).slice(0, 3);
  const supportive = top.filter((f) => Math.sign(f.deltaChange) === Math.sign(finalDelta) || finalDelta === 0);
  const lead = `${faster} was ${fmtS(finalDelta)} faster over the lap.`;
  const reasons = supportive.length
    ? ` Largest contributions: ${supportive.map((f) => `${f.scope} (${fmtS(f.deltaChange)}, ${f.factor.replaceAll("_", " ")})`).join("; ")}.`
    : "";
  return lead + reasons;
}
