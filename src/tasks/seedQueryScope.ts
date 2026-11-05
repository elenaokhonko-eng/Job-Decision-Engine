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
