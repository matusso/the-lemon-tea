# Circuit engine

Code: `packages/circuit-engine/src/index.ts` (`circuit-geometry-v2`) and `CircuitService` (`packages/domain/src/services/circuit.ts`).

## What the geometry is

It is a **driven-line estimate** built from measured car positions. It is *not* surveyed track geometry. Every layout carries `provenance`, `accuracyM` and `confidence`, and these are shown in the UI and returned by `get_circuit`.

## Derivation (`deriveGeometry`)

1. `CircuitService` picks up to 5 drivers' fastest valid laps (not out-laps, with a start time) and builds distance traces with x/y and z.
2. The fastest lap's x/y path is parameterised by **path length** and resampled every 5 m. Speed-integrated distance is not used here because it drifts along the track. The result is smoothed with a 5-point (≈25 m) moving average.
3. The path-length axis is scaled to the median speed-integrated lap length, so that lap distance from telemetry maps onto the line.
4. **Accuracy** = RMS lateral (nearest-point) distance from the other laps' raw samples (every 4th sample) to the line.
5. **Confidence:** `high` if ≥ 3 laps and accuracy < 2.5 m; `medium` if ≥ 2 laps and accuracy < 5 m; otherwise `low`.
6. **Elevation** is kept only if per-lap z agrees with the median (RMS of deviations < 1 m) and the total range is > 1 m. It is then smoothed with a 9-point moving average. Otherwise `z` is omitted.
7. Coordinates are shifted by `origin` (median x/y, minimum z). Corners come from speed minima (`detectCorners`) and are mapped onto the line. Sector boundaries come from the reference lap's sector-1 and sector-1+2 times.

2025 Monza qualifying: 5,758.7 m driven length, 1.41 m lateral RMS, confidence `high`. Version 1 averaged laps index by index and reported 7 m of scatter. That was along-track misalignment, not real disagreement, which is why v2 measures lateral distance.

## Privacy

Layouts from public sessions are persisted in `circuit_layouts` (one per circuit and year). Layouts derived from a tenant's private session are kept only in that process's memory, keyed by tenant, so geometry cannot leak private telemetry.

## Helpers

- `nearestDistance(geo, x, y)` returns the lap distance and lateral offset of the nearest centreline point. It is used to turn a click on the map into a chart cursor distance.
- `pointAtDistance(geo, d)` returns x/y at a lap distance (wraps around).

## Not available

These are not available and are never synthesised: track width and boundaries, official turn numbers and names (corners are labelled `C1…Cn`, source `detected`), marshal sectors, pit-lane geometry, speed-trap positions, DRS or active-aero zones, and surroundings. The schema allows `source: "official"` corners for when a licensed metadata source is added.

## Renderer (apps/web)

The web app (`apps/web/src/modes/command/Circuit3D.tsx`) renders the centreline with React Three Fiber and Three.js. Cars are placed from replay windows (`GET /api/sessions/:id/replay`) using `positionAt`, and positions update inside the render loop rather than through React state. The 2D track map (`TrackMap2D.tsx`) supports the Telemetry Lab cursor. See the source for the current camera modes and overlays; WebGPU is not used.
