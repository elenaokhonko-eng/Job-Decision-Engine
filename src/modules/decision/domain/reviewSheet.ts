/**
 * The blind sheet, its key, the reveal and the pass rule. The owner rates from the posting text: the sheet shows no
 * link, saved mark, list, rank or comparison marker. The key keeps those sealed (encoded, so opening it by accident
 * shows nothing), and the reveal shows a link and the saved mark only for jobs already rated. Pure.
 */
import { headerLine, sheetCompany, sheetLocation, sheetPostingText, sheetWorkMode } from "./postingText.js";
import type { DroppedJob } from "./reviewDraft.js";
import { sheetJobs, type PoolJob, type ReviewLists } from "./reviewLists.js";

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

/**
 * Untrusted text as one line of plain text in a Markdown table cell: no line breaks, format characters, Markdown or HTML,
 * and no leading character a spreadsheet reads as a formula.
 */
export function sheetText(value: string | null | undefined): string {
  const cell = (value ?? "")
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
  return /^[=+-]/.test(cell) ? `'${cell}` : cell;
}

const FENCE = "~~~~";
const ANSWER_LABEL = "Answer (Y or N):";
const COMMENT_LABEL = "Comment:";

function sheetBlock(job: PoolJob, n: number, boardNames: ReadonlyMap<string, string>): string[] {
  return [
    `## Job ${n}`,
    "",
    `${ANSWER_LABEL} `,
    `${COMMENT_LABEL} `,
    "",
    `${FENCE}text`,
    `Title:     ${headerLine(job.title).toLowerCase()}`,
    `Company:   ${sheetCompany(job.company, boardNames)}`,
    `Location:  ${sheetLocation(job.location)}`,
    `Work mode: ${sheetWorkMode(job.workMode)}`,
    "",
    sheetPostingText(job.description),
    FENCE,
    "",
  ];
}

export function renderReviewSheet(lists: ReviewLists, seed: string, boardNames: ReadonlyMap<string, string> = new Map()): string {
  return [
    "# Review sheet: would you apply?",
    "",
    `For each job, read the posting and write **Y** (would apply) or **N** (would not) after \`${ANSWER_LABEL}\`.`,
    "A comment is optional. Do not change anything else. Links are shown only after you have answered.",
    "",
    ...sheetJobs(lists, seed).flatMap((job, index) => sheetBlock(job, index + 1, boardNames)),
  ].join("\n");
}

/** What the key keeps from the reader until the reveal and the score. */
export interface ReviewDetail {
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
  readonly company: string;
  readonly link: string;
}

export interface ReviewKey {
  readonly schema_version: "review_lists_key_v2";
  readonly name: string;
  readonly created_at: string;
  readonly seed: string;
  /** Row number and job id only: later runs read these to keep rated jobs out. */
  readonly items: ReadonlyArray<{ readonly n: number; readonly id: string }>;
  /** The details, base64 encoded. */
  readonly sealed: string;
}

export function buildReviewKey(
  lists: ReviewLists,
  input: { name: string; createdAt: string; seed: string; dropped?: readonly DroppedJob[] },
): ReviewKey {
  const details = sheetJobs(lists, input.seed).map((job, index): ReviewDetail => {
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
      company: job.company,
      link: job.link,
    };
  });
  return {
    schema_version: "review_lists_key_v2",
    name: input.name,
    created_at: input.createdAt,
    seed: input.seed,
    items: details.map(({ n, id }) => ({ n, id })),
    sealed: Buffer.from(JSON.stringify({ details, dropped: input.dropped ?? [] }), "utf8").toString("base64"),
  };
}

