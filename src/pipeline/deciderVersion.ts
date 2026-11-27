/**
 * The version of the recommendation decider's rules. One value, used for the decision context fingerprint (task version and
 * the `decider_version` payload key), the stage-version table in pipelineTaskCurrentness, the policy snapshot, and the
 * `deterministic_decisions.decider_version` column (migration 121).
 *
 * Bump it when the decider's code, or a policy it applies (for example the role-shape policy), changes what it would decide for
 * the same inputs. Jobs whose latest decision carries a different (or no) decider_version are then re-seeded once (a per-run cap
 * applies), and every decision context fingerprint changes. `decision_hash` covers the decision, readiness and evidence only,
 * so the version never enters it. deterministic_decisions rows are immutable (a trigger rejects UPDATE): the version is
 * written in the decision's INSERT, and it is part of the decision context fingerprint so a post-migration decision never
 * collides with an unstamped row of the same inputs.
 */
// v5: posting age no longer blocks or holds application readiness (owner decision 2026-11-27).
export const DECIDER_VERSION = "recommendation_decider_v5" as const;

/** SQL (alias `c` = canonical_jobs) true when the job's latest decision was made by another decider version. */
export function deciderVersionRefreshSql(canonicalAlias = "c", options: { includeTestFixtures?: boolean } = {}): string {
  const literal = DECIDER_VERSION.replaceAll("'", "''");
  // Only jobs the decider itself will process: an archived job (or a fixture, unless fixtures are included) never gets a current
  // decider_version, so it would keep the oldest updated_at and starve live jobs past the per-run cap.
  const live = `${canonicalAlias}.archived_at IS NULL${options.includeTestFixtures ? "" : ` AND ${canonicalAlias}.is_test_fixture IS NOT TRUE`}`;
  return `(${live} AND EXISTS (
          SELECT 1
          FROM deterministic_decisions decider_refresh
          WHERE decider_refresh.id = ${canonicalAlias}.latest_deterministic_decision_id
            AND decider_refresh.decider_version IS DISTINCT FROM '${literal}'
        ))`;
}

export function deciderVersionReassessmentReason(): string {
  return `DECIDER_VERSION:${DECIDER_VERSION}`;
}
