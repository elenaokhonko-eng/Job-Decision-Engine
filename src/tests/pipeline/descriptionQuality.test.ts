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
      reason: "DESCRIPTION_BELOW_1000_CHAR_COMPLETENESS_FLOOR",
    });
  });

  it("does not mark a complete posting as incomplete", () => {
    expect(classifyDescriptionQuality("x".repeat(MIN_COMPLETE_DESCRIPTION_CHARS))).toEqual({
      status: "COMPLETE",
      reason: null,
    });
  });
});
