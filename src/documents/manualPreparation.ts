import crypto from "node:crypto";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

export const MANUAL_COMPARATOR_VERSION = "literal-overlap-v1";

export interface ManualRequirement {
  requirement_key: string;
  requirement_type: string;
  importance: string;
  requirement_text: string;
}

export interface ManualEvidence {
  id: string;
  evidence_type: "FACT" | "CREDENTIAL" | "ENGAGEMENT";
  label: string;
  statement: string;
}

export interface ManualComparisonInput {
  canonical_job_id: string;
  job_version_id: string;
  source_observation_id: string;
  source_evidence_fingerprint: string;
  job_content_hash: string;
  title: string;
  company: string;
  canonical_url: string | null;
  profile_version_id: string;
  candidate_profile_id: string;
  requirement_set_id: string;
  profile_contact_fact_ids: string[];
  profile_contact_fingerprint: string;
  preference_context_fingerprint: string;
  context_fingerprint: string;
  requirements: ManualRequirement[];
  evidence: ManualEvidence[];
  suitability_warnings: string[];
}

export interface ManualApprovalIdentity {
  canonicalJobId: string;
  jobVersionId: string;
  sourceObservationId: string;
  jobContentHash: string;
  profileVersionId: string;
  candidateProfileId: string;
  profileContactFactIdsFingerprint: string;
  profileContactFingerprint: string;
  preferenceContextFingerprint: string;
  requirementSetId: string;
  comparatorVersion: string;
  comparisonFingerprint: string;
}

export type ManualApprovalCurrentness =
  | { ok: true }
  | { ok: false; reason: keyof ManualApprovalIdentity };

export function validateManualApprovalCurrentness(
  pinned: ManualApprovalIdentity,
  current: ManualApprovalIdentity,
): ManualApprovalCurrentness {
  for (const key of [
    "canonicalJobId", "jobVersionId", "sourceObservationId", "jobContentHash", "profileVersionId",
    "candidateProfileId", "profileContactFactIdsFingerprint", "profileContactFingerprint",
    "preferenceContextFingerprint", "requirementSetId", "comparatorVersion", "comparisonFingerprint",
  ] as const) {
    if (!pinned[key] || !current[key] || pinned[key] !== current[key]) return { ok: false, reason: key };
  }
  return { ok: true };
}

