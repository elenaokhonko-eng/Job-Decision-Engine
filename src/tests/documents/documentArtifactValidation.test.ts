import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractDocxText, containsPhoneNumber } from "../../../scripts/verify_document_artifacts.js";
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

describe("document artifact verification helpers", () => {
  it("extracts text from valid in-memory DOCX packages", async () => {
    const archive = new JSZip();
    archive.file("[Content_Types].xml", "<Types/>");
    archive.file("word/document.xml", '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Verified CV</w:t></w:r></w:p></w:body></w:document>');
    const content = await archive.generateAsync({ type: "nodebuffer" });

    await expect(extractDocxText("cv.docx", content)).resolves.toContain("Verified CV");
  });

  it("rejects a DOCX package without its document body", async () => {
    const archive = new JSZip();
    archive.file("[Content_Types].xml", "<Types/>");
    const content = await archive.generateAsync({ type: "nodebuffer" });

    await expect(extractDocxText("cv.docx", content)).rejects.toThrow(/document\.xml is missing/i);
  });

  it("matches graph phone digits across common formatting", () => {
    expect(containsPhoneNumber("Phone: +65 9072 7915", "+6590727915")).toBe(true);
    expect(containsPhoneNumber("Phone: +65 9072 791", "+6590727915")).toBe(false);
    expect(containsPhoneNumber("Phone: 123", "")).toBe(false);
  });
});
