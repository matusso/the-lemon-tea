# Authentication and authorisation

## Three security contexts

| Context | Credential | Where it lives |
|---|---|---|
| Application identity | session cookie or personal API token | `users`, `app_sessions`, `api_tokens` |
| MCP delegation | OAuth 2.1 access token (JWT) for the `/mcp` resource | `oauth_*` tables, `APP_JWT_SECRET` |
| Provider authorisation | operator credentials (e.g. `OPENF1_USERNAME` / `OPENF1_PASSWORD`) and users' own provider accounts (Formula 1 account token) | server environment or Worker Secrets; per-tenant `provider_connections` (encrypted) |

None of these credentials is ever converted into another. An MCP token cannot call `/api/*` (those routes accept cookies or `lt_pat_` tokens), and REST credentials are not accepted on `/mcp`.

## Users and tenants

Each user belongs to a tenant. Private data is owned by tenants. The first administrator is created at Node server start (`bootstrapAdmin`) from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (≥ 12 characters), and only when no users exist yet. There is no self-registration endpoint.

- **Passwords:** PBKDF2-SHA256, 310,000 iterations, 16-byte salt, stored as `pbkdf2$<iterations>$<salt>$<hash>` (WebCrypto, so it works in Node and Workers). Comparisons are constant-time. A failed login for an unknown email still runs a dummy hash to keep timing uniform.
- **Browser sessions:** a 32-byte random token in cookie `lt_session` (HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https or `COOKIE_SECURE=true`, 7 days). The database stores only its SHA-256.
- **Personal API tokens:** `lt_pat_<random>`, created with `POST /api/auth/tokens` from a browser session. They have a name, scopes (never `admin`) and an expiry (default 90 days, maximum 365). Only the hash is stored. They are used for REST (`Authorization: Bearer`) and the stdio MCP server.

## AuthContext and scopes

`userContext(user, via, scopes?)` (`packages/auth/src/context.ts`):
- base rights: all user scopes plus `ingest:write`, plus `admin` for administrators;
- delegated access (an API token or MCP grant) is the **intersection** of the grant and the base rights.

Anonymous callers get `sessions:read telemetry:read analytics:read predictions:read` (none when `ALLOW_ANONYMOUS=false`) and can see only publicly displayable sources.

Every service call goes through `AccessPolicy`, which checks the scope and resolves the session with tenant scoping. Inaccessible resources return `not_found`.

## OAuth 2.1 server (for MCP)

Implementation: `packages/auth/src/oauth.ts` and `apps/api/src/oauth-routes.ts`.

| Aspect | Behaviour |
|---|---|
| Client registration | `POST /oauth/register` (RFC 7591). Public clients only (`token_endpoint_auth_method: none`). 1–5 redirect URIs, https or loopback http (`127.0.0.1`, `localhost`, `[::1]`), no fragments. `client_id = mcp_<random>`. Rate-limited to 30/min per IP |
| Authorization | `response_type=code`; PKCE **S256 required**; `resource` must equal `${PUBLIC_URL}/mcp` (RFC 8707); unsupported scopes are dropped and none-left is an error. Errors raised before the redirect URI is trusted are shown on a page, never redirected |
| Sign-in and consent | a server-rendered page signs in the user (sets the same session cookie) and shows client name and scopes. The approve/deny form carries a CSRF token derived from the session token. Approval redirects with `code`, `state` and `iss` |
| Codes | 32 random bytes, stored hashed, 5-minute lifetime, single use (atomic `used_at` update) |
| Access tokens | JWT, HS256 with `APP_JWT_SECRET`, header `typ: at+jwt`. Claims `iss`, `aud` (= resource), `sub`, `tid`, `scope`, `client_id`, `jti`, `iat`, `exp` (1 hour) |
| Refresh tokens | opaque, hashed, 30 days, **rotated on every use**; reuse fails. A refresh can narrow scope but never widen it |
| Verification at `/mcp` | signature, issuer, audience, expiry, `typ`; the user must still exist in the same tenant |
| Audit | consent approvals and denials are written to `audit_log` |

Tests (`tests/integration/api-mcp.test.ts`) cover:
- the full PKCE flow,
- scope enforcement,
- code reuse rejection,
- the unknown-resource rejection,
- forged token rejection,
- refresh rotation,
- the 401 challenge.

## Provider credentials

Operator credentials (OpenF1) are read from the environment by `buildRuntime` / the Worker and passed only to adapters.

## Provider accounts

Users can connect their **own Formula 1 account** to read F1 live timing (`f1lt`). The F1 TV subscription it carries is required by the archive and the live feed. `ProviderAccountService` (`packages/domain/src/services/connections.ts`) manages these connections.

**Sign-in** (`packages/providers/f1-livetiming/src/auth.ts`, ported from FastF1 `internals.f1account`, MIT):
1. Read the public client configuration (`davinci:{clientId, acrValues}`) from `account.formula1.com/scripts/main.min.js`.
2. `GET id.formula1.com/as/authorize` with PKCE S256 and `response_mode=pi.flow`. This returns a JSON form descriptor and a submit URL.
3. POST the username/password to that submit URL (PingOne DaVinci). The result is an authorization code; the `state` is checked.
4. `POST /as/token` with the code verifier. The access token's `subscriptionToken` claim is the F1 TV entitlement JWT that livetiming accepts as `Bearer`.

Credentials go **only** to `id.formula1.com`: hosts are allow-listed, the submit URL must be on the identity provider, and no redirects are followed. They are never stored, logged or audited. The flow keeps a cookie jar for `id.formula1.com` only. Steps 1–2 were checked against the real services; steps 3–4 need a real account and are **not yet verified**.

**Alternative:** paste a subscription token instead, for example the `value` of FastF1's `f1auth_token.json` after `python -m fastf1 auth f1tv`. Its expiry is read from the unverified `exp` claim; the signature is verified by livetiming.

**Storage:** one `provider_connections` row per tenant and provider (RLS forced). The token is AES-GCM encrypted with `APP_ENCRYPTION_KEY`, with associated data `provider_connection:<tenant>:<provider>`, so a ciphertext copied to another tenant's row does not decrypt. `config` holds only the expiry, method, connect time and the two entitlement claims `SubscriptionStatus` / `SubscribedProduct`. Identity claims are never read or stored. Without `APP_ENCRYPTION_KEY`, connecting is refused.

**Use:** tokens are decrypted only server-side, by the tenant's own provider instance (`ProviderRegistry.resolve`). No API returns a token; the REST routes (`/api/connections/*`, see [API.md](API.md)) return status only. Only signed-in web or REST callers can manage connections; anonymous and MCP callers cannot, so MCP clients never handle provider credentials. When livetiming answers 401/403 the connection is marked `expired`, and callers get a `provider_error` asking them to sign in again. Sign-in and token routes are limited to 5 requests per minute per user. Connect and disconnect events are audited, without credentials.
