/**
 * The blind sheet, its key and the pass rule. The sheet shows no list, rank, score or comparison marker. Everything from
 * a posting is untrusted text: it is escaped, and a link is shown only when it is plain http or https. Pure.
 */
import { sheetJobs, type ReviewLists, type PoolJob } from "./reviewLists.js";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** The URL, parsed and percent-encoded so it is safe in a Markdown table cell; null unless plain http or https. */
export function safePostingLink(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw || CONTROL_CHARACTERS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  return url.href.replace(/[\s|<>()[\]`"'\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Untrusted text as one line of plain text in a Markdown table cell: no line breaks, format characters, Markdown or HTML. */
export function sheetText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\p{Cf}+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/www\.|mailto:|:\/\/|[&<>@\\`*_[\]()|~!#]/gi, (match) => {
      if (/^www\.$/i.test(match)) return `${match.slice(0, 3)}&#46;`;
      if (match === "://") return "&#58;//";
      if (match.length > 1) return `${match.slice(0, -1)}&#58;`;
      if (match === "&") return "&amp;";
      if (match === "<") return "&lt;";
      if (match === ">") return "&gt;";
      if (match === "@") return "&#64;";
      if (match === "#") return "&#35;";
      return `\\${match}`;
    });
}

function notes(job: PoolJob): string {
  return [
    job.saved ? "saved" : null,
    job.linkedInOnly ? "LinkedIn, not verified" : null,
    job.availability === "UNKNOWN" ? "open not confirmed" : null,
  ].filter(Boolean).join("; ");
}

