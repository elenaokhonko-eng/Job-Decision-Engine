import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/db.ts";
import { runAgent } from "../services/agent.ts";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

describe.sequential("Job Decision Engine Test Suite", () => {
  beforeEach(async () => {
    // Fail fast if DATABASE_URL is not set instead of silently skipping
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set to run the test suite. Exiting to prevent silent CI skips.");
    }

    // Protect production database from being wiped during test runs
    if (process.env.DATABASE_URL.includes("neon.tech") && process.env.ALLOW_TEST_DB_WIPE !== "true") {
      console.warn("⚠️ WARNING: DATABASE_URL points to a live Neon database. Wiping is blocked to prevent data loss. Set ALLOW_TEST_DB_WIPE=true to force.");
      return;
    }

    // Reset database to default seed state before each test
    await db.resetToDefaults();
  });

  // Test 1: Database Read Happy Path
  it("Test 1: should fetch seeded jobs from database", async () => {

    let jobs = await db.queryJobs();
    if (jobs.length === 0) {
      await db.addJob({
        title: "Lead AI & RegTech Platform Architect",
        company_name: "Apex Wealth Management",
        source: "eFinancialCareers",
        salary_range: "SGD 24,000 - SGD 28,000 / month",
        posted_date: "2026-07-12",
        location: "Singapore (Hybrid)",
        careers_portal_url: "https://www.efinancialcareers.sg/jobs/lead-ai-regtech-platform-architect-apex-wealth-management-100231",
        raw_description: "Hands-on Platform Architect experience building AI compliance platform.",
        processing_status: "EVALUATED",
        primary_lane: "CORE_AI_DATA",
        lane_confidence: "High",
        nd_friendly_score: 92
      }, true);
      jobs = await db.queryJobs();
    }
    expect(jobs).toBeInstanceOf(Array);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]).toHaveProperty("title");
    expect(jobs[0]).toHaveProperty("company_name");
    expect(jobs[0]).toHaveProperty("raw_description");
  });

  // Test 2: Database Write Happy Path
  it("Test 2: should add a new job to the database", async () => {

    const newJobPayload = {
      title: "Senior Biotech Specialist",
      company_name: "Amsterdam FloraPharma",
      source: "LinkedIn",
      raw_description: "Hands-on research on medicinal plants for clinical pipelines in Utrecht, Netherlands. No travel.",
      salary_range: "EUR 6,000 / month",
      location: "Utrecht, Netherlands",
      careers_portal_url: "https://www.florapharma.nl/careers",
      processing_status: "EVALUATED" as const,
      primary_lane: "HEALTH_BIO_PHARMA" as const,
      lane_confidence: "High",
      nd_friendly_score: 85
    };

    const addedJob = await db.addJob(newJobPayload, true);
    expect(addedJob).toHaveProperty("id");
    expect(addedJob.title).toBe(newJobPayload.title);
    expect(addedJob.company_name).toBe(newJobPayload.company_name);

    const jobs = await db.queryJobs("FloraPharma");
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some(j => j.title === "Senior Biotech Specialist")).toBe(true);
  });

  // Test 3: Database Delete
  it("Test 3: should delete an existing job from the database", async () => {

    let jobsBefore = await db.queryJobs();
    if (jobsBefore.length === 0) {
      await db.addJob({
        title: "Test Delete Job",
        company_name: "Delete Company",
        source: "LinkedIn",
        raw_description: "Test description",
        careers_portal_url: "https://www.linkedin.com/jobs/view/test-delete",
        processing_status: "EVALUATED",
        primary_lane: "CORE_AI_DATA",
        lane_confidence: "High",
        nd_friendly_score: 80
      }, true);
      jobsBefore = await db.queryJobs();
    }
    const initialLength = jobsBefore.length;
    expect(initialLength).toBeGreaterThan(0);

    const targetId = jobsBefore[0].id;
    const success = await db.deleteJob(targetId);
    expect(success).toBe(true);

    const jobsAfter = await db.queryJobs();
    expect(jobsAfter.length).toBe(initialLength - 1);
    expect(jobsAfter.find(j => j.id === targetId)).toBeUndefined();
  });

  // Test 4: Database Interaction Logging Happy Path
  it("Test 4: should successfully log agent interactions", async () => {

    const question = "Check high paying finance jobs in the database";
    const toolsUsed = ["queryDatabaseForJobs"];
    const answer = { summary: "Top matched jobs found" };
    const trace = ["Step 1: Init", "Step 2: DB query completed"];

    const interaction = await db.logInteraction(question, toolsUsed, answer, trace);
    expect(interaction).toHaveProperty("id");
    expect(interaction.question).toBe(question);
    expect(interaction.toolsUsed).toContain("queryDatabaseForJobs");

    const logs = await db.getInteractions();
    const logFound = logs.find(l => l.id === interaction.id);
    expect(logFound).toBeDefined();
    expect(logFound?.question).toBe(question);
  });

  // Test 5: Agent Initialization Key Validation Failure Case (Loud Fail)
  it("Test 5: should fail loud if neither GEMINI_API_KEY nor OPENAI_API_KEY is configured", async () => {

    // Temporarily save original keys
    const origGemini = process.env.GEMINI_API_KEY;
    const origOpenAI = process.env.OPENAI_API_KEY;
    
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    // Expect the agent run to fail loud with a descriptive API error
    await expect(runAgent("Analyze jobs")).rejects.toThrow(
      "CRITICAL API KEY CONFLICT"
    );

    // Restore original keys
    if (origGemini) process.env.GEMINI_API_KEY = origGemini;
    if (origOpenAI) process.env.OPENAI_API_KEY = origOpenAI;
  });
});
