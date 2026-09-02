/**
 * Job requirements contracts
 * @description Zod schemas for requirement extraction, validation, and matching
 * @version 2.0
 */

import { z } from 'zod';

export const REQUIREMENTS_SCHEMA_VERSION = '2.0';

export const RequirementTypeSchema = z.enum([
  'OFFICE_DAYS',
  'WORK_MODE',
  'EXPERIENCE_YEARS',
  'CREDENTIAL',
  'DEGREE',
  'EMPLOYMENT_TYPE',
  'TRAVEL',
  'WORK_AUTH',
  'ON_CALL',
  'SHIFT_WORK',
  'DOMAIN',
  'FUNCTION',
  'CUSTOM',
]);

export const RequirementImportanceSchema = z.enum([
  'MUST',
  'PREFERRED',
  'NICE_TO_HAVE',
]);

export const ExtractorTypeSchema = z.enum(['DETERMINISTIC', 'LLM_QUOTED']);

export const RequirementStatusSchema = z.enum([
  'EXTRACTED',
  'VALIDATED',
  'REJECTED',
]);

export const PipelineStageSchema = z.enum([
  'NORMALIZED',
  'REQUIREMENTS_EXTRACTED',
  'GATE_EVALUATED',
  'LANE_ROUTED',
  'QUEUED_FOR_AI',
  'EVALUATING',
  'EVALUATED',
  'DOCUMENT_READY',
]);

export const PipelineStageStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'RETRY_WAIT',
  'NEEDS_MANUAL_REVIEW',
  'FAILED',
]);

export const JobRequirementSchema = z.object({
  id: z.string().uuid().optional(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  requirement_key: z.string().regex(/^R-[0-9]{3}$/),
  requirement_type: RequirementTypeSchema,
  importance: RequirementImportanceSchema,
  requirement_text: z.string().min(5).max(4000),
  quote_text: z.string().min(5).max(4000).nullable().optional(),
  quote_start_offset: z.number().int().min(0).nullable().optional(),
  quote_end_offset: z.number().int().min(0).nullable().optional(),
  structured_value: z.record(z.unknown()).nullable().optional(),
  extractor_type: ExtractorTypeSchema,
  extractor_version: z.string().min(1).max(50),
  confidence: z.number().min(0).max(1),
  status: RequirementStatusSchema.default('EXTRACTED'),
  created_at: z.date().optional(),
});

export const RequirementExtractionRunSchema = z.object({
  id: z.string().uuid().optional(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  run_type: ExtractorTypeSchema,
  provider: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  status: z.enum(['STARTED', 'COMPLETED', 'FAILED']),
  error_message: z.string().max(4000).nullable().optional(),
  requirements_extracted: z.number().int().min(0).default(0),
  response_payload: z.record(z.unknown()).nullable().optional(),
  started_at: z.date().optional(),
  completed_at: z.date().nullable().optional(),
});

export const JobVersionPipelineStateSchema = z.object({
  id: z.string().uuid().optional(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  current_stage: PipelineStageSchema,
  stage_status: PipelineStageStatusSchema,
  attempt_count: z.number().int().min(0).default(0),
  last_error: z.string().max(4000).nullable().optional(),
  next_retry_at: z.date().nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});

export const PipelineStageEventSchema = z.object({
  id: z.string().uuid().optional(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  stage: PipelineStageSchema,
  transition_from: PipelineStageStatusSchema.nullable().optional(),
  transition_to: PipelineStageStatusSchema,
  event_type: z.enum(['STAGE_ENTERED', 'STAGE_COMPLETED', 'STAGE_FAILED', 'RETRY_SCHEDULED']),
  error_message: z.string().max(4000).nullable().optional(),
  payload: z.record(z.unknown()).nullable().optional(),
  created_at: z.date().optional(),
});

export const QuotedRequirementSchema = z.object({
  requirement_key: z.string().regex(/^R-[0-9]{3}$/),
  requirement_type: RequirementTypeSchema,
  importance: RequirementImportanceSchema,
  requirement_text: z.string().min(5).max(4000),
  quote_text: z.string().min(5).max(4000),
  quote_start_offset: z.number().int().min(0).optional(),
  quote_end_offset: z.number().int().min(0).optional(),
  structured_value: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1),
});

export const QuotedRequirementExtractorResponseSchema = z.object({
  schema_version: z.string(),
  requirements: z.array(QuotedRequirementSchema).min(1).max(25),
});
