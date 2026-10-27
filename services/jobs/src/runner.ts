import { buildRuntime } from "@lemon-tea/api/container";
import { processJob } from "./worker.ts";

/**
 * Long-running job worker for self-hosted deployments. Claims jobs with SKIP LOCKED so several
 * runners can work in parallel; on Cloudflare the same processJob runs in a Queue consumer.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const rt = buildRuntime({ DATABASE_URL: url, OPENF1_USERNAME: process.env.OPENF1_USERNAME, OPENF1_PASSWORD: process.env.OPENF1_PASSWORD, APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY, publicSources: [] });
  const concurrency = Number(process.env.JOB_CONCURRENCY ?? 2);
  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));
  console.log(`[jobs] runner started (concurrency ${concurrency})`);

  const loop = async () => {
    while (!stopping) {
      const job = await rt.services.store.claimJob().catch((e) => {
        console.error("[jobs] claim failed:", (e as Error).message);
        return null;
      });
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      await processJob(rt.services, rt.identity, job);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, loop));
  await rt.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
