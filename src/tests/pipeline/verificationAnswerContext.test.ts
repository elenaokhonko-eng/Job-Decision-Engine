import { describe, expect, it, vi } from "vitest";
import {
  applyGlobalGates,
} from "../../services/criteria.js";
import {
  applyExactProfileGates,
  applyPersistedRequirementGates,
} from "../../pipeline/hardGate.js";
import {
  createVerificationAnswerContext,
  isVerificationAnswerContextApplicable,
  loadVerificationAnswerContext,
  loadWorkabilityPolicy,
  type VerificationAnswerContext,
} from "../../pipeline/workabilityPolicy.js";

describe("verification answer context", () => {
  const technicalJob = (description: string, workplaceType = "REMOTE") => ({
    id: "job-1",
    title: "Senior AI Engineer",
    company_name: "Example Corp",
    raw_description: description,
    location: "Singapore",
    workplace_type: workplaceType,
    employment_type: "PERMANENT",
  });

  const requirement = (requirement_type: string, requirement_text: string, structured_value: Record<string, unknown> | null = null) => ({
    requirement_key: `req-${requirement_type}`,
    requirement_type,
    importance: "REQUIRED",
    requirement_text,
    quote_text: requirement_text,
    structured_value,
  });

  it("maps each persisted answer key to one typed, independent override", () => {
    const context = createVerificationAnswerContext(
      {
        workplace_hybrid_office_days_allowed: "2 days/week (Recommended)",
        profile_degree_subjects: ["Computer Science / Software Engineering"],
        work_authorization_jurisdictions: "Singapore Citizen / PR (Recommended)",
        experience_equivalent_domains: "Full-Stack & Backend Systems",
        lifestyle_travel_percentage_cap: "Up to 25%",
      },
      { answerRevisionId: "answer-revision-1", jobVersionId: "job-version-1" },
    );

    expect(context).toMatchObject({
      answerRevisionId: "answer-revision-1",
      jobVersionId: "job-version-1",
      overrides: {
        workplaceOfficeDaysCap: 2,
        degreeSubjects: ["computer_science"],
        workAuthorizationRegions: ["SINGAPORE"],
        experienceDomains: ["software"],
        travelPercentageCap: 25,
      },
    });
  });

  it("updates only the affected workplace blocker when the answer revision changes", () => {
    const job = technicalJob("Build deep learning models. 2 days per week in the office.", "HYBRID");
    const restrictive = createVerificationAnswerContext({
      workplace_hybrid_office_days_allowed: "1 day/week",
    }, { answerRevisionId: "revision-1" });
    const permissive = createVerificationAnswerContext({
      workplace_hybrid_office_days_allowed: "3 days/week",
    }, { answerRevisionId: "revision-2" });

    expect(applyGlobalGates(job as any).status).toBe("PASS");
    expect(applyGlobalGates(job as any, loadWorkabilityPolicy(), restrictive).status).toBe("HARD_REJECT");
    expect(applyGlobalGates(job as any, loadWorkabilityPolicy(), permissive).status).toBe("PASS");
  });

  it("uses degree answers to resolve a subject policy without inventing missing profile evidence", () => {
    const degreeRequirement = [requirement("DEGREE", "Bachelor's degree in Computer Science")];
    const degreeLevelOnly = [{
      id: "fact-degree",
      statement: "Bachelor's degree",
      structured_value: { degree_level: "bachelor" },
      source_type: "PROFILE_FACT" as const,
    }];
    const accepted = createVerificationAnswerContext({
      profile_degree_subjects: "Computer Science / Software Engineering",
    });
    const unrelated = createVerificationAnswerContext({
      profile_degree_subjects: "Data Science / Analytics",
    });

    expect(applyExactProfileGates(degreeRequirement, degreeLevelOnly).status).toBe("NEEDS_VERIFICATION");
    expect(applyExactProfileGates(degreeRequirement, degreeLevelOnly, accepted).status).toBe("PASS");
    expect(applyExactProfileGates(degreeRequirement, degreeLevelOnly, unrelated).status).toBe("HARD_REJECT");
    expect(applyExactProfileGates(degreeRequirement, [], accepted).status).toBe("NEEDS_VERIFICATION");
  });

  it("uses authorization answers only for an unknown authorization fact and preserves conflicts", () => {
    const authRequirement = [requirement("WORK_AUTH", "Authorized to work in Singapore")];
    const singaporeAnswer = createVerificationAnswerContext({
      work_authorization_jurisdictions: "Singapore Citizen / PR",
    });
    const usAnswer = createVerificationAnswerContext({
      work_authorization_jurisdictions: "US Citizen / Green Card",
    });
    const conflictingProfileFact = [{
      id: "fact-auth",
      statement: "Authorized to work in the United States",
      structured_value: { authorized_jurisdictions: ["UNITED_STATES"] },
      source_type: "PROFILE_FACT" as const,
    }];

    expect(applyExactProfileGates(authRequirement, []).status).toBe("NEEDS_VERIFICATION");
    expect(applyExactProfileGates(authRequirement, [], singaporeAnswer).status).toBe("PASS");
    expect(applyExactProfileGates(authRequirement, [], usAnswer).status).toBe("HARD_REJECT");
    expect(applyExactProfileGates(authRequirement, conflictingProfileFact, singaporeAnswer).status).toBe("HARD_REJECT");
  });

  it("expands only the required experience scope and preserves a duration conflict", () => {
    const experienceRequirement = [requirement(
      "EXPERIENCE_YEARS",
      "5 years of AI experience",
      { minimum_years: 5, experience_scope: "AI / Machine Learning" },
    )];
    const softwareExperience = [{
      id: "fact-experience",
      statement: "5 years of backend software engineering experience",
      structured_value: { professional_years: 5, experience_scope: "software" },
      source_type: "PROFILE_FACT" as const,
    }];
    const softwareAnswer = createVerificationAnswerContext({
      experience_equivalent_domains: "Full-Stack & Backend Systems",
    });
    const shortExperience = [{
      ...softwareExperience[0],
      structured_value: { professional_years: 2, experience_scope: "software" },
    }];

    expect(applyExactProfileGates(experienceRequirement, softwareExperience).status).toBe("NEEDS_VERIFICATION");
    expect(applyExactProfileGates(experienceRequirement, softwareExperience, softwareAnswer).status).toBe("PASS");
    expect(applyExactProfileGates(experienceRequirement, shortExperience, softwareAnswer).status).toBe("HARD_REJECT");
  });

  it("applies a travel cap without clearing an unrelated office blocker", () => {
    const travelJob = technicalJob("Build deep learning models. Up to 25% travel.");
    const travelAnswer = createVerificationAnswerContext({
      lifestyle_travel_percentage_cap: "Up to 25%",
    });
    const officeJob = technicalJob("Build deep learning models. 4 days per week in the office.", "HYBRID");

    expect(applyGlobalGates(travelJob as any).status).toBe("HARD_REJECT");
    expect(applyGlobalGates(travelJob as any, loadWorkabilityPolicy(), travelAnswer).status).toBe("PASS");
    expect(applyGlobalGates(officeJob as any, loadWorkabilityPolicy(), travelAnswer).status).toBe("HARD_REJECT");
  });

  it("leaves unknown answers and stale identities unapplied", () => {
    const unknown = createVerificationAnswerContext({
      workplace_hybrid_office_days_allowed: "a value the policy does not recognize",
      lifestyle_travel_percentage_cap: null,
    }, { answerRevisionId: "revision-current", jobVersionId: "job-current" });

    expect(unknown.overrides.workplaceOfficeDaysCap).toBeNull();
    expect(unknown.overrides.travelPercentageCap).toBeNull();
    expect(unknown.providedAnswerKeys).toEqual([
      "workplace_hybrid_office_days_allowed",
      "lifestyle_travel_percentage_cap",
    ]);
    expect(isVerificationAnswerContextApplicable(unknown, {
      answerRevisionId: "revision-stale",
      jobVersionId: "job-current",
    })).toBe(false);
    expect(isVerificationAnswerContextApplicable(unknown, {
      answerRevisionId: "revision-current",
      jobVersionId: "job-stale",
    })).toBe(false);
  });

  it("keeps explicitly unanswered workplace and travel facts in verification", () => {
    const unknownAnswers = createVerificationAnswerContext({
      workplace_hybrid_office_days_allowed: "not a supported answer",
      lifestyle_travel_percentage_cap: "not a supported answer",
    });

    expect(applyGlobalGates(technicalJob("Build deep learning models.", "HYBRID") as any, loadWorkabilityPolicy(), unknownAnswers).status)
      .toBe("NEEDS_VERIFICATION");
    expect(applyGlobalGates(technicalJob("Build deep learning models. 2 days per week in the office.", "HYBRID") as any, loadWorkabilityPolicy(), unknownAnswers).status)
      .toBe("NEEDS_VERIFICATION");
    expect(applyGlobalGates(technicalJob("Build deep learning models. Up to 5% travel.") as any, loadWorkabilityPolicy(), unknownAnswers).status)
      .toBe("NEEDS_VERIFICATION");
    expect(applyGlobalGates(technicalJob("Build deep learning models. Frequent travel may be required.") as any, loadWorkabilityPolicy(), unknownAnswers).status)
      .toBe("NEEDS_VERIFICATION");

    const unknownAuthorization = createVerificationAnswerContext({
      work_authorization_jurisdictions: "not a supported answer",
    });
    expect(applyPersistedRequirementGates(
      technicalJob("Build deep learning models.") as any,
      [requirement("WORK_AUTH", "Authorized to work in the United States")],
      loadWorkabilityPolicy(),
      unknownAuthorization,
    ).status).toBe("NEEDS_VERIFICATION");
  });

  it("loads a requested revision with both identities and maps JSON content", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: "revision-2",
        revision_number: 7,
        content: JSON.stringify({ Q01: "2 days/week", Q05: "Up to 25%" }),
      }],
    });
    const loaded = await loadVerificationAnswerContext({ query } as any, {
      context: { workspaceId: "workspace-1" } as any,
      answerRevisionId: "revision-2",
      jobVersionId: "job-version-2",
    });

    expect(loaded).toMatchObject({
      answerRevisionId: "revision-2",
      revisionNumber: 7,
      jobVersionId: "job-version-2",
      overrides: { workplaceOfficeDaysCap: 2, travelPercentageCap: 25 },
    });
  });

  it("preserves the no-context behavior and does not turn a DB read failure into a gate result", async () => {
    const job = technicalJob("Build deep learning models. 2 days per week in the office.", "HYBRID");
    expect(applyGlobalGates(job as any).status).toBe("PASS");

    const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
    await expect(loadVerificationAnswerContext({ query } as any, {
      answerRevisionId: "revision-1",
      jobVersionId: "job-version-1",
    })).resolves.toBeNull();
  });

  it("keeps an unknown travel amount in verification when an answer context is present", () => {
    const job = technicalJob("Build deep learning models. Frequent travel may be required.");
    const travelAnswer = createVerificationAnswerContext({
      lifestyle_travel_percentage_cap: "Up to 25%",
    });

    expect(applyGlobalGates(job as any, loadWorkabilityPolicy(), travelAnswer).status).toBe("NEEDS_VERIFICATION");
  });

  it("passes the answer context through persisted requirement gates", () => {
    const officeRequirement = [requirement("OFFICE_DAYS", "2 days per week in office", { office_days_per_week: 2 })];
    const restrictive = createVerificationAnswerContext({
      workplace_hybrid_office_days_allowed: "1 day/week",
    });
    const permissive = createVerificationAnswerContext({
      workplace_hybrid_office_days_allowed: "3 days/week",
    });
    const job = {
      title: "Senior AI Engineer",
      company_name: "Example Corp",
      workplace_type: "HYBRID",
      description: "Build deep learning models.",
    };

    expect(applyPersistedRequirementGates(job, officeRequirement, loadWorkabilityPolicy(), restrictive).status).toBe("HARD_REJECT");
    expect(applyPersistedRequirementGates(job, officeRequirement, loadWorkabilityPolicy(), permissive).status).toBe("PASS");
  });
});
