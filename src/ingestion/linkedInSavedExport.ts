/**
 * LinkedIn saved-jobs export (`linkedin_saved_jobs.json`).
 *
 * The file is produced by the user in their own logged-in browser with
 * `scripts/linkedin/export_saved_jobs.console.js`; nothing in this repository
 * signs in to LinkedIn, holds a LinkedIn cookie, or fetches LinkedIn pages.
 * Output of the earlier snippet ({title, company, url, location, description})
 * is accepted, but its placeholders are read as missing, never as content.
 * This module only validates the exported file and derives the posting identity.
 * Missing facts stay missing: no location, salary, work mode or date is invented.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { postingFactsPayload, type PostingFactsResult } from "./postingFacts.js";
import { linkedInJobIdFromUrl, linkedInJobUrl } from "./searchApi/searchApiClient.js";
import { isUnknownEmployerName } from "./postingIdentity.js";

export const LINKEDIN_SAVED_SOURCE_NAME = "LINKEDIN_SAVED" as const;
export const LINKEDIN_SAVED_PLUGIN_KEY = "linkedin_saved" as const;
export const LINKEDIN_SAVED_CONTENT_PROVENANCE = "LINKEDIN_SAVED_EXPORT" as const;
export const LINKEDIN_SAVED_EXPORT_SCHEMA = "linkedin_saved_export_v1" as const;
/** Upper bound for one export file; a saved-jobs list is far smaller in practice. */
export const LINKEDIN_SAVED_MAX_ITEMS = 2000;

const LINKEDIN_JOB_ID = /^\d{5,20}$/;

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

export const LINKEDIN_SAVED_DESCRIPTION_STATUSES = ["OK", "MISSING", "FETCH_FAILED"] as const;
export const LINKEDIN_SAVED_AVAILABILITY_STATUSES = ["OPEN", "CLOSED", "UNKNOWN"] as const;
/** How the export snippet reads posting facts: the public guest posting page, requested without the session. */
export const LINKEDIN_GUEST_POSTING_CHECK_METHOD = "LINKEDIN_GUEST_POSTING_PAGE_USER_BROWSER" as const;

/**
 * Placeholder text the user's earlier console snippet wrote in place of a real
 * description. It is never posting content and is treated as a missing description.
 */
const LEGACY_PLACEHOLDER_DESCRIPTIONS = [
  /^full description not available\.?(\s+please visit (the )?job link to apply\.?)?$/i,
  /^failed to fetch description automatically\.?$/i,
];
/** The earlier snippet's company default; never a real employer name. */
const LEGACY_PLACEHOLDER_COMPANY = /^unknown( company)?$/i;
/** The earlier snippet defaulted a missing location to exactly this value. */
const LEGACY_DEFAULT_LOCATION = "Singapore";

/**
 * One exported saved job. Unknown keys are rejected so a changed snippet cannot
 * slip fields past review. Items without `descriptionStatus` are the earlier
 * snippet's legacy shape `{title, company, url, location, description}`.
 */
export const LinkedInSavedJobItemSchema = z.object({
  title: requiredText("title", 1000),
  company: optionalText("company", 300),
  url: requiredText("url", 2000),
  description: optionalText("description", 100_000),
  descriptionStatus: z.enum(LINKEDIN_SAVED_DESCRIPTION_STATUSES).nullable().optional(),
  location: optionalText("location", 300),
  salary: optionalText("salary", 300),
  /** Absolute posting date from the guest page (JSON-LD datePosted or <time datetime>). */
  postedAt: optionalText("postedAt", 100),
  /** The guest page's relative age text, e.g. "2 weeks ago" or "Reposted 3 days ago". */
  postedAtText: optionalText("postedAtText", 100),
  /** Absolute end of the application window (JSON-LD validThrough). */
  validThrough: optionalText("validThrough", 100),
  /** OPEN only with an apply control and no closed banner; CLOSED from the closed banner; else UNKNOWN. */
  availabilityStatus: z.enum(LINKEDIN_SAVED_AVAILABILITY_STATUSES, {
    invalid_type_error: "availabilityStatus must be OPEN, CLOSED, UNKNOWN or null",
  }).nullable().optional().transform((value) => value ?? null),
  /** The page text the status was read from, e.g. "No longer accepting applications". */
  availabilityEvidence: optionalText("availabilityEvidence", 300),
  /** When the guest posting page was read (ISO timestamp). */
  postingCheckedAt: optionalText("postingCheckedAt", 100),
  /**
   * A later re-check (refresh()) that failed: when, and why (e.g. "HTTP 404").
   * The facts above are then the earlier, successfully read ones with their own check time.
   */
  postingRecheckFailedAt: optionalText("postingRecheckFailedAt", 100),
  postingRecheckFailure: optionalText("postingRecheckFailure", 300),
  linkedinJobId: z
    .union([z.string(), z.number().int()], { invalid_type_error: "linkedinJobId must be a string or integer" })
    .nullable()
    .optional()
    .transform((value) => (value === null || value === undefined || String(value).trim() === "" ? null : String(value).trim())),
  exportedAt: optionalText("exportedAt", 100),
  sourcePage: optionalText("sourcePage", 2000),
}).strict();

