import { ANONYMOUS_SCOPES, type AuthContext, type Scope, Scope as ScopeSchema } from "@lemon-tea/shared-types";
import type { UserRecord } from "./identity.ts";

const ALL_USER_SCOPES: Scope[] = ScopeSchema.options.filter((s) => s !== "admin" && s !== "ingest:write");

export function anonymousContext(via: AuthContext["via"]): AuthContext {
  return { anonymous: true, userId: null, tenantId: null, scopes: new Set(ANONYMOUS_SCOPES), via };
}

export function userContext(user: UserRecord, via: AuthContext["via"], scopes?: readonly Scope[], clientId?: string): AuthContext {
  const base: Scope[] = user.role === "admin" ? [...ALL_USER_SCOPES, "ingest:write", "admin"] : [...ALL_USER_SCOPES, "ingest:write"];
  // Delegated (MCP/API-token) access is the intersection of the grant and the user's own rights.
  const granted = scopes ? base.filter((s) => scopes.includes(s)) : base;
  return { anonymous: false, userId: user.id, tenantId: user.tenantId, scopes: new Set(granted), via, ...(clientId ? { clientId } : {}) };
}

export function systemContext(): AuthContext {
  return { anonymous: false, userId: null, tenantId: null, scopes: new Set<Scope>(["admin", ...ALL_USER_SCOPES, "ingest:write"]), via: "system" };
}
