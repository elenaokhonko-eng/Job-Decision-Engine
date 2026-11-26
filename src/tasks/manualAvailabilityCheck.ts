/**
 * Same-day availability check of a chosen list of jobs (scripts/check_availability_now.ts).
 *
 * Each posting link is read once, serially, with a pause between reads of one site. What a read means and how
 * it is stored is the existing re-check (runAvailabilityRecheck, manual mode): this module only chooses which
 * links may be read, paces them and reports. A job never checked before is included. It writes nothing itself.
 * Plan mode runs in a READ ONLY transaction and has no code path to a posting reader. Replay copies only.
 */
import fs from "node:fs";

import pg from "pg";

import { pgConnectionConfig } from "../db/pgSsl.js";
import { blockedLinkReason, loadJobBoardHosts, type BlockedLinkReason } from "../ingestion/availabilityCheckLinks.js";
import { fetchJobContent, postingRequestUrl, type PostingFetcherDependencies } from "../ingestion/jobContentFetcher.js";
import { requireApprovedReplayTarget } from "../reporting/replayGuard.js";
import { publicErrorSummary } from "../security/publicErrorSummary.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import {
  defaultAvailabilityRecheckDependencies,
  findRecheckCandidate,
  HostThrottle,
  runAvailabilityRecheck,
  type RecheckCandidate,
} from "./availabilityRecheck.js";

/** The day a check counts for: the review draw reads availability on the Singapore date. */
export const CHECK_TIME_ZONE = "Asia/Singapore";
export const DEFAULT_SITE_INTERVAL_SECONDS = 5;
const MIN_SITE_INTERVAL_SECONDS = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CHECK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export type ExclusionReason =
  | Exclude<RecheckCandidate["skip"], null>
  | BlockedLinkReason
  | "NOT_A_JOB_ID"
  | "LISTED_TWICE"
  | "NO_POSTING_LINK"
  | "UNREADABLE_LINK"
  | "SAME_LINK_AS_ANOTHER_JOB"
  | "ALREADY_CONFIRMED_OPEN_TODAY"
  | "ALREADY_CHECKED_TODAY";

export interface PlannedRead {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  /** Host the first request goes to. */
  readonly site: string;
  readonly intervalMs: number;
}

export interface AvailabilityCheckPlan {
  readonly listed: number;
  readonly reads: readonly PlannedRead[];
  readonly excluded: ReadonlyArray<{ readonly id: string; readonly reason: ExclusionReason }>;
}

type Queryable = Pick<pg.PoolClient, "query">;

export interface PlanOptions {
  readonly now: Date;
  readonly intervalSeconds?: number;
  readonly requestsPerMinute?: (sourcePluginKey: string | null) => Promise<number | null>;
  readonly jobBoardHosts?: readonly string[];
}

