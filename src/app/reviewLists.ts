/**
 * Wiring of the review-lists command (scripts/build_review_lists.ts). A build writes no sheet while a listed job still
 * awaits today's availability check (the check command's own plan says which). Build reads a replay copy only
 * (REPLAY_DATABASE_URL and REPLAY_BRANCH_ID, the connected branch checked, one READ ONLY transaction) and writes three
 * files under private/review/. Reveal and score read the filled sheet and its key. Only counts are printed: no title,
 * employer, host or setting, and nothing about which job was saved.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { configPath } from "../config/configPaths.js";
import { loadStructuredFile } from "../config/structuredLoader.js";
import { pgConnectionConfig } from "../db/pgSsl.js";
import { OWNER_SAVED_SOURCE_NAMES } from "../services/jobArchiveHardRejectedPolicy.js";
import { isUnknownEmployerName, normalizePostingUrl } from "../ingestion/postingIdentity.js";
import {
  buildReviewKey,
  buildReviewListsFromStore,
  changedAfterShown,
  openShownAnswers,
  sealShownAnswers,
  countUncheckedJobs,
  EMPTY_DRAFT,
  idsFromKeyText,
  jobIdOrder,
  listedPositions,
  openDraft,
  openReviewKey,
  parseFilledSheet,
  parseRankingDesign,
  renderCheckByHand,
  renderReveal,
  renderReviewSheet,
  requireApprovedDesign,
  scoreReviewSheet,
  sealDraft,
  updateDraft,
  type CompanyIndustryTags,
  type RankingDesign,
  type ReviewListResult,
  type ReviewListRules,
  type RoleKind,
} from "../modules/decision/index.js";
import { withReadOnlySession, type SessionQueryable } from "../platform/persistence/index.js";
import { classifyCareerTrack } from "../pipeline/careerTrack.js";
import { blockedLinkReason, loadJobBoardHosts } from "../ingestion/availabilityCheckLinks.js";
import { postingRequestUrl } from "../ingestion/jobContentFetcher.js";
import { detectCustomerFacingDelivery, detectPeopleManagementCore } from "../pipeline/roleShape.js";
import { topKCapabilityScore } from "../pipeline/scoringPolicy.js";
import { requireApprovedReplayTarget, requireReplayDatabaseUrl } from "../reporting/replayGuard.js";
import { resolveWorkspaceContext } from "../workspace/context.js";

export class ReviewListsRefusal extends Error {}

const FALLBACK_KINDS: Readonly<Record<string, RoleKind>> = {
  HANDS_ON_AI_DATA: "DATA_ML",
  ARCHITECTURE: "ARCHITECTURE",
  PRODUCT: "PRODUCT",
  PROGRAM_MANAGEMENT: "DELIVERY_MANAGEMENT",
  GENERIC_SOFTWARE: "SOFTWARE",
};

const roleShapeInput = (title: string, description: string) =>
  ({ title, description, employmentType: "", degreeGapQuote: null });

export const REVIEW_LIST_RULES: ReviewListRules = {
  topKScore: (rows) => topKCapabilityScore(rows).score,
  // Posting wording only: a job title is not evidence of external client work.
  externalClientFacing: (description) => detectCustomerFacingDelivery(roleShapeInput("", description)) !== null,
  peopleManagementCore: (title, description) => detectPeopleManagementCore(roleShapeInput(title, description)) !== null,
  fallbackKind: (title) => FALLBACK_KINDS[classifyCareerTrack(title).track] ?? null,
  normalizePostingUrl: (url) => normalizePostingUrl(url),
  isUnknownEmployer: isUnknownEmployerName,
  savedSourceNames: OWNER_SAVED_SOURCE_NAMES,
};

/** The migration that states what a lead is; read as text, never applied. */
export function loadLeadDefinitionSql(file = path.resolve("migrations", "123_job_lead_read_model.sql")): string {
  return fs.readFileSync(file, "utf8");
}

const CompaniesSchema = z.object({
  companies: z.array(z.object({
    name: z.string(),
    board_slug: z.string().nullish(),
    target_lanes: z.array(z.string()).default([]),
  }).passthrough()),
}).passthrough();

