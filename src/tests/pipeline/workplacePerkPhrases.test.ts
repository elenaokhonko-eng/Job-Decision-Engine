import { describe, expect, it, vi } from "vitest";
import { neutralizeWorkplacePerkPhrases } from "../../pipeline/workplacePerkPhrases.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";
import { applyGlobalGates, evaluateWorkability } from "../../services/criteria.js";
import { enrichWorkModeIfNeeded, extractWorkModeFromText } from "../../services/workModeEnrichment.js";
import { extractDeterministicRequirements } from "../../requirements/deterministicExtractors.js";
import { parseWhoIsHiringComment, prefilterWhoIsHiringPost, type HnItem } from "../../ingestion/adapters/hackerNewsWhoIsHiringAdapter.js";
import { fetchJobContent, type JobContentResult } from "../../ingestion/jobContentFetcher.js";
import { loadWorkabilityPolicy, mergeWorkabilityPreferenceContent } from "../../pipeline/workabilityPolicy.js";
import { HN_FIXTURE_THREAD_ID, hnComment } from "../fixtures/hackerNewsWhoIsHiring.js";
import {
  KNOWN_FALSE_ACCEPTS,
  ROUND_3_NOT_ONSITE,
  ROUND_4_NOT_ONSITE,
  ROUND_4_OFFICE_DAYS,
  ROUND_4_ONSITE,
  SEPARATOR_OR_LABEL_PERKS,
  SWEEP_FORMS,
  SWEEP_FULL_DAYS,
  SWEEP_NEGATIONS,
  SWEEP_NOUNS,
  SWEEP_NOUN_FORMS,
  SWEEP_PARTIAL_DAYS,
  SWEEP_PERKS,
  SWEEP_VALUE_FORMS,
} from "../fixtures/onsiteProbeCorpus.js";

// Deterministic, synthetic postings. A workplace perk is never work-mode
// evidence; a genuine work-mode statement stays one even when a perk follows.
const TECH = "You will build LLM evaluation pipelines and RAG systems in Python and PyTorch.";

function gate(description: string, workplaceType = "UNKNOWN", policy = loadWorkabilityPolicy()) {
  return applyGlobalGates({
    id: "perk-fixture",
    title: "Machine Learning Engineer",
    company_name: "Example Analytics",
    raw_description: description,
    location: "Singapore",
    workplace_type: workplaceType,
    employment_type: "PERMANENT",
  } as any, policy);
}

function requirementsFor(description: string) {
  return extractDeterministicRequirements({
    canonical_job_id: "11111111-1111-4111-8111-111111111111",
    job_version_id: "22222222-2222-4222-8222-222222222222",
    description_text: description,
  }).requirements;
}

async function enrichSingapore(description: string, cachedWorkplaceType?: string) {
  const pool: any = {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM work_mode_enrichments") && cachedWorkplaceType) {
        return { rows: [{ workplace_type: cachedWorkplaceType, office_days_min: null, office_days_max: null, attendance_basis: "UNKNOWN", territory_restriction: null, work_auth_restriction: null, evidence_quote: null, source_type: "STORED_DESCRIPTION", status: "GENUINELY_UNKNOWN" }] };
      }
      return { rows: [] };
    }),
  };
  const context = { workspaceId: "ws-test", workspaceKey: "default", userId: "u1", userKey: "k1", role: "OWNER" };
  return enrichWorkModeIfNeeded(pool, context as any, {
    canonical_job_id: "job-sg-perk",
    job_version_id: "jv-sg-perk",
    location: "Singapore",
    workplace_type: "UNKNOWN",
    description_text: description,
  }, { readOnly: true });
}

const POSTING_URL = "https://careers.exampleanalytics.example/jobs/synthetic-ml-engineer-4100000002/";

async function employerPage(workModeLine: string): Promise<JobContentResult> {
  const html = [
    "<!DOCTYPE html><html><head><title>Machine Learning Engineer | Example Analytics</title></head><body>",
    "<h1>Machine Learning Engineer</h1>",
    "<p>Example Analytics is hiring a machine learning engineer to build synthetic evaluation pipelines for deterministic tests.</p>",
    "<p><strong>Responsibilities</strong></p>",
    "<ul><li>Design, build and operate LLM evaluation pipelines and retrieval systems in Python and PyTorch.</li>",
    "<li>Own model quality metrics, review architecture decisions and mentor engineers across the platform team.</li>",
    "<li>Partner with product and risk stakeholders to plan quarterly delivery of the evaluation roadmap.</li></ul>",
    "<p><strong>Requirements</strong></p>",
    "<ul><li>5+ years of experience in machine learning engineering or data platform engineering roles.</li>",
    "<li>Strong written communication and stakeholder management skills in a regulated environment.</li></ul>",
    `<p>${workModeLine}</p>`,
    "</body></html>",
  ].join("\n");
  return fetchJobContent(POSTING_URL, { title: "Machine Learning Engineer", companyName: "Example Analytics" }, {
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchOnce: async (url) => ({
      url: url.toString(),
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(html, "utf8"),
    }),
  });
}

