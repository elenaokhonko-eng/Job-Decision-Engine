/**
 * Hacker News "Ask HN: Who is hiring?" adapter.
 *
 * Reads the monthly thread posted by the `whoishiring` account through the
 * official HN Firebase API (https://github.com/HackerNews/API). Each top-level
 * comment is one employer post whose first line conventionally reads
 * `Company | Role(s) | Location | REMOTE/ONSITE | Salary | URL`.
 *
 * - Source identity is the HN comment id; the raw item (minus the volatile
 *   `kids` reply list) is the raw payload, so an edited comment produces a new
 *   payload hash exactly like a changed posting from any other source.
 * - The cursor `hn:<threadId>:<lastSettledCommentId>` only advances past
 *   comments older than the HN edit window, so recent comments are re-read once
 *   more and edits are captured. HN ids are monotonic, so later runs read only
 *   comments posted after the cursor; a new monthly thread restarts the sweep.
 * - Comments that are deleted, dead, non-conforming, or clearly incompatible
 *   with the workability policy are returned as `filteredCandidates` with a
 *   reason code and their raw payload; they never disappear silently.
 * - Any HTTP, timeout, or JSON failure fails the whole page (no partial page is
 *   staged and the cursor does not move).
 */
import { ExtractedJob, SCHEMA_VERSION, SourceName } from "../../contracts/index.js";
import { stripHtmlToText } from "../../security/sanitize.js";
import { findOnsiteException } from "../../pipeline/onsiteExceptions.js";
import {
  evaluateWorkerTerritoryRequirements,
  extractExplicitWorkerTerritoryRequirements,
  type WorkabilityPolicy,
} from "../../pipeline/workabilityPolicy.js";
import { neutralizeWorkplacePerkPhrases } from "../../pipeline/workplacePerkPhrases.js";
import {
  BaseSourceAdapter,
  type AdapterFetchOptions,
  type AdapterResult,
  type FilteredSourceCandidate,
} from "./baseAdapter.js";

export const HN_API_BASE_URL = "https://hacker-news.firebaseio.com/v0";
export const HN_ITEM_URL_PREFIX = "https://news.ycombinator.com/item?id=";
export const HN_WHOISHIRING_USER = "whoishiring";
/** Hard cap on comments read in one run, independent of the plugin's items_per_run. */
export const HN_MAX_COMMENTS_PER_RUN = 200;
/** Upper bound on top-level comments accepted from one thread (a thread has ~300-700). */
export const HN_MAX_THREAD_COMMENTS = 3_000;
export const HN_MAX_CONCURRENCY = 4;
/** HN allows edits for two hours; comments younger than this are re-read on the next run. */
export const HN_EDIT_SETTLE_MS = 3 * 60 * 60 * 1000;

const WHO_IS_HIRING_TITLE = /^\s*ask hn:\s*who is hiring\?/i;

export type HackerNewsSkipReason =
  | "HN_COMMENT_DELETED"
  | "HN_COMMENT_DEAD"
  | "HN_ITEM_UNAVAILABLE"
  | "HN_NOT_TOP_LEVEL_COMMENT"
  | "HN_EMPTY_COMMENT"
  | "HN_NON_CONFORMING_POST"
  | "PREFILTER_ONSITE_ONLY"
  | "PREFILTER_WORK_TERRITORY_INCOMPATIBLE";

export interface HackerNewsRunStats {
  readonly threadId: number | null;
  readonly threadTitle: string | null;
  readonly threadComments: number;
  readonly commentsFetched: number;
  readonly postingsReturned: number;
  readonly skipped: Readonly<Partial<Record<HackerNewsSkipReason, number>>>;
  readonly cursorIn: string | null;
  readonly cursorOut: string | null;
  readonly cursorReset: "NONE" | "NEW_THREAD" | "UNREADABLE_CURSOR";
}

export interface HackerNewsAdapterOptions {
  /** Workability policy used for the volume pre-filter. Without it only parse skips apply. */
  readonly workabilityPolicy?: Pick<WorkabilityPolicy, "authorizedRegions" | "rejectExplicitForeignTerritory" | "onsiteOnlyAllowed" | "allowedWorkModes" | "researchOnsiteExceptions" | "onsiteExceptionEmployers">;
  readonly concurrency?: number;
  readonly maxCommentsPerRun?: number;
  /** Newest `whoishiring` submissions inspected while looking for the hiring thread. */
  readonly maxThreadCandidates?: number;
  readonly requestTimeoutMs?: number;
  /** Wall-clock budget for one fetchJobs call; exceeding it fails the run. */
  readonly runDeadlineMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => Date;
}

