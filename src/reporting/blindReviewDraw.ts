/**
 * The blind review draw: command arguments, earlier-sheet ids, the 30-job draw, and the sheet and key texts.
 */
import { createHash } from "node:crypto";

import type { BlindReviewCandidate, BlindReviewPool } from "./blindReviewPool.js";
import { markdownText, safeHttpUrl } from "./blindReviewRules.js";

export const DEFAULT_BLIND_REVIEW_SEED = "blind-review-2026-11-20";
export const MIN_BLIND_REVIEW_POOL = 100;
const TOP_POOL = 30; // draw 15 from the best 30
const PER_GROUP = 15;
const USAGE = "usage: blind_review_set.ts <sheet.md> <key.json> [--seed=<text>] [--exclude=<key.json> ...]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BlindReviewArgs {
  sheetPath: string;
  keyPath: string;
  seed: string;
  excludeKeyPaths: string[];
}

/** Unknown or extra arguments are refused, so a mistyped --exclude can never be ignored. */
export function parseBlindReviewArgs(args: readonly string[]): BlindReviewArgs {
  const positional: string[] = [];
  const excludeKeyPaths: string[] = [];
  let seed = DEFAULT_BLIND_REVIEW_SEED;
  for (const arg of args) {
    if (arg.startsWith("--exclude=") && arg.length > "--exclude=".length) excludeKeyPaths.push(arg.slice("--exclude=".length));
    else if (arg.startsWith("--seed=")) seed = arg.slice("--seed=".length);
    else if (arg.startsWith("--")) throw new Error(`unknown argument ${arg}; ${USAGE}`);
    else positional.push(arg);
  }
  const [sheetPath, keyPath] = positional;
  if (!sheetPath || !keyPath || positional.length !== 2) throw new Error(USAGE);
  return { sheetPath, keyPath, seed, excludeKeyPaths };
}

/** Job ids labelled in earlier sheets, read from their key files. */
export function labelledIdsFromKeys(paths: readonly string[], readFile: (path: string) => string): string[] {
  return paths.flatMap((file) => {
    const key = JSON.parse(readFile(file)) as { items?: Array<{ id?: unknown }> };
    if (!key.items?.length) throw new Error(`${file} has no items to exclude`);
    return key.items.map((item) => {
      if (typeof item.id !== "string" || !UUID.test(item.id)) throw new Error(`${file} has an item without a job id`);
      return item.id;
    });
  });
}

export function blindReviewPoolSummary(pool: BlindReviewPool): string {
  const reasons = Object.entries(pool.excluded).map(([reason, count]) => `${reason}=${count}`).join(", ");
  return [
    `draw date ${pool.drawDate} (${pool.timeZone}): only jobs confirmed open on that date are eligible; LinkedIn is left out`,
    `scored jobs ${pool.scored}; eligible ${pool.rows.length}; left out by reason: ${reasons}`,
    `not scored (matched, gate-passed, no adjusted score yet - re-decide first): ${pool.notYetDecided}`,
    `labelled ids not found in this database (their other records cannot be recognised): ${pool.labelledNotFound}`,
  ].join("\n");
}

export type BlindReviewPick = BlindReviewCandidate & { group: "TOP" | "MIDDLE" };

/**
 * 15 of the 30 best-scored eligible jobs and 15 of the middle fifth (positions 40% to 60% by score), each chosen and then
 * shuffled by a seeded hash of the job id. `pool.rows` must already be ordered by score, best first. Throws rather than
 * drawing from a smaller pool or returning fewer than 30 jobs.
 */
export function drawBlindReview(pool: BlindReviewPool, seed: string): BlindReviewPick[] {
  const rows = pool.rows;
  if (rows.length < MIN_BLIND_REVIEW_POOL) {
    throw new Error(
      `Blind review not drawn: ${rows.length} eligible jobs, ${MIN_BLIND_REVIEW_POOL} required. The sample is not reduced. ` +
      `${pool.excluded.NOT_VERIFIED_OPEN_ON_DRAW_DATE} more postings pass every other rule and are not known to be closed, but were not confirmed open on ${pool.drawDate} (${pool.timeZone}).\n` +
      blindReviewPoolSummary(pool),
    );
  }
  const rank = (id: string) => createHash("sha256").update(`${seed}:${id}`).digest().readUInt32BE(0);
  const lo = Math.floor(rows.length * 0.4);
  const hi = Math.floor(rows.length * 0.6);
  const pick = (from: BlindReviewCandidate[], group: BlindReviewPick["group"]) =>
    [...from].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, PER_GROUP).map((r) => ({ ...r, group }));
  const top = pick(rows.slice(0, TOP_POOL), "TOP");
  const middle = pick(rows.slice(lo, hi), "MIDDLE");
  return [...top, ...middle].sort((a, b) => rank(`x${a.id}`) - rank(`x${b.id}`));
}

export function renderBlindReviewSheet(picked: readonly BlindReviewPick[], pool: Pick<BlindReviewPool, "drawDate" | "timeZone">): string {
  return [
    "# Blind review: would you apply?",
    "",
    "Thirty jobs you have not saved, applied to or labelled before; LinkedIn is left out. Scores and ranks are hidden. For each, mark **Y** (would apply) or **N** (would not).",
    `Each posting was confirmed open on ${pool.drawDate} (${pool.timeZone}).`,
    "Judge the role, not the evidence match. About 10 minutes.",
    "",
    "| # | Title | Company | Location | Link | Apply? (Y/N) |",
    "|---|---|---|---|---|---|",
    ...picked.map((job, i) => {
      const url = safeHttpUrl(job.canonical_url);
      if (!url) throw new Error(`job ${job.id} has no safe posting link`);
      return `| ${i + 1} | ${markdownText(job.title)} | ${markdownText(job.company_name)} | ${markdownText(job.location)} | <${url}> |  |`;
    }),
    "",
  ].join("\n");
}

export function renderBlindReviewKey(picked: readonly BlindReviewPick[], pool: BlindReviewPool, seed: string): string {
  return JSON.stringify(
    {
      pool: pool.rows.length, seed, drawDate: pool.drawDate, timeZone: pool.timeZone, excluded: pool.excluded,
      items: picked.map((j, i) => ({ n: i + 1, id: j.id, group: j.group, score: j.score, unmatchedMust: j.unmatched_must, title: j.title })),
    },
    null,
    2,
  );
}
