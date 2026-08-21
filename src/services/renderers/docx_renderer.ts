import * as fs from "fs";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, convertInchesToTwip } from "docx";

export async function generateDocx(cvData: any, outputPath: string) {
  const children: any[] = [];

  // Contact Info (Centered)
  const contact = cvData.cv?.contact || {};
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: contact.full_name || "", bold: true, size: 32, font: "Arial" }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: `${contact.location || ""} | ${contact.phone || ""} | ${contact.email || ""} | ${contact.linkedin || ""}`, size: 20, font: "Arial" }),
      ],
      spacing: { after: 300 },
    })
  );

  // Headline
  if (cvData.cv?.headline) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: cvData.cv.headline.toUpperCase(), bold: true, size: 24, font: "Arial" }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  // Executive Summary
  if (cvData.cv?.executive_summary) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: cvData.cv.executive_summary, size: 21, font: "Arial" }),
        ],
        spacing: { after: 200 },
      })
    );
  }

  // Core Expertise
  if (cvData.cv?.core_expertise && Array.isArray(cvData.cv.core_expertise)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "CORE EXPERTISE", font: "Arial", size: 24, bold: true })],
        spacing: { before: 200, after: 100 },
      })
    );
    const expertiseChunks = [];
    for (let i = 0; i < cvData.cv.core_expertise.length; i += 3) {
      expertiseChunks.push(cvData.cv.core_expertise.slice(i, i + 3).join("  |  "));
    }
    for (const chunk of expertiseChunks) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: chunk, size: 21, font: "Arial" })],
        })
      );
    }
    children.push(new Paragraph({ spacing: { after: 200 } }));
  }

  // Selected Impact
  if (cvData.cv?.selected_impact && Array.isArray(cvData.cv.selected_impact)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "SIGNATURE IMPACT", font: "Arial", size: 24, bold: true })],
        spacing: { before: 200, after: 100 },
      })
    );
    for (const impact of cvData.cv.selected_impact) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: impact.text, size: 21, font: "Arial" })],
        })
      );
    }
    children.push(new Paragraph({ spacing: { after: 200 } }));
  }

  // Professional Experience
  if (cvData.cv?.experience && Array.isArray(cvData.cv.experience)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "PROFESSIONAL EXPERIENCE", font: "Arial", size: 24, bold: true })],
        spacing: { before: 200, after: 100 },
      })
    );

    for (const exp of cvData.cv.experience) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: exp.title, bold: true, size: 22, font: "Arial" }),
            new TextRun({ text: ` | ${exp.employer}`, size: 22, font: "Arial" }),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: `${exp.date_display} - ${exp.location || "Singapore"}`, size: 20, font: "Arial", italics: true }),
          ],
          spacing: { after: 100 },
        })
      );

      if (exp.scope_statement) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: exp.scope_statement, size: 21, font: "Arial" })],
            spacing: { after: 100 },
          })
        );
      }

      if (exp.achievements && Array.isArray(exp.achievements)) {
        for (const ach of exp.achievements) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              children: [new TextRun({ text: ach.text, size: 21, font: "Arial" })],
            })
          );
        }
      }
      children.push(new Paragraph({ spacing: { after: 200 } }));
    }
  }

  // Education
  if (cvData.cv?.education && Array.isArray(cvData.cv.education)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: "EDUCATION & CREDENTIALS", font: "Arial", size: 24, bold: true })],
        spacing: { before: 200, after: 100 },
      })
    );
    for (const edu of cvData.cv.education) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: edu, size: 21, font: "Arial" })],
        })
      );
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.75),
            right: convertInchesToTwip(0.75),
            bottom: convertInchesToTwip(0.75),
            left: convertInchesToTwip(0.75),
          },
        },
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}
