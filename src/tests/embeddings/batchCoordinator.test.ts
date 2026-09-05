import { describe, expect, it, vi } from 'vitest';
import { runEmbeddingBatch, runEmbeddingBatchWithFallback } from '../../embeddings/batchCoordinator.js';
import * as agent from '../../services/agent.js';
import type { WorkspaceContext } from '../../workspace/context.js';

describe('runEmbeddingBatch', () => {
  it('creates a batch and persists validated embeddings', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM embedding_spaces')) {
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              workspace_id: 'workspace-id-1',
              provider: 'openai',
              model: agent.MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL,
              dimensions: 4,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO embedding_batches') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }] };
      }
      if (sql.includes('FROM embedding_inputs ei')) {
        return {
          rows: [
            { id: '44444444-4444-4444-8444-444444444444', content_text: 'first text' },
            { id: '55555555-5555-4555-8555-555555555555', content_text: 'second text' },
          ],
        };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    vi.spyOn(agent, 'generateEmbeddingWithProvider').mockResolvedValue([0.1, 0.2, 0.3, 0.4]);

    const result = await runEmbeddingBatch(
      '11111111-1111-4111-8111-111111111111',
      'batch-key-1',
      'PRIMARY',
      50,
      undefined,
      undefined,
      undefined,
      fakePool
    );

    expect(result.batchId).toBe('33333333-3333-4333-8333-333333333333');
    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failedInputIds).toEqual([]);
    expect(result.runType).toBe('PRIMARY');

    const calls = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((sql) => sql.includes('INSERT INTO semantic_embeddings'))).toBe(true);
    expect(calls.some((sql) => sql.includes('UPDATE embedding_batches'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO embedding_batch_items'))).toBe(true);
  });

  it('runs fallback space batch for failed primary items', async () => {
    let nextBatchId = 0;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO embedding_spaces')) {
        const spaceKey = String(params?.[1] || '');
        return { rows: [{ id: spaceKey.includes('primary') ? 'space-primary' : 'space-fallback' }] };
      }
      if (sql.includes('FROM job_requirements jr')) {
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              requirement_type: 'DOMAIN',
              requirement_text: 'machine learning domain',
              quote_text: 'machine learning',
              structured_value: { domain_key: 'MACHINE_LEARNING' },
            },
          ],
        };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return { rows: [] };
      }
      if (sql.includes('FROM embedding_spaces')) {
        const isPrimary = String(params?.[0]) === 'space-primary';
        return {
          rows: [
            {
              id: String(params?.[0]),
              workspace_id: 'workspace-id-1',
              provider: isPrimary ? 'gemini' : 'openai',
              model: isPrimary
                ? agent.MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL
                : agent.MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL,
              dimensions: isPrimary ? 4 : 3,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO embedding_batches') && sql.includes('RETURNING id')) {
        nextBatchId += 1;
        return { rows: [{ id: `batch-${nextBatchId}` }] };
      }
      if (sql.includes('WHERE ei.id = ANY')) {
        return { rows: [{ id: 'input-req-1', content_text: 'retry input' }] };
      }
      if (sql.includes('FROM embedding_inputs ei')) {
        return { rows: [{ id: 'input-req-1', content_text: 'first text' }] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const spy = vi.spyOn(agent, 'generateEmbeddingWithProvider');
    spy
      .mockResolvedValueOnce([0.1, 0.2, 0.3, 0.4])
      .mockResolvedValueOnce([0.11, 0.22, 0.33]);

    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    const result = await runEmbeddingBatchWithFallback(10, fakePool, { context });

    expect(result.primary.failed).toBe(0);
    expect(result.primary.succeeded).toBe(1);
    expect(result.fallback).toBeUndefined();

    // Force a primary failure and fallback execution.
    spy.mockReset();
    spy
      .mockResolvedValueOnce([0, 0, 0, 0])
      .mockResolvedValueOnce([0.21, 0.22, 0.23]);

    const second = await runEmbeddingBatchWithFallback(10, fakePool, { context });
    expect(second.primary.failedInputIds).toContain('input-req-1');
    expect(second.fallback).toBeTruthy();
    expect(second.fallback?.runType).toBe('FALLBACK');

    const sqlCalls = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls.some((sql) => sql.includes('fallback_from_batch_id'))).toBe(true);
  });
});
