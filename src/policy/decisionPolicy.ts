import pg from 'pg';
import { z } from 'zod';
import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import { getActiveConfigRevision } from '../config/registry.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { RuleExprSchema, evaluateRuleExpr, type DecisionEvalContext, type RuleExpr } from './ruleDsl.js';

type QueryClient = {
  query: pg.PoolClient['query'];
};

export const DecisionEligibilitySchema = z.enum(['ELIGIBLE', 'VERIFY', 'INELIGIBLE']);
export type DecisionEligibility = z.infer<typeof DecisionEligibilitySchema>;

export const DecisionOutcomeSchema = z.enum(['PRIORITY', 'REVIEW', 'TRACK', 'SKIP']);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const DecisionPolicyRuleSchema = z
  .object({
    id: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    when: RuleExprSchema,
    set: z
      .object({
        eligibility: DecisionEligibilitySchema.optional(),
        outcome: DecisionOutcomeSchema.optional(),
        rationale: z.string().max(4000).optional(),
      })
      .refine((v) => Object.keys(v).length > 0, { message: 'set must assign at least one field' }),
  })
  .strict();

export type DecisionPolicyRule = z.infer<typeof DecisionPolicyRuleSchema>;

export const DecisionPolicyConfigSchema = z
  .object({
    schema_version: z.string().optional(),
    policy_version: z.string().min(1).max(100).default('decision_policy_v1'),
    eligibility_rules: z.array(DecisionPolicyRuleSchema).default([]),
    outcome_rules: z.array(DecisionPolicyRuleSchema).default([]),
    defaults: z
      .object({
        eligibility: DecisionEligibilitySchema.default('VERIFY'),
        outcome: DecisionOutcomeSchema.default('TRACK'),
      })
      .default({ eligibility: 'VERIFY', outcome: 'TRACK' }),
  })
  .passthrough();

export type DecisionPolicyConfig = z.infer<typeof DecisionPolicyConfigSchema>;

export const DEFAULT_DECISION_POLICY: DecisionPolicyConfig = {
  schema_version: '2.2.0',
  policy_version: 'decision_policy_v1',
  eligibility_rules: [
    {
      id: 'eligibility_hard_reject',
      description: 'Hard gate rejection makes the job ineligible regardless of match scores.',
      when: { op: 'eq', field: 'gate_decision', value: 'HARD_REJECT' },
      set: { eligibility: 'INELIGIBLE' },
    },
    {
      id: 'eligibility_needs_verification',
      description: 'Unknown workability facts require verification, never an ineligible decision.',
      when: { op: 'eq', field: 'gate_decision', value: 'NEEDS_VERIFICATION' },
      set: { eligibility: 'VERIFY' },
    },
    {
      id: 'eligibility_pass',
      when: { op: 'eq', field: 'gate_decision', value: 'PASS' },
      set: { eligibility: 'ELIGIBLE' },
    },
  ],
  outcome_rules: [
    {
      id: 'outcome_ineligible_skip',
      when: { op: 'eq', field: 'eligibility', value: 'INELIGIBLE' },
      set: { outcome: 'SKIP' },
    },
    {
      id: 'outcome_missing_scores_verify_review',
      when: {
        op: 'and',
        args: [
          { op: 'eq', field: 'eligibility', value: 'VERIFY' },
          {
            op: 'or',
            args: [
              { op: 'is_null', field: 'requirement_score' },
              { op: 'is_null', field: 'coverage_score' },
            ],
          },
        ],
      },
      set: { outcome: 'REVIEW' },
    },
    {
      id: 'outcome_missing_scores_track',
      when: {
        op: 'or',
        args: [
          { op: 'is_null', field: 'requirement_score' },
          { op: 'is_null', field: 'coverage_score' },
        ],
      },
      set: { outcome: 'TRACK' },
    },
    {
      id: 'outcome_priority_thresholds',
      when: {
        op: 'and',
        args: [
          { op: 'eq', field: 'eligibility', value: 'ELIGIBLE' },
          { op: 'gte', field: 'requirement_score', value: 0.75 },
          { op: 'gte', field: 'coverage_score', value: 0.55 },
          { op: 'gte', field: 'evidence_completeness', value: 0.7 },
        ],
      },
      set: { outcome: 'PRIORITY' },
    },
    {
      id: 'outcome_review_threshold',
      when: { op: 'gte', field: 'requirement_score', value: 0.5 },
      set: { outcome: 'REVIEW' },
    },
  ],
  defaults: {
    eligibility: 'VERIFY',
    outcome: 'TRACK',
  },
};

