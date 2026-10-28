import { XMLValidator } from "fast-xml-parser";

export function extractReadableDocumentXmlText(xml: string): string {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error("DOCX document XML is malformed.");
  const text = xml.replace(/<[^>]+>/g, " ").trim();
  if (!text) throw new Error("DOCX document XML contains no readable text.");
  return text;
}
