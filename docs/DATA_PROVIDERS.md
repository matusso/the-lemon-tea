# Provider SDK and adapter guide

Providers implement `ProviderAdapter` from `packages/provider-sdk/src/index.ts` and are registered in a `ProviderRegistry` (`apps/api/src/container.ts`, and `apps/api/src/worker.ts` on Cloudflare).

```ts
interface ProviderAdapter {
  readonly id: string;                         // must match a data_sources.id row
  capabilities(): ProviderCapabilities;        // channels, auth, live, coverage, rate limit, licensingSourceId
  health(): Promise<ProviderHealth>;
  listSessions(year: number): Promise<SessionListing[]>;
  fetchSession(sessionKey: string): Promise<SessionBundle>;   // timing + metadata
  fetchCarSamples(sessionKey, driverNumber, fromIso, toIso): Promise<CarSamples>;
  fetchPositionSamples(sessionKey, driverNumber, fromIso, toIso): Promise<PositionSamples>;
  pollLive?(sessionKey, cursor: string | null): Promise<LiveDelta>;
  lastQuality?(): Record<string, unknown>;     // source-level notes merged into the quality report
}
```

## Account-scoped providers

Some sources authenticate with **each user's own account** (today: `f1lt`, the Formula 1 account). They are registered with `ProviderRegistry.registerScoped(id, factory)`:

- `registry.get(id)` returns an instance without credentials, used only for `capabilities()`.
- `registry.resolve(id, tenantId)` builds an instance whose `authorization()` reads that tenant's encrypted token through `ProviderAccountService.tokenFor`. A 401/403 from the source calls `markExpired`.
- Ingestion and discovery always use `resolve(source, ctx.tenantId)`, and ingestion refuses `public` visibility for scoped providers.
- Live sessions get one provider instance (and so one upstream connection) per tenant: keyed by the private session uid on Node, and one Durable Object per (session, tenant) on Workers.

Wiring lives in `apps/api/src/providers.ts` (`createProviders`, `bindAccountProviders`), shared by `container.ts` and `worker.ts`.

## Normalisation contract

- Times: ISO-8601 UTC strings in bundles; **epoch milliseconds** in sample arrays.
- Units: seconds, km/h, metres, throttle %, brake 0/1.
- Samples are sorted by time, duplicate timestamps are dropped, and incomplete samples are dropped. Nothing is zero-filled. A channel the source lacks is omitted, not filled with zeros.
- Session ids are `<provider id>:<source key>`; meetings and circuits use the same prefix.
- Source text (race-control messages) is length-capped and stored verbatim as untrusted data.
- `capabilities().channels` marks every channel `measured`, `calculated`, `estimated` or `unavailable`.

## HTTP client (`packages/provider-sdk/src/http.ts`)

`ProviderHttpClient` gives every adapter:

| Concern | Behaviour |
|---|---|
| Rate limiting | Token bucket per client (`requestsPerSecond`, `burst`); requests are serialised through it |
| Retries | Retries 429 and 5xx responses and network errors, up to `maxRetries` (default 5). Honours `Retry-After`; otherwise exponential backoff `min(30 s, 500 ms·2^n)` with ±25 % jitter |
| Timeouts | `timeoutMs`, default 60 s, via `AbortController` |
| SSRF | `assertSafeUrl` allows only https (http only when `allowHttp` is set, e.g. localhost) and only allow-listed hosts. It blocks URL credentials, `localhost` / `.localhost` / `.internal` / IPv6 literals unless allow-listed, and private/loopback/link-local/CGNAT IPv4 literals. Redirects are rejected (`redirect: "error"`) |
| Size | Bodies above `maxBytes` (default 200 MB) are rejected |
| Credentials | `authorization()` callback returns a header value server-side; the OpenF1 adapter uses an OAuth password grant against `/token` and caches the token until 60 s before expiry. A failing credential lookup (e.g. no connected account) is not retried |
| Text | `getText()` for non-JSON bodies (live timing `.jsonStream`); `getJson()` uses it |

## Adding a provider

1. Add a governance row to a new migration (`database/migrations/000N_*.sql`): licence, permitted use, redistribution, attribution, rate limit, missing channels. Leave `public_display_allowed = false` unless the terms clearly allow public display.
2. Create `packages/providers/<name>` with `package.json` (`@lemon-tea/provider-<name>`) and `src/index.ts` implementing `ProviderAdapter`. Use `ProviderHttpClient` with an explicit `allowedHosts` list.
3. Map source fields to `SessionBundle`, `CarSamples` and `PositionSamples` in the units above. Write unit tests on **synthetic or self-authored** payloads; never commit real provider data.
4. Register it in `createProviders()` (`apps/api/src/providers.ts`), which both `apps/api/src/container.ts` and `apps/api/src/worker.ts` use. Account-scoped providers go in `bindAccountProviders()`.
5. Ingest with `npx tsx apps/api/src/cli/ingest.ts --source <id> --discover --year <y>`, then `--session <id>:<key> --tenant <uuid>` (private) or `--public` (operator decision).

## Ingestion

`IngestionService.ingest` (`packages/domain/src/ingestion.ts`):

1. Fetches the timing bundle, upserts circuit, meeting and session, and replaces all timing tables for that session. Re-ingesting therefore picks up source corrections.
2. Fetches car and location samples per driver in 20-minute windows, from 15 minutes before session start to 5 minutes after the last lap end (capped at now). It inserts with `ON CONFLICT DO NOTHING`, which de-duplicates on `(session_uid, driver_number, t)`.
3. Writes a `data_quality_reports` row (laps without time or start, drivers without car or position data, sample counts).
4. Marks the session `complete` only if all three channel groups were requested and every driver has car data; otherwise `partial`.

Ingestion can be cancelled between windows when run as a job. Public ingestion requires the `admin` scope; private ingestion requires `ingest:write`. Account-scoped sources (`f1lt`) can only be ingested privately, with the caller's own token, e.g. `npm run ingest -- --session f1lt:2025-9908 --tenant <tenant uuid>` (discover with `--discover --source f1lt --tenant <uuid> --year 2025`).

## Live

`pollLive` is optional. `LiveSessionCoordinator` (`apps/api/src/live.ts`) calls it every 2 s while viewers are connected and backs off up to 60 s on failure. It records both the source timestamp and the platform receive time, so source latency is shown rather than hidden. **OpenF1 live polling has not been verified against an authenticated account.**

`f1lt` implements `pollLive` on top of a push feed: `F1LiveFeed` (`packages/providers/f1-livetiming/src/live.ts`) holds one SignalR connection per tenant instance and buffers updates, and each poll drains what arrived since the previous one. Polling a session that is not the one currently live is an error. A dropped connection is rebuilt on the next (backed-off) poll. Node opens the socket with the `ws` package, because the upgrade needs an `Authorization` header. The Worker uses `fetch` with `Upgrade: websocket`. **Not yet verified against a running session.**
