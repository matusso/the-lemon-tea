import { decryptSecret, encryptSecret } from "@lemon-tea/auth";
import { LemonTeaError, type AuthContext } from "@lemon-tea/shared-types";
import type { Store } from "../store.ts";

/**
 * Tenants' connections to their own provider accounts (provider auth — the second of the three
 * security contexts, separate from app identity and MCP OAuth).
 *
 * Only the provider's token is kept, AES-GCM encrypted with APP_ENCRYPTION_KEY and bound to
 * tenant + provider. Passwords pass through `signIn` to the provider and are never stored,
 * logged or audited. Tokens are never returned by any API; callers get status only.
 */

export interface ProviderToken {
  value: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Non-secret, non-personal entitlement details safe to show (e.g. subscription status). */
  details?: Record<string, string>;
}

export interface AccountProviderTools {
  /** Display name, e.g. "Formula 1 account". */
  name: string;
  signIn(username: string, password: string): Promise<ProviderToken>;
  /** Validate a token pasted by the user (e.g. one obtained with FastF1) and read its expiry. */
  parseToken(value: string): ProviderToken;
}

export interface ConnectionStatus {
  provider: string;
  name: string;
  status: "connected" | "expired" | "not_connected";
  expiresAt: string | null;
  method: "password" | "token" | null;
  connectedAt: string | null;
  details: Record<string, string>;
}

export class ProviderAccountService {
  constructor(
    private readonly store: Store,
    private readonly encryptionKey: string | undefined,
    private readonly tools: Record<string, AccountProviderTools>,
  ) {}

  providers(): string[] {
    return Object.keys(this.tools);
  }

  private tool(provider: string): AccountProviderTools {
    const t = this.tools[provider];
    if (!t) throw new LemonTeaError("not_found", `No account connection for provider '${provider}'`);
    return t;
  }

  private key(): string {
    if (!this.encryptionKey) throw new LemonTeaError("internal", "Provider account connections require APP_ENCRYPTION_KEY to be configured");
    return this.encryptionKey;
  }

  /** Signed-in users of the web app / REST API only; MCP clients never handle provider credentials. */
  private tenant(ctx: AuthContext): string {
    if (ctx.anonymous || !ctx.tenantId || !ctx.userId) throw new LemonTeaError("unauthorized", "Sign in to manage provider accounts");
    if (ctx.via !== "web" && ctx.via !== "api") throw new LemonTeaError("forbidden", "Provider accounts can only be managed from the web app or REST API");
    return ctx.tenantId;
  }

  private aad = (tenantId: string, provider: string) => `provider_connection:${tenantId}:${provider}`;

  async status(ctx: AuthContext, provider: string): Promise<ConnectionStatus> {
    const tenantId = this.tenant(ctx);
    const name = this.tool(provider).name;
    const c = await this.store.getProviderConnection({ tenantId }, provider);
    if (!c) return { provider, name, status: "not_connected", expiresAt: null, method: null, connectedAt: null, details: {} };
    const expiresAt = Number(c.config.expiresAt);
    const expired = c.status !== "connected" || !Number.isFinite(expiresAt) || expiresAt <= Date.now();
    return {
      provider,
      name,
      status: expired ? "expired" : "connected",
      expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
      method: c.config.method === "password" || c.config.method === "token" ? c.config.method : null,
      connectedAt: typeof c.config.connectedAt === "string" ? c.config.connectedAt : null,
      details: (c.config.details ?? {}) as Record<string, string>,
    };
  }

  async signIn(ctx: AuthContext, provider: string, username: string, password: string): Promise<ConnectionStatus> {
    const tenantId = this.tenant(ctx);
    const tool = this.tool(provider);
    this.key();
    let token: ProviderToken;
    try {
      token = await tool.signIn(username, password);
    } catch (e) {
      await this.audit(ctx, provider, "error", { method: "password", action: "connect" });
      throw new LemonTeaError("invalid_input", (e as Error).message);
    }
    await this.save(ctx, tenantId, provider, token, "password");
    return this.status(ctx, provider);
  }

  async connectWithToken(ctx: AuthContext, provider: string, value: string): Promise<ConnectionStatus> {
    const tenantId = this.tenant(ctx);
    const tool = this.tool(provider);
    this.key();
    let token: ProviderToken;
    try {
      token = tool.parseToken(value);
    } catch (e) {
      throw new LemonTeaError("invalid_input", (e as Error).message);
    }
    if (token.expiresAt <= Date.now()) throw new LemonTeaError("invalid_input", "This token has already expired");
    await this.save(ctx, tenantId, provider, token, "token");
    return this.status(ctx, provider);
  }

  private async save(ctx: AuthContext, tenantId: string, provider: string, token: ProviderToken, method: "password" | "token") {
    const secret = await encryptSecret(token.value, this.key(), this.aad(tenantId, provider));
    await this.store.saveProviderConnection(
      { tenantId },
      { provider, status: "connected", secret, config: { expiresAt: token.expiresAt, method, connectedAt: new Date().toISOString(), details: token.details ?? {} } },
    );
    await this.audit(ctx, provider, "ok", { method, action: "connect" });
  }

  async disconnect(ctx: AuthContext, provider: string): Promise<{ disconnected: boolean }> {
    const tenantId = this.tenant(ctx);
    this.tool(provider);
    const disconnected = await this.store.deleteProviderConnection({ tenantId }, provider);
    await this.audit(ctx, provider, "ok", { action: "disconnect" });
    return { disconnected };
  }

  /** Server-internal: the tenant's valid token, or null. Never exposed through an interface. */
  async tokenFor(tenantId: string | null, provider: string): Promise<string | null> {
    if (!tenantId || !this.encryptionKey) return null;
    const c = await this.store.getProviderConnection({ tenantId }, provider);
    if (!c?.secret || c.status !== "connected") return null;
    if (!(Number(c.config.expiresAt) > Date.now())) return null;
    try {
      return await decryptSecret(c.secret, this.encryptionKey, this.aad(tenantId, provider));
    } catch {
      return null; // key rotated or row tampered with: treated as not connected
    }
  }

  /** Called when the provider rejects the token before its stated expiry (revoked, subscription ended). */
  async markExpired(tenantId: string | null, provider: string): Promise<void> {
    if (!tenantId) return;
    const c = await this.store.getProviderConnection({ tenantId }, provider);
    if (c) await this.store.saveProviderConnection({ tenantId }, { provider, status: "expired", secret: c.secret, config: c.config });
  }

  private audit(ctx: AuthContext, provider: string, outcome: "ok" | "error", details: Record<string, unknown>) {
    return this.store.audit({ userId: ctx.userId, tenantId: ctx.tenantId, via: ctx.via, action: "provider_account", resource: provider, outcome, details });
  }
}
