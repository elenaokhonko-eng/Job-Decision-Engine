/**
 * Same-day availability check of a chosen list of jobs (scripts/check_availability_now.ts).
 *
 * Each posting link is read once a day, serially, with a pause between requests of one site (redirect hops too).
 * A site that answers 429 or blocks the reader is not read again that day. An apply is bound to the confirmed plan:
 * job list, links and Singapore date. Nothing from the jobs file is printed: only line numbers and counts. What a read means and how
 * it is stored is the existing re-check (runAvailabilityRecheck, manual mode): this module only chooses which
 * links may be read, paces them and reports. A job never checked before is included. It writes nothing itself.
 * Plan mode runs in a READ ONLY transaction and has no code path to a posting reader. Replay copies only.
 */
import { createHash } from "node:crypto";
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
/** Responses after which a site is left alone for the rest of the day. */
const SITE_STOP_STATUSES = new Set([403, 429, 999]);
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
  | "SITE_STOPPED_TODAY"
  | "ALREADY_CONFIRMED_OPEN_TODAY"
  | "ALREADY_CHECKED_TODAY";

export interface PlannedRead {
  /** Position of the job in the chosen list (its line in a --jobs file). */
  readonly line: number;
  readonly linkKey: string;
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  /** Host the first request goes to. */
  readonly site: string;
  readonly intervalMs: number;
}

export interface AvailabilityCheckPlan {
  readonly listed: number;
  readonly reads: readonly PlannedRead[];
  readonly excluded: ReadonlyArray<{ readonly line: number; readonly reason: ExclusionReason }>;
  readonly checkDate: string;
  /** Hash of the job list, the links to be read and the Singapore date: what an apply must confirm. */
  readonly planId: string;
}

type Queryable = Pick<pg.PoolClient, "query">;