export function openReviewKey(text: string): { details: ReviewDetail[]; dropped: DroppedJob[] } {
  let key: Partial<ReviewKey>;
  try {
    key = JSON.parse(text.replace(/^\uFEFF/, "")) as Partial<ReviewKey>;
  } catch {
    throw new Error("Key file is not valid JSON.");
  }
  if (key.schema_version !== "review_lists_key_v2" || typeof key.sealed !== "string") {
    throw new Error("Key file is not a review-lists key of this version.");
  }
  return JSON.parse(Buffer.from(key.sealed, "base64").toString("utf8")) as { details: ReviewDetail[]; dropped: DroppedJob[] };
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

export interface SheetEntry {
  /** null when not answered. */
  readonly answer: "YES" | "NO" | null;
  readonly commented: boolean;
}

/**
 * The answer of each job of a filled sheet. Posting text sits inside fences and is never read. An answer that is not Y,
 * N or empty fails with its job number.
 */
export function parseFilledSheet(markdown: string): Map<number, SheetEntry> {
  const entries = new Map<number, { answer: SheetEntry["answer"]; commented: boolean; labelled: boolean }>();
  const invalid: number[] = [];
  let fenced = false;
  let current: number | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith(FENCE)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^## Job (\d+)\s*$/.exec(line);
    if (heading) {
      current = Number(heading[1]);
      if (entries.has(current)) throw new Error(`The filled sheet has job ${current} twice.`);
      entries.set(current, { answer: null, commented: false, labelled: false });
      continue;
    }
    const entry = current === null ? undefined : entries.get(current);
    if (!entry) continue;
    if (line.startsWith(ANSWER_LABEL)) {
      const raw = line.slice(ANSWER_LABEL.length).replace(/\*/g, "").trim().toLowerCase();
      entry.labelled = true;
      if (raw === "y" || raw === "yes") entry.answer = "YES";
      else if (raw === "n" || raw === "no") entry.answer = "NO";
      else if (raw !== "") invalid.push(current!);
    } else if (line.startsWith(COMMENT_LABEL)) {
      entry.commented = line.slice(COMMENT_LABEL.length).trim() !== "";
    }
  }
  const unlabelled = [...entries].filter(([, entry]) => !entry.labelled).map(([n]) => n);
  if (unlabelled.length) throw new Error(`The filled sheet has lost the answer line of: ${unlabelled.join(", ")}.`);
  if (invalid.length) throw new Error(`Rows with an answer that is not Y or N: ${invalid.join(", ")}.`);
  return new Map([...entries].map(([n, { answer, commented }]) => [n, { answer, commented }]));
}

function entriesFor(filledSheet: string, details: ReadonlyArray<{ n: number }>): Map<number, SheetEntry> {
  const entries = parseFilledSheet(filledSheet);
  const missing = details.filter((item) => !entries.has(item.n)).map((item) => item.n);
  if (missing.length) throw new Error(`The filled sheet has no job: ${missing.join(", ")}.`);
  if (entries.size !== details.length) throw new Error("The filled sheet has jobs that the key does not hold.");
  return entries;
}

/** The "Link closed?" notes of an earlier reveal file, by job number. */
export function closedNotes(revealed: string): Map<number, string> {
  const notes = new Map<number, string>();
  for (const line of revealed.split(/\r?\n/)) {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (/^\d+$/.test(cells[1] ?? "") && (cells[7] ?? "") !== "") notes.set(Number(cells[1]), cells[7]!);
  }
  return notes;
}

/** The answer each job had when its link was first shown, by job number. */
export type ShownAnswers = Readonly<Record<string, "YES" | "NO">>;

export const sealShownAnswers = (answers: ShownAnswers): string =>
  `${JSON.stringify({ schema_version: "review_lists_shown_v1", sealed: Buffer.from(JSON.stringify(answers), "utf8").toString("base64") })}\n`;

export function openShownAnswers(text: string): ShownAnswers {
  const stored = JSON.parse(text) as { schema_version?: string; sealed?: string };
  if (stored.schema_version !== "review_lists_shown_v1" || typeof stored.sealed !== "string") {
    throw new Error("Key file or record of shown answers is not of this version.");
  }
  return JSON.parse(Buffer.from(stored.sealed, "base64").toString("utf8")) as ShownAnswers;
}

