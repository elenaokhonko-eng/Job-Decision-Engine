/**
 * Imports a LinkedIn saved-jobs export (linkedin_saved_jobs.json) into the
 * canonical pipeline as LINKEDIN_SAVED observations.
 *
 *   npm run import:linkedin-saved -- <path/to/linkedin_saved_jobs.json> --dry-run
 *   npm run import:linkedin-saved -- <path/to/linkedin_saved_jobs.json>
 *
 * The file is produced by the user in their own browser with
 * scripts/linkedin/export_saved_jobs.console.js. This command never contacts
 * LinkedIn. It exits non-zero when the file is unreadable, any item is invalid,
 * or any valid item fails to stage (the valid items are still staged).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { loadStructuredFile } from "../src/config/structuredLoader.js";
import { SourcePluginSchema } from "../src/contracts/index.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import {
  LinkedInSavedExportFileError,
  parseLinkedInSavedExportText,
} from "../src/ingestion/linkedInSavedExport.js";
import {
  importLinkedInSavedJobs,
  linkedInSavedImportExitCode,
  type LinkedInSavedImportReport,
} from "../src/ingestion/linkedInSavedImport.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

export interface ImportLinkedInSavedArguments {
  readonly filePath: string;
  readonly dryRun: boolean;
  readonly workspaceKey?: string;
  readonly userKey?: string;
}

export function parseImportLinkedInSavedArguments(argv: readonly string[]): ImportLinkedInSavedArguments {
  let filePath: string | null = null;
  let dryRun = false;
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--workspace-key" || argument === "--user-key") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      values[argument.slice(2)] = value.trim();
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unsupported argument: ${argument}`);
    if (filePath) throw new Error("Provide exactly one export file path.");
    filePath = argument;
  }
  if (!filePath) {
    throw new Error("Usage: npm run import:linkedin-saved -- <path/to/linkedin_saved_jobs.json> [--dry-run] [--workspace-key KEY] [--user-key KEY]");
  }
  return {
    filePath,
    dryRun,
    ...(values["workspace-key"] ? { workspaceKey: values["workspace-key"] } : {}),
    ...(values["user-key"] ? { userKey: values["user-key"] } : {}),
  };
}

/** Counts and per-item outcomes only: no descriptions, cookies or connection details. */
export function formatLinkedInSavedImportReport(report: LinkedInSavedImportReport): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push(`LinkedIn saved-jobs import (${report.mode === "DRY_RUN" ? "dry run, nothing written" : "applied"})`);
  lines.push(`  items in file: ${t.items}; valid: ${t.valid}; invalid: ${t.invalid}; duplicates in file: ${t.duplicatesInFile}`);
  lines.push(`  ${report.mode === "DRY_RUN" ? "would stage" : "staged"}: ${t.staged}; already imported: ${t.alreadyImported}; failed: ${t.failed}`);
  lines.push(`  matching Gmail LinkedIn alert cards: ${t.gmailMatches}; content ${report.mode === "DRY_RUN" ? "would be attached" : "attach queued"}: ${t.contentAttachQueued}; already had content: ${t.gmailAlreadyComplete}; not attachable: ${t.gmailUnusable}`);
  lines.push(`  saved jobs whose LinkedIn URL already has a canonical job: ${t.existingCanonicalJobs}`);
  if (report.mode === "APPLIED") {
    lines.push(`  fetch tasks reactivated: ${t.fetchTasksReactivated}; fetch tasks enqueued: ${t.fetchTasksEnqueued}`);
    lines.push(`  normalization tasks seeded: ${t.normalizeTasksSeeded}; already queued: ${t.normalizeTasksAlreadyQueued}; left for the worker: ${t.normalizeSeedDeferred}`);
    if (report.normalizeSeedError) lines.push(`  ERROR normalization seeding: ${report.normalizeSeedError}`);
  }
  for (const invalid of report.invalid) lines.push(`  INVALID item ${invalid.index}: ${invalid.reason}`);
  for (const duplicate of report.duplicatesInFile) {
    lines.push(`  DUPLICATE item ${duplicate.index}: LinkedIn job ${duplicate.linkedInJobId} repeats item ${duplicate.firstIndex}; staged once`);
  }
  for (const item of report.items) {
    const matches = item.gmailMatches.length === 0
      ? "no Gmail alert match"
      : item.gmailMatches.map((match) => `${match.observationId.slice(0, 8)}:${match.outcome}`).join(", ");
    lines.push(`  item ${item.index} job ${item.linkedInJobId}: ${item.outcome}; description ${item.descriptionQuality}; ${matches}${item.error ? `; ERROR ${item.error}` : ""}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  dotenv.config();
  dotenv.config({ path: ".env.local" });
  const args = parseImportLinkedInSavedArguments(process.argv.slice(2));
  const absolutePath = path.resolve(process.cwd(), args.filePath);
  if (!fs.existsSync(absolutePath)) throw new LinkedInSavedExportFileError(`Export file not found: ${args.filePath}`);
  const parsed = parseLinkedInSavedExportText(fs.readFileSync(absolutePath, "utf8"));

  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const plugin = (await loadStructuredFile(
    path.resolve(process.cwd(), "config", "source-plugins", "linkedin_saved.yml"),
    SourcePluginSchema,
  )).data;

  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  try {
    const client = await pool.connect();
    try {
      const context = await resolveWorkspaceContext(client, {
        ...(args.workspaceKey ? { workspaceKey: args.workspaceKey } : {}),
        ...(args.userKey ? { userKey: args.userKey } : {}),
      });
      const report = await importLinkedInSavedJobs(client, context, parsed, { dryRun: args.dryRun, plugin });
      console.log(formatLinkedInSavedImportReport(report));
      const exitCode = linkedInSavedImportExitCode(report);
      if (exitCode !== 0) console.error("LinkedIn saved-jobs import finished with invalid or failed items; see the lines above.");
      return exitCode;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error("import_linkedin_saved failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
