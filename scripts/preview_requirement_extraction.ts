/**
 * Read-only preview of the requirement extractor on stored postings.
 *
 * Runs the extractor in memory over the latest stored description of every saved
 * job and every non-fit job (the same two groups as `npm run measure:ranking`)
 * and prints counts only. It writes nothing and calls no AI provider. All queries
 * run inside one BEGIN READ ONLY transaction that is always rolled back.
 *
 *   npm run preview:requirements
 */
import dotenv from 'dotenv';
import pg from 'pg';

import { pgConnectionConfig } from '../src/db/pgSsl.js';
import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS } from '../src/db/stagingDatabaseIdentity.js';
import { LINKEDIN_SAVED_SOURCE_NAME } from '../src/ingestion/linkedInSavedExport.js';
import { classifyNonFitTitle } from '../src/reporting/rankingMeasurement.js';
import {
  previewExtraction,
  unrecognisedHeadingCandidates,
  type ExtractionPreview,
  type PreviewJob,
} from '../src/reporting/extractionPreview.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const pct = (part: number, whole: number): string => (whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(0)}%`);

function block(label: string, preview: ExtractionPreview): string[] {
  const histogram = Object.entries(preview.confirmedHistogram)
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
    .map(([bucket, count]) => `${bucket}:${count}`)
    .join('  ');
  return [
    `[${label}]  jobs: ${preview.jobs}`,
    `  has a requirements heading   ${preview.withRequirementsSection} (${pct(preview.withRequirementsSection, preview.jobs)})`,
    `  has a responsibilities part  ${preview.withResponsibilitiesSection} (${pct(preview.withResponsibilitiesSection, preview.jobs)})`,
    `  bullets but no heading       ${preview.itemsWithoutRequirementsHeading} (${pct(preview.itemsWithoutRequirementsHeading, preview.jobs)})`,
    `  needs description (<3)       ${preview.needsDescription} (${pct(preview.needsDescription, preview.jobs)})`,
    `  confirmed requirements/job   median ${preview.medianConfirmed ?? 'n/a'}   histogram ${histogram}`,
    `  item classes                 ${JSON.stringify(preview.itemClassCounts)}`,
  ];
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Set it in the environment or .env.local.');
    process.exit(1);
  }
  const host = new URL(databaseUrl).hostname.toLowerCase();
  const knownProduction = STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.knownProductionHostnames.some(
    (candidate) => host === candidate || host.replace('-pooler', '') === candidate,
  );
  console.error(`Database host: ${host}${knownProduction ? ' (production branch: read-only transaction enforced)' : ''}`);

  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const workspace = await resolveWorkspaceContext(client);
    const { rows } = await client.query<{ job_id: string; title: string | null; description_text: string | null; saved: boolean }>(
      `
      SELECT cj.id AS job_id, cj.normalized_title AS title, jv.description_text,
             EXISTS (
               SELECT 1 FROM raw_job_observations o
               JOIN job_versions ojv ON ojv.id = o.job_version_id
               WHERE o.workspace_id = cj.workspace_id AND o.source_name = $2
                 AND ojv.canonical_job_id = cj.id
             ) AS saved
      FROM canonical_jobs cj
      JOIN job_versions jv ON jv.id = cj.latest_job_version_id
      WHERE cj.workspace_id = $1 AND cj.archived_at IS NULL AND jv.description_text IS NOT NULL
      `,
      [workspace.workspaceId, LINKEDIN_SAVED_SOURCE_NAME],
    );

    const saved: PreviewJob[] = [];
    const nonFit: PreviewJob[] = [];
    for (const row of rows) {
      const job = { jobId: row.job_id, descriptionText: row.description_text ?? '' };
      if (row.saved) saved.push(job);
      else if (classifyNonFitTitle(row.title ?? '')) nonFit.push(job);
    }

    const lines = ['Requirement extraction preview (read-only, counts only)', ''];
    lines.push(...block('SAVED jobs', previewExtraction(saved)), '');
    lines.push(...block('NON-FIT jobs', previewExtraction(nonFit)), '');
    lines.push('Short heading-like lines the parser does not recognise (postings that carry them):');
    for (const candidate of unrecognisedHeadingCandidates([...saved, ...nonFit])) {
      lines.push(`  ${String(candidate.postings).padStart(4)}  ${candidate.line}`);
    }
    console.log(lines.join('\n'));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
