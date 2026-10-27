import { assertSafeUrl } from "@lemon-tea/provider-sdk";
import { LemonTeaError } from "@lemon-tea/shared-types";

/**
 * Formula 1 account sign-in, ported from FastF1's `internals.f1account` (MIT, see NOTICE).
 *
 * account.formula1.com uses PingOne (id.formula1.com): OAuth2 Authorization Code + PKCE around a
 * DaVinci username/password flow. With `response_mode=pi.flow` every step is a JSON call:
 *   1. read the public client config (`davinci:{clientId, acrValues}`) from the account frontend
 *   2. GET  /as/authorize           → login form descriptor + submit URL
 *   3. POST <submit URL>            → authorization code
 *   4. POST /as/token               → access token whose `subscriptionToken` claim is the F1 TV
 *                                      entitlement JWT that livetiming.formula1.com accepts.
 *
 * Credentials are sent only to id.formula1.com, are never stored or logged, and no redirects are
 * followed. Only the subscription token (and its expiry) leaves this module.
 */

export const ACCOUNT_ORIGIN = "https://account.formula1.com";
export const IDP_ORIGIN = "https://id.formula1.com";
const CONFIG_SCRIPT_URL = `${ACCOUNT_ORIGIN}/scripts/main.min.js`;
const AUTHORIZE_URL = `${IDP_ORIGIN}/as/authorize`;
const TOKEN_URL = `${IDP_ORIGIN}/as/token`;
const ALLOWED_HOSTS = ["account.formula1.com", "id.formula1.com"] as const;
const TIMEOUT_MS = 30_000;

// The identity provider rejects obvious non-browser clients; FastF1 sends a browser UA as well.
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PING_SDK = { "X-Requested-With": "ping-sdk" };

/** The Formula 1 account (not the user's app session) failed: surfaced to users as provider_error. */
export class F1AuthError extends LemonTeaError {
  constructor(message: string) {
    super("provider_error", message);
    this.name = "F1AuthError";
  }
}

export interface SubscriptionToken {
  value: string;
  /** Epoch ms from the token's `exp` claim. */
  expiresAt: number;
  /** Non-personal entitlement claims (as FastF1 shows them): SubscriptionStatus, SubscribedProduct. */
  details?: Record<string, string>;
}

/** Renew this long before expiry. */
export const EXPIRY_MARGIN_MS = 5 * 60_000;

export function isTokenValid(t: SubscriptionToken, now = Date.now()): boolean {
  return t.expiresAt - EXPIRY_MARGIN_MS > now;
}

/** Claims are read without verification; livetiming.formula1.com verifies the signature. */
export function unverifiedClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new F1AuthError("Token is not a JWT");
  try {
    const json = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1]!.length / 4) * 4, "="));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    if (typeof claims !== "object" || claims === null) throw new Error("not an object");
    return claims as Record<string, unknown>;
  } catch {
    throw new F1AuthError("Token claims could not be decoded");
  }
}

/** Build a SubscriptionToken from the entitlement JWT (as pasted by a user or from sign-in). */
export function subscriptionTokenFromJwt(value: string): SubscriptionToken {
  const v = value.trim();
  const claims = unverifiedClaims(v);
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp)) throw new F1AuthError("Subscription token has no valid expiry");
  // Only these two entitlement claims are kept; identity claims are never read or stored.
  const details: Record<string, string> = {};
  for (const k of ["SubscriptionStatus", "SubscribedProduct"]) if (typeof claims[k] === "string") details[k] = (claims[k] as string).slice(0, 60);
  return { value: v, expiresAt: exp * 1000, ...(Object.keys(details).length ? { details } : {}) };
}

export function parseFrontendConfig(script: string): { clientId: string; policyId: string } {
  const obj = /\bdavinci:\{([^}]*)\}/.exec(script);
  if (!obj) throw new F1AuthError("Sign-in configuration not found on account.formula1.com");
  const field = (name: string) => {
    const m = new RegExp(`\\b${name}:"([^"]+)"`).exec(obj[1]!);
    if (!m) throw new F1AuthError(`Sign-in configuration is missing ${name}`);
    return m[1]!;
  };
  return { clientId: field("clientId"), policyId: field("acrValues") };
}

