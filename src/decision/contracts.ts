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
