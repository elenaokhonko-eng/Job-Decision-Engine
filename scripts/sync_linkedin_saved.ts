import puppeteer from "puppeteer";
import pg from "pg";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();
dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;
const liAtCookie = process.env.LINKEDIN_LI_AT;

async function syncLinkedInSavedJobs() {
  console.log("====================================================");
  console.log("   AUTOMATED LINKEDIN SAVED JOBS SYNC & UNSAVE      ");
  console.log("====================================================");

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    process.exit(1);
  }

  if (!liAtCookie || liAtCookie.trim() === "" || liAtCookie === "YOUR_LINKEDIN_LI_AT_COOKIE") {
    console.error("❌ ERROR: LINKEDIN_LI_AT cookie value is missing in environment variables.");
    console.log("Please copy your 'li_at' cookie value from your active LinkedIn browser session");
    console.log("and set it in your .env.local file as: LINKEDIN_LI_AT=\"your_cookie_value\"");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
  });

  console.log("Initializing headless browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });

  try {
    console.log("Injecting active LinkedIn session cookies...");
    await page.setCookie({
      name: "li_at",
      value: liAtCookie,
      domain: ".linkedin.com",
      path: "/",
      secure: true
    });

    console.log("Navigating to LinkedIn Saved Jobs tracker...");
    await page.goto("https://www.linkedin.com/my-items/saved-jobs/", { waitUntil: "networkidle2" });

    // Check if we got redirected to login page
    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("signup")) {
      throw new Error("LinkedIn authentication failed. Your 'li_at' cookie might be expired or invalid.");
    }

    console.log("Scrolling page to load all saved jobs list items...");
    let prevHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 30;

    while (scrollAttempts < maxScrollAttempts) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        // Also scroll internal list containers if any
        const scrollContainer = document.querySelector('.scaffold-layout__list') || document.querySelector('.reusable-search__result-container')?.closest('div');
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      
      const count = await page.evaluate(() => document.querySelectorAll('a[href*="/jobs/view/"]').length);
      console.log(`- Scroll progress: loaded ${count} job link elements...`);

      if (newHeight === prevHeight && scrollAttempts > 5) {
        break;
      }
      prevHeight = newHeight;
      scrollAttempts++;
    }

    // Extract basic metadata of saved jobs
    const jobsList = await page.evaluate(() => {
      const jobElements = Array.from(document.querySelectorAll('.reusable-search__result-container, .entity-list-item'));
      return jobElements.map(el => {
        const titleLink = el.querySelector('a[href*="/jobs/view/"]') as HTMLAnchorElement | null;
        if (!titleLink) return null;
        
        const url = titleLink.href.split('?')[0];
        const title = titleLink.innerText.trim();
        
        const companyEl = el.querySelector('.entity-list-item__subtitle, .reusable-search__result-subtitle, .job-card-container__company-name');
        const company = companyEl ? (companyEl as HTMLElement).innerText.trim() : 'Unknown Company';
        
        const locationEl = el.querySelector('.entity-list-item__caption, .reusable-search__result-caption, .job-card-container__metadata-item');
        const location = locationEl ? (locationEl as HTMLElement).innerText.trim() : 'Singapore';
        
        return { title, company, url, location };
      }).filter((j): j is { title: string; company: string; url: string; location: string } => j !== null);
    });

    // Deduplicate
    const uniqueJobs = Array.from(new Map(jobsList.map(item => [item.url, item])).values());
    console.log(`📊 Found ${uniqueJobs.length} unique saved jobs to process.`);

    if (uniqueJobs.length === 0) {
      console.log("No saved jobs found. Exiting.");
      return;
    }

    let successCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < uniqueJobs.length; i++) {
      const job = uniqueJobs[i];
      console.log(`\n[${i + 1}/${uniqueJobs.length}] Processing: "${job.title}" at "${job.company}"`);

      // 1. Check for duplicates in DB first to avoid unnecessary scraping
      const checkRaw = await pool.query(
        "SELECT id FROM raw_jobs WHERE careers_portal_url = $1 OR (title = $2 AND company_name = $3)",
        [job.url, job.title, job.company]
      );
      const checkFinal = await pool.query(
        "SELECT id FROM jobs WHERE careers_portal_url = $1 OR (title = $2 AND company_name = $3)",
        [job.url, job.title, job.company]
      );

      if (checkRaw.rows.length > 0 || checkFinal.rows.length > 0) {
        console.log(`- Job already exists in DB. Attempting to unsave...`);
        // Go to page to unsave it
        await page.goto(job.url, { waitUntil: "networkidle2" });
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const unsaved = await unsaveCurrentJob(page);
        if (unsaved) {
          console.log(`- Successfully unsaved duplicate.`);
        }
        skippedCount++;
        continue;
      }

      // 2. Navigate to job page to scrape description
      await page.goto(job.url, { waitUntil: "networkidle2" });
      await new Promise(resolve => setTimeout(resolve, 2000));

      const description = await page.evaluate(() => {
        const descEl = document.querySelector('.jobs-description-content') || 
                      document.querySelector('.show-more-less-html__markup') || 
                      document.querySelector('[id^="job-details"]') || 
                      document.querySelector('.jobs-box__html-content') ||
                      document.querySelector('.jobs-description');
        return descEl ? (descEl as HTMLElement).innerText.trim() : '';
      });

      if (!description) {
        console.warn(`- ⚠️ Warning: Could not extract description. Skipping.`);
        skippedCount++;
        continue;
      }

      // 3. Insert into raw_jobs (staging)
      await pool.query(
        `INSERT INTO raw_jobs 
         (company_name, title, source, raw_description, location, careers_portal_url, processed) 
         VALUES ($1, $2, 'LinkedIn', $3, $4, $5, FALSE)`,
        [job.company, job.title, description, job.location, job.url]
      );
      console.log(`- Ingested into database.`);

      // 4. Click "Saved" button to Unsave
      const unsaved = await unsaveCurrentJob(page);
      if (unsaved) {
        console.log(`- Unsaved from LinkedIn tracker.`);
      } else {
        console.log(`- Could not find Unsave button. Skipping unsave action.`);
      }

      successCount++;
      // Sleep to prevent triggering rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`\n====================================================`);
    console.log(`✅ LinkedIn saved jobs sync completed!`);
    console.log(`- Ingested & Unsaved: ${successCount} jobs`);
    console.log(`- Skipped/Duplicates: ${skippedCount} jobs`);
    console.log(`====================================================`);

  } catch (err: any) {
    console.error("❌ Sync Error:", err.message || err);
  } finally {
    await browser.close();
    await pool.end();
  }
}

async function unsaveCurrentJob(page: puppeteer.Page): Promise<boolean> {
  return await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const savedBtn = buttons.find(btn => btn.innerText.trim().toLowerCase() === 'saved');
    if (savedBtn) {
      (savedBtn as HTMLButtonElement).click();
      return true;
    }
    return false;
  });
}

syncLinkedInSavedJobs();
