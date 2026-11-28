import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { REVIEW_LIST_RULES } from "../../../app/reviewLists.js";
import {
  classifyJob,
  classifySector,
  parseRankingDesign,
  requireApprovedDesign,
  roleKindOfTitle,
  statedTravelPercent,
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
  { names: ["Example Tagged Grove"], tags: ["CORE_AI_DATA", "SOCIAL_IMPACT_MULTILATERAL"] },
  { names: ["Example Model Shop"], tags: ["CORE_AI_DATA"] },
];

const classify = (overrides: Partial<Parameters<typeof classifyJob>[2]> = {}, using = design) =>
  classifyJob(using, TAGS, {
    title: "zorblat software engineer",
    company: "Example Orchard",
    employerUnknown: false,
    description: "You write Python services.",
    workMode: null,
    externalClientFacing: false,
    peopleManagementCore: false,
    fallbackKind: null,
    ...overrides,
  });

/** The example with one invented change, for a test of a single mechanism. */
const designWith = (change: (raw: any) => void) => parseRankingDesign(changed(change));
const strictManagement = designWith((raw) => { raw.management_without_hands_on = "NEVER"; });

describe("ranking design", () => {
  it("accepts the invented example", () => {
    expect(design.schema_version).toBe("ranking_design_v1");
  });

  it("has no way to leave saved jobs out of the overall list", () => {
    expect(design.lists.overall_from_unsaved_only).toBeUndefined();
    expect(parseRankingDesign(changed((raw) => { raw.lists.overall_from_unsaved_only = false; })).lists.overall_from_unsaved_only).toBe(false);
    expect(() => parseRankingDesign(changed((raw) => { raw.lists.overall_from_unsaved_only = true; }))).toThrow(/overall_from_unsaved_only/);
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
    ["zorblat engineering manager, quindle", "ENGINEERING_MANAGEMENT"],
    ["quindle manager, engineering", "ENGINEERING_MANAGEMENT"],
    ["head of zorblat engineering", "ENGINEERING_MANAGEMENT"],
    ["zorblat associate director, wibbet engineering", null],
    ["wibbet engineering, vp", null],
    ["head of zorblat ai governance", "AI_STRATEGY_LEADERSHIP"],
    ["director, quindle ai strategy", "AI_STRATEGY_LEADERSHIP"],
    ["vp, wibbet ai risk", "AI_STRATEGY_LEADERSHIP"],
    ["zorblat ai engineer", "AI_ENGINEERING"],
    ["manager of wibbet ai engineering", "AI_ENGINEERING"],
    ["mirvane ai governance engineer", "AI_ENGINEERING"],
    ["mirvane ai architecture", "ARCHITECTURE"],
    ["mirvane ai product manager", "PRODUCT"],
    ["fennick program manager for quindles", "DELIVERY_MANAGEMENT"],
    ["snorple research engineer", "RESEARCH_ENGINEERING"],
    ["glimmet machine learning wrangler", "DATA_ML"],
    ["tovrik data scientist", "DATA_ML"],
    ["brumble full stack developer", "SOFTWARE"],
    ["skellet forward deployed wrangler", "FORWARD_DEPLOYED"],
    ["zorblat keeper", null],
  ])("%s is %s", (title, kind) => {
    expect(roleKindOfTitle(title)).toBe(kind);
  });
});