function postingWorkplaceType(result: JobContentResult): string {
  if (result.kind !== "COMPLETE") throw new Error("Expected COMPLETE, got " + JSON.stringify(result));
  return String((result.posting as any).workplaceType);
}

/**
 * The gate status; a HARD_REJECT for a reason other than the on-site work model
 * (e.g. a London job outside the authorized regions) is reported as
 * "HARD_REJECT_OTHER", so the probes test only the on-site rules.
 */
function gateAt(description: string, workplaceType: string, location: string): string {
  const result = applyGlobalGates({
    id: "perk-fixture",
    title: "Machine Learning Engineer",
    company_name: "Example Analytics",
    raw_description: description,
    location,
    workplace_type: workplaceType,
    employment_type: "PERMANENT",
  } as any, loadWorkabilityPolicy());
  if (result.status === "HARD_REJECT" && !result.rejection_codes.includes("GATE_HIGH_OFFICE_DAYS")) return "HARD_REJECT_OTHER";
  return result.status;
}

async function enrichAt(description: string, location: string) {
  const pool: any = { query: vi.fn().mockImplementation(async () => ({ rows: [] })) };
  const context = { workspaceId: "ws-test", workspaceKey: "default", userId: "u1", userKey: "k1", role: "OWNER" };
  return enrichWorkModeIfNeeded(pool, context as any, {
    canonical_job_id: "job-probe",
    job_version_id: "jv-probe",
    location,
    workplace_type: "UNKNOWN",
    description_text: description,
  }, { readOnly: true });
}

/** One probe line through enrich-then-gate, the gate with stored HYBRID / ASSUMED_HYBRID / UNKNOWN, and the fetcher. */
async function allPaths(line: string, location = "Singapore") {
  const description = `${TECH}\n${line}`;
  const enriched = await enrichAt(description, location);
  return {
    enriched: enriched.workplace_type,
    enrichThenGate: gateAt(description, enriched.workplace_type, location),
    hybrid: gateAt(description, "HYBRID", location),
    assumed: gateAt(description, "ASSUMED_HYBRID", location),
    unknown: gateAt(description, "UNKNOWN", location),
    remote: gateAt(description, "REMOTE", location),
    fetched: postingWorkplaceType(await employerPage(line)),
  };
}

// Review of #177: a perk that follows a genuine statement on the same line
// must not erase the statement. Each line read as on-site on main.
const STATEMENTS_WITH_TRAILING_PERK = [
  "5 days on-site meals provided",
  "Work 5 days in office free lunch daily",
  "5 days per week onsite canteen access",
  "This role is on-site facilities based",
  "Work on-site facilities daily",
];


