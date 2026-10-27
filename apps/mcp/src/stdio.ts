import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { sha256, userContext } from "@lemon-tea/auth";
import { createMcpServer } from "@lemon-tea/mcp-tools";
import { buildRuntime } from "@lemon-tea/api/container";

/**
 * Local MCP server over stdio for self-hosted installs. It uses the same tools and services as
 * the remote /mcp endpoint and authenticates with a personal API token (LEMONTEA_API_TOKEN),
 * so a local AI client gets exactly that user's rights and never the database owner's.
 * stdout carries the protocol; diagnostics go to stderr.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  const token = process.env.LEMONTEA_API_TOKEN;
  if (!url) throw new Error("DATABASE_URL is required");
  if (!token?.startsWith("lt_pat_")) throw new Error("LEMONTEA_API_TOKEN (a personal API token, lt_pat_...) is required");
  const rt = buildRuntime({ DATABASE_URL: url, publicSources: (process.env.PUBLIC_SOURCES ?? "").split(",").filter(Boolean) });
  const rec = await rt.identity.apiToken(await sha256(token));
  if (!rec) throw new Error("Invalid or expired API token");
  const ctx = userContext(rec.user, "stdio", rec.scopes as never);
  const server = createMcpServer(rt.services, ctx, { audit: true });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[lemon-tea mcp] stdio server ready (${[...ctx.scopes].join(", ")})\n`);
  const shutdown = async () => {
    await server.close();
    await rt.close();
    process.exit(0);
  };
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`[lemon-tea mcp] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
