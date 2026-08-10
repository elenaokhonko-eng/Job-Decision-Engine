import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log("=== Checking BJAK status in processed 'jobs' ===");
  const resBjak = await pool.query(`
    SELECT title, company_name, status, total_score, recommended_cv_version, next_action, created_at 
    FROM jobs 
    WHERE company_name ILIKE '%BJAK%' AND title ILIKE '%Technical Product Manager%'
  `);
  resBjak.rows.forEach(r => {
    console.log(`- [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} | Status: ${r.status} | Score: ${r.total_score}/100`);
    console.log(`  CV: ${r.recommended_cv_version} | Next: ${r.next_action}`);
  });

  console.log("\n=== Checking Top 5 recently processed jobs ===");
  const resRecent = await pool.query(`
    SELECT title, company_name, status, total_score, created_at 
    FROM jobs 
    ORDER BY created_at DESC 
    LIMIT 5
  `);
  resRecent.rows.forEach(r => {
    console.log(`- [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title} | Status: ${r.status} | Score: ${r.total_score}/100`);
  });

  await pool.end();
}

run();
