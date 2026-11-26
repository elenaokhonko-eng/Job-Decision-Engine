import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { drawBlindReview, labelledIdsFromKeys, parseBlindReviewArgs, renderBlindReviewSheet } from "../../reporting/blindReviewDraw.js";
import type { BlindReviewCandidate, BlindReviewPool } from "../../reporting/blindReviewPool.js";
import {
  BLIND_REVIEW_EXCLUSIONS, blindReviewExclusion, isLinkedInLink, markdownText, postingKeys, reviewDate, safeHttpUrl,
  type BlindReviewFacts,
} from "../../reporting/blindReviewRules.js";
import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS } from "../../db/stagingDatabaseIdentity.js";
import { requireReplayDatabaseUrl } from "../../reporting/replayGuard.js";

const candidate = (i: number): BlindReviewCandidate => ({
  id: `job-${String(i).padStart(3, "0")}`, company_name: "Co", title: "Role", location: "Singapore",
  canonical_url: `https://example.test/${i}`, score: 90.5 - i / 10, unmatched_must: 0,
});

const poolOf = (size: number): BlindReviewPool => ({
  rows: Array.from({ length: size }, (_, i) => candidate(i)),
  excluded: {
    ...(Object.fromEntries(BLIND_REVIEW_EXCLUSIONS.map((r) => [r, 0])) as BlindReviewPool["excluded"]),
    LINKEDIN: 7, NOT_VERIFIED_OPEN_ON_DRAW_DATE: 12,
  },
  scored: size + 19, notYetDecided: 3, labelledNotFound: 0, drawDate: "2026-11-26", timeZone: "Asia/Singapore",
});

const eligible: BlindReviewFacts = {
  archived: false, testFixture: false, gatePassed: true, manuallyRemoved: false, savedByUser: false, hasApplication: false,
  labelled: false, samePostingAsTaken: false, linkedIn: false, contentComplete: true, hasPostingLink: true, currentTopKMatch: true,
  awaitingRecompute: false, confirmedClosed: false, availabilityCurrent: true, availabilityVerifiedAt: new Date("2026-11-26T02:00:00Z"),
};

