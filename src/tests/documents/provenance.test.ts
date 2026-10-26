import { describe, expect, it, vi } from 'vitest';
import { persistDocumentProvenance } from '../../documents/provenance.js';

describe('persistDocumentProvenance', () => {
  it('stores document run, claims, and DOCUMENT_READY stage event', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('current_shortlist.gate_status')) {
        return {
          rows: [{
            current_job_version_id: '44444444-4444-4444-8444-444444444444',
            latest_match_run_id: '55555555-5555-4555-8555-555555555555',
            latest_deterministic_decision_id: '66666666-6666-4666-8666-666666666666',
            active_profile_version_id: '77777777-7777-4777-8777-777777777777',
            match_run_id: '55555555-5555-4555-8555-555555555555',
            match_run_job_version_id: '44444444-4444-4444-8444-444444444444',
            match_run_profile_version_id: '77777777-7777-4777-8777-777777777777',
            match_run_status: 'COMPLETED',
            match_run_requirement_set_id: '88888888-8888-4888-8888-888888888888',
            active_requirement_set_id: '88888888-8888-4888-8888-888888888888',
            match_run_job_content_hash: 'job-hash-current',
            current_job_content_hash: 'job-hash-current',
            match_run_context_fingerprint: 'context-current',
            deterministic_decision_id: '66666666-6666-4666-8666-666666666666',
            decision_job_version_id: '44444444-4444-4444-8444-444444444444',
            decision_match_run_id: '55555555-5555-4555-8555-555555555555',
            decision_context_fingerprint: 'context-current',
            decision_recommendation_eligibility: 'ELIGIBLE',
            decision_recommendation_outcome: 'REVIEW',
            gate_status: 'PASS',
            recommendation_eligibility: 'ELIGIBLE',
            recommendation_outcome: 'REVIEW',
          }],
        };
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
      if (sql.includes('FROM application_records AS application')) {
        return { rows: [{
          application_record_id: '99999999-9999-4999-8999-999999999999',
          cv_document_run_id: '11111111-1111-4111-8111-111111111111',
          cover_letter_document_run_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          cv_template_revision_id: null,
          cover_letter_template_revision_id: null,
        }] };
      }
      if (sql.includes('FROM document_template_plugins')) return { rows: [] };
      if (sql.includes('UPDATE application_records')) {
        return { rows: [{ id: '99999999-9999-4999-8999-999999999999' }], rowCount: 1 };
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
        applicationRecordId: '99999999-9999-4999-8999-999999999999',
        canonicalJobId: '33333333-3333-4333-8333-333333333333',
        jobVersionId: '44444444-4444-4444-8444-444444444444',
        matchRunId: '55555555-5555-4555-8555-555555555555',
        profileVersionId: '77777777-7777-4777-8777-777777777777',
        deterministicDecisionId: '66666666-6666-4666-8666-666666666666',
        contextFingerprint: 'context-current',
        documentType: 'CV',
        policyVersion: 'documents_v2',
        generatorVersion: 'cv_generator_v2',
        outputManifest: {
          json_path: 'scripts/exports/example.cv.json',
          docx_path: 'scripts/exports/example.docx',
          docx_sha256: 'test-docx-sha256',
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
    expect(calls.some((sql) =>
      sql.includes('current_shortlist.gate_status') &&
      sql.includes('current_shortlist.recommendation_eligibility') &&
      sql.includes('decision.recommendation_eligibility')
    )).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO document_runs'))).toBe(true);
    const exactApplicationLink = query.mock.calls.find((call: unknown[]) => String(call[0]).includes('UPDATE application_records'));
    expect(exactApplicationLink?.[0]).toContain('AND id = $5::uuid');
    expect(exactApplicationLink?.[1]).toContain('99999999-9999-4999-8999-999999999999');
    expect(calls.some((sql) => sql.includes('INSERT INTO document_claims'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO job_version_pipeline_state'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO pipeline_stage_events'))).toBe(true);
  });
});
