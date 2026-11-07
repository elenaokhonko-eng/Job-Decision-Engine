import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceNameSchema, SourcePluginSchema } from "../../contracts/index.js";
import {
  HN_MAX_COMMENTS_PER_RUN,
  HN_MAX_THREAD_COMMENTS,
  HackerNewsWhoIsHiringAdapter,
  isWhoIsHiringTitle,
  parseWhoIsHiringComment,
  prefilterWhoIsHiringPost,
  type HackerNewsAdapterOptions,
  type HnItem,
} from "../../ingestion/adapters/hackerNewsWhoIsHiringAdapter.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { loadWorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";
import { processSourcePage } from "../../../scripts/run_adapters.js";
import type { SourceBroker } from "../../ingestion/sourceBroker.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import {
  HN_FIXTURE_BASE,
  HN_FIXTURE_COMMENTS,
  HN_FIXTURE_NOW,
  HN_FIXTURE_POSTED_AT,
  HN_FIXTURE_THREAD_ID,
  hnComment,
  hnFetchStub,
  hnFixtureItems,
} from "../fixtures/hackerNewsWhoIsHiring.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function adapter(options: HackerNewsAdapterOptions = {}): HackerNewsWhoIsHiringAdapter {
  return new HackerNewsWhoIsHiringAdapter(HN_FIXTURE_BASE, { now: () => HN_FIXTURE_NOW, retryDelayMs: 0, ...options });
}

function stub(items = hnFixtureItems(), hooks: Parameters<typeof hnFetchStub>[1] = {}) {
  const fixture = hnFetchStub(items, hooks);
  vi.stubGlobal("fetch", vi.fn(fixture.fetchImpl));
  return fixture;
}

function asItem(value: unknown): HnItem {
  return value as HnItem;
}

describe("Hacker News who-is-hiring thread discovery", () => {
  it("recognises only the hiring thread title", () => {
    expect(isWhoIsHiringTitle("Ask HN: Who is hiring? (November 2026)")).toBe(true);
    expect(isWhoIsHiringTitle("Ask HN: Who wants to be hired? (November 2026)")).toBe(false);
    expect(isWhoIsHiringTitle("Ask HN: Freelancer? Seeking freelancer? (November 2026)")).toBe(false);
    expect(isWhoIsHiringTitle(undefined)).toBe(false);
  });

  it("picks the newest hiring thread and skips the wants-to-be-hired and freelancer threads", async () => {
    const fixture = stub();
    const result = await adapter().fetchJobs({ limit: 200 });

    expect(result.success).toBe(true);
    expect(result.snapshotId).toBe(String(HN_FIXTURE_THREAD_ID));
    expect(fixture.requested.slice(0, 4)).toEqual(["user/whoishiring", "item/4800003", "item/4800002", `item/${HN_FIXTURE_THREAD_ID}`]);
    expect(fixture.requested).not.toContain("item/4700000");
  });

  it("fails the source run when no hiring thread is among the newest submissions", async () => {
    const items = hnFixtureItems();
    items[`item/${HN_FIXTURE_THREAD_ID}`] = { id: HN_FIXTURE_THREAD_ID, by: "whoishiring", type: "story", title: "Ask HN: Who wants to be hired? (November 2026)" };
    stub(items);
    const result = await adapter({ maxThreadCandidates: 3 }).fetchJobs();

    expect(result.success).toBe(false);
    expect(result.jobs).toEqual([]);
    expect(result.error).toContain("No \"Ask HN: Who is hiring?\" thread");
  });
});

