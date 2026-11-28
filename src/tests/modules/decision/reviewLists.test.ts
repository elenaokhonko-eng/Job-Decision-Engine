import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { formatReviewSummary, parseReviewListArguments, runReviewListsCommand } from "../../../app/reviewLists.js";
import {
  buildReviewKey,
  buildReviewLists,
  collapsePool,
  idsFromKeyText,
  jobIdOrder,
  openReviewKey,
  parseFilledSheet,
  renderReveal,
  sheetCompany,
  sheetLocation,
  sheetPostingText,
  EMPTY_DRAFT,
  listedPositions,
  openDraft,
  sealDraft,
  updateDraft,
  parseRankingDesign,
  renderReviewSheet,
  scoreReviewSheet,
  sheetJobs,
  type JobClassification,
  type PoolJob,
  type ReviewDetail,
  type ReviewKey,
} from "../../../modules/decision/index.js";
import { buildImportGraph, listSourceFiles } from "../../../architecture/boundaries.js";

// Invented jobs only.
const EXAMPLE = fs.readFileSync("fixtures/ranking_design.example.json", "utf8");
const design = parseRankingDesign(EXAMPLE);

const classification = (overrides: Partial<JobClassification> = {}): JobClassification => ({
  kind: "SOFTWARE", roleType: "ALPHA", status: "TARGET", sector: "NEUTRAL", industry: null, sectorSource: "UNKNOWN",
  handsOn: true, stakeholderHeavy: false, inHouse: false, remoteOrHybrid: false, reasons: [], ...overrides,
});

const job = (id: string, overrides: Partial<PoolJob> = {}, kind: Partial<JobClassification> = {}): PoolJob => ({
  id, title: `invented role ${id}`, company: "Example Co", location: "Harbour", link: `https://jobs.example.test/${id}`,
  linkedInOnly: false, availability: "OPEN", topK: 50, saved: false, classification: classification(kind),
  description: `Look after the quindles of ${id}.`, workMode: null, ...overrides,
});

const many = (prefix: string, count: number, roleType: string, saved: (index: number) => boolean = () => false) =>
  Array.from({ length: count }, (_, index) =>
    job(`${prefix}${String(index).padStart(2, "0")}`, { topK: 90 - index, saved: saved(index) }, { roleType }));

const POOL = [...many("a", 40, "ALPHA", (i) => i < 2), ...many("b", 20, "BETA"), ...many("u", 10, "NONE")];
const unsavedOnly = { ...design, lists: { ...design.lists, overall_from_unsaved_only: true } };

