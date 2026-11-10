import { describe, it, expect } from "vitest";
import { applyGlobalGates, isTechnicalRole, evaluateWorkability } from "../../services/criteria.js";
import { loadWorkabilityPolicy, mergeWorkabilityPreferenceContent } from "../../pipeline/workabilityPolicy.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURE_PATH = path.resolve(__dirname, "../../../fixtures/anonymized_nine_emails.json");

type GateStatus = "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";

interface NineEmailFixture {
  readonly id: string;
  readonly subject: string;
  readonly raw_html?: string;
  readonly location_raw: string;
  readonly workplace_type_raw: string;
  readonly employment_type_raw: string;
  readonly expected_gate: GateStatus;
  readonly expected_rejection_codes?: readonly string[];
}

// The fixture is the deterministic external-data boundary for these tests.
const fixtureEmails = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8")) as NineEmailFixture[];

describe("Criteria Hard Gates & Workability Unit Tests", () => {
  describe("Nine Email Fixture Deterministic Classification", () => {
    it("classifies all 9 email fixtures accurately according to expected gate statuses", () => {
      const results = fixtureEmails.map((email) => {
        const company = email.subject.split(" at ")[1] || "Unknown Corp";
        const title = email.subject.replace("Job Alert: ", "").replace("REPOST - ", "").split(" at ")[0] || "Unknown Title";

        const job = {
          id: email.id,
          title,
          company_name: company,
          raw_description: email.raw_html || email.subject,
          location: email.location_raw,
          workplace_type: email.workplace_type_raw,
          employment_type: email.employment_type_raw,
        };

        const gateResult = applyGlobalGates(job as any);
        return {
          id: email.id,
          title,
          status: gateResult.status,
          expected: email.expected_gate,
          rejectionCodes: gateResult.rejection_codes,
          expectedRejectionCodes: email.expected_rejection_codes ?? [],
        };
      });

      const passCount = results.filter(r => r.status === "PASS").length;
      const rejectCount = results.filter(r => r.status === "HARD_REJECT").length;
      const verifyCount = results.filter(r => r.status === "NEEDS_VERIFICATION").length;

      expect(rejectCount).toBe(2);
      expect(verifyCount).toBe(1);
      expect(passCount).toBe(6); // 6 eligible observations; fixtures 001 and 009 are one reposted job.

      for (const res of results) {
        expect(res.status).toBe(res.expected);
        if (res.expected === "HARD_REJECT" || res.expected === "NEEDS_VERIFICATION") {
          expect(res.rejectionCodes).toEqual(expect.arrayContaining(Array.from(res.expectedRejectionCodes)));
        }
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

    it("does not treat investment management context alone as a target technical domain", () => {
      const result = applyGlobalGates({
        id: "investment-interconnection-manager",
        title: "Interconnection Execution Manager",
        company_name: "Investment Systems Co",
        raw_description: "Manage interconnection execution and coordinate handoffs for investment management clients.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
    });

    it("rejects technical roles outside the target domains at Axis 2", () => {
      const result = applyGlobalGates({
        id: "network-engineer-out-of-domain",
        title: "Network Engineer",
        company_name: "Telecom Systems Co",
        raw_description: "Configure enterprise routing, switching, firewalls, and network operations.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(isTechnicalRole("Network Engineer", "Configure enterprise routing, switching, firewalls, and network operations.").isTechnical).toBe(true);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_NOT_AI_DATA");
    });

    it("does not let the Technical Product Manager title override Axis 2", () => {
      const description = "Own product roadmaps, stakeholder alignment, and delivery planning for enterprise software.";
      const result = applyGlobalGates({
        id: "technical-product-manager-out-of-domain",
        title: "Technical Product Manager",
        company_name: "Enterprise Software Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(isTechnicalRole("Technical Product Manager", description).isTechnical).toBe(true);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_NOT_AI_DATA");
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

    it("allows a direct-employer fixed-term contract such as the MAS data architect role", () => {
      const job = {
        id: "mas-investment-data-architect-contract",
        title: "Lead Data Architect (Investment Management) (Contract)",
        company_name: "Monetary Authority of Singapore",
        raw_description: "The Monetary Authority of Singapore is hiring directly for a fixed-term staff appointment. Lead data architecture for investment management, including data models, governance, lineage, and platforms.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "CONTRACT"
      };
      const result = applyGlobalGates(job as any);
      expect(result.status).toBe("PASS");
    });

    it("rejects a contract placed with a third-party client by an employment agency", () => {
      const job = {
        id: "agency-client-data-architect-contract",
        title: "Lead Data Architect (12-month contract)",
        company_name: "Randstad",
        raw_description: "Randstad is hiring on behalf of our client, a Singapore investment firm, for a 12-month contract role. Design and govern data architecture, models, and lineage.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "CONTRACT",
      };

      const result = applyGlobalGates(job as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_CONTRACT_ROLE");
      expect(result.evidence_quotes.join(" ")).toContain("on behalf of our client");
    });

    it("rejects agency contract placements even when the client relationship is unstated", () => {
      const result = applyGlobalGates({
        id: "agency-company-no-placement-evidence",
        title: "Lead Data Architect (12-month contract)",
        company_name: "Randstad",
        raw_description: "Design and govern the data platform, models, and lineage for internal operations.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "CONTRACT",
      } as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_CONTRACT_ROLE");
    });

    it("allows direct fixed-term employment despite a legacy contract preference", () => {
      const job = {
        id: "contract-job-policy-disabled",
        title: "Lead Data Architect",
        company_name: "Data Systems Co",
        raw_description: "Design data architecture and implement governed data platforms.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "CONTRACT",
      };
      const restrictivePolicy = { ...loadWorkabilityPolicy(), contractAllowed: false };
      const result = applyGlobalGates(job as any, restrictivePolicy);

      expect(result.status).toBe("PASS");
      expect(result.rejection_codes).not.toContain("GATE_CONTRACT_ROLE");
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

    it("requires verification for an unknown workplace arrangement rather than assuming hybrid", () => {
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
      expect(result.rejection_codes).toContain("GATE_UNKNOWN_WORK_MODE");
    });

    it("evaluates explicit worker-country alternatives as a set and ignores employer headquarters", () => {
      const authorizedAlternative = evaluateWorkability(
        "Remote",
        "REMOTE",
        "Must be authorized to work in Singapore or Australia.",
        "PERMANENT",
        loadWorkabilityPolicy(),
      );
      const usaOnly = evaluateWorkability(
        "Remote",
        "REMOTE",
        "Must be authorized to work in the United States.",
        "PERMANENT",
        loadWorkabilityPolicy(),
      );
      const employerHeadquartersOnly = evaluateWorkability(
        "Remote",
        "REMOTE",
        "Fully remote role. The company is headquartered in California.",
        "PERMANENT",
        loadWorkabilityPolicy(),
      );

      const gate = (description: string) => applyGlobalGates({
        id: "country-condition-test",
        title: "Senior AI Engineer",
        company_name: "Test Systems",
        raw_description: description,
        location: "Remote",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      const alternativeGate = gate("Build deep learning models. Candidates must be authorized to work in Singapore or Australia.");
      const separateMandatoryGate = gate("Build deep learning models. Must reside in the United States. Must be authorized to work in Singapore.");
      const abbreviatedGate = gate("Build deep learning models. Must reside in the U.S.");
      const citizenshipGate = gate("Build deep learning models. U.S. citizenship is required.");
      const ambiguousGate = gate("Build deep learning models. Candidates must be authorized to work in Singapore, Australia.");

      expect(authorizedAlternative.workable).toBe(true);
      expect(usaOnly.reasonCode).toBe("WORK_AUTHORIZATION_INCOMPATIBLE");
      expect(employerHeadquartersOnly.workable).toBe(true);
      expect(alternativeGate.status).toBe("PASS");
      expect(separateMandatoryGate.rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
      expect(abbreviatedGate.rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
      expect(citizenshipGate.rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
      expect(ambiguousGate.status).toBe("NEEDS_VERIFICATION");
    });

    it("retains a positive travel requirement after a negated clause and applies the numeric cap", () => {
      const result = applyGlobalGates({
        id: "mixed-travel-test",
        title: "Senior AI Engineer",
        company_name: "Test Systems",
        raw_description: "Build deep learning models. No regular travel is required, but 30% travel is required for client deployments.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      const minimalTravelJob = {
        id: "minimal-travel-test",
        title: "Senior AI Engineer",
        company_name: "Test Systems",
        raw_description: "Build deep learning models. Minimal travel is required.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      };
      const minimalTravel = applyGlobalGates(minimalTravelJob as any);
      const unacceptedMinimalTravel = applyGlobalGates(
        minimalTravelJob as any,
        { ...loadWorkabilityPolicy(), minimalTravelAllowed: false },
      );

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
      expect(result.evidence_quotes.join(" ")).toContain("30% travel");
      expect(minimalTravel.status).toBe("PASS");
      expect(unacceptedMinimalTravel.status).toBe("NEEDS_VERIFICATION");
    });

    it("does not let an assumed or explicit hybrid mode override a remote-only preference", () => {
      const remoteOnlyPolicy = mergeWorkabilityPreferenceContent(loadWorkabilityPolicy(), {
        hard_constraints: { work_modes: ["REMOTE"], max_office_days_per_week: 0 },
      });
      const assumed = evaluateWorkability(
        "Singapore",
        "ASSUMED_HYBRID",
        "Flexible workplace arrangement.",
        "PERMANENT",
        remoteOnlyPolicy,
      );
      const explicitHybrid = evaluateWorkability(
        "Singapore",
        "HYBRID",
        "Two days per week in the office.",
        "PERMANENT",
        remoteOnlyPolicy,
      );

      expect(assumed.workable).toBe(true);
      expect(assumed.needsVerify).toBe(true);
      expect(assumed.reasonCode).toBe("GATE_UNKNOWN_WORK_MODE");
      expect(explicitHybrid.workable).toBe(false);
      expect(explicitHybrid.reasonCode).toBe("GATE_HIGH_OFFICE_DAYS");
    });

    it.each([
      "PASS",
      "NEEDS_VERIFICATION",
      "HARD_REJECT",
    ] as const)("does not turn unknown work mode into a pass or rejection when legacy policy says %s", (disposition) => {
      const result = evaluateWorkability(
        "Singapore",
        "UNKNOWN",
        "Build deep learning models.",
        "PERMANENT",
        { ...loadWorkabilityPolicy(), unknownWorkModeDisposition: disposition },
      );
      expect(result.workable).toBe(true);
      expect(result.needsVerify).toBe(true);
      expect(result.reasonCode).toBe("GATE_UNKNOWN_WORK_MODE");
    });
  });

  describe("target data ownership and domain evidence", () => {
    const cases = [
      ["Data Governance Lead", "Own data lineage, quality controls, and metadata standards for investment management."],
      ["Reference Data Manager", "Design reference data models and implement data quality controls for investment products."],
      ["Master Data Architect", "Own the master data platform architecture and data-model lifecycle."],
      ["Knowledge Graph Specialist", "Design and implement knowledge graph schemas and ontologies for market data."],
      ["Data Product Owner", "Own the data product roadmap, data contracts, platform architecture, and quality controls."],
      ["SVP - Lead Technical Product Owner (Corporate/Data Domain)", "Own data contracts, data models, and data quality controls for investment products."],
    ] as const;

    it.each(cases)("accepts technical ownership evidence for %s", (title, description) => {
      const result = applyGlobalGates({
        id: "target-data-role",
        title,
        company_name: "Investment Data Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      expect(isTechnicalRole(title, description).isTechnical).toBe(true);
      expect(result.status).toBe("PASS");
    });

    it("does not admit a data-product owner without technical ownership evidence", () => {
      const title = "Data Product Owner";
      const description = "Coordinate customer feedback, feature prioritization, release schedules, and stakeholder updates.";
      const result = applyGlobalGates({
        id: "generic-data-product-owner",
        title,
        company_name: "Generic Products Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      expect(isTechnicalRole(title, description).isTechnical).toBe(false);
      expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
    });

    it("does not treat a data-governance leadership title alone as technical ownership evidence", () => {
      const title = "Data Governance Manager";
      const description = "Coordinate governance policy committees, privacy training, and stakeholder reporting.";
      const result = applyGlobalGates({
        id: "data-governance-manager-no-technical-duties",
        title,
        company_name: "Generic Governance Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(isTechnicalRole(title, description).isTechnical).toBe(false);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
    });

    it("does not count negated data-ownership statements as technical evidence", () => {
      const title = "Data Governance Manager";
      const description = "We are hiring a Data Governance Manager. You will not be responsible for data quality or own data lineage; coordinate governance committees and stakeholder reporting.";
      const result = applyGlobalGates({
        id: "data-governance-negated-ownership",
        title,
        company_name: "Generic Governance Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(isTechnicalRole(title, description).isTechnical).toBe(false);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
    });

    it("admits the reviewed GenAI product-manager role, but not a generic product manager", () => {
      const genAiRole = applyGlobalGates({
        id: "genai-product-manager",
        title: "Senior Product Manager - GenAI",
        company_name: "AI Systems Co",
        raw_description: "Experiment with emerging models and APIs, prototype GenAI workflows, and partner with Engineering on model performance, reliability, scale, and cost.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      const strategyOnlyGenAiRole = applyGlobalGates({
        id: "genai-product-manager-strategy-only",
        title: "Senior Product Manager - GenAI",
        company_name: "AI Systems Co",
        raw_description: "Lead product management for generative AI systems and LLM workflows. Own customer research, roadmap prioritization, launch plans, and stakeholder updates.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      const adoptionOnlyGenAiRole = applyGlobalGates({
        id: "genai-product-manager-adoption-only",
        title: "Senior Product Manager - GenAI",
        company_name: "AI Systems Co",
        raw_description: "Partner with stakeholders to scale generative AI adoption. Own customer research, roadmap prioritization, and launch plans.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      const negatedTechnicalGenAiRole = applyGlobalGates({
        id: "genai-product-manager-negated-technical-duties",
        title: "Senior Product Manager - GenAI",
        company_name: "AI Systems Co",
        raw_description: "You will not build models or deploy APIs; instead, own roadmap, customer research, and launch strategy.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      const genericRole = applyGlobalGates({
        id: "generic-product-manager",
        title: "Senior Product Manager",
        company_name: "Consumer Products Co",
        raw_description: "Own customer research, roadmap prioritization, and stakeholder updates.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(genAiRole.status).toBe("PASS");
      expect(strategyOnlyGenAiRole.status).toBe("HARD_REJECT");
      expect(strategyOnlyGenAiRole.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
      expect(adoptionOnlyGenAiRole.status).toBe("HARD_REJECT");
      expect(adoptionOnlyGenAiRole.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
      expect(negatedTechnicalGenAiRole.status).toBe("HARD_REJECT");
      expect(negatedTechnicalGenAiRole.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
      expect(genericRole.status).toBe("HARD_REJECT");
      expect(genericRole.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
    });

    it.each([
      "Assess customer demand for generative AI, market positioning, and launch strategy.",
      "Research the market for machine learning products and define the product roadmap.",
    ])("rejects strategy-only product work despite AI market language: %s", (description) => {
      const title = "Senior Product Manager - GenAI";
      const result = applyGlobalGates({
        id: "genai-product-manager-market-research-only",
        title,
        company_name: "AI Systems Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(isTechnicalRole(title, description).isTechnical).toBe(false);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
    });

    it.each(["AI Product Manager", "AI Product Owner"])("does not treat the %s title alone as technical evidence", (title) => {
      const description = `${title}. Own customer research, roadmap prioritization, launch plans, and stakeholder updates.`;
      const result = applyGlobalGates({
        id: "ai-product-leadership-no-technical-duties",
        title,
        company_name: "AI Systems Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(isTechnicalRole(title, description).isTechnical).toBe(false);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
    });

    it("requires technical ownership evidence for a product owner in a data domain", () => {
      const title = "SVP - Lead Technical Product Owner (Corporate/Data Domain)";
      const description = "Coordinate stakeholder priorities and release schedules across the corporate product portfolio.";
      expect(isTechnicalRole(title, description).isTechnical).toBe(false);
    });

    it("does not use data-asset ownership wording alone to make an unrelated manager a technical role", () => {
      expect(isTechnicalRole(
        "Interconnection Execution Manager",
        "Manage and govern market data quality controls for investment management clients.",
      ).isTechnical).toBe(false);
    });

    it("does not reject a technical target role only because the employer is a consulting firm", () => {
      const result = applyGlobalGates({
        id: "consulting-data-architect",
        title: "BCG Platinion Lead/Principal Architect - Data & AI",
        company_name: "Boston Consulting Group",
        raw_description: "Design and deliver data platforms and AI architectures for investment management clients.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      expect(result.status).toBe("PASS");
      expect(result.rejection_codes).not.toContain("GATE_CONSULTING_FIRM");
    });

    it("allows technical pre-sales with stated interaction below the relaxed 60% cap", () => {
      const result = applyGlobalGates({
        id: "technical-presales-architect",
        title: "Applied AI Architect",
        company_name: "Anthropic",
        raw_description: "Pre-sales architect designing and deploying LLM solutions for public sector customers. Stakeholder interaction is 55%.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      expect(result.status).toBe("PASS");
    });

    it("allows the reviewed technical pre-sales architect when the posting omits an interaction share", () => {
      const result = applyGlobalGates({
        id: "technical-presales-architect-no-interaction-share",
        title: "Applied AI Architect",
        company_name: "Anthropic",
        raw_description: "Pre-sales architect designing and deploying LLM solutions for public sector customers.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("PASS");
      expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    });

    it("allows the reviewed GovTech architect based on explicit LLM architecture and integration duties", () => {
      const result = applyGlobalGates({
        id: "reviewed-govtech-applied-ai-architect",
        title: "Applied AI Architect, Public Sector",
        company_name: "Anthropic",
        raw_description: "As a Pre-Sales architect, help customers integrate and deploy Claude into their technology stack. Architect innovative LLM solutions that address complex mission challenges. Guide technical architecture decisions and help customers integrate Claude into their existing technology stack.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("PASS");
      expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    });

    it("keeps a pre-sales engineer out when the title is not an owner-approved target architecture role", () => {
      const result = applyGlobalGates({
        id: "presales-engineer",
        title: "Senior Partner Engineer",
        company_name: "AI Systems Co",
        raw_description: "Pre-sales partner engineer for LLM deployments with continuous client relationship management.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    });

    it("does not exempt a title-only AI architect selling licenses from the client-facing gate", () => {
      const result = applyGlobalGates({
        id: "license-sales-ai-architect",
        title: "AI Pre-Sales Architect",
        company_name: "AI Systems Co",
        raw_description: "Pre-sales AI architect selling product licenses. Present product demos and manage customer relationships; no solution design or deployment work.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    });

    it.each([
      "Pre-sales AI architect. Evaluate customer business models and adoption strategy. Manage customer relationships.",
      "Pre-sales AI architect. Evaluate software business models and adoption strategy. Manage customer relationships.",
      "Pre-sales AI architect. Evaluate the market for AI systems and compare API options for customer adoption. Manage customer relationships.",
      "Pre-sales AI architect. Design a go-to-market strategy for AI systems. Manage customer relationships.",
      "Pre-sales AI architect. Build a customer adoption strategy for AI systems. Manage customer relationships.",
      "Pre-sales AI architect. Build a market strategy for AI systems. Manage customer relationships.",
      "Pre-sales AI architect. Develop a customer adoption roadmap for AI systems. Manage customer relationships.",
      "Pre-sales AI architect. Build a customer adoption strategy for AI systems and implement customer onboarding campaigns. Manage customer relationships.",
      "Pre-sales AI architect. Build adoption strategy for AI systems and test market messaging. Manage customer relationships.",
      "Pre-sales AI architect. Build adoption programs for AI systems and manage customer relationships.",
      "Pre-sales AI architect. Build customer enablement for AI systems and manage customer relationships.",
      "Pre-sales AI architect. Build AI systems onboarding materials for customers and manage relationships.",
      "Pre-sales AI architect. Build AI systems training materials for customers and manage relationships.",
      "Pre-sales AI architect. Build AI systems training programs for customers and manage relationships.",
      "Pre-sales AI architect. Build AI systems education content for customers and manage relationships.",
      "Pre-sales AI architect. Deliver technical training for AI systems to customers and manage customer relationships.",
      "Pre-sales AI architect. Provide AI systems training to users and manage customer relationships.",
      "Pre-sales AI architect. Design an LLM training curriculum for customers and manage customer relationships.",
      "Pre-sales AI architect. Create AI courses for customers and manage customer relationships.",
      "Pre-sales AI architect. Deliver LLM product demonstrations to prospective customers and manage relationships.",
      "Pre-sales AI architect. Conduct technical workshops about LLM solutions for customers and manage relationships.",
      "Pre-sales AI architect. Design LLM demonstration scripts and presentation materials for prospective customers.",
      "Pre-sales AI architect. Design LLM sales presentations for enterprise customers and manage relationships.",
      "Pre-sales AI architect. Develop LLM customer case studies for sales prospects and manage relationships.",
      "Pre-sales AI architect. Develop LLM value propositions for enterprise buyers and manage customer relationships.",
      "Pre-sales AI architect. Develop LLM pitch materials for enterprise customers and manage relationships.",
      "Pre-sales AI architect. Develop LLM product FAQs for customers and manage relationships.",
      "Pre-sales AI architect. Develop LLM sales brochures for enterprise prospects and manage relationships.",
      "Pre-sales AI architect. Develop LLM ROI analyses for prospective customers and manage relationships.",
      "Pre-sales AI architect. Develop an LLM customer adoption framework for enterprise clients and manage relationships.",
      "Pre-sales AI architect. Develop an LLM adoption architecture for enterprise customers and manage customer relationships.",
      "Pre-sales AI architect. Develop LLM business models for enterprise customers and manage customer relationships.",
      "Pre-sales AI architect. Develop LLM pricing models for enterprise customers and manage customer relationships.",
      "Pre-sales AI architect. Develop LLM licensing models for enterprise customers and manage customer relationships.",
      "Pre-sales AI architect. Develop LLM unit economics for enterprise offerings and manage customer relationships.",
    ])("does not exempt an AI architect whose only model reference is commercial: %s", (description) => {
      const result = applyGlobalGates({
        id: "commercial-models-ai-presales-architect",
        title: "AI Pre-Sales Architect",
        company_name: "AI Systems Co",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    });

    it("rejects target roles only when stated interaction exceeds the relaxed 60% cap", () => {
      const result = applyGlobalGates({
        id: "high-interaction-architect",
        title: "Applied AI Architect",
        company_name: "Anthropic",
        raw_description: "Design LLM solutions for public sector customers. Stakeholder interaction is 60.1%.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    });

    it.each([
      "Pre-sales architect designing and deploying LLM solutions. 70% of the role is customer-facing.",
      "Pre-sales architect designing and deploying LLM solutions. Customer interaction is 70%.",
    ])("recognizes explicit customer interaction above the cap: %s", (description) => {
      const result = applyGlobalGates({
        id: "high-customer-interaction-architect",
        title: "Applied AI Architect",
        company_name: "Anthropic",
        raw_description: description,
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    });

    it("uses the maximum when a posting states multiple interaction shares", () => {
      const result = applyGlobalGates({
        id: "multiple-interaction-shares",
        title: "Applied AI Architect",
        company_name: "Anthropic",
        raw_description: "Pre-sales architect designing and deploying LLM solutions. Stakeholder interaction is 55%. Client-facing work is 70%.",
        location: "Singapore",
        workplace_type: "REMOTE",
        employment_type: "PERMANENT",
      } as any);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    });
  });
  describe("office location with an unrecognised country", () => {
    const job = (location: string, workplaceType: string) => ({
      id: `office-${workplaceType}-${location}`,
      title: "Senior AI Platform Architect",
      company_name: "Example AI",
      raw_description: "Design and build machine learning platforms and AI agent infrastructure with Python and Kubernetes.",
      location,
      workplace_type: workplaceType,
      employment_type: "PERMANENT",
    });

    it("sends a hybrid or on-site role in an unrecognised city to verification", () => {
      for (const workplaceType of ["HYBRID", "ONSITE"]) {
        const result = applyGlobalGates(job("Exampleville", workplaceType) as any);
        expect(result.status, workplaceType).not.toBe("PASS");
      }
      expect(applyGlobalGates(job("Exampleville", "HYBRID") as any).status).toBe("NEEDS_VERIFICATION");
    });

    it("keeps a recognised country deciding the hybrid outcome", () => {
      expect(applyGlobalGates(job("Singapore", "HYBRID") as any).status).toBe("PASS");
      expect(applyGlobalGates(job("San Mateo, California, United States", "HYBRID") as any).rejection_codes).toContain("WORK_AUTHORIZATION_INCOMPATIBLE");
    });

    it("still passes a remote role with no stated country", () => {
      expect(applyGlobalGates(job("Remote", "REMOTE") as any).status).toBe("PASS");
    });
  });
});
