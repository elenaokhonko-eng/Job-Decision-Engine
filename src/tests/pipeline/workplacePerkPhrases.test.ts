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

// Review of #177: a perk that follows a genuine statement on the same line
// must not erase the statement. Each line read as on-site on main.
const STATEMENTS_WITH_TRAILING_PERK = [
  "5 days on-site meals provided",
  "Work 5 days in office free lunch daily",
  "5 days per week onsite canteen access",
  "Location: On-site Parking available",
  "Workplace type: Onsite Perks: free lunch",
  "Full-time · On-site Free parking",
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

  describe("a perk after a genuine statement keeps the statement on-site", () => {
    // Enrichment reads the first six as employer-stated ON-SITE, exactly as on
    // main. Main's text extraction has no "role is / work on-site" rule, so the
    // last two stay UNKNOWN there (and get the Singapore default, as on main);
    // the gate still rejects all eight.
    const ENRICHED_AS = ["ONSITE", "ONSITE", "ONSITE", "ONSITE", "ONSITE", "ONSITE", "ASSUMED_HYBRID", "ASSUMED_HYBRID"];
    STATEMENTS_WITH_TRAILING_PERK.forEach((line, index) => {
      it(`"${line}" stays HARD_REJECT and enriches as on main`, async () => {
        const description = `${TECH} ${line}`;
        const result = gate(description);
        expect(result.status).toBe("HARD_REJECT");
        expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
        const enriched = await enrichSingapore(description);
        expect(enriched.workplace_type).toBe(ENRICHED_AS[index]);
        if (ENRICHED_AS[index] === "ONSITE") expect(enriched.attendance_basis).toBe("EMPLOYER_STATED");
      });
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
      expect(postingWorkplaceType(await employerPage("Location: On-site Parking available."))).toBe("ONSITE");
    });
  });
});
