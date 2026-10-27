import type { ChannelAvailability, SessionBundle } from "@lemon-tea/shared-types";
import type { CarSamples, PositionSamples } from "@lemon-tea/telemetry-core";

export * from "./http.ts";

export type ProviderAuth = "none" | "oauth_password_grant" | "api_key" | "bearer_token";

export interface ProviderCapabilities {
  id: string;
  name: string;
  historical: boolean;
  /** Live access is only advertised when credentials for an authorised live tier are configured. */
  live: boolean;
  auth: ProviderAuth;
  sessionDiscovery: boolean;
  channels: ChannelAvailability[];
  coverage: string;
  rateLimit: { requestsPerSecond: number; burst: number };
  licensingSourceId: string;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs: number | null;
  checkedAt: string;
  message?: string;
}

export interface SessionListing {
  sessionKey: string;
  meetingKey: string;
  year: number;
  name: string;
  type: string;
  circuitShortName: string;
  countryName: string | null;
  dateStart: string;
  dateEnd: string | null;
}

/** Incremental data for a live session since a cursor. */
export interface LiveDelta {
  cursor: string;
  sourceTimestamp: string | null;
  bundle: Partial<SessionBundle>;
  car: Map<number, CarSamples>;
  position: Map<number, PositionSamples>;
}

/**
 * Contract every data provider implements. Adapters normalise to shared-types units:
 * seconds, km/h, metres, epoch-ms sample times. They never invent channels the source lacks.
 */
export interface ProviderAdapter {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  health(): Promise<ProviderHealth>;
  listSessions(year: number): Promise<SessionListing[]>;
  fetchSession(sessionKey: string): Promise<SessionBundle>;
  fetchCarSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<CarSamples>;
  fetchPositionSamples(sessionKey: string, driverNumber: number, fromIso: string, toIso: string): Promise<PositionSamples>;
  pollLive?(sessionKey: string, cursor: string | null): Promise<LiveDelta>;
  /** Source-level data quality notes from the last fetchSession (decode errors, integrity issues). */
  lastQuality?(): Record<string, unknown>;
}

/** Builds a provider instance bound to one tenant's own provider credentials (null: no tenant). */
export type ScopedProviderFactory = (tenantId: string | null) => ProviderAdapter;

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  private scoped = new Map<string, ScopedProviderFactory>();

  register(a: ProviderAdapter): this {
    this.adapters.set(a.id, a);
    return this;
  }

  /**
   * Register a provider that authenticates with each tenant's own account. Its data belongs to
   * that tenant: `get` returns an instance without credentials (capabilities only) and
   * `resolve` an instance for one tenant.
   */
  registerScoped(id: string, factory: ScopedProviderFactory): this {
    this.scoped.set(id, factory);
    this.adapters.set(id, factory(null));
    return this;
  }

  isScoped(id: string): boolean {
    return this.scoped.has(id);
  }

  get(id: string): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown provider '${id}'`);
    return a;
  }

  /** The instance to fetch data with on behalf of a tenant. */
  resolve(id: string, tenantId: string | null): ProviderAdapter {
    const f = this.scoped.get(id);
    return f ? f(tenantId) : this.get(id);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
