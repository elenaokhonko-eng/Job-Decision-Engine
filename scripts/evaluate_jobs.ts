import pg from "pg";
import dotenv from "dotenv";
import { getGeminiClient, runAgent, generateContent } from "../src/services/agent.ts";
import { extractWithFallback } from "../src/services/llmFallback.ts";
import { db, verifyUrlLive } from "../src/db/db.ts";
import { runDeduplication } from "./deduplicate.ts";
import puppeteer from "puppeteer";

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

async function scrapeJobDescription(url: string, browser: puppeteer.Browser): Promise<{ description: string; isExpired: boolean }> {
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

function checkDirectRejection(title: string, company: string, description: any): string | null {
  const t = title.toLowerCase();
  const c = company.toLowerCase();
  let d = "";

  if (description) {
    if (typeof description === "object") {
      d = (
        (description.job_description || "") + " " +
        (description.key_responsibilities || []).join(" ") + " " +
        (description.technical_skills || []).join(" ") + " " +
        (description.qualifications_education || []).join(" ") + " " +
        (description.nice_to_haves || []).join(" ")
      ).toLowerCase();
    } else if (typeof description === "string") {
      if (description.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(description);
          d = (
            (parsed.job_description || "") + " " +
            (parsed.key_responsibilities || []).join(" ") + " " +
            (parsed.technical_skills || []).join(" ") + " " +
            (parsed.qualifications_education || []).join(" ") + " " +
            (parsed.nice_to_haves || []).join(" ")
          ).toLowerCase();
        } catch {
          d = description.toLowerCase();
        }
      } else {
        d = description.toLowerCase();
      }
    }
  }

  // 1. FDE (Forward Deployed Engineering) check
  if (t.includes("fde") || t.includes("forward deployed") || d.includes("forward deployed") || d.includes("fde ")) {
    return "Rejected: Role is a Forward Deployed Engineering (FDE) position.";
  }

  // 2. Consulting Firms check
  const consultingFirms = [
    "accenture", "kpmg", "bcg", "mckinsey", "bain", "deloitte", "pwc", 
    "ernst & young", "pricewaterhousecoopers", "boston consulting group"
  ];
  for (const firm of consultingFirms) {
    if (c.includes(firm)) {
      return `Rejected: Company "${company}" is a consulting firm.`;
    }
  }

  // Exact or word-boundary check for "EY" (Ernst & Young) to avoid matching "Stanley" or "Disney"
  if (c === "ey" || c === "ey pte ltd" || c.startsWith("ey ") || c.endsWith(" ey") || c.includes(" ey ") || c.includes("ey.com")) {
    return `Rejected: Company "${company}" is a consulting firm (EY).`;
  }

  // 3. IT Outsourcing check
  if (c.includes("red hat") || d.includes("deployed to client") || d.includes("work for our clients") || d.includes("hired resource")) {
    return `Rejected: Role is in an IT outsourcing or staffing deployment model.`;
  }

  // 3b. Recruitment Agency Contract check
  const contractKeywords = ["contract", "contractor", "temp", "temporary", "freelance"];
  const agencyKeywords = [
    "recruitment", "recruiting", "staffing", "talent acquisition",
    "hays", "randstad", "pagegroup", "michael page", "adecco", 
    "charterhouse", "huxley", "robert half", "robert walters", "kelly services", 
    "monroe consulting", "recruit"
  ];
  const isAgency = agencyKeywords.some(kw => c.includes(kw)) || 
                   d.includes("on behalf of our client") || 
                   d.includes("our client is looking for") || 
                   d.includes("hiring for our client");
                   
  if (isAgency) {
    const isContract = contractKeywords.some(kw => t.includes(kw) || d.includes(kw)) || d.includes("renewable");
    if (isContract) {
      return "Rejected: Contract/renewable role posted by recruitment agency.";
    }
  }

  // 4. Contract check
  for (const kw of contractKeywords) {
    if (t.includes(kw)) {
      if (t.includes("permanent contract") || d.includes("permanent contract")) {
        continue;
      }
      return `Rejected: Role is a contract or temporary position ("${kw}").`;
    }
  }

  // 5. Kitchen-sink / Multi-role (Extreme management/delivery overhead)
  const managementKeywords = ["manage large teams", "manage client teams", "manage client expectations", "client relationship management"];
  for (const kw of managementKeywords) {
    if (d.includes(kw)) {
      return `Rejected: Role involves heavy management overhead / managing client teams (${kw}).`;
    }
  }

  // Kitchen sink indicators (if 4 or more distinct roles are combined)
  let rolesCount = 0;
  if (d.includes("project manager") || d.includes("scrum master") || d.includes("project management")) rolesCount++;
  if (d.includes("people manager") || d.includes("people management") || d.includes("line manager")) rolesCount++;
  if (d.includes("client manager") || d.includes("delivery manager") || d.includes("account manager")) rolesCount++;
  if (d.includes("architect") || d.includes("architecture")) rolesCount++;
  if (d.includes("developer") || d.includes("engineer")) rolesCount++;

  if (rolesCount >= 4) {
    return "Rejected: Kitchen-sink posting combining too many distinct roles (Architect + PM + People Manager + Client/Delivery Manager).";
  }

  return null;
}