/** A comment parsed from the posting convention. */
export interface ParsedHiringPost {
  readonly company: string;
  readonly title: string;
  readonly locationRaw: string | null;
  readonly workMode: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
  readonly employmentType: string | null;
  readonly salaryText: string | null;
  readonly applyUrl: string | null;
  readonly headerLine: string;
  /** The header states partial attendance ("2-3x per week"), so the role is not on-site only. */
  readonly attendanceQualified: boolean;
  readonly description: string;
  readonly mentionsRemoteOrHybrid: boolean;
}

export type ParsedCommentResult =
  | { readonly kind: "POSTING"; readonly post: ParsedHiringPost }
  | { readonly kind: "SKIPPED"; readonly reasonCode: HackerNewsSkipReason; readonly reasonDetail: string };

export interface HnItem {
  readonly id: number;
  readonly type?: string;
  readonly by?: string;
  readonly time?: number;
  readonly text?: string;
  readonly title?: string;
  readonly parent?: number;
  readonly kids?: readonly number[];
  readonly deleted?: boolean;
  readonly dead?: boolean;
}

class HackerNewsRequestError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly rateLimited = false) {
    super(message);
    this.name = "HackerNewsRequestError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // HN Firebase JSON is narrowed at this external API boundary.
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function toHnItem(value: unknown): HnItem | null {
  const record = asRecord(value);
  const id = positiveInteger(record?.id);
  if (!record || id === null) return null;
  const kids = Array.isArray(record.kids) ? record.kids.filter((kid): kid is number => positiveInteger(kid) !== null) : undefined;
  return {
    id,
    type: typeof record.type === "string" ? record.type : undefined,
    by: typeof record.by === "string" ? record.by : undefined,
    time: positiveInteger(record.time) ?? undefined,
    text: typeof record.text === "string" ? record.text : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    parent: positiveInteger(record.parent) ?? undefined,
    kids,
    deleted: record.deleted === true,
    dead: record.dead === true,
  };
}

/** The stored raw payload: the provider item without its volatile reply list. */
function rawCommentPayload(raw: unknown, thread: { id: number; title: string }): Record<string, unknown> {
  const record = asRecord(raw) ?? { value: raw };
  const { kids: _replies, ...item } = record;
  return { hn_item: item, thread };
}

export function isWhoIsHiringTitle(title: unknown): boolean {
  return typeof title === "string" && WHO_IS_HIRING_TITLE.test(title);
}

export function hnItemUrl(id: number): string {
  return `${HN_ITEM_URL_PREFIX}${id}`;
}

// ---------------------------------------------------------------------------
// Comment parsing
// ---------------------------------------------------------------------------

const ROLE_PATTERN = /\b(?:engineer(?:s|ing)?|eng\b|developer(?:s)?|scientist(?:s)?|architect(?:s)?|manager(?:s)?|designer(?:s)?|analyst(?:s)?|researcher(?:s)?|head of|director(?:s)?|vp\b|cto|ciso|founding|programmer(?:s)?|sre(?:s)?|devops|intern(?:s|ship)?|specialist(?:s)?|consultant(?:s)?|administrator(?:s)?|product owner|recruiter(?:s)?|technician(?:s)?|marketer(?:s)?|executive(?:s)?|officer(?:s)?|representative(?:s)?|coordinator(?:s)?|strategist(?:s)?|member of technical staff|swe(?:s)?|mle(?:s)?|tech lead|team lead|lead\b|staff\b|principal\b|counsel|attorney|accountant|economist|statistician|phd|postdoc|fellow(?:ship)?|scrum master|qa\b)/i;
/** Role nouns strong enough to read a short body line as a job title. */
const BODY_ROLE_PATTERN = /\b(?:engineer(?:s)?|developer(?:s)?|scientist(?:s)?|architect(?:s)?|manager(?:s)?|designer(?:s)?|analyst(?:s)?|researcher(?:s)?|director(?:s)?|head of|programmer(?:s)?|sre(?:s)?|intern(?:s)?|specialist(?:s)?|consultant(?:s)?|administrator(?:s)?|recruiter(?:s)?|technician(?:s)?|marketer(?:s)?|executive(?:s)?|officer(?:s)?|representative(?:s)?|lead)\b/i;
const MAX_BODY_ROLES = 8;
/** "Multiple roles" and similar placeholders name no role and are not a location. */
const ROLE_PLACEHOLDER_PATTERN = /^(?:multiple|several|various|many|all|open|\d+)?\s*(?:[\w-]+\s+)?(?:roles?|positions?|openings?|jobs?)\b/i;
/** Benefit and status segments ("Equity", "VISA + relocation") are neither roles nor locations. */
const NON_LOCATION_PATTERN = /\b(?:equity|visa|relocation|sponsorship|benefits?|bonus|profitable|pmf|hiring|seed|series|yc|funded)\b/i;
/** An attendance qualifier ("2-3x per week", "3 days in office") means the role is not on-site only. */
const ATTENDANCE_QUALIFIER_PATTERN = /\b\d\s*(?:\+|-|–|to)?\s*\d?\s*(?:x|days?|times)\s*(?:\/\s*|per\s+|a\s+)?(?:week|wk)\b|\b\d\+?\s*days?\s+(?:in|at)\s+(?:the\s+)?office\b|\bpart(?:ly|ially)?[- ](?:remote|wfh)\b|\bflexib(?:le|ility)\b/i;
/** Only an explicit exclusivity phrase lets the header territory pre-filter drop a post. */
const EXCLUSIVE_TERRITORY_PATTERN = /\bonly\b|\bcitizen(?:s|ship)?\b|\bmust\s+(?:be|reside|live)\b|\bauthori[sz]ation\s+required\b|\bwork\s+authori[sz]ation\b|\bresidents?\b/i;
const WORK_MODE_PATTERN = /\b(?:remote|on[- ]?site|in[- ]office|hybrid|wfh)\b/i;
const REMOTE_PATTERN = /\b(?:remote|wfh|work from home)\b/i;
const REMOTE_NEGATED_PATTERN = /\b(?:no|not|non)[- ]remote\b|\bremote\s*:\s*no\b/i;
const HYBRID_PATTERN = /\bhybrid\b/i;
const ONSITE_PATTERN = /\b(?:on[- ]?site|in[- ]office|in[- ]person)\b/i;
const EMPLOYMENT_PATTERN = /\b(?:full[- ]?time|part[- ]?time|contract(?:or)?s?|freelance|permanent|internships?|ft|pt)\b/i;
const VISA_PATTERN = /\bvisa\b/i;
const MONEY_PATTERN = /(?:(?:[$€£]|\b(?:USD|EUR|GBP|SGD|CAD|AUD|CHF|INR)\s?)\d[\d,.]*\s?[kK]?(?:\s?(?:-|–|—|to)\s?(?:[$€£]|\b(?:USD|EUR|GBP|SGD|CAD|AUD|CHF|INR)\s?)?\d[\d,.]*\s?[kK]?)?(?:\s?(?:USD|EUR|GBP|SGD|CAD|AUD|CHF|INR)\b)?(?:\s?(?:\/\s?(?:yr|year|hr|hour)|per (?:year|annum|hour)))?(?:\s?\+\s?equity)?)|\b\d{2,3}\s?[kK]\s?(?:-|–|—|to)\s?\d{2,3}\s?[kK]\b(?:\s?(?:USD|EUR|GBP|SGD|CAD|AUD|CHF|INR)\b)?(?:\s?\+\s?equity)?/;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')|]+/i;
// Bare domains need a common web TLD so tokens such as "Node.js" are never read as URLs.
const BARE_DOMAIN_PATTERN = /^(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|io|ai|co|org|net|dev|app|tech|so|xyz|health|bio|jobs|careers|us|uk|de|fr|nl|sg|ca|eu|me|gg|sh|vc|fund|finance|capital|systems|software|cloud|world|inc)(?:\/[^\s]*)?$/i;
const FUNDING_PATTERN = /\b(?:raised|raise|funding|funded|series [a-f]|seed|valuation|revenue|arr|backed|investors?)\b/i;
const PLACE_LIKE_PATTERN = /^[\p{L}][\p{L}\s.,'’()\/&+-]{1,100}$/u;

function decodeHref(href: string): string {
  return stripHtmlToText(href).trim();
}

function validHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim().replace(/[.,;:!?)]+$/, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isHackerNewsHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "news.ycombinator.com" || host === "ycombinator.com";
  } catch {
    return false;
  }
}

