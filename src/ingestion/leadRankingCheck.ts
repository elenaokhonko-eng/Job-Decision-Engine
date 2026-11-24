import type { SourceName } from "../contracts/index.js";
import { AGGREGATOR_HOSTS } from "./aggregatorHosts.js";
import type { Queryable } from "./contentCompleteness.js";

/**
 * Must-be-zero check: no aggregator lead is in any ranking.
 *
 * A lead (a Gmail alert observation from an aggregator: payload lead_kind AGGREGATOR_LEAD, or a link on an
 * aggregator host) becomes a rankable job only when the employer's own posting is resolved. A job is "ranked" when
 * it carries a recommendation outcome that a list shows: PRIORITY, REVIEW or TRACK (src/contracts/jobStatus.ts
 * buckets; SKIP is not shown in a ranking). The eligibility column alone does not count: VERIFY is also the gate
 * default for jobs that are gated and not ranked. A ranked job backed by a lead must also have an observation from
 * an employer-owned source or one the owner provided. Read only; ids only.
 */

/**
 * What each source name is, so a new source forces a decision here (the Record is exhaustive over SourceName).
 *  - EMPLOYER: the employer's own posting (its ATS or its own site). Resolves a lead.
 *  - OWNER_PROVIDED: the owner saved or entered the job; the owner's own selections are always evaluated
 *    (AGENTS.md) and a saved export carries the full text. Exempt.
 *  - BOARD_FEED: a third-party job board or feed (not the employer's own posting). Does not resolve a lead.
 *  - AGGREGATOR: an aggregator listing (LinkedIn). Does not resolve a lead.
 *  - ALERT: the Gmail alert itself.
 */
export const SOURCE_ROLE: Record<SourceName, "EMPLOYER" | "OWNER_PROVIDED" | "BOARD_FEED" | "AGGREGATOR" | "ALERT"> = {
  GMAIL_ALERT: "ALERT",
  EMPLOYER_WEBSITE: "EMPLOYER",
  GREENHOUSE: "EMPLOYER",
  LEVER: "EMPLOYER",
  ASHBY: "EMPLOYER",
  WORKABLE: "EMPLOYER",
  SMARTRECRUITERS: "EMPLOYER",
  WORKDAY: "EMPLOYER",
  HIMALAYAS: "BOARD_FEED",
  JOBICY: "BOARD_FEED",
  REMOTIVE: "BOARD_FEED",
  WE_WORK_REMOTELY: "BOARD_FEED",
  STARTUP_JOBS: "BOARD_FEED",
  HACKER_NEWS: "BOARD_FEED",
  LINKEDIN: "AGGREGATOR",
  LINKEDIN_SAVED: "OWNER_PROVIDED",
  MCF_SAVED: "OWNER_PROVIDED",
  MANUAL_IMPORT: "OWNER_PROVIDED",
  MANUAL_STREAMLIT: "OWNER_PROVIDED",
};

/** Sources whose presence on a job means the lead has been resolved (or the owner chose the job). */
export const RESOLVING_SOURCE_NAMES: readonly SourceName[] = (Object.keys(SOURCE_ROLE) as SourceName[])
  .filter((name) => SOURCE_ROLE[name] === "EMPLOYER" || SOURCE_ROLE[name] === "OWNER_PROVIDED");

/** The sample is capped at this many ids, and the whole sample is printed. */
export const LEAD_RANKING_SAMPLE_SIZE = 5;

export interface LeadInRankingReport {
  count: number;
  sample: string[];
}

function aggregatorUrlPattern(): string {
  // "[.]" matches a literal dot without a backslash escape.
  const hosts = AGGREGATOR_HOSTS.map((host) => host.split(".").join("[.]"));
  return `^https?://([^/@]*[.])?(${hosts.join("|")})([:/?#]|$)`;
}

export async function reportAggregatorLeadsInRanking(client: Queryable, workspaceId: string): Promise<LeadInRankingReport> {
  const result = await client.query<{ canonical_job_id: string }>(
    `SELECT canonical.id::text AS canonical_job_id
       FROM canonical_jobs canonical
      WHERE canonical.workspace_id = $1::uuid
        AND canonical.is_test_fixture = FALSE
        AND canonical.archived_at IS NULL
        AND canonical.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK')
        AND EXISTS (
          SELECT 1 FROM job_versions version
            JOIN raw_job_observations lead
              ON lead.workspace_id = version.workspace_id AND lead.job_version_id = version.id
           WHERE version.workspace_id = canonical.workspace_id AND version.canonical_job_id = canonical.id
             AND lead.source_name = 'GMAIL_ALERT'
             AND (lead.raw_payload->>'lead_kind' = 'AGGREGATOR_LEAD' OR lead.source_url ~* $2)
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_versions version
            JOIN raw_job_observations other
              ON other.workspace_id = version.workspace_id AND other.job_version_id = version.id
           WHERE version.workspace_id = canonical.workspace_id AND version.canonical_job_id = canonical.id
             AND other.source_name = ANY($3::text[])
        )
      ORDER BY canonical.id`,
    [workspaceId, aggregatorUrlPattern(), [...RESOLVING_SOURCE_NAMES]],
  );
  return { count: result.rows.length, sample: result.rows.slice(0, LEAD_RANKING_SAMPLE_SIZE).map((row) => row.canonical_job_id) };
}
