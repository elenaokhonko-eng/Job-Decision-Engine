import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query(`
    SELECT * FROM jobs 
    WHERE biological_stress_risk ILIKE '%Quota exceeded%' OR biological_stress_risk ILIKE '%All model API calls failed%'
  `);
  
  console.log(`Found ${res.rows.length} jobs that failed due to API rate limits.`);
  
  for (const job of res.rows) {
    // Insert back into raw_jobs
    await pool.query(`
      INSERT INTO raw_jobs (title, company_name, source, url, careers_portal_url, raw_description, status, posted_date, processed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
    `, [
      job.title, 
      job.company_name, 
      job.source, 
      job.careers_portal_url, // We might not have the original URL, but careers_portal_url is fine
      job.careers_portal_url,
      job.description, 
      'NEW', 
      job.created_at
    ]);
    
    // Delete from jobs
    await pool.query(`DELETE FROM jobs WHERE id = $1`, [job.id]);
  }
  
  console.log("Successfully restored failed jobs to staging queue and removed them from the Vault.");
  process.exit(0);
}
run();
