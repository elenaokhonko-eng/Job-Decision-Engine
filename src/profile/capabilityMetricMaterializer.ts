import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { loadActiveEvidenceStrengthPolicy } from '../evidence/evidenceStrengthPolicy.js';
import { computeConceptCapabilityMetrics, type ConceptFactInput } from './capabilityMetrics.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

type QueryClient = {
  query: pg.PoolClient['query'];
};

export interface MaterializeCapabilityMetricsOptions {
  context?: WorkspaceContext;
  asOfDate: string;
}

export interface MaterializeCapabilityMetricsResult {
  profileVersionId: string;
  asOfDate: string;
  inserted: number;
  skipped: number;
  policySource: 'REGISTRY' | 'DEFAULT_FALLBACK';
  policyHash: string;
}

type EngagementRow = {
  id: string;
  start_date: string;
  end_date: string | null;
  is_current: boolean;
  hours_per_week_band: string | null;
};

type FactConceptRow = {
  profile_fact_id: string;
  fact_type: string;
  engagement_id: string | null;
  evidence_tier: string;
  verification_status: string;
  concept_id: string;
  concept_key: string;
  concept_type: string;
};

export async function materializeCapabilityMetricsForProfileVersion(
  profileVersionId: string,
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: MaterializeCapabilityMetricsOptions
): Promise<MaterializeCapabilityMetricsResult> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  let inserted = 0;
  let skipped = 0;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const asOfDate = (options?.asOfDate || '').trim();
    if (!asOfDate) {
      throw new Error('asOfDate is required (YYYY-MM-DD).');
    }

    const versionRes = await (client as QueryClient).query<{ workspace_id: string }>(
      `SELECT workspace_id
       FROM profile_versions
       WHERE id = $1
       LIMIT 1`,
      [profileVersionId]
    );
    if (versionRes.rows.length === 0) {
      throw new Error(`profile_version not found: ${profileVersionId}`);
    }
    if (versionRes.rows[0].workspace_id !== ctx.workspaceId) {
      throw new Error(
        `profile_version workspace mismatch: expected ${ctx.workspaceId} got ${versionRes.rows[0].workspace_id}`
      );
    }

    const engagementsRes = await (client as QueryClient).query<EngagementRow>(
      `SELECT id, start_date, end_date, is_current, hours_per_week_band
       FROM profile_engagements
       WHERE workspace_id = $1
         AND profile_version_id = $2`,
      [ctx.workspaceId, profileVersionId]
    );

    const factsRes = await (client as QueryClient).query<FactConceptRow>(
      `SELECT
         pf.id AS profile_fact_id,
         pf.fact_type AS fact_type,
         pf.engagement_id AS engagement_id,
         pf.evidence_tier AS evidence_tier,
         pf.verification_status AS verification_status,
         pfc.concept_id AS concept_id,
         tc.concept_key AS concept_key,
         tc.concept_type AS concept_type
       FROM profile_facts pf
       JOIN profile_fact_concepts pfc
         ON pfc.workspace_id = pf.workspace_id
        AND pfc.profile_fact_id = pf.id
       JOIN taxonomy_concepts tc
         ON tc.id = pfc.concept_id
       WHERE pf.workspace_id = $1
         AND pf.profile_version_id = $2`,
      [ctx.workspaceId, profileVersionId]
    );

    const policyLoaded = await loadActiveEvidenceStrengthPolicy(client as any, { context: ctx });
    const hoursBandWeights = policyLoaded.policy.hours_per_week_band_weights as Record<string, number>;

    const factsByConcept = new Map<
      string,
      { conceptKey: string; conceptType: string; facts: ConceptFactInput[] }
    >();

    for (const row of factsRes.rows) {
      const entry =
        factsByConcept.get(row.concept_id) || {
          conceptKey: row.concept_key,
          conceptType: row.concept_type,
          facts: [],
        };
      entry.facts.push({
        fact_id: row.profile_fact_id,
        fact_type: row.fact_type,
        engagement_id: row.engagement_id,
        evidence_tier: row.evidence_tier,
        verification_status: row.verification_status,
      });
      factsByConcept.set(row.concept_id, entry);
    }

    await client.query('BEGIN');

    for (const [conceptId, payload] of Array.from(factsByConcept.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const computed = computeConceptCapabilityMetrics({
        asOfDate,
        conceptKey: payload.conceptKey,
        conceptType: payload.conceptType,
        engagements: engagementsRes.rows.map((e) => ({
          engagement_id: e.id,
          start_date: e.start_date,
          end_date: e.end_date,
          is_current: e.is_current,
          hours_per_week_band: e.hours_per_week_band,
        })),
        facts: payload.facts,
        evidenceStrengthPolicy: policyLoaded.policy,
        hoursBandWeights,
      });

      const res = await (client as QueryClient).query(
        `INSERT INTO profile_concept_metric_snapshots (
           workspace_id,
           profile_version_id,
           concept_id,
           as_of_date,
           schema_version,
           metric_policy_version,
           metrics_hash,
           metrics,
           trace
         )
         VALUES ($1, $2, $3, $4, '2.2.0', 'capability_metrics_v1', $5, $6::jsonb, $7::jsonb)
         ON CONFLICT (profile_version_id, concept_id, as_of_date, metric_policy_version, metrics_hash) DO NOTHING`,
        [
          ctx.workspaceId,
          profileVersionId,
          conceptId,
          asOfDate,
          computed.metricsHash,
          JSON.stringify(computed.metrics),
          JSON.stringify(computed.trace),
        ]
      );

      if (res.rowCount && res.rowCount > 0) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    }

    await client.query('COMMIT');

    return {
      profileVersionId,
      asOfDate,
      inserted,
      skipped,
      policySource: policyLoaded.source,
      policyHash: policyLoaded.policyHash,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

