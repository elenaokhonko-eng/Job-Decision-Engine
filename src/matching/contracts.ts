/**
 * Matching engine contracts
 * @description Zod schemas for requirement-evidence matching and scoring
 * @version 2.0
 */

import { z } from 'zod';

export const MATCHING_SCHEMA_VERSION = '2.0';

export const MatchRunStatusSchema = z.enum(['STARTED', 'COMPLETED', 'FAILED']);
export const MatchTypeSchema = z.enum(['EXACT', 'SEMANTIC', 'NO_MATCH', 'UNKNOWN']);

export const MatchRunSchema = z.object({
  id: z.string().uuid().optional(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  profile_version_id: z.string().uuid(),
  embedding_space_id: z.string().uuid().nullable().optional(),
  status: MatchRunStatusSchema,
  requirement_count: z.number().int().min(0),
  matched_count: z.number().int().min(0),
  coverage_score: z.number().min(0).max(100),
  overall_match_score: z.number().min(0).max(100),
  policy_version: z.string().min(1).max(100),
  error_message: z.string().max(4000).nullable().optional(),
  started_at: z.date().optional(),
  completed_at: z.date().nullable().optional(),
});

export const RequirementEvidenceMatchSchema = z.object({
  id: z.string().uuid().optional(),
  match_run_id: z.string().uuid(),
  requirement_id: z.string().uuid(),
  profile_fact_id: z.string().uuid().nullable().optional(),
  match_type: MatchTypeSchema,
  match_score: z.number().min(0).max(1),
  rationale: z.string().max(4000).nullable().optional(),
  evidence: z.record(z.unknown()).nullable().optional(),
  created_at: z.date().optional(),
});

export const MatchScoringSchema = z.object({
  matched_requirements: z.number().int().min(0),
  total_requirements: z.number().int().min(0),
  coverage_score: z.number().min(0).max(100),
  overall_match_score: z.number().min(0).max(100),
});

export const MatchingContractPlaceholder = z.object({
  schema_version: z.literal(MATCHING_SCHEMA_VERSION).default(MATCHING_SCHEMA_VERSION),
  run: MatchRunSchema,
  matches: z.array(RequirementEvidenceMatchSchema),
  scoring: MatchScoringSchema,
});
