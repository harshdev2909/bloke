import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Applies db/migrations/*.sql in order, once each, recording them in schema_migrations. */
export async function migrate(databaseUrl: string, dir = defaultDir()): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8").replace(/^\s*BEGIN;\s*$/m, "").replace(/^\s*COMMIT;\s*$/m, "");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

function defaultDir(): string {
  return fileURLToPath(new URL("../../../db/migrations", import.meta.url));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("missing DATABASE_URL");
  migrate(url).then((a) => console.log(JSON.stringify({ msg: "migrated", applied: a })));
}
