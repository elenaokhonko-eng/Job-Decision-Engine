import { describe, expect, it } from "vitest";
import { parseGmailReconciliationLimit } from "../../../scripts/cleanup_gmail.js";

describe("Gmail reconciliation batch limit", () => {
  it("defaults to a batch large enough to classify the production alert cohort", () => {
    expect(parseGmailReconciliationLimit(undefined)).toBe(2000);
    expect(parseGmailReconciliationLimit(" ")).toBe(2000);
  });

  it("accepts a positive configured limit", () => {
    expect(parseGmailReconciliationLimit("250")).toBe(250);
  });

  it("caps the configured limit to bound API work per workflow run", () => {
    expect(parseGmailReconciliationLimit("9000")).toBe(5000);
  });

  it("rejects invalid configured limits", () => {
    expect(() => parseGmailReconciliationLimit("0")).toThrow("positive integer");
    expect(() => parseGmailReconciliationLimit("invalid")).toThrow("positive integer");
  });
});
