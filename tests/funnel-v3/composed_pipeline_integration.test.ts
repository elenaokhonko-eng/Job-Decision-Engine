import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import { runHardGates } from "../../src/pipeline/hardGate.js";
import { runLaneRouter } from "../../src/pipeline/laneRouter.js";
import { runDeterministicMatcher } from "../../src/pipeline/deterministicMatcher.js";
import type { WorkspaceContext } from "../../src/workspace/context.js";
import {
  ACTIVE_LANE_KEYS,
  createLaneRouterTestHarness,
  deterministicLaneEmbedding,
} from "./fixtures/lane_router.test-helper.js";
import { LANE_FIXTURES } from "./fixtures/l_q_k_lanes_qualifications.fixtures.js";
import * as agent from "../../src/services/agent.js";

vi.mock("../../src/services/agent.js", () => ({
  generateEmbeddingWithProvider: vi.fn(),
  MODEL_REGISTRY: {
    EMBEDDING_PRIMARY_MODEL: "deterministic-primary",
    EMBEDDING_FALLBACK_MODEL: "deterministic-fallback",
  },
}));

const TEST_CONTEXT: WorkspaceContext = {
  workspaceId: "funnel-v3-composed-workspace",
  workspaceKey: "default",
  userId: "user-composed-1",
  userKey: "user-1",
  role: "OWNER",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agent.generateEmbeddingWithProvider).mockImplementation(async (text: string) =>
    deterministicLaneEmbedding(text),
  );
});

