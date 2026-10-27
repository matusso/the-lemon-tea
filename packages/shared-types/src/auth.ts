import { z } from "zod";

export const Scope = z.enum([
  "sessions:read",
  "telemetry:read",
  "analytics:read",
  "predictions:read",
  "simulations:execute",
  "reports:read",
  "ingest:write",
  "admin",
]);
export type Scope = z.infer<typeof Scope>;

/** Scopes an MCP client may ever request. `admin` and `ingest:write` stay out of MCP. */
export const MCP_SCOPES: readonly Scope[] = [
  "sessions:read",
  "telemetry:read",
  "analytics:read",
  "predictions:read",
  "simulations:execute",
  "reports:read",
];

export const ANONYMOUS_SCOPES: readonly Scope[] = [
  "sessions:read",
  "telemetry:read",
  "analytics:read",
  "predictions:read",
];

/**
 * Who is calling. Three security contexts are deliberately separate:
 * - application identity  -> `userId`/`tenantId`
 * - MCP delegation         -> `via: "mcp"` + `clientId`, scopes narrowed by the OAuth grant
 * - provider authorization -> never present here; provider credentials live only in server config
 */
export interface AuthContext {
  anonymous: boolean;
  userId: string | null;
  tenantId: string | null;
  scopes: ReadonlySet<Scope>;
  via: "web" | "api" | "mcp" | "stdio" | "system";
  clientId?: string;
}

export function hasScope(ctx: AuthContext, scope: Scope): boolean {
  return ctx.scopes.has("admin") || ctx.scopes.has(scope);
}
