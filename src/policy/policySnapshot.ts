import pg from 'pg';
import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import { loadActiveEvidenceStrengthPolicy, type LoadedEvidenceStrengthPolicy } from '../evidence/evidenceStrengthPolicy.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { loadActiveDecisionPolicy, type LoadedDecisionPolicy } from './decisionPolicy.js';

type QueryClient = {
  query: pg.PoolClient['query'];
};

export interface ResolvedWorkspacePolicySnapshot {
  snapshotId: string;
  snapshotHash: string;
  resolvedSnapshot: unknown;
  decisionPolicy: LoadedDecisionPolicy;
  evidenceStrengthPolicy: LoadedEvidenceStrengthPolicy;
}

export async function resolveWorkspacePolicySnapshot(
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ResolvedWorkspacePolicySnapshot> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const decisionPolicy = await loadActiveDecisionPolicy(client as any, { context: ctx });
    const evidenceStrengthPolicy = await loadActiveEvidenceStrengthPolicy(client as any, { context: ctx });

    const resolvedSnapshot = {
      schema_version: '2.2.0',
      snapshot_version: 'workspace_policy_snapshot_v1',
      workspace_id: ctx.workspaceId,
      decision_policy: {
        source: decisionPolicy.source,
        policy_version: decisionPolicy.policy.policy_version,
        policy_hash: decisionPolicy.policyHash,
        config_revision_id: decisionPolicy.configRevisionId ?? null,
        content_hash: decisionPolicy.contentHash ?? null,
      },
      evidence_strength_policy: {
        source: evidenceStrengthPolicy.source,
        policy_key: (evidenceStrengthPolicy.policy as any).policy_key ?? 'evidence_strength_v1',
        policy_hash: evidenceStrengthPolicy.policyHash,
        config_revision_id: evidenceStrengthPolicy.configRevisionId ?? null,
      },
      engines: {
        rule_dsl: 'rule_dsl_v1',
        recommendation_decider: 'recommendation_decider_v1',
      },
    };

    const snapshotHash = sha256Hex(stableStringify(resolvedSnapshot));

    const decisionRevisionId =
      decisionPolicy.source === 'REGISTRY' ? decisionPolicy.configRevisionId ?? null : null;
    const evidenceRevisionId =
      evidenceStrengthPolicy.source === 'REGISTRY'
        ? evidenceStrengthPolicy.configRevisionId ?? null
        : null;

    const { rows } = await (client as QueryClient).query<{ id: string }>(
      `
      WITH inserted AS (
        INSERT INTO workspace_policy_snapshots (
          workspace_id,
          snapshot_hash,
          decision_policy_config_revision_id,
          evidence_strength_policy_config_revision_id,
          resolved_snapshot,
          created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (workspace_id, snapshot_hash) DO NOTHING
        RETURNING id
      )
      SELECT id FROM inserted
      UNION
      SELECT id
      FROM workspace_policy_snapshots
      WHERE workspace_id = $1
        AND snapshot_hash = $2
      LIMIT 1
      `,
      [
        ctx.workspaceId,
        snapshotHash,
        decisionRevisionId,
        evidenceRevisionId,
        JSON.stringify(resolvedSnapshot),
        ctx.userId,
      ]
    );

    if (rows.length === 0) {
      throw new Error('Failed to resolve or create workspace_policy_snapshots row.');
    }

    return {
      snapshotId: rows[0].id,
      snapshotHash,
      resolvedSnapshot,
      decisionPolicy,
      evidenceStrengthPolicy,
    };
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