export type LinkedInSavedJobItem = z.infer<typeof LinkedInSavedJobItemSchema>;

export type LinkedInSavedImportNote = "LEGACY_DEFAULT_LOCATION_DROPPED" | "TITLE_TRIMMED_TO_FIRST_LINE";

export interface LinkedInSavedJob {
  /** Zero-based position in the exported array. */
  readonly index: number;
  readonly linkedInJobId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly company: string;
  readonly description: string;
  readonly location: string | null;
  readonly salary: string | null;
  readonly postedAt: string | null;
  /** Posting dates and open/closed status read from the guest page; unknown facts are absent. */
  readonly postingFacts: PostingFactsResult;
  /** Work mode only from an explicit LinkedIn location label such as "Singapore (Hybrid)". */
  readonly workplaceType: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
  /** Legacy-shape repairs applied while reading the item (never added content). */
  readonly notes: LinkedInSavedImportNote[];
  /** Deterministic observation payload; its hash is the re-import idempotency key. */
  readonly rawPayload: Record<string, unknown>;
}

export interface LinkedInSavedItemError {
  readonly index: number;
  readonly reason: string;
}

export interface LinkedInSavedExportParseResult {
  readonly total: number;
  readonly valid: LinkedInSavedJob[];
  readonly invalid: LinkedInSavedItemError[];
  /** Same job id and identical content repeated in the file; staged once. */
  readonly duplicatesInFile: Array<{ readonly index: number; readonly firstIndex: number; readonly linkedInJobId: string }>;
}

export class LinkedInSavedExportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedInSavedExportFileError";
  }
}

export function linkedInWorkplaceTypeFromLocation(location: string | null): LinkedInSavedJob["workplaceType"] {
  const label = location?.match(/\((remote|hybrid|on-?site)\)/i)?.[1]?.toLowerCase();
  if (label === "remote") return "REMOTE";
  if (label === "hybrid") return "HYBRID";
  if (label === "onsite" || label === "on-site") return "ONSITE";
  return "UNKNOWN";
}

export function isLegacyPlaceholderDescription(value: string | null): boolean {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return LEGACY_PLACEHOLDER_DESCRIPTIONS.some((pattern) => pattern.test(text));
}

/** First non-empty line of a rendered link text ("Title\nTitle\nwith verification" -> "Title"). */
export function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).find((line) => line !== "") ?? "";
}

function contentKey(job: Pick<LinkedInSavedJob, "title" | "company" | "description" | "location" | "salary" | "postedAt" | "postingFacts">): string {
  return createHash("sha256")
    .update(JSON.stringify([job.title, job.company, job.description, job.location, job.salary, job.postedAt, job.postingFacts.payload]), "utf8")
    .digest("hex");
}

/**
 * Posting facts from the guest page. Relative age text and the open/closed
 * status are anchored only to postingCheckedAt, the time that page was read;
 * never to exportedAt, which a later (possibly failed) re-check also updates.
 * A check time after `notAfter` (the import time) is not used.
 */
