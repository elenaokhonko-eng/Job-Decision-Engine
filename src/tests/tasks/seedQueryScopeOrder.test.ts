import { describe, expect, it } from "vitest";

import { scopeSeedQuery } from "../../tasks/seedQueryScope.js";

const seed = (orderBy: string) => `SELECT c.id AS canonical_job_id, jv.id AS job_version_id
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.canonical_job_id = c.id
       WHERE c.workspace_id = $1
       -- a comment with (unbalanced parenthesis and ORDER BY inside
       ${orderBy}
       LIMIT $2`;

describe("scopeSeedQuery keeps the seed ordering on the wrapper", () => {
  it("orders the wrapper by the seed's own ORDER BY, so the cap cannot pick an arbitrary subset", () => {
    const scoped = scopeSeedQuery(seed("ORDER BY jv.observed_at ASC"), ["ws", 200], { jobVersionIds: ["v1"] }, 2);
    expect(scoped.sql).toMatch(/\(jv\.observed_at\) AS seed_order_0/);
    expect(scoped.sql).toMatch(/ORDER BY scoped_seed\.seed_order_0 ASC\s+LIMIT \$3/);
  });
  it("handles several keys, directions, NULLS and CASE expressions with commas inside function calls", () => {
    const scoped = scopeSeedQuery(
      seed("ORDER BY CASE c.recommendation_outcome WHEN 'PRIORITY' THEN 0 ELSE COALESCE(c.rank, 2) END, c.updated_at DESC NULLS LAST, c.id"),
      ["ws", 200], { jobVersionIds: ["v1"] }, 2);
    expect(scoped.sql).toMatch(/ORDER BY scoped_seed\.seed_order_0 ASC, scoped_seed\.seed_order_1 DESC NULLS LAST, scoped_seed\.seed_order_2 ASC\s+LIMIT/);
  });
  it("a seed without ORDER BY gets none added", () => {
    const scoped = scopeSeedQuery("SELECT 'v'::text AS job_version_id WHERE $1::text = 'w' LIMIT $2", ["w", 5], { jobVersionIds: ["v"] }, 1);
    expect(scoped.sql).not.toMatch(/ORDER BY/i);
  });
});