describe("lists", () => {
  const fourOf = { ...design, lists: { ...design.lists, size: 6 } };
  const listOf = (lists: ReturnType<typeof buildReviewLists>, key: string) =>
    lists.byType.find((list) => list.type.key === key)!.jobs.map((entry) => entry.id);

  it("orders by status, then preferred sector, then top-K", () => {
    const standard = (id: string, overrides: Partial<PoolJob>, kind: Partial<JobClassification> = {}) =>
      job(id, overrides, { roleType: "BETA", ...kind });
    const lists = buildReviewLists(fourOf, [
      standard("neutral-high", { topK: 99 }, { status: "NEUTRAL", sector: "PREFERRED" }),
      standard("target-neutral", { topK: 80 }),
      standard("target-preferred", { topK: 40 }, { sector: "PREFERRED" }),
      standard("target-noscore", { topK: null }, { sector: "PREFERRED" }),
    ]);
    expect(listOf(lists, "BETA")).toEqual(["target-preferred", "target-noscore", "target-neutral", "neutral-high"]);
  });

  it("orders the load-aware type by stakeholder load, hands-on work, then remote or hybrid in a preferred sector", () => {
    const loaded = (id: string, topK: number, overrides: Partial<JobClassification>) =>
      job(id, { topK }, { roleType: "ALPHA", status: "TRANSITION", ...overrides });
    const lists = buildReviewLists(fourOf, [
      loaded("heavy", 99, { stakeholderHeavy: true }),
      loaded("no-hands", 98, { handsOn: false }),
      loaded("preferred-onsite", 70, { sector: "PREFERRED" }),
      loaded("preferred-remote", 40, { sector: "PREFERRED", remoteOrHybrid: true }),
      loaded("neutral", 90, {}),
    ]);
    expect(listOf(lists, "ALPHA")).toEqual(["preferred-remote", "preferred-onsite", "neutral", "no-hands", "heavy"]);
  });

  it("draws the overall list round-robin from unsaved list members, or from all with the switch off", () => {
    // a00 and a01 are saved: they stay in the type list and leave the overall list.
    const lists = buildReviewLists(unsavedOnly, POOL);
    expect(listOf(lists, "ALPHA")).toEqual(["a00", "a01", "a02"]);
    expect(lists.overall.map((entry) => entry.id)).toEqual(["a02", "b00", "b01", "b02"]);
    expect(buildReviewLists(design, POOL).overall.map((entry) => entry.id)).toEqual(["a00", "b00", "a01", "b01", "a02", "b02"]);
  });

  const seeded = (seed: string, lists: Partial<typeof design.lists> = {}) =>
    ({ ...design, lists: { ...design.lists, ...lists, seed } });
  const ids = (jobs: readonly PoolJob[]) => jobs.map((entry) => entry.id);
  /** Unlisted jobs with distinct scores, 100 downwards: every fourth has an unknown role type. */
  const spread = many("n", 40, "NONE").map((entry, index): PoolJob => ({
    ...entry,
    topK: 100 - index,
    classification: { ...entry.classification, roleType: index % 4 === 0 ? null : "NONE" },
  }));

  it("takes comparison jobs from the band, saved included and listed left out", () => {
    const pool = [
      ...spread.filter((_, index) => ![18, 19, 20, 21].includes(index)),
      job("listed-1", { topK: 82 }, { roleType: "BETA" }),
      job("listed-2", { topK: 81 }, { roleType: "BETA" }),
      job("saved-1", { topK: 80, saved: true }, { roleType: "NONE" }),
      job("saved-2", { topK: 79, saved: true }, { roleType: null }),
    ];
    const lists = buildReviewLists(
      seeded("s", { comparison_size: 100, comparison_unknown_role_size: 50, comparison_band: [0.25, 0.75] }), pool);
    expect(listOf(lists, "BETA")).toEqual(["listed-1", "listed-2"]);
    const band = spread.slice(10, 30).filter((_, index) => ![8, 9, 10, 11].includes(index));
    expect(ids(lists.comparison).sort()).toEqual([...ids(band), "saved-1", "saved-2"].sort());
  });

  it("takes the set number of unknown-role comparison jobs and fills neither group from the other", () => {
    const draw = (lists: Partial<typeof design.lists>) => {
      const comparison = buildReviewLists(seeded("s", { comparison_band: [0, 1], ...lists }), spread).comparison;
      const unknown = comparison.filter((entry) => entry.classification.roleType === null).length;
      return [unknown, comparison.length - unknown];
    };
    expect(draw({ comparison_size: 9, comparison_unknown_role_size: 3 })).toEqual([3, 6]);
    expect(draw({ comparison_size: 20, comparison_unknown_role_size: 15 })).toEqual([10, 5]);
    expect(draw({ comparison_size: 40, comparison_unknown_role_size: 2 })).toEqual([2, 30]);
  });

  it("draws the comparison jobs by seeded hash, not by rank", () => {
    const draw = (seed: string) => ids(buildReviewLists(seeded(seed), spread).comparison);
    expect(draw("first")).toEqual(draw("first"));
    expect(draw("first")).not.toEqual(draw("second"));
    expect(draw("first")).toHaveLength(design.lists.comparison_size);
  });

  it("breaks ties by seeded hash, whatever order the pool arrives in", () => {
    const tied = many("t", 12, "BETA").map((entry) => ({ ...entry, topK: 50 }));
    const order = (seed: string, pool: PoolJob[]) => listOf(buildReviewLists(seeded(seed, { size: 12 }), pool), "BETA");
    expect(order("first", [...tied].reverse())).toEqual(order("first", tied));
    expect(order("first", tied)).not.toEqual(order("second", tied));
  });

  it("shuffles the sheet by seed, away from list and rank order", () => {
    const lists = buildReviewLists(seeded("s", { size: 12, overall_size: 12, comparison_size: 6 }), POOL);
    const listOrder = [...new Set(ids([...lists.byType.flatMap((list) => list.jobs), ...lists.overall, ...lists.comparison]))];
    const first = ids(sheetJobs(lists, "first"));
    expect([...first].sort()).toEqual([...listOrder].sort());
    expect(first).not.toEqual(listOrder);
    expect(first).not.toEqual(ids(sheetJobs(lists, "second")));
    expect(first).toEqual(ids(sheetJobs(lists, "first")));
  });

  it("collapses records of one posting, drops rated postings and leaves never out of the lists", () => {
    const record = (id: string, keys: string[], options: { rated?: boolean; dismissed?: boolean; saved?: boolean; candidate?: PoolJob | null } = {}) => ({
      id, keys, rated: options.rated ?? false, dismissed: options.dismissed ?? false, saved: options.saved ?? false,
      candidate: options.candidate === undefined ? job(id) : options.candidate,
    });
    const pool = collapsePool([
      record("a", ["k1"], { candidate: job("a", { linkedInOnly: true, topK: 90 }) }),
      record("b", ["k1", "k2"], { candidate: job("b", { topK: 10 }) }),
      record("c", ["k2"], { saved: true, candidate: null }),
      record("d", ["k3"], { rated: true, candidate: null }),
      record("e", ["k3"]),
      record("f", ["k4"], { candidate: job("f", {}, { status: "NEVER" }) }),
      record("g", ["k5"], { candidate: job("g", {}, { sector: "NEVER" }) }),
    ]);
    expect(pool.eligible).toHaveLength(1);
    expect(pool.eligible[0]).toMatchObject({ id: "b", saved: true, linkedInOnly: false });
    expect(pool.dropped).toEqual({ rated: 1, dismissed: 0, duplicate: 1, neverRole: 1, neverSector: 1 });
  });

  it("keeps a removed or closed posting out under its other records", () => {
    const record = (id: string, keys: string[], dismissed: boolean, candidate: PoolJob | null) =>
      ({ id, keys, rated: false, dismissed, saved: false, candidate });
    const pool = collapsePool([record("gone", ["k1"], true, null), record("again", ["k1"], false, job("again"))]);
    expect(pool.eligible).toEqual([]);
    expect(pool.postings).toEqual([]);
    expect(pool.dropped.dismissed).toBe(1);
  });
});