describe("Hacker News who-is-hiring comment parsing", () => {
  it("maps a pipe-separated post with roles, location, remote flag, salary and URL", async () => {
    stub();
    const result = await adapter().fetchJobs({ limit: 200 });
    const job = result.jobs.find((candidate) => candidate.source_external_id === "4800101");

    expect(job).toMatchObject({
      company_name: "Quillfeather Labs",
      title: "Senior ML Engineer, Data Platform Engineer",
      location_raw: "Singapore or REMOTE",
      workplace_type_raw: "REMOTE",
      employment_type_raw: "Full-time",
      compensation_raw: "$150k-$190k + equity",
      employer_posting_url: "https://news.ycombinator.com/item?id=4800101",
      application_url: "https://quillfeather.example/careers",
      canonical_apply_url: "https://quillfeather.example/careers",
      published_at: new Date((HN_FIXTURE_POSTED_AT + 101) * 1000).toISOString(),
      source_attribution: "Hacker News: Ask HN: Who is hiring? (November 2026)",
    });
    expect(job?.description_raw).toContain("Quillfeather Labs | Senior ML Engineer");
    expect(job?.description_raw).toContain("Requirements: several years building distributed systems");
    expect(job?.description_raw).not.toContain("<p>");
  });

  it("keeps salary unknown when the header has none and uses the body link as the apply URL", async () => {
    stub();
    const result = await adapter().fetchJobs({ limit: 200 });
    const job = result.jobs.find((candidate) => candidate.source_external_id === "4800102");

    expect(job).toMatchObject({
      company_name: "Northwind Genomics",
      title: "Bioinformatics Data Engineer",
      location_raw: "Remote (APAC)",
      workplace_type_raw: "REMOTE",
      compensation_raw: "UNKNOWN",
      employment_type_raw: "UNKNOWN",
      application_url: "https://jobs.northwind-genomics.example/apply/7",
    });
    // HN truncates long link text; the stored description keeps the full href.
    expect(job?.description_raw).toContain("https://jobs.northwind-genomics.example/apply/7");
  });

  it("joins several role segments into one observation per comment", async () => {
    stub();
    const result = await adapter().fetchJobs({ limit: 200 });
    const job = result.jobs.find((candidate) => candidate.source_external_id === "4800103");

    expect(job).toMatchObject({ company_name: "Lumen Ledger", title: "Backend Engineer; Platform Architect", location_raw: "Remote", workplace_type_raw: "REMOTE" });
    expect(job?.application_url).toBeUndefined();
    expect(job?.canonical_apply_url).toBe("https://news.ycombinator.com/item?id=4800103");
  });

  it("reads a URL from the comment text and a hybrid work mode", async () => {
    stub();
    const result = await adapter().fetchJobs({ limit: 200 });
    const job = result.jobs.find((candidate) => candidate.source_external_id === "4800104");

    expect(job).toMatchObject({
      company_name: "Tidewater Compliance",
      title: "Solutions Architect",
      location_raw: "Hybrid, Singapore",
      workplace_type_raw: "HYBRID",
      application_url: "https://tidewater.example/jobs/42",
    });
  });

  it("accepts an unpiped 'X is hiring a Y' header and never treats a funding amount as salary", async () => {
    stub();
    const result = await adapter().fetchJobs({ limit: 200 });

    expect(result.jobs.find((candidate) => candidate.source_external_id === "4800110")).toMatchObject({
      company_name: "Fernleaf Health",
      title: "Clinical Data Engineer",
      location_raw: "Unknown",
      workplace_type_raw: "UNKNOWN",
    });
    expect(result.jobs.find((candidate) => candidate.source_external_id === "4800111")).toMatchObject({
      company_name: "Glimmer AI",
      title: "AI Engineer",
      location_raw: "London",
      workplace_type_raw: "UNKNOWN",
      compensation_raw: "UNKNOWN",
    });
  });

  it("skips non-conforming, deleted and dead comments with a counted reason and their raw payload", async () => {
    stub();
    const hn = adapter();
    const result = await hn.fetchJobs({ limit: 200 });

    expect(result.success).toBe(true);
    expect(result.totalFetched).toBe(11);
    expect(result.jobs).toHaveLength(8);
    expect(result.filteredCandidates?.map((candidate) => [candidate.identity, candidate.reasonCode])).toEqual([
      ["4800105", "HN_NON_CONFORMING_POST"],
      ["4800106", "HN_COMMENT_DELETED"],
      ["4800107", "HN_COMMENT_DEAD"],
    ]);
    expect(result.filteredCandidates?.[1]?.rawPayload).toEqual({
      hn_item: HN_FIXTURE_COMMENTS[4_800_106],
      thread: { id: HN_FIXTURE_THREAD_ID, title: "Ask HN: Who is hiring? (November 2026)" },
    });
    expect(hn.lastRunStats?.skipped).toEqual({ HN_NON_CONFORMING_POST: 1, HN_COMMENT_DELETED: 1, HN_COMMENT_DEAD: 1 });
  });

  it("stores the comment without its volatile reply list, so only an edit changes the payload hash", async () => {
    stub();
    const first = await adapter().fetchJobs({ limit: 200 });
    const repliesAdded = hnFixtureItems();
    repliesAdded["item/4800101"] = { ...HN_FIXTURE_COMMENTS[4_800_101], kids: [1, 2, 3] };
    vi.unstubAllGlobals();
    stub(repliesAdded);
    const second = await adapter().fetchJobs({ limit: 200 });
    const edited = hnFixtureItems();
    edited["item/4800101"] = { ...HN_FIXTURE_COMMENTS[4_800_101], text: "Quillfeather Labs | Staff ML Engineer | REMOTE<p>Edited post." };
    vi.unstubAllGlobals();
    stub(edited);
    const third = await adapter().fetchJobs({ limit: 200 });

    const hash = (result: typeof first) => createHash("sha256")
      .update(JSON.stringify(result.jobs.find((job) => job.source_external_id === "4800101")?.raw_payload))
      .digest("hex");
    expect(JSON.stringify(first.jobs[0]?.raw_payload)).not.toContain("\"kids\"");
    expect(hash(second)).toBe(hash(first));
    expect(hash(third)).not.toBe(hash(first));
    expect(third.jobs.find((job) => job.source_external_id === "4800101")?.title).toBe("Staff ML Engineer");
  });

  it("reads role titles listed in the body when the header says only 'Multiple roles'", () => {
    const listed = parseWhoIsHiringComment(asItem(hnComment(1_100,
      "Synthetic Orchard | Multiple roles | Remote (EU) | Full-time<p>We grow a data platform for farms.<p>- Senior Data Engineer<p>- Staff ML Engineer: https:&#x2F;&#x2F;orchard.example&#x2F;ml<p>Requirements: 5+ years as an engineer.")), HN_FIXTURE_THREAD_ID);
    expect(listed).toMatchObject({ kind: "POSTING", post: { title: "Senior Data Engineer; Staff ML Engineer", locationRaw: "Remote (EU)" } });

    const rolesLine = parseWhoIsHiringComment(asItem(hnComment(1_101,
      "Synthetic Orchard | Remote<p>Roles: Platform Architect, Data Engineer and Product Designer")), HN_FIXTURE_THREAD_ID);
    expect(rolesLine).toMatchObject({ kind: "POSTING", post: { title: "Platform Architect; Data Engineer; Product Designer" } });

    const placeholderOnly = parseWhoIsHiringComment(asItem(hnComment(1_102,
      "Synthetic Orchard | Multiple Engineering Roles | Remote<p>See our site for details.")), HN_FIXTURE_THREAD_ID);
    expect(placeholderOnly).toMatchObject({ kind: "POSTING", post: { title: "Multiple Engineering Roles" } });

    const noRoles = parseWhoIsHiringComment(asItem(hnComment(1_103,
      "Synthetic Orchard | Remote | Full-time<p>We are growing and would love to hear from you.")), HN_FIXTURE_THREAD_ID);
    expect(noRoles).toMatchObject({ kind: "SKIPPED", reasonCode: "HN_NON_CONFORMING_POST" });
  });

  it("cuts prose that runs into a header segment and keeps benefits out of the location", () => {
    const parsed = parseWhoIsHiringComment(asItem(hnComment(1_200,
      "Synthetic Mills | Software Engineers | REMOTE (all remote). Synthetic Mills makes tools for weavers | Equity | VISA + relocation")), HN_FIXTURE_THREAD_ID);
    expect(parsed).toMatchObject({ kind: "POSTING", post: { title: "Software Engineers", locationRaw: "REMOTE (all remote)" } });
  });

  it("parses comments deterministically without the network", () => {
    const parsed = parseWhoIsHiringComment(asItem(hnComment(1_000, "Acme Example | Staff Data Engineer | Remote | acme-synthetic-fixture.io/jobs")), HN_FIXTURE_THREAD_ID);
    expect(parsed).toMatchObject({ kind: "POSTING", post: { company: "Acme Example", applyUrl: "https://acme-synthetic-fixture.io/jobs" } });
    const nodeJs = parseWhoIsHiringComment(asItem(hnComment(1_001, "Acme Example | Backend Engineer | Node.js | Remote")), HN_FIXTURE_THREAD_ID);
    expect(nodeJs).toMatchObject({ kind: "POSTING", post: { applyUrl: null } });
    const reply = parseWhoIsHiringComment(asItem(hnComment(1_002, "Acme | Engineer", { parent: 999 })), HN_FIXTURE_THREAD_ID);
    expect(reply).toMatchObject({ kind: "SKIPPED", reasonCode: "HN_NOT_TOP_LEVEL_COMMENT" });
    const empty = parseWhoIsHiringComment(asItem(hnComment(1_003, "")), HN_FIXTURE_THREAD_ID);
    expect(empty).toMatchObject({ kind: "SKIPPED", reasonCode: "HN_EMPTY_COMMENT" });
  });
});

