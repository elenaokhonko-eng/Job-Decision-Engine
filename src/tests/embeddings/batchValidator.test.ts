import { describe, expect, it } from 'vitest';
import { checksumVector, validateEmbeddingVector } from '../../embeddings/batchValidator.js';

describe('validateEmbeddingVector', () => {
  it('accepts a valid non-zero vector with expected dimensions', () => {
    const v = [0.1, 0.2, 0.3, 0.4];
    const result = validateEmbeddingVector(v, 4);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.dimensions).toBe(4);
    expect(result.checksum).toBe(checksumVector(v));
  });

  it('rejects dimension mismatch and zero vectors', () => {
    const mismatch = validateEmbeddingVector([1, 2, 3], 4);
    expect(mismatch.valid).toBe(false);
    expect(mismatch.issues.join(' ')).toContain('dimension mismatch');

    const zero = validateEmbeddingVector([0, 0, 0, 0], 4);
    expect(zero.valid).toBe(false);
    expect(zero.issues.join(' ')).toContain('magnitude is zero');
  });
});
