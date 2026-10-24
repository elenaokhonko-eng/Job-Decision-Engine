import fs from "fs";
import path from "path";
import crypto from "crypto";
import { load as loadYaml } from "js-yaml";
import dotenv from "dotenv";
import { z } from "zod";
import type { SourceName, SourcePlugin } from "../src/contracts/index.js";
import { SourceNameSchema, SourcePluginSchema } from "../src/contracts/index.js";
import { loadStructuredFile } from "../src/config/structuredLoader.js";
import { GreenhouseAdapter } from "../src/ingestion/adapters/greenhouseAdapter.js";
import { AshbyAdapter } from "../src/ingestion/adapters/ashbyAdapter.js";
import { LeverAdapter } from "../src/ingestion/adapters/leverAdapter.js";
import { HimalayasAdapter } from "../src/ingestion/adapters/himalayasAdapter.js";
import { JobicyAdapter } from "../src/ingestion/adapters/jobicyAdapter.js";
import { RemotiveAdapter } from "../src/ingestion/adapters/remotiveAdapter.js";
import { createWeWorkRemotelyAdapter } from "../src/ingestion/adapters/attributedRssAdapter.js";
import type { AdapterResult, BaseSourceAdapter } from "../src/ingestion/adapters/baseAdapter.js";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";
import type { JobSourceEvidence } from "../src/contracts/jobSourceEvidence.js";
import { DiscoveryScoutPlanner, type ScoutSearchPlan } from "../src/ingestion/scouts/discoveryScouts.js";
import { assessCandidateLanes, type LaneDisposition } from "../src/ingestion/discoveryPlanExecution.js";
import { normalizePostingUrl } from "../src/ingestion/postingIdentity.js";
import { loadGlobalLanesConfig } from "../src/pipeline/laneConfigLoader.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const CompanyConfigSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  ats_provider: z.string().optional(),
  board_slug: z.string().nullable().optional(),
  target_lanes: z.array(z.string()).optional(),
}).passthrough();
type CompanyConfig = z.infer<typeof CompanyConfigSchema>;

