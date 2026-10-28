import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatContactLine,
  requireCvContactInfo,
  resolveDocumentContactInfo,
  loadProfileContactSnapshot,
} from "../../documents/contactInfo.js";

const contactFact = (factKey: string, kind: string, value: string) => ({
  id: `00000000-0000-4000-8000-${String(factKey.length).padStart(12, "0")}`,
  fact_key: factKey,
  fact_type: "CONTACT",
  structured_value: { kind, value },
  verification_status: "SELF_ATTESTED",
  confidentiality: "PRIVATE_INTERNAL",
});

describe("profile graph document contact", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses only the selected profile's private graph facts", () => {
    const contact = resolveDocumentContactInfo(
      [
        contactFact("contact_name", "name", "Graph Candidate"),
        contactFact("contact_location", "location", "Singapore"),
        contactFact("contact_email", "email", "graph@example.invalid"),
        contactFact("contact_phone", "phone", "+6500000000"),
        contactFact("contact_linkedin", "linkedin", "https://www.linkedin.com/in/graph-candidate"),
      ],
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
      "Profile Display Name",
    );

    expect(contact).toMatchObject({
      full_name: "Profile Display Name",
    });
    expect(contact).not.toHaveProperty("phone");
    expect(contact).not.toHaveProperty("email");
  });

  it("rejects a current private contact fact that violates the shared contract", () => {
    expect(() => resolveDocumentContactInfo(
      [contactFact("contact_phone", "email", "person@example.invalid")],
      "Profile Display Name",
    )).toThrow(/contact fact contract/i);
  });

  it("requires phone for final CV contact and never formats absent fields as undefined", () => {
    const contact = resolveDocumentContactInfo([], "Profile Display Name");

    expect(() => requireCvContactInfo(contact)).toThrow(/phone/i);
    expect(formatContactLine({ location: "Singapore", phone: "+6500000000", email: "candidate@example.invalid", linkedin: "" }))
      .toBe("Singapore | +6500000000 | candidate@example.invalid");
  });

  it("never inherits another tenant's process-wide contact and preserves a scoped phone when email is absent", async () => {
    vi.stubEnv("MASTER_PROFILE_JSON", JSON.stringify({ full_name: "Tenant A", email: "a@example.invalid", phone: "+6500000001" }));
    vi.stubEnv("DOCUMENT_CONTACT_JSON", JSON.stringify({ full_name: "Tenant A", email: "a@example.invalid", phone: "+6500000001" }));
    const scopedPhone = contactFact("contact_phone", "phone", "+6500000002");
    const query = vi.fn().mockResolvedValue({ rows: [scopedPhone] });
    const snapshot = await loadProfileContactSnapshot({ query } as never, "workspace-b", "profile-b", "Tenant B");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE workspace_id = $1"), ["workspace-b", "profile-b"]);
    expect(snapshot.contact).toEqual({ full_name: "Tenant B", phone: "+6500000002" });
    expect(snapshot.factIds).toEqual([scopedPhone.id]);
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
