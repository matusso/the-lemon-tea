# Security design

To report a vulnerability, see the root [SECURITY.md](../SECURITY.md).

## Threat model (summary)

| Asset | Threats | Controls |
|---|---|---|
| Tenants' private telemetry | id guessing, cross-tenant reads via REST, MCP, jobs, exports or caches | RLS, `AccessPolicy`, `AuthorizedSession` brand type, `not_found` for forbidden, private-derived circuit layouts kept in memory per tenant, Python trains on public data only |
| Provider credentials, JWT secret | leakage to browsers, agents or logs | environment variables / Worker Secrets only; never in responses, `AuthContext` or MCP output; error messages are generic for internal errors |
| Users' Formula 1 accounts | password capture, token theft or reuse across tenants, credentials reaching agents | password forwarded only to `id.formula1.com` and never stored; token AES-GCM encrypted with tenant-bound associated data; status-only APIs; web/REST only (never MCP); 5/min limit; `f1lt` data private-only |
| User accounts | credential stuffing, CSRF, session theft | PBKDF2, uniform-timing login, HttpOnly SameSite cookies, CSRF header and Origin check, rate limits |
| MCP delegation | token replay to other services, scope escalation, prompt injection via source text | audience-bound JWTs, PKCE, scope intersection, untrusted-text labelling, no SQL, shell or HTTP tools |
| Providers | SSRF, quota exhaustion | host allow-lists, private-IP blocking, no redirects, one rate-limited poller per live session |
| Availability | large queries, oversized bodies | bounded windows (telemetry 30 min, replay 10 min), decimation, body limits, output cap, job quota |

## Implemented controls

- **Headers** (`apps/api/src/security.ts`): `Content-Security-Policy` with
  - `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`,
  - `img-src 'self' data: blob:`, `font-src 'self' data:`, `connect-src 'self' ws: wss:`,
  - `worker-src 'self' blob:`, `media-src https:`,
  - `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`,
  - `form-action 'self' http://127.0.0.1:* http://localhost:* https:` (OAuth redirects),

  plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` (camera, microphone and geolocation disabled), and HSTS on https.
- **CORS:** an explicit allow-list (`PUBLIC_URL` + `ALLOWED_ORIGINS`).
- **CSRF:** cookie-authenticated mutations need `X-Requested-With: lemon-tea` and a trusted Origin. The OAuth consent form uses a per-session CSRF token.
- **Rate limiting:** fixed window per user or IP (`RATE_LIMIT_PER_MINUTE`, default 240); OAuth endpoints 30/min. It is **in-process**: on Cloudflare each isolate counts separately, so add Cloudflare WAF / rate-limiting rules in production.
- **Body limits:** 1 MB by default, 60 MB for imports, 256 KB for MCP.
- **Input validation:** zod schemas shared by REST and MCP. Session ids must match `^[a-z0-9]+:[A-Za-z0-9_-]+$`.
- **SSRF:** see [DATA_PROVIDERS.md](DATA_PROVIDERS.md#http-client-packagesprovider-sdksrchttpts).
- **Database:** the app connects as non-owner `lemontea_app`. RLS is forced on sessions, predictions, jobs and provider connections. The migration role is separate.
- **Access errors:** forbidden and unknown resources both return `not_found`, so ids cannot be probed.
- **Jobs:** run as the job's owner, re-derived from the stored user id, never from the job payload. Limited to 5 active jobs per tenant.
- **MCP:** DNS-rebinding protection with `allowedHosts`, Origin check, 512 KB output cap, audit log entry per tool call (no arguments).
- **Untrusted source text:** race-control messages are capped at 500 characters and labelled untrusted in tool output and server instructions. The web UI renders them as text.
- **Exports:** rights-aware (source redistribution class or own import). CSV formula injection is neutralised.
- **Logging:** minimal. Secrets and request bodies are not logged; `audit_log` holds the security-relevant events.
- **Docker:** images run as non-root users; Compose binds ports to 127.0.0.1.

## Known gaps

- No account lockout or MFA. The only brute-force protection is the per-IP rate limit.
- No user management UI or API beyond the bootstrap admin.
- JWTs are HS256 with a single shared secret. Rotating `APP_JWT_SECRET` invalidates all access tokens; there is no key-id based rotation yet.
- Rate limiting is per-process (see above).
- The F1 account sign-in posts the user's Formula 1 password through this server. Self-hosters and their users should treat the operator as able to see it in transit; the paste-token option avoids that. A browser-only flow is not possible, because the identity provider's API is not CORS-enabled for third-party origins.
- Rotating `APP_ENCRYPTION_KEY` makes stored provider tokens undecryptable (treated as not connected); users must reconnect.
- The `x-forwarded-for` header is trusted for rate-limit keys when present. Deploy behind a proxy that sets it.
- The CSP still allows inline styles (needed by the chart and 3D libraries).
