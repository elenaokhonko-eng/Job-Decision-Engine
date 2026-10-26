import { describe, it, expect, vi } from "vitest";
import { applyGlobalGates, evaluateWorkability } from "../../services/criteria.js";
import { containsConcept, hasApprovedLaneFunction, hasCoreTechnicalFunction, hasRequiredInstitutionalContext, loadLanesConfig } from "../../pipeline/laneRouter.js";
import { loadWorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";

describe("CareerDecisionEngine V4.2 Calibration & Funnel Tests", () => {
  const policy = loadWorkabilityPolicy();

  describe("Part B: Intern Token Matching Guard", () => {
    it("does not reject roles containing internal or international in title", () => {
      const allowedTitles = [
        "Senior Full-Stack Engineer, Internal Applications",
        "Staff Decision Scientist (International)",
        "Senior Internal Audit Analyst",
        "International Data Acquisition Manager",
        "Engineering Manager - Internal Tools",
      ];

      for (const title of allowedTitles) {
        const result = applyGlobalGates({
          id: "test-intern-job",
          title,
          company_name: "Tech Corp",
          location: "Singapore",
          workplace_type: "REMOTE",
          raw_description: "Build internal data systems and international APIs using Python.",
        } as any, policy);

        expect(
          result.rejection_codes,
          `Title should not be rejected for GATE_EXPERIENCE_TOO_LOW: ${title}`
        ).not.toContain("GATE_EXPERIENCE_TOO_LOW");
      }
    });

    it("rejects actual junior and internship roles", () => {
      const juniorTitles = [
        "Software Engineer Intern",
        "Machine Learning Internship (Summer 2027)",
        "Graduate Trainee - Data Engineering",
        "AI Engineering Apprentice",
        "Junior Developer Apprenticeship",
      ];

      for (const title of juniorTitles) {
        const result = applyGlobalGates({
          id: "test-intern-job",
          title,
          company_name: "Tech Corp",
          location: "Singapore",
          workplace_type: "REMOTE",
          raw_description: "Internship program for university students.",
        } as any, policy);

        expect(result.status).toBe("HARD_REJECT");
        expect(result.rejection_codes).toContain("GATE_EXPERIENCE_TOO_LOW");
      }
    });
  });

  describe("Part C: FDE Role Identity vs Description Mention", () => {
    it("rejects roles when the title is an FDE-family role", () => {
      const fdeTitles = [
        "Forward Deployed Engineer",
        "Forward Deployed Software Engineer",
        "Forward Deployed Engineering Lead",
        "AI FDE",
        "Engineering Manager, FDE Infrastructure",
      ];

      for (const title of fdeTitles) {
        const result = applyGlobalGates({
          id: "test-fde-job",
          title,
          company_name: "Enterprise AI",
          location: "Singapore",
          workplace_type: "REMOTE",
          raw_description: "Build client deployments on-site.",
        } as any, policy);

        expect(result.status).toBe("HARD_REJECT");
        expect(result.rejection_codes).toContain("GATE_OUT_OF_SCOPE_DOMAIN");
      }
    });

    it("does NOT reject when FDE is merely an adjacent team or previous background", () => {
      const nonFdeRoles = [
        {
          title: "Applied AI Engineer",
          description: "Build core LLM models. You will collaborate closely with our Forward Deployed Engineers and customer success teams.",
        },
        {
          title: "Applied AI Architect",
          description: "Design cloud data pipelines. Previous experience as an FDE or solutions architect is a plus.",
        },
        {
          title: "Technical Deployment Lead",
          description: "Lead enterprise deployment roadmaps. Work alongside FDEs and engineering directors.",
        },
      ];

      for (const role of nonFdeRoles) {
        const result = applyGlobalGates({
          id: "test-non-fde-job",
          title: role.title,
          company_name: "Tech Corp",
          location: "Singapore",
          workplace_type: "REMOTE",
          raw_description: role.description,
        } as any, policy);

        expect(result.status).toBe("PASS");
        expect(result.rejection_codes).not.toContain("GATE_OUT_OF_SCOPE_DOMAIN");
      }
    });
  });

  describe("Part M: Prospective On-Call vs Retrospective Incident Mentions", () => {
    it("rejects active prospective regular on-call obligations", () => {
      const result = applyGlobalGates({
        id: "test-oncall-job",
        title: "Senior Platform Engineer",
        company_name: "Tech Corp",
        location: "Singapore",
        workplace_type: "REMOTE",
        raw_description: "Participate in a weekly on-call rotation for production systems. 24/7 support readiness required.",
      } as any, policy);

      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
    });

    it("does NOT reject retrospective on-call experience or incident management", () => {
      const result = applyGlobalGates({
        id: "test-oncall-job",
        title: "Senior Platform Engineer",
        company_name: "Tech Corp",
        location: "Singapore",
        workplace_type: "REMOTE",
        raw_description: "Builds distributed AI data pipelines with Python. Prior experience with incident management and leadership through production incidents. Has been on-call previously in prior roles.",
      } as any, policy);

      expect(result.status).toBe("PASS");
      expect(result.rejection_codes).not.toContain("GATE_LIFESTYLE_INCOMPATIBLE");
    });
  });

  describe("Part J: Singapore Unknown Work Mode Assumption", () => {
    it("applies ASSUMED_HYBRID_3_2 for Singapore roles with unknown workplace mode after enrichment", async () => {
      const { enrichWorkModeIfNeeded } = await import("../../services/workModeEnrichment.js");
      const mockPool: any = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("FROM work_mode_enrichments")) return { rows: [] };
          if (sql.includes("FROM raw_job_observations")) return { rows: [] };
          return { rows: [] };
        }),
      };
      const context = { workspaceId: "ws-test", workspaceKey: "default", userId: "u1", userKey: "k1", role: "OWNER" };
      const enriched = await enrichWorkModeIfNeeded(mockPool, context as any, {
        canonical_job_id: "job-sg-1",
        job_version_id: "jv-sg-1",
        location: "Singapore",
        workplace_type: "UNKNOWN",
        description_text: "We are looking for an AI Engineer based in our Singapore office. Flexible workplace arrangement.",
      });

      expect(enriched.workplace_type).toBe("ASSUMED_HYBRID");
      expect(enriched.office_days_min).toBe(3);
      expect(enriched.office_days_max).toBe(3);
      expect(enriched.attendance_basis).toBe("OWNER_POLICY_DEFAULT_SG_UNKNOWN_WORK_MODE");

      const workability = evaluateWorkability(
        "Singapore",
        enriched.workplace_type,
        "We are looking for an AI Engineer based in our Singapore office. Flexible workplace arrangement.",
        "FULL_TIME",
        policy
      );

      expect(workability.workable).toBe(false);
      expect(workability.reasonCode).toBe("GATE_UNKNOWN_WORK_MODE");
      expect(workability.facts?.workplace_type).toBeUndefined();
    });

    it("rejects foreign roles when work mode is unknown", () => {
      const workability = evaluateWorkability(
        "Unknown",
        "UNKNOWN",
        "Software engineer role. Flexible workplace arrangement.",
        "FULL_TIME",
        policy
      );

      expect(workability.workable).toBe(false);
      expect(workability.reasonCode).toBe("GATE_UNKNOWN_WORK_MODE");
    });

    it("rejects Singapore roles that explicitly require 5 days on-site", () => {
      const workability = evaluateWorkability(
        "Singapore",
        "UNKNOWN",
        "This role requires 5 days on-site at our laboratory in Singapore.",
        "FULL_TIME",
        policy
      );

      expect(workability.workable).toBe(false);
      expect(workability.reasonCode).toBe("GATE_HIGH_OFFICE_DAYS");
    });
  });

  describe("Part G & H: Lane Context Predicates", () => {
    const lanes = loadLanesConfig().lanes;

    it("University lane requires formal institutional context", () => {
      const universityLane = lanes.UNIVERSITY_AI_RESEARCH;
      const domainConcepts = universityLane.included_domain_concepts || [];

      expect(domainConcepts).toContain("university");
      expect(domainConcepts).toContain("academic research");
      expect(domainConcepts).not.toContain("ai research"); // removed generic AI terms
      expect(domainConcepts).not.toContain("machine learning research");
    });

    it("University concept aliases match university labs but not commercial publications", () => {
      const academicText = "Research Engineer conducting deep learning research at the university AI laboratory";
      const commercialText = "Staff AI Engineer building models. We publish at NeurIPS and ICML conferences.";

      expect(containsConcept(academicText, "UNIVERSITY")).toBe(true);
      expect(containsConcept(academicText, "ACADEMIC_RESEARCH")).toBe(true);
      expect(hasRequiredInstitutionalContext("UNIVERSITY_AI_RESEARCH", academicText)).toBe(true);

      // Commercial text does NOT satisfy the institutional predicate.
      expect(hasRequiredInstitutionalContext("UNIVERSITY_AI_RESEARCH", commercialText)).toBe(false);
    });

    it("Social Impact lane does not treat bare 'govtech' SaaS vendor as primary multilateral infrastructure", () => {
      const vendorText = "Senior Software Architect building applications for a GovTech SaaS company";
      const publicInfraText = "Architect designing digital public infrastructure and public digital goods for multilateral agencies";

      expect(containsConcept(publicInfraText, "DIGITAL_PUBLIC_INFRASTRUCTURE")).toBe(true);
      expect(hasRequiredInstitutionalContext("SOCIAL_IMPACT_MULTILATERAL", publicInfraText)).toBe(true);
      expect(hasRequiredInstitutionalContext("SOCIAL_IMPACT_MULTILATERAL", vendorText)).toBe(false);
    });

    it("Core AI Data excludes generic mobile client developers via negative concepts", () => {
      const coreLane = lanes.CORE_AI_DATA;
      expect(coreLane.negative_concepts).toContain("ios developer");
      expect(coreLane.negative_concepts).toContain("android developer");
    });

    it("requires an approved technical function before CORE_AI_DATA eligibility", () => {
      const technicalTitles = [
        "Senior AI Engineer",
        "Lead AI Data Engineer",
        "Machine Learning Architect",
        "Technical Product Manager - ML Platform",
        "Research Scientist - Generative AI",
      ];
      const nonTechnicalTitles = [
        "Licensed Professional Counselor",
        "Director, Sales",
        "Business Development Manager",
        "Product Designer",
        "People Business Partner",
        "FP&A Associate",
        "Customer Success Manager",
      ];

      for (const title of technicalTitles) expect(hasCoreTechnicalFunction(title)).toBe(true);
      for (const title of nonTechnicalTitles) expect(hasCoreTechnicalFunction(title)).toBe(false);
    });

    it("blocks nontechnical role families from every lane before routing", () => {
      const lanesToCheck = [
        "CORE_AI_DATA",
        "LEGAL_REGTECH",
        "HEALTH_BIO_PHARMA",
        "INVESTMENT_MARKETS_FINTECH",
      ];
      const nonTechnicalTitles = [
        "Enterprise Sales Director",
        "Licensed Clinical Social Worker",
        "Financial Crimes Investigator",
        "Conceptual Art Director",
        "Customer Success Manager",
      ];

      for (const laneKey of lanesToCheck) {
        for (const title of nonTechnicalTitles) {
          expect(hasApprovedLaneFunction(laneKey, title)).toBe(false);
        }
      }

      expect(hasApprovedLaneFunction("HEALTH_BIO_PHARMA", "Clinical Data Scientist")).toBe(true);
      expect(hasApprovedLaneFunction("LEGAL_REGTECH", "Compliance Automation Engineer")).toBe(true);
      expect(hasCoreTechnicalFunction("Technical Consultant")).toBe(false);
      expect(hasCoreTechnicalFunction("Principal Architect")).toBe(true);
      expect(hasCoreTechnicalFunction("Research Scientist")).toBe(true);
    });
  });
});
