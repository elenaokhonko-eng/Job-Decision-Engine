import { describe, expect, it } from "vitest";
import { neutralizeWorkplacePerkPhrases } from "../../pipeline/workplacePerkPhrases.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";
import { applyGlobalGates, evaluateWorkability } from "../../services/criteria.js";
import { extractWorkModeFromText } from "../../services/workModeEnrichment.js";
import { extractDeterministicRequirements } from "../../requirements/deterministicExtractors.js";
import { parseWhoIsHiringComment, prefilterWhoIsHiringPost, type HnItem } from "../../ingestion/adapters/hackerNewsWhoIsHiringAdapter.js";
import { loadWorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";
import { HN_FIXTURE_THREAD_ID, hnComment } from "../fixtures/hackerNewsWhoIsHiring.js";

// Deterministic, synthetic postings: workplace perks must never be work-mode evidence.
const TECH = "You will build LLM evaluation pipelines and RAG systems in Python and PyTorch.";

function gate(description: string, workplaceType = "UNKNOWN") {
  return applyGlobalGates({
    id: "perk-fixture",
    title: "Machine Learning Engineer",
    company_name: "Example Analytics",
    raw_description: description,
    location: "Singapore",
    workplace_type: workplaceType,
    employment_type: "PERMANENT",
  } as any);
}

describe("workplace perk phrases are neutral", () => {
  it("blanks only the on-site token of a perk phrase, preserving length", () => {
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
      "Hybrid", "Remote", "Wet lab work", "lab-based role", "laboratory-based role",
      "Location: On-site\nParking available", "on-site clinic-based role",
    ]) {
      expect(neutralizeWorkplacePerkPhrases(text)).toBe(text);
    }
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
    expect(normalizeWorkMode("Onsite parking")).toBe("UNKNOWN");
  });

  it("still reads a genuine fully onsite statement as on-site", () => {
    const description = `${TECH}\nThis position is fully onsite. Perks include an onsite gym.`;
    const result = gate(description);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
    expect(extractWorkModeFromText(description).workplace_type).toBe("ONSITE");
    expect(normalizeWorkMode("On-site")).toBe("ONSITE");
  });

  it("does not read an office-day requirement from a perk phrase", () => {
    const result = extractDeterministicRequirements({
      canonical_job_id: "11111111-1111-4111-8111-111111111111",
      job_version_id: "22222222-2222-4222-8222-222222222222",
      description_text: `${TECH} Our onsite gym is open 5 days a week.`,
    });
    expect(result.requirements.find((r) => r.requirement_type === "OFFICE_DAYS")).toBeUndefined();
  });

  it("does not let the HN pre-filter drop a header whose only on-site mention is a perk", () => {
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
});
