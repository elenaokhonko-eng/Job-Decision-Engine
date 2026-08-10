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
  console.log("=== Staging & Processing Status ===");
  
  // Unprocessed email alerts
  const resEmail = await pool.query("SELECT COUNT(*) as cnt FROM raw_email_alerts WHERE processed_at IS NULL");
  console.log(`Unprocessed email alerts (in raw_email_alerts): ${resEmail.rows[0].cnt}`);

  // Unprocessed staged jobs
  const resRaw = await pool.query("SELECT id, title, company_name, created_at FROM raw_jobs WHERE processed = FALSE");
  console.log(`Unprocessed raw jobs (in raw_jobs): ${resRaw.rows.length}`);
  resRaw.rows.forEach(r => {
    console.log(`  - [${r.created_at.toLocaleString()}] ${r.company_name} | ${r.title}`);
  });

  // Details for BJAK Technical Product Manager
  console.log("\n=== Detailed evaluation for BJAK Technical Product Manager ===");
  const resBjak = await pool.query(`
    SELECT title, company_name, total_score, status, 
           score_technical_autonomy, score_compensation_potential, score_domain_relevance,
           score_environment_guardrails, score_future_mobility,
           nd_friendly_score, politics_stress_score, sensory_overload_index,
           biological_stress_risk, strategic_value, recommended_cv_version, next_action,
           careers_portal_url
    FROM jobs 
    WHERE company_name = 'BJAK' AND title = 'Technical Product Manager'
    ORDER BY created_at DESC 
    LIMIT 1
  `);

  if (resBjak.rows.length > 0) {
    const b = resBjak.rows[0];
    console.log(`Company: ${b.company_name}`);
    console.log(`Title: ${b.title}`);
    console.log(`Status: ${b.status}`);
    console.log(`Total Score: ${b.total_score}/100`);
    console.log(`Careers Url: ${b.careers_portal_url}`);
    console.log(`Subscores:`);
    console.log(`  - Guardrails (30%): ${b.score_environment_guardrails}`);
    console.log(`  - Autonomy (25%): ${b.score_technical_autonomy}`);
    console.log(`  - Relevance (20%): ${b.score_domain_relevance}`);
    console.log(`  - Compensation (15%): ${b.score_compensation_potential}`);
    console.log(`  - Mobility (10%): ${b.score_future_mobility}`);
    console.log(`Autonomy Score: ${b.nd_friendly_score}%`);
    console.log(`Politics Stress Score: ${b.politics_stress_score}%`);
    console.log(`Sensory Overload Index: ${b.sensory_overload_index}%`);
    console.log(`Biological Stress Risk:\n  ${b.biological_stress_risk}`);
    console.log(`Strategic Value:\n  ${b.strategic_value}`);
    console.log(`Recommended CV: ${b.recommended_cv_version}`);
    console.log(`Next Action: ${b.next_action}`);
  } else {
    console.log("No BJAK Technical Product Manager record found.");
  }

  await pool.end();
}

run();
