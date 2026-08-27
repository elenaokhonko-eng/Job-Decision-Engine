import * as fs from "fs";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";

export async function generateCoverLetterDocx(clData: any, outputPath: string, contactInfo: any) {
  const children: any[] = [];

  // Contact Info (Centered, matching CV style)
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: contactInfo.full_name || "Elena Okhonko", bold: true, size: 32, font: "Arial" }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: `${contactInfo.location || ""} | ${contactInfo.phone || ""} | ${contactInfo.email || ""} | ${contactInfo.linkedin || ""}`, size: 20, font: "Arial" }),
      ],
      spacing: { after: 300 },
    })
  );

  const cl = clData.cover_letter;
  if (!cl) {
    throw new Error("Missing cover_letter data in provided payload.");
  }

  // Date
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), size: 24, font: "Arial" }),
      ],
      spacing: { before: 200, after: 200 },
    })
  );

  // Recipient
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: `Dear ${cl.recipient_name},`, size: 24, font: "Arial" }),
      ],
      spacing: { after: 200 },
    })
  );

  // Opening Hook
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: cl.opening_hook, size: 24, font: "Arial" }),
      ],
      spacing: { after: 200 },
    })
  );

  // Body Paragraphs
  for (const para of cl.body_paragraphs) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: para, size: 24, font: "Arial" }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  // Closing Statement
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: cl.closing_statement, size: 24, font: "Arial" }),
      ],
      spacing: { after: 200 },
    })
  );

  // Sign-off
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "Sincerely,", size: 24, font: "Arial" }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: contactInfo.full_name || "Elena Okhonko", size: 24, font: "Arial" }),
      ]
    })
  );

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}
