import puppeteer from 'puppeteer';

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
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  const urls = [
    "https://www.mycareersfuture.gov.sg/job/information-technology/data-ai=",
    "https://www.linkedin.com/jobs-guest/jobs/api/jobDetail/4438531898"
  ];

  for (const url of urls) {
    console.log(`\nNavigating to: ${url}`);
    try {
      const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
      console.log(`- Response Status: ${response ? response.status() : 'NULL'}`);
      console.log(`- Final URL: ${page.url()}`);
      
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log(`- Body length: ${bodyText.length}`);
      console.log(`- Body Snippet: ${bodyText.substring(0, 300).replace(/\n/g, ' ')}`);
    } catch (err: any) {
      console.error(`- Error: ${err.message}`);
    }
  }

  await browser.close();
}

run();
