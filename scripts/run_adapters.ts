import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as yaml from "js-yaml";
import dotenv from "dotenv";
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

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

type CompanyConfig = {
  id?: string;
  name?: string;
  enabled?: boolean;
  ats_provider?: string;
  board_slug?: string | null;
  target_lanes?: string[];
};

function stableExternalIdForJob(resultSourceName: string, job: any): string {
  const raw = String(job?.source_external_id || job?.id || job?.canonical_apply_url || "").trim();
  if (raw.length > 0) {
    return raw;
  }
  const fallback = `${resultSourceName}|${job?.company_name || ""}|${job?.title || ""}|${job?.canonical_apply_url || ""}`;
  return `${resultSourceName.toLowerCase()}-${crypto.createHash("sha256").update(fallback).digest("hex").slice(0, 16)}`;
}

function extractTextForFiltering(job: any): string {
  return [
    job?.company_name,
    job?.title,
    job?.location_raw,
    job?.workplace_type_raw,
    job?.description_raw,
  ]
    .map((v) => (typeof v === "string" ? v : ""))
    .join(" ")
    .toLowerCase();
}

function matchesPluginQuery(job: any, plugin: SourcePlugin): boolean {
  const query = (plugin as any)?.request?.query || {};
  const keywords: string[] = Array.isArray(query.keywords) ? query.keywords : [];
  const locations: string[] = Array.isArray(query.locations) ? query.locations : [];
  const workModes: string[] = Array.isArray(query.work_modes) ? query.work_modes : [];

  const text = extractTextForFiltering(job);
  if (keywords.length > 0) {
    const ok = keywords.some((kw) => {
      const needle = String(kw || "").trim().toLowerCase();
      return needle.length > 0 && text.includes(needle);
    });
    if (!ok) return false;
  }

  if (locations.length > 0) {
    const locationText = typeof job?.location_raw === "string" ? job.location_raw.toLowerCase() : "";
    const ok = locations.some((loc) => {
      const needle = String(loc || "").trim().toLowerCase();
      if (needle.length === 0) return false;
      return locationText.includes(needle) || text.includes(needle);
    });
    if (!ok) return false;
  }

  const workMode = typeof job?.workplace_type_raw === "string" ? job.workplace_type_raw.trim() : "UNKNOWN";
  if (workModes.length > 0 && !workModes.includes(workMode)) {
    return false;
  }

  return true;
}

