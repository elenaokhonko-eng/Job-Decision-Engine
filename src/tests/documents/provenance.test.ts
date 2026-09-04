import { describe, expect, it, vi } from 'vitest';
import { persistDocumentProvenance } from '../../documents/provenance.js';

describe('persistDocumentProvenance', () => {
  it('stores document run, claims, and DOCUMENT_READY stage event', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM canonical_jobs') && sql.includes('workspace_id')) {
        return { rows: [{ ok: 1 }] };
      }
      if (sql.includes('FROM job_versions') && sql.includes('workspace_id')) {
        return { rows: [{ ok: 1 }] };
      }
      if (sql.includes('FROM match_runs') && sql.includes('workspace_id')) {
        return { rows: [{ ok: 1 }] };
      }
      if (sql.includes('INSERT INTO document_runs')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
      }
      if (sql.includes('SELECT id, requirement_key')) {
        return {
          rows: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              requirement_key: 'R-001',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const result = await persistDocumentProvenance(
      {
        canonicalJobId: '33333333-3333-4333-8333-333333333333',
        jobVersionId: '44444444-4444-4444-8444-444444444444',
        matchRunId: '55555555-5555-4555-8555-555555555555',
        documentType: 'CV',
        policyVersion: 'documents_v2',
        generatorVersion: 'cv_generator_v2',
        outputManifest: {
          json_path: 'scripts/exports/example.cv.json',
          docx_path: 'scripts/exports/example.docx',
        },
        claims: [
          {
            sectionLabel: 'role_alignment_snapshot',
            claimText: 'Delivered production-grade fraud detection pipelines.',
            profileFactIds: ['pf-1'],
            requirementKeys: ['R-001'],
          },
        ],
      },
      fakePool,
      {
        context: {
          workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workspaceKey: 'default',
          userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          userKey: 'local_user',
          role: 'OWNER',
        },
      }
    );

    expect(result.documentRunId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.claimCount).toBe(1);

    const calls = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((sql) => sql.includes('INSERT INTO document_runs'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO document_claims'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO job_version_pipeline_state'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO pipeline_stage_events'))).toBe(true);
  });
});
