import { describe, expect, it } from "vitest";

import {
  assessCareerTrack,
  capOutcome,
  classifyCareerTrack,
  classifyJobLevel,
  parseTrackExperience,
  type TrackExperience,
  type TrackRequirement,
} from "../../pipeline/careerTrack.js";

// Synthetic experience split: long data-management and architecture careers, a mid product
// career, and a short hands-on AI/data track. Not any real candidate's figures.
const EXPERIENCE: TrackExperience[] = [
  { track: "DATA_MANAGEMENT", years: 16 },
  { track: "ARCHITECTURE", years: 10 },
  { track: "PRODUCT", years: 6 },
  { track: "HANDS_ON_AI_DATA", years: 1.5 },
];

function years(minimum: number, scope = "machine learning"): TrackRequirement {
  return {
    requirement_type: "EXPERIENCE_YEARS",
    importance: "MUST",
    requirement_text: "Role requires minimum years of experience.",
    structured_value: { minimum_years: minimum, experience_scope: scope },
  };
}

function assess(title: string, requirements: TrackRequirement[] = []) {
  return assessCareerTrack({ title, requirements, experience: EXPERIENCE });
}

describe("career track classification", () => {
  it.each([
    ["AI Engineer II", "HANDS_ON_AI_DATA"],
    ["Machine Learning Engineer", "HANDS_ON_AI_DATA"],
    ["Senior Data Scientist", "HANDS_ON_AI_DATA"],
    ["Senior Data Engineer", "HANDS_ON_AI_DATA"],
    ["AI Solutions Architect", "AI_BRIDGE"],
    ["Forward Deployed Engineer", "AI_BRIDGE"],
    ["AI Product Manager", "AI_BRIDGE"],
    ["Director of AI Engineering", "AI_BRIDGE"],
    ["Responsible AI Lead", "AI_BRIDGE"],
    ["Head of Data Governance", "DATA_MANAGEMENT"],
    ["Master Data Management Lead", "DATA_MANAGEMENT"],
    ["Data Analyst", "DATA_MANAGEMENT"],
    ["Enterprise Architect", "ARCHITECTURE"],
    ["Senior Product Manager", "PRODUCT"],
    ["Software Engineer II", "GENERIC_SOFTWARE"],
    ["Front-End Software Engineer", "GENERIC_SOFTWARE"],
    ["Senior Commercial Counsel", "UNCLASSIFIED"],
    ["Remote AI Trainers (Python Coding Experts)", "UNCLASSIFIED"],
    ["Sr. Data Analytics Engineer", "HANDS_ON_AI_DATA"],
    ["Senior Data Platform Architect", "ARCHITECTURE"],
    ["Head of Data Architecture", "ARCHITECTURE"],
    ["Accelerator Program - Applied AI Application Engineer", "HANDS_ON_AI_DATA"],
    ["AI Programme Manager", "AI_BRIDGE"],
  ])("classifies %s as %s", (title, track) => {
    expect(classifyCareerTrack(title).track).toBe(track);
  });

  it("lifts a generic engineering title to hands-on AI only with two mandatory AI requirements", () => {
    const aiRequirement = (text: string): TrackRequirement => ({ requirement_type: "SKILL", importance: "MUST", requirement_text: text, structured_value: null });
    expect(classifyCareerTrack("Backend Engineer", [aiRequirement("Experience building LLM applications")]).track).toBe("GENERIC_SOFTWARE");
    expect(classifyCareerTrack("Backend Engineer", [
      aiRequirement("Experience building LLM applications"),
      aiRequirement("Production machine learning model serving"),
    ]).track).toBe("HANDS_ON_AI_DATA");
  });
});

describe("job level", () => {
  it.each([
    ["Software Engineer II", "MID"],
    ["Technical Implementation Specialist II", "MID"],
    ["IAM Engineer 1", "ENTRY"],
    ["Junior Data Scientist", "ENTRY"],
    ["Associate Product Manager", "ENTRY"],
    ["Associate Director, Data Strategy", "SENIOR"],
    ["AVP, Data Scientist", "SENIOR"],
    ["Senior / Software Engineer", "SENIOR"],
    ["Staff Software Engineer", "SENIOR"],
    ["Head of Data Architecture", "LEADERSHIP"],
    ["Vice President, Agentic AI Platform Lead", "LEADERSHIP"],
    ["Machine Learning Engineer", "MID"],
    ["Partner Solutions Architect", "MID"],
    ["Accelerator Program - Applied AI Application Engineer", "ENTRY"],
  ])("reads %s as %s", (title, level) => {
    expect(classifyJobLevel(title, null).level).toBe(level);
  });

  it("uses stated minimum years only for an unmarked title", () => {
    expect(classifyJobLevel("Data Engineer", 10).level).toBe("SENIOR");
    expect(classifyJobLevel("Data Engineer", 1).level).toBe("ENTRY");
    expect(classifyJobLevel("Senior Data Engineer", 1).level).toBe("SENIOR");
  });
});

