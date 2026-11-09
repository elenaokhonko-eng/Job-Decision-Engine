import { describe, expect, it } from "vitest";
import {
  discoveryPrescreenEnabled,
  excludedConceptTerms,
  filteredPayloadDedupeEnabled,
  matchTitleDenyList,
  PRESCREEN_TIER1_DEFAULTS,
} from "../../ingestion/discoveryPrescreen.js";
import {
  assessStructuredGeoScope,
  buildDiscoveryLocationScope,
  loadDiscoveryLocationScope,
  structuredGeoFromPayload,
  type LocationScopeConfig,
} from "../../ingestion/discoveryLocationScope.js";
import { assessCandidateLanes } from "../../ingestion/discoveryPlanExecution.js";
import { DiscoveryScoutPlanner } from "../../ingestion/scouts/discoveryScouts.js";
import { loadGlobalLanesConfig } from "../../pipeline/laneConfigLoader.js";
import { discoveryScopeSkip } from "../../../scripts/run_adapters.js";
import type { ExtractedJob } from "../../contracts/index.js";

// Synthetic fixtures only.
const CONFIG: LocationScopeConfig = {
  applies_to_source_keys: ["greenhouse", "lever", "ashby", "workable", "smartrecruiters", "jobicy", "himalayas", "remotive", "we_work_remotely"],
  region_terms: { SINGAPORE: ["singapore"] },
  region_country_codes: { SINGAPORE: ["SG"] },
  regional_terms: ["apac", "asia pacific", "southeast asia", "asia"],
  remote_terms: ["remote", "work from home"],
  global_terms: ["worldwide", "global", "anywhere"],
  remote_filler_terms: ["first", "fully", "only", "based", "from", "in", "the", "any", "or"],
  unknown_location_terms: ["unknown", "not specified", "multiple locations"],
};
const SCOPE = buildDiscoveryLocationScope(CONFIG, { authorizedRegions: ["SINGAPORE"], rejectExplicitForeignTerritory: true });

describe("discovery pre-screen flags", () => {
  it("is off unless explicitly true and refuses an unparseable value", () => {
    expect(discoveryPrescreenEnabled({})).toBe(false);
    expect(discoveryPrescreenEnabled({ DISCOVERY_PRESCREEN_ENABLED: "false" })).toBe(false);
    expect(discoveryPrescreenEnabled({ DISCOVERY_PRESCREEN_ENABLED: " TRUE " })).toBe(true);
    expect(() => discoveryPrescreenEnabled({ DISCOVERY_PRESCREEN_ENABLED: "yes" })).toThrow(/must be "true" or "false"/);
    expect(filteredPayloadDedupeEnabled({})).toBe(false);
    expect(filteredPayloadDedupeEnabled({ DISCOVERY_FILTERED_PAYLOAD_DEDUPE_ENABLED: "true" })).toBe(true);
    expect(() => filteredPayloadDedupeEnabled({ DISCOVERY_FILTERED_PAYLOAD_DEDUPE_ENABLED: "1" })).toThrow();
  });
});

