import { z } from "zod";

/**
 * Server configuration. Secrets come from the environment (Node) or Worker Secrets (Cloudflare)
 * and are never sent to clients or written to logs.
 */
const Env = z.object({
  PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  DATABASE_URL: z.string().min(1),
  APP_JWT_SECRET: z.string().min(32, "APP_JWT_SECRET must be at least 32 characters"),
  APP_ENCRYPTION_KEY: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default(""),
  ALLOW_ANONYMOUS: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Extra source ids whose public rows anonymous users may read (beyond the governance registry). */
  PUBLIC_SOURCES: z.string().default(""),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  OPENF1_USERNAME: z.string().optional(),
  OPENF1_PASSWORD: z.string().optional(),
  WEB_DIST: z.string().optional(),
  PORT: z.coerce.number().int().default(8787),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(240),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export type Config = z.infer<typeof Env> & { mcpResource: string; origins: string[]; publicSources: string[]; cookieSecure: boolean };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  const base = c.PUBLIC_URL.replace(/\/$/, "");
  return {
    ...c,
    PUBLIC_URL: base,
    mcpResource: `${base}/mcp`,
    origins: [base, ...c.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)],
    publicSources: c.PUBLIC_SOURCES.split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: c.COOKIE_SECURE ?? base.startsWith("https://"),
  };
}
