/**
 * Test harness: the real Hono app and domain services over in-memory stores, loaded with the
 * SYNTHETIC fixture (not real F1 data). Used to test HTTP, MCP, OAuth and isolation end to end.
 */
import { createApp } from "@lemon-tea/api";
import { loadConfig } from "@lemon-tea/api/config";
import { hashPassword, type IdentityStore, type OAuthClientRecord, type OAuthCodeRecord, type RefreshTokenRecord, type UserRecord } from "@lemon-tea/auth";
import { createServices, MemoryStore, type AccountProviderTools, type Services } from "@lemon-tea/domain";
import { ProviderRegistry } from "@lemon-tea/provider-sdk";
import type { SessionBundle } from "@lemon-tea/shared-types";
import { syntheticLap } from "../fixtures/synthetic.ts";

export class MemoryIdentity implements IdentityStore {
  users: UserRecord[] = [];
  sessions = new Map<string, { userId: string; exp: number }>();
  tokens = new Map<string, { userId: string; scopes: string[] }>();
  clients = new Map<string, OAuthClientRecord>();
  codes = new Map<string, OAuthCodeRecord & { used: boolean }>();
  refresh = new Map<string, RefreshTokenRecord & { revoked: boolean }>();

  async countUsers() { return this.users.length; }
  async createUser(_t: string, email: string, passwordHash: string, role: "admin" | "user") {
    const u = { id: crypto.randomUUID(), tenantId: crypto.randomUUID(), email, passwordHash, role };
    this.users.push(u);
    return u;
  }
  async userByEmail(e: string) { return this.users.find((u) => u.email === e.toLowerCase()) ?? null; }
  async userById(id: string) { return this.users.find((u) => u.id === id) ?? null; }
  async createAppSession(h: string, userId: string, exp: Date) { this.sessions.set(h, { userId, exp: exp.getTime() }); }
  async appSessionUser(h: string) { const s = this.sessions.get(h); return s && s.exp > Date.now() ? this.userById(s.userId) : null; }
  async deleteAppSession(h: string) { this.sessions.delete(h); }
  async createApiToken(h: string, userId: string, _n: string, scopes: string[]) { this.tokens.set(h, { userId, scopes }); }
  async apiToken(h: string) { const t = this.tokens.get(h); const u = t ? await this.userById(t.userId) : null; return t && u ? { user: u, scopes: t.scopes } : null; }
  async registerClient(c: OAuthClientRecord) { this.clients.set(c.clientId, c); }
  async client(id: string) { return this.clients.get(id) ?? null; }
  async saveCode(h: string, c: OAuthCodeRecord) { this.codes.set(h, { ...c, used: false }); }
  async consumeCode(h: string) { const c = this.codes.get(h); if (!c || c.used || Date.parse(c.expiresAt) < Date.now()) return null; c.used = true; return c; }
  async saveRefreshToken(h: string, r: RefreshTokenRecord) { this.refresh.set(h, { ...r, revoked: false }); }
  async consumeRefreshToken(h: string) { const r = this.refresh.get(h); if (!r || r.revoked) return null; r.revoked = true; return r; }
}

const LAPS = () => [syntheticLap(1, 2, 600_000, {}, 11), syntheticLap(2, 2, 700_000, { corners: [{}, { brakeDistance: 85 }] }, 23)];

