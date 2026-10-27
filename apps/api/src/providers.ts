import type { AccountProviderTools, Services } from "@lemon-tea/domain";
import { ProviderRegistry } from "@lemon-tea/provider-sdk";
import { F1LiveTimingProvider, F1LT_SOURCE_ID, signIn, subscriptionTokenFromJwt, type WebSocketFactory } from "@lemon-tea/provider-f1-livetiming";
import { FileImportProvider } from "@lemon-tea/provider-file-import";
import { JolpicaProvider } from "@lemon-tea/provider-jolpica";
import { OpenF1Provider } from "@lemon-tea/provider-openf1";
import type { Config } from "./config.ts";

/** Providers users connect with their own account. */
export const accountProviders: Record<string, AccountProviderTools> = {
  [F1LT_SOURCE_ID]: { name: "Formula 1 account", signIn: (u, p) => signIn(u, p), parseToken: subscriptionTokenFromJwt },
};

/** Shared by the Node runtime and the Cloudflare Worker. */
export function createProviders(config: Pick<Config, "OPENF1_USERNAME" | "OPENF1_PASSWORD">) {
  const fileImport = new FileImportProvider();
  const providers = new ProviderRegistry()
    .register(new OpenF1Provider({ ...(config.OPENF1_USERNAME ? { username: config.OPENF1_USERNAME } : {}), ...(config.OPENF1_PASSWORD ? { password: config.OPENF1_PASSWORD } : {}) }))
    .register(new JolpicaProvider())
    .register(fileImport);
  return { providers, fileImport };
}

/**
 * F1 live timing authenticates with each tenant's own Formula 1 account, so every tenant gets
 * its own provider instance whose token comes from that tenant's encrypted connection.
 */
export function bindAccountProviders(providers: ProviderRegistry, services: Services, connect?: WebSocketFactory) {
  providers.registerScoped(
    F1LT_SOURCE_ID,
    (tenantId) =>
      new F1LiveTimingProvider({
        token: () => services.connections.tokenFor(tenantId, F1LT_SOURCE_ID),
        onUnauthorized: () => services.connections.markExpired(tenantId, F1LT_SOURCE_ID),
        ...(connect ? { connect } : {}),
      }),
  );
}
