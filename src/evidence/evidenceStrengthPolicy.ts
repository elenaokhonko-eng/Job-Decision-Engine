import pg from 'pg';
import { z } from 'zod';
import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import { getActiveConfigRevision } from '../config/registry.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';

type QueryClient = {
  query: pg.PoolClient['query'];
};

export const EvidenceTierSchema = z.enum([
  'PROFESSIONAL_PRODUCTION',
  'DEPLOYED_OPEN_SOURCE',
  'APPLIED_PROJECT',
  'COURSE_PROJECT',
  'KNOWLEDGE_ONLY',
]);

export const VerificationStatusSchema = z.enum(['VERIFIED', 'SELF_ATTESTED', 'UNVERIFIED']);

export const HoursPerWeekBandSchema = z.enum(['FULL_TIME', 'SUBSTANTIAL_PART_TIME', 'LIMITED']);

export const EvidenceStrengthPolicySchema = z
  .object({
    schema_version: z.string().optional(),
    policy_key: z.string().optional(),
    evidence_tier_weights: z.record(EvidenceTierSchema, z.number()).default({}),
    verification_status_weights: z.record(VerificationStatusSchema, z.number()).default({}),
    hours_per_week_band_weights: z.record(HoursPerWeekBandSchema, z.number()).default({}),
  })
  .passthrough();

export type EvidenceStrengthPolicy = z.infer<typeof EvidenceStrengthPolicySchema>;

export const DEFAULT_EVIDENCE_STRENGTH_POLICY: EvidenceStrengthPolicy = {
  schema_version: '2.2.0',
  policy_key: 'evidence_strength_v1',
  evidence_tier_weights: {
    PROFESSIONAL_PRODUCTION: 1.0,
    DEPLOYED_OPEN_SOURCE: 0.8,
    APPLIED_PROJECT: 0.6,
    COURSE_PROJECT: 0.3,
    KNOWLEDGE_ONLY: 0.1,
  },
  verification_status_weights: {
    VERIFIED: 1.0,
    SELF_ATTESTED: 0.7,
    UNVERIFIED: 0.4,
  },
  hours_per_week_band_weights: {
    FULL_TIME: 1.0,
    SUBSTANTIAL_PART_TIME: 0.6,
    LIMITED: 0.3,
  },
};

export interface LoadedEvidenceStrengthPolicy {
  policy: EvidenceStrengthPolicy;
  policyHash: string;
  source: 'REGISTRY' | 'DEFAULT_FALLBACK';
  configRevisionId?: string;
}

export function hashEvidenceStrengthPolicy(policy: EvidenceStrengthPolicy): string {
  return sha256Hex(stableStringify(policy));
}

export async function loadActiveEvidenceStrengthPolicy(
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<LoadedEvidenceStrengthPolicy> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const active = await getActiveConfigRevision('evidence_strength', client as any, { context: ctx });

    if (!active) {
      return {
        policy: DEFAULT_EVIDENCE_STRENGTH_POLICY,
        policyHash: hashEvidenceStrengthPolicy(DEFAULT_EVIDENCE_STRENGTH_POLICY),
        source: 'DEFAULT_FALLBACK',
      };
    }

    const parsed = EvidenceStrengthPolicySchema.parse(active.content);

    return {
      policy: parsed,
      policyHash: active.contentHash || hashEvidenceStrengthPolicy(parsed),
      source: 'REGISTRY',
      configRevisionId: active.configRevisionId,
    };
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

export function computeEvidenceStrength(
  evidenceTier: z.infer<typeof EvidenceTierSchema>,
  verificationStatus: z.infer<typeof VerificationStatusSchema>,
  policy: EvidenceStrengthPolicy
): number {
  const tierWeight = policy.evidence_tier_weights[evidenceTier] ?? 0;
  const verificationWeight = policy.verification_status_weights[verificationStatus] ?? 0;
  const strength = tierWeight * verificationWeight;
  return Math.max(0, Math.min(1, Number(strength.toFixed(6))));
}

