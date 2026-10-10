import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseConnection } from "./managementStore.js";
export async function applyVersionedMigrations(db: DatabaseConnection) {
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return db.transaction(async connection => {
    await connection.query("SELECT pg_advisory_xact_lock(74842024)");
    await connection.query("CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())");
    const applied: string[] = [];
    for (const version of files) {
      const source = await readFile(`${directory}/${version}`, "utf8"), checksum = createHash("sha256").update(source).digest("hex");
      const existing = await connection.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version=$1",[version]);
      if (existing.length) { if (existing[0].checksum !== checksum) throw new Error("MIGRATION_CHECKSUM_MISMATCH"); continue; }
      // Migrations are trusted versioned files, never request input. Postgres.js permits multi-statements without parameters.
      await connection.query(source);
      await connection.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[version,checksum]); applied.push(version);
    }
    return applied;
  });
}
