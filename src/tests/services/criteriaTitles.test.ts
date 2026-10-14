import { describe, it, expect } from "vitest";
import {
  GLOBAL_TITLE_EXCLUSIONS,
  isTechnicalRole,
  isConsultancyRole,
} from "../../services/criteria.js";

describe("Criteria Title Taxonomy & Exclusions", () => {
  describe("GLOBAL_TITLE_EXCLUSIONS", () => {
    it("allows AI and Machine Learning postdoctoral fellows", () => {
      const allowedTitles = [
        "Postdoctoral Fellow in Machine Learning",
        "Postdoctoral Researcher - Artificial Intelligence",
        "AI Research Fellow (Postdoctoral)",
        "Postdoc - Deep Learning & NLP",
        "Postdoctoral Associate in Generative AI",
      ];

      for (const title of allowedTitles) {
        const matches = GLOBAL_TITLE_EXCLUSIONS.some((regex) => regex.test(title));
        expect(matches, `Expected title to be allowed: ${title}`).toBe(false);
      }
    });

    it("excludes non-AI academic postdocs and professors", () => {
      const excludedTitles = [
        "Postdoctoral Fellow in Medieval History",
        "Postdoctoral Researcher in Organic Chemistry",
        "Adjunct Professor",
        "Tenure Track Assistant Professor",
      ];

      for (const title of excludedTitles) {
        const matches = GLOBAL_TITLE_EXCLUSIONS.some((regex) => regex.test(title));
        expect(matches, `Expected title to be excluded: ${title}`).toBe(true);
      }
    });

    it("excludes purely administrative, operations, sales, and retail roles", () => {
      const excludedTitles = [
        "Store Manager",
        "Cashier",
        "Executive Assistant",
        "Sales Representative",
        "Customer Success Associate",
        "HR Generalist",
      ];

      for (const title of excludedTitles) {
        const matches = GLOBAL_TITLE_EXCLUSIONS.some((regex) => regex.test(title));
        expect(matches, `Expected title to be excluded: ${title}`).toBe(true);
      }
    });
  });

  describe("isTechnicalRole", () => {
    it("recognizes modern technical architecture and consultant titles", () => {
      const technicalTitles = [
        "Enterprise Solutions Architect",
        "AI Solutions Architect",
        "Principal Solutions Architect",
        "Technical Consultant (Cloud & Data)",
        "AI Legal Solutions Consultant",
        "Research Associate - Bioinformatics",
        "Technical Product Manager",
        "Technical Delivery Lead",
        "ML Platform Engineer",
        "Staff Data Engineer",
      ];

      for (const title of technicalTitles) {
        expect(isTechnicalRole(title, "").isTechnical, `Expected isTechnicalRole to be true for: ${title}`).toBe(true);
      }
    });

    it("rejects purely non-technical roles", () => {
      const nonTechnicalTitles = [
        "Marketing Manager",
        "Human Resources Business Partner",
        "Account Executive",
        "Office Administrator",
        "Legal Counsel (Commercial Contracts)",
      ];

      for (const title of nonTechnicalTitles) {
        expect(isTechnicalRole(title, "").isTechnical, `Expected isTechnicalRole to be false for: ${title}`).toBe(false);
      }
    });
  });

  describe("isConsultancyRole", () => {
    it("does NOT classify pure technical software/data architecture roles as disqualifying consultancy", () => {
      const technicalRoles = [
        { title: "Solutions Architect", description: "Design cloud microservices and distributed data pipelines" },
        { title: "Technical Consultant", description: "Build ETL pipelines with Python, Spark, and Postgres" },
        { title: "AI Legal Solutions Consultant", description: "Integrate LLM search APIs with document workflows" },
      ];

      for (const role of technicalRoles) {
        expect(isConsultancyRole(role.title, role.description)).toBe(false);
      }
    });

    it("classifies pure advisory management consulting as consultancy", () => {
      const advisoryRoles = [
        {
          title: "Strategy & Management Consultant",
          description: "Deliver slide decks to C-suite clients on change management and organizational design",
        },
        {
          title: "Advisory Consultant",
          description: "Provide client advisory services on market entry and corporate strategy",
        },
      ];

      for (const role of advisoryRoles) {
        expect(isConsultancyRole(role.title, role.description)).toBe(true);
      }
    });
  });
});
