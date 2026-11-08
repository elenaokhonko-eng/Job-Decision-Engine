/**
 * Replay the remote hiring-territory gate and track-aware seniority against current jobs.
 *
 * Dry run (default) is read-only: it computes, in memory, how every gate-passed job with a
 * PRIORITY/REVIEW/TRACK outcome would change and prints Apply Now before and after.
 *
 *   npx tsx scripts/replay_track_seniority.ts [--experience-file <profile.json or array>] [--json <out>]
 *   npx tsx scripts/replay_track_seniority.ts --apply
 *
 * --experience-file previews a profile's experience_by_track before it is imported; otherwise the
 * active profile version's stored value is used. --apply re-gates only the jobs whose territory
 * result changed and re-runs the decider for the rest; it never uses --experience-file.
 */
import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { applyRemoteTerritoryGate, remoteTerritoryScopeForPolicy, runHardGates } from "../src/pipeline/hardGate.js";
import { runRecommendationDecider } from "../src/pipeline/recommendationDecider.js";
import { resolveWorkspaceWorkabilityPolicy } from "../src/pipeline/workabilityPolicy.js";
import {
  assessCareerTrack,
  capOutcome,
  parseTrackExperience,
  type CareerTrackAssessment,
  type TrackExperience,
  type TrackRequirement,
} from "../src/pipeline/careerTrack.js";
import type { RemoteTerritoryScope } from "../src/eligibility/remoteHiringTerritory.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

export interface ReplayJob {
  readonly canonical_job_id: string;
  readonly company_name: string;
  readonly title: string;
  readonly outcome: string;
  readonly source_name: string | null;
  readonly location: string | null;
  readonly workplace_type: string | null;
  readonly description: string | null;
  readonly requirements: readonly TrackRequirement[];
}

export interface ReplayRow {
  readonly canonical_job_id: string;
  readonly company_name: string;
  readonly title: string;
  readonly before: string;
  readonly after: string;
  readonly territory: "PASS" | "HARD_REJECT" | "NEEDS_VERIFICATION";
  readonly territory_reason: string | null;
  readonly career_track: CareerTrackAssessment;
}

const APPLY_NOW = new Set(["PRIORITY", "REVIEW"]);

/** Pure replay: the new gate result and capped outcome for each job. */
export function planTrackSeniorityReplay(
  jobs: readonly ReplayJob[],
  scope: RemoteTerritoryScope | null,
  experience: readonly TrackExperience[],
): ReplayRow[] {
  return jobs.map((job) => {
    const gate = applyRemoteTerritoryGate({
      sourceName: job.source_name,
      location: job.location,
      workplaceType: job.workplace_type,
      description: job.description,
    }, scope);
    const careerTrack = assessCareerTrack({ title: job.title, requirements: job.requirements, experience });
    const after = gate.status === "HARD_REJECT"
      ? "HARD_REJECTED"
      : gate.status === "NEEDS_VERIFICATION"
        ? "NEEDS_VERIFICATION"
        : capOutcome(job.outcome, careerTrack.outcome_cap);
    return {
      canonical_job_id: job.canonical_job_id,
      company_name: job.company_name,
      title: job.title,
      before: job.outcome,
      after,
      territory: gate.status,
      territory_reason: gate.status === "PASS" ? null : gate.evidence_quotes[0] ?? null,
      career_track: careerTrack,
    };
  });
}

function parseArgs(argv: readonly string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  const experienceFile = value("--experience-file");
  const apply = argv.includes("--apply");
  if (apply && experienceFile) throw new Error("--apply uses the active profile; do not combine it with --experience-file.");
  return { apply, experienceFile, jsonOut: value("--json") };
}

function experienceFromFile(filePath: string): TrackExperience[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), ""));
  return parseTrackExperience(Array.isArray(parsed) ? parsed : parsed?.experience_by_track ?? null);
}