/** The employers of config/companies.yml with their tags; a board is also known by its slug. */
export async function loadCompanyIndustryTags(file = configPath("companies.yml")): Promise<CompanyIndustryTags[]> {
  const { data } = await loadStructuredFile(file, CompaniesSchema);
  return data.companies.map((company) => ({
    names: [company.name, ...(company.board_slug ? [company.board_slug] : [])],
    tags: company.target_lanes,
  }));
}

export interface CommandArguments {
  readonly mode: "build" | "reveal" | "score";
  readonly privateDir: string;
  readonly designPath: string;
  readonly name: string;
  readonly nameGiven: boolean;
  readonly seed: string | null;
  readonly replace: boolean;
  readonly sheetPath: string | null;
  readonly keyPath: string | null;
  readonly revealedPath: string | null;
}

const singaporeDate = (value: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);

export function parseReviewListArguments(argv: readonly string[], now: Date): CommandArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of argv) {
    const [, key, value] = /^--([a-z-]+)(?:=(.*))?$/.exec(argument) ?? [];
    if (key && value === undefined && (key === "replace" || key === "score" || key === "reveal")) flags.add(key);
    else if (key && value && ["private-dir", "design", "name", "seed", "sheet", "key", "revealed"].includes(key)) values.set(key, value);
    else throw new ReviewListsRefusal(`Unknown or empty argument: --${key ?? "?"}`);
  }
  const privateDir = path.resolve(values.get("private-dir") ?? "private");
  // Personal data goes nowhere but a directory named private (which git ignores).
  if (path.basename(privateDir).toLowerCase() !== "private") {
    throw new ReviewListsRefusal("--private-dir must be a directory named private.");
  }
  const name = values.get("name") ?? singaporeDate(now);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ReviewListsRefusal("--name may hold letters, digits, - and _ only.");
  if (flags.has("score") && flags.has("reveal")) throw new ReviewListsRefusal("Give --reveal or --score, not both.");
  const mode = flags.has("score") ? "score" : flags.has("reveal") ? "reveal" : "build";
  if (mode !== "build" && !(values.has("sheet") && values.has("key"))) {
    throw new ReviewListsRefusal(`--${mode} needs --sheet=<filled sheet> and --key=<key file>.`);
  }
  return {
    mode,
    privateDir,
    designPath: path.resolve(values.get("design") ?? path.join(privateDir, "profile", "ranking_design.json")),
    name,
    nameGiven: values.has("name"),
    seed: values.get("seed") ?? null,
    replace: flags.has("replace"),
    sheetPath: values.get("sheet") ?? null,
    keyPath: values.get("key") ?? null,
    revealedPath: values.get("revealed") ?? null,
  };
}

export function reviewListFiles(privateDir: string, name: string) {
  const directory = path.join(privateDir, "review");
  return {
    directory,
    sheet: path.join(directory, `review_lists_sheet_${name}.md`),
    key: path.join(directory, `review_lists_key_${name}.json`),
    jobIds: path.join(directory, `review_lists_job_ids_${name}.txt`),
    revealed: path.join(directory, `review_lists_revealed_${name}.md`),
    draft: path.join(directory, `review_lists_draft_${name}.json`),
    shown: path.join(directory, `review_lists_shown_${name}.json`),
    checkByHand: path.join(directory, "for_coordinator", `check_by_hand_${name}.md`),
  };
}

/** Every job of every earlier key file. The key of the run being redrawn is not an earlier one. */
export function ratedIdsFromReviewFolder(directory: string, ownKey: string): { ids: string[]; files: number } {
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((file) => /key.*\.json$/i.test(file) && file !== path.basename(ownKey)).sort()
    : [];
  const ids = files.flatMap((file) => idsFromKeyText(fs.readFileSync(path.join(directory, file), "utf8"), file));
  return { ids: [...new Set(ids)], files: files.length };
}

/** An existing output is replaced only on request; a sheet with anything written in it, or already revealed, never. */
function requireWritable(files: ReturnType<typeof reviewListFiles>, replace: boolean): void {
  // A draft run leaves only the job id file and the draft, so it can simply be run again.
  const existing = [files.sheet, files.key].filter((file) => fs.existsSync(file));
  if (existing.length === 0) return;
  if (!replace) throw new ReviewListsRefusal("These lists already exist. Use another --name, or --replace for an unfilled sheet.");
  if (fs.existsSync(files.revealed)) {
    throw new ReviewListsRefusal("Refusing to replace lists whose links were already shown. Use another --name.");
  }
  if (!fs.existsSync(files.sheet)) return;
  const filled = [...parseFilledSheet(fs.readFileSync(files.sheet, "utf8")).values()]
    .some((entry) => entry.answer !== null || entry.commented);
  if (filled) throw new ReviewListsRefusal("Refusing to replace a sheet that has answers in it. Use another --name.");
}

