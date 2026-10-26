import { describe, expect, it, vi } from "vitest";
import { SourceBroker } from "../../ingestion/sourceBroker.js";
import { buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";
import { JobSourceEvidenceSchema } from "../../contracts/jobSourceEvidence.js";
import type { WorkspaceContext } from "../../workspace/context.js";

vi.mock("../../ingestion/jobSourceEvidence.js", () => ({
  buildJobSourceEvidence: vi.fn(),
}));

const context: WorkspaceContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceKey: "default",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userKey: "local_user",
  role: "OWNER",
};

describe("source broker checkpoint and disposition persistence", () => {
  it("loads and advances a checkpoint only through the registered source plugin", async () => {
    const pluginId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const planRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const sourceRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("INSERT INTO source_runs")) return { rows: [{ id: sourceRunId }], rowCount: 1 };
      if (sql.includes("SELECT id FROM source_plugins")) return { rows: [{ id: pluginId }], rowCount: 1 };
      if (sql.includes("SELECT checkpoint FROM source_checkpoints")) return { rows: [{ checkpoint: { cursor: "after:post-30", cycle: 2 } }], rowCount: 1 };
      if (sql.includes("INSERT INTO source_plan_runs")) return { rows: [{ id: planRunId }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const broker = new SourceBroker({ query } as any, context);
    await broker.startRun();

    const checkpoint = await broker.loadSourceCheckpoint("himalayas", "plan:2026-10:CORE_AI_DATA");
    const startedPlan = await broker.startSourcePlanRun("himalayas", "plan:2026-10:CORE_AI_DATA", "six_lane_sources_v1", "CORE_AI_DATA");
    await broker.saveSourceCheckpoint("himalayas", "plan:2026-10:CORE_AI_DATA", {
      cursor: "after:post-60",
      cycle: 2,
      last_page_committed_at: "2026-10-24T00:00:00.000Z",
    });
    await broker.finishSourcePlanRun(startedPlan, "COMPLETED", {
      pagesProcessed: 1,
      itemsSeen: 30,
      itemsStaged: 12,
      itemsFiltered: 18,
    });

    expect(checkpoint).toEqual({ cursor: "after:post-30", cycle: 2 });
    expect(startedPlan).toBe(planRunId);
    const checkpointWrite = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO source_checkpoints"));
    expect(checkpointWrite?.[1]?.[2]).toBe("plan:2026-10:CORE_AI_DATA");
    expect(JSON.parse(String(checkpointWrite?.[1]?.[3]))).toMatchObject({ cursor: "after:post-60", cycle: 2 });
    await broker.endRun("COMPLETED");
  });

  it("persists evidence-normalization failures to the raw observation error history", async () => {
    vi.mocked(buildJobSourceEvidence).mockImplementation(() => {
      throw new Error("unsupported source evidence shape");
    });
    const observationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("INSERT INTO source_runs")) return { rows: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }], rowCount: 1 };
      if (sql.includes("INSERT INTO raw_job_observations")) return { rows: [{ id: observationId, inserted: true }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const broker = new SourceBroker({ query } as any, context);
    await broker.startRun();
    await broker.processObservation({
      sourceName: "GREENHOUSE",
      sourcePluginKey: "greenhouse",
      sourcePluginRevisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sourceExternalId: "posting-42",
      sourceUrl: "https://boards.greenhouse.io/acme/jobs/42",
      retrievedAt: "2026-10-24T00:00:00.000Z",
      companyName: "Acme",
      title: "Platform Architect",
      descriptionRaw: "Build a data platform.",
      canonicalApplyUrl: "https://apply.example.test/jobs/42",
      sourceLane: "CORE_AI_DATA",
      searchPlanVersion: "six_lane_sources_v1",
      rawPayload: { id: "posting-42" },
    }, { id: "posting-42" });

    const errorHistoryWrite = query.mock.calls.find(([sql]) => sql.includes("SET error_history"));
    expect(errorHistoryWrite).toBeDefined();
    expect(JSON.parse(String(errorHistoryWrite?.[1]?.[0]))).toMatchObject({
      stage: "NORMALIZED_SOURCE_EVIDENCE",
      error: "unsupported source evidence shape",
      raw_payload_hash: expect.any(String),
    });
    expect(errorHistoryWrite?.[1]?.[2]).toBe(observationId);
    await broker.endRun("DEGRADED");
  });

  it("stores versioned normalized evidence with every candidate disposition for availability refreshes", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("INSERT INTO source_runs")) return { rows: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const broker = new SourceBroker({ query } as any, context);
    await broker.startRun();
    const normalizedEvidence = JobSourceEvidenceSchema.parse({
      schema_version: "job_source_evidence_v1",
      normalizer_version: "job_source_evidence_builder_v1",
      source_name: "GREENHOUSE",
      source_plugin_key: "greenhouse",
      source_plugin_revision_id: null,
      source_external_id: "posting-42",
      source_identity_hash: "identity-hash",
      employer_posting_url: "https://boards.greenhouse.io/acme/jobs/42",
      application_url: "https://apply.example.test/jobs/42",
      raw_payload_hash: "a".repeat(64),
      retrieved_at: "2026-10-24T00:00:00.000Z",
      description: {
        normalized_text: "Build a platform.",
        normalized_text_hash: "description-hash",
        completeness_status: "COMPLETE",
        completeness_reasons: [],
        segments: [],
      },
      dates: Object.fromEntries(["published_at", "reposted_at", "source_updated_at", "expires_at"].map((key) => [key, {
        status: "UNKNOWN",
        value: null,
        basis: "UNKNOWN",
        raw_value: null,
        timestamp_unit: "UNKNOWN",
        evidence: [],
      }])),
      availability: {
        status: "OPEN",
        verified_at: "2026-10-24T00:00:00.000Z",
        expires_at: "2026-10-25T00:00:00.000Z",
        verification_method: "EMPLOYER_ATS_LISTING",
        reason_code: "ACTIVE_PUBLIC_ATS_LISTING",
        evidence: [],
      },
      workability: {
        hiring_territories: { status: "UNKNOWN", operator: "UNKNOWN", countries: [], evidence: [] },
        work_mode: { status: "UNKNOWN", value: "UNKNOWN", office_days_min: null, office_days_max: null, evidence: [] },
        employment_routes: { status: "UNKNOWN", values: ["UNKNOWN"], evidence: [] },
        timezone_overlap: { status: "UNKNOWN", value: null, evidence: [] },
        travel_pct: { status: "UNKNOWN", minimum: null, maximum: null, evidence: [] },
        on_call: { status: "UNKNOWN", required: null, evidence: [] },
      },
      compensation: { status: "UNKNOWN", components: [], evidence: [] },
      role_shape: {
        status: "UNKNOWN",
        role_families: [],
        domain_families: [],
        technical_ownership: "UNKNOWN",
        hands_on_coding: "UNKNOWN",
        architecture_scope: "UNKNOWN",
        delivery_scope: "UNKNOWN",
        sales_ownership: "UNKNOWN",
        people_management: "UNKNOWN",
        interaction_burden: "UNKNOWN",
        evidence: [],
      },
      opportunity_category: { status: "UNKNOWN", value: null, evidence: [] },
    });

    await broker.recordCandidateDisposition({
      sourcePluginKey: "greenhouse",
      planKey: "company:acme:CORE_AI_DATA",
      laneKey: "CORE_AI_DATA",
      sourceExternalId: "posting-42",
      sourceUrl: "https://boards.greenhouse.io/acme/jobs/42",
      rawPayloadHash: "a".repeat(64),
      rawPayload: { id: "posting-42" },
      normalizedEvidence,
      disposition: "DUPLICATE",
      observationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }, null);

    const recorded = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO source_candidate_dispositions"));
    expect(recorded?.[0]).toContain("normalized_evidence");
    expect(recorded?.[1]?.[15]).toContain('"availability"');
    expect(recorded?.[1]?.[16]).toBe("job_source_evidence_v1");
  });

  it("persists filtered-candidate payload identity and reason instead of silently dropping it", async () => {
    const pluginId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("INSERT INTO source_runs")) return { rows: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }], rowCount: 1 };
      if (sql.includes("SELECT id FROM source_plugins")) return { rows: [{ id: pluginId }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const broker = new SourceBroker({ query } as any, context);
    await broker.startRun();
    await broker.recordCandidateDisposition({
      sourcePluginKey: "greenhouse",
      planKey: "company:acme:CORE_AI_DATA",
      laneKey: "CORE_AI_DATA",
      sourceExternalId: "posting-42",
      sourceUrl: "https://boards.greenhouse.io/acme/jobs/42",
      rawPayloadHash: "a".repeat(64),
      rawPayload: { id: 42, title: "Finance Sales Operations" },
      disposition: "FILTERED",
      reasonCode: "LANE_QUERY_MISS",
      reasonDetail: "No configured function or domain term matched this lane plan.",
    }, null);

    const recorded = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO source_candidate_dispositions"));
    expect(recorded).toBeDefined();
    expect(recorded?.[1]).toContain("posting-42");
    expect(recorded?.[1]).toContain("LANE_QUERY_MISS");
    expect(JSON.parse(String(recorded?.[1]?.[9]))).toMatchObject({ id: 42 });
    await broker.endRun("COMPLETED");
  });
});
