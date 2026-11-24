/**
 * Stale embedding spaces: a non-fallback active space that is not the configured primary. Two matcher
 * and router lookups read "the active primary space"; a second active non-fallback space makes that
 * ambiguous (the matcher then refuses the space when it finds two rows). This module reports the state
 * (read only) and deactivates a stale space that holds no published embedding for any current input.
 * Deactivation is additive and reversible (active = TRUE restores it); nothing is deleted.
 */
import type pg from "pg";

import { getEmbeddingSpaceRegistryConfiguration } from "./spaceRegistry.js";

type Queryable = Pick<pg.PoolClient, "query">;

export interface ActiveSpaceRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly isPrimary: boolean;
  readonly publishedForCurrentInputs: number;
}

export interface EmbeddingSpacePreflight {
  readonly activeNonFallback: readonly ActiveSpaceRow[];
  readonly staleSpaceIds: readonly string[];
  /** Spaces the matcher accepts: exactly one row per configured space, all of provider/model/dimensions/normalization/metric. */
  readonly matcherCandidateIds: readonly string[];
  /** Spaces the lane router reads: any active space with the configured primary or fallback provider and model. */
  readonly routerCandidateIds: readonly string[];
  readonly routerEqualsMatcher: boolean;
  /**
   * More than one active non-fallback space, or exactly one that is not the configured primary
   * (provider, model, dimensions). No active non-fallback space is not a violation: a fresh workspace
   * before seedEmbeddingSpaces runs, or one that has only the fallback space, is a state to repair by
   * seeding, not a permanent integrity failure.
   */
  readonly violation: boolean;
}

export async function embeddingSpacePreflight(db: Queryable, workspaceId: string): Promise<EmbeddingSpacePreflight> {
  const configuration = getEmbeddingSpaceRegistryConfiguration();
  const { rows } = await db.query<{
    id: string; provider: string; model: string; dimensions: number; is_fallback_space: boolean;
    normalization: string; distance_metric: string; published: string;
  }>(
    `SELECT sp.id::text AS id, sp.provider, sp.model, sp.dimensions, sp.is_fallback_space, sp.normalization, sp.distance_metric,
            (SELECT COUNT(*) FROM embedding_inputs ei
              WHERE ei.workspace_id = sp.workspace_id AND ei.is_current
                AND EXISTS (SELECT 1 FROM v_published_semantic_embeddings se
                             WHERE se.workspace_id = ei.workspace_id AND se.embedding_input_id = ei.id AND se.embedding_space_id = sp.id))::text AS published
       FROM embedding_spaces sp
      WHERE sp.workspace_id = $1::uuid AND sp.active = TRUE
      ORDER BY sp.created_at, sp.id`,
    [workspaceId],
  );
  const same = (value: string, other: string) => value.toLowerCase() === other.toLowerCase();
  const isPrimary = (row: (typeof rows)[number]) =>
    same(row.provider, configuration.primary.provider) && row.model === configuration.primary.model && Number(row.dimensions) === configuration.primary.dimensions;
  const nonFallback = rows.filter((row) => !row.is_fallback_space);
  const activeNonFallback: ActiveSpaceRow[] = nonFallback.map((row) => ({
    id: row.id, provider: row.provider, model: row.model, dimensions: Number(row.dimensions),
    isPrimary: isPrimary(row), publishedForCurrentInputs: Number(row.published),
  }));
  const strict = (spec: { provider: string; model: string; dimensions: number }, fallback: boolean) =>
    rows.filter((row) => row.is_fallback_space === fallback && same(row.provider, spec.provider) && row.model === spec.model &&
      Number(row.dimensions) === spec.dimensions && row.normalization === configuration.normalization && row.distance_metric === configuration.distanceMetric);
  const matcherPrimary = strict(configuration.primary, false);
  const matcherFallback = strict(configuration.fallback, true);
  const matcherCandidateIds = [
    ...(matcherPrimary.length === 1 ? [matcherPrimary[0]!.id] : []),
    ...(matcherFallback.length === 1 ? [matcherFallback[0]!.id] : []),
  ];
  const routerCandidateIds = rows
    .filter((row) => (same(row.provider, configuration.primary.provider) && row.model === configuration.primary.model) ||
      (same(row.provider, configuration.fallback.provider) && row.model === configuration.fallback.model))
    .map((row) => row.id);
  return {
    activeNonFallback,
    staleSpaceIds: activeNonFallback.filter((row) => !row.isPrimary && row.publishedForCurrentInputs === 0).map((row) => row.id),
    matcherCandidateIds,
    routerCandidateIds,
    routerEqualsMatcher: [...matcherCandidateIds].sort().join() === [...routerCandidateIds].sort().join(),
    violation: activeNonFallback.length > 1 || (activeNonFallback.length === 1 && !activeNonFallback[0]!.isPrimary),
  };
}

export interface DeactivatedSpaceAudit {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
}