/** The names of drafts whose lists never became final. */
export function unfinishedDrafts(directory: string): string[] {
  const files = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  return files
    .flatMap((file) => /^review_lists_draft_([A-Za-z0-9_-]+)\.json$/.exec(file)?.[1] ?? [])
    .filter((name) => !files.includes(`review_lists_sheet_${name}.md`))
    .sort();
}

export function formatReviewSummary(result: ReviewListResult): string {
  const { lists, withoutFullText } = result;
  const counts = (record: Readonly<Record<string, number | undefined>>) =>
    Object.entries(record).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join(" ");
  return [
    `leads in the workspace=${result.leads.total} (definition: ${result.leads.source})`,
    // Nothing here tells what the availability check dropped: closed counts are left out until the rating is scored.
    `excluded: ${counts({ ...result.excluded, KNOWN_CLOSED: undefined })}`,
    `dropped: ${counts({ ...result.dropped, dismissed: undefined })}`,
    `eligible postings=${result.eligible} candidate records without top-K=${result.withoutTopK} rated ids not found=${result.ratedNotFound}`,
    `left out without the full posting text, by role type: ${counts(withoutFullText.byRoleType) || "none"} (saved=${withoutFullText.saved} not saved=${withoutFullText.unsaved})`,
    ...lists.byType.map((list) => `list ${list.type.key}: eligible=${list.eligible} listed=${list.jobs.length}`),
    `overall: listed=${lists.overall.length}`,
    `comparison: listed=${lists.comparison.length} unknown role=${lists.comparison.filter((job) => job.classification.roleType === null).length} other=${lists.comparison.filter((job) => job.classification.roleType !== null).length}`,
  ].join("\n");
}

export interface StoreRequest {
  readonly design: RankingDesign;
  readonly companyTags: readonly CompanyIndustryTags[];
  readonly ratedIds: readonly string[];
}

export interface StoreResult {
  readonly branch: string;
  readonly result: ReviewListResult;
  /** Listed jobs whose link the availability check would still read today. */
  readonly unchecked: number;
}

export interface CommandDependencies {
  readonly log?: (line: string) => void;
  readonly now?: Date;
  /** Reads the lists from the store; the default is the guarded read-only replay session. */
  readonly read?: (request: StoreRequest, env: NodeJS.ProcessEnv) => Promise<StoreResult>;
  /** Replaces the replay-branch check of the real read, so that a test can run it on its own database. */
  readonly approve?: (url: string, identity: Parameters<typeof requireApprovedReplayTarget>[1], branch: string) => void;
}

/**
 * How many of the jobs the check command would still read today, with the check's own link rules. The check itself is
 * not imported: its modules load environment files, which this command never does.
 */
export async function uncheckedJobCount(
  db: SessionQueryable,
  workspaceId: string,
  jobIds: readonly string[],
  now: Date,
): Promise<number> {
  const jobBoardHosts = await loadJobBoardHosts();
  return countUncheckedJobs(db, workspaceId, jobIds, now, {
    readable: (link) => blockedLinkReason(link, jobBoardHosts) === null,
    requestHost: (link) => postingRequestUrl(link).hostname,
  });
}

async function readFromReplay(
  request: StoreRequest,
  env: NodeJS.ProcessEnv,
  approve: NonNullable<CommandDependencies["approve"]> = requireApprovedReplayTarget,
): Promise<StoreResult> {
  const branch = env.REPLAY_BRANCH_ID?.trim();
  if (!branch) throw new ReviewListsRefusal("REPLAY_BRANCH_ID is not set.");
  const url = requireReplayDatabaseUrl(env.REPLAY_DATABASE_URL);
  const read = await withReadOnlySession(
    pgConnectionConfig(url),
    (identity) => {
      try {
        approve(url, identity, branch);
      } catch {
        // The guard's own message names the database host, which this command does not print.
        throw new ReviewListsRefusal("Refusing to run: REPLAY_DATABASE_URL is not the approved replay branch.");
      }
    },
    async (db) => {
      const workspace = await resolveWorkspaceContext(db as never);
      const result = await buildReviewListsFromStore(db, {
        ...request,
        workspaceId: workspace.workspaceId,
        rules: REVIEW_LIST_RULES,
        leadDefinitionSql: loadLeadDefinitionSql(),
      });
      const listed = listedPositions(result.lists).map((position) => position.id);
      return { result, unchecked: await uncheckedJobCount(db, workspace.workspaceId, listed, new Date()) };
    },
  );
  return { branch, ...read };
}