describe("blind review rules", () => {
  const now = new Date("2026-11-26T05:00:00Z");

  it("dates in Singapore, not UTC", () => {
    expect(reviewDate(new Date("2026-11-25T15:59:59Z"))).toBe("2026-11-25");
    expect(reviewDate(new Date("2026-11-25T16:00:00Z"))).toBe("2026-11-26");
  });

  it.each<[string, Partial<BlindReviewFacts>]>([
    ["ARCHIVED", { archived: true }], ["TEST_FIXTURE", { testFixture: true }], ["NOT_GATE_PASSED", { gatePassed: false }],
    ["MANUALLY_REMOVED", { manuallyRemoved: true }], ["SAVED_BY_USER", { savedByUser: true }], ["HAS_APPLICATION", { hasApplication: true }],
    ["ALREADY_LABELLED", { labelled: true }], ["SAME_POSTING_AS_SAVED_APPLIED_OR_LABELLED", { samePostingAsTaken: true }],
    ["LINKEDIN", { linkedIn: true }], ["AWAITING_CONTENT", { contentComplete: false }], ["NO_POSTING_LINK", { hasPostingLink: false }],
    ["NO_CURRENT_TOPK_MATCH", { currentTopKMatch: false }], ["AWAITING_RECOMPUTE", { awaitingRecompute: true }],
    ["CONFIRMED_CLOSED", { confirmedClosed: true, availabilityCurrent: false }],
    ["NOT_VERIFIED_OPEN_ON_DRAW_DATE", { availabilityCurrent: false }],
    ["NOT_VERIFIED_OPEN_ON_DRAW_DATE", { availabilityVerifiedAt: new Date("2026-11-25T02:00:00Z") }],
    ["NOT_VERIFIED_OPEN_ON_DRAW_DATE", { availabilityVerifiedAt: null }],
  ])("%s", (reason, change) => {
    expect(blindReviewExclusion(eligible, now)).toBeNull();
    expect(blindReviewExclusion({ ...eligible, ...change }, now)).toBe(reason);
  });

  it("recognises LinkedIn links, including wrapped ones, and not look-alikes", () => {
    for (const url of ["https://www.linkedin.com/jobs/view/1", "linkedin.com/jobs/view/1", "https://lnkd.in/x",
      "https://www.google.com/url?q=https%3A%2F%2Fsg.linkedin.com%2Fjobs%2Fview%2F1",
      "https://click.example.test/r?u=www.linkedin.com%2Fjobs%2Fview%2F1", "https://click.example.test/r?u=linkedin.com/jobs/view/1",
      "https://click.example.test/r/www.linkedin.com/jobs/view/1", "https://click.example.test/r/https%3A%2F%2Flinkedin.com%2Fjobs%2F1",
      "https://click.example.test/r?u=https%253A%252F%252Fwww.linkedin.com%252Fjobs", "https://click.example.test/r#//lnkd.in/x"]) {
      expect(isLinkedInLink(url), url).toBe(true);
    }
    for (const url of ["https://notlinkedin.com/jobs/1", "https://linkedin.com.example.test/x", "https://example.test/linkedin.com",
      "https://example.test/r?utm_source=linkedin.com", "https://example.test/r/notlinkedin.com/jobs", "", null]) {
      expect(isLinkedInLink(url), String(url)).toBe(false);
    }
  });

  it("makes untrusted text one inert table cell", () => {
    const cell = markdownText("Lead\r\n| 99 | <img src=x onerror=1> [click](javascript:1) ![i](u) **b** `c` https://evil.test www.evil.test a@b.test \\");
    expect(cell).not.toMatch(/[\r\n<>@]/);
    expect(cell).not.toMatch(/(?<!\\)[|[\]()*`!]/);
    expect(cell).not.toMatch(/www\./i);
    expect(cell.endsWith("\\\\")).toBe(true);
  });

  it("leaves nothing for a linkifier to find in the text as rendered", () => {
    // What a Markdown viewer shows for the cell: entities and backslash escapes decoded. Linkifiers run over that text.
    const rendered = (markdown: string) => markdown.replace(
      /\\([!-/:-@[-`{-~])|&#(\d+);|&(amp|lt|gt);/g,
      (_, escaped?: string, code?: string, name?: string) =>
        escaped ?? (code ? String.fromCodePoint(Number(code)) : ({ amp: "&", lt: "<", gt: ">" } as Record<string, string>)[name!]!),
    );
    // linkify-it is the linkifier the mail parser dependency ships; fuzzy domains are off because GFM does not link them.
    const LinkifyIt = createRequire(import.meta.url)("linkify-it");
    const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: true });
    const found = (text: string): string[] => [
      ...((linkify.match(text) ?? []) as Array<{ raw: string }>).map((m) => m.raw),
      ...(text.match(/www\.[a-z0-9-]|(?:mailto|xmpp):[a-z0-9]|\/\/[a-z0-9]|[a-z0-9._+-]+@[a-z0-9-]+\./gi) ?? []),
    ];
    for (const hostile of ["a@b.test", "mailto:a@b.test", "MAILTO:someone", "xmpp:a@b.test/room", "//evil.test/x", "////evil.test",
      "https://evil.test", "ftp://evil.test", "www.evil.test", "a\u00ad@\u200bb.test"]) {
      expect(found(hostile.replace(/\p{Cf}/gu, "")).length, `control: ${hostile}`).toBeGreaterThan(0);
      expect(found(rendered(markdownText(hostile))), hostile).toEqual([]);
    }
  });

  it("strips every format character", () => {
    expect(markdownText("a\u00adb\u200bc\u2060d\u{e0041}e\u061cf\u180eg\u202eh\ufeffi")).toBe("abcdefghi");
  });

  it("gives no posting keys without a known company name", () => {
    const record = { title: "Role", location: "Singapore", urls: ["https://example.test/1"], identityHashes: ["x:1"] };
    for (const company of [null, "", "Unknown", "Unknown Company", "https://logo.example.test/a.png"]) {
      expect(postingKeys({ ...record, company }), String(company)).toEqual([]);
    }
    expect(postingKeys({ ...record, company: "Acme" }).length).toBeGreaterThan(0);
  });

  it("accepts only http and https links, encoded", () => {
    expect(safeHttpUrl("https://example.test/a b?q=(1)|<x>")).toBe("https://example.test/a%20b?q=%281%29%7C%3Cx%3E");
    for (const url of ["javascript:alert(1)", "data:text/html,x", "ftp://example.test/a", "https://user:pw@example.test/", "not a url",
      "https://example.test/\njavascript:1", "", null]) {
      expect(safeHttpUrl(url), String(url)).toBeNull();
    }
  });
});