describe("Hacker News workability pre-filter", () => {
  const policy = loadWorkabilityPolicy();

  it("drops only on-site-only posts and explicit foreign-territory remote posts under the configured policy", async () => {
    stub();
    const hn = adapter({ workabilityPolicy: policy });
    const result = await hn.fetchJobs({ limit: 200 });

    const filtered = Object.fromEntries((result.filteredCandidates ?? []).map((candidate) => [candidate.identity, candidate.reasonCode]));
    expect(filtered["4800108"]).toBe("PREFILTER_ONSITE_ONLY");
    expect(filtered["4800109"]).toBe("PREFILTER_WORK_TERRITORY_INCOMPATIBLE");
    // Unknown work mode (London, no mode) and non-exclusive remote regions are left for the gates.
    expect(result.jobs.map((job) => job.source_external_id)).toEqual(["4800101", "4800102", "4800103", "4800104", "4800110", "4800111"]);
    expect(hn.lastRunStats?.skipped).toMatchObject({ PREFILTER_ONSITE_ONLY: 1, PREFILTER_WORK_TERRITORY_INCOMPATIBLE: 1 });
  });

  it("keeps everything that parses when the policy allows on-site work and authorises the territory", () => {
    const onsite = parseWhoIsHiringComment(asItem(HN_FIXTURE_COMMENTS[4_800_108]), HN_FIXTURE_THREAD_ID);
    const usOnly = parseWhoIsHiringComment(asItem(HN_FIXTURE_COMMENTS[4_800_109]), HN_FIXTURE_THREAD_ID);
    if (onsite.kind !== "POSTING" || usOnly.kind !== "POSTING") throw new Error("fixture posts must parse");
    const permissive = { ...policy, onsiteOnlyAllowed: true, allowedWorkModes: ["REMOTE", "HYBRID", "ONSITE"] as Array<"REMOTE" | "HYBRID" | "ONSITE">, authorizedRegions: ["SINGAPORE", "UNITED_STATES"] };
    expect(prefilterWhoIsHiringPost(onsite.post, permissive)).toBeNull();
    expect(prefilterWhoIsHiringPost(usOnly.post, permissive)).toBeNull();
  });

  it("leaves partial attendance and visa mentions to the gates", () => {
    const partial = parseWhoIsHiringComment(asItem(hnComment(2_001, "Acme | Site Reliability Engineer | Denver, CO | On-site 2-3x per week | Full-time")), HN_FIXTURE_THREAD_ID);
    const visa = parseWhoIsHiringComment(asItem(hnComment(2_002, "Acme | Research Engineer | Hong Kong | Full Time | Visa | Relocation")), HN_FIXTURE_THREAD_ID);
    const citizens = parseWhoIsHiringComment(asItem(hnComment(2_003, "Acme | Applied AI Engineer | REMOTE (US Citizenship Required)")), HN_FIXTURE_THREAD_ID);
    if (partial.kind !== "POSTING" || visa.kind !== "POSTING" || citizens.kind !== "POSTING") throw new Error("fixture posts must parse");
    expect(partial.post).toMatchObject({ workMode: "ONSITE", attendanceQualified: true });
    expect(prefilterWhoIsHiringPost(partial.post, policy)).toBeNull();
    expect(prefilterWhoIsHiringPost(visa.post, policy)).toBeNull();
    expect(prefilterWhoIsHiringPost(citizens.post, policy)?.reasonCode).toBe("PREFILTER_WORK_TERRITORY_INCOMPATIBLE");
  });

  it("keeps an on-site header when the body offers remote or hybrid work", () => {
    const parsed = parseWhoIsHiringComment(asItem(hnComment(2_000, "Acme | Data Engineer | Austin, TX | ONSITE<p>Remote considered for senior candidates.")), HN_FIXTURE_THREAD_ID);
    if (parsed.kind !== "POSTING") throw new Error("fixture post must parse");
    expect(prefilterWhoIsHiringPost(parsed.post, policy)).toBeNull();
  });
});