async function build(args: CommandArguments, env: NodeJS.ProcessEnv, dependencies: CommandDependencies): Promise<void> {
  const log = dependencies.log ?? console.log;
  const now = dependencies.now ?? new Date();
  if (!fs.existsSync(args.designPath)) throw new ReviewListsRefusal("The ranking design file does not exist.");
  const parsed = parseRankingDesign(fs.readFileSync(args.designPath, "utf8"));
  const design = args.seed ? { ...parsed, lists: { ...parsed.lists, seed: args.seed } } : parsed;
  requireApprovedDesign(design);
  const files = reviewListFiles(args.privateDir, args.name);
  // A draft holds what the check has dropped so far. A run on a later day must not silently start another.
  const unfinished = unfinishedDrafts(files.directory);
  if (!args.nameGiven && unfinished.length && !unfinished.includes(args.name)) {
    throw new ReviewListsRefusal(`Refusing to start new lists: pass --name=${unfinished.at(-1)} to continue the unfinished draft, or another --name.`);
  }
  requireWritable(files, args.replace);
  const rated = ratedIdsFromReviewFolder(files.directory, files.key);
  const companyTags = await loadCompanyIndustryTags();
  const request: StoreRequest = { design, companyTags, ratedIds: rated.ids };
  const { branch, result, unchecked } = dependencies.read
    ? await dependencies.read(request, env)
    : await readFromReplay(request, env, dependencies.approve);

  const { lists } = result;
  const draft = updateDraft(
    fs.existsSync(files.draft) ? openDraft(fs.readFileSync(files.draft, "utf8")) : EMPTY_DRAFT,
    lists,
    new Set(result.closedIds),
    new Set(result.postings.map((job) => job.id)),
  );
  fs.mkdirSync(files.directory, { recursive: true });
  fs.writeFileSync(files.draft, sealDraft(draft), "utf8");
  fs.mkdirSync(path.dirname(files.checkByHand), { recursive: true });
  fs.writeFileSync(files.checkByHand, renderCheckByHand(lists, new Set(result.checkByHandIds)), "utf8");
  fs.writeFileSync(files.jobIds, jobIdOrder(lists, design.lists.seed).map((id) => `${id}\n`).join(""), "utf8");

  log(`branch=${branch} earlier key files=${rated.files} rated ids=${rated.ids.length}`);
  if (unchecked > 0) {
    // A sheet from an earlier, unfilled run would be of other lists.
    for (const stale of [files.sheet, files.key]) fs.rmSync(stale, { force: true });
    // No number: after a drop it would say how many replacements came in.
    log("NOT FINAL: listed jobs await today's availability check. No sheet was written.");
    log(`Run the check on review_lists_job_ids_${args.name}.txt (do not show its output to the rater), then run this again with --name=${args.name}.`);
    return;
  }
  // Counts are printed for final lists only: a draft's counts beside the final ones would show how many were dropped.
  log(`employer override list: ${design.employer_override ? "approved" : "none in this design"}`);
  log(formatReviewSummary(result));
  const key = buildReviewKey(lists, { name: args.name, createdAt: now.toISOString(), seed: design.lists.seed, dropped: draft.dropped });
  // A board stores its slug as the company: the sheet writes the employer's name, as other records do.
  const boardNames = new Map(companyTags.flatMap((company) => company.names.slice(1).map((slug) => [slug.toLowerCase(), company.names[0]!] as const)));
  fs.writeFileSync(files.sheet, renderReviewSheet(lists, design.lists.seed, boardNames), "utf8");
  fs.writeFileSync(files.key, `${JSON.stringify(key, null, 2)}\n`, "utf8");
  log(`wrote ${key.items.length} jobs: review_lists_{sheet,key}_${args.name} under private/review/`);
}