/** Read only: no request is made and nothing is written. */
export async function planAvailabilityCheck(
  client: Queryable,
  context: WorkspaceContext,
  jobIds: readonly string[],
  options: PlanOptions,
): Promise<AvailabilityCheckPlan> {
  const minMs = Math.max(MIN_SITE_INTERVAL_SECONDS, options.intervalSeconds ?? DEFAULT_SITE_INTERVAL_SECONDS) * 1000;
  const requestsPerMinute = options.requestsPerMinute ?? defaultAvailabilityRecheckDependencies().requestsPerMinute;
  const jobBoardHosts = options.jobBoardHosts ?? await loadJobBoardHosts();
  const reads: PlannedRead[] = [];
  const excluded: Array<{ id: string; reason: ExclusionReason }> = [];
  const seenIds = new Set<string>();
  const seenLinks = new Set<string>();

  for (const listed of jobIds) {
    const id = listed.trim().toLowerCase();
    const leaveOut = (reason: ExclusionReason) => excluded.push({ id, reason });
    if (!UUID_PATTERN.test(id)) { leaveOut("NOT_A_JOB_ID"); continue; }
    if (seenIds.has(id)) { leaveOut("LISTED_TWICE"); continue; }
    seenIds.add(id);
    const candidate = await findRecheckCandidate(client, context.workspaceId, id);
    if (candidate.skip !== null) { leaveOut(candidate.skip); continue; }
    if (!candidate.link?.trim()) { leaveOut("NO_POSTING_LINK"); continue; }
    const blocked = blockedLinkReason(candidate.link, jobBoardHosts);
    if (blocked !== null) { leaveOut(blocked); continue; }
    let requestUrl: URL;
    let linkKey: string;
    try {
      requestUrl = postingRequestUrl(candidate.link);
      const link = new URL(candidate.link);
      link.hash = "";
      linkKey = link.toString();
    } catch {
      leaveOut("UNREADABLE_LINK");
      continue;
    }
    const { rows } = await client.query<{ open_now: boolean; verified_at: Date | null; checked: boolean }>(
      `SELECT COALESCE(availability.availability_current, FALSE) AS open_now,
              availability.availability_verified_at AS verified_at,
              EXISTS (SELECT 1 FROM job_availability_recheck_events event
                       WHERE event.workspace_id = $1::uuid AND event.canonical_job_id = $2::uuid
                         AND event.job_version_id = $3::uuid AND event.details->>'trigger' = 'MANUAL'
                         AND (event.occurred_at AT TIME ZONE $5)::date = ($4::timestamptz AT TIME ZONE $5)::date) AS checked
         FROM (SELECT 1) AS one
         LEFT JOIN v_job_availability_current availability
           ON availability.workspace_id = $1::uuid AND availability.canonical_job_id = $2::uuid
          AND availability.job_version_id::text = $3::text`,
      [context.workspaceId, id, candidate.jobVersionId, options.now, CHECK_TIME_ZONE],
    );
    const state = rows[0];
    if (state?.open_now && state.verified_at && checkDate(state.verified_at) === checkDate(options.now)) {
      leaveOut("ALREADY_CONFIRMED_OPEN_TODAY");
      continue;
    }
    if (state?.checked) { leaveOut("ALREADY_CHECKED_TODAY"); continue; }
    if (seenLinks.has(linkKey)) { leaveOut("SAME_LINK_AS_ANOTHER_JOB"); continue; }
    seenLinks.add(linkKey);
    const rpm = await requestsPerMinute(candidate.sourcePluginKey);
    reads.push({
      canonicalJobId: id,
      jobVersionId: candidate.jobVersionId,
      site: requestUrl.hostname.toLowerCase(),
      intervalMs: Math.max(minMs, rpm ? Math.ceil(60_000 / rpm) : 0),
    });
  }
  // One site at a time: all reads of a site follow each other.
  reads.sort((a, b) => a.site.localeCompare(b.site));
  return { listed: jobIds.length, reads, excluded };
}

export function formatPlan(plan: AvailabilityCheckPlan): string {
  const sites = new Map<string, { requests: number; intervalMs: number }>();
  for (const read of plan.reads) {
    const site = sites.get(read.site) ?? { requests: 0, intervalMs: 0 };
    sites.set(read.site, { requests: site.requests + 1, intervalMs: Math.max(site.intervalMs, read.intervalMs) });
  }
  const reasons = new Map<ExclusionReason, string[]>();
  for (const { id, reason } of plan.excluded) reasons.set(reason, [...(reasons.get(reason) ?? []), id]);
  const seconds = Math.ceil([...sites.values()].reduce((total, s) => total + (s.requests - 1) * s.intervalMs, 0) / 1000);
  return [
    `jobs listed: ${plan.listed}`,
    `posting links to read: ${plan.reads.length} (one request each, plus any redirects, at most 5 per link; Ashby postings of one board can share a request)`,
    `sites: ${sites.size}, one at a time, serial; pauses add at least ${seconds}s`,
    ...[...sites].map(([host, s]) => `  ${host}: ${s.requests} request(s), at most 1 every ${s.intervalMs / 1000}s`),
    `excluded: ${plan.excluded.length}`,
    ...[...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([reason, ids]) => `  ${reason}: ${ids.length} [${ids.join(" ")}]`),
  ].join("\n");
}

export interface CheckedJob {
  readonly canonicalJobId: string;
  /** OPEN, CLOSED or CANNOT_TELL as read; SKIPPED when the job changed since the plan; ERROR when it failed. */
  readonly result: "OPEN" | "CLOSED" | "CANNOT_TELL" | "SKIPPED" | "ERROR";
  readonly detail: string;
  /** OPEN and CLOSED only: the read model shows the stored verdict (for OPEN: current, verified today). */
  readonly visible: boolean | null;
}

export interface ApplyOptions {
  readonly fetcher?: PostingFetcherDependencies;
  readonly now?: () => Date;
  readonly throttle?: HostThrottle;
  readonly jobBoardHosts?: readonly string[];
  readonly log?: (line: string) => void;
}

