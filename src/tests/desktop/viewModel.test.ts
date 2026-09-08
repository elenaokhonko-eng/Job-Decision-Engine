import { describe, expect, it } from "vitest";
import {
  jobOutcomeLabel,
  safeExternalHref,
  summarizeDesktopCounts,
} from "../../desktop/viewModel.js";
import type { ApplicationRecord, ShortlistRow } from "../../contracts/index.js";
import type { PipelineTaskRow, SourceHealthRow } from "../../sdk/index.js";

const baseJob: ShortlistRow = {
  canonical_job_id: "11111111-1111-4111-8111-111111111111",
  job_version_id: "22222222-2222-4222-8222-222222222222",
  title: "AI Engineer",
  company: "Example",
  canonical_url: "https://example.test/job",
  source: "GMAIL_ALERT",
  location: "Remote",
  workplace_type: "REMOTE",
  employment_type: "PERMANENT",
  description: null,
  gate_status: "PASS",
  rejection_codes: null,
  gate_evidence_quotes: null,
  primary_lane: "CORE_AI_DATA",
  secondary_lanes: [],
  lane_confidence: "High",
  priority_score: 80,
  deterministic_match_score: null,
  deterministic_match_coverage: null,
  processing_state: "MATCHED",
  processing_status: "MATCHED",
  recommendation_eligibility: "ELIGIBLE",
  recommendation_outcome: "PRIORITY",
  recommendation_requirement_score: null,
  recommendation_coverage_score: null,
  recommendation_evidence_completeness: null,
  recommendation_decided_at: null,
  nd_friendly_score: null,
  politics_stress_score: null,
  sensory_overload_index: null,
  next_action: null,
  strategic_value: null,
  recommended_cv_version: null,
  evaluation_summary: null,
  eval_provider: null,
  eval_is_fallback: null,
  version_mismatch: false,
  observed_at: "2026-09-08T00:00:00.000Z",
  evaluated_at: null,
  lane_matches: null,
  workability_facts: null,
  queue_status: null,
  latest_match_run_id: null,
  cv_document_run_id: null,
  cover_letter_document_run_id: null,
  document_ready: false,
};

const baseApplication: ApplicationRecord = {
  application_record_id: "33333333-3333-4333-8333-333333333333",
  canonical_job_id: baseJob.canonical_job_id,
  job_version_id: baseJob.job_version_id,
  title: baseJob.title,
  company: baseJob.company,
  canonical_url: baseJob.canonical_url,
  processing_state: "MATCHED",
  processing_status: "MATCHED",
  recommendation_eligibility: "ELIGIBLE",
  recommendation_outcome: "PRIORITY",
  primary_lane: "CORE_AI_DATA",
  secondary_lanes: [],
  application_status: "READY_TO_APPLY",
  submission_url: baseJob.canonical_url,
  cv_document_run_id: null,
  cover_letter_document_run_id: null,
  notes: null,
  handoff_payload: {},
  target_submit_at: null,
  submitted_at: null,
  follow_up_at: null,
  last_action_at: "2026-09-08T00:00:00.000Z",
  created_at: "2026-09-08T00:00:00.000Z",
  updated_at: "2026-09-08T00:00:00.000Z",
};

const baseTask: PipelineTaskRow = {
  id: "44444444-4444-4444-8444-444444444444",
  task_type: "APPLY_HARD_GATES",
  task_key: "task-1",
  status: "PENDING",
  available_at: "2026-09-08T00:00:00.000Z",
  lease_id: null,
  lease_expires_at: null,
  heartbeat_at: null,
  claimed_by: null,
  attempt_count: 0,
  max_attempts: 3,
  last_error: null,
  dead_letter_reason: null,
  created_at: "2026-09-08T00:00:00.000Z",
  updated_at: "2026-09-08T00:00:00.000Z",
  completed_at: null,
};

const baseSource: SourceHealthRow = {
  source_key: "manual_import",
  display_name: "Manual Import",
  kind: "MANUAL",
  status: "ACTIVE",
  active_revision_number: 1,
  access_basis: "user_supplied",
  terms_url: null,
  attribution_required: null,
  observation_count: 2,
  last_observed_at: "2026-09-08T00:00:00.000Z",
};

describe("desktop view model", () => {
  it("allows only safe external links", () => {
    expect(safeExternalHref("https://example.test/job")).toBe("https://example.test/job");
    expect(safeExternalHref("javascript:alert(1)")).toBeNull();
    expect(safeExternalHref("not a url")).toBeNull();
  });

  it("labels jobs from persisted deterministic state", () => {
    expect(jobOutcomeLabel(baseJob)).toBe("PRIORITY");
    expect(jobOutcomeLabel({ ...baseJob, recommendation_outcome: null, gate_status: "NEEDS_VERIFICATION" })).toBe("VERIFY");
  });

  it("summarizes desktop counters without fabricating records", () => {
    const counts = summarizeDesktopCounts(
      [baseJob, { ...baseJob, canonical_job_id: "55555555-5555-4555-8555-555555555555", gate_status: "NEEDS_VERIFICATION", recommendation_outcome: null }],
      [baseApplication, { ...baseApplication, application_record_id: "66666666-6666-4666-8666-666666666666", application_status: "SUBMITTED" }],
      [baseTask, { ...baseTask, id: "77777777-7777-4777-8777-777777777777", status: "COMPLETED" }],
      [baseSource, { ...baseSource, source_key: "stale", status: "DISABLED" }]
    );

    expect(counts).toMatchObject({
      totalJobs: 2,
      priorityJobs: 1,
      needsVerificationJobs: 1,
      activeApplications: 1,
      submittedApplications: 1,
      runningTasks: 1,
      failingSources: 1,
    });
  });
});
