import puppeteer from 'puppeteer';

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
        console.log(`Checking LinkedIn Guest URL: ${guestUrl}`);
        const response = await page.goto(guestUrl, { waitUntil: "networkidle2", timeout: 20000 });
        console.log(`LinkedIn Guest Status: ${response ? response.status() : 'NULL'}`);
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
    console.log(`Direct URL Status: ${response ? response.status() : 'NULL'}`);
    if (!response || response.status() === 404 || response.status() === 410) {
      return true;
    }

    const finalUrl = page.url().toLowerCase();
    console.log(`Final URL: ${finalUrl}`);
    if (finalUrl.includes("expired") || finalUrl.includes("not-found") || finalUrl.includes("job-not-found") || finalUrl.includes("inactive")) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const bodyLength = pageText.length;
    console.log(`Page body length: ${bodyLength}`);

    // If body length is extremely short (e.g. < 2000 chars for MyCareersFuture), it's a MCF error page!
    if (url.includes("mycareersfuture.gov.sg") && bodyLength < 2500) {
      console.log("MCF error page detected due to short body length.");
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
    console.warn(`Error during checkExpiry for ${url}: ${err.message || err}`);
    return false;
  } finally {
    await page.close();
  }
}

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const urls = [
    "https://www.mycareersfuture.gov.sg/job/information-technology/data-ai=",
    "https://www.linkedin.com/comm/jobs/view/4438531898/?trackingId="
  ];

  for (const url of urls) {
    console.log(`\n--- Testing ${url} ---`);
    const isExpired = await checkExpiry(url, browser);
    console.log(`Result: isExpired = ${isExpired}`);
  }

  await browser.close();
}

run();
