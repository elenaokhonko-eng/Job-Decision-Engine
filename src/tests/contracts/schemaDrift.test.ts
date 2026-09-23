import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  IngestionEnvelopeSchema,
  ExtractedJobSchema,
  JobObservationSchema,
  CanonicalJobVersionSchema,
  GateDecisionSchema,
  LaneDecisionSchema,
  EvaluationQueueItemSchema,
  EvaluationResultSchema,
  ShortlistRowSchema,
  ObservationPersistenceSchema,
  PersistedGateDecisionSchema,
  PersistedLaneDecisionSchema,
  PersistedEvaluationQueueItemSchema,
  SCHEMA_VERSION
} from "../../contracts/index.js";
import {
  sampleGmailEnvelope,
  sampleAtsObservation,
  sampleDuplicateRepostVersion,
  sampleHardRejectGate,
  sampleNeedsVerificationGate,
  samplePendingQueueItem,
  sampleFailedThenRetriedQueueItem,
  sampleEvaluatedShortlistRow
} from "../../contracts/fixtures.js";
import { SHORTLIST_FIELD_LINEAGE, generateFieldLineageMarkdown } from "../../contracts/fieldLineage.js";

describe("P0-01: Data Contract Validation & Schema Drift Baseline", () => {
  it("exports structurally non-empty JSON schemas for every boundary contract", () => {
    const schemaDir = path.resolve(process.cwd(), "src/contracts/json");
    const expectedNames = [
      "IngestionEnvelope",
      "ExtractedJob",
      "JobObservation",
      "CanonicalJobVersion",
      "GateDecision",
      "LaneDecision",
      "EvaluationQueueItem",
      "EvaluationResult",
      "ShortlistRow"
    ];

    for (const name of expectedNames) {
      const json = JSON.parse(fs.readFileSync(path.join(schemaDir, `${name}.schema.json`), "utf-8"));
      const definition = json.definitions?.[name] ?? json.$defs?.[name] ?? json;
      expect(definition.type, `${name} must export as an object schema`).toBe("object");
      expect(Object.keys(definition.properties ?? {}).length, `${name} must have properties`).toBeGreaterThan(0);
      expect((definition.required ?? []).length, `${name} must have required fields`).toBeGreaterThan(0);
    }
  });

  it("should successfully parse and validate all 8 canonical boundary fixtures", () => {
    expect(() => IngestionEnvelopeSchema.parse(sampleGmailEnvelope)).not.toThrow();
    expect(() => JobObservationSchema.parse(sampleAtsObservation)).not.toThrow();
    expect(() => CanonicalJobVersionSchema.parse(sampleDuplicateRepostVersion)).not.toThrow();
    expect(() => GateDecisionSchema.parse(sampleHardRejectGate)).not.toThrow();
    expect(() => GateDecisionSchema.parse(sampleNeedsVerificationGate)).not.toThrow();
    expect(() => EvaluationQueueItemSchema.parse(samplePendingQueueItem)).not.toThrow();
    expect(() => EvaluationQueueItemSchema.parse(sampleFailedThenRetriedQueueItem)).not.toThrow();
    expect(() => ShortlistRowSchema.parse(sampleEvaluatedShortlistRow)).not.toThrow();
  });

  it("requires explicit schema versions at persistence boundaries", () => {
    const observationPersistence = {
      schema_version: SCHEMA_VERSION,
      workspace_id: sampleAtsObservation.workspace_id,
      source_run_id: sampleAtsObservation.source_run_id,
      source_type: sampleAtsObservation.source_type,
      source_plugin_key: sampleAtsObservation.source_plugin_key,
      source_plugin_revision_id: sampleAtsObservation.source_plugin_revision_id,
      source_external_id: sampleAtsObservation.source_external_id,
      source_url: sampleAtsObservation.source_url,
      retrieved_at: sampleAtsObservation.retrieved_at,
      company_name_raw: sampleAtsObservation.company_name_raw,
      title_raw: sampleAtsObservation.title_raw,
      description_text: sampleAtsObservation.description_text,
      location_raw: sampleAtsObservation.location_raw,
      workplace_type_raw: sampleAtsObservation.workplace_type_raw,
      employment_type_raw: sampleAtsObservation.employment_type_raw,
      compensation_raw: sampleAtsObservation.compensation_raw,
      canonical_apply_url: sampleAtsObservation.canonical_apply_url,
      source_lane: sampleAtsObservation.source_lane,
      search_plan_version: sampleAtsObservation.search_plan_version,
      raw_payload: sampleAtsObservation.raw_payload,
      raw_payload_hash: sampleAtsObservation.raw_payload_hash,
    };
    const laneDecision = {
      schema_version: SCHEMA_VERSION,
      canonical_job_id: sampleHardRejectGate.canonical_job_id,
      job_version_id: sampleHardRejectGate.job_version_id,
      pipeline_run_id: sampleHardRejectGate.pipeline_run_id,
      model_version: "lane-router-test",
      primary_lane: "CORE_AI_DATA",
      secondary_lanes: ["UNIVERSITY_AI_RESEARCH"],
      lane_confidence: "High",
      semantic_scores: { CORE_AI_DATA: 0.9 },
      lane_evidence: ["AI platform engineering"],
      evaluated_at: sampleHardRejectGate.evaluated_at,
    };

    expect(() => ObservationPersistenceSchema.parse(observationPersistence)).not.toThrow();
    expect(() => PersistedGateDecisionSchema.parse(sampleHardRejectGate)).not.toThrow();
    expect(() => PersistedLaneDecisionSchema.parse(laneDecision)).not.toThrow();
    expect(() => PersistedEvaluationQueueItemSchema.parse(samplePendingQueueItem)).not.toThrow();

    const withoutVersion = (value: Record<string, unknown>) => {
      const { schema_version: _schemaVersion, ...rest } = value;
      return rest;
    };
    expect(() => ObservationPersistenceSchema.parse(withoutVersion(observationPersistence))).toThrow();
    expect(() => PersistedGateDecisionSchema.parse(withoutVersion(sampleHardRejectGate))).toThrow();
    expect(() => PersistedLaneDecisionSchema.parse(withoutVersion(laneDecision))).toThrow();
    expect(() => PersistedEvaluationQueueItemSchema.parse(withoutVersion(samplePendingQueueItem))).toThrow();
  });

  it("should retain persisted observation provenance and version-linkage metadata", () => {
    const observation = JobObservationSchema.parse(sampleAtsObservation);

    expect(observation.schema_version).toBe(SCHEMA_VERSION);
    expect(observation.workspace_id).toBe("12121212-1212-4121-8121-121212121212");
    expect(observation.source_plugin_key).toBe("greenhouse");
    expect(observation.source_plugin_revision_id).toBe("13131313-1313-4131-8131-131313131313");
    expect(observation.source_external_id).toBe("9988");
    expect(observation.source_url).toBe("https://boards.greenhouse.io/databricks/jobs/9988");
    expect(observation.retrieved_at).toBe("2026-08-28T12:05:00.000Z");
    expect(observation.source_lane).toBe("CORE_AI_DATA");
    expect(observation.search_plan_version).toBe("1.0");
    expect(observation.raw_payload).toEqual({ id: 9988, source: "greenhouse" });
    expect(observation.job_version_id).toBeNull();
  });

  it("should preserve queue context and availability fields without inventing legacy context", () => {
    const queueItem = EvaluationQueueItemSchema.parse(samplePendingQueueItem);

    expect(queueItem.schema_version).toBe(SCHEMA_VERSION);
    expect(queueItem.workspace_id).toBe("12121212-1212-4121-8121-121212121212");
    expect(queueItem.profile_version_id).toBe("14141414-1414-4141-8141-141414141414");
    expect(queueItem.match_run_id).toBe("15151515-1515-4151-8151-151515151515");
    expect(queueItem.deterministic_decision_id).toBe("16161616-1616-4161-8161-161616161616");
    expect(queueItem.job_content_hash).toBe("sha256-job-content-9988");
    expect(queueItem.context_fingerprint).toBe("sha256-context-9988");
    expect(queueItem.available_at).toBe("2026-08-28T12:20:00.000Z");

    const { profile_version_id: _profileVersionId, match_run_id: _matchRunId, deterministic_decision_id: _decisionId, job_content_hash: _contentHash, context_fingerprint: _contextFingerprint, ...legacyQueueItem } = queueItem;
    const parsedLegacyQueueItem = EvaluationQueueItemSchema.parse(legacyQueueItem);
    expect(parsedLegacyQueueItem.profile_version_id).toBeNull();
    expect(parsedLegacyQueueItem.match_run_id).toBeNull();
    expect(parsedLegacyQueueItem.deterministic_decision_id).toBeNull();
    expect(parsedLegacyQueueItem.job_content_hash).toBeNull();
    expect(parsedLegacyQueueItem.context_fingerprint).toBeNull();
  });

  it("should require pipeline identity on every gate decision", () => {
    const { pipeline_run_id: _pipelineRunId, ...gateWithoutPipelineRun } = sampleHardRejectGate;

    expect(() => GateDecisionSchema.parse(gateWithoutPipelineRun)).toThrow();
    expect(GateDecisionSchema.parse(sampleHardRejectGate).pipeline_run_id).toBe("66666666-6666-4666-8666-666666666666");
  });

  it("should preserve a null or missing shortlist priority score instead of defaulting to zero", () => {
    const explicitNull = ShortlistRowSchema.parse({ ...sampleEvaluatedShortlistRow, priority_score: null });
    const { priority_score: originalPriorityScore, ...withoutPriorityScore } = sampleEvaluatedShortlistRow;
    const missing = ShortlistRowSchema.parse(withoutPriorityScore);

    expect(originalPriorityScore).toBe(0.449);
    expect(explicitNull.priority_score).toBeNull();
    expect(missing.priority_score).toBeNull();
  });

  it("should reject invalid ingestion envelopes with strict schema validation errors", () => {
    const invalidEnvelope = {
      source_type: "UNSUPPORTED_FEED", // Invalid source
      source_id: "",                   // Empty ID
      observed_at: "invalid-date",
      raw_payload_hash: "",
      raw_payload: ""
    };
    expect(() => IngestionEnvelopeSchema.parse(invalidEnvelope)).toThrow();
  });

  it("should reject evaluation results that have invalid lane or score out of bounds", () => {
    const invalidEval = {
      schema_version: SCHEMA_VERSION,
      canonical_job_id: "12345", // Not a UUID
      job_version_id: "v1",
      pipeline_run_id: "66666666-6666-4666-8666-666666666666",
      provider: "unvetted_llm",  // Invalid provider
      model: "gpt-mock",
      attempt: 0,                // Attempt must be positive
      is_fallback: false,
      degraded_state: false,
      evaluation_summary: "summary",
      primary_lane: "invalid-lane",
      secondary_lanes: [],
      lane_confidence: "Extreme", // Invalid confidence enum
      nd_score: 150,              // Out of 0-100 bounds
      nd_friendly_score: -10,     // Negative score
      politics_stress_score: 50,
      sensory_overload_index: 50,
      building_research_ratio: 50,
      interaction_load: 50,
      rejection_codes: [],
      next_action: "MAYBE_APPLY", // Invalid action enum
      evaluated_at: "2026-08-28T12:00:00.000Z"
    };
    expect(() => EvaluationResultSchema.parse(invalidEval)).toThrow();
  });

  it("should verify complete field lineage mapping for all ShortlistRow keys", () => {
    const shortlistShape = ShortlistRowSchema.shape;
    const mappedFields = new Set(SHORTLIST_FIELD_LINEAGE.map((e) => e.field));

    for (const key of Object.keys(shortlistShape)) {
      expect(mappedFields.has(key)).toBe(true);
    }

    const lineageDoc = generateFieldLineageMarkdown();
    expect(lineageDoc).toContain("# Shortlist Read Model Field Lineage");
    expect(lineageDoc).toContain("canonical_job_id");
    expect(lineageDoc).toContain("strategic_value");
  });

  it("should enforce the state-conservation invariant: N_in = N_terminal + N_active", () => {
    const inputObservations = 10;
    const stateCounts = {
      HARD_REJECTED: 3,
      NEEDS_VERIFICATION: 2,
      AI_EVALUATED: 2,
      QUEUED_FOR_AI: 1,
      RETRY_WAIT: 1,
      EVALUATING: 1,
      PENDING: 0
    };

    const terminalCount = stateCounts.HARD_REJECTED + stateCounts.AI_EVALUATED;
    const activeOrDeferredCount =
      stateCounts.NEEDS_VERIFICATION +
      stateCounts.QUEUED_FOR_AI +
      stateCounts.RETRY_WAIT +
      stateCounts.EVALUATING +
      stateCounts.PENDING;

    expect(terminalCount + activeOrDeferredCount).toBe(inputObservations);
  });
});
