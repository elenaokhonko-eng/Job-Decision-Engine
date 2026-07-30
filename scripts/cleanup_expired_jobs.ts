import pg from 'pg';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function checkExpiry(url: string, browser: puppeteer.Browser): Promise<boolean> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1200, height: 800 });

    if (url.includes("linkedin.com/jobs/view/") || url.includes("linkedin.com/comm/jobs/view/")) {
      const match = url.match(/\/view\/(\d+)/);
      if (match && match[1]) {
        const jobId = match[1];
        const guestUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobDetail/${jobId}`;
        const response = await page.goto(guestUrl, { waitUntil: "networkidle2", timeout: 20000 });
        if (response && (response.status() === 404 || response.status() === 410)) {
          return true;
        }
        const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
        if (pageText.includes("no longer accepting applications") || pageText.includes("job has expired") || pageText.includes("expired")) {
          return true;
        }
        return false;
      }
    }

    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
    if (!response || response.status() === 404 || response.status() === 410) {
      return true;
    }

    const finalUrl = page.url().toLowerCase();
    if (finalUrl.includes("expired") || finalUrl.includes("not-found") || finalUrl.includes("job-not-found") || finalUrl.includes("inactive")) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    
    // Check MCF blank/error page (status 200 but no actual job details, text length is short)
    if (url.includes("mycareersfuture.gov.sg") && pageText.length < 2500) {
      return true;
    }

    const expiredKeywords = [
      "this job has expired",
      "no longer accepting applications",
      "job posting has expired",
      "posting is no longer active",
      "job is no longer available",
      "expired job application"
    ];

    if (expiredKeywords.some(keyword => pageText.includes(keyword))) {
      return true;
    }

    return false;
  } catch (err: any) {
    const errMsg = err.message || "";
    console.warn(`  -> Verification failed for ${url}: ${errMsg}`);
    if (errMsg.includes("ERR_ABORTED") || errMsg.includes("ERR_INVALID_URL") || errMsg.includes("ERR_NAME_NOT_RESOLVED")) {
      return true;
    }
    return false;
  } finally {
    try {
      await page.close();
    } catch {}
  }
}

async function run() {
  console.log("====================================================");
  console.log("       EXPIRED JOBS CLEANUP & STATUS VALIDATION     ");
  console.log("====================================================");

  // 1. Fetch active jobs
  const res = await pool.query(
    "SELECT id, company_name, title, careers_portal_url, status FROM jobs WHERE status IN ('STRONG MATCH', 'REVIEW REQUIRED')"
  );
  console.log(`Found ${res.rows.length} active jobs in the database.`);

  if (res.rows.length === 0) {
    console.log("No active jobs to verify. Exiting.");
    await pool.end();
    return;
  }

  let browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  let expiredCount = 0;

  try {
    for (let i = 0; i < res.rows.length; i++) {
      const job = res.rows[i];
      const url = job.careers_portal_url;

      console.log(`[${i + 1}/${res.rows.length}] Checking active job: "${job.title}" at "${job.company_name}"...`);

      if (!url) {
        console.log("  -> No URL associated. Skipping.");
        continue;
      }

      let isExpired = false;
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
        isExpired = await checkExpiry(url, browser);
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
          isExpired = await checkExpiry(url, browser);
        } catch (retryErr: any) {
          console.error(`  -> Persistent browser error on retry: ${retryErr.message}`);
          continue;
        }
      }

      if (isExpired) {
        console.log(`  -> ⚠️ EXPIRED! Marking status as REJECTED and unsetting is_top_ten.`);
        await pool.query(
          "UPDATE jobs SET status = 'REJECTED', is_top_ten = FALSE, total_score = 0 WHERE id = $1",
          [job.id]
        );
        expiredCount++;
      } else {
        console.log("  -> Active.");
      }

      // Small delay between requests to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err: any) {
    console.error("❌ Fatal error during run:", err.message || err);
  } finally {
    try {
      await browser.close();
    } catch {}
    await pool.end();
    console.log("====================================================");
    console.log(`Cleanup completed! Total expired jobs rejected: ${expiredCount}`);
    console.log("====================================================");
  }
}

run();
