import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { compress } from "hono/compress";
import { z } from "zod";
import {
  CompareLapsInput,
  CompareTeamsInput,
  CornerInput,
  CreateJobInput,
  DegradationInput,
  HTTP_STATUS,
  IngestInput,
  IngestWeekendInput,
  LemonTeaError,
  PracticeInput,
  PredictQualifyingInput,
  PredictRaceResultInput,
  SessionId,
  SimulateStrategyInput,
  TelemetryInput,
  TrackDominanceInput,
  type AuthContext,
} from "@lemon-tea/shared-types";
import { anonymousContext, randomToken, sha256, userContext, verifyPassword, type IdentityStore } from "@lemon-tea/auth";
import { paceParams, type Services } from "@lemon-tea/domain";
import type { FileImportProvider } from "@lemon-tea/provider-file-import";
import type { Config } from "./config.ts";
import { bodyLimit, rateLimit, securityHeaders } from "./security.ts";
import { mountOAuth } from "./oauth-routes.ts";
import { mountMcp } from "./mcp-route.ts";

export type AppEnv = { Variables: { auth: AuthContext; sessionToken: string | null } };

export interface AppDeps {
  services: Services;
  identity: IdentityStore;
  config: Config;
  fileImport?: FileImportProvider;
}

const SESSION_COOKIE = "lt_session";
const SESSION_TTL_MS = 7 * 24 * 3600_000;

/** Resolve the caller: personal API token (Bearer lt_pat_*), browser session cookie, or anonymous. */
export async function resolveAuth(c: Context<AppEnv>, d: AppDeps): Promise<{ auth: AuthContext; sessionToken: string | null }> {
  const authz = c.req.header("authorization");
  if (authz?.startsWith("Bearer lt_pat_")) {
    const rec = await d.identity.apiToken(await sha256(authz.slice(7)));
    if (!rec) throw new LemonTeaError("unauthorized", "Invalid API token");
    return { auth: userContext(rec.user, "api", rec.scopes as never), sessionToken: null };
  }
  if (authz) {
    // MCP OAuth tokens are audience-bound to /mcp and are not valid here; never fall back to anonymous.
    throw new LemonTeaError("unauthorized", "Unsupported credentials for the REST API; use a personal API token (lt_pat_...) or a browser session");
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) {
    const user = await d.identity.appSessionUser(await sha256(cookie));
    if (user) return { auth: userContext(user, "web"), sessionToken: cookie };
  }
  const anon = anonymousContext("web");
  if (!d.config.ALLOW_ANONYMOUS) anon.scopes = new Set();
  return { auth: anon, sessionToken: null };
}

function errorResponse(c: Context, e: unknown) {
  if (e instanceof LemonTeaError) return c.json(e.toJSON(), HTTP_STATUS[e.code] as never);
  if (e instanceof z.ZodError) {
    return c.json({ error: { code: "invalid_input", message: "Invalid input", details: { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } } }, 400);
  }
  console.error("[api] unhandled error:", (e as Error)?.message ?? e);
  return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
}

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

/** Resolve the caller of a raw Request (e.g. a WebSocket upgrade handled outside the app). */
export async function authenticateRequest(req: Request, d: AppDeps): Promise<AuthContext> {
  const probe = new Hono<AppEnv>();
  let out: AuthContext | null = null;
  probe.all("*", async (c) => {
    out = (await resolveAuth(c, d)).auth;
    return c.body(null, 204);
  });
  await probe.fetch(new Request(req.url, { headers: req.headers }));
  if (!out) throw new LemonTeaError("unauthorized", "Could not authenticate the request");
  return out;
}

