export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
}

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface OAuthCodeRecord {
  clientId: string;
  userId: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  expiresAt: string;
}

export interface RefreshTokenRecord {
  clientId: string;
  userId: string;
  scopes: string[];
  resource: string;
  expiresAt: string;
}

/** Persistence for application identity and the MCP OAuth server. Secrets are stored hashed. */
export interface IdentityStore {
  countUsers(): Promise<number>;
  createUser(tenantName: string, email: string, passwordHash: string, role: "admin" | "user"): Promise<UserRecord>;
  userByEmail(email: string): Promise<UserRecord | null>;
  userById(id: string): Promise<UserRecord | null>;

  createAppSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  appSessionUser(tokenHash: string): Promise<UserRecord | null>;
  deleteAppSession(tokenHash: string): Promise<void>;

  createApiToken(tokenHash: string, userId: string, name: string, scopes: string[], expiresAt: Date | null): Promise<void>;
  apiToken(tokenHash: string): Promise<{ user: UserRecord; scopes: string[] } | null>;

  registerClient(c: OAuthClientRecord): Promise<void>;
  client(clientId: string): Promise<OAuthClientRecord | null>;
  saveCode(codeHash: string, c: OAuthCodeRecord): Promise<void>;
  /** Atomically marks the code used; returns null if unknown, expired or already used. */
  consumeCode(codeHash: string): Promise<OAuthCodeRecord | null>;
  saveRefreshToken(tokenHash: string, r: RefreshTokenRecord): Promise<void>;
  /** Atomically revokes and returns the token (rotation); null if unknown/expired/revoked. */
  consumeRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>;
}
