import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SourcePluginSchema, type ExtractedJob } from "../../contracts/index.js";
import { BaseSourceAdapter, type AdapterResult } from "../../ingestion/adapters/baseAdapter.js";
import {
  assessLocationScope,
  buildDiscoveryLocationScope,
  loadDiscoveryLocationScope,
  locationScopeAppliesTo,
  type LocationScopeConfig,
} from "../../ingestion/discoveryLocationScope.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { processSourcePage } from "../../../scripts/run_adapters.js";
import type { SourceBroker } from "../../ingestion/sourceBroker.js";

const CONFIG: LocationScopeConfig = {
  applies_to_source_keys: ["greenhouse", "lever", "ashby", "workable", "smartrecruiters"],
  region_terms: { SINGAPORE: ["singapore"] },
  regional_terms: ["apac", "asia pacific", "asia-pacific", "southeast asia", "asia"],
  remote_terms: ["remote", "work from home"],
  global_terms: ["worldwide", "global", "anywhere"],
  remote_filler_terms: ["first", "friendly", "fully", "only", "based", "from", "in", "the", "any", "or", "hybrid", "timezone"],
  unknown_location_terms: ["unknown", "not specified", "n/a", "multiple locations"],
};
const SCOPE = buildDiscoveryLocationScope(CONFIG, { authorizedRegions: ["SINGAPORE"], rejectExplicitForeignTerritory: true });

function posting(location: string, workplace = "UNKNOWN", title = "Synthetic Platform Architect") {
  return { title, location_raw: location, workplace_type_raw: workplace };
}