const TOKEN = /[a-z0-9+#.]{2,}/gi;
const GENERIC = new Set(["with", "from", "that", "this", "will", "have", "your", "role", "work", "team", "years", "strong", "ability", "experience", "skills", "knowledge", "required", "preferred", "including"]);

function terms(value: string): Set<string> {
  return new Set((value.match(TOKEN) ?? []).map((part) => part.toLowerCase()).filter((part) => !GENERIC.has(part)));
}

export function buildManualComparison(input: ManualComparisonInput): Record<string, unknown> {
  const rows = input.requirements.map((requirement) => {
    const requirementTerms = terms(`${requirement.requirement_text} ${requirement.requirement_type}`);
    const matched = input.evidence.map((evidence) => {
      const overlap = [...requirementTerms].filter((term) => terms(`${evidence.label} ${evidence.statement}`).has(term));
      return { evidence, overlap };
    }).filter((entry) => entry.overlap.length > 0)
      .sort((left, right) => right.overlap.length - left.overlap.length || left.evidence.id.localeCompare(right.evidence.id))
      .slice(0, 3);
    return {
      requirement_key: requirement.requirement_key,
      requirement_type: requirement.requirement_type,
      importance: requirement.importance,
      requirement: requirement.requirement_text,
      evidence: matched.map(({ evidence }) => ({ id: evidence.id, type: evidence.evidence_type, label: evidence.label, statement: evidence.statement })),
      gap: matched.length === 0
        ? "No directly matching statement was found in the selected current profile evidence. Confirm this manually; absence is not proof of inability."
        : null,
      comparison_method: "literal-term overlap; potential evidence only",
    };
  });
  return {
    schema_version: "manual_application_v1",
    comparator_version: MANUAL_COMPARATOR_VERSION,
    canonical_job_id: input.canonical_job_id,
    job_version_id: input.job_version_id,
    source_observation_id: input.source_observation_id,
    source_evidence_fingerprint: input.source_evidence_fingerprint,
    job_content_hash: input.job_content_hash,
    profile_version_id: input.profile_version_id,
    candidate_profile_id: input.candidate_profile_id,
    requirement_set_id: input.requirement_set_id,
    profile_contact_fact_ids: [...input.profile_contact_fact_ids],
    profile_contact_fingerprint: input.profile_contact_fingerprint,
    preference_context_fingerprint: input.preference_context_fingerprint,
    context_fingerprint: input.context_fingerprint,
    title: input.title,
    company: input.company,
    canonical_url: input.canonical_url,
    requirements: input.requirements,
    evidence: input.evidence,
    rows,
    suitability_warnings: [...input.suitability_warnings],
    evidence_notice: "Potential matches are literal-term retrieval hints, not a suitability decision. Review source statements and gaps yourself.",
  };
}

export interface ManualArtifactIdentity {
  document_type: "CV" | "COVER_LETTER";
  format: "DOCX" | "PDF";
  document_run_id: string;
}

export function validateManualArtifactPair(rows: readonly ManualArtifactIdentity[]): void {
  const expected = new Set(["CV:DOCX", "CV:PDF", "COVER_LETTER:DOCX", "COVER_LETTER:PDF"]);
  const actual = new Set(rows.map((row) => `${row.document_type}:${row.format}`));
  const cvRuns = new Set(rows.filter((row) => row.document_type === "CV").map((row) => row.document_run_id));
  const coverLetterRuns = new Set(rows.filter((row) => row.document_type === "COVER_LETTER").map((row) => row.document_run_id));
  if (rows.length !== 4 || actual.size !== expected.size || [...expected].some((key) => !actual.has(key)) ||
      cvRuns.size !== 1 || coverLetterRuns.size !== 1 || [...cvRuns][0] === [...coverLetterRuns][0]) {
    throw new Error("Generated document pair validation failed.");
  }
}

export function fingerprintManualComparison(comparison: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableStringify(comparison)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface ControlledDocuments {
  cv: string;
  coverLetter: string;
  claims: Array<{ section: string; text: string; evidenceIds: string[]; requirementKeys: string[] }>;
}

export function buildControlledDocuments(
  comparison: Record<string, any>,
  contact: { full_name: string; location?: string; email?: string; phone?: string; linkedin?: string },
): ControlledDocuments {
  if (!contact.phone?.trim()) throw new Error("The active private contact graph has no current phone fact; document preparation is blocked.");
  const evidence = Array.isArray(comparison.evidence) ? comparison.evidence as ManualEvidence[] : [];
  const rows = Array.isArray(comparison.rows) ? comparison.rows as Array<Record<string, any>> : [];
  const selectedIds = new Set(rows.flatMap((row) => (row.evidence ?? []).map((item: { id: string }) => item.id)));
  const selected = evidence.filter((item) => selectedIds.has(item.id));
  // Include relevant retrieved facts, active credentials and engagements, plus
  // standalone tenure facts. Do not merge hands-on coding and architecture years.
  const tenureFacts = evidence.filter((item) =>
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+years?\b/i.test(item.statement) &&
    /(coding|software development|hands-on|technical-functional|architecture)/i.test(item.statement),
  );
  const cvEvidence = evidence.filter((item) =>
    selectedIds.has(item.id) || item.evidence_type === "CREDENTIAL" || item.evidence_type === "ENGAGEMENT" ||
    tenureFacts.some((fact) => fact.id === item.id),
  );
  const factualLines = cvEvidence.map((item) => item.statement.trim()).filter(Boolean);
  const cvLines = [
    `# ${contact.full_name}`,
    [contact.location, contact.email, contact.phone, contact.linkedin].filter(Boolean).join(" | "),
    "",
    `## Target role: ${comparison.title} — ${comparison.company}`,
    "",
    "## Profile evidence",
    ...factualLines.map((line) => `- ${line}`),
  ].join("\n");
  const keyEvidence = selected.slice(0, 4);
  const statementLines = keyEvidence.map((item) => item.statement.trim()).filter(Boolean);
  const coverLetter = [
    `# ${contact.full_name}`,
    [contact.location, contact.email, contact.phone, contact.linkedin].filter(Boolean).join(" | "),
    "",
    `## Application for ${comparison.title} at ${comparison.company}`,
    "",
    `Dear ${comparison.company} Hiring Team,`,
    "",
    `I am applying for the ${comparison.title} role at ${comparison.company}. I reviewed the role requirements and compared them with my current profile evidence. The following statements are copied from that evidence record:`,
    ...statementLines.map((line) => `- ${line}`),
    "",
    "I have left gaps visible in the comparison for your review and have not inferred qualifications that are not recorded in my profile. I would welcome the opportunity to discuss the role and the evidence above.",
    "",
    "Sincerely,",
    contact.full_name,
  ].join("\n");
  const claims = cvEvidence.map((item) => ({
    section: "Profile evidence",
    text: item.statement.trim(),
    evidenceIds: [item.id],
    requirementKeys: rows.filter((row) => (row.evidence ?? []).some((linked: { id: string }) => linked.id === item.id)).map((row) => row.requirement_key),
  }));
  // Experience duration facts stay verbatim and separate; no combined tenure claim is generated.
  return { cv: cvLines, coverLetter, claims };
}

export async function renderControlledDocx(markdown: string): Promise<Buffer> {
  const paragraphs: Paragraph[] = [];
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (!line.trim()) { paragraphs.push(new Paragraph({ text: "" })); continue; }
    if (line.startsWith("# ")) paragraphs.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.TITLE }));
    else if (line.startsWith("## ")) paragraphs.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_1 }));
    else if (line.startsWith("- ")) paragraphs.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }));
    else paragraphs.push(new Paragraph({
      spacing: { after: index === 1 ? 260 : 120, line: 276 },
      children: [new TextRun({ text: line, ...(index === 1 ? { size: 19, color: "5B6573" } : {}) })],
    }));
  }
  const document = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 21, color: "202833" },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
      },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 36, bold: true, color: "111827" }, paragraph: { spacing: { before: 0, after: 100 }, keepNext: true } },
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { font: "Arial", size: 26, bold: true, color: "174A6E" }, paragraph: { spacing: { before: 220, after: 100 }, keepNext: true } },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 720, right: 780, bottom: 720, left: 780 } } }, children: paragraphs }],
  });
  return Packer.toBuffer(document);
}