describe("Tier 0 title deny-list", () => {
  it.each([
    ["Machine Learning Intern", "intern"],
    ["Summer Internship - Data", "intern"],
    ["Data Apprenticeship", "apprentice"],
    ["Graduate Trainee, Analytics", "trainee"],
    ["Working Student AI", "working student"],
    ["Software Co-op (Fall)", "co-op"],
    ["Graduate Software Engineer", "graduate"],
    ["New Graduate Data Engineer", "graduate"],
    ["Recent Graduate Programme - Technology", "graduate"],
    ["Registered Nurse", "nurse"],
    ["Staff Physician", "physician"],
    ["Clinical Pharmacist", "pharmacist"],
    ["Clinical Research Associate II", "clinical research associate"],
    ["Sales Development Representative", "sales development"],
    ["SDR, APAC", "SDR"],
    ["Enterprise Account Executive", "account executive"],
    ["Customer Success Manager", "customer success"],
    ["Technical Support Specialist", "support specialist"],
    ["Customer Support Lead", "customer support"],
    ["Technical Recruiter", "recruiter"],
    ["Recruiting Coordinator", "recruiter"],
    ["Talent Acquisition Partner", "talent acquisition"],
    ["HRBP, Engineering", "HR business partner"],
    ["Office Manager", "office manager"],
    ["Executive Assistant to the CEO", "executive assistant"],
    ["Senior GL Accountant", "accountant"],
    ["Payroll Operations Manager", "payroll"],
    ["Warehouse Associate", "warehouse"],
    ["Delivery Driver", "driver"],
    ["Field Service Technician", "field technician"],
    ["Senior UX Designer", "designer"],
    ["UI/UX Designer", "designer"],
    ["Graphic Designer", "designer"],
    ["Motion Designer", "designer"],
  ])("denies %j (%s)", (title, term) => {
    expect(matchTitleDenyList(title)).toMatchObject({ term });
  });

  it.each([
    "Software Engineer II",
    "Associate Data Scientist",
    "Mid-Level Machine Learning Engineer",
    "AI Solutions Specialist",
    "Senior Data Analyst",
    "Postgraduate Research Software Engineer",
    "Undergraduate Research Programme Lead",
    "Post-graduate Research Fellow, Computational Biology",
    "Product Designer",
    "Senior Product Designer, AI Platform",
    "Data Warehouse Engineer",
    "Linux Kernel Driver Developer",
    "Payroll Platform Engineer",
    "Internal Tools Engineer",
    "International Data Architect",
    "Full time + Internships",
    "",
  ])("keeps %j", (title) => {
    expect(matchTitleDenyList(title)).toBeNull();
  });
});