async function verdictVisible(client: Queryable, workspaceId: string, jobId: string, open: boolean, now: Date): Promise<boolean> {
  const { rows } = await client.query<{ state: string; open_now: boolean; verified_at: Date | null }>(
    `SELECT availability_state AS state, availability_current AS open_now, availability_verified_at AS verified_at
       FROM v_job_availability_current WHERE workspace_id = $1::uuid AND canonical_job_id = $2::uuid`,
    [workspaceId, jobId],
  );
  const row = rows[0];
  if (!row) return false;
  if (!open) return row.state === "CLOSED";
  return row.open_now && row.verified_at !== null && checkDate(row.verified_at) === checkDate(now);
}

/** Reads each planned link once. `client` must not be inside a transaction. */
export async function applyAvailabilityCheck(
  client: pg.PoolClient,
  context: WorkspaceContext,
  plan: AvailabilityCheckPlan,
  options: ApplyOptions = {},
): Promise<CheckedJob[]> {
  const now = options.now ?? (() => new Date());
  const throttle = options.throttle ?? new HostThrottle();
  const jobBoardHosts = options.jobBoardHosts ?? await loadJobBoardHosts();
  const fetcher: PostingFetcherDependencies = {
    ...options.fetcher,
    refuseRequest: (url) => blockedLinkReason(url.toString(), jobBoardHosts) !== null,
  };
  const results: CheckedJob[] = [];
  for (const read of plan.reads) {
    await throttle.acquire(read.site, read.intervalMs);
    let checked: CheckedJob;
    try {
      const startedAt = now();
      const outcome = await runAvailabilityRecheck(
        client,
        context,
        { canonical_job_id: read.canonicalJobId, job_version_id: read.jobVersionId, cycle_started_at: startedAt.toISOString() },
        null,
        {
          ...defaultAvailabilityRecheckDependencies(),
          fetchJobContent,
          pageFetcherDependencies: fetcher,
          // Paced above, by the host that is actually requested.
          throttle: new HostThrottle(() => 0, async () => undefined),
          requestsPerMinute: async () => null,
          createFeedAdapter: () => null,
          now: () => startedAt,
        },
        { manual: true },
      );
      if (outcome.status === "SKIPPED") {
        checked = { canonicalJobId: read.canonicalJobId, result: "SKIPPED", detail: outcome.reason, visible: null };
      } else {
        const result = outcome.outcome === "OPEN" ? "OPEN" : outcome.outcome === "CLOSED_BY_PAGE" ? "CLOSED" : "CANNOT_TELL";
        checked = {
          canonicalJobId: read.canonicalJobId,
          result,
          detail: outcome.reasonCode,
          visible: result === "CANNOT_TELL" ? null : await verdictVisible(client, context.workspaceId, read.canonicalJobId, result === "OPEN", startedAt),
        };
      }
    } catch (error) {
      checked = { canonicalJobId: read.canonicalJobId, result: "ERROR", detail: publicErrorSummary(error, "pipeline"), visible: null };
    }
    options.log?.(`${checked.canonicalJobId} ${read.site} ${checked.result} ${checked.detail}${checked.visible === false ? " NOT_VISIBLE_IN_READ_MODEL" : ""}`);
    results.push(checked);
  }
  return results;
}

/** Non-zero when a job failed, a stored verdict is not visible, or not one of several reads could tell. */
export function availabilityCheckExitCode(results: readonly CheckedJob[]): 0 | 1 {
  const failed = results.some((r) => r.result === "ERROR" || r.visible === false);
  const nothingRead = results.length > 1 && results.every((r) => r.result === "CANNOT_TELL");
  return failed || nothingRead ? 1 : 0;
}

export interface CheckArguments {
  readonly jobIds: readonly string[];
  readonly apply: boolean;
  readonly confirmWorkspace: string | null;
  readonly intervalSeconds: number;
}

/** A mistake in how the command was called, or a refusal: safe to print as it is. */
export class AvailabilityCheckRefusal extends Error {}