function asSourceName(sourceKey: string): SourceName | null {
  const candidate = String(sourceKey || "").trim().toUpperCase();
  const parsed = SourceNameSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function loadCompaniesConfig(): CompanyConfig[] {
  const companiesPath = path.resolve(process.cwd(), "config/companies.yml");
  if (!fs.existsSync(companiesPath)) {
    return [];
  }
  const fileContents = fs.readFileSync(companiesPath, "utf8");
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  const doc = loadFn(fileContents) as any;
  const companies = Array.isArray(doc?.companies) ? (doc.companies as CompanyConfig[]) : [];
  return companies;
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
  options: { limit?: number } = {}
): Promise<AdapterResult> {
  return adapter.fetchJobs({ limit: options.limit ?? 50 });
}

async function stageAdapterResult(
  broker: SourceBroker,
  plugin: SourcePlugin,
  result: AdapterResult,
  options?: { targetCompanyId?: string; sourceLane?: string }
): Promise<{ discovered: number; staged: number; filteredOut: number }> {
  let staged = 0;
  let filteredOut = 0;
  let discovered = 0;

  for (const job of result.jobs) {
    discovered += 1;
    if (!matchesPluginQuery(job, plugin)) {
      filteredOut += 1;
      continue;
    }

    const stableExternalId = stableExternalIdForJob(result.sourceName, job);
    await broker.processObservation(
      {
        sourceName: result.sourceName,
        sourcePluginKey: plugin.source_key,
        sourceExternalId: stableExternalId,
        sourceUrl: job.canonical_apply_url,
        retrievedAt: new Date().toISOString(),
        companyName: job.company_name,
        title: job.title,
        descriptionRaw: job.description_raw,
        locationRaw: job.location_raw,
        workplaceTypeRaw: job.workplace_type_raw,
        employmentTypeRaw: job.employment_type_raw,
        compensationRaw: job.compensation_raw,
        canonicalApplyUrl: job.canonical_apply_url,
        sourceLane: options?.sourceLane || "UNKNOWN",
        searchPlanVersion: "1.0",
        targetCompanyId: options?.targetCompanyId,
        rawPayload: job.raw_payload ?? job,
      },
      job.raw_payload ?? job
    );
    staged += 1;
  }

  return { discovered, staged, filteredOut };
}

function pickAtsAdapter(sourceKey: string, boardSlug: string): BaseSourceAdapter | null {
  if (sourceKey === "greenhouse") return new GreenhouseAdapter(boardSlug);
  if (sourceKey === "ashby") return new AshbyAdapter(boardSlug);
  if (sourceKey === "lever") return new LeverAdapter(boardSlug);
  return null;
}

function pickFeedAdapter(plugin: SourcePlugin): BaseSourceAdapter | null {
  const endpoint = String((plugin as any)?.request?.endpoint || "").trim();
  if (!endpoint) {
    return null;
  }
  if (plugin.source_key === "himalayas") return new HimalayasAdapter(endpoint);
  if (plugin.source_key === "jobicy") return new JobicyAdapter(endpoint);
  if (plugin.source_key === "remotive") return new RemotiveAdapter(endpoint);
  if (plugin.source_key === "we_work_remotely") return createWeWorkRemotelyAdapter(endpoint);
  return null;
}

export async function runAdapters(): Promise<{
  totalDiscovered: number;
  totalStaged: number;
  errors: number;
  status: "HEALTHY" | "DEGRADED" | "FAILED";
}> {
  console.log("====================================================");
  console.log("   STAGE 0: MANIFEST-DRIVEN SOURCE ADAPTER RUNNER    ");
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

  const enabledPlugins = plugins.filter((p) => p.status === "active" && (p as any)?.schedule?.enabled !== false);

  for (const plugin of enabledPlugins) {
    const sourceName = asSourceName(plugin.source_key);
    if (!sourceName) {
      console.warn(`  SKIP: unknown source_key (not in SourceName enum): ${plugin.source_key}`);
      continue;
    }

    const itemsPerRunRaw = (plugin as any)?.request?.rate_limit?.items_per_run;
    const parsedItemsPerRun =
      itemsPerRunRaw == null ? NaN : typeof itemsPerRunRaw === "number" ? itemsPerRunRaw : Number(itemsPerRunRaw);
    const itemsPerRun = Number.isFinite(parsedItemsPerRun) && parsedItemsPerRun > 0 ? parsedItemsPerRun : 50;

    if (plugin.kind === "ats") {
      const atsCompanies = companies.filter(
        (c) =>
          c.enabled !== false &&
          typeof c.ats_provider === "string" &&
          c.ats_provider.trim().toLowerCase() === plugin.source_key
      );
      if (atsCompanies.length === 0) {
        continue;
      }

      for (const company of atsCompanies) {
        const boardSlug = typeof company.board_slug === "string" ? company.board_slug.trim() : "";
        if (!boardSlug) {
          continue;
        }
        enabledSourceCount += 1;
        const label = `${plugin.source_key}:${company.id || company.name || boardSlug}`;
        console.log(`\nPolling ${label}...`);
        try {
          const adapter = pickAtsAdapter(plugin.source_key, boardSlug);
          if (!adapter) {
            broker.recordError(`Unsupported ATS provider: ${plugin.source_key}`);
            failedSources.push(label);
            errorCount += 1;
            continue;
          }
          const result = await runAdapter(adapter, { limit: itemsPerRun });
          if (!result.success) {
            const detail = `${result.error || "unknown failure"}${result.isRateLimited ? " [rate-limited]" : ""}`;
            broker.recordError(`${label}: ${detail}`);
            failedSources.push(label);
            errorCount += 1;
            console.warn(`  WARN: ${label} failed: ${detail}`);
            continue;
          }
          const staged = await stageAdapterResult(broker, plugin, result, {
            targetCompanyId: company.id,
            sourceLane: Array.isArray(company.target_lanes) && company.target_lanes.length > 0 ? String(company.target_lanes[0]) : "UNKNOWN",
          });
          totalDiscovered += staged.discovered;
          totalStaged += staged.staged;
          successfulSources.push(label);
          console.log(
            `  -> discovered ${staged.discovered}; filtered ${staged.filteredOut}; staged ${staged.staged} (quarantined ${result.quarantined ?? 0})`
          );
        } catch (err: any) {
          broker.recordError(`${label}: ${err.message || err}`);
          failedSources.push(label);
          errorCount += 1;
          console.error(`  ERROR: ${label} failed:`, err.message || err);
        }
      }
      continue;
    }

    if (plugin.kind === "json_api" || plugin.kind === "rss" || plugin.kind === "atom" || plugin.kind === "schema_org") {
      enabledSourceCount += 1;
      const label = plugin.source_key;
      console.log(`\nPolling ${label} (${plugin.kind})...`);
      try {
        const adapter = pickFeedAdapter(plugin);
        if (!adapter) {
          broker.recordError(`Unsupported feed adapter: ${plugin.source_key} (${plugin.kind})`);
          failedSources.push(label);
          errorCount += 1;
          continue;
        }
        const result = await runAdapter(adapter, { limit: itemsPerRun });
        if (!result.success) {
          const detail = `${result.error || "unknown failure"}${result.isRateLimited ? " [rate-limited]" : ""}`;
          broker.recordError(`${label}: ${detail}`);
          failedSources.push(label);
          errorCount += 1;
          console.warn(`  WARN: ${label} failed: ${detail}`);
          continue;
        }
        const staged = await stageAdapterResult(broker, plugin, result);
        totalDiscovered += staged.discovered;
        totalStaged += staged.staged;
        successfulSources.push(label);
        console.log(
          `  -> discovered ${staged.discovered}; filtered ${staged.filteredOut}; staged ${staged.staged} (quarantined ${result.quarantined ?? 0})`
        );
      } catch (err: any) {
        broker.recordError(`${label}: ${err.message || err}`);
        failedSources.push(label);
        errorCount += 1;
        console.error(`  ERROR: ${label} failed:`, err.message || err);
      }
      continue;
    }
  }

  const finalStatus: "HEALTHY" | "DEGRADED" | "FAILED" =
    failedSources.length === 0 ? "HEALTHY" : successfulSources.length > 0 ? "DEGRADED" : "FAILED";

  await broker.endRun(finalStatus === "FAILED" ? "FAILED" : finalStatus === "DEGRADED" ? "DEGRADED" : "COMPLETED");

  console.log(`\n====================================================`);
  console.log(`Source Adapter Summary:`);
  console.log(`  Status: ${finalStatus}`);
  console.log(`  Discovered: ${totalDiscovered}, Staged: ${totalStaged}`);
  console.log(`  Successful Sources (${successfulSources.length}): ${successfulSources.join(", ") || "None"}`);
  console.log(`  Failed Sources (${failedSources.length}): ${failedSources.join(", ") || "None"}`);
  console.log(`  Total Errors: ${errorCount}`);
  console.log(`====================================================\n`);

  if (finalStatus === "FAILED" && enabledSourceCount > 0) {
    throw new Error(`All ${enabledSourceCount} enabled source adapters failed during ingestion.`);
  }

  return { totalDiscovered, totalStaged, errors: errorCount, status: finalStatus };
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
