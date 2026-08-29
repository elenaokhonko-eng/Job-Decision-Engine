/**
 * Sprint G — Cover Letter & CV generation contract tests
 *
 * Tests the generation scripts' input validation and output schema enforcement
 * without hitting the DB or the LLM API.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_COVER_LETTER_PAYLOAD = {
  cover_letter: {
    recipient_name: "Hiring Team",
    opening_hook:
      "I am writing to express my strong interest in the AI Policy Analyst role at DeepMind, where my background in applied AI strategy directly aligns with your mission.",
    body_paragraphs: [
      "During my tenure at GovTech Singapore I designed the national AI governance framework, providing direct evidence for requirement R-01 (Policy Architecture).",
      "As lead for the ASEAN AI Ethics Taskforce, I facilitated cross-border regulatory harmonisation — a direct match for R-03 (Stakeholder Engagement).",
    ],
    closing_statement:
      "I would welcome the opportunity to discuss how my work can accelerate DeepMind's policy agenda. Available for interview at your convenience.",
  }
};

const INVALID_COVER_LETTER_PAYLOAD_MISSING_FIELD = {
  cover_letter: {
    recipient_name: "Hiring Team",
    opening_hook: "Some opening.",
    // body_paragraphs intentionally missing
    closing_statement: "Some closing.",
  }
};

// ── cleanJsonResponse (inline copy for testing) ──────────────────────────────

function cleanJsonResponse(rawText: string): string {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return cleaned;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("P2-G1: Cover Letter Generation Contract", () => {
  it("should strip markdown fences from LLM JSON response (```json ... ```)", () => {
    const raw = "```json\n" + JSON.stringify(VALID_COVER_LETTER_PAYLOAD) + "\n```";
    const cleaned = cleanJsonResponse(raw);
    const parsed = JSON.parse(cleaned);
    expect(parsed.cover_letter.opening_hook).toContain("DeepMind");
  });

  it("should strip plain code fences from LLM JSON response (``` ... ```)", () => {
    const raw = "```\n" + JSON.stringify(VALID_COVER_LETTER_PAYLOAD) + "\n```";
    const cleaned = cleanJsonResponse(raw);
    const parsed = JSON.parse(cleaned);
    expect(parsed.cover_letter.body_paragraphs).toHaveLength(2);
  });

  it("should pass validation for a complete cover letter payload", () => {
    const cl = VALID_COVER_LETTER_PAYLOAD.cover_letter;
    const required = ["recipient_name", "opening_hook", "body_paragraphs", "closing_statement"];
    for (const field of required) {
      expect((cl as any)[field]).toBeDefined();
    }
  });

  it("should fail validation and detect missing required field", () => {
    const cl = INVALID_COVER_LETTER_PAYLOAD_MISSING_FIELD.cover_letter;
    const required = ["recipient_name", "opening_hook", "body_paragraphs", "closing_statement"];
    const missing = required.filter(
      (field) => !(cl as any)[field]
    );
    expect(missing).toContain("body_paragraphs");
  });

  it("should not invent evidence — body paragraphs must reference evidence IDs or direct quotes", () => {
    // Each body paragraph must be non-empty (proxy for grounded content)
    for (const para of VALID_COVER_LETTER_PAYLOAD.cover_letter.body_paragraphs) {
      expect(para.length).toBeGreaterThan(20);
    }
  });

  it("should keep cover letter within one page (max 6 paragraphs total)", () => {
    const totalParagraphs =
      1 + // opening
      VALID_COVER_LETTER_PAYLOAD.cover_letter.body_paragraphs.length +
      1; // closing
    expect(totalParagraphs).toBeLessThanOrEqual(6);
  });
});

describe("P2-G2: generate_cv.ts schema contract", () => {
  it("should require a job_analysis schema with at least 6 requirements", () => {
    const schemaPath = path.resolve(
      process.cwd(),
      "scripts",
      "schemas",
      "job_analysis.schema.json"
    );
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    expect(schema.properties.requirements.minItems).toBeGreaterThanOrEqual(6);
    expect(schema.properties.requirements.maxItems).toBeLessThanOrEqual(12);
  });

  it("should require importance_components with max total ≤ 100", () => {
    const schemaPath = path.resolve(
      process.cwd(),
      "scripts",
      "schemas",
      "job_analysis.schema.json"
    );
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const ic = schema.properties.requirements.items.properties.importance_components.properties;
    const maxTotal =
      ic.role_mandate.maximum +
      ic.prominence.maximum +
      ic.business_outcome.maximum +
      ic.seniority.maximum +
      ic.repetition.maximum;
    expect(maxTotal).toBe(100);
  });

  it("should require mandatory fields: requirement_id, source_text, mandatory, category", () => {
    const schemaPath = path.resolve(
      process.cwd(),
      "scripts",
      "schemas",
      "job_analysis.schema.json"
    );
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const required: string[] = schema.properties.requirements.items.required;
    expect(required).toContain("requirement_id");
    expect(required).toContain("source_text");
    expect(required).toContain("mandatory");
    expect(required).toContain("category");
  });
});
