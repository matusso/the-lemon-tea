/**
 * Database-level isolation test (runs only when DATABASE_URL and MIGRATION_DATABASE_URL are set,
 * e.g. in CI or locally via `npx vitest run tests/db` with the .env loaded). Synthetic rows only.
 */
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PgStore } from "@lemon-tea/db";

const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const enabled = Boolean(appUrl && ownerUrl);

describe.skipIf(!enabled)("row-level security", () => {
  const owner = enabled ? postgres(ownerUrl!, { max: 1, onnotice: () => {} }) : null;
  const store = enabled ? PgStore.connect(appUrl!, { max: 2 }) : null;
  const tag = `rls${Date.now()}`;
  const meeting = `synthetic:${tag}`;
  let tenantA = "";
  let tenantB = "";

  afterAll(async () => {
    if (!owner) return;
    await owner`delete from sessions where meeting_id = ${meeting}`;
    await owner`delete from meetings where id = ${meeting}`;
    await owner`delete from tenants where id in ${owner([tenantA, tenantB])}`;
    await owner.end();
    await store!.close();
  });

  it("sets up synthetic public and private sessions", async () => {
    [{ id: tenantA }] = await owner!`insert into tenants (name) values ('A') returning id`;
    [{ id: tenantB }] = await owner!`insert into tenants (name) values ('B') returning id`;
    await owner!`insert into circuits (id, short_name) values ('synthetic:oval', 'Synthetic Oval') on conflict do nothing`;
    await owner!`insert into meetings (id, year, name, circuit_id, date_start, source) values (${meeting}, 2026, 'Synthetic', 'synthetic:oval', now(), 'synthetic')`;
    for (const [suffix, ownerId] of [["pub", null], ["a", tenantA], ["b", tenantB]] as const) {
      await owner!`insert into sessions (id, owner_tenant_id, meeting_id, year, name, type, circuit_id, date_start, regulation_era, source)
        values (${`synthetic:${tag}${suffix}`}, ${ownerId}, ${meeting}, 2026, 'Q', 'qualifying', 'synthetic:oval', now(), 'active_aero_2026', 'synthetic')`;
    }
  });

  it("tenant A sees public and own rows only", async () => {
    const ids = (await store!.listSessions({ tenantId: tenantA }, { meetingId: meeting, limit: 200 })).map((r) => r.id).sort();
    expect(ids).toEqual([`synthetic:${tag}a`, `synthetic:${tag}pub`]);
    expect(await store!.findSessions({ tenantId: tenantA }, `synthetic:${tag}b`)).toEqual([]);
  });

  it("anonymous scope sees only public rows", async () => {
    const ids = (await store!.listSessions({ tenantId: null }, { meetingId: meeting, limit: 200 })).map((r) => r.id);
    expect(ids).toEqual([`synthetic:${tag}pub`]);
  });

  it("the application role cannot write a row owned by another tenant", async () => {
    await expect(
      store!.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        await tx`insert into sessions (id, owner_tenant_id, meeting_id, year, name, type, circuit_id, date_start, regulation_era, source)
          values (${`synthetic:${tag}x`}, ${tenantB}, ${meeting}, 2026, 'Q', 'qualifying', 'synthetic:oval', now(), 'active_aero_2026', 'synthetic')`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("provider account connections are visible to their own tenant only", async () => {
    const secret = new Uint8Array([1, 2, 3]);
    await store!.saveProviderConnection({ tenantId: tenantA }, { provider: "f1lt", status: "connected", secret, config: { expiresAt: 1 } });
    expect((await store!.getProviderConnection({ tenantId: tenantA }, "f1lt"))?.secret).toEqual(secret);
    expect(await store!.getProviderConnection({ tenantId: tenantB }, "f1lt")).toBeNull();
    expect(await store!.getProviderConnection({ tenantId: null }, "f1lt")).toBeNull();
    expect(await store!.deleteProviderConnection({ tenantId: tenantB }, "f1lt")).toBe(false);
    await expect(
      store!.sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
        await tx`insert into provider_connections (tenant_id, provider, status) values (${tenantA}, 'openf1', 'connected')`;
      }),
    ).rejects.toThrow(/row-level security/);
    expect(await store!.deleteProviderConnection({ tenantId: tenantA }, "f1lt")).toBe(true);
  });
});
