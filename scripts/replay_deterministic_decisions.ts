import dotenv from 'dotenv';
import pg from 'pg';
import { pgSslConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';
import {
  DecisionPolicyConfigSchema,
  DEFAULT_DECISION_POLICY,
  evaluateDecisionPolicy,
  hashDecisionPolicy,
} from '../src/policy/decisionPolicy.js';
import { RecommendationDecisionSchema } from '../src/decision/contracts.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

type SnapshotRow = {
  id: string;
  resolved_snapshot: any;
};

function parseArgs(argv: string[]): { snapshotId?: string; snapshotHash?: string } {
  const out: { snapshotId?: string; snapshotHash?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snapshot-id' && argv[i + 1]) {
      out.snapshotId = argv[i + 1];
      i++;
    } else if (a === '--snapshot-hash' && argv[i + 1]) {
      out.snapshotHash = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function loadSnapshot(
  client: pg.PoolClient,
  workspaceId: string,
  args: { snapshotId?: string; snapshotHash?: string }
): Promise<SnapshotRow> {
  if (args.snapshotId) {
    const { rows } = await client.query<SnapshotRow>(
      `SELECT id, resolved_snapshot
       FROM workspace_policy_snapshots
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [workspaceId, args.snapshotId]
    );
    if (rows.length === 0) throw new Error(`Snapshot not found: ${args.snapshotId}`);
    return rows[0];
  }

  if (args.snapshotHash) {
    const { rows } = await client.query<SnapshotRow>(
      `SELECT id, resolved_snapshot
       FROM workspace_policy_snapshots
       WHERE workspace_id = $1 AND snapshot_hash = $2
       LIMIT 1`,
      [workspaceId, args.snapshotHash]
    );
    if (rows.length === 0) throw new Error(`Snapshot not found for hash: ${args.snapshotHash}`);
    return rows[0];
  }

  const { rows } = await client.query<SnapshotRow>(
    `SELECT id, resolved_snapshot
     FROM workspace_policy_snapshots
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId]
  );
  if (rows.length === 0) {
    throw new Error('No workspace_policy_snapshots found. Run the recommendation decider first.');
  }
  return rows[0];
}

async function loadDecisionPolicyForSnapshot(
  client: pg.PoolClient,
  snapshot: SnapshotRow
): Promise<{ policy: any; policyHash: string; policyVersion: string }> {
  const decisionPolicyInfo = snapshot.resolved_snapshot?.decision_policy;
  const source = String(decisionPolicyInfo?.source || 'DEFAULT_FALLBACK');
  const revisionId = decisionPolicyInfo?.config_revision_id as string | null | undefined;

  if (source !== 'REGISTRY' || !revisionId) {
    return {
      policy: DEFAULT_DECISION_POLICY,
      policyHash: hashDecisionPolicy(DEFAULT_DECISION_POLICY),
      policyVersion: DEFAULT_DECISION_POLICY.policy_version,
    };
  }

  const { rows } = await client.query<{ content: unknown; content_hash: string }>(
    `SELECT content, content_hash
     FROM config_revisions
     WHERE id = $1
     LIMIT 1`,
    [revisionId]
  );
  if (rows.length === 0) {
    throw new Error(`Decision policy config revision not found: ${revisionId}`);
  }

  const parsed = DecisionPolicyConfigSchema.parse(rows[0].content);
  return {
    policy: parsed,
    policyHash: rows[0].content_hash || hashDecisionPolicy(parsed),
    policyVersion: parsed.policy_version,
  };
}

async function main(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: pgSslConfig(process.env.DATABASE_URL),
  });

  const client = await pool.connect();
  try {
    const ctx = await resolveWorkspaceContext(client as any);
    const args = parseArgs(process.argv.slice(2));

    const snapshot = await loadSnapshot(client, ctx.workspaceId, args);
    const { policy, policyHash, policyVersion } = await loadDecisionPolicyForSnapshot(client, snapshot);

    const { rows: decisions } = await client.query<{ id: string; decision_json: any }>(
      `SELECT id, decision_json
       FROM deterministic_decisions
       WHERE workspace_id = $1
         AND policy_snapshot_id = $2
       ORDER BY created_at ASC`,
      [ctx.workspaceId, snapshot.id]
    );

    if (decisions.length === 0) {
      console.log('No deterministic_decisions found for this snapshot.');
      return;
    }

    let mismatches = 0;

    for (const row of decisions) {
      const stored = RecommendationDecisionSchema.parse(row.decision_json);
      const evaluation = evaluateDecisionPolicy(policy, stored.inputs);

      const okEligibility = evaluation.eligibility === stored.outputs.eligibility;
      const okOutcome = evaluation.outcome === stored.outputs.outcome;
      const okRuleIds =
        evaluation.eligibilityRuleId === stored.trace.eligibility_rule_id &&
        evaluation.outcomeRuleId === stored.trace.outcome_rule_id;

      const okPolicy =
        stored.trace.policy_hash === policyHash && stored.trace.policy_version === policyVersion;

      if (!okEligibility || !okOutcome || !okRuleIds || !okPolicy) {
        mismatches += 1;
        console.log(`Mismatch decision ${row.id}:`);
        if (!okPolicy) {
          console.log(
            `  policy: expected version=${policyVersion} hash=${policyHash} got version=${stored.trace.policy_version} hash=${stored.trace.policy_hash}`
          );
        }
        if (!okEligibility) {
          console.log(`  eligibility: expected ${evaluation.eligibility} got ${stored.outputs.eligibility}`);
        }
        if (!okOutcome) {
          console.log(`  outcome: expected ${evaluation.outcome} got ${stored.outputs.outcome}`);
        }
        if (!okRuleIds) {
          console.log(
            `  rules: expected eligibility=${evaluation.eligibilityRuleId} outcome=${evaluation.outcomeRuleId} got eligibility=${stored.trace.eligibility_rule_id} outcome=${stored.trace.outcome_rule_id}`
          );
        }
      }
    }

    if (mismatches > 0) {
      console.error(`❌ Replay failed: ${mismatches} decision(s) mismatched.`);
      process.exitCode = 1;
      return;
    }

    console.log(`✅ Replay OK: ${decisions.length} decision(s) matched the policy snapshot.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Replay failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

