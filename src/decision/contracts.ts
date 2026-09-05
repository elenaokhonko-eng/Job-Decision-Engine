/**
 * Deterministic decision engine contracts
 * @description Zod schemas for workability, qualification, and final decision logic
 * @version 2.2.0
 */

import { z } from 'zod';
import { SCHEMA_VERSION as CONTRACT_SCHEMA_VERSION, SchemaVersionSchema } from '../contracts/version.js';

export const DECISION_SCHEMA_VERSION = CONTRACT_SCHEMA_VERSION;

export const WorkabilityDecisionSchema = z.object({
  status: z.enum(['PASS', 'NEEDS_VERIFICATION', 'HARD_REJECT']),
  rejection_codes: z.array(z.string()).default([]),
  evidence_quotes: z.array(z.string()).default([]),
});

export const QualificationDecisionSchema = z.object({
  status: z.enum(['STRONG_FIT', 'MODERATE_FIT', 'WEAK_FIT', 'NO_FIT']),
  overall_match_score: z.number().min(0).max(100),
  coverage_score: z.number().min(0).max(100),
  matched_requirement_count: z.number().int().min(0),
  total_requirement_count: z.number().int().min(0),
});

export const DeterministicDecisionSchema = z.object({
  schema_version: SchemaVersionSchema.default(DECISION_SCHEMA_VERSION),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  match_run_id: z.string().uuid(),
  workability: WorkabilityDecisionSchema,
  qualification: QualificationDecisionSchema,
  decision_label: z.enum(['ADVANCE', 'DEFER', 'REJECT']),
  rationale: z.string().min(1).max(4000),
  created_at: z.date().optional(),
});

export const DecisionPolicySchema = z.object({
  policy_version: z.string().min(1).max(100),
  strong_fit_min_score: z.number().min(0).max(100).default(75),
  moderate_fit_min_score: z.number().min(0).max(100).default(60),
  minimum_coverage_pct: z.number().min(0).max(100).default(40),
});

export const DecisionContractPlaceholder = z.object({
  schema_version: SchemaVersionSchema.default(DECISION_SCHEMA_VERSION),
  decision: DeterministicDecisionSchema,
  policy: DecisionPolicySchema,
});

// ---------------------------------------------------------------------------
// P6: Policy snapshots + deterministic recommendation decisions (policy-driven)
// ---------------------------------------------------------------------------

export const RecommendationEligibilitySchema = z.enum(['ELIGIBLE', 'VERIFY', 'INELIGIBLE']);
export const RecommendationOutcomeSchema = z.enum(['PRIORITY', 'REVIEW', 'TRACK', 'SKIP']);

export const RecommendationDecisionInputsSchema = z.object({
  gate_decision: z.enum(['PASS', 'NEEDS_VERIFICATION', 'HARD_REJECT']).nullable(),
  requirement_score: z.number().min(0).max(1).nullable(),
  coverage_score: z.number().min(0).max(1).nullable(),
  evidence_completeness: z.number().min(0).max(1).nullable(),
});

export const RecommendationDecisionOutputsSchema = z.object({
  eligibility: RecommendationEligibilitySchema,
  outcome: RecommendationOutcomeSchema,
  recommendation_requirement_score: z.number().min(0).max(1).nullable(),
  recommendation_coverage_score: z.number().min(0).max(1).nullable(),
  recommendation_evidence_completeness: z.number().min(0).max(1).nullable(),
});

export const RecommendationDecisionTraceSchema = z.object({
  policy_version: z.string().min(1).max(100),
  policy_hash: z.string().min(1).max(200),
  policy_snapshot_id: z.string().uuid(),
  eligibility_rule_id: z.string().nullable(),
  outcome_rule_id: z.string().nullable(),
  notes: z.array(z.string()).default([]),
});

export const RecommendationDecisionSchema = z.object({
  schema_version: SchemaVersionSchema.default(DECISION_SCHEMA_VERSION),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  match_run_id: z.string().uuid().nullable(),
  inputs: RecommendationDecisionInputsSchema,
  outputs: RecommendationDecisionOutputsSchema,
  trace: RecommendationDecisionTraceSchema,
  created_at: z.date().optional(),
});