describe("Hacker News adapter bounds and cursor", () => {
  it("reads at most the page limit with at most four requests in flight and resumes from the cursor", async () => {
    const fixture = stub(hnFixtureItems(), { delayMs: 5 });
    const hn = adapter();
    const first = await hn.fetchJobs({ limit: 5 });

    expect(first.totalFetched).toBe(5);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(`hn:${HN_FIXTURE_THREAD_ID}:4800105`);
    expect(fixture.maxInFlight()).toBeLessThanOrEqual(4);
    expect(fixture.maxInFlight()).toBeGreaterThan(1);

    const second = await hn.fetchJobs({ limit: 5, cursor: first.nextCursor });
    expect(second.jobs.map((job) => job.source_external_id)).toEqual(["4800108", "4800109", "4800110"]);
    const third = await hn.fetchJobs({ limit: 5, cursor: second.nextCursor });
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBe(`hn:${HN_FIXTURE_THREAD_ID}:4800111`);

    // Once the thread is swept, a run reads only the thread metadata until new comments appear.
    const before = fixture.requested.length;
    const idle = await hn.fetchJobs({ limit: 5, cursor: third.nextCursor });
    expect(idle).toMatchObject({ success: true, totalFetched: 0, jobs: [], nextCursor: third.nextCursor, hasMore: false });
    expect(fixture.requested.slice(before).filter((request) => /^item\/48001\d\d$/.test(request))).toEqual([]);
  });

  it("caps comments per run even when a larger limit is requested", async () => {
    const comments = Object.fromEntries(Array.from({ length: HN_MAX_COMMENTS_PER_RUN + 20 }, (_, index) => {
      const id = 4_810_000 + index;
      return [id, hnComment(id, `Synthetic Co ${index} | Data Engineer | Remote`)];
    }));
    stub(hnFixtureItems({ comments }));
    const result = await adapter().fetchJobs({ limit: 10_000 });

    expect(result.totalFetched).toBe(HN_MAX_COMMENTS_PER_RUN);
    expect(result.hasMore).toBe(true);
  });

  it("fails rather than reading an implausibly large thread", async () => {
    const kids = Array.from({ length: HN_MAX_THREAD_COMMENTS + 1 }, (_, index) => 5_000_000 + index);
    stub(hnFixtureItems({ threadKids: kids }));
    const result = await adapter().fetchJobs();

    expect(result.success).toBe(false);
    expect(result.error).toContain(`limit is ${HN_MAX_THREAD_COMMENTS}`);
  });

  it("holds the cursor before comments still inside the HN edit window", async () => {
    const fresh = hnFixtureItems();
    fresh["item/4800104"] = { ...HN_FIXTURE_COMMENTS[4_800_104], time: Math.floor(HN_FIXTURE_NOW.getTime() / 1000) - 600 };
    stub(fresh);
    const result = await adapter().fetchJobs({ limit: 200 });

    expect(result.jobs.map((job) => job.source_external_id)).toContain("4800104");
    expect(result.nextCursor).toBe(`hn:${HN_FIXTURE_THREAD_ID}:4800103`);
  });

  it("restarts at the first comment of a newer monthly thread", async () => {
    stub(hnFixtureItems({ newerThreadId: 4_900_001 }));
    const hn = adapter();
    const result = await hn.fetchJobs({ limit: 200, cursor: `hn:${HN_FIXTURE_THREAD_ID}:4800111` });

    expect(result.snapshotId).toBe("4900001");
    expect(result.totalFetched).toBe(11);
    expect(hn.lastRunStats?.cursorReset).toBe("NEW_THREAD");
  });
});

