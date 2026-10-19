import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { appendCompanyPolicyObservation } from '../../policy/companyPolicyStore.js';
import type { WorkspaceContext } from '../../workspace/context.js';

const context: WorkspaceContext = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  workspaceKey: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  userKey: 'test-user',
  role: 'OWNER',
};

describe('appendCompanyPolicyObservation', () => {
  it('stores user-reported company-stage evidence with explicit provenance and confidence', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('INSERT INTO workspace_companies')) return { rows: [{ id: 'company-1' }] };
      if (sql.includes('SELECT id, revision_number, policy_value')) return { rows: [] };
      if (sql.includes('INSERT INTO workspace_company_policy_observations')) {
        return { rows: [{ id: 'observation-1' }] };
      }
      return { rows: [] };
    });
    const client = { query } as unknown as pg.PoolClient;

    const result = await appendCompanyPolicyObservation(client, context, {
      company_name: 'Example Company',
      policy_type: 'COMPANY_STAGE',
      value: { stage: 'UNDERFUNDED_EARLY_STARTUP' },
      evidence_quote: 'User reports that this employer is an underfunded early startup.',
      source_url: null,
      source_type: 'USER_REPORTED',
      confidence: 'LOW',
      observed_at: '2026-10-19T00:00:00.000Z',
    });

    const insert = query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO workspace_company_policy_observations')
    );
    expect(result).toMatchObject({
      observationId: 'observation-1',
      policyDomain: 'company_stage',
      revisionNumber: 1,
      confidenceScore: 25,
      duplicate: false,
    });
    expect(insert?.[1]?.[7]).toBe('USER_REPORTED');
    expect(insert?.[1]?.[14]).toBe(context.userId);
  });

  it('requires verbatim job-version evidence before storing a job-description policy claim', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM job_versions')) return { rows: [{ description_text: 'Fully remote from Singapore.' }] };
      return { rows: [] };
    });
    const client = { query } as unknown as pg.PoolClient;

    await expect(appendCompanyPolicyObservation(client, context, {
      company_name: 'Example Company',
      policy_type: 'REMOTE_POLICY',
      value: { remote: true },
      evidence_quote: 'Remote from Singapore is allowed.',
      source_url: null,
      source_type: 'JOB_DESCRIPTION',
      confidence: 'HIGH',
      observed_at: '2026-10-19T00:00:00.000Z',
    }, { jobVersionId: '33333333-3333-4333-8333-333333333333' }))
      .rejects.toThrow('verbatim substring');

    expect(query).toHaveBeenCalledTimes(1);
  });
});