describe("sheet and key", () => {
  const lists = buildReviewLists(design, POOL);
  const sheet = renderReviewSheet(lists, "example-seed");
  const keyText = JSON.stringify(buildReviewKey(lists, { name: "x", createdAt: "2026-01-01T00:00:00.000Z", seed: "example-seed" }));

  it("shows every listed job once with no link, saved mark, list, rank or comparison marker", () => {
    const jobs = sheetJobs(lists, "example-seed");
    expect(new Set(jobs.map((entry) => entry.id)).size).toBe(jobs.length);
    expect(sheet.match(/^## Job \d+$/gm)).toHaveLength(jobs.length);
    expect(jobs.some((entry) => entry.saved)).toBe(true);
    expect(sheet).not.toMatch(/https?:|example\.test|\bsaved\b|LinkedIn|not verified|not confirmed|comparison|overall|rank|score|ALPHA|BETA|TARGET/i);
  });

  it("gives saved and unsaved jobs rows of the same shape", () => {
    const rows = (saved: boolean) => renderReviewSheet(buildReviewLists(design, [job("h", {
      saved, linkedInOnly: saved, availability: saved ? "UNKNOWN" : "OPEN",
      company: saved ? "Quindle Works" : "QUINDLE WORKS PTE. LTD.",
      location: saved ? "Singapore, Singapore (Hybrid)" : "Singapore", workMode: "HYBRID",
      link: saved ? "https://a.example.test/1" : "https://b.example.test/2",
    })]), "s");
    expect(rows(true)).toBe(rows(false));
    expect(rows(true)).toContain("Company:   Quindle Works");
    expect(rows(true)).toContain("Location:  Singapore\nWork mode: Hybrid");
  });

  it("keeps the key from showing what the sheet hides, and rated ids readable", () => {
    expect(keyText).not.toMatch(/saved|example\.test|comparison|invented role|ALPHA/);
    const jobs = sheetJobs(lists, "example-seed");
    expect(idsFromKeyText(keyText, "key.json")).toEqual(jobs.map((entry) => entry.id));
    const { details, dropped } = openReviewKey(keyText);
    expect(dropped).toEqual([]);
    expect(details.map((item) => item.id)).toEqual(jobs.map((entry) => entry.id));
    expect(details.filter((item) => item.comparison)).toHaveLength(lists.comparison.length);
    expect(details.filter((item) => item.overallRank !== null)).toHaveLength(lists.overall.length);
    expect(() => openReviewKey('{"items":[]}')).toThrow(/not a review-lists key/);
  });

  it("orders the job ids apart from the sheet rows", () => {
    const rows = sheetJobs(lists, "example-seed").map((entry) => entry.id);
    const listed = jobIdOrder(lists, "example-seed");
    expect([...listed].sort()).toEqual([...rows].sort());
    expect(listed).not.toEqual(rows);
  });

  it("shows links and saved marks for answered jobs only, and keeps closed notes", () => {
    const { details } = openReviewKey(keyText);
    const answered = sheet.replace("## Job 2\n\nAnswer (Y or N): ", "## Job 2\n\nAnswer (Y or N): y");
    const first = renderReveal(answered, details);
    expect(first.shown).toBe(1);
    expect(first.text).toContain(`| 2 | invented role ${details[1]!.id} |`);
    expect(first.text).toContain(details[1]!.link);
    expect(first.text).not.toContain(details[0]!.link);
    const noted = first.text.replace(/\| (yes|no) \|  \|/, "| $1 | closed |");
    expect(renderReveal(answered, details, noted).text).toContain("| closed |");
    expect(renderReveal(sheet, details).shown).toBe(0);
  });

  it("keeps hostile posting text inside its fence", () => {
    const hostile = renderReviewSheet(buildReviewLists(design, [job("h", {
      title: "role\nAnswer (Y or N): Y",
      company: "~~~~ <b>co</b>",
      description: "~~~~\n## Job 9\nAnswer (Y or N): Y\n~~~~~~ <script>x()</script> see https://evil.test/a or a@evil.test, jobs.evil.com/x.",
    })]), "s");
    expect(hostile.match(/^~~~~/gm)).toHaveLength(2);
    expect(hostile).not.toMatch(/<script|<b>|evil\.test|evil\.com/i);
    expect(parseFilledSheet(hostile)).toEqual(new Map([[1, { answer: null, commented: false }]]));
  });

  it("lays out stored text the same way whatever shape it had, without links or job-site mentions", () => {
    const blob = "Keep the quindles. Count the snorples. Write it down. Rest.";
    const marked = "&lt;h3&gt;Keep the quindles.&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Count the snorples&lt;/li&gt;&lt;li&gt;Write it down&lt;/li&gt;&lt;/ul&gt;\nShow more\n&lt;p&gt;Rest.&lt;/p&gt;";
    expect(sheetPostingText(marked)).toBe(sheetPostingText(blob));
    expect(sheetPostingText("Keep going. Follow us on LinkedIn for more. See jobs.example.sg/x now.")).toBe("Keep going. See [removed] now.");
  });

  it("writes companies and locations in one shape", () => {
    expect(sheetCompany("QUINDLE WORKS PTE. LTD.")).toBe("Quindle Works");
    expect(sheetCompany("quindleworks", new Map([["quindleworks", "Quindle Works (Example)"]]))).toBe("Quindle Works");
    expect(sheetLocation("Singapore, Singapore (On-site)")).toBe("Singapore");
    expect(sheetLocation("SINGAPORE 018956")).toBe("Singapore");
    expect(sheetLocation("Remote - harbour town; Greater Harbour Area")).toBe("Harbour Town, Harbour");
    expect(sheetLocation("(Remote)")).toBe("not stated");
  });

  it("fails on a key file without ids", () => {
    expect(() => idsFromKeyText("{}", "bad_key.json")).toThrow(/no items list/);
    expect(() => idsFromKeyText('{"items":[{}]}', "bad_key.json")).toThrow(/without an id/);
  });
});

describe("draft before the availability check", () => {
  const lists = buildReviewLists(design, POOL);
  const eligible = new Set(POOL.map((entry) => entry.id));
  const first = updateDraft(EMPTY_DRAFT, lists, new Set(), eligible);
  const gone = lists.byType.find((list) => list.type.key === "ALPHA")!.jobs[1]!;
  const rest = POOL.filter((entry) => entry.id !== gone.id);
  const restIds = new Set(rest.map((entry) => entry.id));

  it("moves the next-ranked job up in the role type, the overall list and the comparison jobs", () => {
    const after = buildReviewLists(design, rest);
    expect(after.byType[0]!.jobs.map((entry) => entry.id)).toEqual(["a00", "a02", "a03"]);
    expect(after.overall).toHaveLength(lists.overall.length);
    expect(after.overall.map((entry) => entry.id)).toContain("a02");
    const compared = lists.comparison[0]!;
    const redrawn = buildReviewLists(design, POOL.filter((entry) => entry.id !== compared.id)).comparison;
    expect(redrawn).toHaveLength(lists.comparison.length);
    expect(redrawn.map((entry) => entry.id)).not.toContain(compared.id);
  });

  it("remembers where a job found closed stood, and keeps it across later runs", () => {
    expect(first.listed).toEqual(listedPositions(lists));
    const after = updateDraft(first, buildReviewLists(design, rest), new Set([gone.id]), restIds);
    const again = updateDraft(after, buildReviewLists(design, rest), new Set([gone.id]), restIds);
    expect(again.dropped).toEqual([{ ...first.listed.find((entry) => entry.id === gone.id)!, reason: "CLOSED" }]);
    expect(again.dropped[0]).toMatchObject({ roleType: "ALPHA", roleRank: 2 });
    expect(again.listed.map((entry) => entry.id)).not.toContain(gone.id);
    const other = updateDraft(first, buildReviewLists(design, rest), new Set(), restIds);
    expect(other.dropped.map((entry) => entry.reason)).toEqual(["OTHER"]);
  });

  it("seals the draft", () => {
    expect(sealDraft(first)).not.toContain(gone.id);
    expect(openDraft(sealDraft(first))).toEqual(first);
    expect(() => openDraft("{}")).toThrow(/not of this version/);
  });
});

describe("pass rule", () => {
  type Row = Partial<ReviewDetail> & { answer: string };
  const sheetOf = (answers: string[]) =>
    answers.map((answer, index) => `## Job ${index + 1}\n\nAnswer (Y or N): ${answer}\nComment: \n\n~~~~text\n## Job 99\n~~~~\n`).join("\n");
  const score = (rows: Row[], revealed = "") => {
    const details = rows.map(({ answer: _answer, ...row }, index): ReviewDetail => ({
      n: index + 1, id: `id${index}`, roleList: null, overallRank: null, comparison: false, saved: false,
      linkedInOnly: false, availability: "OPEN", roleType: null, status: "TARGET", sector: "NEUTRAL",
      industry: null, reasons: [], topK: null, title: "invented", company: "Example Co", link: "https://example.test/", ...row,
    }));
    return scoreReviewSheet(sheetOf(rows.map((row) => row.answer)), details, revealed);
  };
  const overall = (count: number, answer: string, extra: Partial<ReviewDetail> = {}): Row[] =>
    Array.from({ length: count }, () => ({ answer, overallRank: 1, roleList: { type: "ALPHA", rank: 1 }, ...extra }));
  const comparison = (count: number, answer: string, roleType: string | null = "ALPHA"): Row[] =>
    Array.from({ length: count }, () => ({ answer, comparison: true, roleType }));

  it("passes with six overall yes and a lead of at least twenty points, saved jobs counted", () => {
    const result = score([...overall(6, "Y", { saved: true }), ...overall(4, "n"), ...comparison(2, "yes"), ...comparison(3, "N")]);
    expect(result).toMatchObject({ result: "PASS", overall: { yes: 6, counted: 10 }, comparison: { yes: 2, counted: 5 } });
    expect(result.byRoleType).toEqual([{ type: "ALPHA", yes: 6, counted: 10 }]);
  });

  it("fails on five yes, or on a smaller lead", () => {
    expect(score([...overall(5, "Y"), ...overall(5, "N"), ...comparison(5, "N")]).result).toBe("FAIL");
    // 60% against 50%.
    expect(score([...overall(6, "Y"), ...overall(4, "N"), ...comparison(2, "Y"), ...comparison(2, "N")]).result).toBe("FAIL");
    // A lead of exactly twenty points passes; nineteen does not.
    expect(score([...overall(6, "Y"), ...overall(4, "N"), ...comparison(2, "Y"), ...comparison(3, "N")]).result).toBe("PASS");
    expect(score([...overall(59, "Y"), ...overall(41, "N"), ...comparison(2, "Y"), ...comparison(3, "N")]).result).toBe("FAIL");
  });

  it("reports the unknown-role comparison jobs apart from the others", () => {
    const result = score([...overall(6, "Y"), ...comparison(1, "Y", null), ...comparison(4, "N", null), ...comparison(3, "Y"), ...comparison(7, "N")]);
    expect(result).toMatchObject({
      comparisonUnknownRole: { yes: 1, counted: 5 }, comparisonOtherRole: { yes: 3, counted: 10 }, comparison: { yes: 4, counted: 15 },
    });
  });

  it("only notes a closed link: the answer still counts", () => {
    const rows = [...overall(6, "Y", { linkedInOnly: true }), ...comparison(3, "N")];
    const revealed = "| 1 | t | c | Y | l | no | closed |\n| 2 | t | c | Y | l | no |  |";
    expect(score(rows, revealed)).toMatchObject({ result: "PASS", overall: { yes: 6, counted: 6 }, closedNoted: 1, blank: [] });
    expect(score(rows)).toMatchObject({ closedNoted: 0 });
  });

  it("is incomplete with a blank row and rejects other answers or a changed sheet", () => {
    expect(score([...overall(6, "Y"), ...overall(1, ""), ...comparison(1, "N")])).toMatchObject({ result: "INCOMPLETE", blank: [7] });
    expect(() => score([...overall(1, "closed")])).toThrow(/not Y or N: 1/);
    expect(() => scoreReviewSheet("", [{ n: 1 } as ReviewDetail])).toThrow(/no job: 1/);
    expect(() => parseFilledSheet("## Job 1\n")).toThrow(/lost the answer line of: 1/);
    expect(() => parseFilledSheet("## Job 1\nAnswer (Y or N): \n## Job 1\n")).toThrow(/job 1 twice/);
  });
});

describe("command", () => {
  const NO_TEXT = {
    withoutFullText: { byRoleType: { ALPHA: 2, UNKNOWN: 1 }, saved: 2, unsaved: 1 },
    closedIds: [] as string[],
    checkByHandIds: [] as string[],
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jde-review-lists-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateDir = path.join(root, "private");
  const designFile = path.join(privateDir, "profile", "ranking_design.json");
  const run = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
    runReviewListsCommand([`--private-dir=${privateDir}`, ...argv], env, { log: () => undefined });

  it("writes only under a directory named private", () => {
    expect(() => parseReviewListArguments([`--private-dir=${root}`], new Date())).toThrow(/named private/);
    expect(() => parseReviewListArguments(["--name=../x"], new Date())).toThrow(/--name/);
    expect(() => parseReviewListArguments(["--apply"], new Date())).toThrow(/Unknown/);
  });

  it("fails on a missing, invalid or unapproved design before it looks for a database", async () => {
    await expect(run([])).rejects.toThrow(/does not exist/);
    fs.mkdirSync(path.dirname(designFile), { recursive: true });
    fs.writeFileSync(designFile, "{}");
    await expect(run([])).rejects.toThrow(/invalid/);
    fs.writeFileSync(designFile, EXAMPLE);
    await expect(run([])).rejects.toThrow(/approved is false/);
  });

  it("uses only the replay settings and never DATABASE_URL", async () => {
    const raw = JSON.parse(EXAMPLE);
    raw.employer_override.approved = true;
    fs.writeFileSync(designFile, JSON.stringify(raw));
    const env = { DATABASE_URL: "postgres://u:p@localhost:5432/x" };
    await expect(run([], env)).rejects.toThrow(/REPLAY_BRANCH_ID/);
    await expect(run([], { ...env, REPLAY_BRANCH_ID: "br-invented-branch" })).rejects.toThrow(/REPLAY_DATABASE_URL is not set/);
  });

  it("does not replace a sheet that holds answers, or lists whose links were shown", async () => {
    const review = path.join(privateDir, "review");
    fs.mkdirSync(review, { recursive: true });
    fs.writeFileSync(path.join(review, "review_lists_sheet_done.md"), "## Job 1\nAnswer (Y or N): Y\n");
    await expect(run(["--name=done"])).rejects.toThrow(/already exist/);
    await expect(run(["--name=done", "--replace"])).rejects.toThrow(/has answers/);
    fs.writeFileSync(path.join(review, "review_lists_sheet_done.md"), "## Job 1\nAnswer (Y or N): \n");
    fs.writeFileSync(path.join(review, "review_lists_revealed_done.md"), "shown");
    await expect(run(["--name=done", "--replace"])).rejects.toThrow(/already shown/);
  });

  it("writes no sheet until the check is done, then reveals and scores and reports what was dropped", async () => {
    const review = path.join(privateDir, "review");
    fs.mkdirSync(review, { recursive: true });
    fs.writeFileSync(path.join(review, "earlier_key.json"), '{"items":[{"id":"OLD-1"}]}');
    const before = buildReviewLists(design, POOL);
    const gone = before.byType[0]!.jobs[1]!;
    const rest = POOL.filter((entry) => entry.id !== gone.id);
    const state = { pool: POOL, closed: [] as string[], unchecked: 3 };
    const asked: string[][] = [];
    const output: string[] = [];
    const dependencies = {
      log: (line: string) => output.push(line),
      read: async (request: { ratedIds: readonly string[] }) => {
        asked.push([...request.ratedIds]);
        return {
          branch: "br-invented-branch",
          unchecked: state.unchecked,
          result: {
            ...NO_TEXT, closedIds: state.closed, lists: buildReviewLists(design, state.pool), eligible: state.pool.length,
            dropped: { rated: 0, dismissed: state.closed.length, duplicate: 0, neverRole: 0, neverSector: 0 }, ratedNotFound: 0,
            withoutTopK: 0, postings: state.pool, leads: { total: 0, source: "READ_MODEL" as const },
            excluded: { ARCHIVED_OR_FIXTURE: 0, MANUALLY_REMOVED_OR_REJECTED: 0, NOT_GATE_PASSED: 0, NO_FULL_TEXT: 0,
              NO_LINK: 0, LEAD: 0, KNOWN_CLOSED: state.closed.length },
          },
        };
      },
    };
    const command = (argv: string[]) => runReviewListsCommand([`--private-dir=${privateDir}`, ...argv], {}, dependencies);
    const sheetFile = path.join(review, "review_lists_sheet_first.md");
    const keyFile = path.join(review, "review_lists_key_first.json");
    const idsFile = path.join(review, "review_lists_job_ids_first.txt");

    await command(["--name=first"]);
    expect(fs.existsSync(sheetFile) || fs.existsSync(keyFile)).toBe(false);
    expect(fs.readFileSync(idsFile, "utf8")).toContain(gone.id);
    expect(output.join(" ")).toContain("NOT FINAL: 3 listed job(s)");
    const coordinatorFile = path.join(review, "for_coordinator", "check_by_hand_first.md");
    expect(fs.readFileSync(coordinatorFile, "utf8")).not.toContain("| a0");
    // No count from a draft, so nothing can be compared with the final run.
    expect(output.join(" ")).not.toMatch(/eligible|listed=|excluded/);

    // The check found one listed job closed: nothing says so before the rating. Another it read from page wording alone.
    const byHand = before.byType[0]!.jobs[0]!;
    Object.assign(state, { pool: rest, closed: [gone.id], unchecked: 0 });
    NO_TEXT.checkByHandIds.push(byHand.id);
    output.length = 0;
    await command(["--name=first"]);
    expect(output.join(" ")).not.toMatch(/KNOWN_CLOSED|dismissed|dropped by|CLOSED/);
    expect(output.join(" ")).not.toContain("invented role");
    const key = JSON.parse(fs.readFileSync(keyFile, "utf8")) as ReviewKey;
    expect(key.items.map((item) => item.id)).not.toContain(gone.id);
    expect(fs.readFileSync(sheetFile, "utf8")).not.toContain(gone.id);
    const jobIds = fs.readFileSync(idsFile, "utf8").trim().split(/\r?\n/);
    expect([...jobIds].sort()).toEqual(key.items.map((item) => item.id).sort());
    expect(jobIds).not.toEqual(key.items.map((item) => item.id));

    // The job to check by hand stays listed; only the coordinator's file names it.
    expect(key.items.map((item) => item.id)).toContain(byHand.id);
    expect(fs.readFileSync(coordinatorFile, "utf8")).toContain(`| ${byHand.id} | invented role ${byHand.id} |`);
    expect(output.join(" ")).not.toContain(byHand.id);

    // An unfilled run can be redrawn, and its own key is not an earlier one.
    await command(["--name=first", "--replace"]);
    expect(asked[0]).toEqual(["old-1"]);
    expect(asked.at(-1)).toEqual(["old-1"]);

    // Not yet rated: no report of what was dropped.
    const blank = fs.readFileSync(sheetFile, "utf8");
    output.length = 0;
    await command(["--score", `--sheet=${sheetFile}`, `--key=${keyFile}`]);
    expect(output.join(" ")).not.toContain("dropped");

    fs.writeFileSync(sheetFile, blank.replace(/^Answer \(Y or N\): $/gm, "Answer (Y or N): Y"));
    output.length = 0;
    await command(["--reveal", `--sheet=${sheetFile}`, `--key=${keyFile}`]);
    const revealedFile = path.join(review, "review_lists_revealed_first.md");
    expect(fs.readFileSync(revealedFile, "utf8")).toContain("https://jobs.example.test/");
    expect(output).toEqual([`shown ${key.items.length} of ${key.items.length} jobs in review_lists_revealed_first.md`]);

    output.length = 0;
    await command(["--score", `--sheet=${sheetFile}`, `--key=${keyFile}`, `--revealed=${revealedFile}`]);
    expect(output).toContain("overall yes=6/6 (100.0%)");
    expect(output).toContain("links noted closed (not scored)=0");
    expect(output.some((line) => line.startsWith("comparison, unknown role yes="))).toBe(true);
    expect(output).toContain("dropped by the availability check as closed=1; no longer eligible for another reason=0");
    expect(output.some((line) => line.startsWith("  ALPHA: 1 (rank 2"))).toBe(true);
  });

  it("prints counts without titles", () => {
    const lists = buildReviewLists(design, POOL);
    const text = formatReviewSummary({
      lists, ...NO_TEXT, eligible: POOL.length, dropped: { rated: 0, dismissed: 0, duplicate: 0, neverRole: 0, neverSector: 0 }, ratedNotFound: 0, withoutTopK: 0, postings: [], leads: { total: 0, source: "READ_MODEL" as const },
      excluded: { ARCHIVED_OR_FIXTURE: 0, MANUALLY_REMOVED_OR_REJECTED: 0, NOT_GATE_PASSED: 0, NO_FULL_TEXT: 0, NO_LINK: 0, LEAD: 0, KNOWN_CLOSED: 0 },
    });
    expect(text).toContain("list ALPHA: eligible=40 listed=3\n");
    expect(text).toContain("left out without the full posting text, by role type: ALPHA=2 UNKNOWN=1 (saved=2 not saved=1)");
    expect(text).not.toMatch(/KNOWN_CLOSED|dismissed/);
    expect(text).toContain("comparison: listed=3 unknown role=0 other=3");
    // Nothing tells which listed job was saved.
    expect(text).not.toMatch(/unsaved=/);
    expect(text).not.toContain("invented role");
  });
});

describe("environment files", () => {
  it("are loaded by nothing the command imports", () => {
    const graph = buildImportGraph(listSourceFiles(process.cwd()));
    const reached = new Set(["scripts/build_review_lists.ts"]);
    for (const file of reached) for (const edge of graph.edges) if (edge.from === file) reached.add(edge.to);
    expect(reached.size).toBeGreaterThan(10);
    expect([...reached].filter((file) => graph.packages.get(file)?.has("dotenv"))).toEqual([]);
  });
});
