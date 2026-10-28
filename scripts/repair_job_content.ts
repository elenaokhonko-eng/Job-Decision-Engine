import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { enqueuePipelineTask } from "../src/tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import { classifyDescriptionQuality, sourceContentEvidencePredicate } from "../src/pipeline/descriptionQuality.js";

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

interface RepairCandidate {
  observation_id: string;
  canonical_job_id: string | null;
  latest_job_version_id: string | null;
  processing_state: string | null;
  source_url: string;
  company_name: string;
  title: string;
  description_length: number;
  current_description: string | null;
  description_quality_status: string | null;
  raw_email_alert_id: string | null;
  gmail_message_id: string | null;
  observation_status: string | null;
  has_source_content_evidence: boolean;
  is_test_fixture: boolean;
  has_application: boolean;
  has_documents: boolean;
  has_active_pipeline_task: boolean;
  has_active_evaluation: boolean;
}

async function loadCandidate(
  client: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
  args: RepairJobContentArguments,
  lockObservation = false,
): Promise<RepairCandidate | null> {
  const selector = args.observationId
    ? "observation.id = $2::uuid"
    : "canonical.id = $2::uuid";
  const result = await client.query<RepairCandidate>(
    `SELECT observation.id::text AS observation_id,
            canonical.id::text AS canonical_job_id,
            canonical.latest_job_version_id::text AS latest_job_version_id,
            COALESCE(canonical.processing_state, canonical.processing_status) AS processing_state,
            observation.source_url,
            observation.company_name,
            observation.title,
            LENGTH(COALESCE(observation.description_raw, '')) AS description_length,
            current_version.description_text AS current_description,
            canonical.description_quality_status,
            observation.raw_email_alert_id::text AS raw_email_alert_id,
            observation.gmail_message_id,
            observation.processing_status AS observation_status,
            ${sourceContentEvidencePredicate("current_version.workspace_id", "current_version.id")} AS has_source_content_evidence,
            COALESCE(canonical.is_test_fixture, FALSE) AS is_test_fixture,
            EXISTS (
              SELECT 1 FROM application_records application
              WHERE application.workspace_id = observation.workspace_id
                AND application.canonical_job_id = canonical.id
            ) AS has_application,
            EXISTS (
              SELECT 1 FROM document_runs document
              WHERE document.canonical_job_id = canonical.id
            ) AS has_documents,
            EXISTS (
              SELECT 1 FROM pipeline_tasks task
              WHERE task.workspace_id = observation.workspace_id
                AND task.status = 'RUNNING'
                AND (
                  task.payload->>'observation_id' = observation.id::text
                  OR task.payload->>'job_version_id' = current_version.id::text
                )
            ) AS has_active_pipeline_task,
            EXISTS (
              SELECT 1 FROM evaluation_queue evaluation
              WHERE evaluation.workspace_id = observation.workspace_id
                AND evaluation.job_version_id = current_version.id
                AND evaluation.status = 'EVALUATING'
            ) AS has_active_evaluation
     FROM raw_job_observations observation
     LEFT JOIN job_versions observed_version
       ON observed_version.workspace_id = observation.workspace_id
      AND observed_version.id = observation.job_version_id
     LEFT JOIN canonical_jobs canonical
       ON canonical.workspace_id = observed_version.workspace_id
      AND canonical.id = observed_version.canonical_job_id
     LEFT JOIN job_versions current_version
       ON current_version.workspace_id = canonical.workspace_id
      AND current_version.id = canonical.latest_job_version_id
     WHERE observation.workspace_id = $1
       AND observation.source_name = 'GMAIL_ALERT'
       AND NULLIF(BTRIM(observation.source_url), '') IS NOT NULL
       AND ${selector}
     ORDER BY (observation.job_version_id = canonical.latest_job_version_id) DESC NULLS LAST,
              LENGTH(COALESCE(observation.description_raw, '')) ASC,
              observation.retrieved_at DESC,
              observation.id ASC
     LIMIT 1
     ${lockObservation ? "FOR UPDATE OF observation" : ""}`,
    [context.workspaceId, args.observationId ?? args.canonicalJobId],
  );
  return result.rows[0] ?? null;
}