export interface PlanOptions {
  readonly now: Date;
  readonly intervalSeconds?: number;
  readonly requestsPerMinute?: (sourcePluginKey: string | null) => Promise<number | null>;
  readonly jobBoardHosts?: readonly string[];
  /** Line of each entry in the jobs file; its position when not given. */
  readonly lines?: readonly number[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Links already read, and sites that stopped answering, in today's manual checks of this workspace. */
async function readToday(client: Queryable, workspaceId: string, now: Date): Promise<{ links: Set<string>; stopped: Set<string> }> {
  const { rows } = await client.query<{ link_key: string | null; stopped: unknown }>(
    `SELECT details->>'link_key' AS link_key, details->'stopped_sites' AS stopped
       FROM job_availability_recheck_events
      WHERE workspace_id = $1::uuid AND details->>'trigger' = 'MANUAL'
        AND (occurred_at AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date`,
    [workspaceId, now, CHECK_TIME_ZONE],
  );
  return {
    links: new Set(rows.flatMap((row) => (row.link_key ? [row.link_key] : []))),
    stopped: new Set(rows.flatMap((row) => (Array.isArray(row.stopped) ? row.stopped.map(String) : []))),
  };
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
  const excluded: Array<{ line: number; reason: ExclusionReason }> = [];
  const seenIds = new Set<string>();
  const today = await readToday(client, context.workspaceId, options.now);
  const seenLinks = new Set<string>(today.links);

  for (const [index, listed] of jobIds.entries()) {
    const id = listed.trim().toLowerCase();
    const line = options.lines?.[index] ?? index + 1;
    const leaveOut = (reason: ExclusionReason) => excluded.push({ line, reason });
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
    linkKey = sha256(linkKey);
    if (seenLinks.has(linkKey)) { leaveOut("SAME_LINK_AS_ANOTHER_JOB"); continue; }
    if (today.stopped.has(requestUrl.hostname.toLowerCase())) { leaveOut("SITE_STOPPED_TODAY"); continue; }
    seenLinks.add(linkKey);
    const rpm = await requestsPerMinute(candidate.sourcePluginKey);
    reads.push({
      line,
      linkKey,
      canonicalJobId: id,
      jobVersionId: candidate.jobVersionId,
      site: requestUrl.hostname.toLowerCase(),
      intervalMs: Math.max(minMs, rpm ? Math.ceil(60_000 / rpm) : 0),
    });
  }
  // One site at a time: all reads of a site follow each other.
  reads.sort((a, b) => a.site.localeCompare(b.site));
  const date = checkDate(options.now);
  const planId = sha256(JSON.stringify({
    date,
    jobs: jobIds.map((id) => id.trim().toLowerCase()).sort(),
    reads: reads.map((read) => `${read.canonicalJobId} ${read.linkKey}`).sort(),
  })).slice(0, 16);
  return { listed: jobIds.length, reads, excluded, checkDate: date, planId };
}

export function formatPlan(plan: AvailabilityCheckPlan): string {
  const sites = new Map<string, { requests: number; intervalMs: number }>();
  for (const read of plan.reads) {
    const site = sites.get(read.site) ?? { requests: 0, intervalMs: 0 };
    sites.set(read.site, { requests: site.requests + 1, intervalMs: Math.max(site.intervalMs, read.intervalMs) });
  }
  const reasons = new Map<ExclusionReason, number[]>();
  for (const { line, reason } of plan.excluded) reasons.set(reason, [...(reasons.get(reason) ?? []), line]);
  const seconds = Math.ceil([...sites.values()].reduce((total, s) => total + (s.requests - 1) * s.intervalMs, 0) / 1000);
  return [
    `jobs listed: ${plan.listed}`,
    `posting links to read: ${plan.reads.length} (one request each, plus any redirects, at most 5 per link; Ashby postings of one board can share a request)`,
    `other requests: up to ${plan.reads.length} to api.frankfurter.app (exchange rate to SGD), only when the decision recompute after an open or closed read meets a non-SGD salary with no recent stored rate`,
    `sites: ${sites.size}, one at a time, serial; pauses add at least ${seconds}s`,
    ...[...sites].map(([host, s]) => `  ${host}: ${s.requests} request(s), at most 1 every ${s.intervalMs / 1000}s`),
    "a site that answers 429 or 403, or shows a bot block, is not read again today",
    `excluded: ${plan.excluded.length}`,
    ...[...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([reason, lines]) => `  ${reason}: ${lines.length} (lines ${lines.join(",")})`),
    `plan id: ${plan.planId} (check date ${plan.checkDate})`,
  ].join("\n");
}

export interface CheckedJob {
  readonly canonicalJobId: string;
  /** OPEN, CLOSED or CANNOT_TELL as read; SKIPPED when the job changed since the plan; ERROR when it failed. */
  readonly result: "OPEN" | "CLOSED" | "CANNOT_TELL" | "SKIPPED" | "ERROR";
  readonly detail: string;
  /** OPEN and CLOSED only: the read model shows the stored verdict (for OPEN: current, verified today). */
  readonly visible: boolean | null;
  /** The decision was not recomputed because that would have removed the stored requirement score. */
  readonly scoreKept?: boolean;
}

export interface ApplyOptions {
  readonly fetcher?: PostingFetcherDependencies;
  readonly now?: () => Date;
  readonly throttle?: HostThrottle;
  readonly jobBoardHosts?: readonly string[];
  readonly log?: (line: string) => void;
}

export async function verdictVisible(client: Queryable, workspaceId: string, jobId: string, open: boolean, now: Date): Promise<boolean> {
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
  const intervals = new Map<string, number>();
  for (const read of plan.reads) intervals.set(read.site, Math.max(read.intervalMs, intervals.get(read.site) ?? 0));
  const stopped = new Set<string>();
  const results: CheckedJob[] = [];
  for (const read of plan.reads) {
    const startedAt = now();
    const report = (checked: CheckedJob) => {
      options.log?.(`line ${read.line} ${read.site} ${checked.result} ${checked.detail}${checked.visible === false ? " NOT_VISIBLE_IN_READ_MODEL" : ""}${checked.scoreKept ? " DECISION_NOT_RECOMPUTED" : ""}`);
      results.push(checked);
    };
    const skip = (detail: string) => report({ canonicalJobId: read.canonicalJobId, result: "SKIPPED", detail, visible: null });
    // The plan was confirmed for one Singapore date: past midnight nothing more is requested.
    if (checkDate(startedAt) !== plan.checkDate) { skip("CHECK_DATE_CHANGED"); continue; }
    if (stopped.has(read.site)) { skip("SITE_STOPPED_AFTER_429_OR_BLOCK"); continue; }
    const interval = intervals.get(read.site)!;
    const stoppedByThisRead = new Set<string>();
    const stop = (host: string) => { stoppedByThisRead.add(host); stoppedByThisRead.add(read.site); };
    const fetcher: PostingFetcherDependencies = {
      ...options.fetcher,
      refuseRequest: (url) => stopped.has(url.hostname.toLowerCase()) || blockedLinkReason(url.toString(), jobBoardHosts) !== null,
      // Every request, redirect hops included, waits the interval of this read's site and of its own host.
      beforeRequest: async (url) => {
        const host = url.hostname.toLowerCase();
        await throttle.acquire(read.site, interval);
        if (host !== read.site) await throttle.acquire(host, interval);
      },
      onResponse: (url, status) => { if (SITE_STOP_STATUSES.has(status)) stop(url.hostname.toLowerCase()); },
    };
    let checked: CheckedJob;
    try {
      const outcome = await runAvailabilityRecheck(
        client,
        context,
        { canonical_job_id: read.canonicalJobId, job_version_id: read.jobVersionId, cycle_started_at: startedAt.toISOString() },
        null,
        {
          ...defaultAvailabilityRecheckDependencies(),
          fetchJobContent: async (url, expected, dependencies) => {
            const result = await fetchJobContent(url, expected, dependencies);
            if ((result.kind === "BLOCKED" && result.reason === "BOT_BLOCKED") ||
                (result.kind === "RETRYABLE_FAILURE" && /rate limit/i.test(result.reason))) stop(read.site);
            return result;
          },
          pageFetcherDependencies: fetcher,
          // Paced per request above, by the host that is actually requested.
          throttle: new HostThrottle(() => 0, async () => undefined),
          requestsPerMinute: async () => null,
          createFeedAdapter: () => null,
          now: () => startedAt,
        },
        { manual: true, manualDetails: () => ({ link_key: read.linkKey, stopped_sites: [...stoppedByThisRead] }) },
      );
      if (outcome.status === "SKIPPED") {
        checked = { canonicalJobId: read.canonicalJobId, result: "SKIPPED", detail: outcome.reason, visible: null };
      } else {
        const result = outcome.outcome === "OPEN" ? "OPEN" : outcome.outcome === "CLOSED_BY_PAGE" ? "CLOSED" : "CANNOT_TELL";
        const { rows } = await client.query<{ kept: boolean }>(
          `SELECT COALESCE(details ? 'readiness_recompute_skipped', FALSE) AS kept FROM job_availability_recheck_events
            WHERE workspace_id = $1::uuid AND canonical_job_id = $2::uuid ORDER BY id DESC LIMIT 1`,
          [context.workspaceId, read.canonicalJobId],
        );
        checked = {
          canonicalJobId: read.canonicalJobId,
          result,
          detail: outcome.reasonCode,
          visible: result === "CANNOT_TELL" ? null : await verdictVisible(client, context.workspaceId, read.canonicalJobId, result === "OPEN", startedAt),
          scoreKept: rows[0]?.kept === true,
        };
      }
    } catch (error) {
      checked = { canonicalJobId: read.canonicalJobId, result: "ERROR", detail: publicErrorSummary(error, "pipeline"), visible: null };
    }
    for (const host of stoppedByThisRead) stopped.add(host);
    report(checked);
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
  /** Line of each id in the jobs file (position for --job-ids and JSON arrays). */
  readonly lines: readonly number[];
  readonly apply: boolean;
  readonly confirmWorkspace: string | null;
  readonly confirmPlan: string | null;
  readonly intervalSeconds: number;
}

/** A mistake in how the command was called, or a refusal: safe to print as it is. */
export class AvailabilityCheckRefusal extends Error {}

/** `--jobs=<file>` (one job id per line, or a JSON array of ids) or `--job-ids=<id,id>`. No file content is ever echoed. */
export function parseCheckArguments(argv: readonly string[], readFile = (file: string) => fs.readFileSync(file, "utf8")): CheckArguments {
  const values = new Map<string, string>();
  let apply = false;
  for (const [index, arg] of argv.entries()) {
    if (arg === "--apply") { apply = true; continue; }
    const match = /^--(jobs|job-ids|confirm-workspace|confirm-plan|min-interval-seconds)=(.+)$/.exec(arg);
    if (!match) throw new AvailabilityCheckRefusal(`Unknown argument at position ${index + 1}.`);
    values.set(match[1]!, match[2]!.trim());
  }
  const file = values.get("jobs");
  const inline = values.get("job-ids");
  if ((file === undefined) === (inline === undefined)) {
    throw new AvailabilityCheckRefusal("Give the chosen jobs as --jobs=<file> or --job-ids=<id,id> (exactly one).");
  }
  let entries: Array<{ id: string; line: number }>;
  if (inline !== undefined) {
    entries = inline.split(",").map((id, index) => ({ id, line: index + 1 }));
  } else {
    let text: string;
    try {
      text = readFile(file!).replace(/^\uFEFF/, "");
    } catch {
      throw new AvailabilityCheckRefusal("The jobs file could not be read.");
    }
    if (text.trim().startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // The parser's own message quotes the file.
        throw new AvailabilityCheckRefusal("The jobs file is not valid JSON.");
      }
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new AvailabilityCheckRefusal("The jobs file must be a JSON array of job ids.");
      }
      entries = (parsed as string[]).map((id, index) => ({ id, line: index + 1 }));
    } else {
      entries = text.split(/\r?\n/).map((id, index) => ({ id, line: index + 1 })).filter((entry) => !entry.id.trimStart().startsWith("#"));
    }
  }
  entries = entries.map((entry) => ({ ...entry, id: entry.id.trim() })).filter((entry) => entry.id !== "");
  if (entries.length === 0) throw new AvailabilityCheckRefusal("The chosen job list is empty.");
  const intervalSeconds = Number(values.get("min-interval-seconds") ?? DEFAULT_SITE_INTERVAL_SECONDS);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_SITE_INTERVAL_SECONDS) {
    throw new AvailabilityCheckRefusal(`--min-interval-seconds must be at least ${MIN_SITE_INTERVAL_SECONDS}.`);
  }
  return {
    jobIds: entries.map((entry) => entry.id),
    lines: entries.map((entry) => entry.line),
    apply,
    confirmWorkspace: values.get("confirm-workspace") ?? null,
    confirmPlan: values.get("confirm-plan") ?? null,
    intervalSeconds,
  };
}

