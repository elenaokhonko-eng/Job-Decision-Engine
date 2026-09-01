import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as yaml from "js-yaml";
import dotenv from "dotenv";
import { GreenhouseAdapter } from "../src/ingestion/adapters/greenhouseAdapter.js";
import { AshbyAdapter } from "../src/ingestion/adapters/ashbyAdapter.js";
import { LeverAdapter } from "../src/ingestion/adapters/leverAdapter.js";
import { HimalayasAdapter } from "../src/ingestion/adapters/himalayasAdapter.js";
import { JobicyAdapter } from "../src/ingestion/adapters/jobicyAdapter.js";
import { RemotiveAdapter } from "../src/ingestion/adapters/remotiveAdapter.js";
import { createWeWorkRemotelyAdapter } from "../src/ingestion/adapters/attributedRssAdapter.js";
import { AdapterResult, BaseSourceAdapter } from "../src/ingestion/adapters/baseAdapter.js";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function stageAdapterJobs(broker: SourceBroker, result: AdapterResult): Promise<number> {
  let staged = 0;
  for (const job of result.jobs) {
    const stableExternalId = job.source_external_id ||
      `${result.sourceName.toLowerCase()}-${crypto.createHash("sha256").update(job.canonical_apply_url || `${job.title}${job.company_name}`).digest("hex").substring(0, 16)}`;
    await broker.processObservation(
      {
        sourceName: result.sourceName,
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
        sourceLane: "UNKNOWN",
        searchPlanVersion: "1.0",
        rawPayload: job.raw_payload ?? job
      },
      job.raw_payload ?? job
    );
    staged++;
  }
  return staged;
}

