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
  parseRankingDesign,
  renderReviewSheet,
  scoreReviewSheet,
  sheetJobs,
  type JobClassification,
  type PoolJob,
  type ReviewKey,
} from "../../../modules/decision/index.js";

// Invented jobs only.
const EXAMPLE = fs.readFileSync("fixtures/ranking_design.example.json", "utf8");
const design = parseRankingDesign(EXAMPLE);

const classification = (overrides: Partial<JobClassification> = {}): JobClassification => ({
  kind: "SOFTWARE", roleType: "SOFTWARE", status: "TARGET", sector: "NEUTRAL", industry: null, sectorSource: "UNKNOWN",
  handsOn: true, stakeholderHeavy: false, inHouse: false, remoteOrHybrid: false, reasons: [], ...overrides,
});

const job = (id: string, overrides: Partial<PoolJob> = {}, kind: Partial<JobClassification> = {}): PoolJob => ({
  id, title: `invented role ${id}`, company: "Example Co", location: "Harbour", link: `https://jobs.example.test/${id}`,
  linkedInOnly: false, availability: "OPEN", topK: 50, saved: false, classification: classification(kind), ...overrides,
});

const many = (prefix: string, count: number, roleType: string, saved: (index: number) => boolean = () => false) =>
  Array.from({ length: count }, (_, index) =>
    job(`${prefix}${String(index).padStart(2, "0")}`, { topK: 90 - index, saved: saved(index) }, { roleType }));

const POOL = [...many("s", 40, "SOFTWARE", (i) => i < 4), ...many("d", 20, "DATA"), ...many("u", 10, "NONE")];

