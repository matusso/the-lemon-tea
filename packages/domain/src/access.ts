import { hasScope, LemonTeaError, type AuthContext, type Scope } from "@lemon-tea/shared-types";
import type { AuthorizedSession, Store, TenantScope } from "./store.ts";

/**
 * Resource-based authorisation shared by every interface (web, REST, WebSocket, MCP, stdio).
 * UI restrictions are never relied on: each service call passes through here.
 */
export class AccessPolicy {
  private publicSources: Set<string> | null = null;
  private publicSourcesLoadedAt = 0;

  constructor(
    private readonly store: Store,
    /** Operator override: source ids whose public rows anonymous users may see. */
    private readonly extraPublicSources: readonly string[] = [],
  ) {}

  scope(ctx: AuthContext): TenantScope {
    return { tenantId: ctx.anonymous ? null : ctx.tenantId };
  }

  require(ctx: AuthContext, scope: Scope): void {
    if (!hasScope(ctx, scope)) {
      throw new LemonTeaError(ctx.anonymous ? "unauthorized" : "forbidden", `This operation requires the '${scope}' scope`);
    }
  }

  private async anonymousSources(): Promise<Set<string>> {
    if (!this.publicSources || Date.now() - this.publicSourcesLoadedAt > 60_000) {
      const sources = await this.store.dataSources();
      this.publicSources = new Set([...sources.filter((s) => s.enabled && s.publicDisplayAllowed).map((s) => s.id), ...this.extraPublicSources]);
      this.publicSourcesLoadedAt = Date.now();
    }
    return this.publicSources;
  }

  async canAnonymousSee(source: string): Promise<boolean> {
    return (await this.anonymousSources()).has(source);
  }

  /**
   * Resolve a public session id to the row the caller may read. A tenant's private copy wins over
   * the public row. Unknown and forbidden sessions both yield `not_found` so ids cannot be probed.
   */
  async session(ctx: AuthContext, id: string, scope: Scope = "sessions:read"): Promise<AuthorizedSession> {
    this.require(ctx, scope);
    const rows = await this.store.findSessions(this.scope(ctx), id);
    const own = rows.find((r) => r.ownerTenantId !== null && r.ownerTenantId === ctx.tenantId);
    const pub = rows.find((r) => r.ownerTenantId === null);
    const chosen = own ?? pub;
    if (!chosen) throw new LemonTeaError("not_found", `Session ${id} not found`);
    if (chosen.ownerTenantId !== null && chosen.ownerTenantId !== ctx.tenantId) throw new LemonTeaError("not_found", `Session ${id} not found`);
    if (ctx.anonymous && !(await this.canAnonymousSee(chosen.source))) {
      throw new LemonTeaError("not_found", `Session ${id} not found`);
    }
    return chosen as AuthorizedSession;
  }
}