describe("workplace perk phrases are neutral", () => {
  it("blanks only an on-site token that modifies a perk noun, preserving length", () => {
    for (const text of [
      "• Onsite gym", "Perks: on-site cafe, free lunch", "onsite cafeteria", "on-site parking",
      "onsite childcare", "on-site canteen", "onsite medical clinic", "on-site wellness",
      "on-site amenities", "onsite facilities", "on-site pantry", "free parking on-site", "in-office snacks",
    ]) {
      const neutral = neutralizeWorkplacePerkPhrases(text);
      expect(neutral).toHaveLength(text.length);
      expect(neutral).not.toMatch(/on[- ]?site|in[- ]?office/i);
    }
  });

  it("leaves genuine work-mode and lab statements unchanged", () => {
    for (const text of [
      "This role is onsite.", "5 days in office", "Fully on-site", "fully onsite gym", "100% onsite",
      "100 % onsite gym", "strictly onsite canteen", "entirely on-site cafe",
      "Hybrid", "Remote", "Wet lab work", "lab-based role", "laboratory-based role",
      "Location: On-site\nParking available", "on-site clinic-based role", "parking on-site only",
      ...STATEMENTS_WITH_TRAILING_PERK,
    ]) {
      expect(neutralizeWorkplacePerkPhrases(text)).toBe(text);
    }
  });

  it("R1: blanks a perk after a separator or a label", () => {
    for (const text of SEPARATOR_OR_LABEL_PERKS) {
      const neutral = neutralizeWorkplacePerkPhrases(text.toLowerCase());
      expect(neutral).toHaveLength(text.length);
      expect(neutral).not.toMatch(/on[- ]?site/i);
    }
  });

  describe("a perk after a genuine statement keeps the statement on-site", () => {
    // Text extraction reads the first three as employer-stated ON-SITE. It has
    // no "role is / work on-site" rule, so the last two stay UNKNOWN, and the
    // Singapore assumed-hybrid default is not applied to them (owner rule
    // 2026-11); the gate rejects all five.
    const ENRICHED_AS = ["ONSITE", "ONSITE", "ONSITE", "UNKNOWN", "UNKNOWN"];
    STATEMENTS_WITH_TRAILING_PERK.forEach((line, index) => {
      it(`"${line}" stays HARD_REJECT and is never an assumed hybrid`, async () => {
        const description = `${TECH} ${line}`;
        const result = gate(description);
        expect(result.status).toBe("HARD_REJECT");
        expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
        const enriched = await enrichSingapore(description);
        expect(enriched.workplace_type).toBe(ENRICHED_AS[index]);
        if (ENRICHED_AS[index] === "ONSITE") expect(enriched.attendance_basis).toBe("EMPLOYER_STATED");
        // Enrich-then-gate order, as in hardGate.ts.
        expect(gate(description, enriched.workplace_type).status).toBe("HARD_REJECT");
      });
    });

    it("rejects a perk plus a separate 'role is onsite' sentence in Singapore (no assumed hybrid)", async () => {
      const description = `${TECH}\nPerks: onsite gym and free lunch.\nThis role is onsite.`;
      const enriched = await enrichSingapore(description);
      expect(enriched.workplace_type).not.toBe("ASSUMED_HYBRID");
      const result = gate(description, enriched.workplace_type);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toEqual(expect.arrayContaining(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"]));
      expect(gate(description, "ASSUMED_HYBRID").status).toBe("HARD_REJECT");
    });

    it("keeps the office-day requirement when a perk follows the day count", () => {
      const office = requirementsFor(`${TECH} 5 days per week onsite canteen access.`)
        .find((r) => r.requirement_type === "OFFICE_DAYS");
      expect(office?.structured_value).toEqual({ office_days_per_week: 5 });
    });
  });

  it("keeps a hybrid posting that lists an onsite gym hybrid and PASS", () => {
    const description = `${TECH}\nHybrid working, 2 days per week in the office.\nBenefits:\n• Onsite gym\n• Free lunch`;
    const result = gate(description);
    expect(result.status).toBe("PASS");
    expect(result.rejection_codes).toEqual([]);
    expect(extractWorkModeFromText(description).workplace_type).toBe("HYBRID");
    expect(evaluateWorkability("Singapore", "HYBRID", description, "PERMANENT").workable).toBe(true);
  });

  it("keeps a posting with only an on-site cafe perk UNKNOWN / NEEDS_VERIFICATION, not on-site", () => {
    const description = `${TECH}\nPerks: on-site cafe, onsite parking and an on-site wellness room.`;
    const result = gate(description);
    expect(result.status).toBe("NEEDS_VERIFICATION");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_OFFICE_DAYS");
    expect(result.rejection_codes).not.toContain("UNWORKABLE_LOCATION_MODEL");
    expect(extractWorkModeFromText(description).workplace_type).toBe("UNKNOWN");
    const workability = evaluateWorkability("Singapore", "UNKNOWN", description, "PERMANENT");
    expect(workability).toMatchObject({ workable: true, needsVerify: true, reasonCode: "GATE_UNKNOWN_WORK_MODE" });
  });

  it("still reads a genuine fully onsite statement as on-site", () => {
    const description = `${TECH}\nThis position is fully onsite. Perks include an onsite gym.`;
    const result = gate(description);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
    expect(extractWorkModeFromText(description).workplace_type).toBe("ONSITE");
  });

  // One test per call site: replacing any neutralizeWorkplacePerkPhrases call
  // with the identity function fails the matching test below.
  describe("call sites", () => {
    it("evaluateWorkability reads the perk-neutral text", () => {
      const result = evaluateWorkability("Singapore", "UNKNOWN", `${TECH}\nPerks: onsite gym`, "PERMANENT");
      expect(result.reasonCode).toBe("GATE_UNKNOWN_WORK_MODE");
    });

    it("applyGlobalGates office-day block reads the perk-neutral text", () => {
      const onsitePolicy = mergeWorkabilityPreferenceContent(loadWorkabilityPolicy(), {
        hard_constraints: { work_modes: ["REMOTE", "HYBRID", "ONSITE"] },
      });
      // An accepted on-site role whose only "in-office" mention is a perk is not
      // an ambiguous office expectation.
      expect(gate(`${TECH}\nPerks: in-office snacks.`, "ONSITE", onsitePolicy).status).toBe("PASS");
      expect(gate(`${TECH}\nOffice expectations to be discussed.`, "ONSITE", onsitePolicy).status).toBe("NEEDS_VERIFICATION");
    });

    it("extractWorkModeFromText reads the perk-neutral text", () => {
      expect(extractWorkModeFromText(`${TECH}\nPerks: on-site cafe`).workplace_type).toBe("UNKNOWN");
    });

    it("Singapore enrichment (via extractWorkModeFromText) applies the assumed-hybrid default to a perk-only posting", async () => {
      const enriched = await enrichSingapore(`${TECH}\nPerks: onsite gym`);
      expect(enriched.workplace_type).toBe("ASSUMED_HYBRID");
    });

    it("normalizeWorkMode reads the perk-neutral value", () => {
      expect(normalizeWorkMode("Onsite parking")).toBe("UNKNOWN");
      expect(normalizeWorkMode("On-site")).toBe("ONSITE");
    });

    it("the deterministic OFFICE_DAYS extractor reads the perk-neutral text", () => {
      expect(requirementsFor(`${TECH} Our onsite gym is open 5 days a week.`)
        .find((r) => r.requirement_type === "OFFICE_DAYS")).toBeUndefined();
    });

    it("the HN header work-mode reader and pre-filter read the perk-neutral header", () => {
      const parsed = parseWhoIsHiringComment(
        hnComment(3_000, "Acme | Data Engineer | Austin, TX | Onsite gym | Full-time") as unknown as HnItem,
        HN_FIXTURE_THREAD_ID,
      );
      if (parsed.kind !== "POSTING") throw new Error("fixture post must parse");
      expect(parsed.post.workMode).toBe("UNKNOWN");
      expect(prefilterWhoIsHiringPost(parsed.post, loadWorkabilityPolicy())).toBeNull();

      const onsite = parseWhoIsHiringComment(
        hnComment(3_001, "Acme | Data Engineer | Austin, TX | ONSITE | Full-time") as unknown as HnItem,
        HN_FIXTURE_THREAD_ID,
      );
      if (onsite.kind !== "POSTING") throw new Error("fixture post must parse");
      expect(onsite.post.workMode).toBe("ONSITE");
    });

    it("the HN header classifier does not keep a perk segment as location text", () => {
      const parsed = parseWhoIsHiringComment(
        hnComment(3_002, "Acme | Data Engineer | Austin, TX | Onsite gym") as unknown as HnItem,
        HN_FIXTURE_THREAD_ID,
      );
      if (parsed.kind !== "POSTING") throw new Error("fixture post must parse");
      expect(parsed.post.locationRaw).toBe("Austin, TX");
    });

    it("the employer-page fetcher does not read a perk as on-site", async () => {
      expect(postingWorkplaceType(await employerPage("Perks: on-site gym and free lunch."))).toBe("UNKNOWN");
      expect(postingWorkplaceType(await employerPage("Location: On-site Parking available."))).toBe("UNKNOWN");
      expect(postingWorkplaceType(await employerPage("Location: On-site."))).toBe("ONSITE");
    });
  });
});

// Owner rule (2026-11): for a Singapore-located job any explicit on-site
// statement means on-site (not hybrid, no work from home). It overrides the
// assumed-hybrid default and the gate rejects it unless an on-site exception
// applies. Workplace perks stay neutral.
describe("Singapore explicit on-site statements override the assumed-hybrid default", () => {
  const SINGAPORE_ONSITE_STATEMENTS = [
    "This role is on-site facilities based",
    "Work on-site facilities daily",
    "This role is on-site.",
    "On-site, facilities based.",
    "Work on-site at our facilities daily.",
    "This is an on-site role.",
    "You will be based on-site at our Jurong campus.",
    "You must be on-site.",
    "This is an office-based role.",
    "5 days in office.",
    "Fully on-site.",
    "Location: On-site",
    "Engineering | Onsite | Full-time",
  ];

  for (const line of SINGAPORE_ONSITE_STATEMENTS) {
    it(`"${line}" is on-site: no assumed hybrid, HARD_REJECT`, async () => {
      const description = `${TECH}\n${line}`;
      const enriched = await enrichSingapore(description);
      expect(enriched.workplace_type).not.toBe("ASSUMED_HYBRID");
      const cached = await enrichSingapore(description, "UNKNOWN");
      expect(cached.workplace_type).not.toBe("ASSUMED_HYBRID");
      for (const workplaceType of [enriched.workplace_type, "ASSUMED_HYBRID"]) {
        const result = gate(description, workplaceType);
        expect(result.status).toBe("HARD_REJECT");
        expect(result.rejection_codes).toEqual(expect.arrayContaining(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"]));
      }
    });
  }

  it("still passes a Singapore preferred-employer or research on-site job through the exception", () => {
    const description = `${TECH}\nThis is an on-site role.`;
    const preferred = { ...loadWorkabilityPolicy(), onsiteExceptionEmployers: ["Example Analytics"] };
    for (const workplaceType of ["UNKNOWN", "ASSUMED_HYBRID"]) {
      const result = gate(description, workplaceType, preferred as any);
      expect(result.status).toBe("PASS");
      expect(result.evidence_quotes.join(" ")).toContain("ON-SITE EXCEPTION (PREFERRED_EMPLOYER)");
    }
    const research = applyGlobalGates({
      id: "perk-fixture-research",
      title: "Research Engineer",
      company_name: "National University of Singapore",
      raw_description: description,
      location: "Singapore",
      workplace_type: "UNKNOWN",
      employment_type: "PERMANENT",
    } as any, loadWorkabilityPolicy());
    expect(research.status).toBe("PASS");
    expect(research.evidence_quotes.join(" ")).toContain("ON-SITE EXCEPTION (RESEARCH_ROLE)");
  });

  it("keeps perk-only Singapore lines at the assumed hybrid / NEEDS_VERIFICATION", async () => {
    for (const line of ["Perks: onsite gym", "• On-site cafe\n• Free parking", "Benefits include on-site childcare and an onsite medical clinic."]) {
      const description = `${TECH}\n${line}`;
      const enriched = await enrichSingapore(description);
      expect(enriched.workplace_type).toBe("ASSUMED_HYBRID");
      expect(gate(description, "ASSUMED_HYBRID").status).toBe("NEEDS_VERIFICATION");
      expect(gate(description, "UNKNOWN").status).toBe("NEEDS_VERIFICATION");
    }
  });

  it("does not read a partial-attendance or hybrid statement as on-site", () => {
    expect(gate(`${TECH}\nYou must be on-site 2 days a week.`).status).not.toBe("HARD_REJECT");
    expect(gate(`${TECH}\nHybrid role. This is an on-site role during onboarding.`).status).not.toBe("HARD_REJECT");
  });

  // Review of 331f128: a noun-modifier use of on-site is not a statement.
  const NOUN_MODIFIER_LINES = [
    "On-site training provided.",
    "• On-site training provided",
    "On-site client support as required.",
    "• On-site support for new hires",
    "On-site visits to partner labs.",
    "Occasional on-site meetings with stakeholders.",
    "On-site events every quarter.",
    "On-site interviews in the final round.",
    "On-site orientation in week one.",
    "• On-site induction programme",
    "Benefits: on-site parking and an onsite gym.",
  ];
  for (const line of NOUN_MODIFIER_LINES) {
    it(`"${line}" is not an on-site statement (Singapore and elsewhere)`, async () => {
      const description = `${TECH}\n${line}`;
      for (const workplaceType of ["UNKNOWN", "ASSUMED_HYBRID"]) {
        expect(gate(description, workplaceType).status).toBe("NEEDS_VERIFICATION");
      }
      const enriched = await enrichSingapore(description);
      expect(enriched.workplace_type).toBe("ASSUMED_HYBRID");
      expect(extractWorkModeFromText(description).workplace_type).toBe("UNKNOWN");
      const london = evaluateWorkability("London, United Kingdom", "UNKNOWN", description, "PERMANENT");
      expect(london.reasonCode).not.toBe("GATE_HIGH_OFFICE_DAYS");
    });
  }

  it("does not read a noun-modifier on-site mention on an employer page as on-site", async () => {
    expect(postingWorkplaceType(await employerPage("On-site training provided."))).toBe("UNKNOWN");
    expect(postingWorkplaceType(await employerPage("This role is on-site."))).toBe("ONSITE");
  });

  // Review of 331f128: a 1-3 day count after any Singapore form is partial
  // attendance (hybrid); 4-5 days or "daily" is on-site.
  const SINGAPORE_FORMS = [
    "On-site role",
    "Office-based role",
    "This role is on-site",
    "You must be on-site",
    "Work on-site at our office",
    "Location: On-site",
    "Engineering | On-site",
    "On-site",
  ];
  for (const form of SINGAPORE_FORMS) {
    for (const days of ["1 day a week", "2 days", "3 days a week", "1-3 days per week"]) {
      it(`"${form}, ${days}" is partial attendance, not a hard reject`, async () => {
        const description = `${TECH}\n${form}, ${days}.`;
        const enriched = await enrichSingapore(description);
        expect(gate(description, enriched.workplace_type).status).not.toBe("HARD_REJECT");
      });
    }
    for (const days of ["4 days a week", "5 days a week", "daily"]) {
      it(`"${form}, ${days}" is on-site: HARD_REJECT`, async () => {
        const description = `${TECH}\n${form}, ${days}.`;
        const enriched = await enrichSingapore(description);
        expect(enriched.workplace_type).not.toBe("ASSUMED_HYBRID");
        expect(gate(description, enriched.workplace_type).status).toBe("HARD_REJECT");
        expect(gate(description, "ASSUMED_HYBRID").status).toBe("HARD_REJECT");
      });
    }
  }

  it("applies the Singapore-only forms to Singapore jobs only", () => {
    const london = evaluateWorkability("London, United Kingdom", "UNKNOWN", `${TECH}\nThis is an on-site role.`, "PERMANENT");
    expect(london.reasonCode).not.toBe("GATE_HIGH_OFFICE_DAYS");
  });
});

// Review of b2ce10d.
describe("separator and label on-site values (review of b2ce10d)", () => {
  it("B1: a noun after a header separator or label is not an on-site value", async () => {
    for (const line of [
      "Full-time · On-site training provided",
      "Engineering | On-site training",
      "Location: On-site training provided",
      "Work model: On-site client support",
    ]) {
      const description = `${TECH}\n${line}`;
      const enriched = await enrichSingapore(description);
      expect(enriched.workplace_type).toBe("ASSUMED_HYBRID");
      expect(gate(description, "ASSUMED_HYBRID").status).toBe("NEEDS_VERIFICATION");
      expect(gate(description, "UNKNOWN").status).toBe("NEEDS_VERIFICATION");
      expect(postingWorkplaceType(await employerPage(line))).toBe("UNKNOWN");
    }
  });

  it("R1: a perk after a separator or a label is neutral in every path", async () => {
    for (const line of SEPARATOR_OR_LABEL_PERKS) {
      const result = await allPaths(line);
      expect(result, line).toMatchObject({ enriched: "ASSUMED_HYBRID", enrichThenGate: "NEEDS_VERIFICATION", assumed: "NEEDS_VERIFICATION", unknown: "NEEDS_VERIFICATION", fetched: "UNKNOWN" });
      expect(result.hybrid, line).not.toBe("HARD_REJECT");
    }
  });

  it("a header or label value without a perk stays on-site", async () => {
    for (const line of ["Engineering | Onsite", "Location: On-site.", "Full-time · On-site"]) {
      const description = `${TECH}\n${line}`;
      expect(extractWorkModeFromText(description).workplace_type, line).toBe("ONSITE");
      expect(gate(description, "ASSUMED_HYBRID").status, line).toBe("HARD_REJECT");
    }
  });

  it("B2: enrichment does not store 'Work model: On-site, 2 days a week' as 5-day on-site", async () => {
    for (const line of ["Work model: On-site, 2 days a week", "Workplace: On-site, 2 days a week", "Workplace type: Onsite, 3 days per week"]) {
      const description = `${TECH}\n${line}`;
      expect(extractWorkModeFromText(description).workplace_type).not.toBe("ONSITE");
      const enriched = await enrichSingapore(description);
      expect(enriched.workplace_type).not.toBe("ONSITE");
      expect(gate(description, enriched.workplace_type).status).not.toBe("HARD_REJECT");
    }
  });

  it("4 or more days on-site rejects even with a noun between", async () => {
    for (const line of ["You'll be on-site with clients 4 days a week.", "You will be on-site at client premises 5 days a week.", "Expect to be on-site with the team daily."]) {
      const description = `${TECH}\n${line}`;
      const enriched = await enrichSingapore(description);
      expect(enriched.workplace_type).not.toBe("ASSUMED_HYBRID");
      expect(gate(description, enriched.workplace_type).status).toBe("HARD_REJECT");
      expect(evaluateWorkability("London, United Kingdom", "UNKNOWN", description, "PERMANENT").reasonCode).toBe("GATE_HIGH_OFFICE_DAYS");
    }
  });

  it("a hedged or generic 4+ day mention is not a statement about this job", () => {
    const description = `${TECH}\nWorkplace and information technology positions may require onsite attendance 5 days per week as will be indicated in the job posting.`;
    expect(evaluateWorkability("Boston, MA", "UNKNOWN", description, "PERMANENT").reasonCode).not.toBe("GATE_HIGH_OFFICE_DAYS");
    expect(evaluateWorkability("Boston, MA", "UNKNOWN", `${TECH}\nYou may be on-site 5 days a week during launches.`, "PERMANENT").reasonCode).not.toBe("GATE_HIGH_OFFICE_DAYS");
  });
});

// Property-style sweep: every on-site form x every excluded noun x each day
// count x each negation, through enrich-then-gate, the gate with stored
// HYBRID / ASSUMED_HYBRID / UNKNOWN, work-mode enrichment and the fetcher.
describe("on-site statement property sweep", () => {
  // Hundreds of in-memory probes per test; allow for a loaded CI runner.
  const SWEEP_TIMEOUT_MS = 120_000;
  const rejects = (r: Awaited<ReturnType<typeof allPaths>>) =>
    [r.enrichThenGate, r.hybrid, r.assumed, r.unknown].includes("HARD_REJECT") || r.enriched === "ONSITE" || r.fetched === "ONSITE";

  it("a noun-modifier or perk use never rejects, with or without a day count", async () => {
    const failures: string[] = [];
    for (const formAt of SWEEP_NOUN_FORMS) {
      for (const noun of SWEEP_NOUNS) {
        for (const days of ["", ", 2 days", ", 5 days a week"]) {
          const line = formAt(` ${noun} provided${days}`);
          const result = await allPaths(`${line}.`);
          if (rejects(result)) failures.push(`${line} => ${JSON.stringify(result)}`);
        }
      }
    }
    for (const formAt of SWEEP_VALUE_FORMS) {
      for (const perk of SWEEP_PERKS) {
        for (const days of ["", ", 2 days", ", 5 days a week"]) {
          const line = formAt(` ${perk} available${days}`);
          const result = await allPaths(`${line}.`);
          if (rejects(result)) failures.push(`${line} => ${JSON.stringify(result)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it("1-3 days (digits or words) is partial attendance and 4-5 days or daily is on-site, for every form", async () => {
    const failures: string[] = [];
    for (const formAt of SWEEP_FORMS) {
      for (const days of SWEEP_PARTIAL_DAYS) {
        const line = formAt(`, ${days}`);
        const result = await allPaths(`${line}.`);
        if (rejects(result)) failures.push(`partial ${line} => ${JSON.stringify(result)}`);
      }
      for (const days of ["", ...SWEEP_FULL_DAYS.map((d) => `, ${d}`)]) {
        const line = formAt(days);
        const result = await allPaths(`${line}.`);
        if (result.enrichThenGate !== "HARD_REJECT" || result.assumed !== "HARD_REJECT" || result.enriched === "ASSUMED_HYBRID") {
          failures.push(`full ${line} => ${JSON.stringify(result)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, SWEEP_TIMEOUT_MS);

  it("a negated, optional or temporary form never rejects", async () => {
    const failures: string[] = [];
    for (const formAt of SWEEP_FORMS) {
      for (const negate of SWEEP_NEGATIONS) {
        const line = negate(formAt(""));
        const result = await allPaths(`${line}.`);
        if (rejects(result)) failures.push(`${line} => ${JSON.stringify(result)}`);
      }
    }
    expect(failures).toEqual([]);
  }, SWEEP_TIMEOUT_MS);
});

// Review round 3 (R2-R6): every reviewer input, through enrich-then-gate, the
// gate with stored HYBRID, ASSUMED_HYBRID and UNKNOWN, and the fetcher. None of
// these may hard-reject in any path.

describe("review round 3: negated, hedged, temporary, listed and partial statements", () => {
  for (const { line, location } of ROUND_3_NOT_ONSITE) {
    it(`${JSON.stringify(line)} (${location}) never hard-rejects`, async () => {
      const result = await allPaths(line, location);
      for (const path of ["enrichThenGate", "hybrid", "assumed", "unknown"] as const) {
        expect(result[path], `${path}: ${JSON.stringify(result)}`).not.toBe("HARD_REJECT");
      }
      expect(result.enriched).not.toBe("ONSITE");
      expect(result.fetched).not.toBe("ONSITE");
    });
  }

  it("R6: enrichment stores 'Location: On-site, two days a week' as hybrid with 2 office days", () => {
    expect(extractWorkModeFromText(`${TECH}
Location: On-site, two days a week`)).toMatchObject({
      workplace_type: "HYBRID", office_days_min: 2, office_days_max: 2, attendance_basis: "EMPLOYER_STATED",
    });
    expect(extractWorkModeFromText(`${TECH}
On-site one to three days a week.`)).toMatchObject({ workplace_type: "HYBRID", office_days_min: 1, office_days_max: 3 });
  });

  it("affirmative, permanent full on-site statements still reject", async () => {
    for (const line of [
      "You'll be on-site with clients 4 days a week.",
      "You must be on-site.",
      "This is an on-site role.",
      "Location: On-site",
      "On-site, five days a week.",
      "You will work on-site with clients five days a week.",
    ]) {
      const result = await allPaths(line);
      expect(result.enrichThenGate, line).toBe("HARD_REJECT");
      expect(result.assumed, line).toBe("HARD_REJECT");
    }
  });
});

// Review round 4: N1-N4 never reject; negation is scoped to the statement it
// governs; the posting-wide hybrid/remote skip ignores negated modes,
// equal-opportunity lines and company history.
describe("review round 4: subject, partial attendance, project phases and negation scope", () => {
  for (const { line, location } of ROUND_4_NOT_ONSITE) {
    it(`${JSON.stringify(line)} (${location}) never hard-rejects`, async () => {
      const result = await allPaths(line, location);
      for (const path of ["enrichThenGate", "hybrid", "assumed", "unknown", "remote"] as const) {
        expect(result[path], `${path}: ${JSON.stringify(result)}`).not.toBe("HARD_REJECT");
      }
      expect(result.enriched).not.toBe("ONSITE");
      expect(result.fetched).not.toBe("ONSITE");
    });
  }

  it("N4: a third-party sentence with a stored assumed hybrid stays NEEDS_VERIFICATION, as on main", () => {
    for (const { line } of ROUND_4_NOT_ONSITE.filter((probe) => /nurses|clinicians|operations team|field engineers|manufacturing/i.test(probe.line))) {
      expect(gateAt(`${TECH}
${line}`, "ASSUMED_HYBRID", "Singapore"), line).toBe("NEEDS_VERIFICATION");
    }
  });

  for (const line of ROUND_4_ONSITE) {
    it(`${JSON.stringify(line)} is an affirmative on-site statement`, async () => {
      const result = await allPaths(line);
      expect(result.enrichThenGate, JSON.stringify(result)).toBe("HARD_REJECT");
      expect(result.unknown, JSON.stringify(result)).toBe("HARD_REJECT");
      expect(result.assumed, JSON.stringify(result)).toBe("HARD_REJECT");
    });
  }

  it("enrichment of a 4+ day statement with a remote day stores the on-site days", () => {
    for (const [line, days] of ROUND_4_OFFICE_DAYS) {
      expect(extractWorkModeFromText(`${TECH}
${line}`), line).toMatchObject({ workplace_type: "ONSITE", office_days_min: days, office_days_max: days });
    }
  });
});

describe("known false accepts (non-blocking)", () => {
  for (const { line, location } of KNOWN_FALSE_ACCEPTS) {
    it(`${JSON.stringify(line)} is not hard-rejected (stays PASS or NEEDS_VERIFICATION)`, async () => {
      const result = await allPaths(line, location);
      expect(result.unknown, JSON.stringify(result)).not.toBe("HARD_REJECT");
    });
  }
});