function currentQuality(candidate: RepairCandidate): ReturnType<typeof classifyDescriptionQuality> {
  return classifyDescriptionQuality(candidate.current_description ?? "");
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
      const candidate = await loadCandidate(client, context, args);
      if (!candidate) throw new Error("No Gmail discovery observation with a posting URL matched this target.");
      const quality = currentQuality(candidate);
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
      const candidate = await loadCandidate(client, context, args, true);
      if (!candidate) throw new Error("No Gmail discovery observation with a posting URL matched this target.");
      if (candidate.processing_state === "MANUALLY_REMOVED") {
        throw new Error("Manual removal protects this job from automatic source repair.");
      }
      if (candidate.is_test_fixture) throw new Error("Test fixtures cannot be repaired from live source URLs.");
      if (candidate.has_application || candidate.has_documents) {
        throw new Error("Existing application or document history protects this job from automatic source repair.");
      }
      if (candidate.has_active_pipeline_task || candidate.has_active_evaluation) {
        throw new Error("An active pipeline or AI evaluation lease protects this job from source repair.");
      }
      const quality = currentQuality(candidate);
      if (!args.forceRefetch && quality.status === "COMPLETE" && candidate.has_source_content_evidence) {
        throw new Error("The current canonical posting is already complete; pass --force-refetch to refresh it.");
      }

      const activeTasks = await client.query(
        `SELECT id
         FROM pipeline_tasks
         WHERE workspace_id = $1
           AND task_type = 'FETCH_JOB_CONTENT'
           AND payload->>'observation_id' = $2
           AND status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
         LIMIT 1
         FOR UPDATE`,
        [context.workspaceId, candidate.observation_id],
      );
      if (activeTasks.rows.length > 0) throw new Error("A posting fetch task is already active for this observation.");

      if (candidate.latest_job_version_id) {
        const activeAssessment = await client.query(
          `SELECT id
           FROM pipeline_tasks
           WHERE workspace_id = $1
             AND payload->>'job_version_id' = $2
             AND status = 'RUNNING'
           LIMIT 1`,
          [context.workspaceId, candidate.latest_job_version_id],
        );
        if (activeAssessment.rows.length > 0) {
          throw new Error("An assessment task is currently running for this canonical version.");
        }
      }

      await client.query(
        `UPDATE raw_job_observations
         SET processing_status = 'FETCH_PENDING'
         WHERE workspace_id = $1 AND id = $2::uuid AND source_name = 'GMAIL_ALERT'`,
        [context.workspaceId, candidate.observation_id],
      );
      if (candidate.raw_email_alert_id) {
        await client.query(
          `UPDATE raw_email_alerts
           SET lifecycle_status = 'SOURCE_PENDING', last_error = NULL
           WHERE workspace_id = $1 AND id = $2::uuid`,
          [context.workspaceId, candidate.raw_email_alert_id],
        );
      } else if (candidate.gmail_message_id) {
        await client.query(
          `UPDATE raw_email_alerts
           SET lifecycle_status = 'SOURCE_PENDING', last_error = NULL
           WHERE workspace_id = $1 AND gmail_message_id = $2`,
          [context.workspaceId, candidate.gmail_message_id],
        );
      }

      const taskKey = `FETCH_JOB_CONTENT:${candidate.observation_id}:posting_fetch_v1:repair:${crypto.randomUUID()}`;
      const task = await enqueuePipelineTask({
        taskType: "FETCH_JOB_CONTENT",
        taskKey,
        payload: { observation_id: candidate.observation_id, force_refetch: true },
        maxAttempts: 8,
        producer: "repair_job_content",
        stageVersion: "posting_fetch_v1",
        requestId: taskKey,
      }, client, { context });
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
