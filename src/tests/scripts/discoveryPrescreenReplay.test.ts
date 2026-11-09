import { describe, expect, it } from "vitest";
import {
  isProtected,
  rejectionBucket,
  replayJob,
  summarizeReplay,
  type ReplayContext,
  type ReplayJobRow,
} from "../../../scripts/replay_discovery_prescreen.js";
import { parseReleaseArgs } from "../../../scripts/release_filtered_disposition_payloads.js";
import { boardYieldMarkdown } from "../../../scripts/report_pipeline_status.js";
import { boardYieldReportEnabled, summarizeBoardYield } from "../../reporting/boardYield.js";
import { loadDiscoveryLocationScope } from "../../ingestion/discoveryLocationScope.js";
import { PRESCREEN_TIER1_DEFAULTS } from "../../ingestion/discoveryPrescreen.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";

// Synthetic rows only.
const DESCRIPTION = "Build machine learning platform services, LLM infrastructure and data engineering pipelines as an AI engineer.";

function row(overrides: Partial<ReplayJobRow>): ReplayJobRow {
  return {
    canonical_job_id: "00000000-0000-4000-8000-000000000001",
    title: "Senior AI Engineer",
    company_name: "Example Company",
    source_name: "HIMALAYAS",
    source_plugin_key: "himalayas",
    description_raw: DESCRIPTION,
    location_raw: "Unknown",
    workplace_type_raw: "REMOTE",
    raw_payload: {},
    lane_keys: ["CORE_AI_DATA"],
    board: "feed:himalayas",
    gate_decision: "HARD_REJECT",
    rejection_codes: ["NON_TECHNICAL_FUNCTION"],
    evaluated: false,
    outcome: null,
    user_marked: false,
    ...overrides,
  };
}

const context: ReplayContext = {
  plans: new DiscoveryScoutPlanner().generateSearchPlans(),
  lanes: loadGlobalLanesConfig().lanes,
  locationScope: loadDiscoveryLocationScope(),
  tier1: { ...PRESCREEN_TIER1_DEFAULTS },
};

describe("discovery pre-screen replay", () => {
  it("attributes each drop to the first new rule and leaves non-adapter jobs alone", () => {
    expect(replayJob(row({ title: "Machine Learning Intern" }), context)).toMatchObject({ rule: "PRESCREEN_TITLE_DENY", detail: "intern" });
    expect(replayJob(row({ raw_payload: { locationRestrictions: ["United States"] } }), context)).toMatchObject({ rule: "GEO_FIELD_OUT_OF_SCOPE" });
    expect(replayJob(row({}), context)).toMatchObject({ rule: null });
    expect(replayJob(row({ location_raw: "Berlin, Germany", workplace_type_raw: "ONSITE", source_plugin_key: "greenhouse", board: "ats:example" }), context))
      .toMatchObject({ rule: "EXISTING_LOCATION_SCOPE" });
    expect(replayJob(row({ source_plugin_key: "gmail_alert", lane_keys: null, board: null, title: "Machine Learning Intern" }), context))
      .toMatchObject({ rule: null });
    expect(replayJob(row({ source_plugin_key: "gmail_alert", lane_keys: null, title: "Senior GL Accountant" }), context))
      .toMatchObject({ rule: null, gateTitle: "GL Accountant" });
  });

  it("counts damage only for protected jobs and buckets the original rejection", () => {
    expect(rejectionBucket(row({ rejection_codes: ["WORK_AUTHORIZATION_INCOMPATIBLE", "GATE_OUT_OF_SCOPE_DOMAIN"] }))).toBe("WORK_AUTHORIZATION_INCOMPATIBLE");
    expect(rejectionBucket(row({ rejection_codes: ["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"] }))).toBe("ROLE_CODES");
    expect(rejectionBucket(row({ gate_decision: "PASS", rejection_codes: [] }))).toBe("PASS");
    expect(isProtected(row({}))).toBe(false);
    expect(isProtected(row({ evaluated: true }))).toBe(true);
    expect(isProtected(row({ outcome: "REVIEW" }))).toBe(true);

    const summary = summarizeReplay([
      row({ title: "Machine Learning Intern" }),
      row({ title: "Account Executive", gate_decision: "PASS", rejection_codes: [] }),
      row({}),
    ], context);
    expect(summary).toMatchObject({
      saving_hard_rejects_total_new_rules: 1,
      damage_count: 1,
      damage_by_category: { gate_pass: 1, priority_or_review: 0, user_marked: 0 },
    });
  });
});

describe("board yield report", () => {
  it("is off by default and flags boards with no gate pass after 20 staged jobs", () => {
    expect(boardYieldReportEnabled({})).toBe(false);
    expect(boardYieldReportEnabled({ PIPELINE_BOARD_YIELD_REPORT_ENABLED: "true" })).toBe(true);
    expect(() => boardYieldReportEnabled({ PIPELINE_BOARD_YIELD_REPORT_ENABLED: "on" })).toThrow();
    const summary = summarizeBoardYield([
      { source: "GREENHOUSE", board: "ats:example_a", staged: 20, hard_rejected: 20, passed_gates: 0, evaluated: 0, priority_review: 0 },
      { source: "GREENHOUSE", board: "ats:example_b", staged: 19, hard_rejected: 19, passed_gates: 0, evaluated: 0, priority_review: 0 },
      { source: "ASHBY", board: "ats:example_c", staged: 30, hard_rejected: 20, passed_gates: 10, evaluated: 2, priority_review: 1 },
    ]);
    expect(summary.flagged_boards).toEqual(["GREENHOUSE ats:example_a"]);
    const markdown = boardYieldMarkdown(summary).join("\n");
    expect(markdown).toContain("### Board yield (jobs first seen in the last 7 days)");
    expect(markdown).toContain("| GREENHOUSE | ats:example\\_a | 20 | 20 | 0 | 0 | 0 | 0 passes |");
    expect(boardYieldMarkdown(null)).toEqual([]);
  });
});

describe("FILTERED payload retention arguments", () => {
  it("defaults to a 30-day dry run and refuses a shorter window", () => {
    expect(parseReleaseArgs([])).toEqual({ apply: false, olderThanDays: 30, batchSize: 500 });
    expect(parseReleaseArgs(["--apply", "--older-than-days", "45"])).toMatchObject({ apply: true, olderThanDays: 45 });
    expect(() => parseReleaseArgs(["--older-than-days", "7"])).toThrow(/at least 30/);
  });
});
