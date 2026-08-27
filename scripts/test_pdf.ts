import path from "path";
import { generatePdf } from "../src/services/renderers/pdf_renderer.ts";
import fs from "fs";
import { Document, Packer, Paragraph, TextRun } from "docx";

async function test() {
  const docxPath = path.resolve("scripts/exports/test.docx");
  const pdfPath = path.resolve("scripts/exports/test.pdf");

  // Create a minimal docx file
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          children: [new TextRun("Hello World! This is a test DOCX.")],
        }),
      ],
    }],
  });
  
  const b64string = await Packer.toBase64String(doc);
  fs.writeFileSync(docxPath, Buffer.from(b64string, "base64"));
  console.log("Created test.docx");

  console.log("Generating PDF...");
  await generatePdf(docxPath, pdfPath);
  
  if (fs.existsSync(pdfPath)) {
    console.log("✅ PDF successfully generated at: " + pdfPath);
  } else {
    console.log("❌ PDF failed to generate.");
  }
}

test().catch(console.error);