export interface DeactivateStaleSpacesResult {
  readonly dryRun: boolean;
  readonly spaceIds: readonly string[];
  /** One entry per space the call deactivated (apply) or would deactivate (dry run). Ids and model names only. */
  readonly audit: readonly DeactivatedSpaceAudit[];
  /** Set when nothing may be deactivated; apply throws with this text, a dry run reports it. */
  readonly refusedReason: string | null;
}

/**
 * Sets active = FALSE for a non-fallback space that is not the configured primary and holds no
 * embedding at all. Dry run by default. Apply needs `confirm: true` and refuses unless the configured
 * primary space exists, is active, and already holds published embeddings for current inputs (the
 * configuration is then evidenced by data, so a mis-set primary cannot deactivate the real one).
 * The active rows are locked, and the UPDATE re-checks every condition.
 * Layering: this function enforces only `confirm: true` (plus the data checks above). It does NOT know which
 * database it is connected to; the replay-branch and environment guards live in the script path
 * (deactivationRun.ts / deactivationGuards.ts) and must run before any call.
 */
export async function deactivateStaleEmbeddingSpaces(
  db: Queryable,
  options: { workspaceId: string; dryRun?: boolean; confirm?: boolean },
): Promise<DeactivateStaleSpacesResult> {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== true) {
    throw new Error("Refusing to deactivate embedding spaces without an explicit confirm: true option.");
  }
  const configuration = getEmbeddingSpaceRegistryConfiguration();
  // Lock every active space of the workspace so a concurrent seed or publish cannot change the picture mid-decision.
  await db.query(`SELECT id FROM embedding_spaces WHERE workspace_id = $1::uuid AND active = TRUE ORDER BY id FOR UPDATE`, [options.workspaceId]);
  const refuse = (reason: string): DeactivateStaleSpacesResult => {
    if (!dryRun) throw new Error(`Refusing to deactivate embedding spaces: ${reason}`);
    return { dryRun, spaceIds: [], audit: [], refusedReason: reason };
  };
  const preflight = await embeddingSpacePreflight(db, options.workspaceId);
  const primary = preflight.activeNonFallback.find((row) => row.isPrimary);
  if (!primary) return refuse("the configured primary embedding space does not exist or is not active in this workspace.");
  if (primary.publishedForCurrentInputs === 0) {
    return refuse("the configured primary embedding space holds no published embedding for current inputs, so the configuration is not evidenced by data.");
  }
  const candidates = preflight.activeNonFallback.filter((row) => !row.isPrimary && row.publishedForCurrentInputs === 0);
  if (dryRun) {
    const rows = await db.query<{ id: string }>(
      `SELECT sp.id::text AS id FROM embedding_spaces sp
        WHERE sp.workspace_id = $1::uuid AND sp.id = ANY($2::uuid[]) AND sp.active = TRUE AND sp.is_fallback_space = FALSE
          AND NOT EXISTS (SELECT 1 FROM semantic_embeddings e WHERE e.workspace_id = sp.workspace_id AND e.embedding_space_id = sp.id)
        ORDER BY sp.id`,
      [options.workspaceId, candidates.map((row) => row.id)],
    );
    const ids = new Set(rows.rows.map((row) => row.id));
    const audit = candidates.filter((row) => ids.has(row.id)).map(({ id, provider, model, dimensions }) => ({ id, provider, model, dimensions }));
    return { dryRun, spaceIds: audit.map((row) => row.id), audit, refusedReason: null };
  }
  const updated = await db.query<{ id: string; provider: string; model: string; dimensions: number }>(
    `UPDATE embedding_spaces sp SET active = FALSE
      WHERE sp.workspace_id = $1::uuid AND sp.id = ANY($2::uuid[]) AND sp.active = TRUE AND sp.is_fallback_space = FALSE
        AND NOT (LOWER(sp.provider) = LOWER($3) AND sp.model = $4 AND sp.dimensions = $5)
        AND NOT EXISTS (SELECT 1 FROM semantic_embeddings e WHERE e.workspace_id = sp.workspace_id AND e.embedding_space_id = sp.id)
        AND EXISTS (SELECT 1 FROM embedding_spaces pr
                     WHERE pr.workspace_id = sp.workspace_id AND pr.id = $6::uuid AND pr.active = TRUE AND pr.is_fallback_space = FALSE
                       AND LOWER(pr.provider) = LOWER($3) AND pr.model = $4 AND pr.dimensions = $5)
      RETURNING sp.id::text AS id, sp.provider, sp.model, sp.dimensions`,
    [options.workspaceId, candidates.map((row) => row.id), configuration.primary.provider, configuration.primary.model, configuration.primary.dimensions, primary.id],
  );
  const audit = updated.rows.map((row) => ({ id: row.id, provider: row.provider, model: row.model, dimensions: Number(row.dimensions) }));
  // No fitting events table exists; the returned audit list plus this line (ids and model names only) is the record.
  console.log(`embedding_space_deactivation workspace=${options.workspaceId} primary=${primary.id} deactivated=${audit.map((row) => row.id).join(",") || "none"}`);
  return { dryRun, spaceIds: audit.map((row) => row.id), audit, refusedReason: null };
}