function stableExternalIdForJob(resultSourceName: string, job: unknown): string | null {
  if (job === null || typeof job !== "object" || Array.isArray(job)) return null;
  // Extracted provider records are narrowed at this ingestion boundary.
  const record = job as Record<string, unknown>;
  const raw = record.source_external_id ?? record.id;
  if (typeof raw === "string" && raw.trim()) {
    return normalizePostingUrl(raw, resultSourceName) ?? raw.trim();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  const canonicalUrl = typeof record.employer_posting_url === "string"
    ? record.employer_posting_url
    : typeof record.canonical_apply_url === "string"
      ? record.canonical_apply_url
      : typeof record.url === "string" ? record.url : null;
  return canonicalUrl ? normalizePostingUrl(canonicalUrl, resultSourceName) : null;
}

function asSourceName(sourceKey: string): SourceName | null {
  const candidate = String(sourceKey || "").trim().toUpperCase();
  const parsed = SourceNameSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function loadCompaniesConfig(): CompanyConfig[] {
  const companiesPath = path.resolve(process.cwd(), "config/companies.yml");
  if (!fs.existsSync(companiesPath)) throw new Error(`Company source registry is missing: ${companiesPath}`);
  const fileContents = fs.readFileSync(companiesPath, "utf8");
  const document: unknown = loadYaml(fileContents);
  const root = document !== null && typeof document === "object" && !Array.isArray(document)
    ? Object.fromEntries(Object.entries(document))
    : null;
  const companies = root?.companies;
  if (!Array.isArray(companies)) throw new Error("Company source registry must contain a companies array.");
  return companies.map((company) => CompanyConfigSchema.parse(company));
}

async function loadSourcePluginsFromDisk(): Promise<SourcePlugin[]> {
  const pluginsDir = path.resolve(process.cwd(), "config/source-plugins");
  if (!fs.existsSync(pluginsDir)) {
    console.warn(`WARNING: Source plugin directory not found: ${pluginsDir}`);
    return [];
  }

  const pluginFiles = fs
    .readdirSync(pluginsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => path.join(pluginsDir, f));

  const plugins: SourcePlugin[] = [];
  for (const filePath of pluginFiles) {
    const loaded = await loadStructuredFile(filePath, SourcePluginSchema);
    plugins.push(loaded.data);
  }
  return plugins;
}

async function runAdapter(
  adapter: BaseSourceAdapter,
  options: { limit: number; cursor: string | null },
): Promise<AdapterResult> {
  return adapter.fetchJobs(options);
}

function payloadHash(payload: unknown): string {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export interface SourcePageOptions {
  readonly broker: SourceBroker;
  readonly plugin: SourcePlugin;
  readonly adapter: BaseSourceAdapter;
  readonly checkpointTarget: string;
  readonly planVersion: string;
  readonly laneKeys: readonly string[];
  readonly employerLaneKeys: readonly string[];
  readonly targetCompanyId: string | null;
  readonly itemsPerRun: number;
  readonly plans: Readonly<Record<string, ScoutSearchPlan>>;
  readonly lanes: ReturnType<typeof loadGlobalLanesConfig>["lanes"];
}

export interface SourcePageSummary {
  readonly success: boolean;
  readonly discovered: number;
  readonly newlyStaged: number;
  readonly filtered: number;
  readonly quarantined: number;
  readonly nextCursor: string | null;
  readonly error?: string;
}

export async function processSourcePage(options: SourcePageOptions): Promise<SourcePageSummary> {
  const checkpointKey = `discovery:${options.planVersion}:${options.checkpointTarget}`;
  const checkpoint = await options.broker.loadSourceCheckpoint(options.plugin.source_key, checkpointKey);
  const checkpointVersion = checkpoint?.plan_version;
  const cursor = checkpointVersion === options.planVersion && typeof checkpoint?.cursor === "string"
    ? checkpoint.cursor
    : null;
  const planRunIds = new Map<string, string>();
  for (const laneKey of options.laneKeys) {
    planRunIds.set(laneKey, await options.broker.startSourcePlanRun(
      options.plugin.source_key,
      `${options.checkpointTarget}:${laneKey}`,
      options.planVersion,
      laneKey,
    ));
  }

  const counts = new Map(options.laneKeys.map((laneKey) => [laneKey, { staged: 0, filtered: 0 }]));
  let result: AdapterResult;
  try {
    result = await runAdapter(options.adapter, { limit: options.itemsPerRun, cursor });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const laneKey of options.laneKeys) {
      const planRunId = planRunIds.get(laneKey);
      if (planRunId) await options.broker.finishSourcePlanRun(planRunId, "FAILED", {
        pagesProcessed: 0, itemsSeen: 0, itemsStaged: 0, itemsFiltered: 0,
      }, [detail], options.plans[laneKey]?.coverageNote);
    }
    return { success: false, discovered: 0, newlyStaged: 0, filtered: 0, quarantined: 0, nextCursor: cursor, error: detail };
  }

  const quarantinedCandidates = result.quarantinedCandidates ?? [];
  const quarantineCount = result.quarantined ?? quarantinedCandidates.length;
  let newlyStaged = 0;
  let filtered = 0;
  const totalFetched = result.totalFetched;
  let nextCursor = cursor;
  try {
  for (const job of result.jobs) {
    const laneResults = assessCandidateLanes(job, options.laneKeys, options.plans, options.lanes, options.employerLaneKeys);
    const matchedLanes = laneResults.filter((disposition) => disposition.matched).map((disposition) => disposition.laneKey);
    const rawPayload = job.raw_payload ?? job;
    const rawPayloadHash = payloadHash(rawPayload);
    const externalId = stableExternalIdForJob(result.sourceName, job);
    const completedDispositions = new Set<string>();
    const countedLanes = new Set<string>();
    let observationId: string | null = null;
    let inserted = false;
    let normalizedEvidence: JobSourceEvidence | null = null;
    try {
      if (matchedLanes.length > 0) {
        const staged = await options.broker.processObservation({
          sourceName: result.sourceName,
          sourcePluginKey: options.plugin.source_key,
          sourceExternalId: externalId,
          sourceUrl: job.employer_posting_url ?? job.canonical_apply_url,
          retrievedAt: new Date().toISOString(),
          companyName: job.company_name,
          title: job.title,
          descriptionRaw: job.description_raw,
          locationRaw: job.location_raw,
          workplaceTypeRaw: job.workplace_type_raw,
          employmentTypeRaw: job.employment_type_raw,
          compensationRaw: job.compensation_raw,
          canonicalApplyUrl: job.application_url ?? job.canonical_apply_url,
          sourceLane: matchedLanes[0],
          searchPlanVersion: options.planVersion,
          targetCompanyId: options.targetCompanyId ?? undefined,
          rawPayload,
        }, rawPayload);
        observationId = staged.observationId;
        inserted = staged.inserted;
        normalizedEvidence = staged.normalizedEvidence ?? null;
        if (inserted) newlyStaged += 1;
      }

      for (const laneDisposition of laneResults) {
        if (laneDisposition.matched) counts.get(laneDisposition.laneKey)!.staged += 1;
        else {
          counts.get(laneDisposition.laneKey)!.filtered += 1;
          filtered += 1;
        }
        countedLanes.add(laneDisposition.laneKey);
        await options.broker.recordCandidateDisposition({
          sourcePluginKey: options.plugin.source_key,
          planKey: `${options.checkpointTarget}:${laneDisposition.laneKey}`,
          laneKey: laneDisposition.laneKey,
          sourceExternalId: externalId,
          sourceUrl: job.employer_posting_url ?? job.canonical_apply_url,
          rawPayloadHash,
          rawPayload,
          normalizedEvidence,
          disposition: laneDisposition.matched ? inserted ? "STAGED" : "DUPLICATE" : "FILTERED",
          reasonCode: laneDisposition.reasonCode,
          reasonDetail: laneDisposition.reason,
          observationId,
        }, planRunIds.get(laneDisposition.laneKey) ?? null);
        completedDispositions.add(laneDisposition.laneKey);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      for (const laneDisposition of laneResults) {
        if (!countedLanes.has(laneDisposition.laneKey)) {
          if (laneDisposition.matched && observationId) {
            counts.get(laneDisposition.laneKey)!.staged += 1;
          } else if (!laneDisposition.matched) {
            counts.get(laneDisposition.laneKey)!.filtered += 1;
            filtered += 1;
          }
        }
        if (completedDispositions.has(laneDisposition.laneKey)) continue;
        const failedStage = laneDisposition.matched;
        await options.broker.recordCandidateDisposition({
          sourcePluginKey: options.plugin.source_key,
          planKey: `${options.checkpointTarget}:${laneDisposition.laneKey}`,
          laneKey: laneDisposition.laneKey,
          sourceExternalId: externalId,
          sourceUrl: job.employer_posting_url ?? job.canonical_apply_url,
          rawPayloadHash,
          rawPayload,
          normalizedEvidence,
          disposition: failedStage ? "ERROR" : "FILTERED",
          reasonCode: failedStage ? "CANDIDATE_PROCESSING_FAILED" : laneDisposition.reasonCode,
          reasonDetail: failedStage ? detail : laneDisposition.reason,
          observationId,
        }, planRunIds.get(laneDisposition.laneKey) ?? null);
      }
      throw error;
    }
  }

  for (const candidate of quarantinedCandidates) {
    const rawPayloadHash = payloadHash(candidate.rawPayload);
    for (const laneKey of options.laneKeys) {
      counts.get(laneKey)!.filtered += 1;
      filtered += 1;
      await options.broker.recordCandidateDisposition({
        sourcePluginKey: options.plugin.source_key,
        planKey: `${options.checkpointTarget}:${laneKey}`,
        laneKey,
        sourceExternalId: candidate.identity || null,
        sourceUrl: null,
        rawPayloadHash,
        rawPayload: candidate.rawPayload,
        disposition: "QUARANTINED",
        reasonCode: "SOURCE_SCHEMA_INVALID",
        reasonDetail: candidate.error,
      }, planRunIds.get(laneKey) ?? null);
    }
  }

  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const laneKey of options.laneKeys) {
      const planRunId = planRunIds.get(laneKey);
      const laneCounts = counts.get(laneKey)!;
      if (planRunId) await options.broker.finishSourcePlanRun(planRunId, "FAILED", {
        pagesProcessed: 0,
        itemsSeen: totalFetched,
        itemsStaged: laneCounts.staged,
        itemsFiltered: laneCounts.filtered,
      }, [detail], options.plans[laneKey]?.coverageNote);
    }
    return { success: false, discovered: totalFetched, newlyStaged, filtered, quarantined: quarantineCount, nextCursor: cursor, error: detail };
  }

  const parseFailure = quarantineCount > 0 && quarantinedCandidates.length === 0
    ? `Source adapter reported ${quarantineCount} quarantined record(s) without raw candidate details.`
    : result.success ? null : result.error ?? "Source adapter did not complete successfully.";
  const checkpointCanAdvance = result.success && parseFailure === null;
  if (checkpointCanAdvance) {
    nextCursor = result.nextCursor ?? null;
    const currentCycle = typeof checkpoint?.cycle === "number" ? checkpoint.cycle : 0;
    await options.broker.saveSourceCheckpoint(options.plugin.source_key, checkpointKey, {
      plan_version: options.planVersion,
      cursor: nextCursor,
      cycle: nextCursor === null ? currentCycle + 1 : currentCycle,
      snapshot_id: result.snapshotId ?? null,
      last_page_committed_at: new Date().toISOString(),
      snapshot_total: result.snapshotTotal ?? null,
    });
  }

  for (const laneKey of options.laneKeys) {
    const planRunId = planRunIds.get(laneKey);
    if (!planRunId) continue;
    const laneCounts = counts.get(laneKey)!;
    const planStatus = parseFailure ? "FAILED" : quarantineCount > 0 ? "DEGRADED" : "COMPLETED";
    await options.broker.finishSourcePlanRun(planRunId, planStatus, {
      pagesProcessed: totalFetched > 0 ? 1 : 0,
      itemsSeen: totalFetched,
      itemsStaged: laneCounts.staged,
      itemsFiltered: laneCounts.filtered,
    }, parseFailure ? [parseFailure] : quarantineCount > 0 ? [`${quarantineCount} source candidate(s) quarantined`] : [], options.plans[laneKey]?.coverageNote);
  }

  return {
    success: checkpointCanAdvance,
    discovered: totalFetched,
    newlyStaged,
    filtered,
    quarantined: result.quarantined ?? 0,
    nextCursor,
    error: parseFailure ?? undefined,
  };
}

function pickAtsAdapter(sourceKey: string, boardSlug: string): BaseSourceAdapter | null {
  if (sourceKey === "greenhouse") return new GreenhouseAdapter(boardSlug);
  if (sourceKey === "ashby") return new AshbyAdapter(boardSlug);
  if (sourceKey === "lever") return new LeverAdapter(boardSlug);
  return null;
}

function pickFeedAdapter(plugin: SourcePlugin): BaseSourceAdapter | null {
  const endpoint = plugin.request.endpoint.trim();
  if (!endpoint) {
    return null;
  }
  if (plugin.source_key === "himalayas") return new HimalayasAdapter(endpoint);
  if (plugin.source_key === "jobicy") return new JobicyAdapter(endpoint);
  if (plugin.source_key === "remotive") return new RemotiveAdapter(endpoint);
  if (plugin.source_key === "we_work_remotely") return createWeWorkRemotelyAdapter(endpoint);
  return null;
}

function configuredFeedLanes(
  plugin: SourcePlugin,
  plans: Readonly<Record<string, ScoutSearchPlan>>,
  lanes: ReturnType<typeof loadGlobalLanesConfig>["lanes"],
): string[] {
  const configured = plugin.request.query?.lane_keys ?? [];
  const laneKeys = configured.length > 0
    ? configured
    : Object.entries(lanes).filter(([, lane]) => (lane.enabled_sources ?? []).map((source) => source.toLowerCase()).includes(plugin.source_key)).map(([laneKey]) => laneKey);
  return [...new Set(laneKeys.filter((laneKey) => Boolean(plans[laneKey])))].sort();
}

function configuredCompanyLanes(company: CompanyConfig, plans: Readonly<Record<string, ScoutSearchPlan>>): string[] {
  return [...new Set((company.target_lanes ?? []).filter((laneKey) => Boolean(plans[laneKey])))].sort();
}

function itemsPerRun(plugin: SourcePlugin): number {
  const configured = plugin.request.rate_limit.items_per_run;
  return configured && configured > 0 ? Math.min(configured, 200) : 50;
}

export async function runAdapters(): Promise<{
  totalDiscovered: number;
  totalStaged: number;
  errors: number;
  status: "HEALTHY" | "DEGRADED" | "FAILED";
  laneCoverage: Record<string, { plansExecuted: number; sourcesFailed: number; discovered: number; staged: number; filtered: number; coverageNote: string }>;
}> {
  console.log("====================================================");
  console.log("   STAGE 0: EXECUTED SIX-LANE SOURCE PLAN RUNNER    ");
  console.log("====================================================");

  const broker = new SourceBroker();
  await broker.startRun("UNIFIED_MANIFEST_ADAPTERS_RUN");

  let totalDiscovered = 0;
  let totalStaged = 0;
  let errorCount = 0;
  let enabledSourceCount = 0;
  const failedSources: string[] = [];
  const successfulSources: string[] = [];
  const plugins = await loadSourcePluginsFromDisk();
  const companies = loadCompaniesConfig();
  const lanesConfig = loadGlobalLanesConfig();
  const companiesByLane: Record<string, string[]> = {};
  for (const company of companies.filter((candidate) => candidate.enabled !== false)) {
    for (const lane of company.target_lanes ?? []) {
      if (company.name) (companiesByLane[lane] ??= []).push(company.name);
    }
  }
  const plans = new DiscoveryScoutPlanner().generateSearchPlans(companiesByLane);
  const laneCoverage: Record<string, { plansExecuted: number; sourcesFailed: number; discovered: number; staged: number; filtered: number; coverageNote: string }> = {};
  for (const [laneKey, plan] of Object.entries(plans)) {
    laneCoverage[laneKey] = { plansExecuted: 0, sourcesFailed: 0, discovered: 0, staged: 0, filtered: 0, coverageNote: plan.coverageNote };
  }
  const enabledPlugins = plugins.filter((plugin) => plugin.status === "active" && plugin.schedule.enabled);

  async function runGroup(input: {
    plugin: SourcePlugin;
    adapter: BaseSourceAdapter;
    label: string;
    checkpointTarget: string;
    laneKeys: string[];
    employerLaneKeys: string[];
    targetCompanyId: string | null;
    pluginRevisionId: string;
  }): Promise<void> {
    const planVersion = `${plans[input.laneKeys[0]].planVersion}:${input.pluginRevisionId}`;
    enabledSourceCount += 1;
    for (const laneKey of input.laneKeys) laneCoverage[laneKey].plansExecuted += 1;
    const summary = await processSourcePage({
      broker,
      plugin: input.plugin,
      adapter: input.adapter,
      checkpointTarget: input.checkpointTarget,
      planVersion,
      laneKeys: input.laneKeys,
      employerLaneKeys: input.employerLaneKeys,
      targetCompanyId: input.targetCompanyId,
      itemsPerRun: itemsPerRun(input.plugin),
      plans,
      lanes: lanesConfig.lanes,
    });
    totalDiscovered += summary.discovered;
    totalStaged += summary.newlyStaged;
    for (const laneKey of input.laneKeys) {
      laneCoverage[laneKey].discovered += summary.discovered;
      laneCoverage[laneKey].staged += summary.newlyStaged;
      laneCoverage[laneKey].filtered += summary.filtered;
    }
    if (summary.quarantined > 0) errorCount += summary.quarantined;
    if (summary.success) {
      successfulSources.push(input.label);
      console.log(`  -> ${input.label}: fetched ${summary.discovered}; new observations ${summary.newlyStaged}; filtered ${summary.filtered}; quarantined ${summary.quarantined}; next cursor ${summary.nextCursor ?? "cycle complete"}`);
    } else {
      failedSources.push(input.label);
      errorCount += 1;
      for (const laneKey of input.laneKeys) laneCoverage[laneKey].sourcesFailed += 1;
      broker.recordError(`${input.label}: ${summary.error ?? "source plan did not complete"}`);
      console.warn(`  WARN: ${input.label} failed: ${summary.error ?? "source plan did not complete"}`);
    }
  }

  for (const plugin of enabledPlugins) {
    const sourceName = asSourceName(plugin.source_key);
    if (!sourceName) {
      const detail = `Unknown source key ${plugin.source_key}; source plan cannot execute.`;
      broker.recordError(detail);
      failedSources.push(plugin.source_key);
      errorCount += 1;
      continue;
    }
    const supportedKind = plugin.kind === "ats"
      || plugin.kind === "json_api"
      || plugin.kind === "rss"
      || plugin.kind === "atom"
      || plugin.kind === "schema_org";
    if (!supportedKind) {
      console.log(`  SKIP: ${plugin.source_key} is a passive/manual intake, not an automated public source poll.`);
      continue;
    }

    let pluginRevisionId: string;
    try {
      pluginRevisionId = await broker.ensureSourcePluginRevision(plugin);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      broker.recordError(`${plugin.source_key}: source plugin registry sync failed: ${detail}`);
      failedSources.push(plugin.source_key);
      errorCount += 1;
      continue;
    }

    if (plugin.kind === "ats") {
      const atsCompanies = companies.filter((company) =>
        company.enabled !== false && company.ats_provider?.trim().toLowerCase() === plugin.source_key
      );
      for (const company of atsCompanies) {
        const boardSlug = company.board_slug?.trim() ?? "";
        const laneKeys = configuredCompanyLanes(company, plans);
        const label = `${plugin.source_key}:${company.id ?? company.name ?? boardSlug}`;
        if (!boardSlug || laneKeys.length === 0) {
          const detail = `${label}: enabled ATS company has no verified board slug or configured lane plan.`;
          broker.recordError(detail);
          failedSources.push(label);
          errorCount += 1;
          continue;
        }
        try {
          const adapter = pickAtsAdapter(plugin.source_key, boardSlug);
          if (!adapter) throw new Error(`Unsupported ATS adapter: ${plugin.source_key}`);
          console.log(`\nPolling ${label} for lanes ${laneKeys.join(", ")}...`);
          await runGroup({
            plugin,
            adapter,
            label,
            checkpointTarget: `ats:${company.id ?? boardSlug}`,
            laneKeys,
            employerLaneKeys: laneKeys,
            targetCompanyId: company.id ?? null,
            pluginRevisionId,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          broker.recordError(`${label}: ${detail}`);
          failedSources.push(label);
          errorCount += 1;
        }
      }
      continue;
    }

    const laneKeys = configuredFeedLanes(plugin, plans, lanesConfig.lanes);
    const label = `${plugin.source_key}:${plugin.kind}`;
    if (laneKeys.length === 0) {
      const detail = `${label}: no configured lane plan references this feed.`;
      broker.recordError(detail);
      failedSources.push(label);
      errorCount += 1;
      continue;
    }
    const adapter = pickFeedAdapter(plugin);
    if (!adapter) {
      const detail = `${label}: no supported adapter is configured for this endpoint.`;
      broker.recordError(detail);
      failedSources.push(label);
      errorCount += 1;
      continue;
    }
    console.log(`\nPolling ${label} for lanes ${laneKeys.join(", ")}...`);
    try {
      await runGroup({
        plugin,
        adapter,
        label,
        checkpointTarget: `feed:${plugin.source_key}`,
        laneKeys,
        employerLaneKeys: [],
        targetCompanyId: null,
        pluginRevisionId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      broker.recordError(`${label}: ${detail}`);
      failedSources.push(label);
      errorCount += 1;
    }
  }

  const missingLanePlans = Object.entries(laneCoverage)
    .filter(([, coverage]) => coverage.plansExecuted === 0)
    .map(([lane]) => lane);
  if (missingLanePlans.length > 0) {
    const detail = `No executable configured source plan ran for lanes: ${missingLanePlans.join(", ")}.`;
    broker.recordError(detail);
    failedSources.push("six-lane-plan-coverage");
    errorCount += 1;
  }

  const finalStatus: "HEALTHY" | "DEGRADED" | "FAILED" = enabledSourceCount === 0 || (failedSources.length > 0 && successfulSources.length === 0)
    ? "FAILED"
    : failedSources.length > 0 || errorCount > 0 ? "DEGRADED" : "HEALTHY";
  await broker.endRun(finalStatus === "FAILED" ? "FAILED" : finalStatus === "DEGRADED" ? "DEGRADED" : "COMPLETED");

  console.log(`\n====================================================`);
  console.log(`Executed Six-Lane Source Plan Summary:`);
  console.log(`  Status: ${finalStatus}`);
  console.log(`  Discovered: ${totalDiscovered}, New observations staged: ${totalStaged}`);
  console.log(`  Successful plans (${successfulSources.length}): ${successfulSources.join(", ") || "None"}`);
  console.log(`  Failed plans (${failedSources.length}): ${failedSources.join(", ") || "None"}`);
  for (const [laneKey, coverage] of Object.entries(laneCoverage)) {
    console.log(`  ${laneKey}: plans=${coverage.plansExecuted}, failed=${coverage.sourcesFailed}, discovered=${coverage.discovered}, staged=${coverage.staged}, filtered=${coverage.filtered}; ${coverage.coverageNote}`);
  }
  console.log(`  Total errors: ${errorCount}`);
  console.log(`====================================================\n`);

  if (finalStatus === "FAILED" && enabledSourceCount > 0) {
    throw new Error(`Six-lane discovery failed: ${failedSources.join(", ") || "no source plan executed"}.`);
  }
  return { totalDiscovered, totalStaged, errors: errorCount, status: finalStatus, laneCoverage };
}

if (process.argv[1] && process.argv[1].includes("run_adapters")) {
  runAdapters()
    .then((res) => {
      if (res.status === "FAILED") process.exit(1);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal adapter execution error:", err);
      process.exit(1);
    });
}
