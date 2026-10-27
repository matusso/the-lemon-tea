import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "apps/mcp/**/*.test.ts", "services/jobs/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    environment: "node",
    testTimeout: 20000,
  },
});
