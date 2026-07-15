import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/db.ts";
import { runAgent } from "../services/agent.ts";

describe.sequential("Job Decision Engine Test Suite", () => {
  beforeEach(() => {
    // Reset database to default seed state before each test
    db.resetToDefaults();
  });

  // Test 1: Database Read Happy Path
  it("Test 1: should fetch seeded jobs from database", () => {
    const jobs = db.queryJobs();
    expect(jobs).toBeInstanceOf(Array);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0]).toHaveProperty("title");
    expect(jobs[0]).toHaveProperty("company");
    expect(jobs[0]).toHaveProperty("description");
  });

  // Test 2: Database Insert Happy Path
  it("Test 2: should add a new job to the database", () => {
    const newJobPayload = {
      title: "Senior Biotech Specialist",
      company: "Amsterdam FloraPharma",
      source: "LinkedIn" as const,
      description: "Hands-on research on medicinal plants for clinical pipelines in Utrecht, Netherlands. No travel.",
      salaryRange: "EUR 6,000 / month",
      location: "Utrecht, Netherlands",
      careers_portal_url: "https://www.florapharma.nl/careers"
    };

    const addedJob = db.addJob(newJobPayload);
    expect(addedJob).toHaveProperty("id");
    expect(addedJob.title).toBe(newJobPayload.title);
    expect(addedJob.company).toBe(newJobPayload.company);

    const jobs = db.queryJobs("FloraPharma");
    expect(jobs.length).toBe(1);
    expect(jobs[0].title).toBe("Senior Biotech Specialist");
  });

  // Test 3: Database Delete Happy Path
  it("Test 3: should delete an existing job from the database", () => {
    const jobsBefore = db.queryJobs();
    expect(jobsBefore.length).toBe(5);
    
    const targetId = jobsBefore[0].id;

    const deleteResult = db.deleteJob(targetId);
    expect(deleteResult).toBe(true);

    const jobsAfter = db.queryJobs();
    expect(jobsAfter.length).toBe(4);
    expect(jobsAfter.find(j => j.id === targetId)).toBeUndefined();
  });

  // Test 4: Database Interaction Logging Happy Path
  it("Test 4: should successfully log agent interactions", () => {
    const question = "Check high paying finance jobs in the database";
    const toolsUsed = ["queryDatabaseForJobs"];
    const answer = { summary: "Top matched jobs found" };
    const trace = ["Step 1: Init", "Step 2: DB query completed"];

    const interaction = db.logInteraction(question, toolsUsed, answer, trace);
    expect(interaction).toHaveProperty("id");
    expect(interaction.question).toBe(question);
    expect(interaction.toolsUsed).toContain("queryDatabaseForJobs");

    const logs = db.getInteractions();
    expect(logs.length).toBe(1);
    expect(logs[0].id).toBe(interaction.id);
  });

  // Test 5: Agent Initialization Key Validation Failure Case (Loud Fail)
  it("Test 5: should fail loud if GEMINI_API_KEY is not configured", async () => {
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
