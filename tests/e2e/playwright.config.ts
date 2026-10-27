import { defineConfig } from "@playwright/test";

/**
 * Browser smoke tests against a running instance (default http://localhost:8787).
 * The target must expose E2E_SESSION (default openf1:9908) to the test viewer, e.g. start the
 * server with PUBLIC_SOURCES=openf1 on a local, non-public machine.
 */
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8787", headless: true, viewport: { width: 1680, height: 1000 } },
  reporter: "list",
});
