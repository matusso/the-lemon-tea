import { parseArgs } from "node:util";
import { systemContext } from "@lemon-tea/auth";
import { buildRuntime } from "../container.ts";

/**
 * Operator CLI for ingestion, e.g.
 *   npm run ingest -- --session openf1:9912 --public
 *   npm run ingest -- --discover --year 2025
 * Runs as the system identity; use --public only for data whose terms allow it to be shared
 * with every user of this installation.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      session: { type: "string", multiple: true },
      public: { type: "boolean", default: false },
      tenant: { type: "string" },
      channels: { type: "string", default: "timing,car_data,location" },
      discover: { type: "boolean", default: false },
      year: { type: "string" },
      source: { type: "string", default: "openf1" },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const rt = buildRuntime({ DATABASE_URL: url, OPENF1_USERNAME: process.env.OPENF1_USERNAME, OPENF1_PASSWORD: process.env.OPENF1_PASSWORD, APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY, publicSources: [] });
  try {
    if (values.discover) {
      const sessions = await rt.services.providers.resolve(values.source!, values.tenant ?? null).listSessions(Number(values.year ?? new Date().getUTCFullYear()));
      for (const s of sessions) console.log(`${values.source}:${s.sessionKey}\t${s.dateStart.slice(0, 10)}\t${s.circuitShortName}\t${s.name}`);
      return;
    }
    if (!values.session?.length) throw new Error("--session <source:key> is required");
    if (!values.public && !values.tenant) throw new Error("Use --public or --tenant <tenant uuid> for private ingestion");
    const ctx = { ...systemContext(), tenantId: values.tenant ?? null };
    const channels = values.channels!.split(",") as ("timing" | "car_data" | "location")[];
    for (const sessionId of values.session) {
      const t0 = Date.now();
      let last = -10;
      const r = await rt.services.ingestion!.ingest(ctx, { sessionId, channels, visibility: values.public ? "public" : "private" }, (p) => {
        const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
        if (pct >= last + 10) {
          last = pct;
          console.log(`  ${sessionId} ${p.stage} ${pct}%`);
        }
      });
      console.log(`ingested ${sessionId}: ${r.drivers} drivers, ${r.laps} laps, ${r.carSamples} car samples, ${r.positionSamples} positions in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  } finally {
    await rt.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
