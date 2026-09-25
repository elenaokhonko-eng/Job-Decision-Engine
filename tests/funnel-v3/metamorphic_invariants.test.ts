import { describe, it, expect } from "vitest";
import { applyGlobalGates } from "../../src/services/criteria.js";

describe("Funnel V3 Independent Test Suite — Metamorphic Invariants", () => {
  const baseEligibleJob = {
    id: "meta-01",
    title: "Senior AI Engineer",
    company_name: "FinTech Innovations",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "We are seeking a Senior AI Engineer to build LLM pipelines in Python and PyTorch. Flexible hybrid schedule with 2 days work from home.",
  };

  it("Invariant 1: Changes to compensation cannot change hard gate eligibility", () => {
    const jobNoSalary = { ...baseEligibleJob, raw_description: baseEligibleJob.raw_description + " Salary competitive." };
    const jobLowSalary = { ...baseEligibleJob, raw_description: baseEligibleJob.raw_description + " Salary: $50,000/yr." };
    const jobHighSalary = { ...baseEligibleJob, raw_description: baseEligibleJob.raw_description + " Salary: $350,000/yr." };

    const resNoSalary = applyGlobalGates(jobNoSalary);
    const resLowSalary = applyGlobalGates(jobLowSalary);
    const resHighSalary = applyGlobalGates(jobHighSalary);

    expect(resNoSalary.status).toBe("PASS");
    expect(resLowSalary.status).toBe("PASS");
    expect(resHighSalary.status).toBe("PASS");
  });

  it("Invariant 2: Adding unrelated employer wishlist cannot add a user hard gate veto", () => {
    const jobWithWishlist = {
      ...baseEligibleJob,
      raw_description: baseEligibleJob.raw_description + "\n\nNice to have: Familiarity with Rust, Docker, Kubernetes, and graph databases. Preferred: Kubernetes certification.",
    };

    const resBase = applyGlobalGates(baseEligibleJob);
    const resWishlist = applyGlobalGates(jobWithWishlist);

    expect(resBase.status).toBe("PASS");
    expect(resWishlist.status).toBe("PASS");
  });

  it("Invariant 3: High semantic score or high salary cannot rescue an actual hard fail", () => {
    const hrJobWithAiBuzzwords = {
      id: "meta-03",
      title: "VP of Human Resources & Talent Acquisition",
      company_name: "Apex AI Labs",
      location: "Singapore",
      workplace_type: "HYBRID",
      raw_description: "Direct talent operations for cutting-edge AI, machine learning, and LLM engineers. Generous $400k package.",
    };

    const result = applyGlobalGates(hrJobWithAiBuzzwords);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.passed).toBe(false);
  });

  it("Invariant 4: Explicit attendance requirement overrides hybrid flexibility", () => {
    const hybridWith4DaysOnsite = {
      ...baseEligibleJob,
      raw_description: baseEligibleJob.raw_description + " Mandatory attendance: 4 days in office per week.",
    };

    const result = applyGlobalGates(hybridWith4DaysOnsite);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
  });

  it("Invariant 5: Generic title exclusion cannot shadow a more specific approved title", () => {
    const technicalDirector = {
      id: "meta-05",
      title: "Technical Delivery Director",
      company_name: "Cloud Enterprise",
      location: "Singapore",
      workplace_type: "HYBRID",
      raw_description: "Direct software engineering and technical architecture delivery for distributed cloud platforms in Go and Kubernetes.",
    };

    const result = applyGlobalGates(technicalDirector);
    expect(result.status).toBe("PASS");
  });
});
