import puppeteer from "puppeteer";
import pg from "pg";
import dotenv from "dotenv";
import { runDeduplication } from "./deduplicate.ts";

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
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = await browser.newPage();
  
  // Spoof a realistic user agent
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  
  // Hide the webdriver automation flag
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

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

    console.log("Navigating to LinkedIn homepage for session initialization...");
    await page.goto("https://www.linkedin.com", { waitUntil: "networkidle2" });
    await new Promise(resolve => setTimeout(resolve, 3000));

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
    const maxScrollAttempts = 60; // Increased attempts

    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for initial items to load

    while (scrollAttempts < maxScrollAttempts) {
      await page.evaluate(() => {
        // Slow incremental scroll instead of jumping to the bottom
        window.scrollBy(0, 800);
        
        // Also scroll internal list containers if any
        const scrollContainer = document.querySelector('.scaffold-layout__list') || document.querySelector('.reusable-search__result-container')?.closest('div');
        if (scrollContainer) {
          scrollContainer.scrollBy(0, 800);
        }
      });
      await new Promise(resolve => setTimeout(resolve, 1500));
      const newHeight = await page.evaluate(() => {
        const scrollContainer = document.querySelector('.scaffold-layout__list') || document.querySelector('.reusable-search__result-container')?.closest('div');
        return scrollContainer ? scrollContainer.scrollHeight : document.body.scrollHeight;
      });
      
      const count = await page.evaluate(() => document.querySelectorAll('a[href*="/jobs/view/"]').length);
      console.log(`- Scroll progress: loaded ${count} job link elements...`);

      // check if we've hit the bottom of the container
      const isAtBottom = await page.evaluate(() => {
        const scrollContainer = document.querySelector('.scaffold-layout__list') || document.querySelector('.reusable-search__result-container')?.closest('div');
        if (scrollContainer) {
          return Math.abs(scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop) < 10;
        }
        return Math.abs(document.body.scrollHeight - window.innerHeight - window.scrollY) < 10;
      });

      if (isAtBottom && newHeight === prevHeight && scrollAttempts > 10) {
        // Check for a "Show more" button
        const showMoreClicked = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.toLowerCase().includes('show more'));
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });
        
        if (!showMoreClicked) {
           break; // Truly at bottom and no more to load
        }
      }
      prevHeight = newHeight;
      scrollAttempts++;
    }

    // Extract basic metadata of saved jobs using a more robust link-based approach
    const jobsList = await page.evaluate(() => {
      const jobLinks = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
      const rawList = [];
      for (const a of jobLinks) {
        const url = (a as HTMLAnchorElement).href.split('?')[0];
        const title = (a as HTMLAnchorElement).innerText.trim();
        if (!title || title.length < 3) continue; // Skip empty/icon links
        
        // Traverse up to find container list item or card
        const container = a.closest('li') || a.closest('.entity-list-item') || a.closest('div');
        let company = 'Unknown Company';
        let location = 'Singapore';
        
        if (container) {
          const companyEl = container.querySelector('.entity-list-item__subtitle, .reusable-search__result-subtitle, .job-card-container__company-name');
          if (companyEl) {
            company = (companyEl as HTMLElement).innerText.trim();
          }
          const locationEl = container.querySelector('.entity-list-item__caption, .reusable-search__result-caption, .job-card-container__metadata-item');
          if (locationEl) {
            location = (locationEl as HTMLElement).innerText.trim();
          }
        }
        rawList.push({ title, company, url, location });
      }
      return rawList;
    });

    // Deduplicate
    const uniqueJobs = Array.from(new Map(jobsList.map(item => [item.url, item])).values());
    console.log(`📊 Found ${uniqueJobs.length} unique saved jobs to process.`);

    if (uniqueJobs.length === 0) {
      console.log("No saved jobs found. Saving debug screenshot and exiting.");
      await page.screenshot({ path: "linkedin_saved_debug.png" });
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
    try {
      await runDeduplication();
    } catch (e) {
      console.error("❌ Deduplication during sync cleanup failed:", e);
    }
    try {
      await browser.close();
    } catch (e: any) {
      console.warn("⚠️ Browser close cleanup warning in sync (non-fatal):", e.message || e);
    }
    await pool.end();
  }
}

async function unsaveCurrentJob(page: puppeteer.Page): Promise<boolean> {
  // Wait for the button to appear in the DOM
  try {
    await page.waitForFunction(() => {
      const btn1 = document.querySelector('.jobs-save-button');
      if (btn1) return true;
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      return buttons.some(btn => {
        const text = (btn as HTMLElement).innerText.trim().toLowerCase();
        const aria = btn.getAttribute('aria-label')?.toLowerCase() || '';
        return text === 'saved' || text.includes('saved') || aria.includes('unsave') || aria === 'saved';
      });
    }, { timeout: 5000 });
  } catch (e) {
    // Timeout, button not found
    return false;
  }

  const clicked = await page.evaluate(() => {
    // 1. Try to find the button by standard class names used by LinkedIn
    let savedBtn = document.querySelector('.jobs-save-button') as HTMLButtonElement;
    
    // 2. Fallback to searching all buttons for the text "Saved" or aria-label
    if (!savedBtn) {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      savedBtn = buttons.find(btn => {
        const text = (btn as HTMLElement).innerText.trim().toLowerCase();
        const aria = btn.getAttribute('aria-label')?.toLowerCase() || '';
        return text === 'saved' || text.includes('saved') || aria.includes('unsave') || aria === 'saved';
      }) as HTMLButtonElement;
    }

    if (savedBtn) {
      savedBtn.click();
      return true;
    }
    
    return false;
  });

  if (clicked) {
    // Wait for LinkedIn API to process the unsave action
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  }
  return false;
}

syncLinkedInSavedJobs();
