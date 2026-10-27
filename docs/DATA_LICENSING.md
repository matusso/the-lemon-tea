# Data licensing and governance

The source code is Apache-2.0. **Data is not.** Each source keeps its own terms, recorded in `data_sources` (see [DATA_SOURCES.md](DATA_SOURCES.md)). The repository contains no real F1 data. Test fixtures are synthetic and labelled as such.

## Public versus private data

| Row | Who can read it |
|---|---|
| Session with `owner_tenant_id IS NULL` (ingested with `--public` by an admin) | Every signed-in user of the installation. Anonymous visitors only if the source's `public_display_allowed` is true **or** its id is listed in `PUBLIC_SOURCES` |
| Session with `owner_tenant_id = <tenant>` | That tenant only, enforced by PostgreSQL row-level security and `AccessPolicy` |
| File imports | Always private to the importer |
| F1 Live Timing (`f1lt`) sessions | Always private to the tenant whose Formula 1 account fetched them; public ingestion is refused |

OpenF1 is seeded with `public_display_allowed = false`. On a fresh install, anonymous visitors see no OpenF1 data until the operator decides otherwise, either by updating the registry row or by setting `PUBLIC_SOURCES=openf1`. That decision belongs to the operator and should follow from reading the provider's terms.

Circuit layouts derived from public sessions are persisted and shared. Layouts derived from a tenant's private data stay in that process's memory for that tenant only.

Shared model parameters are trained by `services/analytics` from **public sessions only** (`owner_tenant_id IS NULL`), so private data never influences what other users are served.

## Team radio

Radio items store only the source's recording URL and are marked `redistribution: "link_only"`. The platform does not download, re-host, transcribe or proxy audio. Clients link to the original source.

## FastF1

Used only for local validation in the Python service. Its cache stays local and nothing it returns is stored or redistributed.

## F1 Live Timing and F1 TV

`f1lt` reads the F1 live timing **data** feed (the one FastF1 uses) with the user's own Formula 1 account. Since 2025 that feed requires an F1 TV subscription token. The platform:

- uses each user's token only for that user's own requests, and keeps the data private to their tenant (`public_display_allowed = false`, `redistribution = forbidden`; public ingestion, anonymous display and exports are refused),
- sends Formula 1 passwords only to Formula 1's sign-in service (`id.formula1.com`) and never stores them. Users can paste a token instead,
- does not treat a subscription as permission to redistribute data. Use remains subject to Formula 1's terms, which each user is responsible for,
- does not link or re-host team radio audio from this source.

`f1tv` (F1 TV **video**) remains a disabled placeholder (`redistribution = forbidden`, `enabled = false`). The project does not scrape, proxy or re-host F1 TV video or streams.

## Exports

`ExportService` (`packages/domain/src/services/export.ts`) serves:

- `GET /api/sessions/:id/export/laps?format=csv|json`
- `GET /api/sessions/:id/export/telemetry?driver=&lap=&format=csv|json`

An export is allowed only if one of these holds:
- the source's `redistribution` is `permitted`, `attribution_required` or `non_commercial`, or
- the session is the caller's own private `file_import` session.

Otherwise it returns 403 `forbidden`. Normal session access rules apply first.

CSV output starts with a `# {provenance json}` line that includes the source attribution. Text cells starting with `= + - @` (or a tab or carriage return) are prefixed with `'` to neutralise spreadsheet formula injection.

**Parquet export is not implemented.** Parquet *import* is.

## Raw payload retention

The `raw_payloads` index table exists, but **archiving raw provider payloads to object storage is not implemented**. Only normalised rows are stored today.