describe("structured geo fields", () => {
  const title = { title: "Synthetic Platform Architect" };

  it.each([
    ["himalayas", { locationRestrictions: ["United States"] }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["himalayas", { locationRestrictions: ["United States", "Singapore"] }, "GEO_FIELD_IN_SCOPE"],
    ["jobicy", { jobGeo: "USA" }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["jobicy", { jobGeo: "Canada,  USA" }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["jobicy", { jobGeo: "APAC" }, "GEO_FIELD_IN_SCOPE"],
    ["jobicy", { jobGeo: "Anywhere" }, "GEO_FIELD_IN_SCOPE"],
    ["remotive", { candidate_required_location: "Europe, EMEA" }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["remotive", { candidate_required_location: "Worldwide" }, "GEO_FIELD_IN_SCOPE"],
    ["we_work_remotely", { region: "USA Only", country: "" }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["we_work_remotely", { region: "Anywhere in the World", country: "United States of America" }, "GEO_FIELD_IN_SCOPE"],
    ["smartrecruiters", { location: { country: "sg", remote: false } }, "GEO_FIELD_IN_SCOPE"],
    ["smartrecruiters", { location: { country: "us", remote: false } }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["workable", { locations: [{ country: "United Kingdom", countryCode: "GB", hidden: false }], telecommuting: false }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["ashby", {
      isRemote: false,
      address: { postalAddress: { addressCountry: "United Kingdom" } },
      secondaryLocations: [{ address: { postalAddress: { addressCountry: "Singapore" } } }],
    }, "GEO_FIELD_IN_SCOPE"],
    ["ashby", { isRemote: false, address: { postalAddress: { addressCountry: "France" } }, secondaryLocations: [] }, "GEO_FIELD_OUT_OF_SCOPE"],
    ["greenhouse", { offices: [{ name: "Singapore", location: "Singapore, Central, Singapore" }] }, "GEO_FIELD_IN_SCOPE"],
  ])("%s %j -> %s", (sourceKey, payload, reasonCode) => {
    expect(assessStructuredGeoScope(title, structuredGeoFromPayload(sourceKey, payload), SCOPE)).toMatchObject({ reasonCode });
  });

  it.each([
    ["himalayas", { locationRestrictions: [] }],
    ["himalayas", { location: "Remote" }],
    ["jobicy", { jobGeo: "Remote" }],
    ["jobicy", { jobGeo: "Unknown" }],
    // A remote Ashby, Workable or SmartRecruiters posting's address may be the employer's office.
    ["ashby", { isRemote: true, address: { postalAddress: { addressCountry: "United States" } } }],
    ["workable", { locations: [{ country: "United States", countryCode: "US" }], telecommuting: true }],
    ["smartrecruiters", { location: { country: "us", remote: true } }],
    // Ashby: one location without a country leaves the territory unclear.
    ["ashby", { isRemote: false, address: { postalAddress: { addressCountry: "France" } }, secondaryLocations: [{ location: "Elsewhere" }] }],
    // Greenhouse offices and Lever countries never exclude.
    ["greenhouse", { offices: [{ name: "London", location: "London, England, United Kingdom" }] }],
    ["lever", { country: "US", categories: { location: "San Francisco" } }],
    ["unknown_source", { region: "USA" }],
  ])("%s %j is unclear and leaves the decision to the free-text scope", (sourceKey, payload) => {
    expect(assessStructuredGeoScope(title, structuredGeoFromPayload(sourceKey, payload), SCOPE)).toBeNull();
  });

  it("keeps an out-of-territory field when the title names an authorized region", () => {
    const geo = structuredGeoFromPayload("himalayas", { locationRestrictions: ["United States"] });
    expect(assessStructuredGeoScope({ title: "Data Engineer (Singapore)" }, geo, SCOPE)).toBeNull();
  });

  it("reads the authorized region country codes from the source plan", () => {
    expect(loadDiscoveryLocationScope()?.inScopeCountryCodes).toEqual(["sg"]);
  });
});

describe("discovery scope skip order", () => {
  const job = (overrides: Partial<ExtractedJob>): ExtractedJob => ({
    schema_version: "1.0.0",
    company_name: "Example Company",
    title: "Synthetic Platform Architect",
    description_raw: "Build data platform services.",
    location_raw: "Unknown",
    workplace_type_raw: "REMOTE",
    employment_type_raw: "FULL_TIME",
    compensation_raw: "UNKNOWN",
    canonical_apply_url: "https://example.com/jobs/1",
    ...overrides,
  } as ExtractedJob);

  it("changes nothing when the pre-screen is off", () => {
    const usOnly = { locationRestrictions: ["United States"] };
    expect(discoveryScopeSkip(job({ title: "Machine Learning Intern" }), usOnly, "himalayas", SCOPE, false)).toBeNull();
  });

  it("applies the title deny-list, then structured geo, then the free-text scope", () => {
    expect(discoveryScopeSkip(job({ title: "Machine Learning Intern" }), {}, "himalayas", SCOPE, true))
      .toMatchObject({ reasonCode: "PRESCREEN_TITLE_DENY" });
    expect(discoveryScopeSkip(job({}), { locationRestrictions: ["United States"] }, "himalayas", SCOPE, true))
      .toMatchObject({ reasonCode: "GEO_FIELD_OUT_OF_SCOPE" });
    expect(discoveryScopeSkip(job({ location_raw: "Berlin, Germany", workplace_type_raw: "ONSITE" }), {}, "greenhouse", SCOPE, true))
      .toMatchObject({ reasonCode: "LOCATION_OUT_OF_SCOPE" });
    // An explicit in-scope structured field keeps a posting the free text alone would skip.
    expect(discoveryScopeSkip(
      job({ location_raw: "London", workplace_type_raw: "HYBRID" }),
      { isRemote: false, address: { postalAddress: { addressCountry: "United Kingdom" } }, secondaryLocations: [{ address: { postalAddress: { addressCountry: "Singapore" } } }] },
      "ashby", SCOPE, true,
    )).toBeNull();
    // The title deny-list runs for sources outside the location scope too.
    expect(discoveryScopeSkip(job({ title: "Account Executive" }), {}, "hacker_news", null, true))
      .toMatchObject({ reasonCode: "PRESCREEN_TITLE_DENY" });
  });
});

describe("Tier 1 lane pre-screen", () => {
  const lanes = loadGlobalLanesConfig().lanes;
  const plans = new DiscoveryScoutPlanner().generateSearchPlans();
  const tier1 = { ...PRESCREEN_TIER1_DEFAULTS, roleInTitleOnly: false };

  it("maps excluded domain concepts to plain discovery terms", () => {
    expect(excludedConceptTerms(["PAYMENTS", "M_AND_A", "ios developer"])).toEqual([
      "payments", "m&a", "mergers and acquisitions", "mergers & acquisitions", "ios developer",
    ]);
    expect(lanes.CORE_AI_DATA.excluded_domain_concepts).toContain("ios developer");
  });

  it("is unchanged without pre-screen options", () => {
    const posting = {
      company_name: "Example Company",
      title: "Senior iOS Developer",
      description_raw: "Join our machine learning team. We build LLM platform features with an AI engineer group.",
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
    };
    const result = assessCandidateLanes(posting, ["CORE_AI_DATA"], plans, lanes);
    expect(result[0].reasonCode).not.toBe("LANE_EXCLUDED_DOMAIN");
    expect(assessCandidateLanes(posting, ["CORE_AI_DATA"], plans, lanes, [], tier1)[0])
      .toMatchObject({ matched: false, reasonCode: "LANE_EXCLUDED_DOMAIN" });
  });

  it("excludes a lane on its own negative term while another lane still matches", () => {
    const posting = {
      company_name: "Example Company",
      title: "iOS Developer, Contract Analytics",
      description_raw: "Build legal technology and contract analytics with a software engineer team.",
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
    };
    const result = assessCandidateLanes(posting, ["CORE_AI_DATA", "LEGAL_REGTECH"], plans, lanes, ["CORE_AI_DATA", "LEGAL_REGTECH"], tier1);
    expect(result.find((lane) => lane.laneKey === "CORE_AI_DATA")).toMatchObject({ reasonCode: "LANE_EXCLUDED_DOMAIN" });
    expect(result.find((lane) => lane.laneKey === "LEGAL_REGTECH")).toMatchObject({ matched: true });
  });

  it("requires a role term or technical-role word in the title or the description opening", () => {
    const filler = "Company history and values. ".repeat(20);
    const lead = {
      company_name: "Example Company",
      title: "Head of Partnerships",
      description_raw: `${filler} Later on: work with our AI engineer and data engineer teams on machine learning.`,
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
    };
    expect(assessCandidateLanes(lead, ["CORE_AI_DATA"], plans, lanes)[0]).toMatchObject({ matched: true });
    expect(assessCandidateLanes(lead, ["CORE_AI_DATA"], plans, lanes, [], tier1)[0])
      .toMatchObject({ matched: false, reasonCode: "PRESCREEN_ROLE_OUTSIDE_LEAD" });
    const technicalTitle = { ...lead, title: "Staff Engineer, Infrastructure" };
    expect(assessCandidateLanes(technicalTitle, ["CORE_AI_DATA"], plans, lanes, [], tier1)[0]).toMatchObject({ matched: true });
  });

  it("requires the role term in the title for title-only sources (Jobicy)", () => {
    const posting = {
      company_name: "Example Company",
      title: "Alliances Leader",
      description_raw: "Work with the data engineer and AI engineer teams on machine learning platform partnerships.",
      location_raw: "Remote",
      workplace_type_raw: "REMOTE",
    };
    expect(assessCandidateLanes(posting, ["CORE_AI_DATA"], plans, lanes, [], { ...tier1, roleInTitleOnly: false })[0]).toMatchObject({ matched: true });
    expect(assessCandidateLanes(posting, ["CORE_AI_DATA"], plans, lanes, [], { ...tier1, roleInTitleOnly: true })[0])
      .toMatchObject({ matched: false, reasonCode: "PRESCREEN_ROLE_OUTSIDE_LEAD" });
    expect(assessCandidateLanes({ ...posting, title: "Senior Data Engineer" }, ["CORE_AI_DATA"], plans, lanes, [], { ...tier1, roleInTitleOnly: true })[0])
      .toMatchObject({ matched: true });
  });
});
