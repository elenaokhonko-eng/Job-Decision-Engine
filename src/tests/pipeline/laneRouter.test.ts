import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLaneRouting } from '../../pipeline/laneRouter.js';
import pg from 'pg';
import * as agent from '../../services/agent.js';
import type { WorkspaceContext } from '../../workspace/context.js';
import { loadWorkspaceLanesConfig } from '../../pipeline/laneConfigLoader.js';

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
  generateEmbeddingWithProvider: vi.fn(),
  MODEL_REGISTRY: {
    EMBEDDING_PRIMARY_MODEL: 'gemini-embedding-001',
    EMBEDDING_FALLBACK_MODEL: 'text-embedding-3-small',
  },
}));

vi.mock('../../pipeline/laneConfigLoader.js', async () => {
  const actual: any = await vi.importActual('../../pipeline/laneConfigLoader.js');
  return {
    ...actual,
    loadWorkspaceLanesConfig: vi.fn(async () => ({
      source: 'FILES',
      config: {
        version: 'test',
        description: 'test config',
        lanes: {
          CORE_AI_DATA: {
            title: 'Core AI',
            description: 'Core AI lane',
            threshold: 0,
            semantic_threshold: 0,
            keywords: [],
            prototype_query: 'AI ML',
          },
          LEGAL_REGTECH: {
            title: 'Legal',
            description: 'Legal lane',
            threshold: 0,
            semantic_threshold: 0,
            keywords: [],
            prototype_query: 'Legal compliance',
          },
          HEALTH_BIO_PHARMA: {
            title: 'Health',
            description: 'Health lane',
            threshold: 0,
            semantic_threshold: 0,
            keywords: [],
            prototype_query: 'Health bio pharma',
          },
          INVESTMENT_MARKETS_FINTECH: {
            title: 'Fintech',
            description: 'Fintech lane',
            threshold: 0,
            semantic_threshold: 0,
            keywords: [],
            prototype_query: 'Markets fintech',
          },
        },
        unclassified_policy: {
          label: 'UNCLASSIFIED',
          fallback_behavior: 'DEFER_ROUTING',
          min_similarity_floor: 0.25,
        },
      },
    })),
  };
});

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

  it('routes quantitative systems architecture through investment function aliases', async () => {
    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    (loadWorkspaceLanesConfig as any).mockResolvedValueOnce({
      source: 'FILES',
      config: {
        version: 'investment-alias-test',
        description: 'test config',
        lanes: {
          CORE_AI_DATA: {
            title: 'Core AI',
            description: 'Core AI lane',
            threshold: 0.8,
            semantic_threshold: 0.8,
            keywords: [],
            prototype_query: 'AI ML',
          },
          LEGAL_REGTECH: {
            title: 'Legal',
            description: 'Legal lane',
            threshold: 0.8,
            semantic_threshold: 0.8,
            keywords: [],
            prototype_query: 'Legal compliance',
          },
          HEALTH_BIO_PHARMA: {
            title: 'Health',
            description: 'Health lane',
            threshold: 0.8,
            semantic_threshold: 0.8,
            keywords: [],
            prototype_query: 'Health bio pharma',
          },
          INVESTMENT_MARKETS_FINTECH: {
            title: 'Fintech',
            description: 'Fintech lane',
            threshold: 0.6,
            semantic_threshold: 0.6,
            keywords: [],
            prototype_query: 'Quantitative market data trading infrastructure',
            included_domain_concepts: ['MARKET_DATA', 'CAPITAL_MARKETS', 'TRADING'],
            required_function_concepts: [
              'QUANTITATIVE_RESEARCH',
              'INVESTMENT_DATA_PLATFORM',
              'TRADING_INFRASTRUCTURE',
            ],
            minimum_domain_score: 0.6,
            minimum_function_score: 0.6,
          },
        },
        unclassified_policy: {
          label: 'UNCLASSIFIED',
          fallback_behavior: 'DEFER_ROUTING',
          min_similarity_floor: 0.25,
        },
      },
    });

    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'canon-investment',
          latest_version_id: 'version-investment',
          normalized_title: 'Quantitative Systems Architect',
          description_text:
            'Design low-latency market data feeds, high-frequency execution infrastructure, and algorithmic trading platforms.',
        },
      ],
    });

    (agent.generateEmbeddingWithProvider as any).mockImplementation((text: string) => {
      const t = text.toLowerCase();
      if (t.includes('quantitative') || t.includes('market data') || t.includes('trading')) {
        return Promise.resolve([0, 0, 0, 1]);
      }
      if (t.includes('legal') || t.includes('compliance')) {
        return Promise.resolve([0, 1, 0, 0]);
      }
      if (t.includes('health') || t.includes('bio') || t.includes('pharma')) {
        return Promise.resolve([0, 0, 1, 0]);
      }
      return Promise.resolve([1, 0, 0, 0]);
    });

    const result = await runLaneRouting(undefined, { context });

    expect(result.routed).toBe(1);
    expect(result.deferred).toBe(0);

    const updateCall = (mPool.query as any).mock.calls.find(
      (call: any) => typeof call[0] === 'string' && call[0].includes('UPDATE canonical_jobs')
    );
    expect(updateCall?.[1][0]).toBe('INVESTMENT_MARKETS_FINTECH');
    expect(updateCall?.[1][2]).toBe('LANE_ROUTED');
  });

  it('defers below-threshold jobs with blocker evidence and the raw best score', async () => {
    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    (loadWorkspaceLanesConfig as any).mockResolvedValueOnce({
      source: 'FILES',
      config: {
        version: 'no-match-diagnostics-test',
        description: 'test config',
        lanes: {
          CORE_AI_DATA: {
            title: 'Core AI',
            description: 'Core AI lane',
            threshold: 0.9,
            semantic_threshold: 0.9,
            keywords: [],
            prototype_query: 'core prototype',
            included_domain_concepts: ['MACHINE_LEARNING'],
            required_function_concepts: ['ML_ENGINEERING'],
            minimum_domain_score: 0.6,
            minimum_function_score: 0.6,
          },
          LEGAL_REGTECH: {
            title: 'Legal',
            description: 'Legal lane',
            threshold: 0.9,
            semantic_threshold: 0.9,
            keywords: [],
            prototype_query: 'legal prototype',
          },
          HEALTH_BIO_PHARMA: {
            title: 'Health',
            description: 'Health lane',
            threshold: 0.9,
            semantic_threshold: 0.9,
            keywords: [],
            prototype_query: 'health prototype',
          },
          INVESTMENT_MARKETS_FINTECH: {
            title: 'Fintech',
            description: 'Fintech lane',
            threshold: 0.9,
            semantic_threshold: 0.9,
            keywords: [],
            prototype_query: 'fintech prototype',
          },
        },
        unclassified_policy: {
          label: 'UNCLASSIFIED',
          fallback_behavior: 'DEFER_ROUTING',
          min_similarity_floor: 0.25,
        },
      },
    });

    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'canon-below-threshold',
          latest_version_id: 'version-below-threshold',
          normalized_title: 'Senior Machine Learning Engineer',
          description_text: 'Build machine learning services and ML systems.',
        },
      ],
    });

    (agent.generateEmbeddingWithProvider as any).mockImplementation((text: string) => {
      const t = text.toLowerCase();
      if (t.includes('core prototype')) return Promise.resolve([1, 0, 0, 0]);
      if (t.includes('legal prototype')) return Promise.resolve([0, 1, 0, 0]);
      if (t.includes('health prototype')) return Promise.resolve([0, 0, 1, 0]);
      if (t.includes('fintech prototype')) return Promise.resolve([0, 0, 0, 1]);
      return Promise.resolve([0.5, 0.5, 0.5, 0.5]);
    });

    const result = await runLaneRouting(undefined, { context });

    expect(result.routed).toBe(0);
    expect(result.deferred).toBe(1);

    const selectCall = (mPool.query as any).mock.calls[0];
    expect(selectCall[0]).toContain("ROUTING_DEFERRED");
    expect(selectCall[1][1]).toBe("lane_router_v2.2.1|no-match-diagnostics-test|");

    const updateCall = (mPool.query as any).mock.calls.find(
      (call: any) => typeof call[0] === 'string' && call[0].includes('UPDATE canonical_jobs')
    );
    expect(updateCall?.[1][0]).toBe('UNCLASSIFIED');
    expect(updateCall?.[1][1]).toBeCloseTo(0.5);
    expect(updateCall?.[1][2]).toBe('ROUTING_DEFERRED');
    const evidence = JSON.parse(updateCall?.[1][5]);
    expect(evidence[0]).toBe('ROUTING_POLICY_NO_MATCH');
    expect(evidence).toContain(
      'CORE_AI_DATA:blocked_by=semantic:0.500<0.900;score=0.500;threshold=0.900;domain=1.000/0.600;function=1.000/0.600'
    );
  });
});
