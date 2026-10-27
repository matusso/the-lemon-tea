# Validation

## Test inventory

| Suite | Tests | What it proves |
|---|---|---|
| `packages/telemetry-core/src/comparison.test.ts` | 13 | Distance integration; finish-line alignment (final delta = lap-time difference); identical laps within the noise floor; corner detection near true apexes; braking-point attribution matching ground truth (25 m, within 10 m); exit-traction attribution; corner + straight deltas partition the lap; no apex-hit claims; confidence labelled as a heuristic |
| `packages/telemetry-core/src/models.test.ts` | 17 | Theil–Sen robustness; seeded RNG reproducibility; lap classification (out-lap, push, quali sim, cooldown, long run, interrupted); degradation recovered when the fuel assumption is correct, and biased when it is wrong; race-pace ordering; qualifying probabilities coherent (sum to 1, front row ≥ pole, Q1 ≥ Q2); session-evolution offsets recovered; seed reproducibility; strategy simulator reproducibility, two-compound rule, preference for two stops under extreme degradation |
| `packages/synchronization/src/sync.test.ts` | 8 | Timing tower uses only data ≤ t; pit status, compound change, positions gained, retirements; practice ordering by best lap; SC deployment and withdrawal; timeline ordering; measured vs interpolated position labels; no bridging of large gaps; PlaybackClock rate, clamping and event stepping |
| `packages/providers/openf1/src/openf1.test.ts` | 7 | Normaliser (sorting, de-duplication, binary brake, dropping incomplete samples); 2026 DRS absence; decimetre→metre conversion and no-fix skipping; session types; 429 retry; refusal of live polling without credentials; SSRF allow-list |
| `packages/providers/f1-livetiming/src/f1lt.test.ts` | 22 | `.jsonStream`/`.z` decoding and decode-error counting; offsets, lap-time strings, GMT conversion, time origin; FastF1 lap rules (late-value window, >150 s Q-gap rule, integrity errors, latency-based lap end); drivers, stints, car/position channels (1/10 m), DRS absence; F1 account PKCE flow sending credentials only to `id.formula1.com`, refusing foreign submit URLs, surfacing IdP errors, keeping only entitlement claims; bundle with absolute lap times; 401 → sign-in prompt; SignalR negotiate, handshake, subscribe, ordered feed merging and drain |
| `tests/integration/provider-accounts.test.ts` | 7 | Formula 1 account connection through the real app: status-only responses, no password or token in responses, storage or audit; failed sign-in stores nothing; per-tenant, anonymous and MCP refused; AES-GCM associated data stops cross-tenant ciphertext reuse; token validation and 5/min limit; disconnect; private-only ingestion with the tenant's own token, invisible to other tenants (synthetic archive); 401 marks the connection expired |
| `tests/integration/api-mcp.test.ts` | 14 | MCP `compare_laps` equals REST output; all required tools, prompts and resource templates present; structured errors; tenant isolation over REST and MCP; OAuth PKCE flow, scope enforcement, code reuse and forged-token rejection, refresh rotation, 401 challenge; CSRF; security headers; no password hashes in responses; job idempotency, ownership, and execution through the shared engine |
| `tests/db/rls.test.ts` | 5 | Against real PostgreSQL as `lemontea_app`: tenant sees public + own rows; anonymous sees public only; cannot write rows owned by another tenant; provider connections visible and writable by their own tenant only. Needs `DATABASE_URL` and `MIGRATION_DATABASE_URL`; passed locally on TimescaleDB |
| `services/analytics/tests/test_backtest.py` | 5 | Metric correctness; leakage guard (practice laps after qualifying start excluded); temporal rolling splits; `insufficient_data` reported rather than faked; improvement calibration recovers synthetic truth |

Totals: 89 TypeScript tests pass, plus 5 DB tests when `DATABASE_URL` is set.

**Run:**

```bash
npm test
cd services/analytics && uv run pytest
DATABASE_URL=... MIGRATION_DATABASE_URL=... npx vitest run tests/db
```

**CI** (`.github/workflows/ci.yml`):
- typecheck, vitest, web build, Worker dry-run bundle;
- `uv run pytest`;
- migrations plus the RLS test against a `timescale/timescaledb:2.24.0-pg17` service.

## Synthetic fixtures

`tests/fixtures/synthetic.ts` and `synthetic-weekend.ts` generate a fictional 4.2 km circuit and a fictional practice weekend with known ground truth. Laps are integrated in 1 ms steps, then sampled at about 3.7 Hz with jitter and 1 km/h quantisation. They are marked **SYNTHETIC — NOT REAL FORMULA 1 DATA**, and the integration harness names its meeting "Synthetic GP (NOT REAL DATA)". No real provider data is committed to the repository.

## Real-data checks (2025 Italian GP, OpenF1, ingested locally)

| Check | Result |
|---|---|
| Ingestion of qualifying (`openf1:9908`) | 20 drivers, 315 laps, 349,040 car samples, 296,543 positions |
| OpenF1 position units | path length 57,464 units vs 5,730 m integrated from speed → decimetres |
| Timing tower at session end | VER 1:18.792 (pole), NOR +0.077, PIA +0.190, matching the official classification. The scheduled-end cut-off bug that dropped these laps was fixed by using `max(date_end, last lap end)` |
| VER vs NOR distance-aligned delta | −0.077 s, equal to the timed gap, reliability score 1.0 |
| Circuit centreline | 5,758.7 m driven length, 1.41 m lateral RMS across 5 drivers' laps, confidence `high`, elevation retained |
| Anonymous access to OpenF1 session | refused (`not_found`), because `public_display_allowed = false` |
| Node vs Cloudflare Worker (`wrangler dev`, workerd) | identical comparison output |
| F1 live timing archive without a token | `401` (`/static/2025/Index.json`), so an F1 TV token is required |
| F1 account sign-in steps 1–2 against the real services | client config parsed from `account.formula1.com`; `/as/authorize` returned a form descriptor with a submit URL on `id.formula1.com` |
| Invalid token against the real archive | rejected; connection marked `expired`; caller sees `provider_error` "Sign in again" |

## Gaps

- **Browser end-to-end tests:** none.
- **Python backtest on real data:** only one real weekend is ingested; at least 5 are needed. It has not been run.
- **Calibration:** no `pace` model version has been calibrated or activated, so all probabilities are reported as uncalibrated.
- **Live data:** live OpenF1 polling has not been verified.
- **FastF1 validation:** not executed (FastF1 ≥ 3.9 also needs `python -m fastf1 auth f1tv`).
- **F1 live timing (`f1lt`):** credential submit and token exchange, parsing of a real archive session and the live SignalR feed have not been verified. They need a real F1 TV subscription. Comparing `f1lt` laps with `openf1` for the same session key is the planned check.
- **Jolpica adapter:** not exercised against its live API.
- **Strategy simulator:** compared against synthetic expectations only, not against historical race outcomes.
