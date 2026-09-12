import { describe, expect, it } from "vitest";
import {
  evaluateRetestGate,
  validateManagedApiConfig,
  type RetestGateFunnel,
} from "../../../scripts/check_e2e_retest_gate.js";

const cleanFunnel: RetestGateFunnel = {
  gatePassed: 10,
  prequalified: 0,
  routingDeferred: 2,
  currentRequirements: 10,
  currentMatches: 10,
  currentDecisions: 10,
  currentEvaluations: 0,
  activeEvaluationQueue: 0,
  eligibleWithoutCurrentMatch: 0,
  mandatoryPendingTasks: 0,
  blockedTasks: 0,
  retryingTasks: 0,
  deadLetterTasks: 0,
};

describe("managed API/desktop E2E retest gate", () => {
  it("requires a public HTTPS endpoint and all authenticated identity fields", () => {
    expect(validateManagedApiConfig({
      baseUrl: "http://127.0.0.1:3000/api/v2",
      token: "",
      workspaceKey: "",
      userKey: "",
    })).toEqual(expect.arrayContaining([
      "MANAGED_API_MUST_USE_PUBLIC_HTTPS",
      "MANAGED_API_TOKEN_MISSING",
      "WORKSPACE_KEY_MISSING",
      "WORKSPACE_USER_KEY_MISSING",
    ]));
  });

  it("fails closed on stale dependencies and prequalified jobs", () => {
    const blockers = evaluateRetestGate({
      managedApiConfigured: true,
      managedApiReachable: true,
      funnel: {
        ...cleanFunnel,
        prequalified: 1,
        eligibleWithoutCurrentMatch: 1,
        mandatoryPendingTasks: 1,
      },
    });

    expect(blockers).toEqual(expect.arrayContaining([
      "CURRENT_PROFILE_MATCHES_INCOMPLETE",
      "PREQUALIFIED_JOBS_AWAITING_LANE_ROUTING",
      "MANDATORY_PIPELINE_TASKS_PENDING",
    ]));
  });

  it("passes after managed API and currentness checks are clear", () => {
    expect(evaluateRetestGate({
      managedApiConfigured: true,
      managedApiReachable: true,
      funnel: cleanFunnel,
    })).toEqual([]);
  });
});
