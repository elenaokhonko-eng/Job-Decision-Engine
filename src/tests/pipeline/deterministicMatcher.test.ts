import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isCapabilityRequirementType,
  runDeterministicMatcher,
} from '../../pipeline/deterministicMatcher.js';
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

describe('deterministic matching requirement classification', () => {
  it('keeps workability requirements out of capability scores', () => {
    expect(isCapabilityRequirementType('DOMAIN')).toBe(true);
    expect(isCapabilityRequirementType('FUNCTION')).toBe(true);
    expect(isCapabilityRequirementType('EXPERIENCE_YEARS')).toBe(true);
    expect(isCapabilityRequirementType('WORK_MODE')).toBe(false);
    expect(isCapabilityRequirementType('OFFICE_DAYS')).toBe(false);
    expect(isCapabilityRequirementType('WORK_AUTH')).toBe(false);
    expect(isCapabilityRequirementType('TRAVEL')).toBe(false);
  });
});

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
      if (sql.includes('FROM embedding_spaces') && sql.includes('is_fallback_space = FALSE')) {
        return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
      }
      if (sql.includes('FROM embedding_spaces') && sql.includes('is_fallback_space = TRUE')) {
        return { rows: [] };
      }
      if (sql.includes('COUNT(DISTINCT node_id)') && sql.includes('FROM v_matchable_nodes')) {
        return { rows: [{ n: 1 }] };
      }
      if (sql.includes('SELECT node_id, vector_dimensions, embedding_values') && sql.includes('FROM v_matchable_nodes')) {
        const nodeId = params?.[3]?.[0] || '22222222-2222-4222-8222-222222222222';
        return {
          rows: [
            {
              node_id: nodeId,
              vector_dimensions: 4,
              embedding_values: [0.1, 0.2, 0.3, 0.4],
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO match_runs') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('JOIN job_requirements jr')) {
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
    expect(runInsert?.[0]).toContain('requirement_set_id');
    expect(runInsert?.[0]).toContain('context_fingerprint');

    const requirementSelect = calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('JOIN job_requirements jr')
    );
    expect(requirementSelect?.[0]).toContain('jv.active_requirement_set_id IS NOT NULL');
    expect(requirementSelect?.[0]).not.toContain('jv.active_requirement_set_id IS NULL');

    const reqMatchInsert = calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO requirement_evidence_matches')
    );
    expect(reqMatchInsert).toBeDefined();

    const canonicalUpdate = calls.find(
      (c: any) =>
        typeof c[0] === 'string' &&
        c[0].includes('UPDATE canonical_jobs') &&
        c[0].includes('latest_match_run_id')
    );
    expect(canonicalUpdate).toBeDefined();
    expect(canonicalUpdate?.[0]).toContain("ELSE 'MATCHED'");
    expect(canonicalUpdate?.[1][7]).toBe(false);
  });

  it('does not publish MATCHED while an active embedding cohort is incomplete', async () => {
    (mPool.query as any).mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes("FROM profile_versions") && sql.includes("pv.status = 'ACTIVE'")) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            fact_type: 'EXPERIENCE_YEARS',
            statement: 'Five years of professional production experience',
            evidence_tier: 'PROFESSIONAL_PRODUCTION',
            verification_status: 'VERIFIED',
            structured_value: { experience_years: 5 },
          }],
        };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            latest_job_version_id: '44444444-4444-4444-8444-444444444444',
            resolved_job_version_id: '44444444-4444-4444-8444-444444444444',
          }],
        };
      }
      if (sql.includes('FROM embedding_spaces') && sql.includes('is_fallback_space = FALSE')) {
        return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
      }
      if (sql.includes('FROM embedding_spaces') && sql.includes('is_fallback_space = TRUE')) {
        return { rows: [] };
      }
      if (sql.includes('FROM v_matchable_nodes')) {
        return { rows: [{ n: params?.[2] === 'PROFILE_FACT' ? 1 : 0 }] };
      }
      if (sql.includes('INSERT INTO match_runs') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('JOIN job_requirements jr')) {
        return {
          rows: [{
            id: '66666666-6666-4666-8666-666666666666',
            requirement_key: 'R-001',
            requirement_type: 'EXPERIENCE_YEARS',
            importance: 'MUST',
            requirement_text: 'At least 3 years of professional experience',
            quote_text: 'At least 3 years of professional experience',
            structured_value: { minimum_years: 3 },
          }],
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

    expect(summary.matchedJobs).toBe(0);
    expect(summary.skippedJobs).toBe(1);
    expect(summary.errors).toBe(0);

    const canonicalUpdate = (mPool.query as any).mock.calls.find(
      (call: any[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('UPDATE canonical_jobs') &&
        call[0].includes("processing_state = CASE")
    );
    expect(canonicalUpdate).toBeDefined();
    expect(canonicalUpdate?.[1][5]).toBe('UNKNOWN');
    expect(canonicalUpdate?.[1][7]).toBe(true);
    expect(canonicalUpdate?.[0]).toContain("THEN 'LANE_ROUTED'");
    expect(canonicalUpdate?.[0]).not.toContain("processing_state = 'MATCHED'");
  });

  it('allows an explicitly requeued stale match to run from MATCHED state', async () => {
    (mPool.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM profile_versions") && sql.includes("pv.status = 'ACTIVE'")) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            fact_type: 'PROJECT',
            statement: 'Built production machine learning pipelines for fraud detection',
            evidence_tier: 'PROFESSIONAL_PRODUCTION',
            structured_value: { domain: 'FRAUD_DETECTION' },
          }],
        };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            latest_job_version_id: '44444444-4444-4444-8444-444444444444',
            resolved_job_version_id: '44444444-4444-4444-8444-444444444444',
          }],
        };
      }
      if (sql.includes('FROM embedding_spaces') && sql.includes('is_fallback_space = FALSE')) {
        return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
      }
      if (sql.includes('FROM embedding_spaces') && sql.includes('is_fallback_space = TRUE')) {
        return { rows: [] };
      }
      if (sql.includes('COUNT(DISTINCT node_id)') && sql.includes('FROM v_matchable_nodes')) {
        return { rows: [{ n: 1 }] };
      }
      if (sql.includes('SELECT node_id, vector_dimensions, embedding_values') && sql.includes('FROM v_matchable_nodes')) {
        return {
          rows: [
            {
              node_id: '22222222-2222-4222-8222-222222222222',
              vector_dimensions: 4,
              embedding_values: [0.1, 0.2, 0.3, 0.4],
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO match_runs') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('JOIN job_requirements jr')) {
        return {
          rows: [{
            id: '66666666-6666-4666-8666-666666666666',
            requirement_key: 'R-001',
            requirement_type: 'DOMAIN',
            importance: 'MUST',
            requirement_text: 'Experience in fraud detection and machine learning systems',
            quote_text: 'fraud detection and machine learning',
            structured_value: { domain_key: 'FRAUD_DETECTION' },
          }],
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

    const summary = await runDeterministicMatcher(undefined, {
      context,
      jobVersionIds: ['44444444-4444-4444-8444-444444444444'],
      limit: 1,
    });

    expect(summary.matchedJobs).toBe(1);
    const jobSelect = (mPool.query as any).mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('FROM canonical_jobs c')
    );
    expect(jobSelect?.[0]).toContain("'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'");
    expect(jobSelect?.[1]).toContain(true);
  });

  it('does not publish MATCHED when no active compatible embedding space is configured', async () => {
    (mPool.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM profile_versions") && sql.includes("pv.status = 'ACTIVE'")) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            fact_type: 'EXPERIENCE_YEARS',
            statement: 'Five years of professional production experience',
            evidence_tier: 'PROFESSIONAL_PRODUCTION',
            verification_status: 'VERIFIED',
            structured_value: { experience_years: 5 },
          }],
        };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            latest_job_version_id: '44444444-4444-4444-8444-444444444444',
            resolved_job_version_id: '44444444-4444-4444-8444-444444444444',
          }],
        };
      }
      if (sql.includes('FROM embedding_spaces')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO match_runs') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('JOIN job_requirements jr')) {
        return {
          rows: [{
            id: '66666666-6666-4666-8666-666666666666',
            requirement_key: 'R-001',
            requirement_type: 'EXPERIENCE_YEARS',
            importance: 'MUST',
            requirement_text: 'At least 3 years of professional experience',
            quote_text: 'At least 3 years of professional experience',
            structured_value: { minimum_years: 3 },
          }],
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

    expect(summary.matchedJobs).toBe(0);
    expect(summary.skippedJobs).toBe(1);
    expect(summary.errors).toBe(0);

    const canonicalUpdate = (mPool.query as any).mock.calls.find(
      (call: any[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('UPDATE canonical_jobs') &&
        call[0].includes("processing_state = CASE")
    );
    expect(canonicalUpdate).toBeDefined();
    expect(canonicalUpdate?.[1][5]).toBe('UNKNOWN');
    expect(canonicalUpdate?.[1][7]).toBe(true);
    expect(canonicalUpdate?.[0]).toContain("THEN 'LANE_ROUTED'");
    expect(canonicalUpdate?.[0]).not.toContain("processing_state = 'MATCHED'");
    const matchRunUpdate = (mPool.query as any).mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE match_runs') && call[0].includes('status = CASE')
    );
    expect(matchRunUpdate?.[0]).toContain("WHEN $7::boolean THEN 'FAILED'");
    expect(matchRunUpdate?.[0]).toContain("EMBEDDING_DEPENDENCY_INCOMPLETE");
    expect(canonicalUpdate?.[0]).toContain("recommendation_outcome = CASE");
    expect(canonicalUpdate?.[0]).toContain("WHEN $8::boolean THEN NULL");
    expect(canonicalUpdate?.[0]).toContain("recommendation_decided_at = CASE WHEN $8::boolean THEN NULL ELSE recommendation_decided_at END");
    expect(canonicalUpdate?.[0]).toContain("latest_deterministic_decision_id = CASE WHEN $8::boolean THEN NULL ELSE latest_deterministic_decision_id END");
  });

  it('records a completed zero-coverage match when deterministic extraction completed with no requirements', async () => {
    (mPool.query as any).mockImplementation(async (sql: string) => {
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
              verification_status: 'VERIFIED',
              structured_value: null,
            },
          ],
        };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        return {
          rows: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              latest_job_version_id: '44444444-4444-4444-8444-444444444444',
              resolved_job_version_id: '44444444-4444-4444-8444-444444444444',
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO match_runs') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('JOIN job_requirements jr')) {
        return { rows: [] };
      }
      if (sql.includes('FROM job_versions jv') && sql.includes('job_version_pipeline_state ps')) {
        return { rows: [{ exists: true }] };
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
    expect(
      (mPool.query as any).mock.calls.some(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes("requirement_count = 0") &&
          call[0].includes("status = 'COMPLETED'")
      )
    ).toBe(true);
    expect(
      (mPool.query as any).mock.calls.some(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes("processing_status = 'MATCHED'") &&
          call[0].includes('deterministic_match_score = 0')
      )
    ).toBe(true);
  });

  it('sanitizes engagement and credential facts to null for requirement_evidence_matches.profile_fact_id', async () => {
    (mPool.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM profile_versions") && sql.includes("pv.status = 'ACTIVE'")) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return { rows: [] };
      }
      if (sql.includes('FROM profile_credentials pc')) {
        return {
          rows: [
            {
              id: 'cred-1',
              credential_name: 'AWS Solutions Architect',
              issuer: 'AWS',
              credential_type: 'CREDENTIAL',
              level: 'Associate',
            },
          ],
        };
      }
      if (sql.includes('FROM profile_engagements')) {
        return {
          rows: [
            {
              id: 'eng-1',
              start_date: '2020-01-01',
              end_date: null,
              is_current: true,
              experience_class: 'PROFESSIONAL_PRODUCTION',
              engagement_type: 'EMPLOYMENT',
              role_title: 'Software Engineer',
              summary: 'Built cloud backend systems',
              operating_model: 'HYBRID',
            },
          ],
        };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        return {
          rows: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              latest_job_version_id: '44444444-4444-4444-8444-444444444444',
              resolved_job_version_id: '44444444-4444-4444-8444-444444444444',
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO match_runs') && sql.includes('RETURNING id')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('JOIN job_requirements jr')) {
        return {
          rows: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              requirement_key: 'R-001',
              requirement_type: 'EXPERIENCE_YEARS',
              importance: 'MUST',
              requirement_text: 'Requires 10 years experience in overall professional production',
              quote_text: '10 years experience in overall professional production',
              structured_value: { minimum_years: 10, experience_scope: 'overall professional production' },
            },
            {
              id: '77777777-7777-4777-8777-777777777777',
              requirement_key: 'R-002',
              requirement_type: 'CREDENTIAL',
              importance: 'MUST',
              requirement_text: 'CISSP mandatory',
              quote_text: 'CISSP mandatory',
              structured_value: { is_required: true, credential_name: 'CISSP' },
            },
          ],
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
    expect(summary.errors).toBe(0);

    const matchInserts = (mPool.query as any).mock.calls.filter(
      (call: any[]) =>
        typeof call[0] === 'string' && call[0].includes('INSERT INTO requirement_evidence_matches')
    );
    expect(matchInserts.length).toBe(2);
    // Engagement-backed or unresolved experience evidence must never be written as a profile_facts foreign key.
    for (const insert of matchInserts) {
      const sql = String(insert[0]);
      if (/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*NULL,\s*'UNKNOWN'/i.test(sql)) {
        expect(insert[1][3]).toContain("years are evidenced");
      } else {
        expect(insert[1][3]).toBeNull();
      }
    }
  });
});
