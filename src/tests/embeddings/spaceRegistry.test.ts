import { describe, expect, it, vi } from 'vitest';
import { seedEmbeddingSpaces } from '../../embeddings/spaceRegistry.js';
import type { WorkspaceContext } from '../../workspace/context.js';

describe('seedEmbeddingSpaces', () => {
  it('upserts primary and fallback spaces and returns ids', async () => {
    let calls = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO embedding_spaces')) {
        calls += 1;
        return { rows: [{ id: `space-${calls}` }] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    const res = await seedEmbeddingSpaces(fakePool, { context });

    expect(res.primarySpaceId).toBe('space-1');
    expect(res.fallbackSpaceId).toBe('space-2');
  });
});
