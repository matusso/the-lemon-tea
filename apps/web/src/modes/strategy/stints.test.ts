import { describe, expect, it } from "vitest";
import { addPit, fromShares, pitLaps, removePit, rescale, setPit, total, uniqueName, type Stint } from "./stints";

const two: Stint[] = [
  { compound: "MEDIUM", laps: 22 },
  { compound: "HARD", laps: 31 },
];
const three: Stint[] = [
  { compound: "MEDIUM", laps: 16 },
  { compound: "HARD", laps: 20 },
  { compound: "MEDIUM", laps: 17 },
];

describe("strategy stint arithmetic", () => {
  it("lists stops as the lap each stint ends on", () => {
    expect(pitLaps(two)).toEqual([22]);
    expect(pitLaps(three)).toEqual([16, 36]);
  });

  it("moves a stop without changing race distance", () => {
    const s = setPit(three, 0, 19);
    expect(pitLaps(s)).toEqual([19, 36]);
    expect(total(s)).toBe(53);
  });

  it("keeps every stint at least one lap when a stop is dragged past its neighbour", () => {
    expect(pitLaps(setPit(three, 0, 50))).toEqual([35, 36]);
    expect(pitLaps(setPit(three, 1, 2))).toEqual([16, 17]);
    expect(pitLaps(setPit(two, 0, 99))).toEqual([52]);
  });

  it("adds a stop by splitting the stint that contains the lap, and removes it again", () => {
    const s = addPit(two, 40);
    expect(pitLaps(s)).toEqual([22, 40]);
    expect(s.map((x) => x.compound)).toEqual(["MEDIUM", "HARD", "MEDIUM"]);
    expect(addPit(two, 22)).toBe(two); // already a stop
    expect(removePit(s, 1)).toEqual(two);
  });

  it("builds and rescales stints to exactly the race distance", () => {
    expect(total(fromShares([["SOFT", 0.3], ["HARD", 0.7]], 71))).toBe(71);
    const r = rescale(three, 71);
    expect(total(r)).toBe(71);
    expect(r.map((x) => x.compound)).toEqual(["MEDIUM", "HARD", "MEDIUM"]);
  });

  it("makes names unique", () => {
    expect(uniqueName("1-stop", ["1-stop", "1-stop (2)"])).toBe("1-stop (3)");
    expect(uniqueName("new", ["1-stop"])).toBe("new");
  });
});