export function createApp(d: AppDeps) {
  const { services: s, config } = d;
  const app = new Hono<AppEnv>();

  app.onError((e, c) => errorResponse(c, e));
  app.use("*", securityHeaders());
  app.use("/api/*", compress());
  app.use("*", async (c, next) => (c.req.path === "/api/imports" ? bodyLimit(60_000_000)(c, next) : bodyLimit(1_000_000)(c, next)));

  // Strict CORS: only configured origins, credentials allowed for those only.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && config.origins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Headers", "content-type, authorization, x-requested-with");
      c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const r = await resolveAuth(c, d);
    c.set("auth", r.auth);
    c.set("sessionToken", r.sessionToken);
    // CSRF: cookie-authenticated state changes need a custom header (forces CORS preflight) and a trusted Origin.
    if (r.sessionToken && c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (c.req.header("x-requested-with") !== "lemon-tea" || (origin && !config.origins.includes(origin))) {
        throw new LemonTeaError("forbidden", "CSRF check failed");
      }
    }
    await next();
  });
  app.use(
    "/api/*",
    rateLimit(config.RATE_LIMIT_PER_MINUTE, (c) => c.get("auth")?.userId ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"),
  );

  const auth = (c: Context<AppEnv>) => c.get("auth");
  const body = async <S extends z.ZodTypeAny>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> => schema.parse(await c.req.json().catch(() => ({})));
  const sid = (c: Context<AppEnv>) => SessionId.parse(decodeURIComponent(c.req.param("id")!));

  // ------------------------------------------------------------------ meta & auth
  app.get("/api/health", (c) => c.json({ ok: true, service: "the-lemon-tea", time: new Date().toISOString() }));

  app.post("/api/auth/login", async (c) => {
    const { email, password } = await body(c, z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }));
    const user = await d.identity.userByEmail(email);
    // Verify against a dummy hash when the user does not exist to keep timing uniform.
    const ok = await verifyPassword(password, user?.passwordHash ?? "pbkdf2$310000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    if (!user || !ok) {
      await s.store.audit({ userId: null, tenantId: null, via: "web", action: "auth.login", outcome: "denied" });
      throw new LemonTeaError("unauthorized", "Invalid email or password");
    }
    const token = randomToken(32);
    await d.identity.createAppSession(await sha256(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    await s.store.audit({ userId: user.id, tenantId: user.tenantId, via: "web", action: "auth.login", outcome: "ok" });
    return c.json({ user: { id: user.id, email: user.email, role: user.role } });
  });

  app.post("/api/auth/logout", async (c) => {
    const t = c.get("sessionToken");
    if (t) await d.identity.deleteAppSession(await sha256(t));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    const a = auth(c);
    if (a.anonymous) return c.json({ anonymous: true, scopes: [...a.scopes] });
    const u = await d.identity.userById(a.userId!);
    return c.json({ anonymous: false, user: { id: u!.id, email: u!.email, role: u!.role }, scopes: [...a.scopes] });
  });

  app.post("/api/auth/tokens", async (c) => {
    const a = auth(c);
    if (a.anonymous || a.via !== "web") throw new LemonTeaError("unauthorized", "Sign in to create API tokens");
    const q = await body(c, z.object({ name: z.string().min(1).max(60), scopes: z.array(z.string()).min(1).max(10), expiresInDays: z.number().int().min(1).max(365).default(90) }));
    const allowed = q.scopes.filter((sc) => a.scopes.has(sc as never) && sc !== "admin");
    const token = `lt_pat_${randomToken(32)}`;
    await d.identity.createApiToken(await sha256(token), a.userId!, q.name, allowed, new Date(Date.now() + q.expiresInDays * 86400_000));
    return c.json({ token, scopes: allowed, note: "Shown once. Store it securely." });
  });

  // ------------------------------------------------------------------ sessions & timing
  app.get("/api/sources", async (c) => c.json(await s.sessions.dataSources(auth(c))));
  app.get("/api/seasons", async (c) => c.json(await s.sessions.listSeasons(auth(c))));
  app.get("/api/meetings", async (c) => c.json(await s.sessions.listMeetings(auth(c), num(c.req.query("year")))));
  app.get("/api/sessions", async (c) => {
    const type = c.req.query("type");
    const year = num(c.req.query("year"));
    const meetingId = c.req.query("meetingId");
    return c.json(
      await s.sessions.listSessions(auth(c), {
        ...(year !== undefined ? { year } : {}),
        ...(meetingId ? { meetingId } : {}),
        ...(type ? { type } : {}),
        ingestedOnly: c.req.query("ingestedOnly") === "true",
        limit: Math.min(200, num(c.req.query("limit")) ?? 100),
      }),
    );
  });
  app.get("/api/sessions/:id", async (c) => c.json(await s.sessions.info(auth(c), sid(c))));
  app.get("/api/sessions/:id/availability", async (c) => c.json(await s.sessions.dataAvailability(auth(c), sid(c))));
  app.get("/api/sessions/:id/drivers", async (c) => c.json(await s.sessions.drivers(auth(c), sid(c))));
  app.get("/api/sessions/:id/circuit", async (c) => c.json(await s.circuits.circuit(auth(c), sid(c))));
  app.get("/api/sessions/:id/bundle", async (c) => c.json(await s.timing.bundle(auth(c), sid(c))));
  app.get("/api/sessions/:id/timing", async (c) => c.json(await s.timing.timing(auth(c), sid(c), num(c.req.query("t")))));
  app.get("/api/sessions/:id/timeline", async (c) => c.json(await s.timing.timeline(auth(c), sid(c))));
  app.get("/api/sessions/:id/laps/:driver", async (c) => c.json(await s.timing.driverLaps(auth(c), sid(c), Number(c.req.param("driver")))));
  app.get("/api/sessions/:id/race-control", async (c) => c.json(await s.timing.raceControl(auth(c), sid(c))));
  app.get("/api/sessions/:id/pits", async (c) => c.json(await s.timing.pitStops(auth(c), sid(c))));
  app.get("/api/sessions/:id/weather", async (c) => c.json(await s.timing.weather(auth(c), sid(c), num(c.req.query("t")))));
  app.get("/api/sessions/:id/radio", async (c) => c.json(await s.timing.teamRadio(auth(c), sid(c), num(c.req.query("driver")))));
  app.get("/api/sessions/:id/position", async (c) => c.json(await s.timing.positionAt(auth(c), sid(c), Number(c.req.query("t") ?? 0), num(c.req.query("driver")))));
  app.get("/api/sessions/:id/replay", async (c) => {
    const from = Number(c.req.query("from") ?? 0);
    const to = Number(c.req.query("to") ?? from + 120_000);
    return c.json(await s.timing.replayWindow(auth(c), sid(c), from, to, Math.min(10, num(c.req.query("hz")) ?? 4)));
  });
  app.get("/api/sessions/:id/telemetry", async (c) => {
    const q = TelemetryInput.parse({
      sessionId: sid(c),
      driverNumber: num(c.req.query("driver")),
      lapNumber: num(c.req.query("lap")),
      fromMs: num(c.req.query("from")),
      toMs: num(c.req.query("to")),
      maxPoints: num(c.req.query("maxPoints")),
    });
    return c.json(await s.telemetry.telemetry(auth(c), q));
  });
  // Rights-aware exports (source redistribution terms are enforced in ExportService).
  app.get("/api/sessions/:id/export/laps", async (c) => {
    const f = c.req.query("format") === "json" ? "json" : "csv";
    const e = await s.exports.laps(auth(c), sid(c), f);
    return c.body(e.body, 200, { "content-type": e.contentType, "content-disposition": `attachment; filename="${e.filename}"` });
  });
  app.get("/api/sessions/:id/export/telemetry", async (c) => {
    const f = c.req.query("format") === "json" ? "json" : "csv";
    const q = z.object({ driver: z.coerce.number().int().min(1).max(999), lap: z.coerce.number().int().min(1).optional() }).parse({ driver: c.req.query("driver"), lap: c.req.query("lap") });
    const e = await s.exports.lapTelemetry(auth(c), sid(c), q.driver, q.lap, f);
    return c.body(e.body, 200, { "content-type": e.contentType, "content-disposition": `attachment; filename="${e.filename}"` });
  });
  app.get("/api/sessions/:id/theoretical-best", async (c) => c.json(await s.laps.theoreticalBest(auth(c), sid(c), num(c.req.query("driver")))));

  // ------------------------------------------------------------------ analysis (same services as MCP)
  app.post("/api/analysis/compare", async (c) => c.json(await s.laps.compare(auth(c), await body(c, CompareLapsInput))));
  app.post("/api/analysis/delta", async (c) => c.json(await s.laps.lapDelta(auth(c), await body(c, CompareLapsInput))));
  app.post("/api/analysis/corner", async (c) => c.json(await s.laps.corner(auth(c), await body(c, CornerInput))));
  app.post("/api/analysis/braking", async (c) => c.json(await s.laps.braking(auth(c), await body(c, CompareLapsInput))));
  app.post("/api/analysis/acceleration", async (c) => c.json(await s.laps.acceleration(auth(c), await body(c, CompareLapsInput))));
  app.post("/api/analysis/dominance", async (c) => c.json(await s.laps.dominance(auth(c), await body(c, TrackDominanceInput))));
  app.post("/api/analysis/driver-style", async (c) => c.json(await s.laps.driverStyle(auth(c), await body(c, z.object({ sessionId: SessionId, driverNumber: z.number().int() })))));
  app.post("/api/analysis/teams", async (c) => c.json(await s.laps.compareTeams(auth(c), await body(c, CompareTeamsInput), s.timing)));

  app.post("/api/practice/long-runs", async (c) => {
    const q = await body(c, PracticeInput);
    return c.json(await s.practice.longRuns(auth(c), q.sessionIds, await paceParams(s.store)));
  });
  app.post("/api/tyres/degradation", async (c) => c.json(await s.tyres.degradation(auth(c), await body(c, DegradationInput))));
  app.post("/api/tyres/compare", async (c) => c.json(await s.tyres.compareTyres(auth(c), await body(c, PracticeInput))));
  app.post("/api/predictions/qualifying", async (c) => c.json(await s.qualifying.predict(auth(c), await body(c, PredictQualifyingInput))));
  app.post("/api/predictions/race-pace", async (c) => c.json(await s.racePace.predict(auth(c), await body(c, PracticeInput))));
  app.post("/api/predictions/race-result", async (c) => {
    const q = await body(c, PredictRaceResultInput);
    return c.json(await s.strategy.raceResult(auth(c), { ...q, iterations: Math.min(q.iterations, 2000) }));
  });
  app.post("/api/strategy/simulate", async (c) => {
    const q = await body(c, SimulateStrategyInput);
    return c.json(await s.strategy.simulate(auth(c), { ...q, iterations: Math.min(q.iterations, 2000) }));
  });
  app.get("/api/predictions/history", async (c) => {
    const meetingId = c.req.query("meetingId");
    const q = c.req.query("qualifyingSessionId");
    return c.json(await s.evaluation.predictionHistory(auth(c), { ...(meetingId ? { meetingId } : {}), ...(q ? { qualifyingSessionId: SessionId.parse(q) } : {}) }));
  });
  app.get("/api/models/metrics", async (c) => c.json(await s.evaluation.modelMetrics(auth(c), c.req.query("family"))));

  // ------------------------------------------------------------------ jobs
  app.post("/api/jobs", async (c) => c.json(await s.jobs.create(auth(c), await body(c, CreateJobInput)), 202));
  app.get("/api/jobs/:jobId", async (c) => c.json(await s.jobs.get(auth(c), z.string().uuid().parse(c.req.param("jobId")))));
  app.get("/api/jobs/:jobId/result", async (c) => c.json(await s.jobs.result(auth(c), z.string().uuid().parse(c.req.param("jobId")))));
  app.delete("/api/jobs/:jobId", async (c) => c.json(await s.jobs.cancel(auth(c), z.string().uuid().parse(c.req.param("jobId")))));

  // ------------------------------------------------------------------ provider accounts (provider auth)
  // A user's own provider account (e.g. Formula 1 account → F1 TV subscription token). Responses
  // only ever carry status; tokens and passwords never leave the server. MCP has no such route.
  const providerParam = (c: Context<AppEnv>) => {
    const p = c.req.param("provider") ?? "";
    if (!s.connections.providers().includes(p)) throw new LemonTeaError("not_found", `No account connection for provider '${p}'`);
    return p;
  };
  app.get("/api/connections", async (c) => {
    const a = auth(c);
    return c.json(await Promise.all(s.connections.providers().map((p) => s.connections.status(a, p))));
  });
  app.get("/api/connections/:provider", async (c) => c.json(await s.connections.status(auth(c), providerParam(c))));
  // Credentials are forwarded to the provider's identity service once and never stored.
  const signInLimiter = rateLimit(5, (c) => `connect:${c.get("auth")?.userId ?? c.req.header("cf-connecting-ip") ?? "local"}`);
  app.post("/api/connections/:provider/sign-in", signInLimiter, async (c) => {
    const q = await body(c, z.object({ username: z.string().min(3).max(320), password: z.string().min(1).max(512) }));
    return c.json(await s.connections.signIn(auth(c), providerParam(c), q.username, q.password));
  });
  app.post("/api/connections/:provider/token", signInLimiter, async (c) => {
    const q = await body(c, z.object({ token: z.string().min(20).max(16_384) }));
    return c.json(await s.connections.connectWithToken(auth(c), providerParam(c), q.token));
  });
  app.delete("/api/connections/:provider", async (c) => c.json(await s.connections.disconnect(auth(c), providerParam(c))));

  // ------------------------------------------------------------------ ingestion (authenticated)
  app.get("/api/ingest/discover", async (c) => {
    const a = auth(c);
    s.access.require(a, "ingest:write");
    if (!s.ingestion) throw new LemonTeaError("internal", "Ingestion not configured");
    return c.json(await s.ingestion.discover(a, c.req.query("source") ?? "openf1", Number(c.req.query("year") ?? new Date().getUTCFullYear())));
  });
  app.post("/api/ingest", async (c) => {
    const q = await body(c, IngestInput);
    const a = auth(c);
    return c.json(await s.jobs.create(a, { kind: "ingest_session", input: q, idempotencyKey: `ingest:${q.sessionId}:${q.visibility}:${q.channels.join(",")}:${new Date().toISOString().slice(0, 13)}` }), 202);
  });
  app.post("/api/ingest/weekend", async (c) => {
    const q = await body(c, IngestWeekendInput);
    const a = auth(c);
    const key = `ingest_weekend:${q.source}:${q.year}:${q.meetingKey}:${q.visibility}:${q.channels.join(",")}:${new Date().toISOString().slice(0, 13)}`;
    return c.json(await s.jobs.create(a, { kind: "ingest_weekend", input: q, idempotencyKey: key }), 202);
  });

  // User telemetry imports: always private to the importing tenant.
  app.post("/api/imports", async (c) => {
    const a = auth(c);
    s.access.require(a, "ingest:write");
    if (!s.ingestion || !d.fileImport) throw new LemonTeaError("internal", "File import not configured");
    const Table = z.union([
      z.object({ format: z.literal("json"), rows: z.array(z.unknown()).max(5_000_000) }),
      z.object({ format: z.literal("csv"), text: z.string() }),
      z.object({ format: z.literal("parquet"), base64: z.string() }),
    ]);
    const q = await body(c, z.object({ manifest: z.unknown(), car: Table.optional(), location: Table.optional() }));
    const table = (t: z.infer<typeof Table> | undefined) =>
      t === undefined ? undefined : t.format === "parquet" ? { format: "parquet" as const, bytes: Uint8Array.from(atob(t.base64), (ch) => ch.charCodeAt(0)).buffer } : t;
    const staged = await d.fileImport.stage(q.manifest, { ...(q.car ? { car: table(q.car)! } : {}), ...(q.location ? { location: table(q.location)! } : {}) });
    try {
      const result = await s.ingestion.ingest(a, { sessionId: `file_import:${staged.sessionKey}`, channels: ["timing", "car_data", "location"], visibility: "private" });
      return c.json({ ...result, report: staged.report });
    } finally {
      d.fileImport.release(staged.sessionKey);
    }
  });

  // ------------------------------------------------------------------ OAuth + MCP
  mountOAuth(app, d);
  mountMcp(app, d);

  return app;
}

