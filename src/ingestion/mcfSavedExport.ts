/**
 * MyCareersFuture (MCF) saved-jobs export (`mcf_saved_jobs.json`).
 *
 * The file is produced by the user in their own signed-in browser with
 * `scripts/mcf/export_saved_jobs.console.js`; nothing in this repository signs
 * in to MCF, holds an MCF session, or fetches MCF pages or APIs. This module
 * only validates the exported file and derives the posting identity (the
 * trailing 32-hex job UUID of the MCF job URL). Missing facts stay missing: no
 * location, salary, employment type or date is invented.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  LINKEDIN_SAVED_DESCRIPTION_STATUSES,
  firstNonEmptyLine,
  isLegacyPlaceholderDescription,
} from "./linkedInSavedExport.js";

export const MCF_SAVED_SOURCE_NAME = "MCF_SAVED" as const;
export const MCF_SAVED_PLUGIN_KEY = "mcf_saved" as const;
export const MCF_SAVED_CONTENT_PROVENANCE = "MCF_SAVED_EXPORT" as const;
export const MCF_SAVED_EXPORT_SCHEMA = "mcf_saved_export_v1" as const;
/** Upper bound for one export file; a saved-jobs list is far smaller in practice. */
export const MCF_SAVED_MAX_ITEMS = 2000;

const MCF_ORIGIN = "https://www.mycareersfuture.gov.sg";
const MCF_JOB_UUID = /^[0-9a-f]{32}$/;
/** /job/<category>/<slug>-<uuid> or, without the category folder, /job/<slug>-<uuid>. */
const MCF_JOB_PATH = /^\/job\/(?:[^/]+\/)?(?:[^/]*-)?([0-9a-f]{32})\/?$/i;

const requiredText = (field: string, max: number) => z
  .string({ required_error: `${field} is required`, invalid_type_error: `${field} must be a string` })
  .trim()
  .min(1, `${field} must not be empty`)
  .max(max, `${field} is longer than ${max} characters`);

const optionalText = (field: string, max: number) => z
  .string({ invalid_type_error: `${field} must be a string or null` })
  .trim()
  .max(max, `${field} is longer than ${max} characters`)
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

const optionalDate = (field: string) => optionalText(field, 40).refine(
  (value) => value === null || (/^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value))),
  `${field} must be an ISO date (YYYY-MM-DD...) or null`,
);

const salaryAmount = (field: string) => z
  .number({ invalid_type_error: `salary.${field} must be a number or null` })
  .finite()
  .nonnegative(`salary.${field} must not be negative`)
  .nullable();

/** Salary exactly as MCF shows it; the snippet omits it when the posting hides the salary. */
export const McfSavedSalarySchema = z.object({
  min: salaryAmount("min"),
  max: salaryAmount("max"),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "salary.currency must be a 3-letter currency code"),
  period: z.string().trim().min(1, "salary.period must not be empty").max(40),
}).strict().superRefine((salary, ctx) => {
  if (salary.min === null && salary.max === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "salary must have a min or max amount; omit salary when MCF hides it" });
  }
  if (salary.min !== null && salary.max !== null && salary.min > salary.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "salary.min must not exceed salary.max" });
  }
});

export const MCF_SAVED_DESCRIPTION_STATUSES = LINKEDIN_SAVED_DESCRIPTION_STATUSES;

/**
 * One exported MCF saved job. Unknown keys are rejected, so recruiter contact
 * fields (for example `metadata.emailRecipient`) or a raw MCF API object cannot
 * slip into the pipeline through a changed snippet.
 */