function describeTrack(row: ReplayRow): string {
  const track = row.career_track;
  return [track.track, track.level.toLowerCase(), ...track.tags.map((tag) => tag.toLowerCase())].join(" · ");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  console.log(`Replay track seniority ${options.apply ? "[APPLY]" : "[DRY RUN, read-only]"} on host ${new URL(databaseUrl).host}`);

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    if (!options.apply) await client.query("BEGIN READ ONLY");
    const ctx = await resolveWorkspaceContext(client as any);
    const policy = await resolveWorkspaceWorkabilityPolicy(client as any, { context: ctx });
    const scope = remoteTerritoryScopeForPolicy(policy.policy);

    // A preview file needs no stored profile value (and works before migration 103 is applied).
    const experience = options.experienceFile
      ? experienceFromFile(options.experienceFile)
      : parseTrackExperience((await client.query<{ experience_by_track: unknown }>(
        `SELECT experience_by_track FROM profile_versions
         WHERE workspace_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`,
        [ctx.workspaceId],
      )).rows[0]?.experience_by_track ?? null);
    console.log(`Experience source: ${options.experienceFile ? "--experience-file" : "active profile"} (${experience.length} track(s)).`);

    const { rows } = await client.query<ReplayJob & { requirements: TrackRequirement[] | null }>(
      `SELECT c.id AS canonical_job_id, c.company_name, c.normalized_title AS title,
              c.recommendation_outcome AS outcome, c.workplace_type, jv.description_text AS description,
              observation.source_name, COALESCE(observation.location_raw, c.location) AS location,
              (SELECT json_agg(json_build_object(
                        'requirement_type', jr.requirement_type, 'importance', jr.importance,
                        'requirement_text', jr.requirement_text, 'structured_value', jr.structured_value))
                 FROM job_requirements jr
                WHERE jr.workspace_id = c.workspace_id AND jr.job_version_id = jv.id
                  AND jr.requirement_set_id = jv.active_requirement_set_id) AS requirements
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.id = c.latest_job_version_id AND jv.workspace_id = c.workspace_id
       LEFT JOIN LATERAL (
         SELECT o.source_name, o.location_raw FROM raw_job_observations o
         WHERE o.workspace_id = jv.workspace_id AND o.job_version_id = jv.id
         ORDER BY o.retrieved_at DESC, o.id DESC LIMIT 1
       ) observation ON TRUE
       WHERE c.workspace_id = $1 AND c.archived_at IS NULL AND c.gate_decision = 'PASS'
         AND c.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK')
       ORDER BY c.recommendation_outcome, c.company_name`,
      [ctx.workspaceId],
    );
    const plan = planTrackSeniorityReplay(rows.map((row) => ({ ...row, requirements: row.requirements ?? [] })), scope, experience);

    const before = plan.filter((row) => APPLY_NOW.has(row.before));
    const after = plan.filter((row) => APPLY_NOW.has(row.after));
    const count = (list: ReplayRow[], outcome: string) => list.filter((row) => row[list === before ? "before" : "after"] === outcome).length;
    console.log(`\nApply Now candidates (gate PASS, PRIORITY/REVIEW): before ${before.length} (PRIORITY ${count(before, "PRIORITY")}), after ${after.length} (PRIORITY ${count(after, "PRIORITY")}).`);
    const transitions: Record<string, number> = {};
    for (const row of plan) transitions[`${row.before} -> ${row.after}`] = (transitions[`${row.before} -> ${row.after}`] ?? 0) + 1;
    console.log("Outcome transitions across all PRIORITY/REVIEW/TRACK jobs:", transitions);

    console.log("\nCurrent Apply Now jobs, before -> after:");
    for (const row of before) {
      const why = row.territory !== "PASS" ? row.territory_reason : row.after !== row.before ? row.career_track.rationale : "";
      console.log(`- ${row.before} -> ${row.after} | ${row.company_name} | ${row.title} | ${describeTrack(row)}${why ? ` | ${why}` : ""}`);
    }
    const handsOnMid = plan.filter((row) => row.career_track.track === "HANDS_ON_AI_DATA" && row.career_track.level === "MID");
    console.log(`\nHands-on AI/ML/data mid-level roles: ${handsOnMid.length}; kept or unchanged ${handsOnMid.filter((row) => row.after === row.before).length}; changed ${handsOnMid.filter((row) => row.after !== row.before).length}.`);
    for (const row of handsOnMid.filter((item) => item.after !== item.before)) {
      console.log(`  - ${row.before} -> ${row.after} | ${row.company_name} | ${row.title} | ${row.territory_reason ?? row.career_track.rationale}`);
    }
    if (options.jsonOut) fs.writeFileSync(options.jsonOut, JSON.stringify(plan, null, 2));

    if (!options.apply) {
      await client.query("ROLLBACK");
      console.log("\nDry run only; nothing was written. Re-run with --apply to re-gate and re-decide.");
      return;
    }

    const regate = plan.filter((row) => row.territory !== "PASS").map((row) => row.canonical_job_id);
    console.log(`\nRe-gating ${regate.length} job(s) whose remote hiring territory changed...`);
    if (regate.length > 0) await runHardGates(client, { context: ctx, canonicalJobIds: regate, reprocess: true });
    const redecide = plan.filter((row) => row.territory === "PASS").map((row) => row.canonical_job_id);
    console.log(`Re-deciding ${redecide.length} gate-passed job(s) with track-aware seniority...`);
    if (redecide.length > 0) {
      const summary = await runRecommendationDecider(client, { context: ctx, canonicalJobIds: redecide });
      if (summary.errors > 0) throw new Error(`Recommendation decider reported ${summary.errors} error(s).`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes("replay_track_seniority")) {
  main().catch((error) => {
    console.error("Replay failed:", error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "<redacted>") : error);
    process.exit(1);
  });
}