/** `--jobs=<file>` (one job id per line, or a JSON array of ids) or `--job-ids=<id,id>`. */
export function parseCheckArguments(argv: readonly string[], readFile = (file: string) => fs.readFileSync(file, "utf8")): CheckArguments {
  const values = new Map<string, string>();
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") { apply = true; continue; }
    const match = /^--(jobs|job-ids|confirm-workspace|min-interval-seconds)=(.+)$/.exec(arg);
    if (!match) throw new AvailabilityCheckRefusal(`Unknown argument: ${arg}`);
    values.set(match[1]!, match[2]!.trim());
  }
  const file = values.get("jobs");
  const inline = values.get("job-ids");
  if ((file === undefined) === (inline === undefined)) {
    throw new AvailabilityCheckRefusal("Give the chosen jobs as --jobs=<file> or --job-ids=<id,id> (exactly one).");
  }
  let jobIds: string[];
  if (inline !== undefined) {
    jobIds = inline.split(",");
  } else {
    const text = readFile(file!).replace(/^\uFEFF/, "").trim();
    if (text.startsWith("[")) {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new AvailabilityCheckRefusal("The jobs file must be a JSON array of job ids.");
      }
      jobIds = parsed as string[];
    } else {
      jobIds = text.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#"));
    }
  }
  jobIds = jobIds.map((id) => id.trim()).filter((id) => id !== "");
  if (jobIds.length === 0) throw new AvailabilityCheckRefusal("The chosen job list is empty.");
  const intervalSeconds = Number(values.get("min-interval-seconds") ?? DEFAULT_SITE_INTERVAL_SECONDS);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_SITE_INTERVAL_SECONDS) {
    throw new AvailabilityCheckRefusal(`--min-interval-seconds must be at least ${MIN_SITE_INTERVAL_SECONDS}.`);
  }
  return { jobIds, apply, confirmWorkspace: values.get("confirm-workspace") ?? null, intervalSeconds };
}

/** The environment and argument checks an apply needs before anything connects. */
export function requireApplyConfirmation(args: CheckArguments, env: NodeJS.ProcessEnv): void {
  if (!args.apply) return;
  if (env.AVAILABILITY_CHECK_APPLY_ALLOWED !== "true") {
    throw new AvailabilityCheckRefusal("Refusing to apply: set AVAILABILITY_CHECK_APPLY_ALLOWED=true after the owner confirms the plan.");
  }
  if (!args.confirmWorkspace) throw new AvailabilityCheckRefusal("Refusing to apply: --confirm-workspace=<workspace uuid> is required.");
}

export interface CommandDependencies {
  readonly log?: (line: string) => void;
  readonly connect?: (url: string) => Promise<pg.Client>;
  readonly apply?: typeof applyAvailabilityCheck;
}

/** The command: REPLAY_DATABASE_URL only, replay guard on the connected branch, plan unless --apply. */
export async function runAvailabilityCheckCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: CommandDependencies = {},
): Promise<0 | 1> {
  const log = dependencies.log ?? console.log;
  const args = parseCheckArguments(argv);
  requireApplyConfirmation(args, env);
  const url = env.REPLAY_DATABASE_URL?.trim();
  if (!url) throw new AvailabilityCheckRefusal("REPLAY_DATABASE_URL is not set (DATABASE_URL is never used by this command).");
  const connect = dependencies.connect ?? (async (target: string) => {
    const client = new pg.Client(pgConnectionConfig(target));
    await client.connect();
    return client;
  });
  const client = await connect(url);
  const db = client as unknown as pg.PoolClient;
  try {
    // Everything up to the plan is read only at the database, so plan mode cannot write.
    await client.query("BEGIN READ ONLY");
    const identity = (await client.query<{ d: string; b: string | null }>(
      `SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`,
    )).rows[0]!;
    try {
      requireApprovedReplayTarget(url, { databaseName: identity.d, branchId: identity.b }, env.REPLAY_BRANCH_ID);
    } catch {
      // The guard's own message names the database host, which this command does not print.
      throw new AvailabilityCheckRefusal("Refusing to run: REPLAY_DATABASE_URL is not the approved replay branch.");
    }
    const context = await resolveWorkspaceContext(db);
    if (args.apply && args.confirmWorkspace !== context.workspaceId) {
      throw new AvailabilityCheckRefusal("Refusing to apply: --confirm-workspace does not equal the resolved workspace id.");
    }
    const now = new Date();
    const plan = await planAvailabilityCheck(db, context, args.jobIds, { now, intervalSeconds: args.intervalSeconds });
    await client.query("ROLLBACK");
    log(`mode=${args.apply ? "APPLY" : "PLAN"} branch=${identity.b} workspace=${context.workspaceId} check_date=${checkDate(now)} (${CHECK_TIME_ZONE})`);
    log(formatPlan(plan));
    if (!args.apply) {
      log("PLAN: no request was made and nothing was written.");
      return 0;
    }
    const results = await (dependencies.apply ?? applyAvailabilityCheck)(db, context, plan, { log });
    const tally = (result: CheckedJob["result"]) => results.filter((r) => r.result === result).length;
    log(`APPLIED: ${results.length} read(s): open=${tally("OPEN")} closed=${tally("CLOSED")} cannot_tell=${tally("CANNOT_TELL")} skipped=${tally("SKIPPED")} error=${tally("ERROR")} not_visible=${results.filter((r) => r.visible === false).length}`);
    return availabilityCheckExitCode(results);
  } finally {
    await client.end();
  }
}
