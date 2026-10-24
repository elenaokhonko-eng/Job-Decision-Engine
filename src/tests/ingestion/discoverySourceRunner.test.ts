import { describe, expect, it, vi } from "vitest";
import { SourcePluginSchema, type ExtractedJob, type SourceName } from "../../contracts/index.js";
import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult, snapshotPage, stableAdapterIdentity } from "../../ingestion/adapters/baseAdapter.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { processSourcePage } from "../../../scripts/run_adapters.js";
import type { SourceBroker } from "../../ingestion/sourceBroker.js";

class FixtureAdapter extends BaseSourceAdapter {
  readonly sourceName: SourceName = "HIMALAYAS";
  constructor(private readonly jobs: ExtractedJob[]) { super(); }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    const limit = options.limit ?? 30;
    const page = snapshotPage(this.jobs, limit, options.cursor, options.page, stableAdapterIdentity);
    return {
      sourceName: this.sourceName,
      success: true,
      jobs: page.records,
      totalFetched: page.records.length,
      snapshotTotal: this.jobs.length,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}

function fixtureJob(index: number): ExtractedJob {
  const id = `posting-${String(index).padStart(3, "0")}`;
  return {
    schema_version: "2.2.0",
    source_external_id: id,
    company_name: "Example AI",
    title: "AI Engineer",
    location_raw: "Worldwide remote",
    workplace_type_raw: "REMOTE",
    employment_type_raw: "FULL_TIME",
    compensation_raw: "UNKNOWN",
    canonical_apply_url: `https://jobs.example.test/${id}`,
    description_raw: "Build AI systems, machine learning, LLM infrastructure, and production data engineering platforms.",
    raw_payload: { id, title: "AI Engineer" },
  };
}

function plugin() {
  return SourcePluginSchema.parse({
    schema_version: "2.2.0",
    source_key: "himalayas",
    display_name: "Himalayas fixture feed",
    kind: "json_api",
    status: "active",
    capabilities: { discovery: true, pagination: true, incremental: true, location_filter: false, work_mode_evidence: true },
    compliance: { access_basis: "public_feed", terms_url: "https://himalayas.app/", attribution_required: true, attribution_text: "Link back", authenticated_scraping: false },
    schedule: { enabled: true, interval_minutes: 60 },
    request: {
      endpoint: "https://himalayas.app/jobs/api",
      timeout_ms: 10000,
      retry: { max_attempts: 1, base_delay_ms: 100, max_delay_ms: 1000 },
      rate_limit: { requests_per_minute: 10, items_per_run: 30 },
      pagination: { strategy: "cursor", page_parameter: null, cursor_json_path: "$.nextCursor", next_link_json_path: null, checkpoint_field: "nextCursor" },
      query: { lane_keys: ["CORE_AI_DATA"] },
    },
    mapping: { external_id: "$.id", title: "$.title", company: "$.companyName", description: "$.description", url: "$.jobUrl", location: "$.location", work_mode: "$.workplaceType", employment_type: "$.employmentType" },
  });
}

function fakeBroker() {
  const checkpoint = new Map<string, Record<string, unknown>>();
  const observations = new Map<string, string>();
  const observationInputs: Array<{ sourceExternalId: string | null; sourceUrl?: string; canonicalApplyUrl?: string }> = [];
  const normalizedEvidence = { schema_version: "job_source_evidence_v1", evidence_revision: "fixture" };
  const dispositions: Array<{ laneKey: string | null; disposition: string; sourceExternalId: string | null; reasonCode?: string | null; reasonDetail?: string | null; normalizedEvidence?: unknown }> = [];
  let nextPlanId = 0;
  let failCheckpointOnce = false;
  let failFinishOnce = false;
  let failObservationOnce = false;
  const broker = {
    loadSourceCheckpoint: vi.fn(async (_pluginKey: string, key: string) => checkpoint.get(key) ?? null),
    saveSourceCheckpoint: vi.fn(async (_pluginKey: string, key: string, value: Record<string, unknown>) => {
      if (failCheckpointOnce) {
        failCheckpointOnce = false;
        throw new Error("simulated crash before checkpoint commit");
      }
      checkpoint.set(key, value);
    }),
    startSourcePlanRun: vi.fn(async () => `plan-run-${++nextPlanId}`),
    finishSourcePlanRun: vi.fn(async () => {
      if (failFinishOnce) {
        failFinishOnce = false;
        throw new Error("simulated crash after checkpoint commit");
      }
    }),
    processObservation: vi.fn(async (observation: { sourceExternalId: string | null; sourceUrl?: string; canonicalApplyUrl?: string }) => {
      observationInputs.push(observation);
      if (failObservationOnce) {
        failObservationOnce = false;
        throw new Error("simulated observation persistence failure");
      }
      const identity = observation.sourceExternalId ?? "unknown";
      const inserted = !observations.has(identity);
      const id = observations.get(identity) ?? `observation-${observations.size + 1}`;
      observations.set(identity, id);
      return { observationId: id, inserted, normalizedEvidence };
    }),
    recordCandidateDisposition: vi.fn(async (item: { laneKey: string | null; disposition: string; sourceExternalId: string | null; reasonCode?: string | null; reasonDetail?: string | null; normalizedEvidence?: unknown }) => {
      dispositions.push(item);
    }),
    recordError: vi.fn(),
    failCheckpointOnce: () => { failCheckpointOnce = true; },
    failFinishOnce: () => { failFinishOnce = true; },
    failObservationOnce: () => { failObservationOnce = true; },
    observations,
    observationInputs,
    normalizedEvidence,
    dispositions,
    checkpoint,
  };
  return broker;
}

describe("executed resumable six-lane source plans", () => {
  it("persists employer posting and application URLs as separate observation fields", async () => {
    const broker = fakeBroker();
    const sourcePlans = new DiscoveryScoutPlanner().generateSearchPlans();
    const job = {
      ...fixtureJob(1),
      employer_posting_url: "https://employer.example.test/roles/1",
      application_url: "https://apply.example.test/roles/1",
      canonical_apply_url: "https://apply.example.test/roles/1",
    };
    const summary = await processSourcePage({
      broker: broker as unknown as SourceBroker,
      plugin: plugin(),
      adapter: new FixtureAdapter([job]),
      checkpointTarget: "feed:himalayas",
      planVersion: "six_lane_sources_v1:plugin-revision-1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 30,
      plans: sourcePlans,
      lanes: loadGlobalLanesConfig().lanes,
    });

    expect(summary.success).toBe(true);
    expect(broker.observationInputs[0]?.sourceUrl).toBe("https://employer.example.test/roles/1");
    expect(broker.observationInputs[0]?.canonicalApplyUrl).toBe("https://apply.example.test/roles/1");
    expect(broker.dispositions[0]?.normalizedEvidence).toEqual(broker.normalizedEvidence);
  });

  it("records a durable ERROR disposition when observation staging fails and does not advance the page checkpoint", async () => {
    const broker = fakeBroker();
    const options = {
      broker: broker as unknown as SourceBroker,
      plugin: plugin(),
      adapter: new FixtureAdapter([fixtureJob(1)]),
      checkpointTarget: "feed:himalayas",
      planVersion: "six_lane_sources_v1:plugin-revision-1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 30,
      plans: new DiscoveryScoutPlanner().generateSearchPlans(),
      lanes: loadGlobalLanesConfig().lanes,
    };
    broker.failObservationOnce();

    const summary = await processSourcePage(options);

    expect(summary.success).toBe(false);
    expect(summary.error).toContain("simulated observation persistence failure");
    expect(broker.checkpoint.size).toBe(0);
    expect(broker.dispositions).toMatchObject([{
      disposition: "ERROR",
      reasonCode: "CANDIDATE_PROCESSING_FAILED",
      sourceExternalId: "posting-001",
    }]);
  });

  it("eventually stages every posting from later pages exactly once", async () => {
    const broker = fakeBroker();
    const sourcePlans = new DiscoveryScoutPlanner().generateSearchPlans();
    const laneConfig = loadGlobalLanesConfig();
    const jobs = Array.from({ length: 61 }, (_, index) => fixtureJob(index + 1));
    const adapter = new FixtureAdapter(jobs);
    const options = {
      broker: broker as unknown as SourceBroker,
      plugin: plugin(),
      adapter,
      checkpointTarget: "feed:himalayas",
      planVersion: "six_lane_sources_v1:plugin-revision-1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 30,
      plans: sourcePlans,
      lanes: laneConfig.lanes,
    };

    let summary = await processSourcePage(options);
    expect(summary.nextCursor).toBeTruthy();
    expect(broker.dispositions).toHaveLength(30);
    summary = await processSourcePage(options);
    expect(summary.nextCursor).toBeTruthy();
    expect(broker.dispositions).toHaveLength(60);
    summary = await processSourcePage(options);
    expect(summary.nextCursor).toBeNull();
    expect(summary.discovered).toBe(1);
    expect(broker.observations.size).toBe(61);
    expect(new Set([...broker.observations.keys()]).size).toBe(61);
    expect(broker.dispositions).toHaveLength(61);
    expect(broker.finishSourcePlanRun).toHaveBeenCalledTimes(3);
  });

  it("replays safely after work commits but checkpoint advancement fails", async () => {
    const broker = fakeBroker();
    const options = {
      broker: broker as unknown as SourceBroker,
      plugin: plugin(),
      adapter: new FixtureAdapter(Array.from({ length: 30 }, (_, index) => fixtureJob(index + 1))),
      checkpointTarget: "feed:himalayas",
      planVersion: "six_lane_sources_v1:plugin-revision-1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 30,
      plans: new DiscoveryScoutPlanner().generateSearchPlans(),
      lanes: loadGlobalLanesConfig().lanes,
    };
    broker.failCheckpointOnce();

    await expect(processSourcePage(options)).rejects.toThrow("simulated crash");
    expect(broker.observations.size).toBe(30);
    const replay = await processSourcePage(options);

    expect(replay.success).toBe(true);
    expect(broker.observations.size).toBe(30);
    expect(broker.processObservation).toHaveBeenCalledTimes(60);
    expect(broker.dispositions).toHaveLength(60);
    expect(broker.dispositions.slice(30).every((item) => item.disposition === "DUPLICATE")).toBe(true);
  });

  it("continues to the next page when a crash happens after the checkpoint commits", async () => {
    const broker = fakeBroker();
    const options = {
      broker: broker as unknown as SourceBroker,
      plugin: plugin(),
      adapter: new FixtureAdapter(Array.from({ length: 60 }, (_, index) => fixtureJob(index + 1))),
      checkpointTarget: "feed:himalayas",
      planVersion: "six_lane_sources_v1:plugin-revision-1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 30,
      plans: new DiscoveryScoutPlanner().generateSearchPlans(),
      lanes: loadGlobalLanesConfig().lanes,
    };
    broker.failFinishOnce();

    await expect(processSourcePage(options)).rejects.toThrow("simulated crash after checkpoint commit");
    expect(broker.checkpoint.get("discovery:six_lane_sources_v1:plugin-revision-1:feed:himalayas")?.cursor)
      .toBe("after:posting-030");
    const secondPage = await processSourcePage(options);

    expect(secondPage.success).toBe(true);
    expect(broker.observations.size).toBe(60);
    expect(broker.dispositions).toHaveLength(60);
  });
});
