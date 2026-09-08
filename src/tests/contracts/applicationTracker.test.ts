import { describe, expect, it } from "vitest";
import {
  ApplicationEventSchema,
  ApplicationRecordSchema,
} from "../../contracts/index.js";

describe("application tracker contracts", () => {
  it("parses an application tracker row and event", () => {
    const record = ApplicationRecordSchema.parse({
      application_record_id: "11111111-1111-4111-8111-111111111111",
      canonical_job_id: "22222222-2222-4222-8222-222222222222",
      job_version_id: "33333333-3333-4333-8333-333333333333",
      title: "AI Platform Engineer",
      company: "Example Co",
      canonical_url: "https://example.test/jobs/1",
      processing_state: "MATCHED",
      processing_status: "MATCHED",
      recommendation_eligibility: "ELIGIBLE",
      recommendation_outcome: "PRIORITY",
      primary_lane: "CORE_AI_DATA",
      secondary_lanes: ["LEGAL_REGTECH"],
      application_status: "READY_TO_APPLY",
      submission_url: "https://example.test/apply",
      cv_document_run_id: null,
      cover_letter_document_run_id: null,
      notes: "Review before submitting.",
      handoff_payload: { checklist: ["CV", "cover_letter"] },
      target_submit_at: null,
      submitted_at: null,
      follow_up_at: "2026-09-10T00:00:00.000Z",
      last_action_at: "2026-09-08T00:00:00.000Z",
      created_at: "2026-09-08T00:00:00.000Z",
      updated_at: "2026-09-08T00:00:00.000Z",
    });

    const event = ApplicationEventSchema.parse({
      id: "44444444-4444-4444-8444-444444444444",
      application_record_id: record.application_record_id,
      event_type: "STATUS_CHANGED",
      from_status: "INTENT",
      to_status: "READY_TO_APPLY",
      note: "Documents ready.",
      event_payload: {},
      created_at: "2026-09-08T00:01:00.000Z",
    });

    expect(record.application_status).toBe("READY_TO_APPLY");
    expect(event.to_status).toBe("READY_TO_APPLY");
  });

  it("rejects unsupported application statuses", () => {
    expect(() =>
      ApplicationRecordSchema.parse({
        application_record_id: "11111111-1111-4111-8111-111111111111",
        canonical_job_id: "22222222-2222-4222-8222-222222222222",
        job_version_id: "33333333-3333-4333-8333-333333333333",
        title: "AI Platform Engineer",
        company: "Example Co",
        application_status: "AUTO_SUBMITTED",
        last_action_at: "2026-09-08T00:00:00.000Z",
        created_at: "2026-09-08T00:00:00.000Z",
        updated_at: "2026-09-08T00:00:00.000Z",
      })
    ).toThrow(/AUTO_SUBMITTED/);
  });
});
