import { describe, expect, it } from "vitest";

import { normalizeJobIdentity } from "../../../modules/catalog/index.js";

const employer = (company: string) => normalizeJobIdentity({ company, location: null }).employer;
const location = (value: string | null) => normalizeJobIdentity({ company: null, location: value }).location;

describe("job identity names", () => {
  it.each([
    "Acme", "ACME", "Acme Pte Ltd", "Acme Pte. Ltd.", "Acme PTE.LTD.", "Acme (Pte) Ltd", "Acme Private Limited", "Acme, Inc.",
    "Acme Inc", "Acme Incorporated", "Acme Ltd", "Acme Ltd.", "Acme Limited", "Acme LLC", "Acme L.L.C.", "Acme LLP", "Acme PLC",
    "Acme Corp.", "Acme Corporation", "Acme Co.", "Acme Co., Ltd.", "Acme & Co", "Acme GmbH", "Acme B.V.", "Acme Pty Ltd",
    "Acme Pvt Ltd", "Acme Sdn Bhd", "  Acme   Pte   Ltd  ",
  ])("reads %j as the employer Acme", (name) => {
    expect(employer(name)).toBe("acme");
  });

  it.each([
    ["Acme", "Acme Labs"], ["Acme", "Acme Group"], ["Acme", "Acme Holdings Pte Ltd"], ["Acme", "Acme Singapore Pte Ltd"],
    ["Acme", "Acme Technologies"], ["Acme", "Acme AB"], ["Blue", "Blue Spa"], ["Banco", "Banco SA"], ["Acme", "Acme Company"],
    ["Ltd Commodities", "Commodities"], ["Inc Research", "Research"], ["Acme", "Acme+"], ["Smith and Sons", "Smith"],
    ["AB Co", "A B"], ["Acme", "Acne"],
  ])("keeps %j and %j apart", (a, b) => {
    expect(employer(a)).not.toBe(employer(b));
  });

  it("never strips a name to nothing, and keeps names in other scripts", () => {
    expect(employer("Limited")).toBe("limited");
    expect(employer("Pte Ltd")).toBe("pte");
    expect(employer("Nestlé S.A.")).toBe("nestle sa");
    expect(employer("株式会社テスト")).not.toBe("");
    expect(employer("カ")).not.toBe(employer("ガ"));
    expect(employer("***")).toBe("");
  });

  it.each([
    "Singapore", "singapore", "SINGAPORE ", "Singapore, Singapore", "Singapore, SG", "SG", "Singapore, SGP",
    "Singapore, Singapore, SG", "Republic of Singapore", "Singapore,",
  ])("reads %j as Singapore", (value) => {
    expect(location(value)).toBe("singapore");
  });

  it.each([
    "Kuala Lumpur", "Singapore, Central Region", "Central, Singapore", "Singapore (Hybrid)", "Singapore or Hong Kong",
    "Singapore, Hong Kong", "Remote", "SG Remote", "New York, NY", "",
  ])("does not read %j as Singapore", (value) => {
    expect(location(value)).not.toBe("singapore");
  });

  it("keeps different cities apart, and treats punctuation and unstated values alike", () => {
    expect(location("London, UK")).not.toBe(location("London, Canada"));
    expect(location("New York, NY")).toBe(location("New York NY"));
    for (const value of [null, "", "  ", "Unknown", "Not specified", "N/A"]) expect(location(value), String(value)).toBe("unknown");
  });
});