describe("classification", () => {
  it("classifies an engineering management title as management", () => {
    const result = classify(
      { title: "zorblat engineering manager, quindle snorple", description: "You look after the snorples." },
      strictManagement,
    );
    expect(result).toMatchObject({ kind: "ENGINEERING_MANAGEMENT", roleType: "DELTA", status: "NEVER" });
    expect(result.reasons).toContain("MANAGEMENT_WITHOUT_HANDS_ON");
    expect(classify({ title: "quindle engineering manager", description: "Hands-on: you write code with the zorblats." }, strictManagement))
      .toMatchObject({ roleType: "DELTA", status: "TARGET" });
  });

  it("gives AI strategy leadership the type the design assigns and measures its stakeholder load", () => {
    const heavy = classify({ title: "head of zorblat ai strategy", description: "Stakeholders, steering committee and alignment." });
    expect(heavy).toMatchObject({ kind: "AI_STRATEGY_LEADERSHIP", roleType: "ALPHA", status: "NEUTRAL", stakeholderHeavy: true });
    expect(classify({ title: "head of zorblat ai strategy", description: "One stakeholder." }).stakeholderHeavy).toBe(false);
  });

  it("applies the management rule only where the design asks and only without hands-on wording", () => {
    const managing = { title: "tovrik data scientist", peopleManagementCore: true, description: "You manage the quindles." };
    expect(classify(managing, strictManagement).status).toBe("NEVER");
    expect(classify(managing).status).toBe("TARGET");
    expect(classify({ ...managing, description: "You manage the quindles and write SQL." }, strictManagement).status).toBe("TARGET");
  });

  it("applies conditional statuses in their order", () => {
    const architect = (overrides: Parameters<typeof classify>[0]) => classify({ title: "mirvane data architect", ...overrides });
    expect(architect({ description: "Shape the quindles." }).status).toBe("TARGET");
    expect(architect({ description: "Own our platform in-house." }).status).toBe("NEVER");
    expect(architect({ description: "Own our platform in-house.", externalClientFacing: true }))
      .toMatchObject({ status: "TARGET", reasons: expect.arrayContaining(["EXTERNAL_CLIENT_FACING"]) });
    expect(architect({ company: "Example Advisers Pte Ltd", description: "in-house" }).status).toBe("TRANSITION");
    expect(architect({ company: "Harbour Consulting Group" }).status).toBe("TRANSITION");
  });

  it("does not read a job title as evidence of client-facing work", () => {
    expect(REVIEW_LIST_RULES.externalClientFacing("Shape the quindles of the harbour.")).toBe(false);
    expect(REVIEW_LIST_RULES.externalClientFacing("A customer-facing role with client engagements.")).toBe(true);
  });

  it("leaves a never title phrase out and matches whole words only", () => {
    expect(classify({ title: "night watch zorblat developer" }).status).toBe("NEVER");
    expect(classify({ title: "knight watching zorblat developer" }).status).toBe("NEUTRAL");
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
    expect(classify({ title: "zorblat keeper", company: null, employerUnknown: true }))
      .toMatchObject({ kind: "UNKNOWN", roleType: null, status: "TARGET", sector: "NEUTRAL" });
    expect(classify({ title: "zorblat keeper", fallbackKind: "PRODUCT" })).toMatchObject({ roleType: "GAMMA" });
  });

  const demanding = designWith((raw) => {
    raw.role_types[2].requires = { work_modes: ["ONSITE"], max_travel_percent: 55, top_technology_employer: true };
  });
  const field = (overrides: Parameters<typeof classify>[0]) =>
    classify({ title: "skellet forward deployed wrangler", company: "Example Robotics", ...overrides }, demanding).status;

  it("applies a requirement only to a known fact", () => {
    expect(field({})).toBe("TRANSITION");
    expect(field({ workMode: "REMOTE" })).toBe("NEVER");
    expect(field({ description: "Expect 80% travel." })).toBe("NEVER");
    expect(field({ description: "Travel of up to 5%." })).toBe("TRANSITION");
    expect(field({ company: "Example Orchard" })).toBe("NEVER");
  });

  it.each([
    "Hardly any travel, 100% quindle based",
    "Travel stipend and 100% snorple cover",
    "Zero travel needed, 100% from your burrow",
    "Travel: 100% quindle funded",
    "100% travel insurance for every zorblat",
    "100% travel-free",
    "We travel light. 100% of zorblats agree.",
  ])("reads no travel figure in %j", (description) => {
    expect(statedTravelPercent(description)).toBeNull();
    expect(field({ description })).toBe("TRANSITION");
  });

  it.each([
    ["Expect 80% travel.", 80],
    ["80% of your time travelling between burrows", 80],
    ["70% international travel", 70],
    ["Travel of up to 65%.", 65],
    ["Travel: 60%", 60],
    ["Travel required: 20-75% of the time", 75],
    ["travel approximately 5% and some quindles", 5],
  ])("reads the travel figure in %j", (description, percent) => {
    expect(statedTravelPercent(description)).toBe(percent);
  });

  it("never turns an unknown employer into never", () => {
    expect(field({ company: null, employerUnknown: true })).toBe("TRANSITION");
    expect(field({ company: null })).toBe("TRANSITION");
    expect(field({ company: "Unknown Company", employerUnknown: true })).toBe("TRANSITION");
    // A name that identifies no employer decides no sector either.
    expect(classify({ company: "www.pyrotechnics.example", employerUnknown: true }))
      .toMatchObject({ sector: "NEUTRAL", sectorSource: "UNKNOWN" });
    expect(REVIEW_LIST_RULES.isUnknownEmployer("Unknown Company")).toBe(true);
  });
});
