/**
 * Wiring of the review-lists command (scripts/build_review_lists.ts). Build reads a replay copy only
 * (REPLAY_DATABASE_URL and REPLAY_BRANCH_ID, the connected branch checked, one READ ONLY transaction) and writes three
 * files under private/review/. Score reads two files. Only counts are printed: no title, employer, host or setting.
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
  idsFromKeyText,
  parseRankingDesign,
  renderReviewSheet,
  requireApprovedDesign,
  scoreReviewSheet,
  sheetJobs,
  type CompanyIndustryTags,
  type RankingDesign,
  type ReviewKey,
  type ReviewListResult,
  type ReviewListRules,
  type RoleKind,
} from "../modules/decision/index.js";
import { withReadOnlySession } from "../platform/persistence/index.js";
import { classifyCareerTrack } from "../pipeline/careerTrack.js";
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
  readonly mode: "build" | "score";
  readonly privateDir: string;
  readonly designPath: string;
  readonly name: string;
  readonly seed: string | null;
  readonly replace: boolean;
  readonly sheetPath: string | null;
  readonly keyPath: string | null;
}

const singaporeDate = (value: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);

export function parseReviewListArguments(argv: readonly string[], now: Date): CommandArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const argument of argv) {
    const [, key, value] = /^--([a-z-]+)(?:=(.*))?$/.exec(argument) ?? [];
    if (key && value === undefined && (key === "replace" || key === "score")) flags.add(key);
    else if (key && value && ["private-dir", "design", "name", "seed", "sheet", "key"].includes(key)) values.set(key, value);
    else throw new ReviewListsRefusal(`Unknown or empty argument: --${key ?? "?"}`);
  }
  const privateDir = path.resolve(values.get("private-dir") ?? "private");
  // Personal data goes nowhere but a directory named private (which git ignores).
  if (path.basename(privateDir).toLowerCase() !== "private") {
    throw new ReviewListsRefusal("--private-dir must be a directory named private.");
  }
  const name = values.get("name") ?? singaporeDate(now);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ReviewListsRefusal("--name may hold letters, digits, - and _ only.");
  const mode = flags.has("score") ? "score" : "build";
  if (mode === "score" && !(values.has("sheet") && values.has("key"))) {
    throw new ReviewListsRefusal("--score needs --sheet=<filled sheet> and --key=<key file>.");
  }
  return {
    mode,
    privateDir,
    designPath: path.resolve(values.get("design") ?? path.join(privateDir, "profile", "ranking_design.json")),
    name,
    seed: values.get("seed") ?? null,
    replace: flags.has("replace"),
    sheetPath: values.get("sheet") ?? null,
    keyPath: values.get("key") ?? null,
  };
}

export function reviewListFiles(privateDir: string, name: string) {
  const directory = path.join(privateDir, "review");
  return {
    directory,
    sheet: path.join(directory, `review_lists_sheet_${name}.md`),
    key: path.join(directory, `review_lists_key_${name}.json`),
    jobIds: path.join(directory, `review_lists_job_ids_${name}.txt`),
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

/** An existing output is replaced only on request, and a sheet with anything written in its answer columns never. */
function requireWritable(files: ReturnType<typeof reviewListFiles>, replace: boolean): void {
  const existing = [files.sheet, files.key, files.jobIds].filter((file) => fs.existsSync(file));
  if (existing.length === 0) return;
  if (!replace) throw new ReviewListsRefusal("These lists already exist. Use another --name, or --replace for an unfilled sheet.");
  if (!fs.existsSync(files.sheet)) return;
  const filled = fs.readFileSync(files.sheet, "utf8").split(/\r?\n/).some((line) => {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    return /^\d+$/.test(cells[1] ?? "") && cells.slice(7).some((cell) => cell !== "");
  });
  if (filled) throw new ReviewListsRefusal("Refusing to replace a sheet that has answers in it. Use another --name.");
}

export function formatReviewSummary(result: ReviewListResult): string {
  const unsaved = (jobs: ReadonlyArray<{ saved: boolean }>) => jobs.filter((job) => !job.saved).length;
  const { lists } = result;
  const counts = (record: Record<string, number>) => Object.entries(record).map(([key, value]) => `${key}=${value}`).join(" ");
  return [
    `leads in the workspace=${result.leads.total} (definition: ${result.leads.source})`,
    `excluded: ${counts(result.excluded)}`,
    `dropped: ${counts(result.dropped)}`,
    `eligible postings=${result.eligible} candidate records without top-K=${result.withoutTopK} rated ids not found=${result.ratedNotFound}`,
    ...lists.byType.map((list) =>
      `list ${list.type.key}: eligible=${list.eligible} listed=${list.jobs.length} unsaved=${unsaved(list.jobs)}`),
    `overall: listed=${lists.overall.length} unsaved=${unsaved(lists.overall)}`,
    `comparison: listed=${lists.comparison.length}`,
  ].join("\n");
}

export interface StoreRequest {
  readonly design: RankingDesign;
  readonly companyTags: readonly CompanyIndustryTags[];
  readonly ratedIds: readonly string[];
}

