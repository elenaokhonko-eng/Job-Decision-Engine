import {
  parseRepairJobContentArguments,
  repairJobContent,
} from "./repair_job_content.js";

/**
 * Compatibility entry point for the old source-enrichment command.
 * All retrieval now uses the shared, bounded FETCH_JOB_CONTENT worker path.
 * This command is deliberately scoped and dry-run by default, like the new CLI.
 */
export async function runIncompleteDescriptionEnrichmentCommand(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  console.warn(
    "source:enrich-incomplete now delegates to the scoped posting repair. " +
    "Provide --workspace-key and exactly one of --observation-id or --canonical-job-id.",
  );
  await repairJobContent(parseRepairJobContentArguments(argv));
}

if (process.argv[1]?.includes("enrich_incomplete_descriptions")) {
  runIncompleteDescriptionEnrichmentCommand().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