/** The environment and argument checks an apply needs before anything connects. */
export function requireApplyConfirmation(args: CheckArguments, env: NodeJS.ProcessEnv): void {
  if (!args.apply) return;
  if (env.AVAILABILITY_CHECK_APPLY_ALLOWED !== "true") {
    throw new AvailabilityCheckRefusal("Refusing to apply: set AVAILABILITY_CHECK_APPLY_ALLOWED=true after the owner confirms the plan.");
  }
  if (!args.confirmWorkspace) throw new AvailabilityCheckRefusal("Refusing to apply: --confirm-workspace=<workspace uuid> is required.");
  if (!args.confirmPlan) throw new AvailabilityCheckRefusal("Refusing to apply: --confirm-plan=<plan id of the confirmed plan> is required.");
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
    const plan = await planAvailabilityCheck(db, context, args.jobIds, { now, intervalSeconds: args.intervalSeconds, lines: args.lines });
    await client.query("ROLLBACK");
    log(`mode=${args.apply ? "APPLY" : "PLAN"} branch=${identity.b} workspace=${context.workspaceId} check_date=${checkDate(now)} (${CHECK_TIME_ZONE})`);
    log(formatPlan(plan));
    if (!args.apply) {
      log("PLAN: no request was made and nothing was written.");
      return 0;
    }
    if (args.confirmPlan !== plan.planId) {
      throw new AvailabilityCheckRefusal("Refusing to apply: the job list, the links to read or the Singapore date differ from the confirmed plan. Nothing was requested; confirm the plan above.");
    }
    const results = await (dependencies.apply ?? applyAvailabilityCheck)(db, context, plan, { log });
    const tally = (result: CheckedJob["result"]) => results.filter((r) => r.result === result).length;
    log(`APPLIED: ${results.length} read(s): open=${tally("OPEN")} closed=${tally("CLOSED")} cannot_tell=${tally("CANNOT_TELL")} skipped=${tally("SKIPPED")} error=${tally("ERROR")} not_visible=${results.filter((r) => r.visible === false).length} decision_not_recomputed=${results.filter((r) => r.scoreKept).length}`);
    return availabilityCheckExitCode(results);
  } finally {
    await client.end();
  }
}
