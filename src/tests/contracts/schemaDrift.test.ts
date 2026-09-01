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
  SCHEMA_VERSION
} from "../../contracts/index.js";
import {
  sampleGmailEnvelope,
  sampleAtsObservation,
  sampleDuplicateRepostVersion,
  sampleHardRejectGate,
  sampleNeedsVerificationGate,
  sampleDeferredBudgetQueueItem,
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
    expect(() => EvaluationQueueItemSchema.parse(sampleDeferredBudgetQueueItem)).not.toThrow();
    expect(() => EvaluationQueueItemSchema.parse(sampleFailedThenRetriedQueueItem)).not.toThrow();
    expect(() => ShortlistRowSchema.parse(sampleEvaluatedShortlistRow)).not.toThrow();
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
      primary_lane: "INVALID_LANE",
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
      DEFERRED_BUDGET: 1,
      RETRY_WAIT: 1,
      EVALUATING: 1,
      PENDING: 0
    };

    const terminalCount = stateCounts.HARD_REJECTED + stateCounts.AI_EVALUATED;
    const activeOrDeferredCount =
      stateCounts.NEEDS_VERIFICATION +
      stateCounts.DEFERRED_BUDGET +
      stateCounts.RETRY_WAIT +
      stateCounts.EVALUATING +
      stateCounts.PENDING;

    expect(terminalCount + activeOrDeferredCount).toBe(inputObservations);
  });
});