export const McfSavedJobItemSchema = z.object({
  title: requiredText("title", 1000),
  company: optionalText("company", 300),
  url: requiredText("url", 2000),
  description: optionalText("description", 100_000),
  descriptionStatus: z.enum(MCF_SAVED_DESCRIPTION_STATUSES, {
    required_error: "descriptionStatus is required",
    invalid_type_error: "descriptionStatus must be OK, MISSING, FETCH_FAILED or null",
  }).nullable(),
  location: optionalText("location", 500),
  salary: McfSavedSalarySchema.nullable().optional().transform((value) => value ?? null),
  employmentType: optionalText("employmentType", 200),
  postedAt: optionalDate("postedAt"),
  expiresAt: optionalDate("expiresAt"),
  mcfJobUuid: z
    .string({ required_error: "mcfJobUuid is required", invalid_type_error: "mcfJobUuid must be a string" })
    .trim()
    .transform((value) => value.toLowerCase())
    .refine((value) => MCF_JOB_UUID.test(value), "mcfJobUuid must be 32 hexadecimal characters"),
  exportedAt: optionalText("exportedAt", 100),
  sourcePage: optionalText("sourcePage", 2000),
}).strict();

export type McfSavedJobItem = z.infer<typeof McfSavedJobItemSchema>;
export type McfSavedSalary = z.infer<typeof McfSavedSalarySchema>;

export type McfEmploymentTypeRaw = "PERMANENT" | "CONTRACT" | "UNKNOWN";

export interface McfSavedJob {
  /** Zero-based position in the exported array. */
  readonly index: number;
  readonly mcfJobUuid: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly company: string;
  readonly description: string;
  readonly location: string | null;
  readonly salary: McfSavedSalary | null;
  /** The salary as one display string for `compensation_raw`, only when MCF showed one. */
  readonly compensation: string | null;
  readonly employmentType: string | null;
  readonly employmentTypeRaw: McfEmploymentTypeRaw;
  readonly postedAt: string | null;
  readonly expiresAt: string | null;
  /** Deterministic observation payload; its hash is the re-import idempotency key. */
  readonly rawPayload: Record<string, unknown>;
}

export interface McfSavedItemError {
  readonly index: number;
  readonly reason: string;
}

export interface McfSavedExportParseResult {
  readonly total: number;
  readonly valid: McfSavedJob[];
  readonly invalid: McfSavedItemError[];
  /** Same job UUID and identical content repeated in the file; staged once. */
  readonly duplicatesInFile: Array<{ readonly index: number; readonly firstIndex: number; readonly mcfJobUuid: string }>;
}

export class McfSavedExportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McfSavedExportFileError";
  }
}

function isMcfHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "mycareersfuture.gov.sg" || host.endsWith(".mycareersfuture.gov.sg");
}

