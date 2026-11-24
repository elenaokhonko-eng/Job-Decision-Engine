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
  /** More than one active non-fallback space, or none while inputs exist. */
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
  const inputs = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM embedding_inputs WHERE workspace_id = $1::uuid AND is_current`, [workspaceId]);
  const hasInputs = Number(inputs.rows[0]?.n ?? 0) > 0;
  return {
    activeNonFallback,
    staleSpaceIds: activeNonFallback.filter((row) => !row.isPrimary && row.publishedForCurrentInputs === 0).map((row) => row.id),
    matcherCandidateIds,
    routerCandidateIds,
    routerEqualsMatcher: [...matcherCandidateIds].sort().join() === [...routerCandidateIds].sort().join(),
    violation: activeNonFallback.length > 1 || (activeNonFallback.length === 0 && hasInputs),
  };
}

export interface DeactivateStaleSpacesResult {
  readonly dryRun: boolean;
  readonly spaceIds: readonly string[];
}

/**
 * Sets active = FALSE for a non-fallback space that is not the configured primary and holds no
 * published embedding for any current input. Dry run by default: returns what it would change.
 */
export async function deactivateStaleEmbeddingSpaces(
  db: Queryable,
  options: { workspaceId: string; dryRun?: boolean },
): Promise<DeactivateStaleSpacesResult> {
  const dryRun = options.dryRun !== false;
  const { staleSpaceIds } = await embeddingSpacePreflight(db, options.workspaceId);
  if (dryRun || staleSpaceIds.length === 0) return { dryRun, spaceIds: staleSpaceIds };
  const updated = await db.query<{ id: string }>(
    `UPDATE embedding_spaces SET active = FALSE
      WHERE workspace_id = $1::uuid AND id = ANY($2::uuid[]) AND active = TRUE AND is_fallback_space = FALSE
      RETURNING id::text AS id`,
    [options.workspaceId, [...staleSpaceIds]],
  );
  return { dryRun, spaceIds: updated.rows.map((row) => row.id) };
}
