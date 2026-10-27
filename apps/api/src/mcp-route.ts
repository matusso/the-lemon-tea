import type { Context, Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { anonymousContext, userContext, verifyAccessToken } from "@lemon-tea/auth";
import { createMcpServer } from "@lemon-tea/mcp-tools";
import type { AuthContext } from "@lemon-tea/shared-types";
import type { AppDeps, AppEnv } from "./app.ts";
import { oauthConfig } from "./oauth-routes.ts";
import { rateLimit } from "./security.ts";

/**
 * Remote MCP endpoint: Streamable HTTP, stateless (a fresh server+transport per request, JSON
 * responses). Bearer tokens must be OAuth access tokens issued for exactly this resource
 * (audience check); application cookies and provider credentials are never accepted here.
 */
export function mountMcp(app: Hono<AppEnv>, d: AppDeps) {
  const oc = oauthConfig(d);
  const host = new URL(d.config.PUBLIC_URL).host;
  const challenge = `Bearer resource_metadata="${d.config.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`;

  const authenticate = async (c: Context): Promise<AuthContext | Response> => {
    const h = c.req.header("authorization");
    if (!h) {
      if (!d.config.ALLOW_ANONYMOUS) {
        c.header("WWW-Authenticate", challenge);
        return c.json({ error: "unauthorized", error_description: "Bearer token required" }, 401);
      }
      return anonymousContext("mcp");
    }
    if (!h.startsWith("Bearer ")) {
      c.header("WWW-Authenticate", challenge);
      return c.json({ error: "invalid_token" }, 401);
    }
    try {
      const t = await verifyAccessToken(oc, h.slice(7));
      const user = await d.identity.userById(t.userId);
      if (!user || user.tenantId !== t.tenantId) throw new Error("unknown user");
      return userContext(user, "mcp", t.scopes, t.clientId);
    } catch {
      c.header("WWW-Authenticate", `${challenge}, error="invalid_token"`);
      return c.json({ error: "invalid_token", error_description: "Token is invalid, expired or not issued for this resource" }, 401);
    }
  };

  const handler = async (c: Context) => {
    // DNS-rebinding / cross-site protection: browsers may only call from configured origins.
    const origin = c.req.header("origin");
    if (origin && !d.config.origins.includes(origin)) return c.json({ error: "forbidden_origin" }, 403);
    const ctx = await authenticate(c);
    if (ctx instanceof Response) return ctx;
    const server = createMcpServer(d.services, ctx, { audit: true });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [host, `localhost:${d.config.PORT}`, `127.0.0.1:${d.config.PORT}`],
      maxRequestBodySize: 256 * 1024,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  };

  // Keyed by client IP: unauthenticated callers cannot rotate fake tokens to escape the limit.
  const limiter = rateLimit(d.config.RATE_LIMIT_PER_MINUTE, (c) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local");
  app.post("/mcp", limiter, handler);
  // Stateless server: no standalone SSE stream and no sessions to delete.
  app.get("/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; use POST" }, id: null }, 405));
  app.delete("/mcp", (c) => c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405));
}
