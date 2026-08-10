import puppeteer from 'puppeteer';

async function run() {
  const url = 'https://www.linkedin.com/jobs/view/4446979145/';
  console.log(`Launching Puppeteer to scrape: ${url}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`Response status: ${response ? response.status() : 'null'}`);
    console.log(`Final URL: ${page.url()}`);
    
    const text = await page.evaluate(() => document.body.innerText);
    console.log(`\n=== PAGE TEXT (First 1500 chars) ===`);
    console.log(text.substring(0, 1500));
    console.log(`===================================`);
  } catch (err: any) {
    console.error(`Scrape failed: ${err.message}`);
  } finally {
    await browser.close();
  }
}

run();
