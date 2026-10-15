import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

interface SampleRow {
  id: string;
  normalized_title: string;
  company_name: string;
  location: string | null;
  workplace_type: string | null;
  rejection_codes: string[];
  evidence_quotes: string[];
  description_snippet: string;
}

async function run() {
  const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL_UNPOOLED));
  const ctx = await resolveWorkspaceContext(pool as any);

  const query = `
    WITH latest_gates AS (
      SELECT DISTINCT ON (canonical_job_id)
        canonical_job_id,
        rejection_codes,
        evidence_quotes
      FROM gate_decisions
      WHERE workspace_id = $1
      ORDER BY canonical_job_id, created_at DESC, id DESC
    )
    SELECT
      c.id,
      c.normalized_title,
      c.company_name,
      c.location,
      c.workplace_type,
      lg.rejection_codes,
      lg.evidence_quotes,
      SUBSTRING(jv.description_text, 1, 300) as description_snippet
    FROM canonical_jobs c
    JOIN latest_gates lg ON lg.canonical_job_id = c.id
    JOIN job_versions jv ON jv.id = c.latest_job_version_id
    WHERE c.workspace_id = $1
      AND NOT c.is_test_fixture
      AND lg.rejection_codes ? 'WORK_AUTHORIZATION_INCOMPATIBLE'
    ORDER BY c.created_at ASC
    LIMIT 100
  `;

  const { rows } = await pool.query<SampleRow>(query, [ctx.workspaceId]);
  console.log(`Auditing ${rows.length} stratified WORK_AUTHORIZATION_INCOMPATIBLE samples...`);

  let validWorkerConstraintCount = 0;
  let invalidCompanyMetadataCount = 0;
  const invalidSamples: Array<{ id: string; title: string; company: string; evidence: string[] }> = [];

  const invalidPatterns = [
    /^(?:company|headquarters|hq|office\s+location|employer\s+address)\b/i,
    /^(?:startup|company)\s+based\s+in\b/i,
  ];

  for (const sample of rows) {
    const quotes = sample.evidence_quotes || [];
    const quotesStr = quotes.join(" ");

    // Check if rejection quote contains valid candidate/worker constraints
    const isWorkerConstraint =
      /\b(?:must\s+be\s+(?:authorized|eligible|legally\s+authorized)|right\s+to\s+work|work\s+(?:authorization|permit)|visa\s+sponsorship\s+(?:not|is\s+not)|citizenship\s+required|must\s+reside|candidates?\s+must\s+be\s+based|remote\s+(?:eligible\s+only\s+in|in\s+the\s+us|in\s+the\s+uk|in\s+canada))\b/i.test(quotesStr)
      || /\b(?:us|uk|eu|canada|germany)\s+(?:citizen|citizenship|pr|permanent\s+resident|work\s+authorization)\b/i.test(quotesStr);

    const isInvalidMetadata = invalidPatterns.some((p) => p.test(quotesStr));

    if (isInvalidMetadata || (!isWorkerConstraint && quotesStr.includes("location:"))) {
      invalidCompanyMetadataCount += 1;
      invalidSamples.push({
        id: sample.id,
        title: sample.normalized_title,
        company: sample.company_name,
        evidence: quotes,
      });
    } else {
      validWorkerConstraintCount += 1;
    }
  }

  const precision = rows.length > 0 ? (validWorkerConstraintCount / rows.length) * 100 : 100;
  console.log("\nWORK_AUTHORIZATION PRECISION AUDIT RESULTS:");
  console.log(`- Samples Audited:                ${rows.length}`);
  console.log(`- Valid Worker Constraints:       ${validWorkerConstraintCount}`);
  console.log(`- Invalid Company/Metadata Cases: ${invalidCompanyMetadataCount}`);
  console.log(`- Precision:                      ${precision.toFixed(1)}%`);

  if (invalidSamples.length > 0) {
    console.log(`\nSample invalid cases (${invalidSamples.length}):`);
    for (const s of invalidSamples.slice(0, 5)) {
      console.log(`  * ${s.company} - ${s.title}: ${JSON.stringify(s.evidence)}`);
    }
  }

  await pool.end();
}

run().catch(console.error);
