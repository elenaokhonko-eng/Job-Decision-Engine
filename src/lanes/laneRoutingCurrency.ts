import { sha256Hex, stableStringify } from "../config/structuredLoader.js";

/**
 * Lane revision content keys that never influence routing. A lane revision that differs from
 * another only in these keys routes every job identically, so a job routed under either one is
 * still routed under current lane content. Must stay in sync with lane_routing_content_hash()
 * in migrations/101_lane_revision_routing_content_hash.sql.
 */
export const LANE_ROUTING_EXCLUDED_CONTENT_KEYS = ["budget"] as const;

const TRUSTED_SQL_EXPRESSION = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/i;
const PARAMETER_SQL_EXPRESSION = /^\$[1-9][0-9]*(?:::[a-z_]+)?$/i;

function trustedExpression(expression: string, label: string): string {
  if (!TRUSTED_SQL_EXPRESSION.test(expression) && !PARAMETER_SQL_EXPRESSION.test(expression)) {
    throw new Error(`Lane routing SQL ${label} must be a trusted identifier or parameter.`);
  }
  return expression;
}

/**
 * Workspace-wide routing version: identical for any two sets of active lane revisions whose
 * routing content is identical, whatever their budgets or revision numbers.
 */
export function laneRoutingVersion(
  revisions: ReadonlyArray<{ laneKey: string; routingContentHash: string }>
): string {
  const seed = revisions
    .map((revision) => `${revision.laneKey}:${revision.routingContentHash}`)
    .sort()
    .join("|");
  return `lanes_routing_${sha256Hex(stableStringify(seed)).slice(0, 16)}`;
}

/**
 * SQL subquery returning (lane_key, routing_content_hash) for the live active lane revisions
 * of a workspace.
 */
export function workspaceActiveLaneRoutingSql(workspaceExpression: string): string {
  const workspace = trustedExpression(workspaceExpression, "workspace expression");
  return `(
    SELECT active_identity.lane_key, active_revision.routing_content_hash
    FROM lane_identities active_identity
    JOIN lane_active_revisions active_pointer
      ON active_pointer.lane_identity_id = active_identity.id
    JOIN lane_revisions active_revision
      ON active_revision.id = active_pointer.lane_revision_id
    WHERE active_identity.workspace_id = ${workspace}
      AND active_identity.status = 'ACTIVE'
  )`;
}

/**
 * SQL predicate: TRUE when a LANE_REGISTRY_DB lane snapshot (lane_decisions.lane_snapshot) was
 * routed under lane content that is routing-identical to the given active lane set. Every active
 * lane must appear in the snapshot with a revision of the same lane whose routing_content_hash
 * equals the active one, and the snapshot must not contain lanes that are no longer active.
 * Budget-only revisions therefore keep a route current; any change to routing content, or a lane
 * being added or deactivated, makes it stale. Missing or malformed snapshots are never current.
 *
 * `activeLanesSql` must be a parenthesised subquery returning (lane_key, routing_content_hash).
 */
export function laneRoutingCurrentSql(laneSnapshotExpression: string, activeLanesSql: string): string {
  const snapshot = trustedExpression(laneSnapshotExpression, "lane snapshot expression");
  return `(
    ${snapshot}->>'source' = 'LANE_REGISTRY_DB'
    AND jsonb_typeof(${snapshot}->'active_lane_revisions') = 'array'
    AND jsonb_array_length(${snapshot}->'active_lane_revisions') > 0
    AND EXISTS (SELECT 1 FROM ${activeLanesSql} routing_active_probe)
    AND NOT EXISTS (
      SELECT 1
      FROM (
        SELECT routed_entry.value->>'lane_key' AS lane_key,
               routed_revision.routing_content_hash
        FROM jsonb_array_elements(${snapshot}->'active_lane_revisions') AS routed_entry(value)
        LEFT JOIN lane_revisions routed_revision
          ON routed_revision.id::text = routed_entry.value->>'lane_revision_id'
         AND EXISTS (
           SELECT 1
           FROM lane_identities routed_identity
           WHERE routed_identity.id = routed_revision.lane_identity_id
             AND routed_identity.lane_key = routed_entry.value->>'lane_key'
         )
      ) routed_lane
      FULL OUTER JOIN ${activeLanesSql} active_lane
        ON active_lane.lane_key = routed_lane.lane_key
      WHERE routed_lane.lane_key IS NULL
         OR active_lane.lane_key IS NULL
         OR routed_lane.routing_content_hash IS NULL
         OR active_lane.routing_content_hash IS NULL
         OR routed_lane.routing_content_hash <> active_lane.routing_content_hash
    )
  )`;
}
