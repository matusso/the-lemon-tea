import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "@lemon-tea/db";
import { createApp, resolveAuth } from "./app.ts";
import { loadConfig } from "./config.ts";
import { bootstrapAdmin, buildRuntime } from "./container.ts";
import { LiveSessionCoordinator } from "./live.ts";

/** Self-hosted Node entry: API + MCP + OAuth + live WebSocket + static web app. */
async function main() {
  const config = loadConfig(process.env);
  if (process.env.MIGRATE_ON_START === "true" && process.env.MIGRATION_DATABASE_URL) {
    await migrate(process.env.MIGRATION_DATABASE_URL);
  }
  const rt = buildRuntime(config);
  await bootstrapAdmin(rt, config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
  const deps = { services: rt.services, identity: rt.identity, config, fileImport: rt.fileImport };
  const app = createApp(deps);

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const coordinators = new Map<string, LiveSessionCoordinator>();
  app.get(
    "/ws/live/:id",
    upgradeWebSocket(async (c) => {
      const id = decodeURIComponent(c.req.param("id")!);
      let unsubscribe: (() => void) | null = null;
      return {
        async onOpen(_e, ws) {
          try {
            const { auth } = await resolveAuth(c as never, deps);
            const s = await rt.services.access.session(auth, id, "telemetry:read");
            // Account-scoped sources (F1 live timing) poll with this tenant's own provider account.
            const provider = rt.services.providers.resolve(s.source, auth.tenantId);
            let coord = coordinators.get(s.uid);
            if (!coord) {
              coord = new LiveSessionCoordinator(id, provider, id.split(":")[1]!);
              coordinators.set(s.uid, coord);
            }
            unsubscribe = coord.subscribe({ send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() });
          } catch (e) {
            ws.send(JSON.stringify({ type: "status", payload: { state: "error", error: (e as Error).message } }));
            ws.close(1008, "unauthorized or unavailable");
          }
        },
        onClose() {
          unsubscribe?.();
        },
      };
    }),
  );

  const dist = config.WEB_DIST ?? resolve(process.cwd(), "apps/web/dist");
  if (existsSync(dist)) {
    app.use("/*", serveStatic({ root: dist }));
    const index = readFileSync(resolve(dist, "index.html"), "utf8");
    app.get("*", (c) => (c.req.path.startsWith("/api/") || c.req.path === "/mcp" ? c.notFound() : c.html(index)));
  }

  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: process.env.HOST ?? "0.0.0.0" }, (i) => {
    console.log(`[lemon-tea] listening on http://localhost:${i.port}  (MCP: ${config.mcpResource})`);
  });
  injectWebSocket(server);

  const shutdown = async () => {
    for (const c of coordinators.values()) c.stop();
    server.close();
    await rt.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
