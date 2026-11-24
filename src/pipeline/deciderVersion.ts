/**
 * The version of the recommendation decider's rules. One value, used for the decision context fingerprint
 * (task version), the stage-version table in pipelineTaskCurrentness, the policy snapshot, and the
 * `deterministic_decisions.decider_version` column (migration 121).
 *
 * Bump it when the decider's code changes what it would decide for the same inputs. Jobs whose latest
 * decision carries a different (or no) decider_version are then re-seeded once (a per-run cap applies), and
 * every decision context fingerprint changes. The version is stored in its own column and is NOT part of
 * `decision_hash` (that hash covers the decision, readiness and evidence only), so storing it changes no decision hash.
 * deterministic_decisions rows are immutable (a trigger rejects UPDATE), so the version is written in the INSERT and is also
 * part of the decision context fingerprint: a post-migration decision never collides with an unstamped row of the same inputs.
 */
export const DECIDER_VERSION = "recommendation_decider_v1" as const;

/** SQL (alias `c` = canonical_jobs) true when the job's latest decision was made by another decider version. */
export function deciderVersionRefreshSql(canonicalAlias = "c"): string {
  const literal = DECIDER_VERSION.replaceAll("'", "''");
  return `EXISTS (
          SELECT 1
          FROM deterministic_decisions decider_refresh
          WHERE decider_refresh.id = ${canonicalAlias}.latest_deterministic_decision_id
            AND decider_refresh.decider_version IS DISTINCT FROM '${literal}'
        )`;
}

export function deciderVersionReassessmentReason(): string {
  return `DECIDER_VERSION:${DECIDER_VERSION}`;
}
