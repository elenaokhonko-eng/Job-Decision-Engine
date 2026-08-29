import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import dotenv from "dotenv";
import { GreenhouseAdapter } from "../src/ingestion/adapters/greenhouseAdapter.js";
import { AshbyAdapter } from "../src/ingestion/adapters/ashbyAdapter.js";
import { LeverAdapter } from "../src/ingestion/adapters/leverAdapter.js";
import { HimalayasAdapter } from "../src/ingestion/adapters/himalayasAdapter.js";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

export async function runAdapters(): Promise<{ totalDiscovered: number; totalStaged: number; errors: number }> {
  console.log("====================================================");
  console.log("       STAGE 0: UNIFIED SOURCE ADAPTER RUNNER       ");
  console.log("====================================================");

  const broker = new SourceBroker();
  await broker.startRun("UNIFIED_ADAPTERS_RUN");

  let totalDiscovered = 0;
  let totalStaged = 0;
  let errorCount = 0;

  // 1. Process Companies from config/companies.yml
  const companiesPath = path.resolve(process.cwd(), "config/companies.yml");
  if (fs.existsSync(companiesPath)) {
    try {
      const fileContents = fs.readFileSync(companiesPath, "utf8");
      const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
      const doc = loadFn(fileContents) as any;
      const companies = doc.companies || [];

      for (const company of companies) {
        if (!company.enabled) continue;
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

          if (adapterResult.success && adapterResult.jobs.length > 0) {
            console.log(`  -> Discovered ${adapterResult.jobs.length} jobs for ${company.name}`);
            totalDiscovered += adapterResult.jobs.length;

            for (const job of adapterResult.jobs) {
              await broker.processObservation(
                {
                  sourceName: adapterResult.sourceName as any,
                  sourceExternalId: `${company.id || company.name}-${job.title}`,
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
          } else if (!adapterResult.success) {
            console.warn(`  ⚠️ Adapter warning for ${company.name}: ${adapterResult.error}`);
          }
        } catch (err: any) {
          console.error(`  ❌ Error polling ${company.name}:`, err.message || err);
          errorCount++;
        }
      }
    } catch (cfgErr: any) {
      console.error("❌ Failed to parse config/companies.yml:", cfgErr.message || cfgErr);
    }
  }

  // 2. Poll Public Job Boards (Himalayas)
  console.log("\n🏔️ Polling Himalayas Job Board...");
  try {
    const himalayasAdapter = new HimalayasAdapter();
    const himalayasResult = await himalayasAdapter.fetchJobs({ limit: 30 });
    if (himalayasResult.success && himalayasResult.jobs.length > 0) {
      console.log(`  -> Discovered ${himalayasResult.jobs.length} jobs from Himalayas`);
      totalDiscovered += himalayasResult.jobs.length;

      for (const job of himalayasResult.jobs) {
        await broker.processObservation(
          {
            sourceName: himalayasResult.sourceName as any,
            sourceExternalId: `himalayas-${job.title}-${job.company_name}`,
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
    } else if (!himalayasResult.success) {
      console.warn(`  ⚠️ Himalayas warning: ${himalayasResult.error}`);
    }
  } catch (himErr: any) {
    console.error("  ❌ Error polling Himalayas:", himErr.message || himErr);
    errorCount++;
  }

  await broker.endRun("COMPLETED");
  console.log(`\n✅ Source Adapters Complete: ${totalDiscovered} discovered, ${totalStaged} staged, ${errorCount} errors.`);
  return { totalDiscovered, totalStaged, errors: errorCount };
}

if (process.argv[1] && process.argv[1].includes("run_adapters")) {
  runAdapters()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal adapter execution error:", err);
      process.exit(1);
    });
}