/** HN comment HTML to readable text, keeping the full href of every link (HN truncates long link text). */
export function hnCommentHtmlToText(html: string): string {
  const withHrefs = html.replace(/<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, (_match, href: string) => ` ${href} `);
  return stripHtmlToText(withHrefs)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function headerHtml(html: string): string {
  const paragraphBreak = html.search(/<p\b[^>]*>/i);
  return paragraphBreak >= 0 ? html.slice(0, paragraphBreak) : html;
}

function linkHrefs(html: string): string[] {
  return [...html.matchAll(/<a\s[^>]*href="([^"]*)"/gi)]
    .map((match) => validHttpUrl(decodeHref(match[1] ?? "")))
    .filter((url): url is string => url !== null && !isHackerNewsHost(url));
}

function segmentUrl(segment: string): string | null {
  const explicit = segment.match(URL_PATTERN)?.[0];
  if (explicit) return validHttpUrl(explicit);
  const bare = segment.trim().replace(/^\(|\)$/g, "");
  if (BARE_DOMAIN_PATTERN.test(bare)) return validHttpUrl(`https://${bare}`);
  return null;
}

function isUrlSegment(segment: string): boolean {
  const trimmed = segment.trim().replace(/^(?:apply|careers?|jobs?|more info|info|link)\s*[:\-]\s*/i, "");
  return URL_PATTERN.test(trimmed) && trimmed.replace(URL_PATTERN, "").trim().length === 0
    || BARE_DOMAIN_PATTERN.test(trimmed.replace(/^\(|\)$/g, ""));
}

function cleanCompany(segment: string): string {
  return segment
    .replace(/\(\s*(?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}[^)]*\)/gi, " ")
    .replace(URL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s:,-]+$/, "")
    .trim();
}

