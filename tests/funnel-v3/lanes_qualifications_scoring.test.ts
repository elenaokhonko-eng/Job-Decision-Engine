import { beforeEach, describe, expect, it, vi } from "vitest";

import * as agent from "../../src/services/agent.js";
import { runLaneRouter, runLaneRouting } from "../../src/pipeline/laneRouter.js";
import { isRequirementOptional } from "../../src/pipeline/hardGate.js";
import { applyGlobalGates } from "../../src/services/criteria.js";
import type { WorkspaceContext } from "../../src/workspace/context.js";
import {
  ACTIVE_LANE_KEYS,
  createLaneRouterTestHarness,
  deterministicLaneEmbedding,
} from "./fixtures/lane_router.test-helper.js";
import {
  LANE_FIXTURES,
  QUALIFICATION_FIXTURES,
  COMPENSATION_FIXTURES,
} from "./fixtures/l_q_k_lanes_qualifications.fixtures.js";

vi.mock("../../src/services/agent.js", () => ({
  generateEmbeddingWithProvider: vi.fn(),
  MODEL_REGISTRY: {
    EMBEDDING_PRIMARY_MODEL: "deterministic-primary",
    EMBEDDING_FALLBACK_MODEL: "deterministic-fallback",
  },
}));

const TEST_CONTEXT: WorkspaceContext = {
  workspaceId: "funnel-v3-lane-workspace",
  workspaceKey: "funnel-v3-lane-workspace",
  userId: "funnel-v3-lane-user",
  userKey: "funnel-v3-lane-user",
  role: "OWNER",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agent.generateEmbeddingWithProvider).mockImplementation(async (text: string) =>
    deterministicLaneEmbedding(text),
  );
});

describe("Funnel V3 Independent Test Suite — Lanes & Routing", () => {
  it("routes deterministic fixtures to all six active lanes", async () => {
    const fixtures = [
      LANE_FIXTURES.L01,
      LANE_FIXTURES.L02,
      LANE_FIXTURES.L03,
      LANE_FIXTURES.L04,
      LANE_FIXTURES.L05,
      LANE_FIXTURES.L06,
    ];
    const harness = createLaneRouterTestHarness(fixtures);

    const result = await runLaneRouter(harness.client, { context: TEST_CONTEXT });

    expect(result).toEqual({ routed: 6, deferred: 0 });
    const updatesByJobId = new Map(harness.updates.map((update) => [update.jobId, update]));
    const routedLanes = fixtures.map((fixture) => {
      const update = updatesByJobId.get(fixture.id);
      expect(update).toBeDefined();
      expect(update?.primaryLane).toBe(fixture.expectedLanes?.[0]);
      expect(update?.processingState).toBe("LANE_ROUTED");
      expect(update?.semanticScore).toBe(1);
      expect(update?.laneEvidence).toContain(
        `${fixture.expectedLanes?.[0]}:domain_score=1.000`,
      );
      return update?.primaryLane;
    });

    expect(new Set(routedLanes)).toEqual(new Set(ACTIVE_LANE_KEYS));
  });

  it("keeps negative scope and title fixtures unclassified with policy evidence", async () => {
    const fixtures = [LANE_FIXTURES.L07, LANE_FIXTURES.L13, LANE_FIXTURES.L14];
    const harness = createLaneRouterTestHarness(fixtures);

    const result = await runLaneRouting(harness.client, { context: TEST_CONTEXT });

    expect(result).toEqual({ routed: 0, deferred: 3 });
    for (const fixture of fixtures) {
      const update = harness.updates.find((candidate) => candidate.jobId === fixture.id);
      expect(update).toBeDefined();
      expect(update?.primaryLane).toBe("UNCLASSIFIED");
      expect(update?.processingState).toBe("ROUTING_DEFERRED");
      expect(update?.laneEvidence[0]).toBe("ROUTING_POLICY_NO_MATCH");
    }

    const hospitalityUpdate = harness.updates.find((update) => update.jobId === "L14");
    expect(hospitalityUpdate?.laneEvidence.some((evidence) =>
      evidence.startsWith("CORE_AI_DATA:blocked_by="),
    )).toBe(true);
  });

  it("L12: pure UN fundraising role is rejected on non-technical axis", () => {
    const fixture = LANE_FIXTURES.L12;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
  });
});

describe("Funnel V3 Independent Test Suite — Qualifications & Experience (Q01-Q09)", () => {
  it("Q01: preferred cert missing -> optional gap, isRequirementOptional returns true", () => {
    const req = QUALIFICATION_FIXTURES.Q01.requirement;
    const isOptional = isRequirementOptional(req as any);
    expect(isOptional).toBe(true);
  });

  it("Q02: genuinely mandatory credential missing -> isRequirementOptional returns false", () => {
    const req = QUALIFICATION_FIXTURES.Q02.requirement;
    const isOptional = isRequirementOptional(req as any);
    expect(isOptional).toBe(false);
  });

  it("Q04: preferred/negated certificate is not treated as mandatory", () => {
    const optionalReq1 = {
      requirement_key: "cert_cissp",
      requirement_type: "CERTIFICATION",
      importance: "PREFERRED",
      requirement_text: "CISSP certification preferred but not required.",
      quote_text: "CISSP certification preferred but not required.",
      structured_value: { is_required: false },
    };
    expect(isRequirementOptional(optionalReq1 as any)).toBe(true);
  });

  it("Q06: employer 10 years AI ask vs candidate 1.5 direct + separately evidenced delivery does not trigger silent raw-years hard rejection", () => {
    const job = {
      id: "Q06-job",
      title: "Lead AI Engineer",
      company_name: "Tech Corp",
      location: "Singapore",
      workplace_type: "HYBRID",
      raw_description: "Requires 10 years experience in Artificial Intelligence and Machine Learning. Building scalable LLM models in Python.",
    };
    const result = applyGlobalGates(job);
    // Hard gate passes to allow matching to compute multi-factor domain experience
    expect(result.status).toBe("PASS");
  });
});

describe("Funnel V3 Independent Test Suite — Compensation & Fail Veto Invariants (K01-K04)", () => {
  it("K01: missing compensation does not trigger rejection", () => {
    const fixture = COMPENSATION_FIXTURES.K01;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: "Lakehouse Corp",
      location: "Singapore",
      workplace_type: "HYBRID",
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
  });

  it("K04: high compensation or semantic score cannot override a deterministic hard veto", () => {
    const fixture = COMPENSATION_FIXTURES.K04;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("NON_TARGET_ROLE_FAMILY");
  });
});
