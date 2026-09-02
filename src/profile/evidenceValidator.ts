import { LoadedProfile } from './loader.js';
import { z } from 'zod';
import { VerificationStatusSchema, DateSchema } from './contracts.js';

export const EvidenceSourceInputSchema = z.object({
  source_key: z.string().min(1).max(128),
  source_type: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  uri: z.string().url().nullable().optional(),
  source_date: DateSchema.nullable().optional(),
  verification_status: VerificationStatusSchema.default('UNVERIFIED'),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export type EvidenceSourceInput = z.infer<typeof EvidenceSourceInputSchema>;

export interface EvidenceReferenceValidationResult {
  valid: boolean;
  issues: string[];
  referencedKeys: string[];
}

function collectReferencedKeys(loaded: LoadedProfile): Set<string> {
  const keys = new Set<string>();

  for (const engagement of loaded.engagements.engagements) {
    for (const sourceKey of engagement.evidence_source_keys || []) {
      keys.add(sourceKey);
    }
  }

  for (const fact of loaded.facts.facts) {
    for (const sourceKey of fact.evidence_source_keys || []) {
      keys.add(sourceKey);
    }
  }

  for (const credential of loaded.credentials.credentials) {
    if (credential.evidence_source_key) {
      keys.add(credential.evidence_source_key);
    }
  }

  return keys;
}

export function validateEvidenceSourceReferences(
  loaded: LoadedProfile,
  evidenceSources: EvidenceSourceInput[]
): EvidenceReferenceValidationResult {
  const issues: string[] = [];
  const referencedKeys = [...collectReferencedKeys(loaded)].sort();

  const evidenceSourceMap = new Map<string, EvidenceSourceInput>();
  for (const source of evidenceSources) {
    const parsed = EvidenceSourceInputSchema.parse(source);
    if (evidenceSourceMap.has(parsed.source_key)) {
      issues.push(`Duplicate evidence source key: ${parsed.source_key}`);
      continue;
    }
    evidenceSourceMap.set(parsed.source_key, parsed);
  }

  for (const sourceKey of referencedKeys) {
    if (!evidenceSourceMap.has(sourceKey)) {
      issues.push(`Missing evidence source definition for key: ${sourceKey}`);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    referencedKeys,
  };
}