export interface CommandDependencies {
  readonly log?: (line: string) => void;
  readonly now?: Date;
  /** Reads the lists from the store; the default is the guarded read-only replay session. */
  readonly read?: (request: StoreRequest, env: NodeJS.ProcessEnv) => Promise<{ branch: string; result: ReviewListResult }>;
}

async function readFromReplay(request: StoreRequest, env: NodeJS.ProcessEnv): Promise<{ branch: string; result: ReviewListResult }> {
  const branch = env.REPLAY_BRANCH_ID?.trim();
  if (!branch) throw new ReviewListsRefusal("REPLAY_BRANCH_ID is not set.");
  const url = requireReplayDatabaseUrl(env.REPLAY_DATABASE_URL);
  const result = await withReadOnlySession(
    pgConnectionConfig(url),
    (identity) => {
      try {
        requireApprovedReplayTarget(url, identity, branch);
      } catch {
        // The guard's own message names the database host, which this command does not print.
        throw new ReviewListsRefusal("Refusing to run: REPLAY_DATABASE_URL is not the approved replay branch.");
      }
    },
    async (db) => {
      const workspace = await resolveWorkspaceContext(db as never);
      return buildReviewListsFromStore(db, {
        ...request,
        workspaceId: workspace.workspaceId,
        rules: REVIEW_LIST_RULES,
        leadDefinitionSql: loadLeadDefinitionSql(),
      });
    },
  );
  return { branch, result };
}

async function build(args: CommandArguments, env: NodeJS.ProcessEnv, dependencies: CommandDependencies): Promise<void> {
  const log = dependencies.log ?? console.log;
  const now = dependencies.now ?? new Date();
  if (!fs.existsSync(args.designPath)) throw new ReviewListsRefusal("The ranking design file does not exist.");
  const parsed = parseRankingDesign(fs.readFileSync(args.designPath, "utf8"));
  const design = args.seed ? { ...parsed, lists: { ...parsed.lists, seed: args.seed } } : parsed;
  requireApprovedDesign(design);
  const files = reviewListFiles(args.privateDir, args.name);
  requireWritable(files, args.replace);
  const rated = ratedIdsFromReviewFolder(files.directory, files.key);
  const { branch, result } = await (dependencies.read ?? readFromReplay)(
    { design, companyTags: await loadCompanyIndustryTags(), ratedIds: rated.ids },
    env,
  );

  const { lists } = result;
  const key = buildReviewKey(lists, {
    name: args.name,
    createdAt: now.toISOString(),
    seed: design.lists.seed,
    overallFromUnsavedOnly: design.lists.overall_from_unsaved_only,
  });
  fs.mkdirSync(files.directory, { recursive: true });
  fs.writeFileSync(files.sheet, renderReviewSheet(lists, design.lists.seed), "utf8");
  fs.writeFileSync(files.key, `${JSON.stringify(key, null, 2)}\n`, "utf8");
  // Sheet order, so line n of this file is row n of the sheet.
  fs.writeFileSync(files.jobIds, sheetJobs(lists, design.lists.seed).map((job) => `${job.id}\n`).join(""), "utf8");

  log(`branch=${branch} earlier key files=${rated.files} rated ids=${rated.ids.length}`);
  log(`employer override list: ${design.employer_override ? "approved" : "none in this design"}`);
  log(formatReviewSummary(result));
  log(`overall list from unsaved jobs only: ${design.lists.overall_from_unsaved_only}`);
  log(`wrote ${key.items.length} jobs: review_lists_{sheet,key,job_ids}_${args.name} under private/review/`);
}

function score(args: CommandArguments, log: (line: string) => void): void {
  const key = JSON.parse(fs.readFileSync(args.keyPath!, "utf8")) as ReviewKey;
  if (key.schema_version !== "review_lists_key_v1") throw new ReviewListsRefusal("The key file is not a review-lists key.");
  const result = scoreReviewSheet(fs.readFileSync(args.sheetPath!, "utf8"), key);
  const share = (value: { yes: number; counted: number }) =>
    `${value.yes}/${value.counted}${value.counted ? ` (${((100 * value.yes) / value.counted).toFixed(1)}%)` : ""}`;
  log(`result=${result.result}`);
  log(`overall yes=${share(result.overall)}`);
  log(`listed yes=${share(result.lists)}`);
  log(`comparison yes=${share(result.comparison)}`);
  for (const type of result.byRoleType) log(`${type.type} yes=${share(type)}`);
  log(`not counted: saved=${result.notCounted.saved} linkedin closed=${result.notCounted.linkedInClosed}`);
  log(`counted as not yes because closed=${result.otherClosed}`);
  if (result.blank.length) log(`unanswered rows: ${result.blank.join(", ")}`);
}

export async function runReviewListsCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: CommandDependencies = {},
): Promise<void> {
  const args = parseReviewListArguments(argv, dependencies.now ?? new Date());
  if (args.mode === "score") score(args, dependencies.log ?? console.log);
  else await build(args, env, dependencies);
}