describe("Hacker News adapter failures are source-run failures", () => {
  it("retries a transient 5xx once and then succeeds", async () => {
    let failures = 0;
    stub(hnFixtureItems(), { respond: (requestPath) => requestPath === "item/4800103" && failures++ === 0 ? new Response("", { status: 503 }) : undefined });
    const result = await adapter().fetchJobs({ limit: 200 });

    expect(result.success).toBe(true);
    expect(failures).toBe(2);
    expect(result.jobs.some((job) => job.source_external_id === "4800103")).toBe(true);
  });

  it("fails the whole page, with no jobs, when a comment keeps failing", async () => {
    stub(hnFixtureItems(), { respond: (requestPath) => requestPath === "item/4800103" ? new Response("", { status: 503 }) : undefined });
    const result = await adapter().fetchJobs({ limit: 200 });

    expect(result).toMatchObject({ success: false, jobs: [], totalFetched: 0 });
    expect(result.error).toContain("HTTP 503");
    expect(result.nextCursor).toBeUndefined();
  });

  it("reports rate limiting without retrying", async () => {
    const fixture = stub(hnFixtureItems(), { respond: (requestPath) => requestPath === "user/whoishiring" ? new Response("", { status: 429 }) : undefined });
    const result = await adapter().fetchJobs();

    expect(result).toMatchObject({ success: false, isRateLimited: true });
    expect(fixture.requested).toEqual(["user/whoishiring"]);
  });

  it("reports a timeout", async () => {
    stub(hnFixtureItems(), { delayMs: 50 });
    const result = await adapter({ requestTimeoutMs: 1, maxAttempts: 1 }).fetchJobs();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timeout after 1ms");
  });

  it("stops at the run deadline", async () => {
    stub(hnFixtureItems(), { delayMs: 20 });
    const result = await adapter({ runDeadlineMs: 1 }).fetchJobs();

    expect(result.success).toBe(false);
    expect(result.error).toContain("deadline");
  });

  it("reports malformed JSON and a user record without submissions", async () => {
    stub(hnFixtureItems(), { respond: (requestPath) => requestPath === "item/4800101" ? new Response("{not json", { status: 200 }) : undefined });
    const malformed = await adapter().fetchJobs({ limit: 200 });
    expect(malformed.success).toBe(false);
    expect(malformed.error).toContain("Malformed HN API response");

    vi.unstubAllGlobals();
    const items = hnFixtureItems();
    items["user/whoishiring"] = { id: "whoishiring" };
    stub(items);
    const noSubmissions = await adapter().fetchJobs();
    expect(noSubmissions.success).toBe(false);
    expect(noSubmissions.error).toContain("no submitted list");
  });
});

