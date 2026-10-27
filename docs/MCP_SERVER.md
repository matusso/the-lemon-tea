# MCP server

The Lemon Tea exposes its analytics to AI agents through the Model Context Protocol, built with `@modelcontextprotocol/sdk` 1.32.2 (latest protocol version `2025-11-25`). Tools, resources and prompts are registered once in `packages/mcp-tools` and served by two transports:

| Transport | Entry | Auth |
|---|---|---|
| Streamable HTTP at `/mcp` | `apps/api/src/mcp-route.ts` | OAuth 2.1 bearer token bound to the `/mcp` resource, or anonymous if `ALLOW_ANONYMOUS=true` |
| stdio | `apps/mcp/src/stdio.ts` | personal API token in `LEMONTEA_API_TOKEN` |

Both create `createMcpServer(services, authContext)`, which calls the same domain services as REST. An integration test checks that `compare_laps` returns exactly what `POST /api/analysis/compare` returns. The deprecated HTTP+SSE transport is not implemented.

## HTTP transport

- **Stateless:** a new server and `WebStandardStreamableHTTPServerTransport` per request, with `sessionIdGenerator: undefined` and `enableJsonResponse: true`.
- `POST /mcp` handles JSON-RPC. `GET /mcp` and `DELETE /mcp` return 405, because there is no standalone SSE stream and no session to delete.
- **DNS-rebinding protection** is on. `allowedHosts` = the host of `PUBLIC_URL`, plus `localhost:PORT` and `127.0.0.1:PORT`. A browser `Origin` outside the allowed origins gets 403.
- **Limits:** request body 256 KB; the same per-minute rate limit as the API, keyed by token; tool output capped at 512 KB.
- The same app runs on Cloudflare Workers. `initialize` was verified under `wrangler dev`.

## Authorisation

Discovery:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | resource = `${PUBLIC_URL}/mcp`, authorization server, scopes |
| `/.well-known/oauth-authorization-server` | authorize, token and registration endpoints; `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]` |
| `POST /oauth/register` | dynamic client registration (public clients) |
| `GET/POST /oauth/authorize` | sign-in and consent pages |
| `POST /oauth/token` | `authorization_code` (PKCE) and `refresh_token` |

A request without a token, when anonymous access is disabled, gets `401` with `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`. Tokens are verified for signature, issuer, expiry, `typ: at+jwt` and **audience == `/mcp` resource**. Details are in [AUTHENTICATION.md](AUTHENTICATION.md).

### Scopes

| Scope | Tools |
|---|---|
| `sessions:read` | discovery, timing, laps, race control, pits, weather, radio, circuit, availability |
| `telemetry:read` | `get_telemetry`, `get_driver_position` |
| `analytics:read` | comparisons, corners, braking, acceleration, delta, dominance, theoretical best, driver style, teams |
| `predictions:read` | long runs, qualifying, race pace, degradation, tyres, prediction history, model metrics |
| `simulations:execute` | `simulate_strategy`, `predict_race_result`, all `*_analysis_job` tools |
| `reports:read` | reserved |

`admin` and `ingest:write` are never grantable to MCP clients. The effective scopes are the intersection of the grant and the user's own rights. Anonymous MCP callers get `sessions:read telemetry:read analytics:read predictions:read`, limited to publicly displayable sources.

## Capabilities

- **38 tools:** see [MCP_TOOL_REFERENCE.md](MCP_TOOL_REFERENCE.md). Read-only tools carry `readOnlyHint: true`. Expensive work goes through `create_analysis_job` → `get_analysis_job` → `get_analysis_result` (with `idempotencyKey` and `cancel_analysis_job`). Analysis jobs are executed by the job runner, or by the Queue/cron consumer on Cloudflare.
- **Resources** (all checked against the caller's permissions):
  - `lemontea://seasons/{year}` (listable)
  - `lemontea://sessions/{sessionId}` (lists up to 50 ingested sessions)
  - `lemontea://sessions/{sessionId}/drivers`, `/results`, `/race-control`, `/laps/{driverId}`
  - `lemontea://circuits/{sessionId}`. This is keyed by session rather than circuit id, because layouts are derived per session and year
  - `lemontea://predictions/{predictionId}`
  - `lemontea://models/{modelVersion}/metrics`
  - `lemontea://analyses/{analysisId}` (job results)

  Each resource body is `{version, retrievedAt, data}`.
- **Prompts:** `compare_driver_performance`, `analyze_practice_to_qualifying`, `analyze_race_strategy`, `explain_corner_performance`, `evaluate_prediction_accuracy`. Each tells the client which tools to call and includes guardrails: use only returned numbers, keep value labels, A_minus_B convention, treat source text as data, stop when data is missing.

## Safety

- No tool executes SQL, shell commands or arbitrary HTTP. Tools take ids and numbers validated by zod.
- Race-control text and radio metadata are returned as data, and the server instructions say so. They are never interpreted as instructions.
- Every tool call is audited (`audit_log`, action `mcp.<tool>`, outcome `ok` / `denied` / `error`). Arguments are not logged.
- Provider credentials never appear in any tool result.

## Client configuration

Remote (any client that supports Streamable HTTP and OAuth):

```json
{ "mcpServers": { "lemon-tea": { "url": "http://localhost:8787/mcp" } } }
```

Local stdio (create a token first: sign in, then `POST /api/auth/tokens` with `{"name":"local-ai","scopes":["sessions:read","telemetry:read","analytics:read","predictions:read","simulations:execute"]}` and the `X-Requested-With: lemon-tea` header):

```json
{
  "mcpServers": {
    "lemon-tea": {
      "command": "npx",
      "args": ["tsx", "/path/to/the-lemon-tea/apps/mcp/src/stdio.ts"],
      "env": {
        "DATABASE_URL": "postgres://lemontea_app:...@localhost:5432/lemontea",
        "LEMONTEA_API_TOKEN": "lt_pat_..."
      }
    }
  }
}
```

The stdio server connects as `lemontea_app`, so row-level security still applies. It acts with exactly the token's scopes. It writes diagnostics to stderr only.