export async function runAdapters(): Promise<{ totalDiscovered: number; totalStaged: number; errors: number; status: "HEALTHY" | "DEGRADED" | "FAILED" }> {
  console.log("====================================================");
  console.log("       STAGE 0: UNIFIED SOURCE ADAPTER RUNNER       ");
  console.log("====================================================");

  const broker = new SourceBroker();
  await broker.startRun("UNIFIED_ADAPTERS_RUN");

  let totalDiscovered = 0;
  let totalStaged = 0;
  let errorCount = 0;
  let enabledSourceCount = 0;
  const failedSources: string[] = [];
  const successfulSources: string[] = [];

  // 1. Process Companies from config/companies.yml
  const companiesPath = path.resolve(process.cwd(), "config/companies.yml");
  if (fs.existsSync(companiesPath)) {
    try {
      const fileContents = fs.readFileSync(companiesPath, "utf8");
      const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
      const doc = loadFn(fileContents) as any;
      const companies = doc.companies || [];

      for (const company of companies) {
        if (!company.enabled) {
          console.log(`  ⏸️ Skipping disabled source: ${company.name} (${company.board_slug || "no slug"})`);
          continue;
        }
        enabledSourceCount++;
        console.log(`\n📡 Polling ATS for ${company.name} (${company.ats_provider || "unknown"})...`);

        try {
          let adapterResult;
          if (company.ats_provider === "greenhouse") {
            const adapter = new GreenhouseAdapter(company.board_slug);
            adapterResult = await adapter.fetchJobs({ limit: 50 });
          } else if (company.ats_provider === "ashby") {
            const adapter = new AshbyAdapter(company.board_slug);
            adapterResult = await adapter.fetchJobs({ limit: 50 });
          } else if (company.ats_provider === "lever") {
            const adapter = new LeverAdapter(company.board_slug);
            adapterResult = await adapter.fetchJobs({ limit: 50 });
          } else {
            console.log(`  ℹ️ Skipping unsupported ATS provider "${company.ats_provider}" for ${company.name}`);
            continue;
          }

          if (adapterResult.success) {
            successfulSources.push(company.name);
            console.log(`  -> Discovered ${adapterResult.jobs.length} jobs for ${company.name}`);
            totalDiscovered += adapterResult.jobs.length;

            for (const job of adapterResult.jobs) {
              const stableExternalId = (job as any).id 
                ? String((job as any).id)
                : `${company.id || company.name}-${crypto.createHash("sha256").update(job.canonical_apply_url || job.title).digest("hex").substring(0, 16)}`;

              await broker.processObservation(
                {
                  sourceName: adapterResult.sourceName as any,
                  sourceExternalId: stableExternalId,
                  sourceUrl: job.canonical_apply_url,
                  retrievedAt: new Date().toISOString(),
                  companyName: job.company_name || company.name,
                  title: job.title,
                  descriptionRaw: job.description_raw,
                  locationRaw: job.location_raw,
                  workplaceTypeRaw: job.workplace_type_raw,
                  employmentTypeRaw: job.employment_type_raw,
                  compensationRaw: job.compensation_raw,
                  canonicalApplyUrl: job.canonical_apply_url,
                  sourceLane: (company.target_lanes && company.target_lanes[0]) || "UNKNOWN",
                  searchPlanVersion: "1.0",
                  rawPayload: job
                },
                job
              );
              totalStaged++;
            }
          } else {
            console.warn(`  ⚠️ Adapter warning for ${company.name}: ${adapterResult.error}`);
            failedSources.push(company.name);
            errorCount++;
          }
        } catch (err: any) {
          console.error(`  ❌ Error polling ${company.name}:`, err.message || err);
          failedSources.push(company.name);
          errorCount++;
        }
      }
    } catch (cfgErr: any) {
      console.error("❌ Failed to parse config/companies.yml:", cfgErr.message || cfgErr);
      errorCount++;
    }
  }

  // 2. Poll Public Job Boards (Himalayas)
  console.log("\n🏔️ Polling Himalayas Job Board...");
  enabledSourceCount++;
  try {
    const himalayasAdapter = new HimalayasAdapter();
    const himalayasResult = await himalayasAdapter.fetchJobs({ limit: 30 });
    if (himalayasResult.success) {
      successfulSources.push("Himalayas");
      console.log(`  -> Discovered ${himalayasResult.jobs.length} jobs from Himalayas`);
      totalDiscovered += himalayasResult.jobs.length;

      for (const job of himalayasResult.jobs) {
        const stableExternalId = (job as any).id 
          ? String((job as any).id)
          : `himalayas-${crypto.createHash("sha256").update(job.canonical_apply_url || (job.title + job.company_name)).digest("hex").substring(0, 16)}`;

        await broker.processObservation(
          {
            sourceName: himalayasResult.sourceName as any,
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
            sourceLane: "UNKNOWN",
            searchPlanVersion: "1.0",
            rawPayload: job
          },
          job
        );
        totalStaged++;
      }
    } else {
      console.warn(`  ⚠️ Himalayas warning: ${himalayasResult.error}`);
      failedSources.push("Himalayas");
      errorCount++;
    }
  } catch (himErr: any) {
    console.error("  ❌ Error polling Himalayas:", himErr.message || himErr);
    failedSources.push("Himalayas");
    errorCount++;
  }

  // 3. Poll configured public API/RSS sources.
  const sourcesPath = path.resolve(process.cwd(), "config/sources.yml");
  if (fs.existsSync(sourcesPath)) {
    const sourceDoc = yaml.load(fs.readFileSync(sourcesPath, "utf8")) as any;
    for (const source of sourceDoc?.sources ?? []) {
      if (!source.enabled || source.id === "HIMALAYAS") continue;
      enabledSourceCount++;

      let adapter: BaseSourceAdapter | null = null;
      if (source.id === "JOBICY") adapter = new JobicyAdapter(source.endpoint);
      if (source.id === "REMOTIVE") adapter = new RemotiveAdapter(source.endpoint);
      if (source.id === "WE_WORK_REMOTELY") adapter = createWeWorkRemotelyAdapter(source.endpoint);
      if (!adapter) {
        broker.recordError(`Unsupported configured source: ${source.id}`);
        failedSources.push(source.id);
        errorCount++;
        continue;
      }

      console.log(`\n📡 Polling ${source.id} (${source.type})...`);
      try {
        const result = await adapter.fetchJobs({ limit: source.rate_limit_per_run ?? 50 });
        if (!result.success) {
          const detail = `${result.error || "unknown failure"}${result.isRateLimited ? " [rate-limited]" : ""}`;
          broker.recordError(`${source.id}: ${detail}`);
          failedSources.push(source.id);
          errorCount++;
          console.warn(`  ⚠️ ${source.id} failed: ${detail}`);
          continue;
        }

        const staged = await stageAdapterJobs(broker, result);
        totalDiscovered += result.totalFetched;
        totalStaged += staged;
        successfulSources.push(source.id);
        console.log(`  -> Fetched ${result.totalFetched}; valid ${result.jobs.length}; quarantined ${result.quarantined ?? 0}; staged ${staged}`);
      } catch (err: any) {
        broker.recordError(`${source.id}: ${err.message || err}`);
        failedSources.push(source.id);
        errorCount++;
        console.error(`  ❌ ${source.id} failed: ${err.message || err}`);
      }
    }
  }

  const finalStatus: "HEALTHY" | "DEGRADED" | "FAILED" = 
    failedSources.length === 0 
      ? "HEALTHY" 
      : successfulSources.length > 0 
        ? "DEGRADED" 
        : "FAILED";

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