describe("blind review draw", () => {
  const rank = (id: string) => createHash("sha256").update(`seed:${id}`).digest().readUInt32BE(0);
  const expected = (from: BlindReviewCandidate[]) => [...from].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 15).map((r) => r.id).sort();

  it("takes 15 of the best 30 and 15 of positions 40% to 60%, by seeded hash, shuffled", () => {
    const pool = poolOf(200);
    const picked = drawBlindReview(pool, "seed");
    const group = (name: string) => picked.filter((j) => j.group === name).map((j) => j.id).sort();
    expect(group("TOP")).toEqual(expected(pool.rows.slice(0, 30)));
    expect(group("MIDDLE")).toEqual(expected(pool.rows.slice(80, 120)));
    expect(new Set(picked.map((j) => j.id)).size).toBe(30);
    const shuffle = (id: string) => rank(`x${id}`);
    expect(picked.map((j) => j.id)).toEqual([...picked].sort((a, b) => shuffle(a.id) - shuffle(b.id)).map((j) => j.id));
    expect(drawBlindReview(pool, "seed")).toEqual(picked);
    expect(drawBlindReview(pool, "other")).not.toEqual(picked);
  });

  it("draws from exactly 100, and refuses 99 with the cause and the counts instead of a smaller sample", () => {
    expect(drawBlindReview(poolOf(100), "seed")).toHaveLength(30);
    expect(() => drawBlindReview(poolOf(99), "seed")).toThrow(
      /99 eligible jobs, 100 required.*sample is not reduced.*12 more postings pass every other rule.*not confirmed open on 2026-11-26 \(Asia\/Singapore\)/,
    );
    expect(() => drawBlindReview(poolOf(99), "seed")).toThrow(/LINKEDIN=7/);
  });

  it("escapes every field of the sheet and states the date and timezone", () => {
    const pool = poolOf(100);
    const [job] = drawBlindReview(pool, "seed");
    const sheet = renderBlindReviewSheet(
      [{ ...job!, title: "A\n| B", company_name: "<script>", location: "[x](y)", canonical_url: "https://example.test/a|b" }], pool,
    );
    expect(sheet).toContain("| 1 | A \\| B | &lt;script&gt; | \\[x\\]\\(y\\) | <https://example.test/a%7Cb> |  |");
    expect(sheet).toContain("2026-11-26 (Asia/Singapore)");
    expect(sheet).toContain("LinkedIn is left out");
    expect(sheet).not.toContain(String(job!.score));
    expect(() => renderBlindReviewSheet([{ ...job!, canonical_url: "javascript:1" }], pool)).toThrow(/no safe posting link/);
  });

  it("reads --exclude files and refuses a mistyped argument", () => {
    expect(parseBlindReviewArgs(["s.md", "k.json", "--exclude=a.json", "--exclude=b.json", "--seed=z"]))
      .toEqual({ sheetPath: "s.md", keyPath: "k.json", seed: "z", excludeKeyPaths: ["a.json", "b.json"] });
    for (const args of [["s.md", "k.json", "--exclude", "a.json"], ["s.md", "k.json", "--exclude="], ["s.md", "k.json", "--exlude=a.json"], ["s.md"]]) {
      expect(() => parseBlindReviewArgs(args), args.join(" ")).toThrow();
    }
    const id = randomUUID();
    expect(labelledIdsFromKeys(["a"], () => JSON.stringify({ items: [{ id }] }))).toEqual([id]);
    expect(() => labelledIdsFromKeys(["a"], () => JSON.stringify({ items: [] }))).toThrow(/no items/);
    expect(() => labelledIdsFromKeys(["a"], () => JSON.stringify({ items: [{}] }))).toThrow(/without a job id/);
  });

  it("the script passes the --exclude ids and the clock to the pool, and checks the URL before connecting", () => {
    const source = fs.readFileSync("scripts/experiments/blind_review_set.ts", "utf8");
    expect(source).toContain("labelledIdsFromKeys(excludeKeyPaths");
    expect(source).toContain("loadBlindReviewPool(client, { workspaceId: ws.workspaceId, excludedIds, now: new Date() })");
    const check = source.indexOf("requireReplayDatabaseUrl(process.env.REPLAY_DATABASE_URL)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(source.indexOf("new pg.Client("));
  });

  it("checks REPLAY_DATABASE_URL and never echoes it", () => {
    expect(() => requireReplayDatabaseUrl(undefined)).toThrow(/not set/);
    expect(() => requireReplayDatabaseUrl("  ")).toThrow(/not set/);
    expect(() => requireReplayDatabaseUrl("secret-token")).toThrow(/^REPLAY_DATABASE_URL is not a valid URL\.$/);
    expect(() => requireReplayDatabaseUrl("https://example.test/db")).toThrow(/not a postgres URL/);
    for (const production of STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.knownProductionHostnames) {
      const [first, ...rest] = production.split(".");
      for (const host of [production, [`${first}-pooler`, ...rest].join("."), `${production.toUpperCase()}.`]) {
        expect(() => requireReplayDatabaseUrl(`postgres://u:p@${host}/db`)).toThrow(/known production host/);
      }
    }
    for (const query of ["host=db.example.test", "HOST=db.example.test", "hostaddr=10.0.0.1"]) {
      expect(() => requireReplayDatabaseUrl(`postgres://u:p@localhost/db?${query}`)).toThrow(/host in its query/);
    }
    expect(requireReplayDatabaseUrl(" postgres://u:p@localhost:5432/db ")).toBe("postgres://u:p@localhost:5432/db");
  });
});
