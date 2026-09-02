/**
 * Embedding infrastructure contracts
 * @description Zod schemas for embedding spaces, batches, vectors, caching
 * @version 2.0
 */

import { z } from 'zod';

export const EMBEDDING_SCHEMA_VERSION = '2.0';

export const EmbeddingProviderSchema = z.enum(['gemini', 'openai']);
export const DistanceMetricSchema = z.enum(['COSINE', 'DOT', 'L2']);
export const EmbeddingInputSourceTypeSchema = z.enum([
  'PROFILE_FACT',
  'JOB_REQUIREMENT',
  'LANE_PROTOTYPE',
]);
export const EmbeddingBatchRunTypeSchema = z.enum(['PRIMARY', 'FALLBACK']);
export const EmbeddingBatchStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);

export const EmbeddingSpaceSchema = z.object({
  id: z.string().uuid().optional(),
  space_key: z.string().min(3).max(128),
  provider: EmbeddingProviderSchema,
  model: z.string().min(1).max(128),
  dimensions: z.number().int().positive(),
  normalization: z.string().min(1).max(32).default('L2'),
  distance_metric: DistanceMetricSchema.default('COSINE'),
  is_fallback_space: z.boolean().default(false),
  active: z.boolean().default(true),
  created_at: z.date().optional(),
});

export const EmbeddingInputSchema = z.object({
  id: z.string().uuid().optional(),
  input_key: z.string().min(3).max(256),
  source_type: EmbeddingInputSourceTypeSchema,
  source_id: z.string().uuid(),
  content_text: z.string().min(1).max(12000),
  content_hash: z.string().min(16).max(128),
  created_at: z.date().optional(),
});

export const EmbeddingBatchSchema = z.object({
  id: z.string().uuid().optional(),
  embedding_space_id: z.string().uuid(),
  batch_key: z.string().min(3).max(128),
  run_type: EmbeddingBatchRunTypeSchema,
  status: EmbeddingBatchStatusSchema,
  fallback_from_batch_id: z.string().uuid().nullable().optional(),
  rerun_of_batch_id: z.string().uuid().nullable().optional(),
  item_count: z.number().int().min(0),
  success_count: z.number().int().min(0),
  failure_count: z.number().int().min(0),
  error_message: z.string().max(4000).nullable().optional(),
  created_at: z.date().optional(),
  completed_at: z.date().nullable().optional(),
});

export const EmbeddingBatchItemStatusSchema = z.enum([
  'PENDING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
]);

export const EmbeddingBatchItemSchema = z.object({
  id: z.string().uuid().optional(),
  embedding_batch_id: z.string().uuid(),
  embedding_input_id: z.string().uuid(),
  status: EmbeddingBatchItemStatusSchema,
  attempt_count: z.number().int().min(1),
  error_message: z.string().max(4000).nullable().optional(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});

export const SemanticEmbeddingSchema = z.object({
  id: z.string().uuid().optional(),
  embedding_space_id: z.string().uuid(),
  embedding_input_id: z.string().uuid(),
  embedding_batch_id: z.string().uuid().nullable().optional(),
  vector_dimensions: z.number().int().positive(),
  embedding_values: z.array(z.number()).min(1),
  vector_checksum: z.string().min(16).max(128),
  created_at: z.date().optional(),
});

export const EmbeddingGenerationRequestSchema = z.object({
  embedding_space_id: z.string().uuid(),
  batch_key: z.string().min(3).max(128),
  run_type: EmbeddingBatchRunTypeSchema,
  input_ids: z.array(z.string().uuid()).min(1),
});
