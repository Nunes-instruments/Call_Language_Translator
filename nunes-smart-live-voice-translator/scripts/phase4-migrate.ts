import postgres from "postgres";
import { postgresConnection } from "../packages/database/src/postgresConnection.js";
import { applyVersionedMigrations } from "../packages/database/src/versionedMigrate.js";
async function main() {
  if (!process.argv.includes("--apply") || !process.argv.includes("--target=development")) throw new Error("EXPLICIT_DEVELOPMENT_TARGET_REQUIRED");
  const connection = process.env.DATABASE_URL_UNPOOLED;
  if (!connection || new URL(connection).hostname.includes("-pooler")) throw new Error("DIRECT_DEVELOPMENT_DATABASE_REQUIRED");
  const sql = postgres(connection,{ ssl: "require",max:1 });
  try { console.log({ applied: await applyVersionedMigrations(postgresConnection(sql)) }); } finally { await sql.end(); }
}
main().catch(() => { console.error("Migration failed; no credentials logged. Check explicit development target and database schema."); process.exitCode = 1; });
