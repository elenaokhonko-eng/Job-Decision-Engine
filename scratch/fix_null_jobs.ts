import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.local", override: true });
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL + '?sslmode=require' });

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Update the HARD_FAIL jobs to REJECTED
    const updateRes = await client.query(`
      UPDATE jobs 
      SET final_classification = 'REJECTED', updated_at = NOW()
      WHERE final_classification IS NULL AND stage1_status = 'HARD_FAIL'
    `);
    console.log(`✅ Updated ${updateRes.rowCount} HARD_FAIL jobs to REJECTED classification.`);

    // 2. Flip processed status back to false in raw_jobs for the lost jobs
    const resetRawRes = await client.query(`
      UPDATE raw_jobs
      SET processed = FALSE, processed_at = NULL
      WHERE careers_portal_url IN (
        SELECT careers_portal_url
        FROM jobs
        WHERE final_classification IS NULL AND stage1_status != 'HARD_FAIL'
      )
    `);
    console.log(`✅ Reset ${resetRawRes.rowCount} jobs in raw_jobs staging table back to unprocessed.`);

    // 3. Delete the lost jobs from the final jobs table
    const deleteRes = await client.query(`
      DELETE FROM jobs
      WHERE final_classification IS NULL AND stage1_status != 'HARD_FAIL'
    `);
    console.log(`✅ Deleted ${deleteRes.rowCount} lost jobs from the final jobs vault.`);

    await client.query('COMMIT');
    console.log('🎉 Cleanup script completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error executing cleanup script, transaction rolled back:', error);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
