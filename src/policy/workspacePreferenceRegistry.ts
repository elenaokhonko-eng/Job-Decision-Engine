import pg from 'pg';

import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import type { WorkspaceContext } from '../workspace/context.js';
import { LaneIntentPreferencesSchema, type LaneIntentPreferences } from './laneIntentContracts.js';
import { Stage3WorkPreferencesSchema, type Stage3WorkPreferences } from './stage3Contracts.js';

interface PreferenceRevisionRow {
  preference_domain: string;
  revision_id: string;
  schema_version: string;
  preference_value: unknown;
  preference_hash: string;
}

export interface ResolvedWorkspacePreferenceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly contextId: string | null;
  readonly contextHash: string | null;
  readonly revisionsByDomain: Readonly<Record<string, string>>;
  readonly laneIntent: LaneIntentPreferences | null;
  readonly stage3: Stage3WorkPreferences | null;
}

export interface SaveWorkspacePreferenceRevisionInput {
  readonly preferenceDomain: 'lane_intent' | 'stage3';
  readonly schemaVersion: string;
  readonly preferenceValue: unknown;
  readonly activate?: boolean;
}

export interface SavedWorkspacePreferenceRevision {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly preferenceHash: string;
  readonly activated: boolean;
}

function asJsonObject(value: unknown, domain: string): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      throw new Error(`Preference revision ${domain} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Preference revision ${domain} must contain a JSON object.`);
}

export async function resolveWorkspacePreferenceContext(
  clientOrPool: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
  preferenceDomains?: readonly string[]
): Promise<ResolvedWorkspacePreferenceContext> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
  const { rows: activeRows } = await client.query<PreferenceRevisionRow>(
    `SELECT active.preference_domain,
            revision.id AS revision_id,
            revision.schema_version,
            revision.preference_value,
            revision.preference_hash
     FROM workspace_user_preference_active_versions AS active
     JOIN workspace_user_preference_revisions AS revision
       ON revision.workspace_id = active.workspace_id
      AND revision.user_id = active.user_id
      AND revision.preference_domain = active.preference_domain
      AND revision.id = active.revision_id
     WHERE active.workspace_id = $1
       AND active.user_id = $2
     ORDER BY active.preference_domain ASC`,
    [context.workspaceId, context.userId]
  );
  const allowedDomains = preferenceDomains ? new Set(preferenceDomains) : null;
  const rows = allowedDomains
    ? activeRows.filter((row) => allowedDomains.has(row.preference_domain))
    : activeRows;

  if (rows.length === 0) {
    return {
      workspaceId: context.workspaceId,
      userId: context.userId,
      contextId: null,
      contextHash: null,
      revisionsByDomain: {},
      laneIntent: null,
      stage3: null,
    };
  }

  const revisionsByDomain: Record<string, string> = {};
  let laneIntent: LaneIntentPreferences | null = null;
  let stage3: Stage3WorkPreferences | null = null;
  for (const row of rows) {
    const preferenceValue = asJsonObject(row.preference_value, row.preference_domain);
    revisionsByDomain[row.preference_domain] = row.revision_id;
    if (row.preference_domain === 'lane_intent') {
      laneIntent = LaneIntentPreferencesSchema.parse(preferenceValue);
    } else if (row.preference_domain === 'stage3') {
      stage3 = Stage3WorkPreferencesSchema.parse(preferenceValue);
    }
  }

  const contextHash = sha256Hex(stableStringify({
    schema_version: 'workspace_preference_context_v1',
    workspace_id: context.workspaceId,
    user_id: context.userId,
    revisions: revisionsByDomain,
  }));
  const insertedContext = await client.query<{ id: string }>(
    `INSERT INTO workspace_user_preference_contexts (
       workspace_id, user_id, context_hash, created_by_user_id
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id, context_hash) DO NOTHING
     RETURNING id`,
    [context.workspaceId, context.userId, contextHash, context.userId]
  );
  const contextId = insertedContext.rows[0]?.id ?? (await client.query<{ id: string }>(
    `SELECT id
     FROM workspace_user_preference_contexts
     WHERE workspace_id = $1 AND user_id = $2 AND context_hash = $3
     LIMIT 1`,
    [context.workspaceId, context.userId, contextHash]
  )).rows[0]?.id;
  if (!contextId) throw new Error('Preference context insert succeeded without a resolvable context ID.');

  for (const [preferenceDomain, revisionId] of Object.entries(revisionsByDomain)) {
    await client.query(
      `INSERT INTO workspace_user_preference_context_revisions (
         workspace_id, user_id, context_id, preference_domain, revision_id
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (context_id, preference_domain) DO NOTHING`,
      [context.workspaceId, context.userId, contextId, preferenceDomain, revisionId]
    );
  }

  return { workspaceId: context.workspaceId, userId: context.userId, contextId, contextHash, revisionsByDomain, laneIntent, stage3 };
  } finally {
    if (ownsClient) client.release();
  }
}

export async function saveWorkspacePreferenceRevision(
  client: pg.PoolClient,
  context: WorkspaceContext,
  input: SaveWorkspacePreferenceRevisionInput
): Promise<SavedWorkspacePreferenceRevision> {
  const preferenceValue = asJsonObject(input.preferenceValue, input.preferenceDomain);
  if (input.preferenceDomain === 'lane_intent') {
    LaneIntentPreferencesSchema.parse(preferenceValue);
  } else {
    Stage3WorkPreferencesSchema.parse(preferenceValue);
  }
  const preferenceHash = sha256Hex(stableStringify(preferenceValue));

  const prior = await client.query<{ id: string; revision_number: number }>(
    `SELECT id, revision_number
     FROM workspace_user_preference_revisions
     WHERE workspace_id = $1 AND user_id = $2
       AND preference_domain = $3 AND preference_hash = $4
     ORDER BY revision_number DESC
     LIMIT 1`,
    [context.workspaceId, context.userId, input.preferenceDomain, preferenceHash]
  );
  let revisionId = prior.rows[0]?.id;
  let revisionNumber = prior.rows[0]?.revision_number;

  if (!revisionId || revisionNumber === undefined) {
    const next = await client.query<{ revision_number: number }>(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
       FROM workspace_user_preference_revisions
       WHERE workspace_id = $1 AND user_id = $2 AND preference_domain = $3`,
      [context.workspaceId, context.userId, input.preferenceDomain]
    );
    revisionNumber = next.rows[0]?.revision_number;
    if (revisionNumber === undefined) throw new Error('Could not allocate a preference revision number.');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO workspace_user_preference_revisions (
         workspace_id, user_id, preference_domain, revision_number,
         schema_version, preference_value, preference_hash, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        context.workspaceId,
        context.userId,
        input.preferenceDomain,
        revisionNumber,
        input.schemaVersion,
        JSON.stringify(preferenceValue),
        preferenceHash,
        context.userId,
      ]
    );
    revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error('Preference revision insert returned no ID.');
  }

  const activate = input.activate === true;
  if (activate) {
    await client.query(
      `INSERT INTO workspace_user_preference_active_versions (
         workspace_id, user_id, preference_domain, revision_id, activated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, user_id, preference_domain)
       DO UPDATE SET revision_id = EXCLUDED.revision_id,
                     activated_by_user_id = EXCLUDED.activated_by_user_id
       WHERE workspace_user_preference_active_versions.revision_id IS DISTINCT FROM EXCLUDED.revision_id`,
      [context.workspaceId, context.userId, input.preferenceDomain, revisionId, context.userId]
    );
  }

  return { revisionId, revisionNumber, preferenceHash, activated: activate };
}