describe("lists", () => {
  it("orders by status, then preferred sector, then top-K", () => {
    const lists = buildReviewLists(design, [
      job("neutral-high", { topK: 99 }, { status: "NEUTRAL", sector: "PREFERRED" }),
      job("target-neutral", { topK: 80 }),
      job("target-preferred", { topK: 40 }, { sector: "PREFERRED" }),
      job("target-noscore", { topK: null }, { sector: "PREFERRED" }),
    ]);
    expect(lists.byType.find((list) => list.type.key === "SOFTWARE")!.jobs.map((entry) => entry.id))
      .toEqual(["target-preferred", "target-noscore", "target-neutral", "neutral-high"]);
  });

  it("orders the load-aware type by stakeholder load, hands-on work, then remote or hybrid in a preferred sector", () => {
    const coordination = (id: string, topK: number, overrides: Partial<JobClassification>) =>
      job(id, { topK }, { roleType: "COORDINATION", status: "TRANSITION", ...overrides });
    const lists = buildReviewLists(design, [
      coordination("heavy", 99, { stakeholderHeavy: true }),
      coordination("no-hands", 98, { handsOn: false }),
      coordination("preferred-onsite", 70, { sector: "PREFERRED" }),
      coordination("preferred-remote", 40, { sector: "PREFERRED", remoteOrHybrid: true }),
      coordination("neutral", 90, {}),
    ]);
    expect(lists.byType.find((list) => list.type.key === "COORDINATION")!.jobs.map((entry) => entry.id))
      .toEqual(["preferred-remote", "preferred-onsite", "neutral", "no-hands", "heavy"]);
  });

  it("draws the overall list round-robin from unsaved list members, or from all with the switch off", () => {
    const lists = buildReviewLists(design, POOL);
    // s00 to s03 are saved: they stay in the type list and leave the overall list.
    expect(lists.byType[0]!.jobs.slice(0, 2).map((entry) => entry.id)).toEqual(["s00", "s01"]);
    expect(lists.overall.map((entry) => entry.id)).toEqual(["s04", "d00", "s05", "d01", "s06", "d02", "s07", "d03", "s08", "d04"]);
    const all = buildReviewLists({ ...design, lists: { ...design.lists, overall_from_unsaved_only: false } }, POOL);
    expect(all.overall.map((entry) => entry.id).slice(0, 4)).toEqual(["s00", "d00", "s01", "d01"]);
  });

  it("takes comparison jobs from the middle of the same pool, unsaved and unlisted, by seeded hash", () => {
    const lists = buildReviewLists(design, POOL);
    const listed = new Set(lists.byType.flatMap((list) => list.jobs.map((entry) => entry.id)));
    expect(lists.comparison.length).toBeGreaterThan(0);
    const ranked = [...POOL].sort((a, b) => b.topK! - a.topK!);
    for (const entry of lists.comparison) {
      expect(listed.has(entry.id)).toBe(false);
      expect(entry.saved).toBe(false);
      // Within the 40-60% band (ties by top-K allow the neighbouring places).
      expect(ranked.filter((other) => other.topK! > entry.topK!).length).toBeLessThan(POOL.length * 0.6);
      expect(ranked.filter((other) => other.topK! >= entry.topK!).length).toBeGreaterThan(POOL.length * 0.4);
    }
    expect(buildReviewLists(design, [...POOL].reverse()).comparison.map((entry) => entry.id))
      .toEqual(lists.comparison.map((entry) => entry.id));
  });

  it("collapses records of one posting, drops rated postings and leaves never out of the lists", () => {
    const record = (id: string, keys: string[], options: { rated?: boolean; saved?: boolean; candidate?: PoolJob | null } = {}) => ({
      id, keys, rated: options.rated ?? false, saved: options.saved ?? false,
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
    expect(pool.dropped).toEqual({ rated: 1, duplicate: 1, neverRole: 1, neverSector: 1 });
  });
});

describe("sheet and key", () => {
  const lists = buildReviewLists(design, POOL);
  const sheet = renderReviewSheet(lists, "example-seed");

  it("shows every listed job once with no list, rank or comparison marker", () => {
    const jobs = sheetJobs(lists, "example-seed");
    expect(new Set(jobs.map((entry) => entry.id)).size).toBe(jobs.length);
    expect(sheet.split("\n").filter((line) => /^\| \d+ \|/.test(line))).toHaveLength(jobs.length);
    expect(sheet).not.toMatch(/comparison|overall|rank|score|SOFTWARE|DATA|TARGET/i);
    const key = buildReviewKey(lists, { name: "x", createdAt: "2026-01-01T00:00:00.000Z", seed: "example-seed", overallFromUnsavedOnly: true });
    expect(key.items.map((item) => item.id)).toEqual(jobs.map((entry) => entry.id));
    expect(idsFromKeyText(JSON.stringify(key), "key.json")).toEqual(jobs.map((entry) => entry.id));
    expect(key.items.filter((item) => item.comparison)).toHaveLength(lists.comparison.length);
    expect(key.items.filter((item) => item.overallRank !== null)).toHaveLength(lists.overall.length);
  });

  it("escapes posting text and drops unsafe links", () => {
    const hostile = buildReviewLists(design, [job("h", {
      title: "role | **bold** <img src=x>\nnext www.evil.test @someone",
      company: "[click](https://evil.test)",
      link: "javascript:alert(1)",
      saved: true,
      linkedInOnly: true,
      availability: "UNKNOWN",
    })]);
    const row = renderReviewSheet(hostile, "s").split("\n").find((line) => line.startsWith("| 1 |"))!;
    expect(row.split(/(?<!\\)\|/)).toHaveLength(10);
    expect(row).not.toMatch(/<img|javascript:|\*\*bold|https:\/\/evil|www\.evil|@someone/);
    expect(row).toContain("saved; LinkedIn, not verified; open not confirmed");
  });

  it("fails on a key file without ids", () => {
    expect(() => idsFromKeyText("{}", "bad_key.json")).toThrow(/no items list/);
    expect(() => idsFromKeyText('{"items":[{}]}', "bad_key.json")).toThrow(/without an id/);
  });
});

describe("pass rule", () => {
  type Row = Partial<ReviewKey["items"][number]> & { answer: string };
  const score = (rows: Row[]) => {
    const items = rows.map(({ answer: _answer, ...row }, index) => ({
      n: index + 1, id: `id${index}`, roleList: null, overallRank: null, comparison: false, saved: false,
      linkedInOnly: false, availability: "OPEN" as const, roleType: null, status: "TARGET", sector: "NEUTRAL",
      industry: null, reasons: [], topK: null, title: "invented", ...row,
    }));
    const sheet = rows.map((row, index) => `| ${index + 1} | a \\| b | c | d | e | f | ${row.answer} | any | note |`).join("\n");
    return scoreReviewSheet(sheet, { items });
  };
  const overall = (count: number, answer: string): Row[] =>
    Array.from({ length: count }, () => ({ answer, overallRank: 1, roleList: { type: "SOFTWARE", rank: 1 } }));
  const comparison = (count: number, answer: string): Row[] => Array.from({ length: count }, () => ({ answer, comparison: true }));

  it("passes with six overall yes and a lead of at least twenty points", () => {
    const result = score([...overall(6, "Y"), ...overall(4, "n"), ...comparison(2, "yes"), ...comparison(3, "N")]);
    expect(result).toMatchObject({ result: "PASS", overall: { yes: 6, counted: 10 }, comparison: { yes: 2, counted: 5 } });
    expect(result.byRoleType).toEqual([{ type: "SOFTWARE", yes: 6, counted: 10 }]);
  });

  it("fails on five yes, or on a smaller lead", () => {
    expect(score([...overall(5, "Y"), ...overall(5, "N"), ...comparison(5, "N")]).result).toBe("FAIL");
    // 60% against 50%.
    expect(score([...overall(6, "Y"), ...overall(4, "N"), ...comparison(2, "Y"), ...comparison(2, "N")]).result).toBe("FAIL");
  });

  it("does not count saved jobs or LinkedIn jobs marked closed", () => {
    const result = score([
      ...overall(6, "Y"),
      { answer: "Y", overallRank: 7, saved: true },
      { answer: "closed", roleList: { type: "SOFTWARE", rank: 2 }, linkedInOnly: true },
      { answer: "closed", roleList: { type: "SOFTWARE", rank: 3 } },
      { answer: "", roleList: { type: "SOFTWARE", rank: 4 }, saved: true },
      ...comparison(3, "N"),
    ]);
    expect(result).toMatchObject({
      result: "PASS", overall: { yes: 6, counted: 6 }, lists: { yes: 6, counted: 7 },
      notCounted: { saved: 2, linkedInClosed: 1 }, otherClosed: 1, blank: [],
    });
  });

  it("is incomplete with a blank counted row and rejects other answers", () => {
    expect(score([...overall(6, "Y"), ...overall(1, ""), ...comparison(1, "N")])).toMatchObject({ result: "INCOMPLETE", blank: [7] });
    expect(() => score([...overall(1, "maybe")])).toThrow(/not Y, N or closed: 1/);
    expect(() => scoreReviewSheet("", { items: [{ n: 1 } as ReviewKey["items"][number]] })).toThrow(/no row for: 1/);
  });
});

describe("command", () => {
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

  it("does not replace a sheet that holds answers", async () => {
    const review = path.join(privateDir, "review");
    fs.mkdirSync(review, { recursive: true });
    fs.writeFileSync(path.join(review, "review_lists_sheet_done.md"), "| 1 | a | b | c | d | e | Y |  |\n");
    await expect(run(["--name=done"])).rejects.toThrow(/already exist/);
    await expect(run(["--name=done", "--replace"])).rejects.toThrow(/has answers/);
  });

  it("writes the sheet, key and job id file, leaves earlier key ids out and scores the filled sheet", async () => {
    const review = path.join(privateDir, "review");
    fs.writeFileSync(path.join(review, "earlier_key.json"), '{"items":[{"id":"OLD-1"}]}');
    const lists = buildReviewLists(design, POOL);
    const asked: string[][] = [];
    const output: string[] = [];
    const dependencies = {
      log: (line: string) => output.push(line),
      read: async (request: { ratedIds: readonly string[] }) => {
        asked.push([...request.ratedIds]);
        return {
          branch: "br-invented-branch",
          result: {
            lists, eligible: POOL.length, dropped: { rated: 0, duplicate: 0, neverRole: 0, neverSector: 0 }, ratedNotFound: 0,
            withoutTopK: 0, postings: [], leads: { total: 0, source: "READ_MODEL" as const }, excluded: { ARCHIVED_OR_FIXTURE: 0, MANUALLY_REMOVED_OR_REJECTED: 0, NOT_GATE_PASSED: 0,
              AWAITING_CONTENT: 0, NO_LINK: 0, LEAD: 0, KNOWN_CLOSED: 0 },
          },
        };
      },
    };
    const command = (argv: string[]) => runReviewListsCommand([`--private-dir=${privateDir}`, ...argv], {}, dependencies);
    await command(["--name=first"]);
    const sheetFile = path.join(review, "review_lists_sheet_first.md");
    const keyFile = path.join(review, "review_lists_key_first.json");
    const key = JSON.parse(fs.readFileSync(keyFile, "utf8")) as ReviewKey;
    const jobIds = fs.readFileSync(path.join(review, "review_lists_job_ids_first.txt"), "utf8").trim().split(/\r?\n/);
    expect(jobIds).toEqual(key.items.map((item) => item.id));
    expect(output.join(" ")).not.toContain("invented role");

    // An unfilled run can be redrawn, and its own key is not an earlier one.
    await command(["--name=first", "--replace"]);
    await command(["--name=second"]);
    expect(asked[0]).toEqual(["old-1"]);
    expect(asked[1]).toEqual(["old-1"]);
    expect(asked[2]).toEqual(["old-1", ...key.items.map((item) => item.id)]);

    const filled = fs.readFileSync(sheetFile, "utf8").replace(/\|  \|  \|$/gm, "| Y |  |");
    fs.writeFileSync(sheetFile, filled);
    output.length = 0;
    await command(["--score", `--sheet=${sheetFile}`, `--key=${keyFile}`]);
    expect(output).toContain("result=FAIL");
    expect(output).toContain("overall yes=10/10 (100.0%)");
  });

  it("prints counts without titles", () => {
    const lists = buildReviewLists(design, POOL);
    const text = formatReviewSummary({
      lists, eligible: POOL.length, dropped: { rated: 0, duplicate: 0, neverRole: 0, neverSector: 0 }, ratedNotFound: 0, withoutTopK: 0, postings: [], leads: { total: 0, source: "READ_MODEL" as const },
      excluded: { ARCHIVED_OR_FIXTURE: 0, MANUALLY_REMOVED_OR_REJECTED: 0, NOT_GATE_PASSED: 0, AWAITING_CONTENT: 0, NO_LINK: 0, LEAD: 0, KNOWN_CLOSED: 0 },
    });
    expect(text).toContain("list SOFTWARE: eligible=40 listed=10 unsaved=6");
    expect(text).toContain("overall: listed=10 unsaved=10");
    expect(text).not.toContain("invented role");
  });
});
