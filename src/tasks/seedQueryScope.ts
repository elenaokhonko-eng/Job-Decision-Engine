export interface SeedQueryScope {
  readonly jobVersionIds?: readonly string[];
  readonly observationIds?: readonly string[];
}

export interface ScopedSeedQuery {
  readonly sql: string;
  readonly params: unknown[];
}

export function scopeSeedQuery(
  sql: string,
  params: readonly unknown[],
  scope: SeedQueryScope,
  limit: number,
): ScopedSeedQuery {
  const hasJobScope = scope.jobVersionIds !== undefined;
  const hasObservationScope = scope.observationIds !== undefined;
  if (!hasJobScope && !hasObservationScope) return { sql, params: [...params] };

  const limitMatch = /\s+LIMIT\s+\$(\d+)\s*$/i.exec(sql);
  if (!limitMatch || limitMatch.index === undefined) {
    throw new Error("Scoped task seeding requires a query with a final parameterized LIMIT.");
  }
  const limitParameterIndex = Number(limitMatch[1]);
  if (!Number.isInteger(limitParameterIndex) || limitParameterIndex < 1 || limitParameterIndex > params.length) {
    throw new Error("Scoped task seeding requires the LIMIT placeholder to have a matching parameter.");
  }
  const unscopedSql = sql.slice(0, limitMatch.index);
  const limitParameterIsReused = new RegExp(`\\$${limitParameterIndex}(?!\\d)`).test(unscopedSql);
  const baseSql = limitParameterIsReused
    ? unscopedSql
    : unscopedSql.replace(/\$(\d+)/g, (placeholder, rawIndex: string) => {
      const index = Number(rawIndex);
      return index > limitParameterIndex ? `$${index - 1}` : placeholder;
    });
  const baseParams = limitParameterIsReused
    ? [...params]
    : [...params.slice(0, limitParameterIndex - 1), ...params.slice(limitParameterIndex)];
  const filters: string[] = [];
  const scopedParams = [...baseParams];

  if (hasJobScope) {
    scopedParams.push([...(scope.jobVersionIds ?? [])]);
    filters.push(`scoped_seed.job_version_id::text = ANY($${scopedParams.length}::text[])`);
  }
  if (hasObservationScope) {
    scopedParams.push([...(scope.observationIds ?? [])]);
    filters.push(`scoped_seed.observation_id::text = ANY($${scopedParams.length}::text[])`);
  }
  scopedParams.push(limit);

  return {
    sql: `SELECT * FROM (${baseSql}) AS scoped_seed
          WHERE ${filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0]}
          LIMIT $${scopedParams.length}`,
    params: scopedParams,
  };
}

/**
 * The live-job scope every capped seed query carries, applied INSIDE the query before its LIMIT. A seed that
 * selects archived jobs (or fixtures) lets them take the cap: enqueue refuses them afterwards, so the same oldest
 * rows come back every pass and live jobs behind them are never reached. The scope is appended to the first
 * top-level `WHERE c.workspace_id = $1` of the seed (alias `c` = canonical_jobs) as one extra AND term, so it is
 * applied by the helper and a seed cannot forget it. A seed with no such anchor throws; one that has no
 * canonical job (an observation seed) must opt out explicitly at the call site.
 */
export function applyLiveJobScope(
  sql: string,
  params: readonly unknown[],
  options: { includeTestFixtures: boolean },
): ScopedSeedQuery {
  const anchor = /WHERE\s+c\.workspace_id\s*=\s*\$1\b/.exec(sql);
  if (!anchor || anchor.index === undefined) {
    throw new Error("A capped seed query must filter `WHERE c.workspace_id = $1` so the live-job scope can be applied before its LIMIT.");
  }
  const fixtureTerm = options.includeTestFixtures ? "" : " AND c.is_test_fixture IS NOT TRUE";
  const insertAt = anchor.index + anchor[0].length;
  return {
    sql: `${sql.slice(0, insertAt)} AND c.archived_at IS NULL${fixtureTerm}${sql.slice(insertAt)}`,
    params: [...params],
  };
}

/** `pipeline_tasks.repair_action` of a DECIDE task closed because the decider would have changed a terminal job's stored outcome. */
export const OUTCOME_CONFLICT_REPAIR_ACTION = "OUTCOME_CONFLICT_ON_TERMINAL_JOB";

/**
 * States past lane routing that the DECIDE handler can stamp, and not a job whose current version already has a closed
 * outcome conflict (nothing will ever run for it until an operator acts). One predicate shared by the DECIDE seed and the
 * decider stale-stage check, so the two cannot drift again. Alias `c` = canonical_jobs.
 */
export function deciderSeedableSql(alias = "c"): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("A canonical_jobs alias must be a plain identifier.");
  return `(COALESCE(${alias}.processing_state, ${alias}.processing_status) NOT IN ('RAW_STAGED', 'PREQUALIFIED', 'MANUALLY_REMOVED')
     AND NOT EXISTS (
       SELECT 1 FROM pipeline_tasks conflict_task
        WHERE conflict_task.workspace_id = ${alias}.workspace_id AND conflict_task.task_type = 'DECIDE_RECOMMENDATION'
          AND conflict_task.status = 'COMPLETED' AND conflict_task.repair_action = '${OUTCOME_CONFLICT_REPAIR_ACTION}'
          AND conflict_task.payload->>'job_version_id' = ${alias}.latest_job_version_id::text))`;
}
