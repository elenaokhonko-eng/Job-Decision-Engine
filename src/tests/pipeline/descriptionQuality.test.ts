import { describe, expect, it } from "vitest";
import {
  classifyDescriptionQuality,
  MIN_COMPLETE_DESCRIPTION_CHARS,
} from "../../pipeline/descriptionQuality.js";

describe("description quality policy", () => {
  it("classifies missing and short source text as enrichment debt", () => {
    expect(classifyDescriptionQuality("")).toEqual({
      status: "UNKNOWN",
      reason: "DESCRIPTION_MISSING",
    });
    expect(classifyDescriptionQuality("x".repeat(MIN_COMPLETE_DESCRIPTION_CHARS - 1))).toEqual({
      status: "INCOMPLETE",
      reason: "DESCRIPTION_HAS_INSUFFICIENT_SUBSTANTIVE_CONTENT",
    });
  });

  it("accepts a concise but complete posting with responsibilities and qualification sections", () => {
    const concisePosting = [
      "About the role: Build and operate a research data platform used by scientists.",
      "Responsibilities: Design services, implement data workflows, and support production releases.",
      "Requirements: Experience with Python, cloud systems, and cross-functional technical delivery.",
      "The position is full-time and based in Singapore with a hybrid work arrangement.",
    ].join(" ");

    expect(concisePosting.length).toBeLessThan(MIN_COMPLETE_DESCRIPTION_CHARS);
    expect(classifyDescriptionQuality(concisePosting)).toEqual({ status: "COMPLETE", reason: null });
  });

  it("rejects long cookie or login shells as incomplete source evidence", () => {
    const shell = `Accept all cookies. Sign in to continue. Enable JavaScript. ${"Please accept cookie preferences to continue. ".repeat(60)}`;
    expect(classifyDescriptionQuality(shell)).toMatchObject({
      status: "INCOMPLETE",
      reason: "DESCRIPTION_CONSISTS_OF_ACCESS_OR_COOKIE_SHELL",
    });
  });

  it("recognizes a substantive full-length posting as complete", () => {
    const fullPosting = [
      "About the role: Build and operate a research data platform used by scientists.",
      "Responsibilities: Design services, implement data workflows, and support production releases.",
      "Requirements: Experience with Python, cloud systems, and cross-functional technical delivery.",
    ].join(" ").repeat(8);

    expect(fullPosting.length).toBeGreaterThanOrEqual(MIN_COMPLETE_DESCRIPTION_CHARS);
    expect(classifyDescriptionQuality(fullPosting)).toEqual({ status: "COMPLETE", reason: null });
  });
});
