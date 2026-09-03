/**
 * Read model contracts
 * @description Zod schemas for Streamlit and report consumers of canonical data
 * @version 2.0
 */

import { z } from 'zod';

export const READ_MODEL_SCHEMA_VERSION = '2.0';

export const ShortlistRowV2Schema = z.object({
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  title: z.string().min(1),
  company: z.string().min(1),
  canonical_url: z.string().min(1),
  source: z.string().min(1),
  location: z.string().min(1),
  workplace_type: z.string().min(1),
  employment_type: z.string().min(1),
  description: z.string().nullable(),
  gate_status: z.enum(['PASS', 'NEEDS_VERIFICATION', 'HARD_REJECT']),
  rejection_codes: z.array(z.string()).nullable(),
  gate_evidence_quotes: z.array(z.string()).nullable(),
  primary_lane: z.string().nullable(),
  secondary_lanes: z.array(z.string()).default([]),
  lane_confidence: z.string().default('None'),
  priority_score: z.number(),
  deterministic_match_score: z.number().nullable().default(null),
  deterministic_match_coverage: z.number().nullable().default(null),
  processing_status: z.string(),
  nd_friendly_score: z.number().nullable().default(null),
  politics_stress_score: z.number().nullable().default(null),
  sensory_overload_index: z.number().nullable().default(null),
  next_action: z.string().nullable().default(null),
  strategic_value: z.string().nullable().default(null),
  recommended_cv_version: z.string().nullable().default(null),
  evaluation_summary: z.string().nullable().default(null),
  eval_provider: z.string().nullable().default(null),
  eval_is_fallback: z.boolean().nullable().default(null),
  version_mismatch: z.boolean(),
  observed_at: z.coerce.date(),
  evaluated_at: z.coerce.date().nullable(),
  queue_status: z.string().nullable().default(null),
  latest_match_run_id: z.string().uuid().nullable().default(null),
  cv_document_run_id: z.string().uuid().nullable().default(null),
  cover_letter_document_run_id: z.string().uuid().nullable().default(null),
  document_ready: z.boolean().default(false),
});

export const StreamlitJobDetailSchema = z.object({
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  title: z.string(),
  company: z.string(),
  strategic_value: z.string().nullable(),
  evaluation_summary: z.string().nullable(),
  workability_facts: z.record(z.unknown()).nullable(),
  lane_matches: z.array(z.unknown()).nullable(),
  gate_evidence_quotes: z.array(z.string()).nullable(),
});

export const PipelineHealthSchema = z.object({
  generated_at: z.coerce.date(),
  counts_by_status: z.record(z.string(), z.number().int().min(0)),
  version_mismatch_count: z.number().int().min(0),
  document_ready_count: z.number().int().min(0),
});

export const DocumentStatusSchema = z.object({
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  latest_match_run_id: z.string().uuid().nullable(),
  cv_document_run_id: z.string().uuid().nullable(),
  cover_letter_document_run_id: z.string().uuid().nullable(),
  document_ready: z.boolean(),
});

export const ReadModelContractPlaceholder = z.object({
  schema_version: z.literal(READ_MODEL_SCHEMA_VERSION).default(READ_MODEL_SCHEMA_VERSION),
  shortlist_row: ShortlistRowV2Schema,
  job_detail: StreamlitJobDetailSchema,
  pipeline_health: PipelineHealthSchema,
  document_status: DocumentStatusSchema,
});