/** The run a key file belongs to, and that run's files under the private directory: nothing is written anywhere else. */
function filesOfKey(args: CommandArguments) {
  const name = /^review_lists_key_([A-Za-z0-9_-]+)\.json$/.exec(path.basename(args.keyPath!))?.[1];
  if (!name) throw new ReviewListsRefusal("--key must be a review_lists_key_<name>.json file.");
  return { name, files: reviewListFiles(args.privateDir, name) };
}

const readIfThere = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** Writes the links and saved marks of the answered jobs, under <private-dir>/review whatever folder the key is in. */
function reveal(args: CommandArguments, log: (line: string) => void): void {
  const { details } = openReviewKey(fs.readFileSync(args.keyPath!, "utf8"));
  const { name, files } = filesOfKey(args);
  const sheet = fs.readFileSync(args.sheetPath!, "utf8");
  const record = readIfThere(files.shown);
  const shown = renderReveal(sheet, details, readIfThere(files.revealed), record ? openShownAnswers(record) : {});
  fs.mkdirSync(files.directory, { recursive: true });
  fs.writeFileSync(files.revealed, shown.text, "utf8");
  fs.writeFileSync(files.shown, sealShownAnswers(shown.answers), "utf8");
  log(`shown ${shown.shown} of ${details.length} jobs in review_lists_revealed_${name}.md under private/review/`);
  const changed = changedAfterShown(sheet, shown.answers);
  if (changed.length) log(`WARNING: answers changed after their link was shown, rows: ${changed.join(", ")}`);
}

function score(args: CommandArguments, log: (line: string) => void): void {
  const { details, dropped } = openReviewKey(fs.readFileSync(args.keyPath!, "utf8"));
  const revealed = args.revealedPath ? fs.readFileSync(args.revealedPath, "utf8") : "";
  const sheet = fs.readFileSync(args.sheetPath!, "utf8");
  const result = scoreReviewSheet(sheet, details, revealed);
  // Until every job is rated, nothing else: a share would show which list a rated job is in.
  if (result.blank.length) {
    log(`result=${result.result}`);
    log(`unanswered rows: ${result.blank.join(", ")}`);
    return;
  }
  const record = readIfThere(filesOfKey(args).files.shown);
  const changed = record ? changedAfterShown(sheet, openShownAnswers(record)) : [];
  if (changed.length) log(`WARNING: answers changed after their link was shown, rows: ${changed.join(", ")}`);
  const share = (value: { yes: number; counted: number }) =>
    `${value.yes}/${value.counted}${value.counted ? ` (${((100 * value.yes) / value.counted).toFixed(1)}%)` : ""}`;
  log(`result=${result.result}`);
  log(`overall yes=${share(result.overall)}`);
  log(`listed yes=${share(result.lists)}`);
  log(`comparison yes=${share(result.comparison)}`);
  log(`comparison, unknown role yes=${share(result.comparisonUnknownRole)}`);
  log(`comparison, other roles yes=${share(result.comparisonOtherRole)}`);
  for (const type of result.byRoleType) log(`${type.type} yes=${share(type)}`);
  log(args.revealedPath ? `links noted closed (not scored)=${result.closedNoted}` : "links noted closed: no --revealed file given");
  // Only now that every job is rated: what the availability check dropped, and where it stood.
  const closed = dropped.filter((job) => job.reason === "CLOSED");
  log(`dropped by the availability check as closed=${closed.length}; no longer eligible for another reason=${dropped.length - closed.length}`);
  for (const type of [...new Set(closed.map((job) => job.roleType ?? "UNKNOWN"))].sort()) {
    const places = closed.filter((job) => (job.roleType ?? "UNKNOWN") === type).map((job) => [
      job.roleRank === null ? null : `rank ${job.roleRank}`,
      job.overallRank === null ? null : `overall ${job.overallRank}`,
      job.comparison ? "comparison" : null,
    ].filter(Boolean).join(" "));
    log(`  ${type}: ${places.length} (${places.join(", ")})`);
  }
}

export async function runReviewListsCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: CommandDependencies = {},
): Promise<void> {
  const args = parseReviewListArguments(argv, dependencies.now ?? new Date());
  const log = dependencies.log ?? console.log;
  if (args.mode === "score") score(args, log);
  else if (args.mode === "reveal") reveal(args, log);
  else await build(args, env, dependencies);
}
