import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { REVIEW_LIST_RULES } from "../../../app/reviewLists.js";
import {
  classifyJob,
  classifySector,
  parseRankingDesign,
  requireApprovedDesign,
  roleKindOfTitle,
  type CompanyIndustryTags,
} from "../../../modules/decision/index.js";

// Invented titles, employers, industries and posting text only.
const EXAMPLE = fs.readFileSync("fixtures/ranking_design.example.json", "utf8");
const design = parseRankingDesign(EXAMPLE);
const changed = (change: (raw: any) => void) => {
  const raw = JSON.parse(EXAMPLE);
  change(raw);
  return JSON.stringify(raw);
};

const TAGS: CompanyIndustryTags[] = [
  { names: ["Example Tagged Grove"], tags: ["CORE_AI_DATA", "HEALTH_BIO_PHARMA"] },
  { names: ["Example Model Shop"], tags: ["CORE_AI_DATA"] },
];

const classify = (overrides: Partial<Parameters<typeof classifyJob>[2]> = {}) =>
  classifyJob(design, TAGS, {
    title: "software engineer",
    company: "Example Orchard",
    description: "You write Python services.",
    workMode: null,
    externalClientFacing: false,
    peopleManagementCore: false,
    fallbackKind: null,
    ...overrides,
  });

describe("ranking design", () => {
  it("accepts the invented example and defaults the overall list to unsaved jobs", () => {
    expect(design.lists.overall_from_unsaved_only).toBe(true);
    const without = parseRankingDesign(changed((raw) => delete raw.lists.overall_from_unsaved_only));
    expect(without.lists.overall_from_unsaved_only).toBe(true);
  });

  it.each([
    ["not JSON", () => "{", /not valid JSON/],
    ["a missing section", () => changed((raw) => delete raw.role_types), /role_types/],
    ["an unknown field", () => changed((raw) => { raw.extra = true; }), /invalid/],
    ["an undeclared industry", () => changed((raw) => { raw.employers[0].industry = "MOONS"; }), /not declared/],
    ["a function tag used as an industry", () => changed((raw) => { raw.company_tag_industries.CORE_AI_DATA = "ORCHARDS"; }), /describes the role/],
    ["an unassigned role kind", () => changed((raw) => { raw.role_types[0].kinds = ["PRODUCT"]; }), /exactly one role type/],
    ["unknown as never", () => changed((raw) => { raw.unknown_role_status = "NEVER"; }), /unknown_role_status/],
  ])("fails loudly on %s", (_name, text, message) => {
    expect(() => parseRankingDesign(text())).toThrow(message);
  });

  it("refuses to build while the employer override list is not approved", () => {
    expect(() => requireApprovedDesign(design)).toThrow(/approved is false/);
  });

  it("needs no approval without an override list, and then overrides nothing", () => {
    const without = parseRankingDesign(changed((raw) => delete raw.employer_override));
    expect(() => requireApprovedDesign(without)).not.toThrow();
    expect(classifySector(without, [], "Example Loaf")).toMatchObject({ sector: "NEUTRAL", source: "UNKNOWN" });
  });
});

describe("role kind from the title", () => {
  it.each([
    ["engineering manager, orchard platform", "ENGINEERING_MANAGEMENT"],
    ["senior manager, engineering", "ENGINEERING_MANAGEMENT"],
    ["head of platform engineering", "ENGINEERING_MANAGEMENT"],
    ["associate director, data engineering", "DATA_ML"],
    ["software engineering, vp", "SOFTWARE"],
    ["head of ai governance", "AI_STRATEGY_LEADERSHIP"],
    ["director, ai strategy and adoption", "AI_STRATEGY_LEADERSHIP"],
    ["vp, data & ai risk", "AI_STRATEGY_LEADERSHIP"],
    ["senior ai engineer", "AI_ENGINEERING"],
    ["senior manager, ai engineering", "AI_ENGINEERING"],
    ["ai governance engineer", "AI_ENGINEERING"],
    ["director, ai architecture", "ARCHITECTURE"],
    ["ai product manager", "PRODUCT"],
    ["technical program manager, ai", "DELIVERY_MANAGEMENT"],
    ["research engineer, evaluations", "RESEARCH_ENGINEERING"],
    ["machine learning engineer", "DATA_ML"],
    ["senior data scientist", "DATA_ML"],
    ["full stack developer", "SOFTWARE"],
    ["forward deployed engineer", "FORWARD_DEPLOYED"],
    ["lighthouse keeper", null],
  ])("%s is %s", (title, kind) => {
    expect(roleKindOfTitle(title)).toBe(kind);
  });
});

