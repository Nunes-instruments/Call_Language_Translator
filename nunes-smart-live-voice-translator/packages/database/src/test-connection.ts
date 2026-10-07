import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is missing");
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,
});

async function main() {
  try {
    const result = await sql`
      SELECT
        current_database() AS database,
        current_user AS user,
        NOW() AS server_time
    `;

    console.log("");
    console.log("======================================");
    console.log(" NUNES NEON DATABASE CONNECTION");
    console.log("======================================");
    console.log("STATUS   : CONNECTED");
    console.log("DATABASE :", result[0].database);
    console.log("USER     :", result[0].user);
    console.log("TIME     :", result[0].server_time);
    console.log("======================================");
    console.log("");
  } catch (error) {
    console.error("");
    console.error("DATABASE CONNECTION FAILED");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