describe("Composed Pipeline Integration — Gate Separation & Qualification Stages", () => {
  function createComposedGateHarness(options: {
    jobs: Array<{
      id: string;
      title: string;
      company_name: string;
      description_text: string;
      workplace_type?: string;
      location?: string;
      employment_type?: string;
      job_version_id: string;
      requirements?: Array<{
        requirement_key: string;
        requirement_type: string;
        importance?: string;
        requirement_text: string;
        quote_text?: string;
        structured_value?: Record<string, unknown> | null;
      }>;
    }>;
    profileFacts?: Array<{
      id: string;
      statement: string;
      structured_value: Record<string, unknown>;
      source_type?: string;
    }>;
  }) {
    const jobUpdates: Array<{
      id: string;
      gate_decision: string;
      processing_status: string;
      rejection_reason: string | null;
    }> = [];

    const mockClient = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        const s = String(sql || "");

        if (s.includes("workspace_workability_preferences") || s.includes("workability_policies")) {
          return { rows: [] };
        }

        if (s.includes("SELECT c.*, jv.description_text")) {
          return {
            rows: options.jobs.map((j) => ({
              id: j.id,
              normalized_title: j.title,
              company_name: j.company_name,
              description_text: j.description_text,
              location: j.location || "Singapore",
              workplace_type: j.workplace_type || "REMOTE",
              employment_type: j.employment_type || "PERMANENT",
              canonical_url: "https://example.com/apply",
              job_version_id: j.job_version_id,
            })),
          };
        }

        if (s.includes("BEGIN") || s.includes("COMMIT") || s.includes("ROLLBACK")) {
          return { rows: [] };
        }

        if (s.includes("SELECT jr.requirement_key")) {
          const versionId = params?.[1];
          const job = options.jobs.find((j) => j.job_version_id === versionId);
          return {
            rows: (job?.requirements || []).map((r) => ({
              requirement_key: r.requirement_key,
              requirement_type: r.requirement_type,
              importance: r.importance || "MUST",
              requirement_text: r.requirement_text,
              quote_text: r.quote_text || r.requirement_text,
              structured_value: r.structured_value || null,
            })),
          };
        }

        if (s.includes("FROM profile_versions")) {
          return { rows: [{ id: "active-pv-1" }] };
        }

        if (s.includes("FROM profile_facts")) {
          return { rows: options.profileFacts || [] };
        }

        if (s.includes("INSERT INTO gate_decisions")) {
          return { rows: [{ id: "gate-dec-1" }] };
        }

        if (s.includes("UPDATE canonical_jobs")) {
          jobUpdates.push({
            id: params?.[6],
            gate_decision: params?.[0],
            processing_status: params?.[1],
            rejection_reason: params?.[2],
          });
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    return { client: mockClient as unknown as PoolClient, jobUpdates };
  }

  it("10-year experience ask with candidate below 10 years results in GATE_PASSED (PREQUALIFIED), not HARD_REJECTED", async () => {
    const harness = createComposedGateHarness({
      jobs: [
        {
          id: "10000000-0000-4000-8000-000000000001",
          title: "Staff Machine Learning Engineer",
          company_name: "AI Corp",
          description_text: "Lead AI systems. 10 years experience required in machine learning engineering.",
          job_version_id: "11000000-0000-4000-8000-000000000001",
          workplace_type: "REMOTE",
          requirements: [
            {
              requirement_key: "req_exp_10",
              requirement_type: "EXPERIENCE_YEARS",
              importance: "MUST",
              requirement_text: "10 years of Machine Learning experience",
              structured_value: { minimum_years: 10, experience_scope: "machine learning" },
            },
          ],
        },
      ],
      profileFacts: [
        {
          id: "fact-exp-1.5",
          statement: "1.5 years of machine learning experience",
          structured_value: { professional_years: 1.5, experience_scope: "machine learning" },
          source_type: "PROFILE_FACT",
        },
      ],
    });

    const res = await runHardGates(harness.client, { context: TEST_CONTEXT });

    expect(res.passed).toBe(1);
    expect(res.hardRejected).toBe(0);

    const update = harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000001");
    expect(update).toBeDefined();
    expect(update?.gate_decision).toBe("PASS");
    expect(update?.processing_status).toBe("PREQUALIFIED");
    expect(update?.rejection_reason).toBeNull();
  });

  it("mandatory degree mismatch results in GATE_PASSED at global gates", async () => {
    const harness = createComposedGateHarness({
      jobs: [
        {
          id: "10000000-0000-4000-8000-000000000002",
          title: "Senior AI Researcher",
          company_name: "Research Labs",
          description_text: "Build foundational LLMs. PhD degree required in Computer Science.",
          job_version_id: "11000000-0000-4000-8000-000000000002",
          workplace_type: "REMOTE",
          requirements: [
            {
              requirement_key: "req_degree_phd",
              requirement_type: "DEGREE",
              importance: "MUST",
              requirement_text: "PhD in Computer Science required",
              structured_value: { degree_level: "phd", degree_subject: "computer science" },
            },
          ],
        },
      ],
      profileFacts: [
        {
          id: "fact-degree-bachelor",
          statement: "Bachelor of Science in Computer Science",
          structured_value: { degree_level: "bachelor", degree_subject: "computer science" },
          source_type: "PROFILE_FACT",
        },
      ],
    });

    const res = await runHardGates(harness.client, { context: TEST_CONTEXT });

    expect(res.passed).toBe(1);
    expect(res.hardRejected).toBe(0);

    const update = harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000002");
    expect(update?.gate_decision).toBe("PASS");
    expect(update?.processing_status).toBe("PREQUALIFIED");
  });

  it("preferred certification or degree results in GATE_PASSED", async () => {
    const harness = createComposedGateHarness({
      jobs: [
        {
          id: "10000000-0000-4000-8000-000000000003",
          title: "Cloud Infrastructure Architect",
          company_name: "CloudTech",
          description_text: "Design Kubernetes infrastructure. AWS Solutions Architect Professional preferred.",
          job_version_id: "11000000-0000-4000-8000-000000000003",
          workplace_type: "REMOTE",
          requirements: [
            {
              requirement_key: "req_aws_cert",
              requirement_type: "CREDENTIAL",
              importance: "PREFERRED",
              requirement_text: "AWS Certified Solutions Architect Professional preferred",
              structured_value: { is_required: false, credential_name: "AWS Certified Solutions Architect" },
            },
            {
              requirement_key: "req_masters_degree",
              requirement_type: "DEGREE",
              importance: "PREFERRED",
              requirement_text: "Master's degree in Computer Science preferred",
              structured_value: { is_required: false, degree_level: "masters", degree_subject: "computer science" },
            },
          ],
        },
      ],
      profileFacts: [],
    });

    const res = await runHardGates(harness.client, { context: TEST_CONTEXT });

    expect(res.passed).toBe(1);
    expect(res.hardRejected).toBe(0);

    const update = harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000003");
    expect(update?.gate_decision).toBe("PASS");
    expect(update?.processing_status).toBe("PREQUALIFIED");
  });

  it("mandatory certification missing results in GATE_PASSED at global hard gates", async () => {
    const harness = createComposedGateHarness({
      jobs: [
        {
          id: "10000000-0000-4000-8000-000000000004",
          title: "Financial Security Systems Engineer",
          company_name: "SecureBank",
          description_text: "Lead security audit infrastructure. CISSP certification strictly required.",
          job_version_id: "11000000-0000-4000-8000-000000000004",
          workplace_type: "REMOTE",
          requirements: [
            {
              requirement_key: "req_cissp_cert",
              requirement_type: "CREDENTIAL",
              importance: "MUST",
              requirement_text: "CISSP certification required",
              structured_value: { is_required: true, credential_name: "CISSP" },
            },
          ],
        },
      ],
      profileFacts: [],
    });

    const res = await runHardGates(harness.client, { context: TEST_CONTEXT });

    expect(res.passed).toBe(1);
    expect(res.hardRejected).toBe(0);

    const update = harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000004");
    expect(update?.gate_decision).toBe("PASS");
    expect(update?.processing_status).toBe("PREQUALIFIED");
  });

  it("genuine legal WORK_AUTH incompatibility results in global HARD_REJECT", async () => {
    const harness = createComposedGateHarness({
      jobs: [
        {
          id: "10000000-0000-4000-8000-000000000005",
          title: "Senior AI Engineer (Defense)",
          company_name: "US Defense Contractor",
          description_text: "US Citizens only. Strictly requires United States citizenship and security clearance.",
          job_version_id: "11000000-0000-4000-8000-000000000005",
          workplace_type: "REMOTE",
          location: "Remote - United States",
          requirements: [
            {
              requirement_key: "req_auth_us",
              requirement_type: "WORK_AUTH",
              importance: "MUST",
              requirement_text: "Must be a US Citizen",
              structured_value: { required_jurisdictions: ["UNITED_STATES"] },
            },
          ],
        },
      ],
      profileFacts: [
        {
          id: "fact-auth-sg",
          statement: "Authorized to work in Singapore only",
          structured_value: { authorized_jurisdictions: ["SINGAPORE"] },
          source_type: "PROFILE_FACT",
        },
      ],
    });

    const res = await runHardGates(harness.client, { context: TEST_CONTEXT });

    expect(res.passed).toBe(0);
    expect(res.hardRejected).toBe(1);

    const update = harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000005");
    expect(update?.gate_decision).toBe("HARD_REJECT");
    expect(update?.processing_status).toBe("HARD_REJECTED");
    expect(update?.rejection_reason).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
  });

  it("owner hard rules (onsite > 3 days, travel > 20%, FDE) veto with HARD_REJECT", async () => {
    const harness = createComposedGateHarness({
      jobs: [
        {
          id: "10000000-0000-4000-8000-000000000006",
          title: "AI Engineer",
          company_name: "Strict Onsite Corp",
          description_text: "5 days onsite required at office.",
          job_version_id: "11000000-0000-4000-8000-000000000006",
          workplace_type: "ONSITE",
        },
        {
          id: "10000000-0000-4000-8000-000000000007",
          title: "Implementation Engineer",
          company_name: "Travel Corp",
          description_text: "50% travel required across APAC.",
          job_version_id: "11000000-0000-4000-8000-000000000007",
          workplace_type: "REMOTE",
        },
        {
          id: "10000000-0000-4000-8000-000000000008",
          title: "Forward Deployed Engineer - AI Applications",
          company_name: "Unicorn AI",
          description_text: "Forward deployment engineer delivering client integrations.",
          job_version_id: "11000000-0000-4000-8000-000000000008",
          workplace_type: "REMOTE",
        },
      ],
    });

    const res = await runHardGates(harness.client, { context: TEST_CONTEXT });

    expect(res.passed).toBe(0);
    expect(res.hardRejected).toBe(3);

    expect(harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000006")?.gate_decision).toBe("HARD_REJECT");
    expect(harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000007")?.gate_decision).toBe("HARD_REJECT");
    expect(harness.jobUpdates.find((u) => u.id === "10000000-0000-4000-8000-000000000008")?.gate_decision).toBe("HARD_REJECT");
  });
});

describe("Composed Pipeline Integration — Six Lane Routes & Multi-Lane Selection", () => {
  it("routes globally eligible candidates to all six active lanes with correct revisions and role families", async () => {
    const fixtures = [
      LANE_FIXTURES.L01, // CORE_AI_DATA
      LANE_FIXTURES.L02, // LEGAL_REGTECH
      LANE_FIXTURES.L03, // HEALTH_BIO_PHARMA
      LANE_FIXTURES.L04, // INVESTMENT_MARKETS_FINTECH
      LANE_FIXTURES.L05, // SOCIAL_IMPACT_MULTILATERAL
      LANE_FIXTURES.L06, // UNIVERSITY_AI_RESEARCH
    ];
    const harness = createLaneRouterTestHarness(fixtures);

    const result = await runLaneRouter(harness.client, { context: TEST_CONTEXT });

    expect(result.routed).toBe(6);
    expect(result.deferred).toBe(0);

    const routedLanes = fixtures.map((fixture) => {
      const update = harness.updates.find((u) => u.jobId === fixture.id);
      expect(update).toBeDefined();
      expect(update?.primaryLane).toBe(fixture.expectedLanes?.[0]);
      expect(update?.processingState).toBe("LANE_ROUTED");
      expect(update?.laneEvidence.some((e) => e.includes(fixture.expectedLanes?.[0]!))).toBe(true);
      return update?.primaryLane;
    });

    expect(new Set(routedLanes)).toEqual(new Set(ACTIVE_LANE_KEYS));
  });

  it("multi-lane candidate deterministically selects primary lane based on priority rank", async () => {
    // A job matching both LegalTech and Core AI with hybrid embeddings
    vi.mocked(agent.generateEmbeddingWithProvider).mockImplementation(async (text: string) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("senior legal ai") || (normalized.includes("mlops") && normalized.includes("regtech"))) {
        // High similarity to both CORE_AI_DATA (dim 0) and LEGAL_REGTECH (dim 1)
        return [0.707, 0.707, 0, 0, 0, 0];
      }
      return deterministicLaneEmbedding(text);
    });

    const multiLaneJob = {
      id: "multi-lane-1",
      title: "Senior Legal AI & Machine Learning Infrastructure Architect",
      company_name: "LegalTech AI Systems",
      location: "Singapore",
      workplace_type: "HYBRID",
      raw_description: "Build MLOps machine learning engineering infrastructure for RegTech compliance automation and legal document intelligence.",
      expectedStatus: "PASS",
      expectedLanes: ["CORE_AI_DATA", "LEGAL_REGTECH"],
    };

    const harness = createLaneRouterTestHarness([multiLaneJob]);
    const result = await runLaneRouter(harness.client, { context: TEST_CONTEXT });

    expect(result.routed).toBe(1);
    const update = harness.updates.find((u) => u.jobId === multiLaneJob.id);
    expect(update).toBeDefined();
    expect(update?.processingState).toBe("LANE_ROUTED");
    expect(update?.primaryLane).toBe("CORE_AI_DATA"); // Rank 1 in priority
    expect(update?.secondaryLanes).toContain("LEGAL_REGTECH");
  });

  it("semantic similarity cannot create a lane when deterministic negative concepts exclude it", async () => {
    // Merchant acquiring payments-only job has high fintech semantic overlap but is excluded deterministically
    const excludedJob = LANE_FIXTURES.L07;
    const harness = createLaneRouterTestHarness([excludedJob]);

    const result = await runLaneRouter(harness.client, { context: TEST_CONTEXT });

    expect(result.routed).toBe(0);
    expect(result.deferred).toBe(0);

    const update = harness.updates.find((u) => u.jobId === excludedJob.id);
    expect(update?.primaryLane).toBe("UNCLASSIFIED");
    expect(update?.processingState).toBe("UNMATCHED");
    expect(update?.laneEvidence[0]).toBe("ROUTING_POLICY_NO_MATCH");
    expect(update?.laneEvidence).toContain("NO_ACTIVE_LANE_MATCH");
  });
});

describe("Composed Pipeline Integration — Full Lifecycle Transition", () => {
  function createFullPipelineHarness(options: {
    canonicalJob: {
      id: string;
      latest_job_version_id: string;
      primary_lane: string;
      processing_state: string;
      processing_status: string;
    };
    requirements: Array<{
      id: string;
      requirement_key: string;
      requirement_type: string;
      importance: "MUST" | "PREFERRED" | "NICE_TO_HAVE";
      requirement_text: string;
      quote_text?: string;
      structured_value?: Record<string, unknown> | null;
    }>;
    profileFacts: Array<{
      id: string;
      fact_type: string;
      statement: string;
      evidence_tier: string;
      verification_status: string;
      structured_value: Record<string, unknown>;
    }>;
    embeddingsReady: boolean;
  }) {
    let updatedJobState: any = {};
    let recordedMatches: any[] = [];

    const mockClient = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        const s = String(sql || "");

        if (s.includes("profile_versions")) {
          return { rows: [{ id: "pv-active-1" }] };
        }

        if (s.includes("FROM profile_facts pf")) {
          return {
            rows: options.profileFacts.map((f) => ({
              ...f,
              embedding_node_id: f.id,
            })),
          };
        }

        if (s.includes("FROM profile_credentials pc") || s.includes("FROM profile_engagements")) {
          return { rows: [] };
        }

        if (s.includes("SELECT c.id,") && s.includes("FROM canonical_jobs c")) {
          return {
            rows: [
              {
                id: options.canonicalJob.id,
                latest_job_version_id: options.canonicalJob.latest_job_version_id,
                resolved_job_version_id: options.canonicalJob.latest_job_version_id,
              },
            ],
          };
        }

        if (s.includes("SELECT active_requirement_set_id, content_hash FROM job_versions")) {
          return { rows: [{ active_requirement_set_id: "req-set-1", content_hash: "hash-1" }] };
        }

        if (s.includes("INSERT INTO match_runs")) {
          return { rows: [{ id: "match-run-1" }] };
        }

        if (s.includes("job_requirements") && s.includes("job_versions")) {
          return { rows: options.requirements };
        }

        if (s.includes("embedding_spaces")) {
          return { rows: options.embeddingsReady ? [{ id: "space-1" }] : [] };
        }

        if (s.includes("v_matchable_nodes") && s.includes("COUNT")) {
          const nodeType = params?.[2];
          const count = nodeType === "PROFILE_FACT" ? options.profileFacts.length : options.requirements.length;
          return { rows: [{ n: options.embeddingsReady ? count : 0, count: options.embeddingsReady ? count : 0 }] };
        }

        if (s.includes("vector_dimensions") && s.includes("v_matchable_nodes")) {
          const nodeIds: string[] = params?.[3] || [];
          const resRows = options.embeddingsReady
            ? nodeIds.map((nid) => ({
                node_id: nid,
                vector_dimensions: 6,
                embedding_values: [1, 0, 0, 0, 0, 0],
              }))
            : [];
          return { rows: resRows };
        }

        if (s.includes("INSERT INTO requirement_evidence_matches")) {
          const hasLiteralNoMatch = s.includes("'NO_MATCH'");
          const isCoverageParam = s.includes("'NO_MATCH', $5");
          const isUnknownCoverageParam = s.includes("'UNKNOWN', $5, $6, $7");
          recordedMatches.push({
            requirement_id: params?.[2],
            profile_fact_id: params?.[3],
            match_type: isCoverageParam ? "NO_MATCH" : isUnknownCoverageParam ? "UNKNOWN" : hasLiteralNoMatch ? "NO_MATCH" : params?.[4],
            match_score: isCoverageParam ? params?.[4] : isUnknownCoverageParam ? params?.[4] : (hasLiteralNoMatch ? 0 : params?.[5]),
            rationale: isCoverageParam ? params?.[5] : isUnknownCoverageParam ? params?.[5] : (hasLiteralNoMatch ? params?.[4] : params?.[6]),
            evidence: JSON.parse((isCoverageParam ? params?.[6] : isUnknownCoverageParam ? params?.[6] : (hasLiteralNoMatch ? params?.[5] : params?.[7])) || "{}"),
          });
          return { rows: [] };
        }

        if (s.includes("UPDATE match_runs")) {
          return { rows: [] };
        }

        if (s.includes("UPDATE canonical_jobs")) {
          updatedJobState = {
            deterministic_match_score: params?.[1],
            deterministic_match_coverage: params?.[2],
            latest_match_run_id: params?.[3],
            profile_match_status: params?.[5],
            processing_state: params?.[8] ? "UNMATCHED" : (params?.[7] ? "LANE_ROUTED" : "MATCHED"),
            rejection_reason: params?.[8] ? params?.[9] : null,
          };
          return { rows: [], rowCount: 1 };
        }

        if (s.includes("BEGIN") || s.includes("COMMIT") || s.includes("ROLLBACK")) {
          return { rows: [] };
        }

        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    return { client: mockClient as unknown as PoolClient, getUpdatedJobState: () => updatedJobState, getRecordedMatches: () => recordedMatches };
  }

  it("transitions GATE_PASSED -> LANE_ROUTED -> qualification comparison -> semantic comparison -> MATCHED when fully qualified", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createFullPipelineHarness({
      canonicalJob: {
        id: "job-full-pass",
        latest_job_version_id: "jv-full-pass",
        primary_lane: "CORE_AI_DATA",
        processing_state: "LANE_ROUTED",
        processing_status: "LANE_ROUTED",
      },
      requirements: [
        {
          id: "req-1",
          requirement_key: "req_ml_eng",
          requirement_type: "FUNCTION",
          importance: "MUST",
          requirement_text: "Machine Learning Engineering",
        },
      ],
      profileFacts: [
        {
          id: "fact-1",
          fact_type: "FUNCTION",
          statement: "Machine Learning Engineering in PyTorch and MLOps",
          evidence_tier: "PROFESSIONAL_PRODUCTION",
          verification_status: "VERIFIED",
          structured_value: {},
        },
      ],
      embeddingsReady: true,
    });

    const res = await runDeterministicMatcher(harness.client, { context: TEST_CONTEXT });
    if (res.errors > 0) {
      console.log("MATCH ERRORS:", errorSpy.mock.calls);
    }

    expect(res.matchedJobs).toBe(1);
    const state = harness.getUpdatedJobState();
    expect(state.processing_state).toBe("MATCHED");
    expect(state.profile_match_status).toBe("POSITIVE_MATCH");
    expect(state.rejection_reason).toBeNull();
  });

  it("transitions GATE_PASSED -> LANE_ROUTED -> qualification failure -> UNMATCHED with MATCH_QUALIFICATION_MANDATORY_CERT_MISSING", async () => {
    const harness = createFullPipelineHarness({
      canonicalJob: {
        id: "job-mand-cert-fail",
        latest_job_version_id: "jv-mand-cert-fail",
        primary_lane: "CORE_AI_DATA",
        processing_state: "LANE_ROUTED",
        processing_status: "LANE_ROUTED",
      },
      requirements: [
        {
          id: "req-cert-mand",
          requirement_key: "req_cissp",
          requirement_type: "CREDENTIAL",
          importance: "MUST",
          requirement_text: "CISSP certification required",
          structured_value: { is_required: true, credential_name: "CISSP" },
        },
      ],
      profileFacts: [],
      embeddingsReady: true,
    });

    const res = await runDeterministicMatcher(harness.client, { context: TEST_CONTEXT });

    expect(res.skippedJobs).toBe(1);
    const state = harness.getUpdatedJobState();
    expect(state.processing_state).toBe("UNMATCHED");
    expect(state.profile_match_status).toBe("NO_PROFILE_MATCH");
    expect(state.rejection_reason).toContain("MATCH_QUALIFICATION_MANDATORY_CERT_MISSING");

    const match = harness.getRecordedMatches().find((m) => m.requirement_id === "req-cert-mand");
    expect(match?.match_type).toBe("NO_MATCH");
    expect(match?.evidence.match_qualification_code).toBe("MATCH_QUALIFICATION_MANDATORY_CERT_MISSING");
  });

  it("transitions GATE_PASSED -> LANE_ROUTED -> mandatory degree mismatch -> UNMATCHED with MATCH_QUALIFICATION_DEGREE_GAP", async () => {
    const harness = createFullPipelineHarness({
      canonicalJob: {
        id: "job-degree-gap",
        latest_job_version_id: "jv-degree-gap",
        primary_lane: "UNIVERSITY_AI_RESEARCH",
        processing_state: "LANE_ROUTED",
        processing_status: "LANE_ROUTED",
      },
      requirements: [
        {
          id: "req-degree-phd",
          requirement_key: "req_phd_cs",
          requirement_type: "DEGREE",
          importance: "MUST",
          requirement_text: "PhD in Computer Science required",
          structured_value: { degree_level: "phd", degree_subject: "computer science" },
        },
      ],
      profileFacts: [
        {
          id: "fact-degree-bachelor",
          fact_type: "DEGREE",
          statement: "Bachelor of Science in Computer Science",
          evidence_tier: "VERIFIED_DOCUMENT",
          verification_status: "VERIFIED",
          structured_value: { degree_level: "bachelor", degree_subject: "computer science" },
        },
      ],
      embeddingsReady: true,
    });

    const result = await runDeterministicMatcher(harness.client, { context: TEST_CONTEXT });

    expect(result.skippedJobs).toBe(1);
    expect(harness.getUpdatedJobState()).toMatchObject({
      processing_state: "UNMATCHED",
      profile_match_status: "NO_PROFILE_MATCH",
      rejection_reason: "MATCH_QUALIFICATION_DEGREE_GAP",
    });
    const match = harness.getRecordedMatches().find((entry) => entry.requirement_id === "req-degree-phd");
    expect(match?.evidence.match_qualification_code).toBe("MATCH_QUALIFICATION_DEGREE_GAP");
  });

  it("10-year experience ask with 1.5 years evidenced calculates mathematical fit (coverage 0.15) and does not hard reject", async () => {
    const harness = createFullPipelineHarness({
      canonicalJob: {
        id: "job-exp-partial",
        latest_job_version_id: "jv-exp-partial",
        primary_lane: "CORE_AI_DATA",
        processing_state: "LANE_ROUTED",
        processing_status: "LANE_ROUTED",
      },
      requirements: [
        {
          id: "req-exp-10",
          requirement_key: "req_ai_exp",
          requirement_type: "EXPERIENCE_YEARS",
          importance: "MUST",
          requirement_text: "10 years AI engineering experience",
          structured_value: { minimum_years: 10, experience_scope: "ai engineering" },
        },
      ],
      profileFacts: [
        {
          id: "fact-ai-1.5",
          fact_type: "EXPERIENCE_YEARS",
          statement: "1.5 years of AI engineering experience",
          evidence_tier: "PROFESSIONAL_PRODUCTION",
          verification_status: "VERIFIED",
          structured_value: { professional_years: 1.5, experience_scope: "ai engineering" },
        },
      ],
      embeddingsReady: true,
    });

    await runDeterministicMatcher(harness.client, { context: TEST_CONTEXT });

    const matches = harness.getRecordedMatches();
    const expMatch = matches.find((m) => m.requirement_id === "req-exp-10");
    expect(expMatch).toBeDefined();
    expect(expMatch?.match_type).toBe("UNKNOWN");
    expect(expMatch?.match_score).toBeCloseTo(0.15, 2);
    expect(expMatch?.evidence.experience_coverage).toBeCloseTo(0.15, 2);
    expect(expMatch?.evidence.match_qualification_code).toBeUndefined();

    // Proves it did not trigger UNMATCHED veto or hard reject; preserved for semantic evaluation
    const state = harness.getUpdatedJobState();
    expect(state.processing_state).toBe("MATCHED");
  });
});