async function runPipeline() {
  console.log("====================================================");
  console.log("      JOB DESCRIPTION PARSING & EVALUATION PIPELINE  ");
  console.log("====================================================");

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  const evalSleepMs = parseInt(process.env.EVAL_SLEEP_MS || "10000", 10);
  const evalJobSleepMs = parseInt(process.env.EVAL_JOB_SLEEP_MS || "13000", 10);

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
                careers_portal_url: rawJob.careers_portal_url
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

      try {
        for (let i = 0; i < rawJobs.length; i++) {
          const rawJob = rawJobs[i];
          console.log(`\n[${i + 1}/${rawJobs.length}] Verifying job: "${rawJob.title}" at "${rawJob.company_name}"`);
          
          let scrapeResult = { description: "", isExpired: false };
          if (rawJob.careers_portal_url) {
            try {
              if (!browser.connected) {
                console.log("⚠️ Browser disconnected. Re-launching...");
                browser = await puppeteer.launch({
                  headless: true,
                  args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled"
                  ]
                });
              }
              scrapeResult = await scrapeJobDescription(rawJob.careers_portal_url, browser);
            } catch (err: any) {
              console.warn(`  -> Browser error checking URL, trying one-time re-launch: ${err.message || err}`);
              try {
                await browser.close().catch(() => {});
                browser = await puppeteer.launch({
                  headless: true,
                  args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled"
                  ]
                });
                scrapeResult = await scrapeJobDescription(rawJob.careers_portal_url, browser);
              } catch (retryErr: any) {
                console.error(`  -> Persistent browser error on retry: ${retryErr.message}`);
              }
            }
          }
          
          // Parse existing description if available
          let hasExistingDesc = false;
          if (rawJob.raw_description) {
            let parsed: any = null;
            if (typeof rawJob.raw_description === "object" && rawJob.raw_description !== null) {
              parsed = rawJob.raw_description;
            } else if (typeof rawJob.raw_description === "string") {
              try {
                parsed = JSON.parse(rawJob.raw_description);
              } catch {
                if (rawJob.raw_description.length >= 100 && !rawJob.raw_description.startsWith("Paste raw details here")) {
                  hasExistingDesc = true;
                }
              }
            }
            if (parsed) {
              const text = parsed.job_description || "";
              if (text.length >= 100 && !text.startsWith("Paste raw details here")) {
                hasExistingDesc = true;
              }
            }
          }

          // If scraping returned expired or failed, but we already have a valid description, bypass the expiry check
          if (scrapeResult.isExpired && hasExistingDesc) {
            console.log("  -> Scraper flagged job as expired, but a valid pre-existing description is present. Proceeding with evaluation...");
            scrapeResult.isExpired = false;
            scrapeResult.description = ""; // Don't overwrite the existing description
          }

          if (scrapeResult.isExpired || (!scrapeResult.description && !hasExistingDesc)) {
            const reason = scrapeResult.isExpired 
              ? "Job posting is expired or no longer active." 
              : "Could not retrieve or parse the full job description (inactive listing or missing description).";
            
            console.log(`  -> ❌ REJECTED BEFORE EVALUATION: ${reason}`);
            
            // Insert directly to the rejected pile
            const finalJob = await db.addJob({
              title: rawJob.title,
              company: rawJob.company_name,
              source: rawJob.source as any,
              description: rawJob.raw_description || "No description available.",
              salaryRange: rawJob.salary_range || undefined,
              location: rawJob.location || undefined,
              careers_portal_url: rawJob.careers_portal_url,
              postedDate: rawJob.posted_date ? new Date(rawJob.posted_date).toISOString().split('T')[0] : undefined,
              stage1_status: "HARD_FAIL",
              final_classification: "REJECTED",
              career_horizon_route: "STRATEGIC_DEAD_END",
              confidence_level: "Low",
              core_fit_score: 0,
              score_technical_autonomy: 0,
              score_comp_quality: 0,
              score_hands_on_mastery: 0,
              score_role_purity: 0,
              score_market_durability: 0,
              nd_friendly_score: 0,
              politics_stress_score: 0,
              sensory_overload_index: 0,
              biological_stress_risk: reason,
              strategic_value: "Rejected due to inactive/expired listing.",
              recommended_cv_version: "None",
              next_action: "None",
              is_top_ten: false
            }, true);
            
            await db.markRawJobProcessed(rawJob.id);
            continue;
          }
          
          // If description was successfully scraped, update it
          if (scrapeResult.description) {
            console.log(`  -> Full description retrieved (${scrapeResult.description.length} chars). Updating raw job in DB...`);
            const structuredDesc = {
              job_description: scrapeResult.description,
              key_responsibilities: [],
              technical_skills: [],
              qualifications_education: [],
              nice_to_haves: []
            };
            const descJson = JSON.stringify(structuredDesc);
            rawJob.raw_description = descJson;
            await pool.query(
              "UPDATE raw_jobs SET raw_description = $1 WHERE id = $2",
              [descJson, rawJob.id]
            );
          }
          
          // Run direct rejection checks on the raw job title, company, and description
          const rejectionReason = checkDirectRejection(rawJob.title, rawJob.company_name, rawJob.raw_description);
          if (rejectionReason) {
            console.log(`  -> ❌ REJECTED BEFORE EVALUATION (Direct Disqualifier matched): ${rejectionReason}`);
            await db.addJob({
              title: rawJob.title,
              company: rawJob.company_name,
              source: rawJob.source as any,
              description: rawJob.raw_description || "No description available.",
              salaryRange: rawJob.salary_range || undefined,
              location: rawJob.location || undefined,
              careers_portal_url: rawJob.careers_portal_url,
              postedDate: rawJob.posted_date ? new Date(rawJob.posted_date).toISOString().split('T')[0] : undefined,
              stage1_status: "HARD_FAIL",
              final_classification: "REJECTED",
              career_horizon_route: "STRATEGIC_DEAD_END",
              confidence_level: "Low",
              core_fit_score: 0,
              score_technical_autonomy: 0,
              score_comp_quality: 0,
              score_hands_on_mastery: 0,
              score_role_purity: 0,
              score_market_durability: 0,
              nd_friendly_score: 0,
              politics_stress_score: 0,
              sensory_overload_index: 0,
              biological_stress_risk: rejectionReason,
              strategic_value: "Rejected due to direct disqualification rules.",
              recommended_cv_version: "None",
              next_action: "None",
              is_top_ten: false
            }, true);

            await db.markRawJobProcessed(rawJob.id);
            continue;
          }
          
          if (i > 0 && evalJobSleepMs > 0) {
            console.log(`Waiting ${evalJobSleepMs / 1000} seconds before the next evaluation to avoid API rate limits...`);
            await sleep(evalJobSleepMs);
          }
          
          console.log(`Evaluating raw job: "${rawJob.title}" at "${rawJob.company_name}"`);
          
          const descString = typeof rawJob.raw_description === "object" 
            ? JSON.stringify(rawJob.raw_description, null, 2) 
            : rawJob.raw_description;
            
          const evalQuery = `Evaluate job advertisement: "${rawJob.title}" at "${rawJob.company_name}". 
          Location: ${rawJob.location || "Singapore"}. 
          Salary Range: ${rawJob.salary_range || "Not specified"}. 
          Description: ${descString}`;
          
          try {
            const { result } = await runAgent(evalQuery);
            const evalResult = result.evaluated_jobs?.[0];
            if (evalResult) {
              const totalScore = evalResult.core_fit_score ?? 0;
              let status = evalResult.final_classification ?? "REJECTED";
              const track = evalResult.career_horizon_route ?? "STRATEGIC_DEAD_END";

              // AI Hallucination Math Sanity Check Override
              if (totalScore < 70 && (status === "PRIORITY_APPLY" || status === "APPLY_AFTER_VERIFICATION" || status === "HIGH_FIT_HIGH_RISK")) {
                  console.log(`    ⚠️ AI Hallucination detected: Score is ${totalScore} but status was ${status}. Downgrading to LOW_STRATEGIC_VALUE.`);
                  status = "LOW_STRATEGIC_VALUE";
              } else if (totalScore >= 70 && totalScore < 80 && status === "PRIORITY_APPLY") {
                  console.log(`    ⚠️ AI Hallucination detected: Score is ${totalScore} but status was ${status}. Downgrading to APPLY_AFTER_VERIFICATION.`);
                  status = "APPLY_AFTER_VERIFICATION";
              }

              console.log(`  -> Complete: Score = ${totalScore}/100, Status = ${status}, Track = ${track}`);
              
              const techScore = (evalResult as any).score_technical_autonomy ?? evalResult.score_breakdown?.technical_autonomy?.score ?? 0;
              const compScore = (evalResult as any).score_comp_quality ?? evalResult.score_breakdown?.comp_quality?.score ?? 0;
              const domainScore = (evalResult as any).score_hands_on_mastery ?? evalResult.score_breakdown?.hands_on_mastery?.score ?? 0;
              const envScore = (evalResult as any).score_role_purity ?? evalResult.score_breakdown?.role_purity?.score ?? 0;
              const mobilityScore = (evalResult as any).score_market_durability ?? evalResult.score_breakdown?.market_durability?.score ?? 0;
              const bioRisk = (evalResult as any).biological_stress_risk || evalResult.biological_and_stress_risk_assessment || null;

              const finalStatus = status;

              // Insert into the final jobs/companies table
              const finalJob = await db.addJob({
                title: rawJob.title,
                company: rawJob.company_name,
                source: rawJob.source as any,
                description: rawJob.raw_description,
                salaryRange: rawJob.salary_range || undefined,
                location: rawJob.location || undefined,
                careers_portal_url: rawJob.careers_portal_url,
                postedDate: rawJob.posted_date ? new Date(rawJob.posted_date).toISOString().split('T')[0] : undefined,
                stage1_status: evalResult.stage1_status || "PASS",
                final_classification: finalStatus,
                career_horizon_route: track,
                confidence_level: evalResult.confidence_level || "Medium",
                core_fit_score: totalScore,
                score_technical_autonomy: techScore,
                score_comp_quality: compScore,
                score_hands_on_mastery: domainScore,
                score_role_purity: envScore,
                score_market_durability: mobilityScore,
                nd_friendly_score: evalResult.nd_friendly_score || 0,
                politics_stress_score: evalResult.politics_stress_score || 0,
                sensory_overload_index: evalResult.sensory_overload_index || 0,
                biological_stress_risk: bioRisk,
                strategic_value: evalResult.strategic_value || "None",
                recommended_cv_version: evalResult.recommended_cv_version || "None",
                next_action: evalResult.next_action || "None",
                is_top_ten: false
              }, true); // bypass live check since it was validated at extraction
              
              console.log(`  -> Inserted evaluated job into final table with ID ${finalJob.id}`);
              
              // Mark raw job as processed
              await db.markRawJobProcessed(rawJob.id);
              evaluatedTodayIds.push(finalJob.id);
            } else {
              console.log("  -> Complete (warnings: no evaluation details returned in payload)");
            }
          } catch (err: any) {
            console.error(`❌ Evaluation failed for raw job ID ${rawJob.id}:`, err.message || err);
          }
        }
      } finally {
        try {
          await browser.close();
        } catch (err: any) {
          console.warn("⚠️ Browser close cleanup warning (non-fatal):", err.message || err);
        }
      }
    }

    // 3. Daily Top 10 Selection
    console.log("\nSelecting daily Top 10 recommended jobs...");
    const allJobs = await db.queryJobs();
    
    // Filter jobs that were evaluated in the current run and are eligible (status in 'STRONG MATCH', 'REVIEW REQUIRED')
    const eligibleJobs = allJobs.filter(j => 
      evaluatedTodayIds.includes(j.id) && 
      (j.final_classification === "PRIORITY_APPLY" || j.final_classification === "APPLY_AFTER_VERIFICATION") &&
      (j.core_fit_score !== null && j.core_fit_score >= 70) // Math Sanity Check
    );
    
    // Sort by core_fit_score DESC
    const sortedEligible = eligibleJobs.sort((a, b) => (b.core_fit_score || 0) - (a.core_fit_score || 0));
    
    const topTen = sortedEligible.slice(0, 10);
    for (const job of topTen) {
      await pool.query("UPDATE jobs SET is_top_ten = TRUE WHERE id = $1", [job.id]);
    }
    
    const processedTodayCount = evaluatedTodayIds.length;
    const topTenCount = topTen.length;
    
    console.log("====================================================");
    console.log("             DAILY SELECTION SUMMARY                ");
    console.log("====================================================");
    console.log(`Processed raw jobs today: ${processedTodayCount}`);
    if (processedTodayCount === 0) {
      console.log("No new jobs were processed today.");
    } else {
      console.log(`Jobs making it to the Top 10 to apply: ${topTenCount}`);
      if (topTenCount === 0) {
        console.log("No jobs processed today met the criteria for applying.");
      } else {
        topTen.forEach((j, i) => {
          console.log(`  [#${i+1}] ${j.title} at ${j.company} (Score: ${j.core_fit_score}/100, Status: ${j.final_classification})`);
        });
      }
    }
    console.log("====================================================");

    // 4. Clean up Gmail Jobs-Alerts-Processed folder
    const gmailUser = process.env.GMAIL_USER;
    const gmailPassword = process.env.GMAIL_APP_PASSWORD;
    const gmailFolder = process.env.GMAIL_FOLDER || "Jobs-Alerts";
    const gmailProcessedFolder = process.env.GMAIL_PROCESSED_FOLDER || "Jobs-Alerts-Processed";

    if (gmailUser && gmailPassword) {
      console.log(`\nConnecting to Gmail to purge both alert folders...`);
      const { ImapFlow } = await import("imapflow");
      const imapClient = new ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: {
          user: gmailUser,
          pass: gmailPassword
        },
        logger: false
      });

      try {
        await imapClient.connect();

        // 1. Purge main Jobs-Alerts folder
        const mainMailbox = await imapClient.mailboxOpen(gmailFolder);
        if (mainMailbox.exists > 0) {
          console.log(`Deleting ${mainMailbox.exists} emails from Gmail folder "${gmailFolder}"...`);
          await imapClient.messageFlagsAdd("1:*", ["\\Deleted"]);
          console.log(`✅ Cleaned up "${gmailFolder}" folder.`);
        } else {
          console.log(`Gmail folder "${gmailFolder}" is already empty.`);
        }
        await imapClient.mailboxClose();

        // 2. Purge Jobs-Alerts-Processed folder
        const processedMailbox = await imapClient.mailboxOpen(gmailProcessedFolder);
        if (processedMailbox.exists > 0) {
          console.log(`Deleting ${processedMailbox.exists} processed emails from Gmail folder "${gmailProcessedFolder}"...`);
          await imapClient.messageFlagsAdd("1:*", ["\\Deleted"]);
          console.log(`✅ Cleaned up "${gmailProcessedFolder}" folder.`);
        } else {
          console.log(`Gmail folder "${gmailProcessedFolder}" is already empty.`);
        }
        await imapClient.mailboxClose();

        await imapClient.logout();
      } catch (gmailErr: any) {
        console.error(`⚠️ Failed to clean up Gmail folders:`, gmailErr.message || gmailErr);
      }
    }

    console.log("\n✅ Pipeline completed successfully!");

  } catch (err: any) {
    console.error("❌ Fatal pipeline failure:", err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runPipeline();
