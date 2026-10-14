import { describe, it, expect } from "vitest";
import { containsConcept, loadLanesConfig } from "../../pipeline/laneRouter.js";

describe("Lane Concept Extraction Across Six Dynamic Lanes", () => {
  const lanesConfig = loadLanesConfig();
  const lanes = lanesConfig.lanes;

  it("loads all configured dynamic lanes", () => {
    const laneKeys = Object.keys(lanes);
    expect(laneKeys).toContain("CORE_AI_DATA");
    expect(laneKeys).toContain("LEGAL_REGTECH");
    expect(laneKeys).toContain("HEALTH_BIO_PHARMA");
    expect(laneKeys).toContain("INVESTMENT_MARKETS_FINTECH");
    expect(laneKeys).toContain("SOCIAL_IMPACT_MULTILATERAL");
    expect(laneKeys).toContain("UNIVERSITY_AI_RESEARCH");
  });

  describe("Modern Software Engineering & Platform Concepts", () => {
    it("extracts SOFTWARE_ENGINEERING from varied engineering titles and descriptions", () => {
      const texts = [
        "Senior Software Engineer building microservices with TypeScript and Go",
        "Staff Backend Engineer architecting distributed API gateways",
        "Full-stack Developer working with React and Python Postgres",
        "Systems Engineer focusing on high-throughput backend services",
      ];

      for (const text of texts) {
        expect(containsConcept(text, "SOFTWARE_ENGINEERING"), `Failed for: ${text}`).toBe(true);
      }
    });

    it("extracts PLATFORM_ENGINEERING from cloud and infrastructure descriptions", () => {
      const texts = [
        "Platform Engineer maintaining Kubernetes clusters and Terraform infrastructure",
        "Cloud Infrastructure Lead scaling AWS ECS microservices",
        "DevOps Engineer automating CI/CD pipelines and Helm deployments",
        "Site Reliability Engineer monitoring distributed systems observability",
      ];

      for (const text of texts) {
        expect(containsConcept(text, "PLATFORM_ENGINEERING"), `Failed for: ${text}`).toBe(true);
      }
    });
  });

  describe("Core AI Data Lane", () => {
    const lane = lanes.CORE_AI_DATA;

    it("requires accepted function concepts present in YAML", () => {
      const functions = lane.required_function_concepts || [];
      expect(functions).toContain("software engineering");
      expect(functions).toContain("platform engineering");
      expect(functions).toContain("ai engineering");
      expect(functions).toContain("data engineering");
    });

    it("matches AI and data platform engineering roles", () => {
      const text = "AI Platform Engineer designing LLM inference serving infrastructure with PyTorch and vLLM";
      expect(containsConcept(text, "AI_ENGINEERING")).toBe(true);
      expect(containsConcept(text, "LLM_INFRASTRUCTURE")).toBe(true);
    });
  });

  describe("Legal & RegTech Lane", () => {
    const lane = lanes.LEGAL_REGTECH;

    it("requires accepted function concepts present in YAML", () => {
      const functions = lane.required_function_concepts || [];
      expect(functions).toContain("software engineering");
      expect(functions).toContain("data engineering");
      expect(functions).toContain("platform engineering");
    });

    it("extracts legal and compliance concepts", () => {
      const text = "Building contract intelligence workflows with document extraction and automated regulatory compliance";
      expect(containsConcept(text, "LEGAL_AI")).toBe(true);
      expect(containsConcept(text, "COMPLIANCE_AUTOMATION")).toBe(true);
    });
  });

  describe("Health & Bio Pharma Lane", () => {
    const lane = lanes.HEALTH_BIO_PHARMA;

    it("requires accepted function concepts present in YAML", () => {
      const functions = lane.required_function_concepts || [];
      expect(functions).toContain("software engineering");
      expect(functions).toContain("platform engineering");
    });

    it("extracts bioinformatics and clinical informatics concepts", () => {
      const text = "Senior Bioinformatician analyzing whole genome sequencing data and clinical informatics pipelines";
      expect(containsConcept(text, "BIOINFORMATICS")).toBe(true);
      expect(containsConcept(text, "CLINICAL_INFORMATICS")).toBe(true);
    });
  });

  describe("Investment Markets & Fintech Lane", () => {
    const lane = lanes.INVESTMENT_MARKETS_FINTECH;

    it("requires accepted function concepts present in YAML", () => {
      const functions = lane.required_function_concepts || [];
      expect(functions).toContain("software engineering");
      expect(functions).toContain("platform engineering");
      expect(functions).toContain("quantitative research");
    });

    it("extracts quantitative finance concepts", () => {
      const text = "Quantitative Developer building market data feeds and algorithmic trading execution systems";
      expect(containsConcept(text, "QUANTITATIVE_RESEARCH")).toBe(true);
      expect(containsConcept(text, "CAPITAL_MARKETS")).toBe(true);
    });
  });

  describe("University AI Research Lane", () => {
    const lane = lanes.UNIVERSITY_AI_RESEARCH;

    it("requires accepted function concepts present in YAML", () => {
      const functions = lane.required_function_concepts || [];
      expect(functions).toContain("software engineering");
      expect(functions).toContain("platform engineering");
      expect(functions).toContain("ai research");
    });

    it("extracts university and research concepts", () => {
      const text = "Research Scientist conducting machine learning research at the university AI laboratory";
      expect(containsConcept(text, "AI_RESEARCH")).toBe(true);
      expect(containsConcept(text, "ACADEMIC_RESEARCH")).toBe(true);
    });
  });
});
