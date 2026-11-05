import { describe, expect, it } from "vitest";
import { assertApplicationDocumentPairCurrent } from "../../documents/documentPairPolicy.js";

describe("assertApplicationDocumentPairCurrent", () => {
  it("allows a current pair and rejects a stale or unlinked pair when required", () => {
    expect(() => assertApplicationDocumentPairCurrent(true, true)).not.toThrow();
    expect(() => assertApplicationDocumentPairCurrent(false, true)).toThrow(/not current and linked/i);
  });

  it("keeps non-enforcing inspection mode available for historical reports", () => {
    expect(() => assertApplicationDocumentPairCurrent(false, false)).not.toThrow();
  });
});
