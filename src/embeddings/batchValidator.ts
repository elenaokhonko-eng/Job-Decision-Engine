import crypto from 'crypto';

export interface EmbeddingValidationResult {
  valid: boolean;
  issues: string[];
  checksum: string;
  dimensions: number;
}

export function checksumVector(values: number[]): string {
  const payload = values.map((v) => v.toFixed(8)).join(',');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function validateEmbeddingVector(
  values: number[],
  expectedDimensions?: number
): EmbeddingValidationResult {
  const issues: string[] = [];

  if (!Array.isArray(values) || values.length === 0) {
    issues.push('Embedding vector is empty.');
  }

  for (const value of values) {
    if (!Number.isFinite(value)) {
      issues.push('Embedding vector contains non-finite values.');
      break;
    }
  }

  if (expectedDimensions && values.length !== expectedDimensions) {
    issues.push(`Embedding dimension mismatch: expected ${expectedDimensions}, got ${values.length}.`);
  }

  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) {
    issues.push('Embedding vector magnitude is zero.');
  }

  return {
    valid: issues.length === 0,
    issues,
    checksum: checksumVector(values),
    dimensions: values.length,
  };
}
