import { chromium } from "playwright";
import * as fs from "fs";

export async function generatePdf(cvData: any, outputPath: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const c = cvData.cv || {};
  const contact = c.contact || {};
  const expHtml = (c.experience || []).map((exp: any) => `
    <div style="margin-bottom: 20px;">
      <h3 style="margin: 0; font-size: 14pt;"><b>${exp.title}</b> | ${exp.employer}</h3>
      <div style="font-style: italic; color: #555; margin-bottom: 5px;">${exp.date_display} - ${exp.location || "Singapore"}</div>
      ${exp.scope_statement ? `<p style="margin: 0 0 5px 0;">${exp.scope_statement}</p>` : ""}
      <ul style="margin: 0; padding-left: 20px;">
        ${(exp.achievements || []).map((ach: any) => `<li>${ach.text}</li>`).join("")}
      </ul>
    </div>
  `).join("");

  const snapHtml = c.role_alignment_snapshot ? `
    <h2>${c.role_alignment_snapshot.heading || "Role Alignment Snapshot"}</h2>
    ${c.role_alignment_snapshot.items.map((item: any) => `
      <div style="margin-bottom: 15px;">
        <div style="font-weight: bold; text-transform: uppercase; font-size: 11pt;">${item.requirement_label} — ${item.display_match_label}</div>
        <div style="margin-top: 4px;">${item.evidence_statement}</div>
      </div>
    `).join("")}
  ` : "";
  const eduHtml = (c.education || []).map((edu: any) => `<li>${edu}</li>`).join("");
  
  const expertiseHtml = (c.core_expertise || []).map((e: any) => `<span style="display:inline-block; margin-right: 15px; border-right: 1px solid #ccc; padding-right: 15px;">${e}</span>`).join("");

  const html = `
    <html>
      <head>
        <style>
          body { font-family: 'Arial', sans-serif; font-size: 11pt; color: #333; line-height: 1.4; margin: 0; padding: 40px; }
          h1 { text-align: center; font-size: 24pt; margin: 0 0 10px 0; color: #000; }
          .contact { text-align: center; font-size: 10pt; color: #555; margin-bottom: 20px; }
          .headline { text-align: center; font-size: 16pt; font-weight: bold; margin-bottom: 15px; text-transform: uppercase; }
          h2 { font-size: 14pt; border-bottom: 1px solid #000; padding-bottom: 5px; margin-top: 25px; margin-bottom: 15px; text-transform: uppercase; }
          p { margin: 0 0 10px 0; }
          ul { margin-top: 0; }
        </style>
      </head>
      <body>
        <h1>${contact.full_name || ""}</h1>
        <div class="contact">
          ${contact.location || ""} | ${contact.phone || ""} | ${contact.email || ""} | ${contact.linkedin || ""}
        </div>
        ${c.headline ? `<div class="headline">${c.headline}</div>` : ""}
        ${c.executive_summary ? `<p>${c.executive_summary}</p>` : ""}
        
        ${c.core_expertise ? `
          <h2>Core Expertise</h2>
          <div style="line-height: 1.8;">${expertiseHtml}</div>
        ` : ""}

        ${snapHtml}

        ${c.experience ? `
          <h2>Professional Experience</h2>
          ${expHtml}
        ` : ""}

        ${c.education ? `
          <h2>Education & Credentials</h2>
          <ul>${eduHtml}</ul>
        ` : ""}
      </body>
    </html>
  `;

  await page.setContent(html, { waitUntil: "networkidle" });
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    margin: { top: "0.75in", right: "0.75in", bottom: "0.75in", left: "0.75in" }
  });

  await browser.close();
}
