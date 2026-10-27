import type postgres from "postgres";
import type { IdentityStore, OAuthClientRecord, OAuthCodeRecord, RefreshTokenRecord, UserRecord } from "@lemon-tea/auth";

const user = (r: postgres.Row): UserRecord => ({ id: r.id, tenantId: r.tenant_id, email: r.email, passwordHash: r.password_hash, role: r.role });
const iso = (d: Date | string) => new Date(d).toISOString();

/** Identity persistence. Only hashes of tokens/codes are stored; plaintext never touches the DB. */
export class PgIdentityStore implements IdentityStore {
  constructor(private readonly sql: postgres.Sql) {}

  async countUsers() {
    const [r] = await this.sql`select count(*)::int as n from users`;
    return r!.n as number;
  }

  async createUser(tenantName: string, email: string, passwordHash: string, role: "admin" | "user") {
    return this.sql.begin(async (tx) => {
      const [t] = await tx`insert into tenants (name) values (${tenantName}) returning id`;
      const [u] = await tx`insert into users (tenant_id, email, password_hash, role) values (${t!.id}, ${email.toLowerCase()}, ${passwordHash}, ${role}) returning *`;
      return user(u!);
    }) as Promise<UserRecord>;
  }

  async userByEmail(email: string) {
    const [r] = await this.sql`select * from users where email = ${email.toLowerCase()}`;
    return r ? user(r) : null;
  }

  async userById(id: string) {
    const [r] = await this.sql`select * from users where id = ${id}`;
    return r ? user(r) : null;
  }

  async createAppSession(tokenHash: string, userId: string, expiresAt: Date) {
    await this.sql`insert into app_sessions (token_hash, user_id, expires_at) values (${tokenHash}, ${userId}, ${expiresAt})`;
  }

  async appSessionUser(tokenHash: string) {
    const [r] = await this.sql`select u.* from app_sessions s join users u on u.id = s.user_id where s.token_hash = ${tokenHash} and s.expires_at > now()`;
    return r ? user(r) : null;
  }

  async deleteAppSession(tokenHash: string) {
    await this.sql`delete from app_sessions where token_hash = ${tokenHash}`;
  }

  async createApiToken(tokenHash: string, userId: string, name: string, scopes: string[], expiresAt: Date | null) {
    await this.sql`insert into api_tokens (token_hash, user_id, name, scopes, expires_at) values (${tokenHash}, ${userId}, ${name}, ${scopes}, ${expiresAt})`;
  }

  async apiToken(tokenHash: string) {
    const [r] = await this.sql`
      update api_tokens t set last_used_at = now() from users u
      where t.token_hash = ${tokenHash} and u.id = t.user_id and (t.expires_at is null or t.expires_at > now())
      returning u.*, t.scopes as token_scopes`;
    return r ? { user: user(r), scopes: r.token_scopes as string[] } : null;
  }

  async registerClient(c: OAuthClientRecord) {
    await this.sql`insert into oauth_clients (client_id, client_name, redirect_uris) values (${c.clientId}, ${c.clientName}, ${c.redirectUris})`;
  }

  async client(clientId: string) {
    const [r] = await this.sql`select * from oauth_clients where client_id = ${clientId}`;
    return r ? { clientId: r.client_id, clientName: r.client_name, redirectUris: r.redirect_uris } : null;
  }

  async saveCode(codeHash: string, c: OAuthCodeRecord) {
    await this.sql`
      insert into oauth_codes (code_hash, client_id, user_id, scopes, code_challenge, redirect_uri, resource, expires_at)
      values (${codeHash}, ${c.clientId}, ${c.userId}, ${c.scopes}, ${c.codeChallenge}, ${c.redirectUri}, ${c.resource}, ${c.expiresAt})`;
  }

  async consumeCode(codeHash: string) {
    const [r] = await this.sql`
      update oauth_codes set used_at = now()
      where code_hash = ${codeHash} and used_at is null and expires_at > now()
      returning *`;
    return r
      ? { clientId: r.client_id, userId: r.user_id, scopes: r.scopes, codeChallenge: r.code_challenge, redirectUri: r.redirect_uri, resource: r.resource, expiresAt: iso(r.expires_at) }
      : null;
  }

  async saveRefreshToken(tokenHash: string, r: RefreshTokenRecord) {
    await this.sql`
      insert into oauth_refresh_tokens (token_hash, client_id, user_id, scopes, resource, expires_at)
      values (${tokenHash}, ${r.clientId}, ${r.userId}, ${r.scopes}, ${r.resource}, ${r.expiresAt})`;
  }

  async consumeRefreshToken(tokenHash: string) {
    const [r] = await this.sql`
      update oauth_refresh_tokens set revoked_at = now()
      where token_hash = ${tokenHash} and revoked_at is null and expires_at > now()
      returning *`;
    return r ? { clientId: r.client_id, userId: r.user_id, scopes: r.scopes, resource: r.resource, expiresAt: iso(r.expires_at) } : null;
  }
}
