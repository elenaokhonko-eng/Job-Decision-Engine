import type pg from "pg";
import { aggregatorHostOf } from "./aggregatorHosts.js";
import { employerKey } from "./employerBoardLookup.js";
import { isUnknownEmployerName } from "./postingIdentity.js";

/**
 * Read-only report: how many current aggregator leads resolve to the employer's own posting.
 *
 * A lead is a Gmail alert observation whose link points at an aggregator (LinkedIn, MyCareersFuture, Indeed...).
 * It becomes a rankable job only when the employer's own posting is resolved and verified open. This report uses
 * only what is already stored (no network, no write): the employer board cache, the posting content that was
 * attached, and the availability evidence. It answers "how far has each current lead got", in counts only.
 *
 * Library-only: there is no command. A caller opens its own read-only transaction on an approved replay target and
 * calls reportAggregatorLeadResolution; a thin script would be a new database-opening script (rule F3).
 *
 * "Current": retrieved within `windowDays`, or linked to a live job. Never prints a title, employer or URL.
 */

export interface LeadResolutionReport {
  windowDays: number;
  /** Current aggregator leads (one per observation). */
  leads: number;
  byAggregator: Record<string, number>;
  /** Distinct employers among leads that name one. */
  distinctEmployers: number;
  withEmployerName: number;
  withoutEmployerName: number;
  /** Leads by what the employer-board cache says about their employer. */
  employerBoard: { found: number; notFound: number; notResolved: number; unknownEmployer: number };
  /** Leads by observation processing status. */
  byStatus: Record<string, number>;
  /** Stage counts; each stage contains the next. */
  stages: {
    leads: number;
    /** The lead is linked to a live canonical job. */
    linkedToLiveJob: number;
    /** ... whose description is complete (description_quality_status COMPLETE). */
    contentComplete: number;
    /** ... and the content came from the employer's own source, not the alert or an aggregator page. */
    employerSourcedContent: number;
    /** ... and the posting is verified open now (v_job_availability_current). Only these are rankable. */
    verifiedOpen: number;
  };
  /** Distinct employers whose board is cached FOUND: the upper bound a resolution run could reach without new boards. */
  employersWithKnownBoard: number;
}

interface LeadRow {
  observation_id: string;
  source_url: string;
  company_name: string;
  processing_status: string | null;
  job_version_id: string | null;
  live_job: boolean;
  content_complete: boolean | null;
  employer_sourced: boolean;
  availability_current: boolean | null;
}

/** The host an alert link points at, looking through Amazon SES click tracking. */
export function alertLinkHost(sourceUrl: string): string | null {
  try {
    let url = new URL(sourceUrl);
    if (/(?:^|\.)awstrack\.me$/i.test(url.hostname)) {
      const encoded = url.pathname.match(/^\/L0\/([^/]+)/)?.[1];
      if (!encoded) return null;
      url = new URL(decodeURIComponent(encoded));
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export async function reportAggregatorLeadResolution(
  client: pg.PoolClient | pg.Client,
  input: { workspaceId: string; windowDays?: number; now?: Date },
): Promise<LeadResolutionReport> {
  const windowDays = input.windowDays ?? 21;
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new RangeError("windowDays must be a whole number of days, 1 or more.");
  const now = input.now ?? new Date();

  const rows = await client.query<LeadRow>(
    `SELECT observation.id::text AS observation_id,
            observation.source_url,
            COALESCE(observation.company_name, '') AS company_name,
            observation.processing_status,
            observation.job_version_id::text AS job_version_id,
            (canonical.id IS NOT NULL) AS live_job,
            (canonical.description_quality_status = 'COMPLETE') AS content_complete,
            EXISTS (
              SELECT 1 FROM raw_job_observations employer_observation
               WHERE employer_observation.workspace_id = observation.workspace_id
                 AND employer_observation.job_version_id = observation.job_version_id
                 AND employer_observation.source_name IN ('GREENHOUSE', 'LEVER', 'ASHBY', 'EMPLOYER_WEBSITE')
            ) AS employer_sourced,
            availability.availability_current
       FROM raw_job_observations observation
       LEFT JOIN job_versions version
         ON version.workspace_id = observation.workspace_id AND version.id = observation.job_version_id
       LEFT JOIN canonical_jobs canonical
         ON canonical.workspace_id = version.workspace_id AND canonical.id = version.canonical_job_id
        AND canonical.archived_at IS NULL AND canonical.is_test_fixture = FALSE
        AND COALESCE(canonical.processing_state, canonical.processing_status) <> 'MANUALLY_REMOVED'
       LEFT JOIN v_job_availability_current availability
         ON availability.workspace_id = canonical.workspace_id AND availability.canonical_job_id = canonical.id
        AND availability.job_version_id = canonical.latest_job_version_id
      WHERE observation.workspace_id = $1::uuid
        AND observation.source_name = 'GMAIL_ALERT'
        AND (observation.retrieved_at >= $2::timestamptz - make_interval(days => $3::int) OR canonical.id IS NOT NULL)`,
    [input.workspaceId, now, windowDays],
  );

  // employer_board_resolutions is a global cache keyed by employer (migration 100, no workspace_id): one resolution
  // per employer is shared by every workspace, and the report reads only its status, never a name or board token.
  const board = await client.query<{ employer_key: string; status: "FOUND" | "NOT_FOUND" }>(
    `SELECT employer_key, status FROM employer_board_resolutions`,
  );
  const boardByKey = new Map(board.rows.map((row) => [row.employer_key, row.status]));

  const report: LeadResolutionReport = {
    windowDays,
    leads: 0,
    byAggregator: {},
    distinctEmployers: 0,
    withEmployerName: 0,
    withoutEmployerName: 0,
    employerBoard: { found: 0, notFound: 0, notResolved: 0, unknownEmployer: 0 },
    byStatus: {},
    stages: { leads: 0, linkedToLiveJob: 0, contentComplete: 0, employerSourcedContent: 0, verifiedOpen: 0 },
    employersWithKnownBoard: 0,
  };
  const employers = new Set<string>();
  const employersWithBoard = new Set<string>();
  for (const row of rows.rows) {
    const host = alertLinkHost(row.source_url);
    const aggregator = host ? aggregatorHostOf(host) : null;
    if (!aggregator) continue;
    report.leads += 1;
    report.stages.leads += 1;
    report.byAggregator[aggregator] = (report.byAggregator[aggregator] ?? 0) + 1;
    const status = row.processing_status ?? "NONE";
    report.byStatus[status] = (report.byStatus[status] ?? 0) + 1;

    if (isUnknownEmployerName(row.company_name)) {
      report.withoutEmployerName += 1;
      report.employerBoard.unknownEmployer += 1;
    } else {
      report.withEmployerName += 1;
      const key = employerKey(row.company_name);
      employers.add(key);
      const cached = boardByKey.get(key);
      if (cached === "FOUND") {
        report.employerBoard.found += 1;
        employersWithBoard.add(key);
      } else if (cached === "NOT_FOUND") report.employerBoard.notFound += 1;
      else report.employerBoard.notResolved += 1;
    }

    if (!row.live_job) continue;
    report.stages.linkedToLiveJob += 1;
    if (row.content_complete !== true) continue;
    report.stages.contentComplete += 1;
    if (!row.employer_sourced) continue;
    report.stages.employerSourcedContent += 1;
    if (row.availability_current === true) report.stages.verifiedOpen += 1;
  }
  report.distinctEmployers = employers.size;
  report.employersWithKnownBoard = employersWithBoard.size;
  return report;
}
