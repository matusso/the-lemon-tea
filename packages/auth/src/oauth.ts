import { jwtVerify, SignJWT } from "jose";
import { MCP_SCOPES, type Scope } from "@lemon-tea/shared-types";
import { randomToken, sha256, verifyPkce } from "./crypto.ts";
import type { IdentityStore, UserRecord } from "./identity.ts";

/**
 * Minimal OAuth 2.1 authorization server for MCP clients:
 *  - dynamic client registration (RFC 7591), public clients only (PKCE required, no secrets)
 *  - authorization code + PKCE S256
 *  - resource indicators (RFC 8707): tokens are audience-bound to the MCP resource URL
 *  - short-lived JWT access tokens, rotating opaque refresh tokens
 */
export interface OAuthConfig {
  issuer: string;
  /** Canonical MCP resource URL, e.g. https://example.org/mcp */
  resource: string;
  jwtSecret: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

export class OAuthError extends Error {
  constructor(public readonly error: string, public readonly description: string, public readonly status = 400) {
    super(description);
  }
}

export function authorizationServerMetadata(c: OAuthConfig) {
  return {
    issuer: c.issuer,
    authorization_endpoint: `${c.issuer}/oauth/authorize`,
    token_endpoint: `${c.issuer}/oauth/token`,
    registration_endpoint: `${c.issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_SCOPES,
  };
}

export function protectedResourceMetadata(c: OAuthConfig) {
  return {
    resource: c.resource,
    authorization_servers: [c.issuer],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "The Lemon Tea MCP",
  };
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    // Native/CLI clients use loopback redirects (RFC 8252)
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

export async function registerClient(store: IdentityStore, body: unknown) {
  const b = (body ?? {}) as { client_name?: unknown; redirect_uris?: unknown; token_endpoint_auth_method?: unknown };
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 5 || !uris.every(isAllowedRedirect)) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be 1-5 https or loopback URLs without fragments");
  }
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
    throw new OAuthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method=none) are supported");
  }
  const clientName = typeof b.client_name === "string" ? b.client_name.slice(0, 100) : "MCP client";
  const clientId = `mcp_${randomToken(18)}`;
  await store.registerClient({ clientId, clientName, redirectUris: uris });
  return {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export interface AuthorizeRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: Scope[];
  state: string | null;
  codeChallenge: string;
  resource: string;
}

/** Validates an /authorize request. Errors before redirect_uri is trusted are shown, never redirected. */
export async function validateAuthorizeRequest(store: IdentityStore, c: OAuthConfig, q: Record<string, string | undefined>): Promise<AuthorizeRequest> {
  const client = q.client_id ? await store.client(q.client_id) : null;
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id");
  if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
  if (q.response_type !== "code") throw new OAuthError("unsupported_response_type", "response_type must be 'code'");
  if (!q.code_challenge || q.code_challenge_method !== "S256") throw new OAuthError("invalid_request", "PKCE with S256 is required");
  const resource = q.resource ?? c.resource;
  if (resource !== c.resource) throw new OAuthError("invalid_target", "Unknown resource");
  const requested = (q.scope ?? MCP_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  const scopes = requested.filter((s): s is Scope => (MCP_SCOPES as readonly string[]).includes(s));
  if (!scopes.length) throw new OAuthError("invalid_scope", "No supported scopes requested");
  return { clientId: client.clientId, clientName: client.clientName, redirectUri: q.redirect_uri, scopes, state: q.state ?? null, codeChallenge: q.code_challenge, resource };
}

export async function issueCode(store: IdentityStore, req: AuthorizeRequest, user: UserRecord): Promise<string> {
  const code = randomToken(32);
  await store.saveCode(await sha256(code), {
    clientId: req.clientId,
    userId: user.id,
    scopes: req.scopes,
    codeChallenge: req.codeChallenge,
    redirectUri: req.redirectUri,
    resource: req.resource,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  return code;
}

async function signAccess(c: OAuthConfig, user: UserRecord, clientId: string, scopes: string[], resource: string) {
  const ttl = c.accessTokenTtlSeconds ?? 3600;
  const token = await new SignJWT({ tid: user.tenantId, scope: scopes.join(" "), client_id: clientId })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(c.issuer)
    .setAudience(resource)
    .setSubject(user.id)
    .setIssuedAt()
    .setJti(randomToken(12))
    .setExpirationTime(`${ttl}s`)
    .sign(new TextEncoder().encode(c.jwtSecret));
  return { token, ttl };
}

export async function exchangeToken(store: IdentityStore, c: OAuthConfig, form: Record<string, string | undefined>) {
  if (form.grant_type === "authorization_code") {
    if (!form.code || !form.code_verifier || !form.client_id || !form.redirect_uri) {
      throw new OAuthError("invalid_request", "code, code_verifier, client_id and redirect_uri are required");
    }
    const rec = await store.consumeCode(await sha256(form.code));
    if (!rec || rec.clientId !== form.client_id || rec.redirectUri !== form.redirect_uri) throw new OAuthError("invalid_grant", "Invalid, expired or already used code");
    if (!(await verifyPkce(form.code_verifier, rec.codeChallenge))) throw new OAuthError("invalid_grant", "PKCE verification failed");
    if (form.resource && form.resource !== rec.resource) throw new OAuthError("invalid_target", "Resource mismatch");
    const user = await store.userById(rec.userId);
    if (!user) throw new OAuthError("invalid_grant", "User no longer exists");
    return issueTokens(store, c, user, rec.clientId, rec.scopes, rec.resource);
  }
  if (form.grant_type === "refresh_token") {
    if (!form.refresh_token || !form.client_id) throw new OAuthError("invalid_request", "refresh_token and client_id are required");
    const rec = await store.consumeRefreshToken(await sha256(form.refresh_token));
    if (!rec || rec.clientId !== form.client_id) throw new OAuthError("invalid_grant", "Invalid refresh token");
    const user = await store.userById(rec.userId);
    if (!user) throw new OAuthError("invalid_grant", "User no longer exists");
    // A refresh may narrow but never widen scope.
    const scopes = form.scope ? form.scope.split(/\s+/).filter((s) => rec.scopes.includes(s)) : rec.scopes;
    return issueTokens(store, c, user, rec.clientId, scopes, rec.resource);
  }
  throw new OAuthError("unsupported_grant_type", "Supported: authorization_code, refresh_token");
}

async function issueTokens(store: IdentityStore, c: OAuthConfig, user: UserRecord, clientId: string, scopes: string[], resource: string) {
  const { token, ttl } = await signAccess(c, user, clientId, scopes, resource);
  const refresh = randomToken(32);
  await store.saveRefreshToken(await sha256(refresh), {
    clientId,
    userId: user.id,
    scopes,
    resource,
    expiresAt: new Date(Date.now() + (c.refreshTokenTtlSeconds ?? 30 * 86400) * 1000).toISOString(),
  });
  return { access_token: token, token_type: "Bearer", expires_in: ttl, refresh_token: refresh, scope: scopes.join(" ") };
}

export interface VerifiedAccessToken {
  userId: string;
  tenantId: string;
  scopes: Scope[];
  clientId: string;
}

/** Verifies signature, issuer, expiry and that the token's audience is exactly this resource. */
export async function verifyAccessToken(c: OAuthConfig, token: string): Promise<VerifiedAccessToken> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(c.jwtSecret), {
    issuer: c.issuer,
    audience: c.resource,
    algorithms: ["HS256"],
    typ: "at+jwt",
  });
  const scopes = String(payload.scope ?? "")
    .split(/\s+/)
    .filter((s): s is Scope => (MCP_SCOPES as readonly string[]).includes(s));
  return { userId: String(payload.sub), tenantId: String(payload.tid), scopes, clientId: String(payload.client_id) };
}