describe("discovery location scope", () => {
  it.each([
    ["Singapore", "LOCATION_IN_SCOPE"],
    ["Singapore, Singapore", "LOCATION_IN_SCOPE"],
    ["APAC", "LOCATION_IN_SCOPE"],
    ["Asia-Pacific (Remote)", "LOCATION_IN_SCOPE"],
    ["Southeast Asia", "LOCATION_IN_SCOPE"],
    ["Tokyo, Japan | Singapore", "LOCATION_IN_SCOPE"],
    ["Remote", "REMOTE_UNRESTRICTED"],
    ["Remote - Worldwide", "REMOTE_UNRESTRICTED"],
    ["Fully remote (any timezone)", "REMOTE_UNRESTRICTED"],
    ["San Francisco, CA; Remote", "REMOTE_UNRESTRICTED"],
    ["New York or Remote", "REMOTE_UNRESTRICTED"],
    ["", "LOCATION_UNKNOWN"],
    ["Unknown", "LOCATION_UNKNOWN"],
    ["Multiple Locations", "LOCATION_UNKNOWN"],
  ])("keeps %j (%s)", (location, reasonCode) => {
    expect(assessLocationScope(posting(location), SCOPE)).toMatchObject({ inScope: true, reasonCode });
  });

  it.each([
    "London, United Kingdom",
    "San Francisco, CA | New York City, NY",
    "Paris, Île-de-France, France",
    "Remote - US",
    "Remote, Canada only",
    "US Remote",
    "Remote (EMEA)",
    "Hybrid - Berlin, Germany",
  ])("skips %j as LOCATION_OUT_OF_SCOPE", (location) => {
    const decision = assessLocationScope(posting(location), SCOPE);
    expect(decision).toMatchObject({ inScope: false, reasonCode: "LOCATION_OUT_OF_SCOPE" });
    expect(decision.reason).toContain("SINGAPORE");
  });

  it("keeps a remote-flagged posting whose location is only an office base", () => {
    expect(assessLocationScope(posting("Paris, France", "REMOTE"), SCOPE)).toMatchObject({
      inScope: true,
      reasonCode: "REMOTE_FLAG_WITHOUT_RESTRICTION",
    });
  });

  it("skips a remote-flagged posting whose location restricts the remote territory", () => {
    expect(assessLocationScope(posting("Remote - US", "REMOTE"), SCOPE)).toMatchObject({ inScope: false });
  });

  it("keeps postings whose title names an in-scope region", () => {
    expect(assessLocationScope(posting("London, United Kingdom", "UNKNOWN", "Solutions Architect, APAC"), SCOPE).inScope).toBe(true);
  });

  it("does not match region terms inside other words", () => {
    expect(assessLocationScope(posting("Caucasian Heights, Asiago, Italy"), SCOPE).inScope).toBe(false);
  });

  it("is inactive when the workability policy does not reject foreign territory", () => {
    const inactive = buildDiscoveryLocationScope(CONFIG, { authorizedRegions: ["SINGAPORE"], rejectExplicitForeignTerritory: false });
    expect(locationScopeAppliesTo(inactive, "greenhouse")).toBe(false);
    expect(assessLocationScope(posting("London, United Kingdom"), inactive)).toMatchObject({ inScope: true, reasonCode: "LOCATION_SCOPE_INACTIVE" });
  });

  it("applies only to the configured source keys", () => {
    expect(locationScopeAppliesTo(SCOPE, "workable")).toBe(true);
    expect(locationScopeAppliesTo(SCOPE, "himalayas")).toBe(false);
    expect(locationScopeAppliesTo(null, "greenhouse")).toBe(false);
  });

  it("refuses an authorized region without configured terms", () => {
    expect(() => buildDiscoveryLocationScope(CONFIG, { authorizedRegions: ["SINGAPORE", "MALAYSIA"], rejectExplicitForeignTerritory: true }))
      .toThrow("MALAYSIA");
  });

  it("loads the repository config with regions from the workability policy", () => {
    const scope = loadDiscoveryLocationScope();
    expect(scope).not.toBeNull();
    expect(scope).toMatchObject({ active: true, authorizedRegions: ["SINGAPORE"] });
    expect([...scope!.sourceKeys].sort()).toEqual(["ashby", "greenhouse", "lever", "smartrecruiters", "workable"]);
    expect(scope!.inScopeTerms).toContain("singapore");
  });

  it("returns null when the source plan has no location_scope block and throws on a malformed one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jde-scope-"));
    const plan = path.join(dir, "plan.yml");
    fs.writeFileSync(plan, "plan_version: x\n");
    expect(loadDiscoveryLocationScope(plan)).toBeNull();
    fs.writeFileSync(plan, "location_scope:\n  applies_to_source_keys: []\n");
    expect(() => loadDiscoveryLocationScope(plan)).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

class StaticAdapter extends BaseSourceAdapter {
  readonly sourceName = "GREENHOUSE" as const;
  constructor(private readonly jobs: ExtractedJob[]) { super(); }
  async fetchJobs(): Promise<AdapterResult> {
    return { sourceName: this.sourceName, success: true, jobs: this.jobs, totalFetched: this.jobs.length, nextCursor: null, hasMore: false };
  }
}

function atsJob(id: string, location: string): ExtractedJob {
  return {
    schema_version: "2.2.0",
    source_external_id: id,
    company_name: "Example AI",
    title: "AI Engineer",
    location_raw: location,
    workplace_type_raw: "UNKNOWN",
    employment_type_raw: "FULL_TIME",
    compensation_raw: "UNKNOWN",
    canonical_apply_url: `https://boards.greenhouse.io/example/jobs/${id}`,
    description_raw: "Build AI systems, machine learning, LLM infrastructure and production data engineering platforms.",
    raw_payload: { id, location },
  };
}

function greenhousePlugin() {
  return SourcePluginSchema.parse({
    schema_version: "2.2.0",
    source_key: "greenhouse",
    display_name: "Greenhouse fixture",
    kind: "ats",
    status: "active",
    capabilities: { discovery: true, pagination: true, incremental: false, location_filter: false, work_mode_evidence: false },
    compliance: { access_basis: "official_api", terms_url: "https://developers.greenhouse.io/job-board.html", attribution_required: true, authenticated_scraping: false },
    schedule: { enabled: true, interval_minutes: 1440 },
    request: {
      endpoint: "https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs",
      timeout_ms: 10000,
      retry: { max_attempts: 1, base_delay_ms: 100, max_delay_ms: 1000 },
      rate_limit: { requests_per_minute: 10, items_per_run: null },
      pagination: { strategy: "cursor" },
      query: {},
    },
    mapping: { external_id: "$.id", title: "$.title", company: "$context", description: "$.content", url: "$.absolute_url", location: "$.location.name", work_mode: "x", employment_type: "x" },
  });
}

describe("processSourcePage location pre-filter", () => {
  it("records LOCATION_OUT_OF_SCOPE dispositions, creates no observation and reports skips by reason", async () => {
    const dispositions: Array<{ laneKey: string; disposition: string; reasonCode?: string | null; sourceExternalId: string | null }> = [];
    const staged: string[] = [];
    const finished: Array<{ status: string; counts: { itemsFiltered: number; itemsStaged: number } }> = [];
    const broker = {
      loadSourceCheckpoint: vi.fn(async () => null),
      saveSourceCheckpoint: vi.fn(async () => undefined),
      startSourcePlanRun: vi.fn(async () => "plan-run-1"),
      finishSourcePlanRun: vi.fn(async (_id: string, status: string, counts: { itemsFiltered: number; itemsStaged: number }) => {
        finished.push({ status, counts });
      }),
      processObservation: vi.fn(async (observation: { sourceExternalId: string | null }) => {
        staged.push(observation.sourceExternalId ?? "");
        return { observationId: `obs-${staged.length}`, inserted: true, normalizedEvidence: null };
      }),
      recordCandidateDisposition: vi.fn(async (item: { laneKey: string; disposition: string; reasonCode?: string | null; sourceExternalId: string | null }) => {
        dispositions.push(item);
      }),
    };
    const plans = new DiscoveryScoutPlanner().generateSearchPlans({ CORE_AI_DATA: ["Example AI"] });
    const summary = await processSourcePage({
      broker: broker as unknown as SourceBroker,
      plugin: greenhousePlugin(),
      adapter: new StaticAdapter([atsJob("sg-1", "Singapore"), atsJob("ldn-1", "London, United Kingdom"), atsJob("us-1", "Remote - US")]),
      checkpointTarget: "ats:example",
      planVersion: "v1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: ["CORE_AI_DATA"],
      targetCompanyId: "example",
      itemsPerRun: 50,
      plans,
      lanes: loadGlobalLanesConfig().lanes,
      locationScope: SCOPE,
    });

    expect(summary).toMatchObject({ success: true, discovered: 3, newlyStaged: 1, filtered: 2, skippedByReason: { LOCATION_OUT_OF_SCOPE: 2 } });
    expect(staged).toEqual(["sg-1"]);
    expect(dispositions.map((item) => [item.sourceExternalId, item.disposition, item.reasonCode])).toEqual([
      ["sg-1", "STAGED", "LANE_MATCHED"],
      ["ldn-1", "FILTERED", "LOCATION_OUT_OF_SCOPE"],
      ["us-1", "FILTERED", "LOCATION_OUT_OF_SCOPE"],
    ]);
    expect(finished).toEqual([{ status: "COMPLETED", counts: expect.objectContaining({ itemsStaged: 1, itemsFiltered: 2 }) }]);
  });

  it("does not filter feeds that the scope does not list", async () => {
    const broker = {
      loadSourceCheckpoint: vi.fn(async () => null),
      saveSourceCheckpoint: vi.fn(async () => undefined),
      startSourcePlanRun: vi.fn(async () => "plan-run-1"),
      finishSourcePlanRun: vi.fn(async () => undefined),
      processObservation: vi.fn(async () => ({ observationId: "obs-1", inserted: true, normalizedEvidence: null })),
      recordCandidateDisposition: vi.fn(async () => undefined),
    };
    const plugin = { ...greenhousePlugin(), source_key: "himalayas" };
    const plans = new DiscoveryScoutPlanner().generateSearchPlans({ CORE_AI_DATA: ["Example AI"] });
    const summary = await processSourcePage({
      broker: broker as unknown as SourceBroker,
      plugin,
      adapter: new StaticAdapter([atsJob("ldn-1", "London, United Kingdom")]),
      checkpointTarget: "feed:himalayas",
      planVersion: "v1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: ["CORE_AI_DATA"],
      targetCompanyId: null,
      itemsPerRun: 50,
      plans,
      lanes: loadGlobalLanesConfig().lanes,
      locationScope: SCOPE,
    });
    expect(summary).toMatchObject({ newlyStaged: 1, skippedByReason: {} });
  });
});
