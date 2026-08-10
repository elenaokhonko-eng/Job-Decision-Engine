import puppeteer from 'puppeteer';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const liAtCookie = process.env.LINKEDIN_LI_AT;

async function run() {
  console.log("Launching browser to check LinkedIn cookie status...");
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
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1200, height: 800 });

  if (!liAtCookie) {
    console.error("No LINKEDIN_LI_AT cookie found.");
    await browser.close();
    return;
  }

  try {
    console.log("Setting cookie...");
    await page.setCookie({
      name: "li_at",
      value: liAtCookie,
      domain: ".linkedin.com",
      path: "/",
      secure: true
    });

    console.log("Navigating directly to Saved Jobs tracker...");
    const response = await page.goto("https://www.linkedin.com/my-items/saved-jobs/", { waitUntil: "networkidle2", timeout: 30000 });
    console.log(`- Final URL: ${page.url()}`);
    console.log(`- Status: ${response ? response.status() : 'NULL'}`);
    
    // Save a screenshot to help debug
    await page.screenshot({ path: "scratch/linkedin_session_status.png" });
    console.log("Screenshot saved to scratch/linkedin_session_status.png");
  } catch (err: any) {
    console.error("Navigation error:", err.message);
  } finally {
    await browser.close();
  }
}

run();
