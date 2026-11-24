export interface SeedQueryScope {
  readonly jobVersionIds?: readonly string[];
  readonly observationIds?: readonly string[];
}

export interface ScopedSeedQuery {
  readonly sql: string;
  readonly params: unknown[];
}


interface OrderKey { readonly expression: string; readonly direction: string }

/** Index of the last ORDER BY outside parentheses, quotes and comments, or -1. */
function lastTopLevelOrderBy(sql: string): number {
  let depth = 0;
  let found = -1;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (ch === "'") { i = sql.indexOf("'", i + 1); if (i < 0) return -1; continue; }
    if (ch === "-" && sql[i + 1] === "-") { const end = sql.indexOf("\n", i); if (end < 0) break; i = end; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /^ORDER\s+BY\s/i.test(sql.slice(i, i + 12)) && (i === 0 || /\s/.test(sql[i - 1]!))) found = i;
  }
  return found;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "'") { i = text.indexOf("'", i + 1); if (i < 0) break; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseOrderKeys(orderText: string): OrderKey[] {
  return splitTopLevel(orderText).map((item) => {
    const match = /^([\s\S]*?)(?:\s+(ASC|DESC))?(?:\s+(NULLS\s+(?:FIRST|LAST)))?$/i.exec(item)!;
    return {
      expression: match[1]!.trim(),
      direction: [match[2]?.toUpperCase() ?? "ASC", match[3]?.toUpperCase().replace(/\s+/, " ")].filter(Boolean).join(" "),
    };
  });
}

/**
 * The scope filter runs outside the seed query, and a subquery's ORDER BY is not guaranteed to survive an
 * outer SELECT. So the seed's ordering expressions are exposed as extra leading columns and the wrapper
 * orders by them before applying the cap. A seed without a top-level ORDER BY keeps no ordering.
 */
function exposeOrdering(baseSql: string): { sql: string; orderBy: string } {
  const at = lastTopLevelOrderBy(baseSql);
  const select = /^(\s*SELECT\s+)(?!DISTINCT\b)/i.exec(baseSql);
  if (at < 0 || !select || /\bUNION\b/i.test(baseSql)) return { sql: baseSql, orderBy: "" };
  const keys = parseOrderKeys(baseSql.slice(at + "ORDER BY".length));
  if (keys.length === 0) return { sql: baseSql, orderBy: "" };
  const columns = keys.map((key, index) => `(${key.expression}) AS seed_order_${index}`).join(", ");
  return {
    sql: `${select[1]}${columns}, ${baseSql.slice(select[1]!.length)}`,
    orderBy: `ORDER BY ${keys.map((key, index) => `scoped_seed.seed_order_${index} ${key.direction}`).join(", ")}`,
  };
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

  const ordered = exposeOrdering(baseSql);
  return {
    sql: `SELECT * FROM (${ordered.sql}) AS scoped_seed
          WHERE ${filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0]}
          ${ordered.orderBy}
          LIMIT $${scopedParams.length}`,
    params: scopedParams,
  };
}