/**
 * Role titles listed in the body when the header names none ("Multiple roles").
 * Accepts only short title-like lines (a bullet list item or a "Roles: a, b"
 * line), never prose sentences, so a role is not guessed from narrative text.
 */
export function bodyRoleTitles(bodyText: string): string[] {
  const titles: string[] = [];
  const add = (candidate: string): void => {
    const title = candidate
      .replace(URL_PATTERN, " ")
      .replace(/\(\s*\)/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s\-–—*•·>#\d.)]+/, "")
      .replace(/[\s:;,\-–—]+$/, "")
      .trim();
    if (title.length < 4 || title.length > 90 || title.split(/\s+/).length > 12) return;
    if (!BODY_ROLE_PATTERN.test(title)) return;
    if (/\b(?:we|we're|you|you'll|our|us|i|i'm|my)\b/i.test(title) || /[.!?]\s+\S/.test(title) || /[.!?:]$|:\s/.test(title)) return;
    if (/\b\d+\+?\s*(?:years?|yrs?|yoe)\b|\b(?:experience|requirements?|responsibilities)\b/i.test(title)) return;
    if (!titles.some((existing) => existing.toLowerCase() === title.toLowerCase())) titles.push(title);
  };
  for (const rawLine of bodyText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const listed = line.match(/^(?:open\s+)?(?:roles?|positions?|openings?|hiring(?:\s+for)?|we(?:'re|\s+are)\s+hiring(?:\s+for)?)\s*:\s*(.+)$/i);
    if (listed) {
      for (const part of (listed[1] ?? "").split(/[,;]|\s+and\s+/)) add(part);
    } else if (/^[-–—*•·]\s+/.test(line) || line.length <= 90) {
      add(line);
    }
    if (titles.length >= MAX_BODY_ROLES) break;
  }
  return titles.slice(0, MAX_BODY_ROLES);
}

function salaryLike(segment: string): boolean {
  return MONEY_PATTERN.test(segment) && !FUNDING_PATTERN.test(segment);
}

function mentionsRemoteOrHybrid(text: string): boolean {
  const withoutNegations = text.replace(new RegExp(REMOTE_NEGATED_PATTERN.source, "gi"), " ");
  return REMOTE_PATTERN.test(withoutNegations) || HYBRID_PATTERN.test(withoutNegations);
}

function workModeFrom(text: string): ParsedHiringPost["workMode"] {
  const remote = REMOTE_PATTERN.test(text) && !REMOTE_NEGATED_PATTERN.test(text);
  if (remote) return "REMOTE";
  if (HYBRID_PATTERN.test(text)) return "HYBRID";
  // A workplace perk ("Onsite gym") is neutral, never on-site evidence.
  if (ONSITE_PATTERN.test(neutralizeWorkplacePerkPhrases(text))) return "ONSITE";
  return "UNKNOWN";
}

/** Keep a header segment up to its first sentence break; long posts sometimes run prose into the header. */
function firstSentence(segment: string): string {
  const cut = segment.search(/[.!?]\s+[A-Z]/);
  return (cut >= 0 ? segment.slice(0, cut + 1) : segment).replace(/[\s.]+$/, "").trim();
}

function isBareWorkModeSegment(segment: string): boolean {
  return /^(?:remote|on[- ]?site|onsite only|in[- ]office|hybrid|remote ok|remote friendly|remote-first|fully remote|wfh)$/i.test(segment.trim());
}

/**
 * Parse one top-level comment. Returns SKIPPED with a reason when the post is
 * deleted, dead, empty, or does not follow the convention well enough to find
 * a company and at least one role.
 */
export function parseWhoIsHiringComment(item: HnItem, threadId: number): ParsedCommentResult {
  if (item.deleted) return { kind: "SKIPPED", reasonCode: "HN_COMMENT_DELETED", reasonDetail: `HN comment ${item.id} is deleted.` };
  if (item.dead) return { kind: "SKIPPED", reasonCode: "HN_COMMENT_DEAD", reasonDetail: `HN comment ${item.id} is dead (flagged or killed).` };
  if (item.type !== "comment" || item.parent !== threadId) {
    return { kind: "SKIPPED", reasonCode: "HN_NOT_TOP_LEVEL_COMMENT", reasonDetail: `HN item ${item.id} is not a top-level comment of thread ${threadId}.` };
  }
  const html = item.text ?? "";
  const description = hnCommentHtmlToText(html);
  if (!description) return { kind: "SKIPPED", reasonCode: "HN_EMPTY_COMMENT", reasonDetail: `HN comment ${item.id} has no text.` };

  const header = hnCommentHtmlToText(headerHtml(html)).split("\n")[0]?.trim() ?? "";
  const bodyHrefs = linkHrefs(html);
  const segments = header.split("|").map((segment) => firstSentence(segment.trim())).filter(Boolean);

  let company = "";
  const roles: string[] = [];
  const placeholderRoles: string[] = [];
  const locations: string[] = [];
  const salaries: string[] = [];
  let employmentType: string | null = null;
  let headerUrl: string | null = null;

  if (segments.length >= 2) {
    company = cleanCompany(segments[0] ?? "");
    headerUrl = segmentUrl(segments[0] ?? "");
    for (const segment of segments.slice(1)) {
      if (isUrlSegment(segment)) {
        headerUrl ??= segmentUrl(segment);
        continue;
      }
      const hasRole = ROLE_PATTERN.test(segment);
      if (!hasRole && salaryLike(segment)) {
        salaries.push(segment);
        continue;
      }
      if (!hasRole && WORK_MODE_PATTERN.test(neutralizeWorkplacePerkPhrases(segment))) {
        // A bare "REMOTE"/"ONSITE" sets the work mode only; a qualified one ("Remote (EU)") is also location text.
        if (!isBareWorkModeSegment(segment)) locations.push(segment);
        continue;
      }
      if (!hasRole && VISA_PATTERN.test(segment)) continue;
      if (!hasRole && EMPLOYMENT_PATTERN.test(segment) && segment.length <= 40) {
        employmentType ??= segment;
        continue;
      }
      if (hasRole && ROLE_PLACEHOLDER_PATTERN.test(segment)) {
        // "Multiple Engineering Roles": prefer the titles listed in the body, keep this as a fallback.
        placeholderRoles.push(segment);
        continue;
      }
      if (hasRole) {
        const role = segment.replace(URL_PATTERN, " ").replace(/\s+/g, " ").replace(/[\s:;,\-–—]+$/, "").trim();
        if (role) roles.push(role);
        continue;
      }
      if (ROLE_PLACEHOLDER_PATTERN.test(segment) || NON_LOCATION_PATTERN.test(segment)) continue;
      if (PLACE_LIKE_PATTERN.test(segment) && segment.length <= 60 && segment.split(/\s+/).length <= 8) locations.push(segment);
    }
  } else {
    const fallback = firstSentence(header).match(/^(.{2,60}?)\s+(?:is|are)\s+hiring\b[\s:–—-]*(?:an?\s+|for\s+)?(?!in\b|at\b)(.{3,200}?)[.!]?$/i);
    const role = (fallback?.[2] ?? "").replace(URL_PATTERN, " ").replace(/\s+/g, " ").replace(/[\s:;,\-–—]+$/, "").trim();
    if (fallback && ROLE_PATTERN.test(role)) {
      company = cleanCompany(fallback[1] ?? "");
      roles.push(role);
    }
  }

  if (segments.length >= 2 && company && roles.length === 0) {
    // "Company | Multiple roles | Location": the convention holds but the roles are listed in the body.
    const headerEnd = description.indexOf("\n");
    roles.push(...bodyRoleTitles(headerEnd >= 0 ? description.slice(headerEnd + 1) : ""));
    if (roles.length === 0) roles.push(...placeholderRoles);
  }

  if (!company || !/\p{L}/u.test(company) || company.length > 100 || roles.length === 0) {
    return {
      kind: "SKIPPED",
      reasonCode: "HN_NON_CONFORMING_POST",
      reasonDetail: `HN comment ${item.id} does not follow the "Company | Role | Location" convention closely enough to identify a company and a role.`,
    };
  }

  // Salary is kept only as written in the header; it is never inferred from the body.
  const salaryText = salaries.length > 0
    ? salaries.join("; ")
    : segments.filter(salaryLike).map((segment) => segment.match(MONEY_PATTERN)?.[0]?.trim() ?? "").find(Boolean) ?? null;
  const workMode = workModeFrom(segments.length >= 2 ? segments.slice(1).join(" | ") : header);
  const locationRaw = locations.length > 0
    ? locations.join("; ")
    : workMode === "REMOTE" ? "Remote" : null;
  const applyUrl = headerUrl ?? bodyHrefs[0] ?? null;

  return {
    kind: "POSTING",
    post: {
      company,
      title: roles.join("; "),
      locationRaw,
      workMode,
      employmentType,
      salaryText,
      applyUrl,
      headerLine: header,
      attendanceQualified: ATTENDANCE_QUALIFIER_PATTERN.test(header),
      description,
      mentionsRemoteOrHybrid: mentionsRemoteOrHybrid(description),
    },
  };
}

/**
 * Volume pre-filter. Drops only what the workability policy deterministically
 * excludes, using the same territory evaluation as the hard gate; unknown or
 * ambiguous facts always pass so the gate can return NEEDS_VERIFICATION.
 */
export function prefilterWhoIsHiringPost(
  post: ParsedHiringPost,
  policy: NonNullable<HackerNewsAdapterOptions["workabilityPolicy"]>,
): { reasonCode: HackerNewsSkipReason; reasonDetail: string } | null {
  const onsiteAllowed = policy.onsiteOnlyAllowed || policy.allowedWorkModes.includes("ONSITE");
  // The same on-site exceptions as the hard gate: a research/university role or a
  // user-listed employer is left for the gate instead of being filtered out here.
  const onsiteException = findOnsiteException(
    { title: post.title, company_name: post.company, description: post.description },
    policy,
  );
  if (!onsiteAllowed && !onsiteException && post.workMode === "ONSITE" && !post.mentionsRemoteOrHybrid && !post.attendanceQualified) {
    return {
      reasonCode: "PREFILTER_ONSITE_ONLY",
      reasonDetail: `Header states on-site work and the post never mentions remote or hybrid work; the workability policy does not allow on-site-only roles. Header: ${post.headerLine}`,
    };
  }
  // Only explicitly exclusive header phrases ("Remote (US only)", "US citizenship required") are used;
  // a bare location or a visa mention is left for the gate.
  const requirements = extractExplicitWorkerTerritoryRequirements(post.headerLine)
    .filter((requirement) => EXCLUSIVE_TERRITORY_PATTERN.test(requirement.evidenceText));
  if (requirements.length > 0) {
    const evaluation = evaluateWorkerTerritoryRequirements(requirements, policy.authorizedRegions, policy.rejectExplicitForeignTerritory);
    if (evaluation.status === "INCOMPATIBLE") {
      return {
        reasonCode: "PREFILTER_WORK_TERRITORY_INCOMPATIBLE",
        reasonDetail: `Header restricts workers to ${evaluation.incompatibleTerritories.join(", ")}, outside the authorized regions (${policy.authorizedRegions.join(", ") || "none"}). Header: ${post.headerLine}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function parseCursor(cursor: string | null | undefined): { threadId: number; afterId: number } | null | "UNREADABLE" {
  if (!cursor) return null;
  const match = /^hn:(\d{1,15}):(\d{1,15})$/.exec(cursor);
  if (!match) return "UNREADABLE";
  return { threadId: Number(match[1]), afterId: Number(match[2]) };
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const failure: { error: unknown } = { error: null };
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index] as T);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure.error = error;
        }
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure.error;
  return results;
}

export class HackerNewsWhoIsHiringAdapter extends BaseSourceAdapter {
  sourceName: SourceName = "HACKER_NEWS";
  private readonly baseUrl: string;
  private readonly options: HackerNewsAdapterOptions;
  private stats: HackerNewsRunStats | null = null;

  constructor(endpoint: string = HN_API_BASE_URL, options: HackerNewsAdapterOptions = {}) {
    super();
    this.baseUrl = endpoint.trim().replace(/\/+$/, "");
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  get lastRunStats(): HackerNewsRunStats | null {
    return this.stats;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async getJson(url: string, deadline: number): Promise<unknown> {
    const maxAttempts = Math.max(1, Math.min(this.options.maxAttempts ?? 2, 5));
    let lastError: HackerNewsRequestError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (Date.now() > deadline) {
        throw new HackerNewsRequestError(`HN run deadline of ${this.options.runDeadlineMs ?? 180_000}ms exceeded before ${url}.`, false);
      }
      try {
        const response = await this.fetchWithTimeout(url, { headers: { Accept: "application/json", "User-Agent": "JobDecisionEngine/1.0" } });
        if (response.status === 429) throw new HackerNewsRequestError(`429 Rate limited by HN API at ${url}.`, false, true);
        if (!response.ok) {
          throw new HackerNewsRequestError(`HTTP ${response.status} from HN API at ${url}.`, response.status >= 500);
        }
        try {
          return await this.readJsonResponse(response);
        } catch (error) {
          throw new HackerNewsRequestError(`Malformed HN API response at ${url}: ${error instanceof Error ? error.message : String(error)}`, false);
        }
      } catch (error) {
        if (error instanceof HackerNewsRequestError) {
          lastError = error;
        } else if (error instanceof Error && error.name === "AbortError") {
          lastError = new HackerNewsRequestError(`Timeout after ${this.timeoutMs}ms at ${url}.`, true);
        } else {
          lastError = new HackerNewsRequestError(`Network error at ${url}: ${error instanceof Error ? error.message : String(error)}`, true);
        }
        if (!lastError.retryable || attempt === maxAttempts) throw lastError;
        const delay = this.options.retryDelayMs ?? 500;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError ?? new HackerNewsRequestError(`HN API request failed at ${url}.`, false);
  }

  private async findLatestHiringThread(deadline: number): Promise<{ item: HnItem; raw: unknown }> {
    const user = asRecord(await this.getJson(`${this.baseUrl}/user/${HN_WHOISHIRING_USER}.json`, deadline));
    if (!user || !Array.isArray(user.submitted)) {
      throw new HackerNewsRequestError(`HN user ${HN_WHOISHIRING_USER} response has no submitted list.`, false);
    }
    const submitted = user.submitted
      .filter((id): id is number => positiveInteger(id) !== null)
      .sort((left, right) => right - left)
      .slice(0, Math.max(1, Math.min(this.options.maxThreadCandidates ?? 6, 30)));
    for (const id of submitted) {
      const raw = await this.getJson(`${this.baseUrl}/item/${id}.json`, deadline);
      const item = toHnItem(raw);
      if (!item || item.deleted || item.dead || item.type !== "story") continue;
      if (item.by !== undefined && item.by !== HN_WHOISHIRING_USER) continue;
      if (isWhoIsHiringTitle(item.title)) return { item, raw };
    }
    throw new HackerNewsRequestError(
      `No "Ask HN: Who is hiring?" thread among the newest ${submitted.length} ${HN_WHOISHIRING_USER} submissions.`,
      false,
    );
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    this.stats = null;
    const deadline = Date.now() + (this.options.runDeadlineMs ?? 180_000);
    const limit = Math.max(1, Math.min(options.limit ?? HN_MAX_COMMENTS_PER_RUN, this.options.maxCommentsPerRun ?? HN_MAX_COMMENTS_PER_RUN, HN_MAX_COMMENTS_PER_RUN));
    const concurrency = Math.max(1, Math.min(this.options.concurrency ?? HN_MAX_CONCURRENCY, HN_MAX_CONCURRENCY));
    const parsedCursor = parseCursor(options.cursor);
    try {
      const thread = await this.findLatestHiringThread(deadline);
      const threadTitle = thread.item.title ?? "Ask HN: Who is hiring?";
      const commentIds = [...new Set(thread.item.kids ?? [])].sort((left, right) => left - right);
      this.assertRecordCount(commentIds, HN_MAX_THREAD_COMMENTS);
      const cursorReset: HackerNewsRunStats["cursorReset"] = parsedCursor === "UNREADABLE"
        ? "UNREADABLE_CURSOR"
        : parsedCursor !== null && parsedCursor.threadId !== thread.item.id ? "NEW_THREAD" : "NONE";
      const afterId = parsedCursor !== null && parsedCursor !== "UNREADABLE" && parsedCursor.threadId === thread.item.id
        ? parsedCursor.afterId
        : 0;
      const pending = commentIds.filter((id) => id > afterId);
      const pageIds = pending.slice(0, limit);
      const hasMore = pending.length > pageIds.length;

      const rawItems = await mapWithConcurrency(pageIds, concurrency, (id) => this.getJson(`${this.baseUrl}/item/${id}.json`, deadline));

      const threadRef = { id: thread.item.id, title: threadTitle };
      const jobs: ExtractedJob[] = [];
      const filteredCandidates: FilteredSourceCandidate[] = [];
      const skipped: Partial<Record<HackerNewsSkipReason, number>> = {};
      let quarantined = 0;
      const settleBefore = this.now().getTime() - HN_EDIT_SETTLE_MS;
      let settledAfter = afterId;
      let settling = true;
      const skip = (id: number, rawPayload: unknown, reasonCode: HackerNewsSkipReason, reasonDetail: string): void => {
        skipped[reasonCode] = (skipped[reasonCode] ?? 0) + 1;
        filteredCandidates.push({ identity: String(id), sourceUrl: hnItemUrl(id), rawPayload, reasonCode, reasonDetail });
      };

      pageIds.forEach((id, index) => {
        const raw = rawItems[index];
        const item = toHnItem(raw);
        if (settling) {
          // A missing item may not have propagated yet, so it holds the cursor back for a re-read.
          const settled = item !== null && (item.deleted === true || item.dead === true || (item.time !== undefined && item.time * 1000 <= settleBefore));
          if (settled) settledAfter = id;
          else settling = false;
        }
        const rawPayload = rawCommentPayload(raw, threadRef);
        if (!item || item.id !== id) {
          skip(id, rawPayload, "HN_ITEM_UNAVAILABLE", `HN API returned no item for comment id ${id}.`);
          return;
        }
        const parsed = parseWhoIsHiringComment(item, thread.item.id);
        if (parsed.kind === "SKIPPED") {
          skip(id, rawPayload, parsed.reasonCode, parsed.reasonDetail);
          return;
        }
        const prefilter = this.options.workabilityPolicy
          ? prefilterWhoIsHiringPost(parsed.post, this.options.workabilityPolicy)
          : null;
        if (prefilter) {
          skip(id, rawPayload, prefilter.reasonCode, prefilter.reasonDetail);
          return;
        }
        const post = parsed.post;
        const postingUrl = hnItemUrl(id);
        const candidate = {
          schema_version: SCHEMA_VERSION,
          source_external_id: String(id),
          company_name: post.company,
          title: post.title,
          location_raw: post.locationRaw ?? "Unknown",
          workplace_type_raw: post.workMode,
          employment_type_raw: post.employmentType ?? "UNKNOWN",
          compensation_raw: post.salaryText ?? "UNKNOWN",
          employer_posting_url: postingUrl,
          ...(post.applyUrl ? { application_url: post.applyUrl } : {}),
          canonical_apply_url: post.applyUrl ?? postingUrl,
          description_raw: post.description,
          ...(item.time !== undefined ? { published_at: new Date(item.time * 1000).toISOString() } : {}),
          source_attribution: `Hacker News: ${threadTitle}`,
          raw_payload: rawPayload,
        };
        const validated = this.validateJob(candidate, String(id));
        if (validated) jobs.push(validated);
        else quarantined++;
      });

      const nextCursor = `hn:${thread.item.id}:${settledAfter}`;
      this.stats = {
        threadId: thread.item.id,
        threadTitle,
        threadComments: commentIds.length,
        commentsFetched: pageIds.length,
        postingsReturned: jobs.length,
        skipped,
        cursorIn: options.cursor ?? null,
        cursorOut: nextCursor,
        cursorReset,
      };
      const parsedCount = jobs.length + quarantined;
      return {
        sourceName: this.sourceName,
        success: parsedCount === 0 || jobs.length > 0,
        jobs,
        totalFetched: pageIds.length,
        snapshotTotal: commentIds.length,
        quarantined,
        quarantinedCandidates: this.getQuarantinedCandidates(),
        filteredCandidates,
        nextCursor,
        hasMore,
        snapshotId: String(thread.item.id),
        error: parsedCount > 0 && jobs.length === 0 ? `All ${quarantined} parsed Hacker News posts were quarantined.` : undefined,
      };
    } catch (error) {
      if (error instanceof HackerNewsRequestError) return this.errorResult(error.message, { isRateLimited: error.rateLimited });
      return this.errorResult(error instanceof Error ? error.message : String(error));
    }
  }
}
