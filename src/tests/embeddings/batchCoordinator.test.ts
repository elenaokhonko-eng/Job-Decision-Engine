import { describe, expect, it, vi } from 'vitest';
import { runEmbeddingBatch } from '../../embeddings/batchCoordinator.js';
import * as agent from '../../services/agent.js';

describe('runEmbeddingBatch', () => {
  it('creates a batch and persists validated embeddings', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM embedding_spaces')) {
        return { rows: [{ id: 'space-1', dimensions: 4 }] };
      }
      if (sql.includes('INSERT INTO embedding_batches') && sql.includes('RETURNING id')) {
        return { rows: [{ id: 'batch-1' }] };
      }
      if (sql.includes('FROM embedding_inputs ei')) {
        return {
          rows: [
            { id: 'input-1', content_text: 'first text' },
            { id: 'input-2', content_text: 'second text' },
          ],
        };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    vi.spyOn(agent, 'generateEmbedding').mockResolvedValue([0.1, 0.2, 0.3, 0.4]);

    const result = await runEmbeddingBatch('space-1', 'batch-key-1', 'PRIMARY', 50, fakePool);

    expect(result.batchId).toBe('batch-1');
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    const calls = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((sql) => sql.includes('INSERT INTO semantic_embeddings'))).toBe(true);
    expect(calls.some((sql) => sql.includes('UPDATE embedding_batches'))).toBe(true);
  });
});
