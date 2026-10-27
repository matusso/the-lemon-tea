import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  authorizationServerMetadata,
  exchangeToken,
  issueCode,
  OAuthError,
  protectedResourceMetadata,
  randomToken,
  registerClient,
  sha256,
  validateAuthorizeRequest,
  verifyPassword,
  type OAuthConfig,
} from "@lemon-tea/auth";
import type { AppDeps, AppEnv } from "./app.ts";
import { escapeHtml, rateLimit } from "./security.ts";

export function oauthConfig(d: AppDeps): OAuthConfig {
  return { issuer: d.config.PUBLIC_URL, resource: d.config.mcpResource, jwtSecret: d.config.APP_JWT_SECRET };
}

const SCOPE_LABELS: Record<string, string> = {
  "sessions:read": "Browse sessions, drivers and timing",
  "telemetry:read": "Read car telemetry and positions",
  "analytics:read": "Run lap, corner and team analyses",
  "predictions:read": "Run and read predictions",
  "simulations:execute": "Run strategy simulations and analysis jobs",
  "reports:read": "Read saved reports",
};

function page(title: string, inner: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · The Lemon Tea</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c0e;color:#e7e9ec;font:14px/1.5 system-ui,sans-serif}
main{width:min(420px,calc(100% - 32px));background:#14161a;border:1px solid #262a31;border-radius:10px;padding:28px}
h1{font-size:18px;margin:0 0 4px}p{color:#9aa1ab}label{display:block;margin:12px 0 4px;color:#9aa1ab;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
input{width:100%;box-sizing:border-box;padding:10px;background:#0b0c0e;border:1px solid #2c313a;border-radius:6px;color:#e7e9ec}
button{margin-top:18px;padding:10px 14px;border-radius:6px;border:0;font-weight:600;cursor:pointer}
.primary{background:#e8d44d;color:#111}.ghost{background:transparent;color:#9aa1ab;border:1px solid #2c313a;margin-left:8px}
ul{padding-left:18px}.err{color:#ff6b6b}.brand{color:#e8d44d;font-weight:700;letter-spacing:.04em}</style></head>
<body><main><div class="brand">THE LEMON TEA</div>${inner}</main></body></html>`;
}

/** CSRF token bound to the browser session (double-submit via HMAC-free hash of session token). */
async function csrfFor(sessionToken: string) {
  return (await sha256(`csrf:${sessionToken}`)).slice(0, 32);
}

export function mountOAuth(app: Hono<AppEnv>, d: AppDeps) {
  const oc = oauthConfig(d);
  const limiter = rateLimit(30, (c) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local");

  const prm = (c: Context) => c.json(protectedResourceMetadata(oc));
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(oc)));

  const oauthError = (c: Context, e: unknown) => {
    if (e instanceof OAuthError) return c.json({ error: e.error, error_description: e.description }, e.status as 400);
    throw e;
  };

  app.post("/oauth/register", limiter, async (c) => {
    try {
      return c.json(await registerClient(d.identity, await c.req.json().catch(() => ({}))), 201);
    } catch (e) {
      return oauthError(c, e);
    }
  });

  app.post("/oauth/token", limiter, async (c) => {
    try {
      const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
      const tokens = await exchangeToken(d.identity, oc, form);
      c.header("Cache-Control", "no-store");
      return c.json(tokens);
    } catch (e) {
      return oauthError(c, e);
    }
  });

  const currentUser = async (c: Context) => {
    const t = getCookie(c, "lt_session");
    if (!t) return null;
    const u = await d.identity.appSessionUser(await sha256(t));
    return u ? { user: u, token: t } : null;
  };

  app.get("/oauth/authorize", async (c) => {
    let req;
    try {
      req = await validateAuthorizeRequest(d.identity, oc, c.req.query());
    } catch (e) {
      const msg = e instanceof OAuthError ? e.description : "Invalid request";
      return c.html(page("Authorization error", `<h1>Authorization error</h1><p class="err">${escapeHtml(msg)}</p>`), 400);
    }
    const me = await currentUser(c);
    const qs = new URL(c.req.url).search;
    if (!me) {
      return c.html(
        page(
          "Sign in",
          `<h1>Sign in to authorise ${escapeHtml(req.clientName)}</h1><p>An AI client is requesting access to your Lemon Tea data. Your password is never shared with it.</p>
<form method="post" action="/oauth/login${escapeHtml(qs)}"><label>Email</label><input name="email" type="email" required autocomplete="username"><label>Password</label><input name="password" type="password" required autocomplete="current-password"><button class="primary">Continue</button></form>`,
        ),
      );
    }
    const csrf = await csrfFor(me.token);
    return c.html(
      page(
        "Authorise",
        `<h1>Authorise ${escapeHtml(req.clientName)}</h1><p>Signed in as ${escapeHtml(me.user.email)}. This client will be able to act on your behalf with:</p>
<ul>${req.scopes.map((s) => `<li>${escapeHtml(SCOPE_LABELS[s] ?? s)}</li>`).join("")}</ul>
<p>Administrative actions and data-provider credentials are never available to MCP clients.</p>
<form method="post" action="/oauth/authorize${escapeHtml(qs)}"><input type="hidden" name="csrf" value="${csrf}">
<button class="primary" name="decision" value="approve">Approve</button><button class="ghost" name="decision" value="deny">Deny</button></form>`,
      ),
    );
  });

  app.post("/oauth/login", limiter, async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? "");
    const password = String(form.password ?? "");
    const user = await d.identity.userByEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    const qs = new URL(c.req.url).search;
    if (!user || !ok) return c.html(page("Sign in", `<h1>Sign in</h1><p class="err">Invalid email or password.</p><p><a href="/oauth/authorize${escapeHtml(qs)}" style="color:#e8d44d">Try again</a></p>`), 401);
    const token = randomToken(32);
    await d.identity.createAppSession(await sha256(token), user.id, new Date(Date.now() + 7 * 24 * 3600_000));
    setCookie(c, "lt_session", token, { httpOnly: true, secure: d.config.cookieSecure, sameSite: "Lax", path: "/", maxAge: 7 * 24 * 3600 });
    return c.redirect(`/oauth/authorize${qs}`, 303);
  });

  app.post("/oauth/authorize", async (c) => {
    const me = await currentUser(c);
    if (!me) return c.html(page("Error", `<h1>Session expired</h1><p>Please restart the authorisation from your client.</p>`), 401);
    let req;
    try {
      req = await validateAuthorizeRequest(d.identity, oc, c.req.query());
    } catch (e) {
      return c.html(page("Authorization error", `<h1>Authorization error</h1><p class="err">${escapeHtml(e instanceof OAuthError ? e.description : "Invalid request")}</p>`), 400);
    }
    const form = await c.req.parseBody();
    if (form.csrf !== (await csrfFor(me.token))) return c.html(page("Error", `<h1>Request rejected</h1><p class="err">CSRF validation failed.</p>`), 403);
    const target = new URL(req.redirectUri);
    if (req.state) target.searchParams.set("state", req.state);
    target.searchParams.set("iss", oc.issuer);
    if (form.decision !== "approve") {
      target.searchParams.set("error", "access_denied");
      await d.services.store.audit({ userId: me.user.id, tenantId: me.user.tenantId, via: "mcp", clientId: req.clientId, action: "oauth.consent", outcome: "denied" });
      return c.redirect(target.toString(), 303);
    }
    target.searchParams.set("code", await issueCode(d.identity, req, me.user));
    await d.services.store.audit({ userId: me.user.id, tenantId: me.user.tenantId, via: "mcp", clientId: req.clientId, action: "oauth.consent", outcome: "ok", details: { scopes: req.scopes } });
    return c.redirect(target.toString(), 303);
  });
}
