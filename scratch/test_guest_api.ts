import puppeteer from 'puppeteer';

async function run() {
  const url = 'https://www.linkedin.com/jobs-guest/jobs/api/jobDetail/4446979145';
  console.log(`Launching Puppeteer to check guest API: ${url}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`Response status: ${response ? response.status() : 'null'}`);
    const text = await page.evaluate(() => document.body.innerText);
    console.log(`Page text length: ${text.length}`);
    console.log(`Page text: ${text.substring(0, 500)}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  } finally {
    await browser.close();
  }
}

run();
