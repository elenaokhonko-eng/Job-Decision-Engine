import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLaneRouting } from '../../pipeline/laneRouter.js';
import pg from 'pg';
import * as agent from '../../services/agent.js';
import type { WorkspaceContext } from '../../workspace/context.js';

vi.mock('pg', () => {
  const mPool: any = {
    query: vi.fn(),
    end: vi.fn(),
    release: vi.fn(),
  };
  mPool.connect = vi.fn().mockResolvedValue(mPool);
  return {
    default: {
      Pool: class { constructor() { return mPool; } }
    }
  };
});

vi.mock('../../services/agent.js', () => ({
  generateEmbeddingWithProvider: vi.fn()
}));

const mPool = new pg.Pool();

describe('Pipeline Stage: Lane Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should calculate cosine similarity and update job lane', async () => {
    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    // 1. Mock DB query for jobs
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'canon-1',
          normalized_title: 'AI Engineer',
          description_text: 'Deep learning'
        }
      ]
    });

    // 2. Mock embeddings for the 4 prototypes + 1 job
    let embedCallCount = 0;
    (agent.generateEmbeddingWithProvider as any).mockImplementation((text: string) => {
      embedCallCount++;
      if (text.includes('AI') || text.includes('ML')) {
        return Promise.resolve([1, 0, 0, 0]); // Perfect match for first lane
      }
      return Promise.resolve([0, 1, 0, 0]); // Everything else
    });

    await runLaneRouting(undefined, { context });

    // 4 prototypes + 1 job = 5 calls
    expect(agent.generateEmbeddingWithProvider).toHaveBeenCalledTimes(5);

    // DB update: SELECT + BEGIN + UPDATE canonical_jobs + COMMIT
    expect(mPool.query).toHaveBeenCalledTimes(4);

    const updateCall = (mPool.query as any).mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCall[1][0]).toEqual('CORE_AI_DATA'); // bestLane (arg 1)
    expect(updateCall[1][1]).toBe(1);                  // bestScore (arg 2)
    expect(updateCall[1][2]).toEqual('LANE_ROUTED');   // processingStatus (arg 3)
    expect(updateCall[1][3]).toEqual('High');          // laneConfidence (arg 4)
    // arg 5 = secondary_lanes JSON, arg 6 = lane_evidence, arg 7 = id
    expect(updateCall[1][7]).toEqual('canon-1');        // job id (arg 8)
  });
});
