import yaml from "js-yaml";
import fs from "fs";
import { fetchGreenhouseJobs } from "../src/services/adapters/greenhouse.js";
import { fetchAshbyJobs } from "../src/services/adapters/ashby.js";
import { fetchLeverJobs } from "../src/services/adapters/lever.js";
import { fetchHimalayasJobs } from "../src/services/adapters/himalayas.js";
import { fetchStartupJobs } from "../src/services/adapters/startupjobs.js";
import { SourceBroker } from "../src/ingestion/sourceBroker.js";

async function runUnifiedIngest() {
  console.log("====================================================");
  console.log("         STAGE 0: DISCOVERY (BROKER)                ");
  console.log("====================================================");

  const broker = new SourceBroker();
  await broker.startRun();
  console.log("-> Started source run context.");

  // 1. Process Companies Registry
  try {
    const fileContents = fs.readFileSync("config/companies.yml", "utf8");
    const doc = yaml.load(fileContents) as any;
    const companies = doc.companies || [];

    for (const company of companies) {
      if (!company.enabled) continue;
      console.log(`\nPolling ATS for ${company.name} (${company.ats_provider})...`);

      let jobs: any[] = [];
      try {
        if (company.ats_provider === "greenhouse") {
          jobs = await fetchGreenhouseJobs(company.name, company.board_slug);
        } else if (company.ats_provider === "ashby") {
          jobs = await fetchAshbyJobs(company.name, company.board_slug);
        } else if (company.ats_provider === "lever") {
          jobs = await fetchLeverJobs(company.name, company.board_slug);
        } else {
          console.warn(`⚠️ Unsupported ATS provider: ${company.ats_provider}`);
        }
      } catch (err: any) {
        console.error(`❌ Failed to poll ${company.name}: ${err.message}`);
      }

      console.log(`-> Discovered ${jobs.length} jobs for ${company.name}`);
      for (const job of jobs) {
        await broker.processObservation({
          sourceName: company.ats_provider,
          sourceExternalId: job.content_hash || `${company.name}-${job.title}`,
          sourceUrl: job.careers_portal_url,
          retrievedAt: new Date().toISOString(),
          companyName: job.company_name,
          title: job.title,
          descriptionRaw: typeof job.raw_description === "object" ? JSON.stringify(job.raw_description) : job.raw_description,
          sourceLane: "TARGET_COMPANY",
          searchPlanVersion: "1.0",
        }, job);
      }
    }
  } catch (e: any) {
    console.error("Failed to read config/companies.yml", e.message);
  }

  // 2. Process Global Aggregators
  console.log("\nPolling Global/Remote Aggregators...");
  try {
    const himalayasJobs = await fetchHimalayasJobs();
    console.log(`-> Discovered ${himalayasJobs.length} jobs from Himalayas.`);
    for (const job of himalayasJobs) {
      await broker.processObservation({
        sourceName: "himalayas",
        sourceExternalId: job.content_hash || `himalayas-${job.title}`,
        sourceUrl: job.careers_portal_url,
        retrievedAt: new Date().toISOString(),
        companyName: job.company_name,
        title: job.title,
        descriptionRaw: typeof job.raw_description === "object" ? JSON.stringify(job.raw_description) : job.raw_description,
        sourceLane: "AGGREGATOR",
        searchPlanVersion: "1.0",
      }, job);
    }
  } catch (e: any) {
    console.error(`❌ Himalayas fetch failed: ${e.message}`);
  }

  try {
    const startupJobs = await fetchStartupJobs();
    console.log(`-> Discovered ${startupJobs.length} jobs from StartupJobs.`);
    for (const job of startupJobs) {
      await broker.processObservation({
        sourceName: "startup_jobs",
        sourceExternalId: job.content_hash || `startupjobs-${job.title}`,
        sourceUrl: job.careers_portal_url,
        retrievedAt: new Date().toISOString(),
        companyName: job.company_name,
        title: job.title,
        descriptionRaw: typeof job.raw_description === "object" ? JSON.stringify(job.raw_description) : job.raw_description,
        sourceLane: "AGGREGATOR",
        searchPlanVersion: "1.0",
      }, job);
    }
  } catch (e: any) {
    console.error(`❌ StartupJobs fetch failed: ${e.message}`);
  }

  await broker.endRun();
  console.log(`✅ Staged new jobs via Source Broker.`);
  process.exit(0);
}

runUnifiedIngest();