describe("Hacker News source registration and runner dispositions", () => {
  it("registers HACKER_NEWS and a valid manifest with exact availability hosts", () => {
    expect(SourceNameSchema.parse("HACKER_NEWS")).toBe("HACKER_NEWS");
    const manifest = SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", "hacker_news.yml"), "utf8")));
    expect(manifest).toMatchObject({
      source_key: "hacker_news",
      kind: "json_api",
      status: "active",
      compliance: { access_basis: "official_api", authenticated_scraping: false, attribution_required: true },
      request: { endpoint: "https://hacker-news.firebaseio.com/v0", rate_limit: { items_per_run: 200 } },
      availability: { full_posting_hosts: ["news.ycombinator.com"] },
    });
  });

  it("records pre-filtered and skipped comments as FILTERED dispositions with their reason codes", async () => {
    stub();
    const dispositions: Array<{ laneKey: string | null; disposition: string; sourceExternalId: string | null; reasonCode?: string | null; sourceUrl: string | null }> = [];
    const checkpoints = new Map<string, Record<string, unknown>>();
    const broker = {
      loadSourceCheckpoint: vi.fn(async (_key: string, checkpointKey: string) => checkpoints.get(checkpointKey) ?? null),
      saveSourceCheckpoint: vi.fn(async (_key: string, checkpointKey: string, value: Record<string, unknown>) => { checkpoints.set(checkpointKey, value); }),
      startSourcePlanRun: vi.fn(async () => "plan-run-1"),
      finishSourcePlanRun: vi.fn(async () => undefined),
      processObservation: vi.fn(async () => ({ observationId: "observation-1", inserted: true, normalizedEvidence: null })),
      recordCandidateDisposition: vi.fn(async (item: typeof dispositions[number]) => { dispositions.push(item); }),
      recordError: vi.fn(),
    };
    const manifest = SourcePluginSchema.parse(load(readFileSync(path.resolve(process.cwd(), "config", "source-plugins", "hacker_news.yml"), "utf8")));

    const summary = await processSourcePage({
      broker: broker as unknown as SourceBroker,
      plugin: manifest,
      adapter: adapter({ workabilityPolicy: loadWorkabilityPolicy() }),
      checkpointTarget: "feed:hacker_news",
      planVersion: "six_lane_sources_v1:plugin-revision-1",
      laneKeys: ["CORE_AI_DATA"],
      employerLaneKeys: [],
      targetCompanyId: null,
      itemsPerRun: 200,
      plans: new DiscoveryScoutPlanner().generateSearchPlans(),
      lanes: loadGlobalLanesConfig().lanes,
    });

    expect(summary.success).toBe(true);
    expect(summary.discovered).toBe(11);
    const byReason = dispositions.filter((item) => item.disposition === "FILTERED").map((item) => [item.sourceExternalId, item.reasonCode]);
    expect(byReason).toEqual(expect.arrayContaining([
      ["4800105", "HN_NON_CONFORMING_POST"],
      ["4800106", "HN_COMMENT_DELETED"],
      ["4800107", "HN_COMMENT_DEAD"],
      ["4800108", "PREFILTER_ONSITE_ONLY"],
      ["4800109", "PREFILTER_WORK_TERRITORY_INCOMPATIBLE"],
    ]));
    // Every fetched comment has exactly one disposition in the lane.
    expect(new Set(dispositions.map((item) => item.sourceExternalId)).size).toBe(11);
    expect(dispositions.find((item) => item.sourceExternalId === "4800106")?.sourceUrl).toBe("https://news.ycombinator.com/item?id=4800106");
    expect(checkpoints.get("discovery:six_lane_sources_v1:plugin-revision-1:feed:hacker_news")?.cursor).toBe(`hn:${HN_FIXTURE_THREAD_ID}:4800111`);
  });
});