/** Minimal cookie jar: the IdP ties the steps of the flow together through cookies. */
class CookieJar {
  private cookies = new Map<string, string>();
  store(res: Response) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }
  header(): string | null {
    return this.cookies.size ? [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") : null;
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export interface SignInOptions {
  fetchImpl?: typeof fetch;
}

export async function signIn(username: string, password: string, o: SignInOptions = {}): Promise<SubscriptionToken> {
  if (!username || !password) throw new F1AuthError("Email and password are required");
  const f = o.fetchImpl ?? fetch;
  const jar = new CookieJar();
  const call = async (url: string, init: RequestInit = {}) => {
    const u = assertSafeUrl(url, ALLOWED_HOSTS);
    if (u.hostname === "id.formula1.com" && jar.header()) init.headers = { ...init.headers, cookie: jar.header()! };
    let res: Response;
    try {
      res = await f(u.toString(), {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9", ...init.headers },
      });
    } catch (e) {
      throw new F1AuthError(`Could not reach ${u.hostname}: ${(e as Error).message}`);
    }
    if (u.hostname === "id.formula1.com") jar.store(res);
    if (res.status >= 300 && res.status < 400) throw new F1AuthError(`Unexpected redirect from ${u.hostname}`);
    return res;
  };
  const json = async (res: Response, what: string): Promise<Record<string, unknown>> => {
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new F1AuthError(`Unexpected response ${what} (HTTP ${res.status})`);
    }
  };

  const cfgRes = await call(CONFIG_SCRIPT_URL);
  if (!cfgRes.ok) throw new F1AuthError(`Sign-in configuration unavailable (HTTP ${cfgRes.status})`);
  const cfg = parseFrontendConfig(await cfgRes.text());

  const verifier = randomString(64);
  const state = randomString(24);
  const authorize = new URL(AUTHORIZE_URL);
  for (const [k, v] of Object.entries({
    client_id: cfg.clientId,
    response_type: "code",
    response_mode: "pi.flow",
    scope: "openid", // the subscription token is included with any scope
    state,
    nonce: randomString(24),
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
    acr_values: cfg.policyId,
  }))
    authorize.searchParams.set(k, v);
  const formRes = await call(authorize.toString(), { headers: PING_SDK });
  if (!formRes.ok) throw new F1AuthError(`Sign-in could not be started (HTTP ${formRes.status})`);
  const form = await json(formRes, "when starting the sign-in");
  const submitUrl = (form._links as { next?: { href?: string } } | undefined)?.next?.href;
  const interactionId = form.interactionId;
  if (typeof submitUrl !== "string" || typeof interactionId !== "string" || typeof form.id !== "string" || typeof form.eventName !== "string") {
    throw new F1AuthError("Unexpected response when starting the sign-in");
  }
  // Never send the credentials anywhere but the identity provider.
  if (!submitUrl.startsWith(`${IDP_ORIGIN}/`)) throw new F1AuthError("Unexpected sign-in URL");

  const flowRes = await call(submitUrl, {
    method: "POST",
    headers: { ...PING_SDK, interactionId, "content-type": "application/json" },
    body: JSON.stringify({
      id: form.id,
      eventName: form.eventName,
      interactionId,
      parameters: { eventType: "submit", data: { actionKey: "SIGNIN", formData: { username, password } } },
    }),
  });
  const flow = await json(flowRes, "from the sign-in");
  if (flow.status !== "COMPLETED") {
    // e.g. wrong credentials; the IdP message is meant for the user. Capped, never echoed raw.
    const msg = typeof flow.message === "string" ? flow.message.slice(0, 200) : `Sign-in failed (HTTP ${flowRes.status})`;
    throw new F1AuthError(msg);
  }
  const authResponse = (flow.authorizeResponse ?? {}) as { state?: string; code?: string };
  if (authResponse.state !== state) throw new F1AuthError("Sign-in failed: state mismatch");
  if (typeof authResponse.code !== "string" || !authResponse.code) throw new F1AuthError("Sign-in failed: no authorization code");

  const tokenRes = await call(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: cfg.clientId, code: authResponse.code, code_verifier: verifier }),
  });
  if (!tokenRes.ok) throw new F1AuthError(`Token exchange failed (HTTP ${tokenRes.status})`);
  const accessToken = (await json(tokenRes, "from the token endpoint")).access_token;
  if (typeof accessToken !== "string") throw new F1AuthError("No access token in the token response");
  const sub = unverifiedClaims(accessToken).subscriptionToken;
  if (typeof sub !== "string" || !sub) {
    throw new F1AuthError("The account has no F1 TV subscription token. An active F1 TV subscription is required for live timing data.");
  }
  return subscriptionTokenFromJwt(sub);
}
