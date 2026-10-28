import { describe, expect, it } from "vitest";
import {
  formatContactLine,
  requireCvContactInfo,
  resolveDocumentContactInfo,
} from "../../documents/contactInfo.js";

const contactFact = (factKey: string, kind: string, value: string) => ({
  fact_key: factKey,
  fact_type: "CONTACT",
  structured_value: { kind, value },
  verification_status: "SELF_ATTESTED",
  confidentiality: "PRIVATE_INTERNAL",
});

describe("profile graph document contact", () => {
  it("prefers current private contact facts over legacy fallback values", () => {
    const contact = resolveDocumentContactInfo(
      [
        contactFact("contact_name", "name", "Graph Candidate"),
        contactFact("contact_location", "location", "Singapore"),
        contactFact("contact_email", "email", "graph@example.invalid"),
        contactFact("contact_phone", "phone", "+6500000000"),
        contactFact("contact_linkedin", "linkedin", "https://www.linkedin.com/in/graph-candidate"),
      ],
      {
        full_name: "Legacy Candidate",
        location: "Legacy Location",
        email: "legacy@example.invalid",
        phone: "+6500000001",
      },
      "Profile Display Name",
    );

    expect(contact).toEqual({
      full_name: "Graph Candidate",
      location: "Singapore",
      email: "graph@example.invalid",
      phone: "+6500000000",
      linkedin: "https://www.linkedin.com/in/graph-candidate",
    });
  });

  it("does not use unverified or reusable model facts as contact details", () => {
    const contact = resolveDocumentContactInfo(
      [
        {
          ...contactFact("contact_phone", "phone", "+6500000000"),
          verification_status: "UNVERIFIED",
        },
        {
          ...contactFact("contact_email", "email", "public@example.invalid"),
          confidentiality: "PRIVATE_REUSABLE",
        },
      ],
      { location: "Singapore", email: "legacy@example.invalid", phone: "+6500000001" },
      "Profile Display Name",
    );

    expect(contact).toMatchObject({
      full_name: "Profile Display Name",
      location: "Singapore",
      email: "legacy@example.invalid",
      phone: "+6500000001",
    });
  });

  it("rejects a current private contact fact that violates the shared contract", () => {
    expect(() => resolveDocumentContactInfo(
      [contactFact("contact_phone", "email", "person@example.invalid")],
      null,
      "Profile Display Name",
    )).toThrow(/contact fact contract/i);
  });

  it("requires phone for final CV contact and never formats absent fields as undefined", () => {
    const contact = resolveDocumentContactInfo([], { location: "Singapore", email: "candidate@example.invalid" }, "Profile Display Name");

    expect(() => requireCvContactInfo(contact)).toThrow(/phone/i);
    expect(formatContactLine({ location: "Singapore", phone: "+6500000000", email: "candidate@example.invalid", linkedin: "" }))
      .toBe("Singapore | +6500000000 | candidate@example.invalid");
  });
});
