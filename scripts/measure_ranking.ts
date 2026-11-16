/**
 * Read-only ranking measurement.
 *
 * Answers one question: does the deterministic score tell a job the owner
 * saved from a job whose title the owner would never take? Every figure is
 * printed for the whole set and for the FIT (80%) and HOLDOUT (20%) splits.
 *
 * Safety: all queries run inside one BEGIN READ ONLY transaction that is
 * always rolled back. The tool prints only the database host, never a
 * connection string.
 *
 *   npm run measure:ranking
 *   npm run measure:ranking -- --json
 */
import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS } from "../src/db/stagingDatabaseIdentity.js";
import { LINKEDIN_SAVED_SOURCE_NAME } from "../src/ingestion/linkedInSavedExport.js";
import {
  buildMeasurementReport,
  type GroupFigures,
  type MeasurementReport,
} from "../src/reporting/rankingMeasurement.js";
import { loadCandidateJobs, loadSavedObservations } from "../src/reporting/rankingMeasurementQueries.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const fmt = (value: number | null, digits = 2): string => (value === null ? "n/a" : value.toFixed(digits));
const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);

function figuresBlock(label: string, f: GroupFigures): string[] {
  return [
    `  [${label}]  saved jobs measured: ${f.savedCount}   non-fits measured: ${f.nonFitCount}`,
    `    separation (match score):    ${fmt(f.separationMatchScore)}`,
    `    separation (coverage):       ${fmt(f.separationCoverage)}`,
    `    separation (avg similarity): ${fmt(f.separationAvgSimilarity)}`,
    `    median match score   saved ${fmt(f.medianMatchScoreSaved, 1)}  non-fit ${fmt(f.medianMatchScoreNonFit, 1)}`,
    `    median coverage      saved ${fmt(f.medianCoverageSaved, 1)}  non-fit ${fmt(f.medianCoverageNonFit, 1)}`,
    `    median avg similarity saved ${fmt(f.medianAvgSimilaritySaved)}  non-fit ${fmt(f.medianAvgSimilarityNonFit)}`,
    `    at Review/Priority   saved ${f.savedReviewOrPriority}/${f.savedCount} (${pct(f.savedReviewOrPriorityShare)})` +
      `  non-fit ${f.nonFitReviewOrPriority}/${f.nonFitCount} (${pct(f.nonFitReviewOrPriorityShare)})`,
    `    saved jobs in Top 10: ${f.top10.saved}/${f.top10.size}   Top 50: ${f.top50.saved}/${f.top50.size}` +
      `   (saved share of the pool: ${pct(f.poolSavedShare)})`,
  ];
}

export function formatReport(report: MeasurementReport): string {
  const lines: string[] = [];
  lines.push("Ranking measurement (read-only)");
  lines.push("");
  lines.push(`Saved observations (${LINKEDIN_SAVED_SOURCE_NAME}): ${report.observationTotal}`);
  for (const [reason, count] of Object.entries(report.exclusionCounts)) {
    lines.push(`  ${reason.padEnd(24)} ${count}`);
  }
  lines.push("");
  lines.push(`Distinct saved jobs behind those observations: ${report.distinctSavedJobs}`);
  for (const [reason, count] of Object.entries(report.jobReasonCounts)) {
    lines.push(`  ${reason.padEnd(24)} ${count}`);
  }
  const states = Object.entries(report.noMatchByState).sort((a, b) => b[1] - a[1]);
  if (states.length > 0) {
    lines.push("  saved jobs with no completed match, by pipeline state:");
    for (const [state, count] of states) lines.push(`    ${state.padEnd(24)} ${count}`);
  }
  lines.push("");
  lines.push("Non-fit titles used (backend/general software included; DevOps, cloud, platform, architect excluded):");
  for (const [category, count] of Object.entries(report.nonFitCategoryCounts)) {
    const samples = report.nonFitTitleSamples[category as keyof typeof report.nonFitTitleSamples];
    lines.push(`  ${category.padEnd(26)} ${String(count).padStart(5)}   e.g. ${samples.slice(0, 3).join(" | ")}`);
  }
  lines.push(`  dropped because the job is also saved: ${report.nonFitCandidatesExcludedBecauseSaved}`);
  lines.push("");
  lines.push(...figuresBlock("ALL", report.all));
  lines.push("");
  lines.push(...figuresBlock("FIT 80%", report.fit));
  lines.push("");
  lines.push(...figuresBlock("HOLDOUT 20%", report.holdout));
  lines.push("");
  lines.push("Separation: chance a random saved job outscores a random non-fit (0.5 = coin flip, 1.0 = always).");
  lines.push("Top N is counted inside the measured pool (saved + non-fit), ordered by match score.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Set it in the environment or .env.local.");
    process.exit(1);
  }

  const host = new URL(databaseUrl).hostname.toLowerCase();
  const knownProduction = STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.knownProductionHostnames.some(
    (candidate) => host === candidate || host.replace("-pooler", "") === candidate,
  );
  console.error(`Database host: ${host}${knownProduction ? " (production branch: read-only transaction enforced)" : ""}`);

  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const workspace = await resolveWorkspaceContext(client);
    const saved = await loadSavedObservations(client, workspace.workspaceId, LINKEDIN_SAVED_SOURCE_NAME);
    const candidates = await loadCandidateJobs(client, workspace.workspaceId);
    const report = buildMeasurementReport(saved, candidates);
    console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

if (process.argv[1] && /measure_ranking\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(`Ranking measurement failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
