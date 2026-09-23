import { describe, it, expect } from "vitest";
import { DesktopWorkerSupervisor } from "../../src/desktop/workerSupervisor.js";
import {
  buildRequirementInputText,
  buildProfileFactInputText,
  buildJobVersionInputText,
  hashText,
} from "../../src/embeddings/inputBuilder.js";

describe("Funnel V3 Independent Test Suite — Embeddings & Input Builder (E01-E08, P01-P02)", () => {
  it("E01/P01: buildJobVersionInputText formats job text and hashText produces stable SHA-256", () => {
    const text = buildJobVersionInputText({
      normalized_title: "Lead AI Engineer",
      description_text: "Building LLM pipelines in Python",
    });

    expect(text).toBe("Lead AI Engineer: Building LLM pipelines in Python");
    const hash1 = hashText(text);
    const hash2 = hashText(text);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("P02: buildRequirementInputText includes structured value and exact quote text", () => {
    const text = buildRequirementInputText({
      requirement_type: "CERTIFICATION",
      requirement_text: "AWS Solutions Architect",
      quote_text: "Must hold AWS Solutions Architect certificate",
      structured_value: { is_required: true },
    });

    expect(text).toContain("CERTIFICATION: AWS Solutions Architect");
    expect(text).toContain("Quote: Must hold AWS Solutions Architect certificate");
    expect(text).toContain('Structured: {"is_required":true}');
  });

  it("P03: buildProfileFactInputText preserves evidence tier and statement", () => {
    const text = buildProfileFactInputText({
      fact_type: "EXPERIENCE",
      statement: "5 years building distributed data systems",
      structured_value: { years: 5 },
      evidence_tier: "VERIFIED_PRIMARY",
    });

    expect(text).toBe('EXPERIENCE (VERIFIED_PRIMARY): 5 years building distributed data systems Structured: {"years":5}');
  });
});

describe("Funnel V3 Independent Test Suite — Desktop Worker Supervisor (D01-D06)", () => {
  it("D01: DesktopWorkerSupervisor initializes with managed workers and health reporting", () => {
    const supervisor = new DesktopWorkerSupervisor({
      projectRoot: process.cwd(),
      env: { JDEC_DESKTOP_ENABLE_WORKERS: "false" },
    });

    const status = supervisor.getStatus();
    expect(status).toBeDefined();
    expect(status.workers).toBeDefined();
    expect(status.workers.pipeline).toBeDefined();
    expect(status.workers.evaluation).toBeDefined();
    expect(status.workers.recovery).toBeDefined();
  });

  it("D05: Supervisor correctly tracks worker states across lifecycle", async () => {
    const supervisor = new DesktopWorkerSupervisor({
      projectRoot: process.cwd(),
      env: { JDEC_DESKTOP_ENABLE_WORKERS: "false" },
    });

    expect(supervisor.getStatus().state).toBe("not_started");
    await supervisor.stop();
    expect(supervisor.getStatus().state).toBe("stopped");
  });
});
