/**
 * Adds posted dates and open/closed status to LinkedIn saved jobs that are
 * already imported, from a re-exported linkedin_saved_jobs.json.
 *
 *   npm run enrich:linkedin-saved -- <path/to/linkedin_saved_jobs.json>            (dry run)
 *   npm run enrich:linkedin-saved -- <path/to/linkedin_saved_jobs.json> --apply
 *
 * Produce the file with scripts/linkedin/export_saved_jobs.console.js (its
 * `refresh()` re-reads every saved job's posting page). This command never
 * contacts LinkedIn. It keeps each job's stored title, employer and description
 * and stages only the posting facts, as a new observation through the saved-jobs
 * importer; with --apply it then normalizes those observations onto their job
 * versions and recomputes readiness. Without --apply nothing is written. It
 * exits non-zero when an item is invalid or any step fails.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { loadStructuredFile } from "../src/config/structuredLoader.js";
import { SourcePluginSchema } from "../src/contracts/index.js";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { LinkedInSavedExportFileError } from "../src/ingestion/linkedInSavedExport.js";
import {
  linkedInSavedEnrichmentExitCode,
  planLinkedInSavedEnrichment,
  runLinkedInSavedEnrichment,
  type LinkedInSavedEnrichmentReport,
} from "../src/ingestion/linkedInSavedEnrichment.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

export interface EnrichLinkedInSavedArguments {
  readonly filePath: string;
  readonly apply: boolean;
  readonly workspaceKey?: string;
  readonly userKey?: string;
}

export function parseEnrichLinkedInSavedArguments(argv: readonly string[]): EnrichLinkedInSavedArguments {
  let filePath: string | null = null;
  let apply = false;
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--dry-run") {
      apply = false;
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
    throw new Error("Usage: npm run enrich:linkedin-saved -- <path/to/linkedin_saved_jobs.json> [--apply] [--workspace-key KEY] [--user-key KEY]");
  }
  return {
    filePath,
    apply,
    ...(values["workspace-key"] ? { workspaceKey: values["workspace-key"] } : {}),
    ...(values["user-key"] ? { userKey: values["user-key"] } : {}),
  };
}

/** Counts and per-item outcomes only: no titles, employers, descriptions or connection details. */
export function formatLinkedInSavedEnrichmentReport(report: LinkedInSavedEnrichmentReport): string {
  const t = report.totals;
  const lines = [
    `LinkedIn saved-jobs posting-facts enrichment (${report.mode === "DRY_RUN" ? "dry run, nothing written; add --apply to write" : "applied"})`,
    `  ${report.mode === "DRY_RUN" ? "would stage" : "staged"}: ${report.mode === "DRY_RUN" ? t.WOULD_STAGE : t.STAGED}; already enriched: ${t.ALREADY_ENRICHED}; no posting facts: ${t.NO_POSTING_FACTS}; not previously imported: ${t.NOT_PREVIOUSLY_IMPORTED}; invalid: ${t.INVALID}; failed: ${t.FAILED}`,
  ];
  const withFacts = report.items.filter((item) => item.outcome === "WOULD_STAGE" || item.outcome === "STAGED" || item.outcome === "ALREADY_ENRICHED");
  const count = (predicate: (item: (typeof withFacts)[number]) => boolean) => withFacts.filter(predicate).length;
  lines.push(`  posted date: absolute ${count((item) => item.facts.published === "ABSOLUTE_SOURCE_DATE")}, from age text ${count((item) => item.facts.published === "RELATIVE_SOURCE_TEXT")}; repost date ${count((item) => item.facts.reposted !== null)}; deadline ${count((item) => item.facts.expires)}`);
  lines.push(`  status: open ${count((item) => item.facts.availability === "OPEN")}, closed ${count((item) => item.facts.availability === "CLOSED")}, unknown ${count((item) => item.facts.availability === "UNKNOWN")}; stored description kept where the file's differs: ${count((item) => item.descriptionDiffers)}`);
  if (report.mode === "APPLIED") {
    lines.push(`  normalized: ${report.normalized} (errors ${report.normalizationErrors}); readiness recomputed: ${report.decisionsRun} (errors ${report.decisionErrors})`);
    const readiness = report.items.filter((item) => item.readiness);
    const status = (key: "availability" | "freshness", value: string) => readiness.filter((item) => item.readiness?.[key] === value).length;
    lines.push(`  readiness AVAILABILITY: MET ${status("availability", "MET")}, BLOCKED ${status("availability", "BLOCKED")}, NEEDS_VERIFICATION ${status("availability", "NEEDS_VERIFICATION")}; FRESHNESS: MET ${status("freshness", "MET")}, BLOCKED ${status("freshness", "BLOCKED")}, NEEDS_VERIFICATION ${status("freshness", "NEEDS_VERIFICATION")}`);
    if (report.importReport?.normalizeSeedError) lines.push(`  ERROR normalization seeding: ${report.importReport.normalizeSeedError}`);
  }
  for (const item of report.items) {
    const facts = `posted=${item.facts.published ?? item.facts.reposted ?? "unknown"} status=${item.facts.availability}${item.facts.expires ? " deadline" : ""}`;
    const readiness = item.readiness ? `; readiness availability=${item.readiness.availability ?? "-"} freshness=${item.readiness.freshness ?? "-"}` : "";
    lines.push(`  item ${item.index} job ${item.linkedInJobId ?? "?"}: ${item.outcome}; ${facts}${readiness}${item.reason ? `; ${item.reason}` : ""}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  dotenv.config();
  dotenv.config({ path: ".env.local" });
  const args = parseEnrichLinkedInSavedArguments(process.argv.slice(2));
  const absolutePath = path.resolve(process.cwd(), args.filePath);
  if (!fs.existsSync(absolutePath)) throw new LinkedInSavedExportFileError(`Export file not found: ${args.filePath}`);
  const text = fs.readFileSync(absolutePath, "utf8");
  let document: unknown;
  try {
    document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new LinkedInSavedExportFileError(`The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

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
      const plan = await planLinkedInSavedEnrichment(client, context, document);
      const report = await runLinkedInSavedEnrichment(client, context, plan, { dryRun: !args.apply, plugin });
      console.log(formatLinkedInSavedEnrichmentReport(report));
      const exitCode = linkedInSavedEnrichmentExitCode(report);
      if (exitCode !== 0) console.error("LinkedIn saved-jobs enrichment finished with invalid or failed items; see the lines above.");
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
      console.error("enrich_linkedin_saved failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
