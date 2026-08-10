import puppeteer from 'puppeteer';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const url = 'https://www.linkedin.com/jobs/view/4446979145/';
  console.log(`Launching browser to retrieve full description for: ${url}`);
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Extract description using standard selectors
    const description = await page.evaluate(() => {
      const descEl = document.querySelector('.description__text') || 
                    document.querySelector('.show-more-less-html__markup') ||
                    document.querySelector('.jobs-description-content') ||
                    document.querySelector('.jobs-description');
      return descEl ? (descEl as HTMLElement).innerText.trim() : '';
    });

    if (!description || description.length < 100) {
      throw new Error(`Failed to extract a valid description. Got length: ${description ? description.length : 0}`);
    }

    console.log(`Successfully retrieved description (${description.length} chars).`);
    
    // Package description as structured JSON
    const structuredDesc = {
      "job_description": description,
      "key_responsibilities": [],
      "technical_skills": [],
      "qualifications_education": [],
      "nice_to_haves": []
    };
    const descriptionJson = JSON.stringify(structuredDesc);

    // Clean up any existing records in jobs to prevent duplicates
    await pool.query("DELETE FROM jobs WHERE company_name = 'BJAK' AND title = 'Technical Product Manager'");
    await pool.query("DELETE FROM raw_jobs WHERE company_name = 'BJAK' AND title = 'Technical Product Manager'");

    // Insert into raw_jobs
    const insertRes = await pool.query(`
      INSERT INTO raw_jobs 
      (company_name, title, source, raw_description, salary_range, location, careers_portal_url, processed) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
      RETURNING id
    `, [
      'BJAK', 
      'Technical Product Manager', 
      'LinkedIn', 
      descriptionJson, 
      'SGD 8,000 - SGD 12,000', 
      'Singapore (Hybrid)', 
      url
    ]);

    console.log(`Successfully staged BJAK Technical Product Manager in raw_jobs (Staging ID: ${insertRes.rows[0].id}).`);

  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  } finally {
    await browser.close();
    await pool.end();
  }
}

run();
