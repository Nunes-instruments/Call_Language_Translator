import postgres from "postgres";
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({
  path: path.resolve(process.cwd(), ".env")
});

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL missing");
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1
});

try {
  console.log("");
  console.log("==========================================");
  console.log(" NUNES CALL_EVENTS SCHEMA CHECK");
  console.log("==========================================");

  const columns = await sql`
    SELECT
      column_name,
      data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'call_events'
    ORDER BY ordinal_position
  `;

  for (const column of columns) {
    console.log(
      `${column.column_name} : ${column.data_type}`
    );
  }

  console.log("==========================================");
}
finally {
  await sql.end();
}
