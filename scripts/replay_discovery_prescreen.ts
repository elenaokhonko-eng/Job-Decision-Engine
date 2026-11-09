/**
 * Read-only replay of the discovery pre-screen (DISCOVERY_PRESCREEN_ENABLED) over recent jobs.
 *
 *   npx tsx scripts/replay_discovery_prescreen.ts [--days 30] [--json <out file>]
 *
 * Everything runs inside one READ ONLY transaction that is rolled back; nothing is written.
 * For every canonical job first seen in the window it takes the job's first adapter observation,
 * reconstructs the lanes and board the runner assessed it for (from that observation's
 * source_candidate_dispositions) and asks, rule by rule, whether the pre-screen would have kept
 * it from being staged:
 *
 *   EXISTING_LOCATION_SCOPE  already active (free-text location scope); reported for context only
 *   PRESCREEN_TITLE_DENY     Tier 0 title deny-list
 *   GEO_FIELD_OUT_OF_SCOPE   structured region/country field
 *   LANE_EXCLUDED_DOMAIN     Tier 1 lane negative terms (every candidate lane excluded or missed)
 *   PRESCREEN_ROLE_OUTSIDE_LEAD  Tier 1 role term not in the title / description opening
 *                            (title only for Jobicy)
 *
 * It also replays the new NON_TECHNICAL_FUNCTION title patterns of the hard gate (active on
 * merge, every source including Gmail) against jobs that were not hard-rejected.
 *
 * "Damage" is every job that would be dropped although it passed the gates (PASS or
 * NEEDS_VERIFICATION), was AI-evaluated, has a PRIORITY/REVIEW outcome or a user action.
 * Output contains counts and, for damaged jobs only, the public posting title/company/source.
 */
import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";

import { pgPoolConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import { assessCandidateLanes, type LanePrescreenOptions } from "../src/ingestion/discoveryPlanExecution.js";
import {
  assessLocationScope,
  assessStructuredGeoScope,
  loadDiscoveryLocationScope,
  locationScopeAppliesTo,
  structuredGeoFromPayload,
  type DiscoveryLocationScope,
} from "../src/ingestion/discoveryLocationScope.js";
import { matchTitleDenyList, PRESCREEN_TIER1_DEFAULTS, PRESCREEN_TITLE_ROLE_SOURCES } from "../src/ingestion/discoveryPrescreen.js";
import type { SourcePlugin } from "../src/contracts/index.js";
import { configuredCompanyLanes, configuredFeedLanes, loadCompaniesConfig, loadSourcePluginsFromDisk } from "./run_adapters.js";
import { DiscoveryScoutPlanner, type ScoutSearchPlan } from "../src/ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig, type GlobalLanesConfig } from "../src/pipeline/laneConfigLoader.js";
import { nonTechnicalFunctionTitle } from "../src/services/criteria.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

export interface ReplayJobRow {
  readonly canonical_job_id: string;
  readonly title: string | null;
  readonly company_name: string | null;
  readonly source_name: string | null;
  readonly source_plugin_key: string | null;
  readonly description_raw: string | null;
  readonly location_raw: string | null;
  readonly workplace_type_raw: string | null;
  readonly raw_payload: unknown;
  readonly lane_keys: readonly string[] | null;
  readonly board: string | null;
  readonly gate_decision: string | null;
  readonly rejection_codes: readonly string[] | null;
  readonly evaluated: boolean;
  readonly outcome: string | null;
  readonly user_marked: boolean;
}

export type ReplayRule =
  | "EXISTING_LOCATION_SCOPE"
  | "PRESCREEN_TITLE_DENY"
  | "GEO_FIELD_OUT_OF_SCOPE"
  | "LANE_EXCLUDED_DOMAIN"
  | "PRESCREEN_ROLE_OUTSIDE_LEAD"
  | "JOBICY_TITLE_ROLE"
  | "BASELINE_LANE_MISS";

export interface ReplayVerdict {
  /** First rule that keeps the job from being staged, or null when it would still be staged. */
  readonly rule: ReplayRule | null;
  readonly detail: string | null;
  /** The new hard-gate title pattern would reject it (any source). */
  readonly gateTitle: string | null;
}

export interface ReplayContext {
  readonly plans: Readonly<Record<string, ScoutSearchPlan>>;
  readonly lanes: GlobalLanesConfig["lanes"];
  readonly locationScope: DiscoveryLocationScope | null;
  /** Tier 1 variant under test (roleInTitleOnly is set per source). */
  readonly tier1: Omit<LanePrescreenOptions, "roleInTitleOnly">;
}

/** Adapter plugin keys go through run_adapters; Gmail, saved exports and manual intake do not. */
function isAdapterSource(row: ReplayJobRow): boolean {
  return Boolean(row.source_plugin_key && row.lane_keys && row.lane_keys.length > 0);
}

export function replayJob(row: ReplayJobRow, context: ReplayContext): ReplayVerdict {
  const gateTitle = nonTechnicalFunctionTitle(row.title ?? "");
  if (!isAdapterSource(row)) return { rule: null, detail: null, gateTitle };
  const sourceKey = row.source_plugin_key ?? "";
  const job = {
    company_name: row.company_name ?? "",
    title: row.title ?? "",
    description_raw: row.description_raw ?? "",
    location_raw: row.location_raw ?? "",
    workplace_type_raw: row.workplace_type_raw ?? "",
  };
  const laneKeys = [...(row.lane_keys ?? [])];
  const employerLaneKeys = row.board?.startsWith("ats:") ? laneKeys : [];
  const scope = locationScopeAppliesTo(context.locationScope, sourceKey) ? context.locationScope : null;

  // Today's behaviour, so a drop is attributed to a new rule only when today would stage it.
  if (scope) {
    const existing = assessLocationScope(job, scope);
    if (!existing.inScope) {
      const geoKeeps = assessStructuredGeoScope(job, structuredGeoFromPayload(sourceKey, row.raw_payload), scope);
      if (!geoKeeps?.inScope) return { rule: "EXISTING_LOCATION_SCOPE", detail: existing.reasonCode, gateTitle };
    }
  }
  const baseline = assessCandidateLanes(job, laneKeys, context.plans, context.lanes, employerLaneKeys);
  if (!baseline.some((lane) => lane.matched)) return { rule: "BASELINE_LANE_MISS", detail: null, gateTitle };

  const deny = matchTitleDenyList(job.title);
  if (deny) return { rule: "PRESCREEN_TITLE_DENY", detail: deny.term, gateTitle };
  if (scope) {
    const geo = assessStructuredGeoScope(job, structuredGeoFromPayload(sourceKey, row.raw_payload), scope);
    if (geo && !geo.inScope) return { rule: "GEO_FIELD_OUT_OF_SCOPE", detail: geo.reason, gateTitle };
  }
  const titleOnly = PRESCREEN_TITLE_ROLE_SOURCES.has(sourceKey);
  const tier1 = assessCandidateLanes(job, laneKeys, context.plans, context.lanes, employerLaneKeys, {
    ...context.tier1,
    roleInTitleOnly: titleOnly,
  });
  if (tier1.some((lane) => lane.matched)) return { rule: null, detail: null, gateTitle };
  const excluded = tier1.find((lane) => lane.reasonCode === "LANE_EXCLUDED_DOMAIN");
  if (excluded) return { rule: "LANE_EXCLUDED_DOMAIN", detail: excluded.reason, gateTitle };
  const lead = tier1.find((lane) => lane.reasonCode === "PRESCREEN_ROLE_OUTSIDE_LEAD");
  return {
    rule: titleOnly ? "JOBICY_TITLE_ROLE" : "PRESCREEN_ROLE_OUTSIDE_LEAD",
    detail: lead?.reason ?? tier1.map((lane) => lane.reasonCode).join(","),
    gateTitle,
  };
}

const ROLE_CODES = new Set(["NON_TECHNICAL_FUNCTION", "NON_TARGET_ROLE_FAMILY", "GATE_NOT_AI_DATA"]);

/** The headline rejection reason of a job's latest gate decision. */
export function rejectionBucket(row: Pick<ReplayJobRow, "gate_decision" | "rejection_codes">): string {
  if (row.gate_decision !== "HARD_REJECT") return row.gate_decision ?? "NO_GATE";
  const codes = row.rejection_codes ?? [];
  if (codes.includes("WORK_AUTHORIZATION_INCOMPATIBLE")) return "WORK_AUTHORIZATION_INCOMPATIBLE";
  if (codes.some((code) => ROLE_CODES.has(code))) return "ROLE_CODES";
  if (codes.includes("GATE_OUT_OF_SCOPE_DOMAIN")) return "GATE_OUT_OF_SCOPE_DOMAIN";
  return codes[0] ?? "HARD_REJECT_UNCODED";
}

export function isProtected(row: ReplayJobRow): boolean {
  return row.gate_decision !== "HARD_REJECT"
    || row.evaluated
    || row.outcome === "PRIORITY"
    || row.outcome === "REVIEW"
    || row.user_marked;
}

const JOBS_SQL = `
  WITH window_jobs AS (
    SELECT c.id, c.recommendation_outcome
    FROM canonical_jobs c
    WHERE c.workspace_id = $1
      AND c.is_test_fixture = FALSE
      AND c.created_at >= NOW() - make_interval(days => $2::int)
  ),
  first_obs AS (
    SELECT DISTINCT ON (v.canonical_job_id)
      v.canonical_job_id, o.id AS observation_id, o.title, o.company_name, o.source_name,
      o.source_plugin_key, o.description_raw, o.location_raw, o.workplace_type_raw, o.raw_payload
    FROM window_jobs w
    JOIN job_versions v ON v.workspace_id = $1 AND v.canonical_job_id = w.id
    JOIN raw_job_observations o ON o.workspace_id = $1 AND o.job_version_id = v.id
    -- Prefer an adapter observation (it has a disposition), then the earliest.
    ORDER BY v.canonical_job_id,
      (EXISTS (SELECT 1 FROM source_candidate_dispositions d WHERE d.workspace_id = $1 AND d.job_observation_id = o.id)) DESC,
      o.retrieved_at ASC, o.id ASC
  ),
  lanes AS (
    SELECT f.observation_id,
           array_agg(DISTINCT peer.lane_key) FILTER (WHERE peer.lane_key IS NOT NULL) AS lane_keys,
           min(regexp_replace(staged.plan_key, ':[A-Z][A-Z0-9_]*$', '')) AS board
    FROM first_obs f
    JOIN source_candidate_dispositions staged
      ON staged.workspace_id = $1 AND staged.job_observation_id = f.observation_id
    JOIN source_candidate_dispositions peer
      ON peer.workspace_id = $1
     AND peer.source_run_id = staged.source_run_id
     AND peer.source_plugin_key = staged.source_plugin_key
     AND peer.raw_payload_hash = staged.raw_payload_hash
    GROUP BY f.observation_id
  ),
  latest_gate AS (
    SELECT DISTINCT ON (g.canonical_job_id) g.canonical_job_id, g.decision, g.rejection_codes
    FROM gate_decisions g
    JOIN window_jobs w ON w.id = g.canonical_job_id
    WHERE g.workspace_id = $1
    ORDER BY g.canonical_job_id, g.created_at DESC, g.id DESC
  )
  SELECT f.canonical_job_id, f.title, f.company_name, f.source_name, f.source_plugin_key,
         f.description_raw, f.location_raw, f.workplace_type_raw, f.raw_payload,
         l.lane_keys, l.board,
         g.decision AS gate_decision,
         CASE WHEN jsonb_typeof(g.rejection_codes) = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(g.rejection_codes)) ELSE NULL END AS rejection_codes,
         EXISTS (SELECT 1 FROM ai_evaluations e WHERE e.workspace_id = $1 AND e.canonical_job_id = f.canonical_job_id) AS evaluated,
         w.recommendation_outcome AS outcome,
         EXISTS (SELECT 1 FROM v_current_user_actions a WHERE a.workspace_id = $1 AND a.canonical_job_id = f.canonical_job_id) AS user_marked
  FROM first_obs f
  JOIN window_jobs w ON w.id = f.canonical_job_id
  LEFT JOIN lanes l ON l.observation_id = f.observation_id
  LEFT JOIN latest_gate g ON g.canonical_job_id = f.canonical_job_id
`;

const STORAGE_SQL = `
  WITH filtered AS (
    SELECT source_run_id, source_plugin_key, raw_payload_hash, fetched_at,
           pg_column_size(raw_payload) AS payload_bytes
    FROM source_candidate_dispositions
    WHERE workspace_id = $1 AND disposition = 'FILTERED' AND raw_payload IS NOT NULL
  ),
  per_posting AS (
    SELECT source_run_id, source_plugin_key, raw_payload_hash,
           max(payload_bytes) AS payload_bytes, min(fetched_at) AS fetched_at, count(*) AS lane_rows
    FROM filtered
    GROUP BY 1, 2, 3
  )
  SELECT
    (SELECT pg_total_relation_size('source_candidate_dispositions'))::bigint AS table_bytes,
    (SELECT pg_database_size(current_database()))::bigint AS database_bytes,
    (SELECT count(*) FROM source_candidate_dispositions WHERE workspace_id = $1)::int AS all_rows,
    (SELECT count(*) FROM filtered)::int AS filtered_rows,
    (SELECT count(*) FROM per_posting)::int AS filtered_postings_per_run,
    (SELECT count(DISTINCT (source_plugin_key, raw_payload_hash)) FROM filtered)::int AS filtered_unique_payloads,
    (SELECT COALESCE(sum(payload_bytes), 0) FROM filtered)::bigint AS filtered_payload_bytes,
    (SELECT COALESCE(sum(payload_bytes), 0) FROM per_posting)::bigint AS dedupe_payload_bytes,
    (SELECT COALESCE(sum(payload_bytes), 0) FROM per_posting WHERE fetched_at >= NOW() - INTERVAL '30 days')::bigint AS dedupe_retained_30d_bytes,
    (SELECT COALESCE(sum(payload_bytes), 0) FROM filtered WHERE fetched_at < NOW() - INTERVAL '30 days')::bigint AS older_than_30d_bytes,
    (SELECT count(*) FROM filtered WHERE fetched_at < NOW() - INTERVAL '30 days')::int AS older_than_30d_rows
`;

interface Options {
  readonly days: number;
  readonly jsonPath: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const days = Number.parseInt(value("--days") ?? "30", 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be a whole number between 1 and 365.");
  return { days, jsonPath: value("--json") ?? null };
}

function increment(map: Record<string, Record<string, number>>, outer: string, inner: string): void {
  map[outer] ??= {};
  map[outer][inner] = (map[outer][inner] ?? 0) + 1;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type CompanyEntry = ReturnType<typeof loadCompaniesConfig>[number];

function nameKey(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Observations staged before per-lane dispositions were recorded have no lane context; use the
 * lanes the runner assigns today: the feed's configured lanes, or the ATS company's target lanes
 * (matched on provider and employer name). Unmatched rows stay without lanes and are not replayed.
 */
export function withConfiguredLanes(
  row: ReplayJobRow,
  plugins: readonly SourcePlugin[],
  companies: readonly CompanyEntry[],
  plans: Readonly<Record<string, ScoutSearchPlan>>,
  lanes: GlobalLanesConfig["lanes"],
): ReplayJobRow {
  if (row.lane_keys && row.lane_keys.length > 0) return row;
  const sourceKey = row.source_plugin_key ?? "";
  const plugin = plugins.find((candidate) => candidate.source_key === sourceKey);
  if (!plugin) return row;
  if (plugin.kind === "ats") {
    const company = companies.find((candidate) => candidate.enabled !== false
      && candidate.ats_provider?.trim().toLowerCase() === sourceKey
      && nameKey(candidate.name) === nameKey(row.company_name));
    if (!company) return row;
    const laneKeys = configuredCompanyLanes(company, plans);
    return laneKeys.length > 0 ? { ...row, lane_keys: laneKeys, board: `ats:${company.id ?? company.board_slug ?? ""}` } : row;
  }
  const laneKeys = configuredFeedLanes(plugin, plans, lanes);
  return laneKeys.length > 0 ? { ...row, lane_keys: laneKeys, board: `feed:${sourceKey}` } : row;
}

const NEW_RULES = [
  "PRESCREEN_TITLE_DENY",
  "GEO_FIELD_OUT_OF_SCOPE",
  "LANE_EXCLUDED_DOMAIN",
  "PRESCREEN_ROLE_OUTSIDE_LEAD",
  "JOBICY_TITLE_ROLE",
] as const;

/** Counts and damage for one Tier 1 variant. Pure: no database access. */
export function summarizeReplay(rows: readonly ReplayJobRow[], context: ReplayContext): Record<string, unknown> {
  const byRuleAndReason: Record<string, Record<string, number>> = {};
  const titleDenyTerms: Record<string, number> = {};
  const damage: Array<Record<string, string | boolean | null>> = [];
  const gateNewRejects: Array<Record<string, string | boolean | null>> = [];
  let hardRejected = 0;
  let adapterJobs = 0;
  let newlyFilteredPayloadBytes = 0;
  for (const row of rows) {
    if (row.gate_decision === "HARD_REJECT") hardRejected += 1;
    if (isAdapterSource(row)) adapterJobs += 1;
    const verdict = replayJob(row, context);
    const bucket = rejectionBucket(row);
    if (verdict.rule) increment(byRuleAndReason, verdict.rule, bucket);
    if (verdict.rule === "PRESCREEN_TITLE_DENY" && verdict.detail) titleDenyTerms[verdict.detail] = (titleDenyTerms[verdict.detail] ?? 0) + 1;
    const newRule = verdict.rule !== null && (NEW_RULES as readonly string[]).includes(verdict.rule);
    if (newRule) newlyFilteredPayloadBytes += Buffer.byteLength(JSON.stringify(row.raw_payload ?? null));
    if (newRule && isProtected(row)) {
      damage.push({
        title: row.title, company: row.company_name, source: row.source_name, board: row.board,
        rule: verdict.rule, detail: verdict.detail, gate: row.gate_decision, evaluated: row.evaluated,
        outcome: row.outcome, user_marked: row.user_marked,
      });
    }
    if (verdict.gateTitle && row.gate_decision !== "HARD_REJECT") {
      gateNewRejects.push({
        title: row.title, company: row.company_name, source: row.source_name, matched: verdict.gateTitle,
        gate: row.gate_decision, evaluated: row.evaluated, outcome: row.outcome, user_marked: row.user_marked,
      });
    }
  }
  const savedHardRejects = (rule: string): number => Object.entries(byRuleAndReason[rule] ?? {})
    .filter(([bucket]) => !["PASS", "NEEDS_VERIFICATION", "NO_GATE"].includes(bucket))
    .reduce((total, [, count]) => total + count, 0);
  return {
    baseline: {
      staged_jobs: rows.length,
      hard_rejected: hardRejected,
      adapter_sourced_replayed: adapterJobs,
      work_authorization_incompatible: rows.filter((row) => rejectionBucket(row) === "WORK_AUTHORIZATION_INCOMPATIBLE").length,
    },
    by_rule_and_original_reason: byRuleAndReason,
    saving_hard_rejects_by_new_rule: Object.fromEntries(NEW_RULES.map((rule) => [rule, savedHardRejects(rule)])),
    saving_hard_rejects_total_new_rules: NEW_RULES.reduce((total, rule) => total + savedHardRejects(rule), 0),
    work_authorization_caught: {
      existing_location_scope_already_active: byRuleAndReason.EXISTING_LOCATION_SCOPE?.WORK_AUTHORIZATION_INCOMPATIBLE ?? 0,
      geo_field_skip_new: byRuleAndReason.GEO_FIELD_OUT_OF_SCOPE?.WORK_AUTHORIZATION_INCOMPATIBLE ?? 0,
      any_new_rule: NEW_RULES.reduce((total, rule) => total + (byRuleAndReason[rule]?.WORK_AUTHORIZATION_INCOMPATIBLE ?? 0), 0),
    },
    title_deny_terms: titleDenyTerms,
    damage_count: damage.length,
    damage_by_category: {
      gate_pass: damage.filter((row) => row.gate === "PASS").length,
      gate_needs_verification: damage.filter((row) => row.gate === "NEEDS_VERIFICATION").length,
      no_gate_yet: damage.filter((row) => row.gate === null).length,
      ai_evaluated: damage.filter((row) => row.evaluated === true).length,
      ai_evaluated_now_hard_rejected: damage.filter((row) => row.evaluated === true && row.gate === "HARD_REJECT").length,
      priority_or_review: damage.filter((row) => row.outcome === "PRIORITY" || row.outcome === "REVIEW").length,
      user_marked: damage.filter((row) => row.user_marked === true).length,
    },
    damage,
    gate_title_patterns_new_rejects: gateNewRejects,
    added_filtered_payload_once_per_posting: mb(newlyFilteredPayloadBytes),
  };
}

export async function replayDiscoveryPrescreen(options: Options): Promise<Record<string, unknown>> {
  const databaseUrl = String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const workspace = await resolveWorkspaceContext(client);
    const { rows } = await client.query<ReplayJobRow>(JOBS_SQL, [workspace.workspaceId, options.days]);
    const storage = (await client.query<Record<string, string>>(STORAGE_SQL, [workspace.workspaceId])).rows[0];
    await client.query("ROLLBACK");

    const plans = new DiscoveryScoutPlanner().generateSearchPlans();
    const lanes = loadGlobalLanesConfig().lanes;
    const locationScope = loadDiscoveryLocationScope();
    const plugins = await loadSourcePluginsFromDisk();
    const companies = loadCompaniesConfig();
    const withLanes = rows.map((row) => withConfiguredLanes(row, plugins, companies, plans, lanes));

    const variants: Record<string, ReplayContext["tier1"]> = {
      // As specified: lane role term in title / first 300 chars, negatives over title + description.
      spec: { negativeScope: "TITLE_AND_DESCRIPTION", technicalRoleWords: false },
      // Negatives over title + first 300 chars, technical-role words also count in the lead.
      lead_negatives: { negativeScope: "TITLE_AND_LEAD", technicalRoleWords: true },
      // Shipped default: negatives over the title only, technical-role words also count in the lead.
      shipped: { ...PRESCREEN_TIER1_DEFAULTS },
    };
    const summaries = Object.fromEntries(Object.entries(variants).map(([name, tier1]) => [
      name,
      summarizeReplay(withLanes, { plans, lanes, locationScope, tier1 }),
    ]));
    const num = (key: string) => Number(storage[key] ?? 0);
    const report = {
      window_days: options.days,
      writes: "none (READ ONLY transaction, rolled back)",
      variants: summaries,
      storage: {
        table: mb(num("table_bytes")),
        database: mb(num("database_bytes")),
        all_disposition_rows: num("all_rows"),
        filtered_rows: num("filtered_rows"),
        filtered_postings_per_run: num("filtered_postings_per_run"),
        filtered_unique_payloads: num("filtered_unique_payloads"),
        filtered_payload_now: mb(num("filtered_payload_bytes")),
        filtered_payload_once_per_posting: mb(num("dedupe_payload_bytes")),
        filtered_payload_once_per_posting_after_30d_retention: mb(num("dedupe_retained_30d_bytes")),
        released_by_retention_today: `${num("older_than_30d_rows")} rows, ${mb(num("older_than_30d_bytes"))}`,
      },
    };

    const text = JSON.stringify(report, null, 2);
    console.log(text);
    if (options.jsonPath) fs.writeFileSync(options.jsonPath, `${text}\n`, "utf8");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("replay_discovery_prescreen")) {
  replayDiscoveryPrescreen(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error("Discovery pre-screen replay failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