export function renderReviewSheet(lists: ReviewLists, seed: string): string {
  const rows = sheetJobs(lists, seed).map((job, index) =>
    `| ${index + 1} | ${sheetText(job.title)} | ${sheetText(job.company)} | ${sheetText(job.location)} | ${safePostingLink(job.link) ?? ""} | ${notes(job)} |  |  |`);
  return [
    "# Review sheet: would you apply?",
    "",
    "For each job write **Y** (would apply), **N** (would not) or **closed** in the Apply column. Judge the role.",
    "",
    "| # | Title | Company | Location | Link | Notes | Apply? (Y/N/closed) | Comment |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export interface ReviewKeyItem {
  readonly n: number;
  readonly id: string;
  /** The role-type list that holds the job, and its rank there. */
  readonly roleList: { readonly type: string; readonly rank: number } | null;
  readonly overallRank: number | null;
  readonly comparison: boolean;
  readonly saved: boolean;
  readonly linkedInOnly: boolean;
  readonly availability: "OPEN" | "UNKNOWN";
  readonly roleType: string | null;
  readonly status: string;
  readonly sector: string;
  readonly industry: string | null;
  readonly reasons: readonly string[];
  readonly topK: number | null;
  readonly title: string;
}

export interface ReviewKey {
  readonly schema_version: "review_lists_key_v1";
  readonly name: string;
  readonly created_at: string;
  readonly seed: string;
  readonly overall_from_unsaved_only: boolean;
  readonly items: ReviewKeyItem[];
}

export function buildReviewKey(
  lists: ReviewLists,
  input: { name: string; createdAt: string; seed: string; overallFromUnsavedOnly: boolean },
): ReviewKey {
  const items = sheetJobs(lists, input.seed).map((job, index): ReviewKeyItem => {
    const list = lists.byType.find((entry) => entry.jobs.some((listed) => listed.id === job.id));
    const overall = lists.overall.findIndex((listed) => listed.id === job.id);
    return {
      n: index + 1,
      id: job.id,
      roleList: list ? { type: list.type.key, rank: list.jobs.findIndex((listed) => listed.id === job.id) + 1 } : null,
      overallRank: overall < 0 ? null : overall + 1,
      comparison: lists.comparison.some((listed) => listed.id === job.id),
      saved: job.saved,
      linkedInOnly: job.linkedInOnly,
      availability: job.availability,
      roleType: job.classification.roleType,
      status: job.classification.status,
      sector: job.classification.sector,
      industry: job.classification.industry,
      reasons: job.classification.reasons,
      topK: job.topK,
      title: job.title,
    };
  });
  return {
    schema_version: "review_lists_key_v1",
    name: input.name,
    created_at: input.createdAt,
    seed: input.seed,
    overall_from_unsaved_only: input.overallFromUnsavedOnly,
    items,
  };
}

/** The job ids of an earlier key file: any shape that has `items[].id`. A file without them fails. */
export function idsFromKeyText(text: string, fileName: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Key file ${fileName} is not valid JSON.`);
  }
  const items = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(`Key file ${fileName} has no items list.`);
  return items.map((item) => {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id.trim()) throw new Error(`Key file ${fileName} has an item without an id.`);
    return id.trim().toLowerCase();
  });
}

export type SheetAnswer = "YES" | "NO" | "CLOSED" | null;

/** The answer of each numbered row of a filled sheet. An answer that is not Y, N or closed fails with its row number. */
export function parseFilledSheet(markdown: string): Map<number, SheetAnswer> {
  const answers = new Map<number, SheetAnswer>();
  const invalid: number[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    // cells[0] is the text before the first bar; the answer is the seventh column.
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (cells.length < 8 || !/^\d+$/.test(cells[1] ?? "")) continue;
    const n = Number(cells[1]);
    if (answers.has(n)) throw new Error(`The filled sheet has row ${n} twice.`);
    const raw = (cells[7] ?? "").replace(/\*/g, "").trim().toLowerCase();
    if (raw === "") answers.set(n, null);
    else if (raw === "y" || raw === "yes") answers.set(n, "YES");
    else if (raw === "n" || raw === "no") answers.set(n, "NO");
    else if (raw === "closed") answers.set(n, "CLOSED");
    else invalid.push(n);
  }
  if (invalid.length) throw new Error(`Rows with an answer that is not Y, N or closed: ${invalid.join(", ")}.`);
  return answers;
}

/** Fixed before labelling. */
export const PASS_MIN_OVERALL_YES = 6;
export const PASS_MIN_LEAD_POINTS = 20;

export interface Share {
  readonly yes: number;
  readonly counted: number;
}

export interface ReviewScore {
  readonly result: "PASS" | "FAIL" | "INCOMPLETE";
  readonly overall: Share;
  /** Every listed job once: the role-type lists and the overall list. */
  readonly lists: Share;
  readonly comparison: Share;
  readonly byRoleType: Array<{ type: string } & Share>;
  readonly notCounted: { saved: number; linkedInClosed: number };
  /** Marked closed but not LinkedIn-only: counted, and not a yes. */
  readonly otherClosed: number;
  /** Counted rows with no answer. */
  readonly blank: number[];
}

/**
 * Pass: at least PASS_MIN_OVERALL_YES jobs of the overall list are a yes, AND the yes share of the listed jobs is at
 * least PASS_MIN_LEAD_POINTS percentage points above that of the comparison jobs. Saved jobs are not counted, nor is a
 * LinkedIn-only job marked closed.
 */
export function scoreReviewSheet(filledSheet: string, key: Pick<ReviewKey, "items">): ReviewScore {
  const answers = parseFilledSheet(filledSheet);
  const missing = key.items.filter((item) => !answers.has(item.n)).map((item) => item.n);
  if (missing.length) throw new Error(`The filled sheet has no row for: ${missing.join(", ")}.`);
  if (answers.size !== key.items.length) throw new Error("The filled sheet has rows that the key does not hold.");

  const notCounted = { saved: 0, linkedInClosed: 0 };
  const counted: ReviewKeyItem[] = [];
  for (const item of key.items) {
    if (item.saved) notCounted.saved += 1;
    else if (item.linkedInOnly && answers.get(item.n) === "CLOSED") notCounted.linkedInClosed += 1;
    else counted.push(item);
  }
  const share = (items: readonly ReviewKeyItem[]): Share => ({
    yes: items.filter((item) => answers.get(item.n) === "YES").length,
    counted: items.length,
  });
  const overall = share(counted.filter((item) => item.overallRank !== null));
  const lists = share(counted.filter((item) => item.overallRank !== null || item.roleList !== null));
  const comparison = share(counted.filter((item) => item.comparison));
  const types = [...new Set(key.items.flatMap((item) => (item.roleList ? [item.roleList.type] : [])))].sort();
  const byRoleType = types.map((type) => ({ type, ...share(counted.filter((item) => item.roleList?.type === type)) }));
  const blank = counted.filter((item) => answers.get(item.n) === null).map((item) => item.n);

  // Integer arithmetic, so a lead of exactly the minimum passes.
  const leads = (lists.yes * comparison.counted - comparison.yes * lists.counted) * 100
    >= PASS_MIN_LEAD_POINTS * lists.counted * comparison.counted;
  const result = blank.length > 0 || lists.counted === 0 || comparison.counted === 0
    ? "INCOMPLETE"
    : overall.yes >= PASS_MIN_OVERALL_YES && leads ? "PASS" : "FAIL";
  return {
    result, overall, lists, comparison, byRoleType, notCounted,
    otherClosed: counted.filter((item) => answers.get(item.n) === "CLOSED").length,
    blank,
  };
}
