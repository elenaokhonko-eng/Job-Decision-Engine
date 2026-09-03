import { describe, expect, it } from 'vitest';
import {
  ShortlistRowV2Schema,
  DocumentStatusSchema,
  PipelineHealthSchema,
} from '../../readModels/contracts.js';

describe('readModels contracts', () => {
  it('parses shortlist row with deterministic/document fields', () => {
    const parsed = ShortlistRowV2Schema.parse({
      canonical_job_id: '11111111-1111-4111-8111-111111111111',
      job_version_id: '22222222-2222-4222-8222-222222222222',
      title: 'Principal AI Architect',
      company: 'Example Corp',
      canonical_url: 'https://example.com/jobs/1',
      source: 'GREENHOUSE',
      location: 'Singapore',
      workplace_type: 'HYBRID',
      employment_type: 'PERMANENT',
      description: 'Build AI systems',
      gate_status: 'PASS',
      rejection_codes: [],
      gate_evidence_quotes: [],
      primary_lane: 'CORE_AI_DATA',
      secondary_lanes: ['LEGAL_REGTECH'],
      lane_confidence: 'Medium',
      priority_score: 88,
      deterministic_match_score: 86,
      deterministic_match_coverage: 71,
      processing_status: 'AI_EVALUATED',
      nd_friendly_score: 78,
      politics_stress_score: 31,
      sensory_overload_index: 30,
      next_action: 'APPLY_AFTER_VERIFICATION',
      strategic_value: 'Strong fit',
      recommended_cv_version: 'CORE_AI_DATA',
      evaluation_summary: 'Good match with minor verification needs',
      eval_provider: 'openai',
      eval_is_fallback: false,
      version_mismatch: false,
      observed_at: '2026-09-02T10:00:00.000Z',
      evaluated_at: '2026-09-02T11:00:00.000Z',
      queue_status: 'COMPLETED',
      latest_match_run_id: '33333333-3333-4333-8333-333333333333',
      cv_document_run_id: '44444444-4444-4444-8444-444444444444',
      cover_letter_document_run_id: null,
      document_ready: true,
    });

    expect(parsed.document_ready).toBe(true);
    expect(parsed.deterministic_match_score).toBe(86);
  });

  it('parses pipeline health and document status', () => {
    const health = PipelineHealthSchema.parse({
      generated_at: '2026-09-02T12:00:00.000Z',
      counts_by_status: { AI_EVALUATED: 10, DEFERRED_BUDGET: 5 },
      version_mismatch_count: 1,
      document_ready_count: 4,
    });

    const doc = DocumentStatusSchema.parse({
      canonical_job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      job_version_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      latest_match_run_id: null,
      cv_document_run_id: null,
      cover_letter_document_run_id: null,
      document_ready: false,
    });

    expect(health.counts_by_status.AI_EVALUATED).toBe(10);
    expect(doc.document_ready).toBe(false);
  });
});
