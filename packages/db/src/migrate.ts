import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

/**
 * Applies database/migrations/*.sql in lexical order, each in its own transaction, recording
 * applied files in schema_migrations. Runs with the admin/owner connection (MIGRATION_DATABASE_URL);
 * the application itself connects as the restricted `lemontea_app` role.
 * After migrating, sets the app role password from APP_DB_PASSWORD when provided.
 */
export async function migrate(url: string, dir = join(dirname(fileURLToPath(import.meta.url)), "../../../database/migrations"), log = console.log) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const body = await readFile(join(dir, f), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${f})`;
      });
      log(`applied ${f}`);
    }
    const appPassword = process.env.APP_DB_PASSWORD;
    if (appPassword) {
      // ALTER ROLE cannot take bind parameters; quote the literal safely.
      await sql.unsafe(`alter role lemontea_app with login password '${appPassword.replaceAll("'", "''")}'`);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