function syntheticBundle(id: string): SessionBundle {
  const start = new Date(Date.UTC(2026, 0, 1, 12)).toISOString();
  const epoch = Date.parse(start);
  return {
    meeting: { id: `synthetic:m-${id}`, year: 2026, name: "Synthetic GP (NOT REAL DATA)", countryName: null, location: null, circuitId: "synthetic:oval", circuitShortName: "Synthetic Oval", dateStart: start },
    session: {
      id: `synthetic:${id}`, meetingId: `synthetic:m-${id}`, year: 2026, name: "Qualifying", type: "qualifying", circuitId: "synthetic:oval", circuitShortName: "Synthetic Oval",
      countryName: null, dateStart: start, dateEnd: new Date(epoch + 3600_000).toISOString(), regulationEra: "active_aero_2026", source: "synthetic",
    },
    drivers: [
      { driverNumber: 1, code: "AAA", fullName: "Synthetic A", teamName: "Team X", teamColour: "E8D44D" },
      { driverNumber: 2, code: "BBB", fullName: "Synthetic B", teamName: "Team Y", teamColour: "3FB5C0" },
    ],
    laps: LAPS().map((l) => ({
      driverNumber: l.timing.driverNumber, lapNumber: 2, dateStart: new Date(epoch + l.timing.startMs!).toISOString(), lapTime: l.timing.lapTime,
      sector1: null, sector2: null, sector3: null, i1Speed: null, i2Speed: null, stSpeed: null, isPitOutLap: false, miniSectors: [],
    })),
    stints: [], pitEvents: [], raceControl: [], weather: [], teamRadio: [], positionHistory: [], intervals: [], results: [],
  };
}

export async function loadSynthetic(store: MemoryStore, id: string, owner: string | null) {
  const b = syntheticBundle(id);
  const uid = await store.upsertSession(owner, b);
  await store.writeTiming(uid, b);
  const epoch = Date.parse(b.session.dateStart);
  for (const [i, l] of LAPS().entries()) {
    await store.writeCarSamples(uid, i + 1, { ...l.car, t: l.car.t.map((t) => t + epoch) });
    await store.writePositionSamples(uid, i + 1, { ...l.pos, t: l.pos.t.map((t) => t + epoch) });
  }
  await store.markIngested(uid, "complete", ["timing", "car_data", "location"]);
  return uid;
}

export async function makeHarness(
  opts: {
    allowAnonymous?: boolean;
    encryptionKey?: string;
    accountProviders?: Record<string, AccountProviderTools>;
    /** Register extra (e.g. account-scoped) providers once services exist. */
    configure?: (providers: ProviderRegistry, services: Services) => void;
  } = {},
) {
  const store = new MemoryStore();
  store.sources = [
    { id: "synthetic", name: "Synthetic", apiVersion: "1", license: "Apache-2.0", permittedUse: "tests", redistribution: "permitted", attribution: null, publicDisplayAllowed: true, enabled: true, missingChannels: null, rateLimit: null, accuracyNotes: null, historicalCoverage: null, updateFrequency: null, retention: null },
  ];
  const identity = new MemoryIdentity();
  const providers = new ProviderRegistry();
  const services = createServices({
    store,
    ingestStore: store,
    providers,
    ...(opts.accountProviders ? { accountProviders: opts.accountProviders } : {}),
    ...(opts.encryptionKey ? { encryptionKey: opts.encryptionKey } : {}),
  });
  opts.configure?.(providers, services);
  const config = loadConfig({
    DATABASE_URL: "memory://",
    APP_JWT_SECRET: "test-secret-test-secret-test-secret-123456",
    PUBLIC_URL: "http://localhost:8787",
    ALLOW_ANONYMOUS: opts.allowAnonymous === false ? "false" : "true",
    RATE_LIMIT_PER_MINUTE: "100000",
  });
  const app = createApp({ services, identity, config });
  const alice = await identity.createUser("A", "alice@example.test", await hashPassword("alice-password-123", 1000), "user");
  const bob = await identity.createUser("B", "bob@example.test", await hashPassword("bob-password-1234", 1000), "user");
  await loadSynthetic(store, "public1", null);
  await loadSynthetic(store, "alice1", alice.tenantId);
  return { app, store, identity, services, config, alice, bob };
}

export async function login(app: ReturnType<typeof createApp>, email: string, password: string): Promise<string> {
  const r = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "lemon-tea" },
    body: JSON.stringify({ email, password }),
  });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return r.headers.get("set-cookie")!.split(";")[0]!;
}