export function linkedInSavedPostingFacts(item: LinkedInSavedJobItem, notAfter: string = new Date().toISOString()): PostingFactsResult {
  return postingFactsPayload({
    postedAt: item.postedAt,
    postedAtText: item.postedAtText,
    expiresAt: item.validThrough,
    availabilityStatus: item.availabilityStatus,
    availabilityEvidence: item.availabilityEvidence,
    checkMethod: LINKEDIN_GUEST_POSTING_CHECK_METHOD,
    checkedAt: item.postingCheckedAt,
    notAfter,
  });
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
export function parseLinkedInSavedJobItem(value: unknown, index: number): LinkedInSavedJob | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "item must be a JSON object";
  const parsed = LinkedInSavedJobItemSchema.safeParse(value);
  if (!parsed.success) return issueText(parsed.error);
  const item = parsed.data;
  const legacyShape = item.descriptionStatus === undefined;
  const notes: LinkedInSavedImportNote[] = [];

  const title = firstNonEmptyLine(item.title);
  if (!title) return "title must not be empty";
  if (title !== item.title) notes.push("TITLE_TRIMMED_TO_FIRST_LINE");

  const company = item.company && !LEGACY_PLACEHOLDER_COMPANY.test(item.company) ? item.company : null;
  if (!company) return "company is missing (a placeholder such as 'Unknown Company' is not an employer name)";

  if (item.descriptionStatus === null) return "description was not fetched yet (descriptionStatus=null); run resume() in the browser";
  if (item.descriptionStatus && item.descriptionStatus !== "OK") {
    return `description was not exported (descriptionStatus=${item.descriptionStatus})`;
  }
  if (!item.description) return "description is missing";
  if (isLegacyPlaceholderDescription(item.description)) {
    return "description is a placeholder written by the export snippet, not posting content";
  }

  let location = item.location;
  if (legacyShape && location === LEGACY_DEFAULT_LOCATION) {
    // The earlier snippet wrote this value whenever it found no location; it is unknown, not Singapore.
    location = null;
    notes.push("LEGACY_DEFAULT_LOCATION_DROPPED");
  }

  const urlJobId = linkedInJobIdFromUrl(item.url);
  let isLinkedInUrl = false;
  try {
    const parsedUrl = new URL(item.url);
    const hostname = parsedUrl.hostname.toLowerCase();
    isLinkedInUrl = parsedUrl.protocol === "https:" && (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com"));
  } catch {
    return "url is not a valid URL";
  }
  if (!isLinkedInUrl) return "url must be an https linkedin.com job URL";
  if (item.linkedinJobId !== null && !LINKEDIN_JOB_ID.test(item.linkedinJobId)) {
    return "linkedinJobId must be 5-20 digits";
  }
  if (urlJobId && item.linkedinJobId && urlJobId !== item.linkedinJobId) {
    return `linkedinJobId ${item.linkedinJobId} does not match the job id ${urlJobId} in url`;
  }
  const linkedInJobId = urlJobId ?? item.linkedinJobId;
  if (!linkedInJobId) {
    return "no LinkedIn job id: url must contain /jobs/view/<id> or currentJobId=<id>, or linkedinJobId must be set";
  }

  const canonicalUrl = linkedInJobUrl(linkedInJobId);
  if (item.availabilityStatus && item.availabilityStatus !== "UNKNOWN" && !item.postingCheckedAt) {
    return `availabilityStatus ${item.availabilityStatus} needs postingCheckedAt (when the posting page was read)`;
  }
  const postingFacts = linkedInSavedPostingFacts(item);
  // The posting-fact fields are added only when the item has them, so an older
  // export (without them) keeps exactly its earlier payload and hash.
  const postingFactItemFields: Record<string, unknown> = {};
  for (const key of ["postedAtText", "validThrough", "availabilityStatus", "availabilityEvidence", "postingCheckedAt", "postingRecheckFailedAt", "postingRecheckFailure"] as const) {
    if (item[key] !== null && item[key] !== undefined) postingFactItemFields[key] = item[key];
  }
  // exportedAt is left out of the hashed payload so re-exporting unchanged jobs
  // later deduplicates; the observation's retrieved_at records the import time.
  // A posting check time, when present, is kept: each check is new availability evidence.
  const rawPayload: Record<string, unknown> = {
    ...postingFacts.payload,
    export_schema: LINKEDIN_SAVED_EXPORT_SCHEMA,
    content_provenance: LINKEDIN_SAVED_CONTENT_PROVENANCE,
    linkedin_job_id: linkedInJobId,
    canonical_url: canonicalUrl,
    legacy_export_shape: legacyShape,
    import_notes: notes,
    exported_item: {
      title: item.title,
      company: item.company,
      url: item.url,
      description: item.description,
      descriptionStatus: item.descriptionStatus ?? null,
      location: item.location,
      salary: item.salary,
      postedAt: item.postedAt,
      linkedinJobId: item.linkedinJobId,
      sourcePage: item.sourcePage,
      ...postingFactItemFields,
    },
  };
  return {
    index,
    linkedInJobId,
    canonicalUrl,
    title,
    company,
    description: item.description,
    location,
    salary: item.salary,
    postedAt: item.postedAt,
    postingFacts,
    workplaceType: linkedInWorkplaceTypeFromLocation(location),
    notes,
    rawPayload,
  };
}

/**
 * Parses the whole exported document. A non-array root, an empty array or an
 * oversized file is a file-level error; individual bad items are reported with
 * their index and reason and never stop the valid ones from being staged.
 */
export function parseLinkedInSavedExport(document: unknown): LinkedInSavedExportParseResult {
  if (!Array.isArray(document)) {
    throw new LinkedInSavedExportFileError("The export must be a JSON array of saved jobs.");
  }
  if (document.length === 0) {
    throw new LinkedInSavedExportFileError("The export contains no saved jobs; re-run the browser export.");
  }
  if (document.length > LINKEDIN_SAVED_MAX_ITEMS) {
    throw new LinkedInSavedExportFileError(`The export has ${document.length} items; the limit is ${LINKEDIN_SAVED_MAX_ITEMS}.`);
  }

  const valid: LinkedInSavedJob[] = [];
  const invalid: LinkedInSavedItemError[] = [];
  const duplicatesInFile: LinkedInSavedExportParseResult["duplicatesInFile"] = [];
  const firstById = new Map<string, LinkedInSavedJob>();
  document.forEach((value, index) => {
    const result = parseLinkedInSavedJobItem(value, index);
    if (typeof result === "string") {
      invalid.push({ index, reason: result });
      return;
    }
    const first = firstById.get(result.linkedInJobId);
    if (first) {
      if (contentKey(first) === contentKey(result)) {
        duplicatesInFile.push({ index, firstIndex: first.index, linkedInJobId: result.linkedInJobId });
      } else {
        invalid.push({
          index,
          reason: `LinkedIn job ${result.linkedInJobId} appears again (first at index ${first.index}) with different content`,
        });
      }
      return;
    }
    firstById.set(result.linkedInJobId, result);
    valid.push(result);
  });
  return { total: document.length, valid, invalid, duplicatesInFile };
}

/** Parses the export file text; JSON syntax errors are file-level errors. */
export function parseLinkedInSavedExportText(text: string): LinkedInSavedExportParseResult {
  let document: unknown;
  try {
    document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new LinkedInSavedExportFileError(`The export is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseLinkedInSavedExport(document);
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export type SavedPostingIdentityCheck =
  | { readonly matches: true }
  | { readonly matches: false; readonly reason: "TITLE_MISMATCH" | "COMPANY_MISMATCH" };

/**
 * Identity check between a Gmail discovery card and a saved export with the
 * same LinkedIn job id. The title must agree after normalization (the
 * normalizer requires this to link a retrieved posting to its Gmail parent);
 * the employer must agree by containment unless the card did not name one.
 */
export function savedPostingMatchesDiscovery(
  discovery: { readonly title: string; readonly companyName: string },
  saved: { readonly title: string; readonly companyName: string },
): SavedPostingIdentityCheck {
  const discoveryTitle = normalizeIdentity(discovery.title);
  if (!discoveryTitle || discoveryTitle !== normalizeIdentity(saved.title)) {
    return { matches: false, reason: "TITLE_MISMATCH" };
  }
  const expectedCompany = normalizeIdentity(discovery.companyName);
  const actualCompany = normalizeIdentity(saved.companyName);
  const companyUnknown = isUnknownEmployerName(discovery.companyName);
  if (!actualCompany || (!companyUnknown
    && expectedCompany !== actualCompany
    && !expectedCompany.includes(actualCompany)
    && !actualCompany.includes(expectedCompany))) {
    return { matches: false, reason: "COMPANY_MISMATCH" };
  }
  return { matches: true };
}
