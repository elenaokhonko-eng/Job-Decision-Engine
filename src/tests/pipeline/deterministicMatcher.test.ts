import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDeterministicMatcher } from '../../pipeline/deterministicMatcher.js';
import pg from 'pg';
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

const mPool = new pg.Pool();

describe('Pipeline Stage: Deterministic Matcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a match run, stores requirement matches, and marks canonical job as MATCHED', async () => {
    (mPool.query as any).mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM profile_versions") && sql.includes("pv.status = 'ACTIVE'")) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return {
          rows: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              fact_type: 'PROJECT',
              statement: 'Built production machine learning pipelines for fraud detection',
              evidence_tier: 'PROFESSIONAL_PRODUCTION',
              structured_value: { domain: 'FRAUD_DETECTION' },
            }
          ]
        };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        return {
          rows: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              latest_job_version_id: '44444444-4444-4444-8444-444444444444',
              resolved_job_version_id: '44444444-4444-4444-8444-444444444444',
            }
          ]
        };
      }
      if (sql.includes('INSERT INTO match_runs') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('FROM job_requirements jr')) {
        return {
          rows: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              requirement_key: 'R-001',
              requirement_type: 'DOMAIN',
              importance: 'MUST',
              requirement_text: 'Experience in fraud detection and machine learning systems',
              quote_text: 'fraud detection and machine learning',
              structured_value: { domain_key: 'FRAUD_DETECTION' },
            }
          ]
        };
      }
      return { rows: [] };
    });

    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    const summary = await runDeterministicMatcher(undefined, { context });

    expect(summary.matchedJobs).toBe(1);
    expect(summary.errors).toBe(0);

    const calls = (mPool.query as any).mock.calls;
    const runInsert = calls.find((c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO match_runs'));
    expect(runInsert).toBeDefined();

    const reqMatchInsert = calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO requirement_evidence_matches')
    );
    expect(reqMatchInsert).toBeDefined();

    const canonicalUpdate = calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes("processing_status = 'MATCHED'")
    );
    expect(canonicalUpdate).toBeDefined();
  });
});
