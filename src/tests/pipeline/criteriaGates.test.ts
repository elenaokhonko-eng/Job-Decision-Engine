import { describe, it, expect } from "vitest";
import { applyGlobalGates, isTechnicalRole, evaluateWorkability } from "../../services/criteria.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/anonymized_nine_emails.json");
const fixtureEmails: any[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));

describe("Criteria Hard Gates & Workability Unit Tests", () => {
  describe("Nine Email Fixture Deterministic Classification", () => {
    it("classifies all 9 email fixtures accurately according to expected gate statuses", () => {
      const results = fixtureEmails.map((email) => {
        const company = email.subject.split(" at ")[1] || "Unknown Corp";
        const title = email.subject.replace("Job Alert: ", "").replace("REPOST - ", "").split(" at ")[0] || "Unknown Title";
        const location = email.id === "fixture-email-005" ? "Melbourne, Australia" : email.id === "fixture-email-007" ? "Location flexible / TBD" : "Singapore";
        const workplaceType = email.id === "fixture-email-005" ? "ONSITE" : email.id === "fixture-email-007" ? "UNKNOWN" : "REMOTE";

        const job = {
          id: email.id,
          title,
          company_name: company,
          raw_description: email.raw_html || email.subject,
          location,
          workplace_type: workplaceType,
          employment_type: "PERMANENT"
        };

        const gateResult = applyGlobalGates(job as any);
        return {
          id: email.id,
          title,
          status: gateResult.status,
          expected: email.expected_gate
        };
      });

      const passCount = results.filter(r => r.status === "PASS").length;
      const rejectCount = results.filter(r => r.status === "HARD_REJECT").length;
      const verifyCount = results.filter(r => r.status === "NEEDS_VERIFICATION").length;

      expect(rejectCount).toBe(2);
      expect(verifyCount).toBe(1);
      expect(passCount).toBe(6); // 6 observations = 5 unique canonical jobs + 1 repost

      for (const res of results) {
        expect(res.status).toBe(res.expected);
      }
    });
  });

  describe("Counterfactual Role Title Invariance", () => {
    const coreDescription = "Building automated LLM evaluation pipelines, agentic RAG systems, and fine-tuning models in Python and PyTorch.";

    it("accepts researcher, scientist, engineer, and architect titles with identical technical responsibilities", () => {
      const testTitles = [
        "AI Systems Engineer",
        "AI Research Scientist",
        "Applied AI Researcher",
        "AI Platform Architect",
        "Bioinformatics AI Scientist",
        "Associate Director, Legal AI & RegTech",
        "Quantitative Research Developer",
        "Staff Knowledge Engineer"
      ];

      for (const title of testTitles) {
        const job = {
          id: "test-counterfactual",
          title,
          company_name: "Tech Corp",
          raw_description: coreDescription,
          location: "Singapore",
          workplace_type: "REMOTE",
          employment_type: "PERMANENT"
        };

        const result = applyGlobalGates(job as any);
        expect(result.status, `Failed for title: ${title}`).toBe("PASS");
      }
    });

    it("rejects non-technical titles even if they mention compliance without building evidence", () => {
      const complianceJob = {
        id: "test-nontech",
        title: "Compliance Officer",
        company_name: "Finance Corp",
        raw_description: "Manage regulatory compliance checklists, attend audit committee meetings, and file annual paperwork.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT"
      };

      const result = applyGlobalGates(complianceJob as any);
      expect(result.status).toBe("HARD_REJECT");
    });
  });

  describe("Structured Workability & Contract Evaluation", () => {
    it("hard rejects structured ONSITE workplace_type", () => {
      const job = {
        id: "onsite-job",
        title: "Senior AI Engineer",
        company_name: "Office Co",
        raw_description: "Build deep learning models.",
        location: "Singapore",
        workplace_type: "ONSITE",
        employment_type: "PERMANENT"
      };
      const result = applyGlobalGates(job as any);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("UNWORKABLE_LOCATION_MODEL");
    });

    it("hard rejects structured CONTRACT employment_type", () => {
      const job = {
        id: "contract-job",
        title: "Senior AI Engineer",
        company_name: "Contract Co",
        raw_description: "Build deep learning models.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "CONTRACT"
      };
      const result = applyGlobalGates(job as any);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_CONTRACT_ROLE");
    });

    it("passes hybrid workplace_type with <= 3 days", () => {
      const job = {
        id: "hybrid-3days",
        title: "Senior AI Engineer",
        company_name: "Flex Co",
        raw_description: "Build deep learning models. 2 days a week in the office.",
        location: "Singapore",
        workplace_type: "HYBRID",
        employment_type: "PERMANENT"
      };
      const result = applyGlobalGates(job as any);
      expect(result.status).toBe("PASS");
    });

    it("flags ambiguous location and office expectations for verification", () => {
      const job = {
        id: "hybrid-ambiguous",
        title: "Senior AI Engineer",
        company_name: "Flex Co",
        raw_description: "Build deep learning models. Location flexible / TBD. Workplace arrangement and office expectations to be evaluated during partner discussions.",
        location: "Location flexible / TBD",
        workplace_type: "UNKNOWN",
        employment_type: "PERMANENT"
      };
      const result = applyGlobalGates(job as any);
      expect(result.status).toBe("NEEDS_VERIFICATION");
    });
  });
});
