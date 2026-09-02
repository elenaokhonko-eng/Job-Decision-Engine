/**
 * Document generation contracts
 * @description Zod schemas for CV, cover letter, and document provenance
 * @version 2.0
 */

import { z } from 'zod';

export const DOCUMENTS_SCHEMA_VERSION = '2.0';

export const DocumentTypeSchema = z.enum(['CV', 'COVER_LETTER']);
export const DocumentRunStatusSchema = z.enum(['STARTED', 'COMPLETED', 'FAILED']);

export const MatchSnapshotSchema = z.object({
  match_run_id: z.string().uuid(),
  overall_match_score: z.number().min(0).max(100),
  coverage_score: z.number().min(0).max(100),
  matched_count: z.number().int().min(0),
  requirement_count: z.number().int().min(0),
});

export const CriteriaSnapshotItemSchema = z.object({
  requirement_id: z.string().min(1),
  outcome: z.enum(['EXCEEDS', 'MEETS', 'NEAR_MATCH', 'TRANSFERABLE', 'GAP']),
  profile_fact_ids: z.array(z.string().min(1)).min(1),
});

export const CriteriaSnapshotSchema = z.object({
  label: z.string().min(1).max(200),
  coverage_percentage: z.number().min(0).max(100),
  items: z.array(CriteriaSnapshotItemSchema).max(12),
});

export const DocumentClaimSchema = z.object({
  id: z.string().uuid().optional(),
  document_run_id: z.string().uuid(),
  section_label: z.string().min(1).max(100),
  claim_text: z.string().min(1).max(4000),
  profile_fact_ids: z.array(z.string().min(1)).default([]),
  requirement_ids: z.array(z.string().uuid()).default([]),
  unresolved_requirement_keys: z.array(z.string().min(1)).default([]),
  created_at: z.date().optional(),
});

export const DocumentRunSchema = z.object({
  id: z.string().uuid().optional(),
  canonical_job_id: z.string().uuid(),
  job_version_id: z.string().uuid(),
  match_run_id: z.string().uuid().nullable().optional(),
  document_type: DocumentTypeSchema,
  status: DocumentRunStatusSchema,
  policy_version: z.string().min(1).max(100),
  generator_version: z.string().min(1).max(100),
  output_manifest: z.record(z.unknown()),
  claim_count: z.number().int().min(0),
  error_message: z.string().max(4000).nullable().optional(),
  created_at: z.date().optional(),
  completed_at: z.date().nullable().optional(),
});

export const DocumentContractPlaceholder = z.object({
  schema_version: z.literal(DOCUMENTS_SCHEMA_VERSION).default(DOCUMENTS_SCHEMA_VERSION),
  document_run: DocumentRunSchema,
  claims: z.array(DocumentClaimSchema),
  match_snapshot: MatchSnapshotSchema.optional(),
  criteria_snapshot: CriteriaSnapshotSchema.optional(),
});
