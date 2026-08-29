import pg from "pg";
import dotenv from "dotenv";
import { getGeminiClient, runAgent, generateContent, generateEmbedding } from "../src/services/agent.ts";
import { extractWithFallback } from "../src/services/llmFallback.ts";
import { db, verifyUrlLive } from "../src/db/db.ts";
import { applyGlobalGates, generateContentHash, LANE_VOCABULARIES, MULTI_LANE_SCORECARDS } from "../src/services/criteria.ts";
import { runDeduplication } from "./deduplicate.ts";
import puppeteer, { Browser } from "puppeteer";

const jobsExtractSchema = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          source: { type: "string", description: "LinkedIn | MyCareersFuture | eFinancialCareers | Gmail" },
          salaryRange: { type: "string", description: "Optional, e.g. SGD 15,000 - SGD 20,000, or empty string" },
          location: { type: "string", description: "Optional, e.g. Singapore (Remote), or empty string" },
          careers_portal_url: { type: "string", description: "Mandatory. Choose the exact matching URL from the verified URLs list above" },
          description: {
            type: "object",
            properties: {
              job_description: { type: "string", description: "High-level overview of the role and team context." },
              key_responsibilities: { type: "array", items: { type: "string" } },
              technical_skills: { type: "array", items: { type: "string" } },
              qualifications_education: { type: "array", items: { type: "string" } },
              nice_to_haves: { type: "array", items: { type: "string" } }
            },
            required: ["job_description", "key_responsibilities", "technical_skills", "qualifications_education", "nice_to_haves"],
            additionalProperties: false
          }
        },
        required: ["title", "company", "source", "salaryRange", "location", "careers_portal_url", "description"],
        additionalProperties: false
      }
    }
  },
  required: ["jobs"],
  additionalProperties: false
};

dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle database client in evaluation script:", err.message || err);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function scrapeJobDescription(url: string, browser: Browser): Promise<{ description: string; isExpired: boolean }> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1200, height: 800 });
    
    console.log(`- Scraping URL: ${url}`);
    
    // Check if it's LinkedIn guest API format to avoid login wall
    if (url.includes("linkedin.com/jobs/view/")) {
      const match = url.match(/\/view\/(\d+)/);
      if (match && match[1]) {
        const jobId = match[1];
        const guestUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobDetail/${jobId}`;
        console.log(`  -> Using LinkedIn guest detail API: ${guestUrl}`);
        const response = await page.goto(guestUrl, { waitUntil: "networkidle2", timeout: 25000 });
        if (response && (response.status() === 404 || response.status() === 410)) {
          return { description: "", isExpired: true };
        }
        
        const description = await page.evaluate(() => {
          const descEl = document.querySelector('.description__text') || 
                        document.querySelector('.show-more-less-html__markup') ||
                        document.querySelector('.jobs-description-content');
          return descEl ? (descEl as HTMLElement).innerText.trim() : '';
        });
        
        const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
        const isExpired = pageText.includes("no longer accepting applications") || pageText.includes("job has expired") || pageText.includes("expired");
        
        if (description && description.length >= 100) {
          return { description, isExpired };
        }
      }
    }

    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    if (!response || response.status() === 404 || response.status() === 410) {
      console.log(`  -> Page returned status ${response ? response.status() : "null"}`);
      return { description: "", isExpired: true };
    }
    
    const finalUrl = page.url().toLowerCase();
    if (finalUrl.includes("expired") || finalUrl.includes("not-found") || finalUrl.includes("job-not-found") || finalUrl.includes("inactive")) {
      return { description: "", isExpired: true };
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const expiredKeywords = [
      "this job has expired",
      "no longer accepting applications",
      "job posting has expired",
      "posting is no longer active",
      "job is no longer available",
      "expired job application"
    ];
    
    if (expiredKeywords.some(keyword => pageText.includes(keyword))) {
      return { description: "", isExpired: true };
    }
    
    const description = await page.evaluate(() => {
      let descEl = document.querySelector('.jobs-description-content') || 
                   document.querySelector('.show-more-less-html__markup') || 
                   document.querySelector('[id^="job-details"]') || 
                   document.querySelector('.jobs-box__html-content') ||
                   document.querySelector('.jobs-description');
      
      if (descEl) return (descEl as HTMLElement).innerText.trim();
      
      descEl = document.getElementById('job_description') || 
               document.querySelector('.jobDescription') ||
               document.querySelector('[class*="jobDescription"]') ||
               document.querySelector('[class*="job-description"]');
      if (descEl) return (descEl as HTMLElement).innerText.trim();
      
      descEl = document.querySelector('.job-details') || 
               document.querySelector('.job-description') ||
               document.querySelector('[class*="jobDetails"]') ||
               document.querySelector('[class*="jobDescription"]');
      if (descEl) return (descEl as HTMLElement).innerText.trim();
      
      const commonSelectors = [
        'article', 
        'main', 
        '#description', 
        '.description', 
        '#job-description', 
        '.job-description', 
        '.jobdescription', 
        '.job-details'
      ];
      for (const selector of commonSelectors) {
        const el = document.querySelector(selector);
        if (el && (el as HTMLElement).innerText.trim().length > 200) {
          return (el as HTMLElement).innerText.trim();
        }
      }
      return '';
    });
    
    return { description, isExpired: false };
    
  } catch (err: any) {
    console.error(`  -> Scraper error for ${url}: ${err.message || err}`);
    return { description: "", isExpired: false };
  } finally {
    await page.close();
  }
}

// Removed checkDirectRejection in favor of applyGlobalGates in criteria.ts

async function runPipeline() {
  console.log("====================================================");
  console.log("      JOB DESCRIPTION PARSING & EVALUATION PIPELINE  ");
  console.log("====================================================");

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  const evalSleepMs = parseInt(process.env.EVAL_SLEEP_MS || "15000", 10);
  const evalJobSleepMs = parseInt(process.env.EVAL_JOB_SLEEP_MS || "25000", 10);
  let pipelineHealth: string = "HEALTHY";

  console.log("=== Validating Model Configuration ===");
  if (!process.env.GEMINI_API_KEY) {
    console.error("❌ ERROR: GEMINI_API_KEY is not set. Cannot run generative evaluation.");
    process.exit(1);
  }
  
  try {
    const ai = getGeminiClient();
    await generateContent({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      contents: "ping",
      systemInstruction: "reply pong"
    });
    console.log(`✅ Model ${process.env.GEMINI_MODEL || "gemini-1.5-flash"} is accessible.`);
  } catch (err: any) {
    console.error(`❌ ERROR: Failed to access model ${process.env.GEMINI_MODEL || "gemini-1.5-flash"}: ${err.message}`);
    console.error("Failing pipeline to prevent masked provider failure.");
    pipelineHealth = "FAILED";
    process.exit(1);
  }

  try {
    // 0. Clean up staging raw_jobs duplicates and already-evaluated items
    await runDeduplication();

    // 0b. Clean up any duplicate jobs in the final jobs table
    console.log("Deduplicating any existing duplicate records in final jobs table...");
    await pool.query(`
      DELETE FROM jobs j1
      USING jobs j2
      WHERE j1.id < j2.id
        AND j1.company_name = j2.company_name
        AND j1.title = j2.title
    `);

    // 1. Fetch unprocessed raw email alerts
    console.log("Querying database for unprocessed raw email alerts...");
    const emailRes = await pool.query(
      "SELECT id, subject, body FROM raw_email_alerts WHERE processed = FALSE ORDER BY received_at ASC"
    );
    console.log(`Found ${emailRes.rows.length} unprocessed email alerts.`);

    if (emailRes.rows.length > 0) {
      const ai = getGeminiClient();

      for (let i = 0; i < emailRes.rows.length; i++) {
        const alert = emailRes.rows[i];
        if (i > 0 && evalSleepMs > 0) {
          console.log(`Waiting ${evalSleepMs / 1000} seconds before parsing the next email alert to avoid API rate limits...`);
          await sleep(evalSleepMs);
        }
        console.log(`\nParsing email: "${alert.subject}" (ID: ${alert.id})`);
        
        // 1. Extract and validate all URLs in the email body
        const rawBody = alert.body || "";
        const validDomains = ["linkedin.com", "mycareersfuture.gov.sg", "efinancialcareers.com", "efinancialcareers.sg"];
        
        // Extract links starting with http:// or https://
        const urlMatches = rawBody.match(/https?:\/\/[^\s"'>]+/g) || [];
        const cleanUrls: string[] = [];
        for (const url of urlMatches) {
          const u = url.replace(/&amp;/g, "&").replace(/[,.;)]$/, "");
          try {
            const parsed = new URL(u);
            if (validDomains.some(domain => parsed.hostname.includes(domain))) {
              cleanUrls.push(u);
            }
          } catch {}
        }
        const uniqueUrls = Array.from(new Set(cleanUrls));
        
        // Run first validation check (HTTP live checks) on the extracted URLs in parallel
        const urlChecks = await Promise.all(
          uniqueUrls.map(async (u) => {
            const isLive = await verifyUrlLive(u, false);
            return isLive ? u : null;
          })
        );
        const verifiedUrls: string[] = urlChecks.filter((u): u is string => u !== null);
        
        console.log(`Found ${verifiedUrls.length} live job board URLs in email alert.`);
        if (verifiedUrls.length === 0) {
          console.log(`⚠️ Skipping email alert ${alert.id}: No active/valid URLs found for LinkedIn, MyCareersFuture, or eFinancialCareers.`);
          await pool.query(
            "UPDATE raw_email_alerts SET processed = TRUE, processed_at = NOW() WHERE id = $1",
            [alert.id]
          );
          continue;
        }

        const parsePrompt = `You are a high-fidelity data extraction agent. 
Analyze the following email body (which contains job alerts) and extract every individual job advertisement.

### STRICT RULES:
1. You MUST ONLY extract jobs that correspond to a URL from the verified URLs list below.
2. For each extracted job, assign the exact matching URL from the verified list to "careers_portal_url".
3. Under no circumstances should you fabricate, estimate, or make up any URL. Only use URLs from the list below.
4. If a job described in the email does not correspond to any URL in the list below, do not extract it.
5. "careers_portal_url" MUST be a single full-string URL, not a composite or relative path.

Email Subject: ${alert.subject}
Email Body:
${alert.body}

Verified URLs list (you must ONLY use URLs from this list):
${verifiedUrls.map((u, i) => `${i + 1}. ${u}`).join("\n")}`;

        try {
          let rawText = await extractWithFallback(parsePrompt, jobsExtractSchema);
          if (rawText.startsWith("```json")) {
            rawText = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
          } else if (rawText.startsWith("```")) {
            rawText = rawText.replace(/^```\s*/, "").replace(/\s*```$/, "");
          }

          const parsed = JSON.parse(rawText);
          const jobsList = parsed.jobs || [];
          console.log(`Extracted ${jobsList.length} jobs from email alert.`);

          for (const rawJob of jobsList) {
            try {
              const rawDbJob = await db.addRawJob({
                company_name: rawJob.company,
                title: rawJob.title,
                source: (rawJob.source || "Gmail").substring(0, 50),
                raw_description: typeof rawJob.description === "object" ? JSON.stringify(rawJob.description) : rawJob.description,
                salary_range: rawJob.salaryRange || undefined,
                location: rawJob.location || "Singapore",
                posted_date: new Date().toISOString().split("T")[0],
                careers_portal_url: rawJob.careers_portal_url,
                content_hash: generateContentHash(
                  rawJob.company,
                  rawJob.title,
                  typeof rawJob.description === "object" ? JSON.stringify(rawJob.description) : rawJob.description
                )
              });
              console.log(`  -> Inserted raw staging job: "${rawDbJob.title}" at ${rawDbJob.company_name}`);
            } catch (insertErr: any) {
              console.error(`  -> Failed to insert raw job "${rawJob.title}": ${insertErr.message || insertErr}`);
            }
          }

          // Mark email alert as processed
          await pool.query(
            "UPDATE raw_email_alerts SET processed = TRUE, processed_at = NOW() WHERE id = $1",
            [alert.id]
          );
          console.log(`Marked email alert ${alert.id} as processed.`);

        } catch (err: any) {
          console.error(`❌ Failed to parse email alert ${alert.id}:`, err.message || err);
        }
      }
    }

    // 1.5 Run deduplication after new email alerts are staged, to prevent evaluating duplicates
    await runDeduplication();

    // 2. Fetch and evaluate unprocessed raw jobs in database
    console.log("\nQuerying database for unprocessed raw jobs to evaluate...");
    const rawJobs = await db.queryRawJobs(true);
    console.log(`Found ${rawJobs.length} unprocessed raw jobs.`);
    const evaluatedTodayIds: string[] = [];

    // Map lane descriptions for prototype embeddings
    const lanePrototypes: Record<string, string> = {
      CORE_AI_DATA: MULTI_LANE_SCORECARDS.CORE_AI_DATA.description + " " + LANE_VOCABULARIES.CORE_AI_DATA.positive.join(" "),
      LEGAL_REGTECH: MULTI_LANE_SCORECARDS.LEGAL_REGTECH.description + " " + LANE_VOCABULARIES.LEGAL_REGTECH.positive.join(" "),
      HEALTH_BIO_PHARMA: MULTI_LANE_SCORECARDS.HEALTH_BIO_PHARMA.description + " " + LANE_VOCABULARIES.HEALTH_BIO_PHARMA.positive.join(" "),
      INVESTMENT_MARKETS_FINTECH: MULTI_LANE_SCORECARDS.INVESTMENT_MARKETS_FINTECH.description + " " + LANE_VOCABULARIES.INVESTMENT_MARKETS_FINTECH.positive.join(" ")
    };
    
    // Generate prototype embeddings
    console.log("Generating semantic prototypes for 4 lanes...");
    const laneEmbeddings: Record<string, number[]> = {};
    for (const lane of Object.keys(lanePrototypes)) {
      laneEmbeddings[lane] = await generateEmbedding(lanePrototypes[lane]);
    }

    const cosineSimilarity = (vecA: number[], vecB: number[]) => {
      let dotProduct = 0, normA = 0, normB = 0;
      for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
      }
      if (normA === 0 || normB === 0) return 0;
      return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    if (rawJobs.length > 0) {
      console.log("Launching headless browser for job description verification & scraping...");
      let browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled"
        ]
      });

      const survivingJobs: Array<{ rawJob: any, descString: string, primary_lane: string, score: number }> = [];

      try {
        for (let i = 0; i < rawJobs.length; i++) {
          const rawJob = rawJobs[i];
          console.log(`\n[${i + 1}/${rawJobs.length}] Verifying job: "${rawJob.title}" at "${rawJob.company_name}"`);
          
          let scrapeResult = { description: "", isExpired: false };
          if (rawJob.careers_portal_url) {
            try {
              if (!browser.connected) {
                console.log("⚠️ Browser disconnected. Re-launching...");
                browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
              }
              scrapeResult = await scrapeJobDescription(rawJob.careers_portal_url, browser);
            } catch (err: any) {
              console.warn(`  -> Browser error checking URL, trying one-time re-launch: ${err.message || err}`);
            }
          }
          
          let hasExistingDesc = false;
          if (rawJob.raw_description && rawJob.raw_description.length > 100) hasExistingDesc = true;
          
          if (scrapeResult.isExpired && hasExistingDesc) {
            scrapeResult.isExpired = false;
            scrapeResult.description = "";
          }

          if (scrapeResult.isExpired || (!scrapeResult.description && !hasExistingDesc)) {
            console.log(`  -> ❌ REJECTED BEFORE EVALUATION: Expired or missing description.`);
            await db.markRawJobProcessed(rawJob.id);
            continue;
          }
          
          if (scrapeResult.description) {
            rawJob.raw_description = scrapeResult.description;
            await pool.query("UPDATE raw_jobs SET raw_description = $1 WHERE id = $2", [scrapeResult.description, rawJob.id]);
          }
          
          const gateResult = applyGlobalGates(rawJob);
          if (!gateResult.passed) {
            console.log(`  -> ❌ REJECTED BEFORE EVALUATION (Direct Disqualifier matched): ${gateResult.rejection_code}`);
            await db.markRawJobProcessed(rawJob.id);
            continue;
          }

          console.log(`  -> ✅ Passed deterministic gates. Extracting semantic embedding...`);
          const descString = typeof rawJob.raw_description === "object" ? JSON.stringify(rawJob.raw_description, null, 2) : rawJob.raw_description;
          const jobText = `${rawJob.title} ${descString}`;
          const jobEmbedding = await generateEmbedding(jobText);
          
          let bestLane = "CORE_AI_DATA";
          let bestScore = -1;
          for (const lane of Object.keys(laneEmbeddings)) {
            const score = cosineSimilarity(jobEmbedding, laneEmbeddings[lane]);
            if (score > bestScore) {
              bestScore = score;
              bestLane = lane;
            }
          }

          console.log(`  -> Ranked as ${bestLane} (Score: ${bestScore.toFixed(3)})`);
          survivingJobs.push({ rawJob, descString, primary_lane: bestLane, score: bestScore });
        }
      } finally {
        try { await browser.close(); } catch (e) {}
      }

      // Group and cap LLM invocation
      console.log(`\nRanking ${survivingJobs.length} surviving jobs by semantic similarity to cap LLM evaluation to ~3 per lane...`);
      const jobsByLane: Record<string, typeof survivingJobs> = {};
      for (const sj of survivingJobs) {
        if (!jobsByLane[sj.primary_lane]) jobsByLane[sj.primary_lane] = [];
        jobsByLane[sj.primary_lane].push(sj);
      }

      const jobsToEvaluateLLM: typeof survivingJobs = [];
      for (const lane of Object.keys(jobsByLane)) {
        jobsByLane[lane].sort((a, b) => b.score - a.score);
        const top3 = jobsByLane[lane].slice(0, 3);
        console.log(`- ${lane}: Evaluating top ${top3.length} of ${jobsByLane[lane].length} jobs.`);
        jobsToEvaluateLLM.push(...top3);

        // Mark the remaining ones as evaluated/rejected due to cap
        const skipped = jobsByLane[lane].slice(3);
        for (const sj of skipped) {
           await db.markRawJobProcessed(sj.rawJob.id);
           console.log(`  - ⏭️ Skipped (LLM Cap Exceeded): ${sj.rawJob.title} at ${sj.rawJob.company_name}`);
        }
      }

      // Process top jobs through AI
      for (const sj of jobsToEvaluateLLM) {
        if (evalJobSleepMs > 0) { await sleep(evalJobSleepMs); }
        console.log(`\nEvaluating raw job: "${sj.rawJob.title}" at "${sj.rawJob.company_name}" [${sj.primary_lane}]`);
        
        const evalQuery = `Evaluate job advertisement: "${sj.rawJob.title}" at "${sj.rawJob.company_name}". 
        Location: ${sj.rawJob.location || "Singapore"}. 
        Salary Range: ${sj.rawJob.salary_range || "Not specified"}. 
        Description: ${sj.descString}`;
        
        try {
          const { result } = await runAgent(evalQuery);
          const evalResult = result.evaluated_jobs?.[0];
          if (evalResult) {
            console.log(`  -> LLM Complete: Confidence = ${evalResult.lane_confidence}, Next Action = ${evalResult.next_action}`);
            const finalJob = await db.addJob({
              content_hash: sj.rawJob.content_hash || undefined,
              title: sj.rawJob.title,
              company_name: sj.rawJob.company_name,
              source: sj.rawJob.source as any,
              raw_description: sj.rawJob.raw_description,
              salary_range: sj.rawJob.salary_range || undefined,
              location: sj.rawJob.location || undefined,
              careers_portal_url: sj.rawJob.careers_portal_url,
              posted_date: sj.rawJob.posted_date ? new Date(sj.rawJob.posted_date).toISOString().split('T')[0] : undefined,
              processing_status: "EVALUATED",
              primary_lane: evalResult.primary_lane || sj.primary_lane,
              secondary_lanes: evalResult.secondary_lanes || undefined,
              lane_confidence: evalResult.lane_confidence || "Medium",
              lane_evidence: evalResult.lane_evidence || undefined,
              source_lane: "LLM",
              nd_friendly_score: evalResult.nd_friendly_score || 0,
              politics_stress_score: evalResult.politics_stress_score || 0,
              sensory_overload_index: evalResult.sensory_overload_index || 0,
              biological_stress_risk: (evalResult as any).biological_stress_risk || evalResult.biological_and_stress_risk_assessment || undefined,
              strategic_value: evalResult.strategic_value || "None",
              recommended_cv_version: evalResult.recommended_cv_version || "None",
              next_action: evalResult.next_action || "None",
              is_top_ten: false
            }, true);
            await db.markRawJobProcessed(sj.rawJob.id);
            evaluatedTodayIds.push(finalJob.id);
          }
        } catch (err: any) {
          console.error(`❌ Evaluation failed for raw job ID ${sj.rawJob.id}:`, err.message || err);
        }
      }
    }

    // 3. Selection: Evaluate all high confidence jobs in the lane.
    console.log("\nSelecting top recommended jobs (No capping)...");
    const allJobs = await db.queryJobs();
    
    // Filter jobs that were evaluated in the current run and have a high confidence
    const eligibleJobs = allJobs.filter(j => 
      evaluatedTodayIds.includes(j.id) && 
      (j.processing_status === "EVALUATED") &&
      (j.primary_lane !== null && j.lane_confidence === "High")
    );
    
    // Group by lane and sort by ND score
    const jobsByLane: Record<string, typeof eligibleJobs> = {};
    for (const job of eligibleJobs) {
      const lane = job.primary_lane as string;
      if (!jobsByLane[lane]) jobsByLane[lane] = [];
      jobsByLane[lane].push(job);
    }

    let selectedJobs: any[] = [];
    for (const lane of Object.keys(jobsByLane)) {
      const laneJobs = jobsByLane[lane];
      laneJobs.sort((a, b) => (b.nd_friendly_score || 0) - (a.nd_friendly_score || 0));
      
      const selectedCount = laneJobs.length;
      console.log(`Lane: ${lane}`);
      console.log(`Jobs found: ${laneJobs.length}`);
      console.log(`Jobs selected to apply: ${selectedCount}`);
      
      selectedJobs.push(...laneJobs);
    }
    
    for (const job of selectedJobs) {
      await pool.query("UPDATE jobs SET is_top_ten = TRUE WHERE id = $1", [job.id]);
    }
    
    const processedTodayCount = evaluatedTodayIds.length;
    const selectedCount = selectedJobs.length;
    
    console.log("====================================================");
    console.log("             DAILY SELECTION SUMMARY                ");
    console.log("====================================================");
    console.log(`Processed raw jobs today: ${processedTodayCount}`);
    if (processedTodayCount === 0) {
      console.log("No new jobs were processed today.");
    } else {
      console.log(`Jobs selected to apply (Max 3 per lane): ${selectedCount}`);
      if (selectedCount === 0) {
        console.log("No jobs processed today met the criteria for applying.");
      } else {
        selectedJobs.forEach((j, i) => {
          console.log(`  [#${i+1}] ${j.title} at ${j.company_name} (Lane: ${j.primary_lane}, Confidence: ${j.lane_confidence}, ND: ${j.nd_friendly_score})`);
        });
      }
    }
    console.log("====================================================");

    // 4. Clean up Gmail Jobs-Alerts-Processed folder
    // [MODIFIED]: Disabled by Phase 0 Refactor - Emails should not be purged/altered in source

    if (pipelineHealth === "FAILED") {
      console.error("\n❌ Pipeline finished with FAILED status.");
      process.exit(1);
    } else if (pipelineHealth === "DEGRADED") {
      console.log("\n⚠️ Pipeline completed with DEGRADED status (some providers failed).");
    } else {
      console.log("\n✅ Pipeline completed with HEALTHY status!");
    }
  } catch (err: any) {
    console.error("❌ Fatal pipeline failure:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runPipeline();