describe("classification", () => {
  it("never treats an engineering manager as generic software", () => {
    const result = classify({ title: "engineering manager, delivery fleet", description: "You run the fleet and its people." });
    expect(result).toMatchObject({ kind: "ENGINEERING_MANAGEMENT", roleType: "COORDINATION", status: "NEVER" });
    expect(result.reasons).toContain("MANAGEMENT_WITHOUT_HANDS_ON");
    expect(classify({ title: "engineering manager", description: "Hands-on: you write code with the team." }))
      .toMatchObject({ roleType: "COORDINATION", status: "TRANSITION" });
  });

  it("gives AI strategy leadership the type the design assigns and measures its stakeholder load", () => {
    const heavy = classify({ title: "head of ai strategy", description: "Stakeholders, steering committee and alignment." });
    expect(heavy).toMatchObject({ kind: "AI_STRATEGY_LEADERSHIP", roleType: "PRODUCT", status: "NEUTRAL", stakeholderHeavy: true });
    expect(classify({ title: "head of ai strategy", description: "One stakeholder." }).stakeholderHeavy).toBe(false);
  });

  it("flags management as never only without hands-on wording", () => {
    expect(classify({ title: "data lead", peopleManagementCore: true, description: "You manage the team." }).status).toBe("NEVER");
    expect(classify({ title: "data scientist", peopleManagementCore: true, description: "You manage the team and write SQL." }).status)
      .toBe("TARGET");
  });

  it("sets architecture status from client facing, consulting and in-house wording", () => {
    const architect = (overrides: Parameters<typeof classify>[0]) => classify({ title: "data architect", ...overrides }).status;
    expect(architect({ description: "Design the estate." })).toBe("TRANSITION");
    expect(architect({ description: "Own our platform in-house." })).toBe("TARGET");
    expect(architect({ description: "Own our platform in-house.", externalClientFacing: true })).toBe("NEUTRAL");
    expect(architect({ company: "Example Advisers Pte Ltd", description: "in-house" })).toBe("NEVER");
    expect(architect({ company: "Harbour Consulting Group" })).toBe("NEVER");
  });

  it("does not read a solution architect title as client-facing", () => {
    expect(REVIEW_LIST_RULES.externalClientFacing("Design the data estate of the harbour.")).toBe(false);
    expect(REVIEW_LIST_RULES.externalClientFacing("A customer-facing role with client engagements.")).toBe(true);
  });

  it("leaves a never title phrase out and matches whole words only", () => {
    expect(classify({ title: "night watch software engineer" }).status).toBe("NEVER");
    expect(classify({ title: "knight watching software engineer" }).status).toBe("TARGET");
  });

  it("decides the sector from the employer only", () => {
    // Posting words about a preferred or never industry change nothing.
    expect(classify({ company: "Example Unknown Co", description: "We serve orchards, lighthouses and pyrotechnics." }))
      .toMatchObject({ sector: "NEUTRAL", sectorSource: "UNKNOWN", industry: null });
    expect(classify({ company: "Example Orchard Pte. Ltd." })).toMatchObject({ sector: "PREFERRED", sectorSource: "EMPLOYER_LIST" });
    expect(classify({ company: "Example Orchard Singapore" })).toMatchObject({ sector: "PREFERRED" });
    expect(classify({ company: "Example Orchard Removals" })).toMatchObject({ sector: "NEUTRAL" });
    expect(classify({ company: "Example Tagged Grove" })).toMatchObject({ sector: "PREFERRED", sectorSource: "COMPANY_TAG" });
    // The function tag is not an industry.
    expect(classify({ company: "Example Model Shop" })).toMatchObject({ sector: "NEUTRAL", sectorSource: "UNKNOWN" });
    expect(classify({ company: "North Lighthouse Trust" })).toMatchObject({ sector: "PREFERRED", sectorSource: "EMPLOYER_NAME" });
    expect(classify({ company: "Lighthouse Pyrotechnics" }).sector).toBe("NEVER");
    expect(classify({ company: "Example Loaf Singapore Bakehouse" })).toMatchObject({ sector: "NEUTRAL", sectorSource: "EMPLOYER_OVERRIDE" });
  });

  it("keeps unknown roles and unknown sectors in the pool", () => {
    expect(classify({ title: "lighthouse keeper", company: null }))
      .toMatchObject({ kind: "UNKNOWN", roleType: null, status: "NEUTRAL", sector: "NEUTRAL" });
    expect(classify({ title: "lighthouse keeper", fallbackKind: "PRODUCT" })).toMatchObject({ roleType: "PRODUCT" });
  });

  it("applies a requirement only to a known fact", () => {
    const field = (overrides: Parameters<typeof classify>[0]) =>
      classify({ title: "forward deployed engineer", company: "Example Robotics", ...overrides }).status;
    expect(field({})).toBe("NEUTRAL");
    expect(field({ workMode: "ONSITE" })).toBe("NEVER");
    expect(field({ description: "Expect 40% travel." })).toBe("NEVER");
    expect(field({ description: "Travel of up to 5%." })).toBe("NEUTRAL");
    expect(field({ company: "Example Orchard" })).toBe("NEVER");
  });
});
