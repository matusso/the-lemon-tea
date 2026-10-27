import { PgIdentityStore, PgStore } from "@lemon-tea/db";
import { createServices, type Services } from "@lemon-tea/domain";
import type { FileImportProvider } from "@lemon-tea/provider-file-import";
import { hashPassword } from "@lemon-tea/auth";
import type { Config } from "./config.ts";
import { accountProviders, bindAccountProviders, createProviders } from "./providers.ts";

export interface Runtime {
  services: Services;
  identity: PgIdentityStore;
  store: PgStore;
  fileImport: FileImportProvider;
  close(): Promise<void>;
}

/** Composition root shared by the Node server, CLI, job runner and stdio MCP server. */
export function buildRuntime(config: Pick<Config, "DATABASE_URL" | "OPENF1_USERNAME" | "OPENF1_PASSWORD" | "APP_ENCRYPTION_KEY" | "publicSources">): Runtime {
  const store = PgStore.connect(config.DATABASE_URL);
  const identity = new PgIdentityStore(store.sql);
  const { providers, fileImport } = createProviders(config);
  const services = createServices({
    store,
    ingestStore: store,
    providers,
    extraPublicSources: config.publicSources,
    accountProviders,
    ...(config.APP_ENCRYPTION_KEY ? { encryptionKey: config.APP_ENCRYPTION_KEY } : {}),
  });
  bindAccountProviders(providers, services);
  return { services, identity, store, fileImport, close: () => store.close() };
}

/** Create the initial admin from ADMIN_EMAIL/ADMIN_PASSWORD if no users exist yet. */
export async function bootstrapAdmin(rt: Runtime, email: string | undefined, password: string | undefined, log = console.log) {
  if ((await rt.identity.countUsers()) > 0) return;
  if (!email || !password) {
    log("[setup] no users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD (>= 12 chars) to create the first administrator.");
    return;
  }
  await rt.identity.createUser("Default", email, await hashPassword(password), "admin");
  log(`[setup] created administrator ${email}`);
}