export interface LoadedDecisionPolicy {
  policy: DecisionPolicyConfig;
  policyHash: string;
  source: 'REGISTRY' | 'DEFAULT_FALLBACK';
  configRevisionId?: string;
  contentHash?: string;
}

export function hashDecisionPolicy(policy: DecisionPolicyConfig): string {
  return sha256Hex(stableStringify(policy));
}

export async function loadActiveDecisionPolicy(
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<LoadedDecisionPolicy> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const active = await getActiveConfigRevision('decision_policy', client as any, { context: ctx });

    if (!active) {
      return {
        policy: DEFAULT_DECISION_POLICY,
        policyHash: hashDecisionPolicy(DEFAULT_DECISION_POLICY),
        source: 'DEFAULT_FALLBACK',
      };
    }

    const parsed = DecisionPolicyConfigSchema.parse(active.content);
    return {
      policy: parsed,
      policyHash: active.contentHash || hashDecisionPolicy(parsed),
      source: 'REGISTRY',
      configRevisionId: active.configRevisionId,
      contentHash: active.contentHash,
    };
  } finally {
    if (ownsClient && typeof (client as any).release === 'function') {
      (client as any).release();
    }
  }
}

export interface DecisionInputs {
  gate_decision: string | null;
  requirement_score: number | null;
  coverage_score: number | null;
  evidence_completeness: number | null;
}

export interface DecisionEvaluation {
  eligibility: DecisionEligibility;
  outcome: DecisionOutcome;
  eligibilityRuleId: string | null;
  outcomeRuleId: string | null;
  notes: string[];
}

function applyRuleSet<T extends 'eligibility_rules' | 'outcome_rules'>(
  policy: DecisionPolicyConfig,
  ruleSet: T,
  ctx: DecisionEvalContext
): { eligibility?: DecisionEligibility; outcome?: DecisionOutcome; ruleId: string | null } {
  const rules = policy[ruleSet];
  for (const rule of rules) {
    if (evaluateRuleExpr(rule.when as RuleExpr, ctx)) {
      return {
        eligibility: rule.set.eligibility,
        outcome: rule.set.outcome,
        ruleId: rule.id,
      };
    }
  }
  return { ruleId: null };
}

export function evaluateDecisionPolicy(
  policy: DecisionPolicyConfig,
  inputs: DecisionInputs
): DecisionEvaluation {
  const notes: string[] = [];
  const ctx: DecisionEvalContext = {
    gate_decision: inputs.gate_decision,
    eligibility: null,
    requirement_score: inputs.requirement_score,
    coverage_score: inputs.coverage_score,
    evidence_completeness: inputs.evidence_completeness,
  };

  const eligibilityHit = applyRuleSet(policy, 'eligibility_rules', ctx);
  const eligibility = eligibilityHit.eligibility ?? policy.defaults.eligibility;
  if (!eligibilityHit.ruleId) {
    notes.push('eligibility_default_applied');
  }

  ctx.eligibility = eligibility;

  const outcomeHit = applyRuleSet(policy, 'outcome_rules', ctx);
  const outcome = outcomeHit.outcome ?? policy.defaults.outcome;
  if (!outcomeHit.ruleId) {
    notes.push('outcome_default_applied');
  }

  return {
    eligibility,
    outcome,
    eligibilityRuleId: eligibilityHit.ruleId,
    outcomeRuleId: outcomeHit.ruleId,
    notes,
  };
}

