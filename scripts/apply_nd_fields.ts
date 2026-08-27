import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  console.log("Applying schema updates for ND fields...");
  try {
    await pool.query(`
      ALTER TABLE jobs 
      ADD COLUMN IF NOT EXISTS nd_gate_status VARCHAR(50),
      ADD COLUMN IF NOT EXISTS nd_score INTEGER,
      ADD COLUMN IF NOT EXISTS nd_evidence TEXT,
      ADD COLUMN IF NOT EXISTS nd_risk_flags JSONB,
      ADD COLUMN IF NOT EXISTS work_mode_status VARCHAR(50),
      ADD COLUMN IF NOT EXISTS office_days INTEGER,
      ADD COLUMN IF NOT EXISTS interaction_load INTEGER,
      ADD COLUMN IF NOT EXISTS building_research_ratio INTEGER,
      ADD COLUMN IF NOT EXISTS rejection_codes JSONB;
    `);
    console.log("✅ Successfully updated the jobs table with ND fields.");
  } catch (err) {
    console.error("❌ Error updating schema:", err);
  } finally {
    await pool.end();
  }
}

run();