describe("track-aware seniority", () => {
  it("keeps a mid-level hands-on AI role as a transition fit that can stay PRIORITY", () => {
    const result = assess("AI Engineer II");
    expect(result).toMatchObject({ track: "HANDS_ON_AI_DATA", level: "MID", fit: "FIT", outcome_cap: null });
    expect(result.tags).toContain("TRANSITION");
    expect(capOutcome("PRIORITY", result.outcome_cap)).toBe("PRIORITY");
  });

  it("keeps graduate hands-on roles out", () => {
    const result = assess("Junior Data Scientist");
    expect(result).toMatchObject({ fit: "OUT", outcome_cap: "SKIP" });
    expect(capOutcome("REVIEW", result.outcome_cap)).toBe("SKIP");
  });

  it("holds a senior hands-on role demanding far more ML years at REVIEW as a stretch, never rejected", () => {
    const result = assess("Senior Machine Learning Engineer", [years(5)]);
    expect(result).toMatchObject({ fit: "STRETCH", outcome_cap: "REVIEW" });
    expect(result.tags).toContain("STRETCH");
    expect(capOutcome("PRIORITY", result.outcome_cap)).toBe("REVIEW");
  });

  it("leaves a senior hands-on role with a modest years bar uncapped but tagged stretch", () => {
    const result = assess("Senior AI Engineer", [years(3)]);
    expect(result).toMatchObject({ fit: "STRETCH", outcome_cap: null });
    expect(result.tags).toEqual(expect.arrayContaining(["STRETCH", "TRANSITION"]));
  });

  it("treats mid-level data-management and architecture roles as a step down", () => {
    expect(assess("Data Governance Analyst")).toMatchObject({ track: "DATA_MANAGEMENT", fit: "STEP_DOWN", outcome_cap: "REVIEW" });
    expect(assess("Solution Architect")).toMatchObject({ track: "ARCHITECTURE", fit: "STEP_DOWN", outcome_cap: "REVIEW" });
    expect(assess("Head of Data Governance")).toMatchObject({ fit: "FIT", outcome_cap: null });
    expect(assess("Principal Enterprise Architect")).toMatchObject({ fit: "FIT", outcome_cap: null });
  });

  it("treats a junior product role as a step down and mid or senior product roles as a fit", () => {
    expect(assess("Associate Product Manager")).toMatchObject({ track: "PRODUCT", fit: "STEP_DOWN", outcome_cap: "REVIEW" });
    expect(assess("Product Manager")).toMatchObject({ fit: "FIT", outcome_cap: null });
    expect(assess("Senior Product Manager")).toMatchObject({ fit: "FIT", outcome_cap: null });
  });

  it("prefers bridge roles, including unmarked ones", () => {
    const result = assess("AI Solutions Architect");
    expect(result).toMatchObject({ track: "AI_BRIDGE", fit: "FIT", outcome_cap: null, candidate_years: 16 });
    expect(result.tags).toContain("BRIDGE");
  });

  it("caps generic software engineering at REVIEW", () => {
    const result = assess("Software Engineer II");
    expect(result).toMatchObject({ track: "GENERIC_SOFTWARE", outcome_cap: "REVIEW" });
    expect(result.tags).toContain("OFF_TRACK");
    expect(capOutcome("PRIORITY", result.outcome_cap)).toBe("REVIEW");
  });

  it("holds unclassified titles below PRIORITY", () => {
    expect(assess("Senior Commercial Counsel")).toMatchObject({ track: "UNCLASSIFIED", outcome_cap: "REVIEW", tags: ["TRACK_UNCLASSIFIED"] });
  });

  it("applies no floor when the profile states no years for the track", () => {
    const result = assessCareerTrack({ title: "Data Governance Analyst", experience: [] });
    expect(result).toMatchObject({ candidate_years: null, outcome_cap: null, tags: ["TRACK_EXPERIENCE_MISSING"] });
  });

  it("only lowers outcomes", () => {
    expect(capOutcome("TRACK", "REVIEW")).toBe("TRACK");
    expect(capOutcome("SKIP", "REVIEW")).toBe("SKIP");
    expect(capOutcome("REVIEW", null)).toBe("REVIEW");
  });
});

describe("stored experience_by_track", () => {
  it("parses the stored array and treats NULL as none stated", () => {
    expect(parseTrackExperience(null)).toEqual([]);
    expect(parseTrackExperience([{ track: "PRODUCT", years: 6, label: "Product" }])).toEqual([{ track: "PRODUCT", years: 6 }]);
  });

  it("throws on a malformed value instead of silently dropping the floors", () => {
    expect(() => parseTrackExperience([{ track: "PRODUCT", years: -1, label: "Product" }])).toThrow();
    expect(() => parseTrackExperience([{ track: "UNKNOWN", years: 2, label: "x" }])).toThrow();
    expect(() => parseTrackExperience([
      { track: "PRODUCT", years: 6, label: "a" },
      { track: "PRODUCT", years: 7, label: "b" },
    ])).toThrow(/Duplicate experience track/);
  });
});