/** Amazon SES click tracking used by MCF alert emails wraps the destination URL. */
function unwrapClickTracking(url: URL): URL | null {
  if (!/(?:^|\.)awstrack\.me$/i.test(url.hostname)) return url;
  const encoded = url.pathname.match(/^\/L0\/([^/]+)/)?.[1];
  if (!encoded) return null;
  try {
    return new URL(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

/**
 * The MCF job UUID of a job URL: the trailing 32-hex id of
 * https://www.mycareersfuture.gov.sg/job/<category>/<slug>-<uuid> (the category
 * folder is sometimes missing). Alert links wrapped in SES click tracking are
 * unwrapped first. Anything else (search, alert management, other hosts) is null.
 */
export function mcfJobUuidFromUrl(value: string): string | null {
  let url: URL | null;
  try {
    url = unwrapClickTracking(new URL(value));
  } catch {
    return null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !isMcfHost(url.hostname)) return null;
  return url.pathname.match(MCF_JOB_PATH)?.[1]?.toLowerCase() ?? null;
}

/** The job URL as given by MCF, on https://www.mycareersfuture.gov.sg, without query string or fragment. */
export function mcfCanonicalJobUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isMcfHost(url.hostname) || !MCF_JOB_PATH.test(url.pathname)) return null;
  return MCF_ORIGIN + url.pathname.replace(/\/$/, "");
}

/** Company values that name no employer (MCF shows "Company Undisclosed" when the employer is hidden). */
const PLACEHOLDER_COMPANY = /^(unknown( company)?|company undisclosed|undisclosed( company)?|confidential( company)?|n\/?a|null|undefined|-+)$/i;
/** Text that only says a description is absent. */
const PLACEHOLDER_DESCRIPTION = [
  /^(no )?(job )?description( is)? (not )?(available|provided)\.?$/i,
  /^(n\/?a|null|undefined|-+)$/i,
];

export function isMcfPlaceholderCompany(value: string | null): boolean {
  return value !== null && PLACEHOLDER_COMPANY.test(value.replace(/\s+/g, " ").trim());
}

export function isMcfPlaceholderDescription(value: string | null): boolean {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return isLegacyPlaceholderDescription(text) || PLACEHOLDER_DESCRIPTION.some((pattern) => pattern.test(text));
}

/**
 * Employment type for the canonical pipeline: PERMANENT or CONTRACT only when
 * MCF lists exactly that kind; anything else (Full Time, Internship, mixed
 * lists) stays UNKNOWN. The exported text is kept in the raw payload.
 */
export function mcfEmploymentTypeRaw(value: string | null): McfEmploymentTypeRaw {
  if (!value) return "UNKNOWN";
  const kinds = new Set(value.split(/[,/;|]/).map((part) => part.trim().toLowerCase()).filter(Boolean).map((part) => {
    if (part === "permanent") return "PERMANENT";
    if (part === "contract" || part === "temporary") return "CONTRACT";
    return "OTHER";
  }));
  if (kinds.size !== 1) return "UNKNOWN";
  const [kind] = [...kinds];
  return kind === "PERMANENT" || kind === "CONTRACT" ? kind : "UNKNOWN";
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * "SGD 6,500 - 13,000 per month" style text, only from an exported salary with
 * both bounds (MCF postings carry both). A one-sided range is kept in the raw
 * payload only: the compensation parser would read "from X" as an exact amount.
 */
export function mcfCompensationText(salary: McfSavedSalary | null): string | null {
  if (!salary || salary.min === null || salary.max === null) return null;
  const amount = salary.min === salary.max ? formatAmount(salary.min) : `${formatAmount(salary.min)} - ${formatAmount(salary.max)}`;
  const period = salary.period.toLowerCase();
  const periodText = ({ monthly: "per month", annually: "per year", annual: "per year", yearly: "per year", hourly: "per hour", daily: "per day", weekly: "per week" } as Record<string, string>)[period]
    ?? salary.period;
  return `${salary.currency} ${amount} ${periodText}`;
}

function contentKey(job: Pick<McfSavedJob, "title" | "company" | "description" | "location" | "salary" | "employmentType" | "postedAt" | "expiresAt">): string {
  return createHash("sha256")
    .update(JSON.stringify([job.title, job.company, job.description, job.location, job.salary, job.employmentType, job.postedAt, job.expiresAt]), "utf8")
    .digest("hex");
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") return `unknown field(s): ${issue.keys.join(", ")}`;
      const path = issue.path.join(".");
      return path && !issue.message.startsWith(path) ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/** Validates and normalizes one item; returns a reason string when it cannot be staged. */
export function parseMcfSavedJobItem(value: unknown, index: number): McfSavedJob | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "item must be a JSON object";
  const parsed = McfSavedJobItemSchema.safeParse(value);
  if (!parsed.success) return issueText(parsed.error);
  const item = parsed.data;

  const title = firstNonEmptyLine(item.title);
  if (!title) return "title must not be empty";

  if (item.descriptionStatus === null) return "description was not fetched yet (descriptionStatus=null); run resume() in the browser";
  if (item.descriptionStatus !== "OK") return `description was not exported (descriptionStatus=${item.descriptionStatus})`;

  const company = item.company && !isMcfPlaceholderCompany(item.company) ? item.company : null;
  if (!company) return "company is missing (MCF hid the employer, or a placeholder such as 'Company Undisclosed' was exported)";
  if (!item.description) return "description is missing";
  if (isMcfPlaceholderDescription(item.description)) return "description is a placeholder, not posting content";

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(item.url);
  } catch {
    return "url is not a valid URL";
  }
  if (parsedUrl.protocol !== "https:" || !isMcfHost(parsedUrl.hostname)) {
    return "url must be an https mycareersfuture.gov.sg job URL";
  }
  const urlUuid = mcfJobUuidFromUrl(item.url);
  const canonicalUrl = mcfCanonicalJobUrl(item.url);
  if (!urlUuid || !canonicalUrl) {
    return "url must be https://www.mycareersfuture.gov.sg/job/<category>/<slug>-<32-hex job id>";
  }
  if (urlUuid !== item.mcfJobUuid) {
    return `mcfJobUuid ${item.mcfJobUuid} does not match the job id ${urlUuid} in url`;
  }

  const compensation = mcfCompensationText(item.salary);
  // exportedAt is left out of the hashed payload so re-exporting unchanged jobs
  // later deduplicates; the observation's retrieved_at records the import time.
  const rawPayload: Record<string, unknown> = {
    export_schema: MCF_SAVED_EXPORT_SCHEMA,
    content_provenance: MCF_SAVED_CONTENT_PROVENANCE,
    mcf_job_uuid: item.mcfJobUuid,
    canonical_url: canonicalUrl,
    exported_item: {
      title: item.title,
      company: item.company,
      url: item.url,
      description: item.description,
      descriptionStatus: item.descriptionStatus,
      location: item.location,
      salary: item.salary,
      employmentType: item.employmentType,
      postedAt: item.postedAt,
      expiresAt: item.expiresAt,
      mcfJobUuid: item.mcfJobUuid,
      sourcePage: item.sourcePage,
    },
  };
  return {
    index,
    mcfJobUuid: item.mcfJobUuid,
    canonicalUrl,
    title,
    company,
    description: item.description,
    location: item.location,
    salary: item.salary,
    compensation,
    employmentType: item.employmentType,
    employmentTypeRaw: mcfEmploymentTypeRaw(item.employmentType),
    postedAt: item.postedAt,
    expiresAt: item.expiresAt,
    rawPayload,
  };
}

/**
 * Parses the whole exported document. A non-array root, an empty array or an
 * oversized file is a file-level error; individual bad items are reported with
 * their index and reason and never stop the valid ones from being staged.
 */
export function parseMcfSavedExport(document: unknown): McfSavedExportParseResult {
  if (!Array.isArray(document)) {
    throw new McfSavedExportFileError("The export must be a JSON array of saved jobs.");
  }
  if (document.length === 0) {
    throw new McfSavedExportFileError("The export contains no saved jobs; re-run the browser export.");
  }
  if (document.length > MCF_SAVED_MAX_ITEMS) {
    throw new McfSavedExportFileError(`The export has ${document.length} items; the limit is ${MCF_SAVED_MAX_ITEMS}.`);
  }

  const valid: McfSavedJob[] = [];
  const invalid: McfSavedItemError[] = [];
  const duplicatesInFile: McfSavedExportParseResult["duplicatesInFile"] = [];
  const firstByUuid = new Map<string, McfSavedJob>();
  document.forEach((value, index) => {
    const result = parseMcfSavedJobItem(value, index);
    if (typeof result === "string") {
      invalid.push({ index, reason: result });
      return;
    }
    const first = firstByUuid.get(result.mcfJobUuid);
    if (first) {
      if (contentKey(first) === contentKey(result)) {
        duplicatesInFile.push({ index, firstIndex: first.index, mcfJobUuid: result.mcfJobUuid });
      } else {
        invalid.push({
          index,
          reason: `MCF job ${result.mcfJobUuid} appears again (first at index ${first.index}) with different content`,
        });
      }
      return;
    }
    firstByUuid.set(result.mcfJobUuid, result);
    valid.push(result);
  });
  return { total: document.length, valid, invalid, duplicatesInFile };
}

/** Parses the export file text; JSON syntax errors are file-level errors. */
export function parseMcfSavedExportText(text: string): McfSavedExportParseResult {
  let document: unknown;
  try {
    document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new McfSavedExportFileError(`The export is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseMcfSavedExport(document);
}
