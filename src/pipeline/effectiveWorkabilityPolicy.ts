import type pg from "pg";
import { sha256Hex, stableStringify } from "../config/structuredLoader.js";
import { Stage3WorkPreferencesSchema, type Stage3PolicyPreferences } from "../policy/stage3Contracts.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import {
  resolveWorkspaceWorkabilityPolicy,
  withOnsiteExceptionEmployers,
  type WorkabilityPolicy,
  type WorkspaceWorkabilityPolicyResolution,
} from "./workabilityPolicy.js";

/**
 * The one workability policy that every stage uses: the hard gate, the
 * recommendation decider (readiness) and the discovery pre-filters. It is the
 * workspace policy plus the user's on-site exception employers from the stage3
 * preference `mobility.onsite_exception_employers`. Gate, decision and
 * readiness rows therefore carry the same `workability_policy_hash`.
 */
export function resolveOnsiteExceptionPolicy<T extends { policy: WorkabilityPolicy; policyHash: string }>(
  resolution: T,
  stage3Preferences: Stage3PolicyPreferences | null | undefined,
): T {
  const policy = withOnsiteExceptionEmployers(resolution.policy, stage3Preferences?.mobility?.onsite_exception_employers);
  // Without a list the resolution is returned unchanged; with one, the hash
  // also covers the list so a list change is visible in every stored row.
  if (policy === resolution.policy) return resolution;
  return {
    ...resolution,
    policy,
    policyHash: sha256Hex(stableStringify({
      base_policy_hash: resolution.policyHash,
      onsite_exception_employers: policy.onsiteExceptionEmployers,
    })),
  };
}

/**
 * Read the active stage3 preference without creating a preference context row.
 * Absent tables or rows mean no stage3 preference.
 */
export async function loadActiveStage3Preferences(
  client: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
): Promise<Stage3PolicyPreferences | null> {
  try {
    const { rows } = await client.query<{ preference_value: unknown }>(
      `SELECT revision.preference_value
       FROM workspace_user_preference_active_versions AS active
       JOIN workspace_user_preference_revisions AS revision
         ON revision.workspace_id = active.workspace_id
        AND revision.user_id = active.user_id
        AND revision.preference_domain = active.preference_domain
        AND revision.id = active.revision_id
       WHERE active.workspace_id = $1
         AND active.user_id = $2
         AND active.preference_domain = 'stage3'
       LIMIT 1`,
      [context.workspaceId, context.userId],
    );
    const value = rows[0]?.preference_value;
    if (value === undefined || value === null) return null;
    return Stage3WorkPreferencesSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
  } catch (error: any) {
    if (error?.code === "42P01" || error?.code === "42703") return null;
    throw error;
  }
}

/**
 * Resolve the effective workability policy. Callers that already loaded the
 * stage3 preference pass it in; otherwise it is read without side effects.
 */
export async function resolveEffectiveWorkabilityPolicy(
  client: pg.Pool | pg.PoolClient,
  options: { context?: WorkspaceContext; stage3?: Stage3PolicyPreferences | null } = {},
): Promise<WorkspaceWorkabilityPolicyResolution> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(client);
  const connection = ownsClient ? await client.connect() : client;
  try {
    const context = options.context ?? (await resolveWorkspaceContext(connection as any));
    const base = await resolveWorkspaceWorkabilityPolicy(connection, { context });
    const stage3 = options.stage3 !== undefined ? options.stage3 : await loadActiveStage3Preferences(connection, context);
    return resolveOnsiteExceptionPolicy(base, stage3);
  } finally {
    if (ownsClient && typeof (connection as any).release === "function") (connection as any).release();
  }
}