function asciiPdfText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "-")
    .replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function renderControlledPdf(markdown: string): Buffer {
  type PdfLine = { text: string; style: "title" | "heading" | "contact" | "body" };
  const wrapped: PdfLine[] = [];
  const sourceLines = markdown.split(/\r?\n/);
  sourceLines.forEach((sourceLine, index) => {
    const style: PdfLine["style"] = sourceLine.startsWith("# ") ? "title"
      : sourceLine.startsWith("## ") ? "heading"
        : index === 1 ? "contact" : "body";
    const cleaned = sourceLine.replace(/^#{1,2}\s+/, "").replace(/^-\s+/, "• ");
    const words = cleaned.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { wrapped.push({ text: "", style: "body" }); return; }
    const maxChars = style === "title" ? 62 : style === "heading" ? 76 : 92;
    let current = "";
    for (const word of words) {
      if (current && `${current} ${word}`.length > maxChars) {
        wrapped.push({ text: current, style });
        current = word;
      } else current = current ? `${current} ${word}` : word;
    }
    wrapped.push({ text: current, style });
  });
  const pages: PdfLine[][] = [];
  let page: PdfLine[] = [];
  let verticalSpace = 790;
  for (const line of wrapped) {
    const height = line.style === "title" ? 30 : line.style === "heading" ? 23 : line.style === "contact" ? 16 : 15;
    if (verticalSpace - height < 48 && page.length) { pages.push(page); page = []; verticalSpace = 790; }
    page.push(line);
    verticalSpace -= height;
  }
  if (page.length || pages.length === 0) pages.push(page);
  const objects: string[] = [];
  const pageRefs = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
  const regularFontObject = 3 + pages.length * 2;
  const boldFontObject = regularFontObject + 1;
  pages.forEach((lines) => {
    const pageObject = objects.length + 1;
    const contentObject = pageObject + 1;
    let y = 790;
    const commands = lines.flatMap((line) => {
      const title = line.style === "title";
      const heading = line.style === "heading";
      const contact = line.style === "contact";
      const size = title ? 21 : heading ? 13 : contact ? 9 : 10;
      const height = title ? 30 : heading ? 23 : contact ? 16 : 15;
      const font = title || heading ? "F2" : "F1";
      const color = title || heading ? "0.09 0.27 0.39 rg" : contact ? "0.34 0.39 0.45 rg" : "0.13 0.16 0.20 rg";
      const command = `${color}\n/${font} ${size} Tf\n1 0 0 1 50 ${y} Tm\n(${asciiPdfText(line.text)}) Tj`;
      y -= height;
      return [command];
    });
    const content = ["BT", ...commands, "ET"].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${regularFontObject} 0 R /F2 ${boldFontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, "ascii")); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

export function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
