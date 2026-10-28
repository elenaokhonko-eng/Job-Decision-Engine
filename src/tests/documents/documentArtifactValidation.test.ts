import { describe, expect, it } from "vitest";
import { extractReadableDocumentXmlText } from "../../documents/documentArtifactValidation.js";

describe("extractReadableDocumentXmlText", () => {
  it("returns text from a well-formed Word document body", () => {
    const xml = '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Example CV</w:t></w:r></w:p></w:body></w:document>';

    expect(extractReadableDocumentXmlText(xml)).toContain("Example CV");
  });

  it("rejects malformed XML and documents without text", () => {
    expect(() => extractReadableDocumentXmlText("<w:document><w:body></w:document>"))
      .toThrow(/malformed/i);
    expect(() => extractReadableDocumentXmlText('<w:document xmlns:w="urn:word"/>'))
      .toThrow(/no readable text/i);
  });
});
