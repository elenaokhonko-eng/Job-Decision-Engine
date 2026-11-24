import { describe, expect, it } from "vitest";

import { assessEvidenceConfidence } from "../../pipeline/recommendationDecider.js";
import { MIN_CONFIRMED_REQUIREMENTS } from "../../requirements/requirementKinds.js";

describe("evidence confidence for thin postings", () => {
  it("is LOW below the confirmed-requirement minimum and NORMAL at or above it", () => {
    expect(assessEvidenceConfidence(0)).toMatchObject({ level: "LOW", reason: "THIN_POSTING", requirement_count: 0 });
    expect(assessEvidenceConfidence(MIN_CONFIRMED_REQUIREMENTS - 1).level).toBe("LOW");
    expect(assessEvidenceConfidence(MIN_CONFIRMED_REQUIREMENTS)).toMatchObject({ level: "NORMAL", reason: null });
  });

  it("is NORMAL when there is no current match to count (nothing is claimed about confidence)", () => {
    expect(assessEvidenceConfidence(null)).toMatchObject({ level: "NORMAL", requirement_count: null });
  });
});

describe("applyThinPostingCap", () => {
  it("lowers only PRIORITY, only for LOW confidence", async () => {
    const { applyThinPostingCap } = await import("../../pipeline/recommendationDecider.js");
    expect(applyThinPostingCap("PRIORITY", { level: "LOW" })).toBe("REVIEW");
    expect(applyThinPostingCap("PRIORITY", { level: "NORMAL" })).toBe("PRIORITY");
    expect(applyThinPostingCap("REVIEW", { level: "LOW" })).toBe("REVIEW");
    expect(applyThinPostingCap("TRACK", { level: "LOW" })).toBe("TRACK");
  });
});

describe("deciderVersionRefreshSql only selects jobs the decider will process", () => {
  it("requires a live job and, unless fixtures are included, a non-fixture job", async () => {
    const { deciderVersionRefreshSql } = await import("../../pipeline/deciderVersion.js");
    const normal = deciderVersionRefreshSql("c");
    expect(normal).toContain("c.archived_at IS NULL");
    expect(normal).toContain("c.is_test_fixture IS NOT TRUE");
    const withFixtures = deciderVersionRefreshSql("c", { includeTestFixtures: true });
    expect(withFixtures).toContain("c.archived_at IS NULL");
    expect(withFixtures).not.toContain("is_test_fixture");
  });
});
