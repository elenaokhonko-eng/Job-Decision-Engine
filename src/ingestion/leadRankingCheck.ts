import { OWNER_SAVED_SOURCE_NAMES } from "../services/jobArchiveHardRejectedPolicy.js";
import { AGGREGATOR_HOSTS } from "./aggregatorHosts.js";
import type { Queryable } from "./contentCompleteness.js";

/**
 * Must-be-zero check: no aggregator lead is in any ranking.
 *
 * A lead (a Gmail alert observation from an aggregator: payload lead_kind AGGREGATOR_LEAD, or a link on an
 * aggregator host) becomes a rankable job only when the employer's own posting is resolved. So a live job that
 * carries a recommendation (PRIORITY, REVIEW or TRACK outcome, or an ELIGIBLE / VERIFY eligibility) and is backed by
 * an aggregator lead must also have an observation from an employer source. A job the owner saved through a
 * saved-jobs export is exempt: the owner's own selections are always evaluated (AGENTS.md; the export carries the
 * full text). Read only; ids only.
 */

export const EMPLOYER_SOURCE_NAMES = ["GREENHOUSE", "LEVER", "ASHBY", "WORKDAY", "SMARTRECRUITERS", "WORKABLE", "EMPLOYER_WEBSITE"] as const;

export interface LeadInRankingReport {
  count: number;
  /** At most 20 canonical job ids. */
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
        AND (canonical.recommendation_outcome IN ('PRIORITY', 'REVIEW', 'TRACK')
          OR canonical.recommendation_eligibility IN ('ELIGIBLE', 'VERIFY'))
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
    [workspaceId, aggregatorUrlPattern(), [...EMPLOYER_SOURCE_NAMES, ...OWNER_SAVED_SOURCE_NAMES]],
  );
  return { count: result.rows.length, sample: result.rows.slice(0, 20).map((row) => row.canonical_job_id) };
}
