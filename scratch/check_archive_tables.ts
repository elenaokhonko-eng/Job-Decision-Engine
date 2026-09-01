import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main(): Promise<void> {
  const { rows } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('archived_jobs','archived_raw_jobs') ORDER BY table_name"
  );

  console.log("Archive tables found:", rows.map((r) => r.table_name).join(", ") || "none");

  for (const row of rows) {
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM ${row.table_name}`);
    console.log(`${row.table_name} rows:`, count.rows[0].n);
  }
}

main()
  .catch((err) => {
    console.error("Archive check failed:", err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
