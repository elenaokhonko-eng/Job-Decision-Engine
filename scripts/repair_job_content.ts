import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import {
  currentDescriptionQuality,
  enqueueJobContentRefetch,
  loadJobContentRepairCandidate,
  type JobContentRepairTarget,
} from "../src/services/jobContentRepair.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RepairJobContentArguments {
  readonly workspaceKey: string;
  readonly userKey?: string;
  readonly observationId?: string;
  readonly canonicalJobId?: string;
  readonly apply: boolean;
  readonly forceRefetch: boolean;
}

export function parseRepairJobContentArguments(argv: readonly string[]): RepairJobContentArguments {
  const values: Record<string, string> = {};
  let apply = false;
  let forceRefetch = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--force-refetch") {
      forceRefetch = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${argument ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    const key = argument.slice(2);
    if (!["workspace-key", "user-key", "observation-id", "canonical-job-id"].includes(key)) {
      throw new Error(`Unsupported argument: ${argument}`);
    }
    if (values[key]) throw new Error(`${argument} may only be provided once.`);
    values[key] = value;
    index += 1;
  }

  const workspaceKey = values["workspace-key"]?.trim();
  const observationId = values["observation-id"]?.trim();
  const canonicalJobId = values["canonical-job-id"]?.trim();
  if (!workspaceKey) throw new Error("--workspace-key is required to scope the repair.");
  if (Boolean(observationId) === Boolean(canonicalJobId)) {
    throw new Error("Provide exactly one of --observation-id or --canonical-job-id.");
  }
  if (observationId && !UUID_PATTERN.test(observationId)) throw new Error("--observation-id must be a UUID.");
  if (canonicalJobId && !UUID_PATTERN.test(canonicalJobId)) throw new Error("--canonical-job-id must be a UUID.");
  return {
    workspaceKey,
    ...(values["user-key"] ? { userKey: values["user-key"].trim() } : {}),
    ...(observationId ? { observationId } : {}),
    ...(canonicalJobId ? { canonicalJobId } : {}),
    apply,
    forceRefetch,
  };
}

function repairTarget(args: RepairJobContentArguments): JobContentRepairTarget {
  return args.observationId ? { observationId: args.observationId } : { canonicalJobId: args.canonicalJobId };
}

export function buildResumeCommand(observationId: string): string {
  const taskTypes = [
    "FETCH_JOB_CONTENT",
    "NORMALIZE_OBSERVATION",
    "EXTRACT_DETERMINISTIC_REQUIREMENTS",
    "APPLY_HARD_GATES",
  ].join(",");
  return [
    `$env:PIPELINE_TASK_WORKER_TASK_TYPES='${taskTypes}'`,
    `$env:PIPELINE_TASK_WORKER_OBSERVATION_IDS='${observationId}'`,
    "$env:PIPELINE_TASK_WORKER_MAX_TASKS='4'",
    "$env:PIPELINE_TASK_WORKER_SEED='false'",
    "npm run pipeline:worker",
  ].join("; ");
}

export function buildRepairJobContentCommands(workspaceKey: string, observationId: string): {
  dryRun: string;
  enqueue: string;
} {
  const escapedWorkspaceKey = workspaceKey.replace(/'/g, "''");
  const command = [
    "npm run pipeline:repair-content --",
    `--workspace-key '${escapedWorkspaceKey}'`,
    `--observation-id '${observationId}'`,
  ].join(" ");
  return { dryRun: command, enqueue: `${command} --apply` };
}

export async function repairJobContent(args: RepairJobContentArguments): Promise<void> {
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    const context = await resolveWorkspaceContext(client as any, {
      workspaceKey: args.workspaceKey,
      ...(args.userKey ? { userKey: args.userKey } : {}),
    });
    if (args.apply && context.role !== "OWNER") {
      throw new Error("Applying a source repair requires an OWNER workspace membership.");
    }
    if (!args.apply) {
      const candidate = await loadJobContentRepairCandidate(client, context, repairTarget(args));
      if (!candidate) throw new Error("No Gmail discovery observation with a posting URL matched this target.");
      const quality = currentDescriptionQuality(candidate);
      const commands = buildRepairJobContentCommands(context.workspaceKey, candidate.observation_id);
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        workspaceKey: context.workspaceKey,
        canonicalJobId: candidate.canonical_job_id,
        observationId: candidate.observation_id,
        title: candidate.title,
        company: candidate.company_name,
        discoveryDescriptionLength: candidate.description_length,
        currentVersionId: candidate.latest_job_version_id,
        currentDescriptionQuality: candidate.description_quality_status ?? quality.status,
        currentDescriptionLength: candidate.current_description?.length ?? null,
        observationStatus: candidate.observation_status,
        protectedContext: {
          isTestFixture: candidate.is_test_fixture,
          hasApplication: candidate.has_application,
          hasDocuments: candidate.has_documents,
          hasActivePipelineTask: candidate.has_active_pipeline_task,
          hasActiveEvaluation: candidate.has_active_evaluation,
        },
        sourceHost: safeHostname(candidate.source_url),
        hasSourceContentEvidence: candidate.has_source_content_evidence,
        wouldEnqueue: args.forceRefetch || quality.status !== "COMPLETE" || !candidate.has_source_content_evidence,
        dryRunCommand: commands.dryRun,
        enqueueCommand: commands.enqueue,
        applyFlagRequired: true,
      }, null, 2));
      return;
    }

    await client.query("BEGIN");
    try {
      const { candidate, taskId, inserted } = await enqueueJobContentRefetch(client, context, repairTarget(args), {
        forceRefetch: args.forceRefetch,
        producer: "repair_job_content",
      });
      const task = { taskId, inserted };
      await client.query("COMMIT");
      const commands = buildRepairJobContentCommands(context.workspaceKey, candidate.observation_id);
      console.log(JSON.stringify({
        mode: "ENQUEUED",
        workspaceKey: context.workspaceKey,
        canonicalJobId: candidate.canonical_job_id,
        observationId: candidate.observation_id,
        taskId: task.taskId,
        inserted: task.inserted,
        dryRunCommand: commands.dryRun,
        enqueueCommand: commands.enqueue,
        resumeCommand: buildResumeCommand(candidate.observation_id),
      }, null, 2));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client?.release();
    await pool.end();
  }
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "unparseable";
  }
}

if (process.argv[1]?.includes("repair_job_content")) {
  try {
    const args = parseRepairJobContentArguments(process.argv.slice(2));
    await repairJobContent(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