/** The jobs whose answer is no longer the one given before their link was shown. */
export function changedAfterShown(filledSheet: string, shown: ShownAnswers): number[] {
  const entries = parseFilledSheet(filledSheet);
  return Object.entries(shown)
    .filter(([n, answer]) => entries.get(Number(n))?.answer !== answer)
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

/**
 * Links and saved marks of the answered jobs only. Notes already written about closed links are kept, and so is the
 * answer each job had when its link was first shown.
 */
export function renderReveal(
  filledSheet: string,
  details: readonly ReviewDetail[],
  earlier = "",
  before: ShownAnswers = {},
): { text: string; shown: number; answers: ShownAnswers } {
  const entries = entriesFor(filledSheet, details);
  const answers: Record<string, "YES" | "NO"> = { ...before };
  for (const [n, entry] of entries) if (entry.answer !== null) answers[String(n)] ??= entry.answer;
  const notes = closedNotes(earlier);
  const rows = [...details]
    .sort((a, b) => a.n - b.n)
    .filter((item) => answers[String(item.n)] !== undefined)
    .map((item) => `| ${item.n} | ${sheetText(item.title)} | ${sheetText(item.company)} | ${answers[String(item.n)] === "YES" ? "Y" : "N"} | ${safePostingLink(item.link) ?? ""} | ${item.saved ? "yes" : "no"} | ${notes.get(item.n) ?? ""} |`);
  return {
    shown: rows.length,
    answers,
    text: [
      "# Shown after your answers",
      "",
      "Only jobs you have answered appear here. If a posting is closed, write **closed** in the last column. It is noted and",
      "does not change the score; your Y or N stands.",
      "",
      "| # | Title | Company | Your answer | Link | Saved by you | Link closed? |",
      "|---|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
  };
}

/**
 * The listed jobs whose closure is only read from page wording: for the coordinator to open, never for the rater before
 * the rating. Written whether or not there is any, so the file itself says nothing.
 */
export function renderCheckByHand(lists: ReviewLists, ids: ReadonlySet<string>): string {
  const listed = new Map<string, PoolJob>();
  for (const job of [...lists.byType.flatMap((list) => list.jobs), ...lists.overall, ...lists.comparison]) listed.set(job.id, job);
  return [
    "# Check by hand (coordinator only: do not show the rater before the rating)",
    "",
    "The same-day check read these as closed from page wording alone. They stay in the lists as not verified.",
    "",
    "| Job id | Title | Company | Link |",
    "|---|---|---|---|",
    ...[...listed.values()]
      .filter((job) => ids.has(job.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((job) => `| ${job.id} | ${sheetText(job.title)} | ${sheetText(job.company)} | ${safePostingLink(job.link) ?? ""} |`),
    "",
  ].join("\n");
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
  readonly comparisonUnknownRole: Share;
  readonly comparisonOtherRole: Share;
  readonly byRoleType: Array<{ type: string } & Share>;
  /** Links noted as closed in the reveal file. Noted only: no answer is left out or changed. */
  readonly closedNoted: number;
  /** Rows with no answer. */
  readonly blank: number[];
}

/**
 * Pass: at least PASS_MIN_OVERALL_YES jobs of the overall list are a yes, AND the yes share of the listed jobs is at
 * least PASS_MIN_LEAD_POINTS percentage points above that of the comparison jobs. Every rated job counts, saved or not,
 * and a closed link changes nothing.
 */
export function scoreReviewSheet(filledSheet: string, details: readonly ReviewDetail[], revealed = ""): ReviewScore {
  const entries = entriesFor(filledSheet, details);
  const share = (items: readonly ReviewDetail[]): Share => ({
    yes: items.filter((item) => entries.get(item.n)!.answer === "YES").length,
    counted: items.length,
  });
  const overall = share(details.filter((item) => item.overallRank !== null));
  const lists = share(details.filter((item) => item.overallRank !== null || item.roleList !== null));
  const compared = details.filter((item) => item.comparison);
  const comparison = share(compared);
  const types = [...new Set(details.flatMap((item) => (item.roleList ? [item.roleList.type] : [])))].sort();
  const byRoleType = types.map((type) => ({ type, ...share(details.filter((item) => item.roleList?.type === type)) }));
  const blank = details.filter((item) => entries.get(item.n)!.answer === null).map((item) => item.n).sort((a, b) => a - b);

  // Integer arithmetic, so a lead of exactly the minimum passes.
  const leads = (lists.yes * comparison.counted - comparison.yes * lists.counted) * 100
    >= PASS_MIN_LEAD_POINTS * lists.counted * comparison.counted;
  const result = blank.length > 0 || lists.counted === 0 || comparison.counted === 0
    ? "INCOMPLETE"
    : overall.yes >= PASS_MIN_OVERALL_YES && leads ? "PASS" : "FAIL";
  return {
    result, overall, lists, comparison,
    comparisonUnknownRole: share(compared.filter((item) => item.roleType === null)),
    comparisonOtherRole: share(compared.filter((item) => item.roleType !== null)),
    byRoleType,
    closedNoted: [...closedNotes(revealed).values()].filter((note) => /closed/i.test(note)).length,
    blank,
  };
}
