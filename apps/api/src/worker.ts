/**
 * Cloudflare Workers entry. Same Hono app, domain services, MCP tools and OAuth as the Node
 * server; only the platform bindings differ:
 *   - PostgreSQL through Hyperdrive (env.HYPERDRIVE.connectionString)
 *   - jobs pushed to a Queue and consumed here; a Cron trigger also sweeps queued jobs
 *   - live WebSocket fan-out in a Durable Object (one per session)
 *   - static web app via the [assets] binding
 * Secrets (APP_JWT_SECRET, APP_ENCRYPTION_KEY, OPENF1_*, ...) are Worker Secrets and never reach the browser.
 */
import { PgIdentityStore, PgStore } from "@lemon-tea/db";
import { createServices } from "@lemon-tea/domain";
import type { WebSocketFactory, WebSocketLike } from "@lemon-tea/provider-f1-livetiming";
import { processJob } from "@lemon-tea/jobs/worker";
import { authenticateRequest, createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { LiveSessionCoordinator } from "./live.ts";
import { accountProviders, bindAccountProviders, createProviders } from "./providers.ts";

/** Header the Worker sets (after authorising) when forwarding a live socket to its Durable Object. */
const TENANT_HEADER = "x-lemontea-tenant";

/** Workers open outbound WebSockets through fetch with an Upgrade header. */
const workerWebSocket: WebSocketFactory = async (url, headers) => {
  const res = await fetch(url.replace(/^wss:/, "https:"), { headers: { ...headers, Upgrade: "websocket" } });
  const ws = (res as unknown as { webSocket?: WebSocket & { accept(): void } }).webSocket;
  if (!ws) throw new Error(`Live timing WebSocket upgrade failed (HTTP ${res.status})`);
  ws.accept();
  const like: WebSocketLike = { send: (d) => ws.send(d), close: (c) => ws.close(c), onopen: null, onmessage: null, onclose: null, onerror: null };
  ws.addEventListener("message", (e) => like.onmessage?.({ data: e.data }));
  ws.addEventListener("close", (e) => like.onclose?.({ code: e.code, reason: e.reason }));
  ws.addEventListener("error", (e) => like.onerror?.(e));
  setTimeout(() => like.onopen?.(), 0); // already open after accept(); fire once handlers are attached
  return like;
};

interface Env {
  HYPERDRIVE: { connectionString: string };
  JOBS?: { send(body: unknown): Promise<void> };
  LIVE: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
  ASSETS?: { fetch(req: Request): Promise<Response> };
  [key: string]: unknown;
}

interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

function runtime(env: Env) {
  const vars = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const config = loadConfig({ ...vars, DATABASE_URL: env.HYPERDRIVE.connectionString });
  // Hyperdrive pools connections at the edge; keep the per-request client small.
  const store = PgStore.connect(config.DATABASE_URL, { max: 3 });
  const identity = new PgIdentityStore(store.sql);
  const { providers, fileImport } = createProviders(config);
  const services = createServices({
    store,
    ingestStore: store,
    providers,
    extraPublicSources: config.publicSources,
    accountProviders,
    ...(config.APP_ENCRYPTION_KEY ? { encryptionKey: config.APP_ENCRYPTION_KEY } : {}),
    ...(env.JOBS ? { onJobCreated: (jobId: string) => env.JOBS!.send({ jobId }) } : {}),
  });
  bindAccountProviders(providers, services, workerWebSocket);
  return { config, store, identity, services, fileImport };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/live/")) {
      // Authorise here, then hand the socket to the session's Durable Object.
      const rt = runtime(env);
      const id = decodeURIComponent(url.pathname.slice("/ws/live/".length));
      const fwd = new Request(req);
      fwd.headers.delete(TENANT_HEADER);
      let name = id;
      try {
        const auth = await authenticateRequest(req, { services: rt.services, identity: rt.identity, config: rt.config });
        const s = await rt.services.access.session(auth, id, "telemetry:read");
        // Account-scoped sources poll with the tenant's own provider account: one object per tenant.
        if (rt.services.providers.isScoped(s.source)) {
          name = `${id}#${auth.tenantId}`;
          fwd.headers.set(TENANT_HEADER, auth.tenantId!);
        }
      } catch {
        return new Response("Not found", { status: 404 });
      } finally {
        ctx.waitUntil(rt.store.close());
      }
      return env.LIVE.get(env.LIVE.idFromName(name)).fetch(fwd);
    }
    const isApi = /^\/(api|mcp|oauth|\.well-known)(\/|$)/.test(url.pathname);
    if (!isApi && env.ASSETS) return env.ASSETS.fetch(req);
    const rt = runtime(env);
    const app = createApp({ services: rt.services, identity: rt.identity, config: rt.config, fileImport: rt.fileImport });
    const res = await app.fetch(req);
    ctx.waitUntil(rt.store.close());
    return res;
  },

  async queue(batch: { messages: { body: { jobId?: string }; ack(): void; retry(): void }[] }, env: Env): Promise<void> {
    const rt = runtime(env);
    try {
      for (const m of batch.messages) {
        const job = await rt.store.claimJob();
        if (job) await processJob(rt.services, rt.identity, job);
        m.ack();
      }
    } finally {
      await rt.store.close();
    }
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const rt = runtime(env);
    try {
      for (let i = 0; i < 3; i++) {
        const job = await rt.store.claimJob();
        if (!job) break;
        await processJob(rt.services, rt.identity, job);
      }
    } finally {
      await rt.store.close();
    }
  },
};

/** One instance per live session: a single provider poller fanned out to all connected viewers. */
export class LiveSession {
  private coordinator: LiveSessionCoordinator | null = null;

  constructor(
    private readonly state: unknown,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const id = decodeURIComponent(new URL(req.url).pathname.slice("/ws/live/".length));
    const [source, key] = id.split(":") as [string, string];
    if (!this.coordinator) {
      const rt = runtime(this.env);
      // Only reachable through the Worker above, which strips client-supplied values of this header.
      const tenant = req.headers.get(TENANT_HEADER);
      this.coordinator = new LiveSessionCoordinator(id, rt.services.providers.resolve(source, tenant), key);
    }
    const pair = new (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, WebSocket & { accept(): void }> }).WebSocketPair();
    const server = pair[1];
    server.accept();
    const unsubscribe = this.coordinator.subscribe({ send: (m) => server.send(JSON.stringify(m)), close: () => server.close() });
    server.addEventListener("close", () => unsubscribe());
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
}

