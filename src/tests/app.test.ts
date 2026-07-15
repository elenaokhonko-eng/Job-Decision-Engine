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
    // Reset database to default seed state before each test
    await db.resetToDefaults();
  });

  // Test 1: Database Read Happy Path
  it("Test 1: should fetch seeded jobs from database", async () => {
    if (!process.env.DATABASE_URL) {
      console.warn("⚠️ DATABASE_URL is not set. Skipping real DB tests.");
      return;
    }
    const jobs = await db.queryJobs();
    expect(jobs).toBeInstanceOf(Array);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]).toHaveProperty("title");
    expect(jobs[0]).toHaveProperty("company");
    expect(jobs[0]).toHaveProperty("description");
  });

  // Test 2: Database Insert Happy Path
  it("Test 2: should add a new job to the database", async () => {
    if (!process.env.DATABASE_URL) return;
    const newJobPayload = {
      title: "Senior Biotech Specialist",
      company: "Amsterdam FloraPharma",
      source: "LinkedIn" as const,
      description: "Hands-on research on medicinal plants for clinical pipelines in Utrecht, Netherlands. No travel.",
      salaryRange: "EUR 6,000 / month",
      location: "Utrecht, Netherlands",
      careers_portal_url: "https://www.florapharma.nl/careers"
    };

    const addedJob = await db.addJob(newJobPayload);
    expect(addedJob).toHaveProperty("id");
    expect(addedJob.title).toBe(newJobPayload.title);
    expect(addedJob.company).toBe(newJobPayload.company);

    const jobs = await db.queryJobs("FloraPharma");
    expect(jobs.length).toBe(1);
    expect(jobs[0].title).toBe("Senior Biotech Specialist");
  });

  // Test 3: Database Delete Happy Path
  it("Test 3: should delete an existing job from the database", async () => {
    if (!process.env.DATABASE_URL) return;
    const jobsBefore = await db.queryJobs();
    const initialLength = jobsBefore.length;
    expect(initialLength).toBeGreaterThan(0);
    
    const targetId = jobsBefore[0].id;

    const deleteResult = await db.deleteJob(targetId);
    expect(deleteResult).toBe(true);

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
    expect(logs.length).toBe(1);
    expect(logs[0].id).toBe(interaction.id);
  });

  // Test 5: Agent Initialization Key Validation Failure Case (Loud Fail)
  it("Test 5: should fail loud if GEMINI_API_KEY is not configured", async () => {
    if (!process.env.DATABASE_URL) return;
    // Temporarily save original key
    const originalKey = process.env.GEMINI_API_KEY;
    
    // Explicitly delete or nullify the key to simulate a blank environment
    process.env.GEMINI_API_KEY = "MY_GEMINI_API_KEY"; // Default placeholder

    // Expect the agent run to fail loud with a descriptive API error
    await expect(runAgent("Analyze jobs")).rejects.toThrow(
      "CRITICAL DATABASE OR API KEY CONFLICT: GEMINI_API_KEY environment variable is not configured."
    );

    // Restore original key to avoid breaking other states
    process.env.GEMINI_API_KEY = originalKey;
  });
});
