/**
 * gate-2026-11.12: a stale posting is not a non-negotiable (owner decision 2026-11-27). The gate
 * never rejects or holds a job for its posting age; stored freshness preferences still parse.
 * All titles and posting text here are invented.
 */
import { describe, expect, it } from "vitest";

import { GATE_VERSION } from "../../src/contracts/version.js";
import { applyPersistedRequirementGates } from "../../src/pipeline/hardGate.js";
import { FreshnessPolicySchema, Stage3WorkPreferencesSchema } from "../../src/policy/stage3Contracts.js";

const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const gate = (dates: Record<string, unknown>, disposition: "HARD_REJECT" | "DEFER" | "WARN") =>
  applyPersistedRequirementGates(
    {
      title: "Data Engineer",
      company_name: "Example Harbour Co",
      location: "Singapore",
      workplace_type: "HYBRID",
      description: "You will design data pipelines, build services in Python and own the data platform architecture.",
      ...dates,
    },
    [], undefined, null,
    Stage3WorkPreferencesSchema.parse({
      schema_version: "3.0.0",
      freshness: { max_posting_age_days: 60, stale_gate_disposition: disposition },
    }),
  );

describe("posting age is not a gate", () => {
  it("carries the new gate version", () => {
    expect(GATE_VERSION).toBe("gate-2026-11.12");
  });

  it.each(["HARD_REJECT", "DEFER", "WARN"] as const)("accepts a stored %s disposition", (disposition) => {
    expect(FreshnessPolicySchema.parse({ max_posting_age_days: 60, stale_gate_disposition: disposition }))
      .toEqual({ max_posting_age_days: 60, stale_gate_disposition: disposition });
  });

  it.each([
    ["an exact publication date", { posted_at: daysAgo(400), freshness_basis: "POSTED_AT" }],
    ["a genuine repost date", { posted_at: daysAgo(500), reposted_at: daysAgo(200), freshness_basis: "REPOSTED_AT" }],
    ["an approximate date", { posted_at: daysAgo(200), freshness_basis: "POSTED_AT_APPROXIMATE_WEEK" }],
    ["an age that may exceed the limit", { posted_at: daysAgo(58), freshness_basis: "POSTED_AT_APPROXIMATE_WEEK" }],
    ["no date", {}],
  ])("gates %s like a posting from today", (_label, dates) => {
    const today = gate({ posted_at: daysAgo(0), freshness_basis: "POSTED_AT" }, "HARD_REJECT");
    const result = gate(dates, "HARD_REJECT");
    expect(result).toEqual(today);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_STALE_POSTING");
  });
});
