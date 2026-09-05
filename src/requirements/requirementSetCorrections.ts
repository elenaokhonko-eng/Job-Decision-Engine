import { z } from 'zod';
import { JobRequirementSchema } from './contracts.js';

export type JobRequirement = z.infer<typeof JobRequirementSchema>;

export type RequirementOperation =
  | {
      operation_type: 'RETIRE';
      target_requirement_key: string;
    }
  | {
      operation_type: 'RECLASSIFY';
      target_requirement_key: string;
      requirement_type: JobRequirement['requirement_type'];
    }
  | {
      operation_type: 'REVISE';
      target_requirement_key: string;
      updates: Partial<
        Pick<
          JobRequirement,
          | 'requirement_type'
          | 'importance'
          | 'requirement_text'
          | 'quote_text'
          | 'quote_start_offset'
          | 'quote_end_offset'
          | 'structured_value'
          | 'confidence'
          | 'status'
        >
      >;
    }
  | {
      operation_type: 'ADD';
      requirement_type: JobRequirement['requirement_type'];
      importance: JobRequirement['importance'];
      requirement_text: string;
      quote_text?: string | null;
      quote_start_offset?: number | null;
      quote_end_offset?: number | null;
      structured_value?: Record<string, unknown> | null;
      confidence?: number;
    };

export function nextRequirementKey(existingKeys: string[]): string {
  let max = 0;
  for (const key of existingKeys) {
    const match = /^R-(\d{3})$/.exec(key);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) {
      max = n;
    }
  }
  const next = max + 1;
  return `R-${String(next).padStart(3, '0')}`;
}

export function applyRequirementOperations(
  baseRequirements: JobRequirement[],
  operations: RequirementOperation[],
  context: { canonical_job_id: string; job_version_id: string },
  options?: { manualExtractorVersion?: string }
): JobRequirement[] {
  const manualExtractorVersion = options?.manualExtractorVersion || 'manual_correction_v1';

  const nextRequirements: JobRequirement[] = baseRequirements.map((r) => ({ ...r }));

  const findIndex = (key: string): number => {
    const idx = nextRequirements.findIndex((r) => r.requirement_key === key);
    if (idx < 0) {
      throw new Error(`Requirement not found for key: ${key}`);
    }
    return idx;
  };

  for (const op of operations) {
    if (op.operation_type === 'RETIRE') {
      const idx = findIndex(op.target_requirement_key);
      nextRequirements[idx] = JobRequirementSchema.parse({
        ...nextRequirements[idx],
        status: 'REJECTED',
      });
      continue;
    }

    if (op.operation_type === 'RECLASSIFY') {
      const idx = findIndex(op.target_requirement_key);
      nextRequirements[idx] = JobRequirementSchema.parse({
        ...nextRequirements[idx],
        requirement_type: op.requirement_type,
      });
      continue;
    }

    if (op.operation_type === 'REVISE') {
      const idx = findIndex(op.target_requirement_key);
      nextRequirements[idx] = JobRequirementSchema.parse({
        ...nextRequirements[idx],
        ...op.updates,
      });
      continue;
    }

    const newKey = nextRequirementKey(nextRequirements.map((r) => r.requirement_key));
    nextRequirements.push(
      JobRequirementSchema.parse({
        canonical_job_id: context.canonical_job_id,
        job_version_id: context.job_version_id,
        requirement_key: newKey,
        requirement_type: op.requirement_type,
        importance: op.importance,
        requirement_text: op.requirement_text,
        quote_text: op.quote_text ?? null,
        quote_start_offset: op.quote_start_offset ?? null,
        quote_end_offset: op.quote_end_offset ?? null,
        structured_value: op.structured_value ?? null,
        extractor_type: 'DETERMINISTIC',
        extractor_version: manualExtractorVersion,
        confidence: op.confidence ?? 1,
        status: 'VALIDATED',
      })
    );
  }

  return nextRequirements;
}

