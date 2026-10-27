# Contributing

## Setup

```bash
npm install
cp .env.example .env            # fill secrets
docker compose up -d db
npx tsx --env-file=.env packages/db/src/migrate.ts
npm run dev:api & npm run dev:web
cd services/analytics && uv sync
```

## Before opening a pull request

```bash
npm run typecheck
npm test
cd services/analytics && uv run pytest
```

- Match the style of the surrounding code: naming, comment density, idioms. Comments should explain *why*.
- Put analytics in `packages/telemetry-core` (pure, deterministic, seeded), expose them through a domain service, then wire REST and MCP to that service. Do not implement an algorithm twice.
- New inputs get a zod schema in `packages/shared-types/src/inputs.ts`, shared by REST and MCP.
- Every new number must be labelled measured, calculated, estimated or simulated, and carry assumptions where relevant.
- Tests for algorithms should use ground-truth synthetic fixtures. Simulations must use fixed seeds.
- Schema changes go in a new `database/migrations/000N_*.sql`. Never edit an applied migration.

## Data rights

- **Never commit real Formula 1 data** (provider responses, telemetry dumps, audio, images) to the repository, including test fixtures. Use generated synthetic data and label it as such.
- Do not add integrations that scrape, reverse-engineer or proxy services without authorisation (see [docs/DATA_LICENSING.md](docs/DATA_LICENSING.md)).
- New providers need a governance row; see [docs/DATA_PROVIDERS.md](docs/DATA_PROVIDERS.md).

## Licence

Contributions are accepted under Apache-2.0.
