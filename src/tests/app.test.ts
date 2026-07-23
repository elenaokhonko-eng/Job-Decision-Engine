import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/db.ts";
import { runAgent } from "../services/agent.ts";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

describe.sequential("Job Decision Engine Test Suite", () => {
  beforeEach(async () => {
    // Skip if DATABASE_URL is not set
    if (!process.env.DATABASE_URL) return;

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
    if (!process.env.DATABASE_URL) {
      console.warn("⚠️ DATABASE_URL is not set. Skipping real DB tests.");
      return;
    }
    let jobs = await db.queryJobs();
    if (jobs.length === 0) {
      await db.addJob({
        title: "Lead AI & RegTech Platform Architect",
        company: "Apex Wealth Management",
        source: "eFinancialCareers",
        salaryRange: "SGD 24,000 - SGD 28,000 / month",
        postedDate: "2026-07-12",
        location: "Singapore (Hybrid)",
        careers_portal_url: "https://www.efinancialcareers.sg/jobs/lead-ai-regtech-platform-architect-apex-wealth-management-100231",
        description: "Hands-on Platform Architect experience building AI compliance platform.",
        status: "STRONG MATCH",
        assigned_track: "Track A - Finance/AI",
        confidence_level: "High",
        total_score: 92
      }, true);
      jobs = await db.queryJobs();
    }
    expect(jobs).toBeInstanceOf(Array);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]).toHaveProperty("title");
    expect(jobs[0]).toHaveProperty("company");
    expect(jobs[0]).toHaveProperty("description");
  });

  // Test 2: Database Write Happy Path
  it("Test 2: should add a new job to the database", async () => {
    if (!process.env.DATABASE_URL) return;
    const newJobPayload = {
      title: "Senior Biotech Specialist",
      company: "Amsterdam FloraPharma",
      source: "LinkedIn" as const,
      description: "Hands-on research on medicinal plants for clinical pipelines in Utrecht, Netherlands. No travel.",
      salaryRange: "EUR 6,000 / month",
      location: "Utrecht, Netherlands",
      careers_portal_url: "https://www.florapharma.nl/careers",
      status: "STRONG MATCH" as const,
      confidence_level: "High" as const,
      total_score: 85
    };

    const addedJob = await db.addJob(newJobPayload, true);
    expect(addedJob).toHaveProperty("id");
    expect(addedJob.title).toBe(newJobPayload.title);
    expect(addedJob.company).toBe(newJobPayload.company);

    const jobs = await db.queryJobs("FloraPharma");
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some(j => j.title === "Senior Biotech Specialist")).toBe(true);
  });

  // Test 3: Database Delete
  it("Test 3: should delete an existing job from the database", async () => {
    if (!process.env.DATABASE_URL) return;
    let jobsBefore = await db.queryJobs();
    if (jobsBefore.length === 0) {
      await db.addJob({
        title: "Test Delete Job",
        company: "Delete Company",
        source: "LinkedIn",
        description: "Test description",
        careers_portal_url: "https://www.linkedin.com/jobs/view/test-delete",
        status: "STRONG MATCH",
        confidence_level: "High",
        total_score: 80
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
    if (!process.env.DATABASE_URL) return;
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
  it("Test 5: should fail loud if GEMINI_API_KEY is not configured", async () => {
    if (!process.env.DATABASE_URL) return;
    // Temporarily save original keys
    const origKimi = process.env.KIMI_API_KEY;
    const origGemini = process.env.GEMINI_API_KEY;
    
    delete process.env.KIMI_API_KEY;
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY";

    // Expect the agent run to fail loud with a descriptive API error
    await expect(runAgent("Analyze jobs")).rejects.toThrow(
      "CRITICAL API KEY CONFLICT"
    );

    // Restore original keys
    if (origKimi) process.env.KIMI_API_KEY = origKimi;
    if (origGemini) process.env.GEMINI_API_KEY = origGemini;
  });
});
