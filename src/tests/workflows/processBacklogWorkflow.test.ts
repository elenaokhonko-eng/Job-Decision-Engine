import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('process backlog workflow', () => {
  it('drains saved backlog without running source ingestion', () => {
    const workflow = readFileSync(resolve('.github/workflows/process_backlog.yml'), 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('- Job Discovery Ingestion');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('cancel-in-progress: true');
    expect(workflow).toContain("github.event.workflow_run.conclusion != 'cancelled'");
    expect(workflow).toContain('npx tsx scripts/process_pipeline_tasks.ts');
    expect(workflow).toContain('id: process_pipeline_worker');
    expect(workflow).toContain("PIPELINE_TASK_WORKER_STALE_PENDING_RECONCILIATION_LIMIT: ${{ vars.PIPELINE_TASK_WORKER_STALE_PENDING_RECONCILIATION_LIMIT || '100' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_STALE_PENDING_RECONCILIATION_BUDGET_MS: ${{ vars.PIPELINE_TASK_WORKER_STALE_PENDING_RECONCILIATION_BUDGET_MS || '10000' }}");
    expect(workflow).toContain('PIPELINE_TASK_WORKER_DEAD_LETTER_REPORT_FILE: pipeline-dead-letter-health.json');
    expect(workflow).toContain('pipeline-dead-letter-health-${{ github.run_id }}');
    expect(workflow).toContain('PIPELINE_DEAD_LETTERED_THIS_RUN: ${{ steps.process_pipeline_worker.outputs.dead_lettered_this_run }}');
    expect(workflow).toContain('DATABASE_URL_UNPOOLED: ${{ secrets.DATABASE_URL_UNPOOLED }}');
    expect(workflow).toContain('npx tsx scripts/reconcile_pipeline.ts --json > pipeline-reconciliation-before.json');
    expect(workflow).toContain('npx tsx scripts/reconcile_pipeline.ts --json > pipeline-reconciliation-after.json');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('timeout-minutes: 15');
    expect(workflow).toContain("if: ${{ always() && steps.database_migrations.outcome == 'success' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_MAX_TASKS: ${{ vars.PIPELINE_TASK_WORKER_MAX_TASKS || '2500' }}");
    expect(workflow).toContain('PIPELINE_TASK_WORKER_STAGE_MAX_TASKS');
    expect(workflow).toContain("PIPELINE_TASK_WORKER_STAGE_QUANTUM: ${{ vars.PIPELINE_TASK_WORKER_STAGE_QUANTUM || '1' }}");
    expect(workflow).toContain('PIPELINE_TASK_WORKER_RECONCILIATION_REPORT_FILE: pipeline-task-reconciliation.json');
    expect(workflow).toContain('pipeline-task-reconciliation-${{ github.run_id }}');
    expect(workflow).toContain("PIPELINE_TASK_WORKER_WALL_CLOCK_MS: ${{ vars.PIPELINE_TASK_WORKER_WALL_CLOCK_MS || '600000' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_MIN_TIME_TO_START_TASK_MS: ${{ vars.PIPELINE_TASK_WORKER_MIN_TIME_TO_START_TASK_MS || '120000' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_TASK_TYPES: ${{ vars.PIPELINE_TASK_WORKER_TASK_TYPES || '' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_SEED: ${{ vars.PIPELINE_TASK_WORKER_SEED || 'true' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_INCLUDE_ROUTING_DEFERRED: ${{ vars.PIPELINE_TASK_WORKER_INCLUDE_ROUTING_DEFERRED || 'true' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_ROUTING_DEFERRED_REPLAY_VERSION: ${{ vars.PIPELINE_TASK_WORKER_ROUTING_DEFERRED_REPLAY_VERSION || 'routing_deferred_replay_v1' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_SHUTDOWN_GRACE_MS: ${{ vars.PIPELINE_TASK_WORKER_SHUTDOWN_GRACE_MS || '60000' }}");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE: ${{ vars.PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE || '200' }}");
    const gmailCleanupStep = workflow.split("name: Reconcile terminal Gmail job alerts")[1] ?? "";
    expect(gmailCleanupStep.slice(0, 220)).toContain("timeout-minutes: 20");
    expect(gmailCleanupStep).toContain("GMAIL_RECONCILIATION_LIMIT: ${{ vars.GMAIL_RECONCILIATION_LIMIT || '2000' }}");
    expect(workflow).toContain("timeout-minutes: 55");
    expect(workflow).toContain('PIPELINE_TASK_WORKER_WALL_CLOCK_MS');
    expect(workflow).toContain("PIPELINE_TASK_WORKER_EXIT_ON_RETRY_WAIT: 'false'");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_INCLUDE_TEST_FIXTURES: 'false'");
    expect(workflow).toContain('scripts/report_pipeline_status.ts');
    expect(workflow).not.toContain('scripts/ingest_gmail.ts');
    expect(workflow).not.toContain('scripts/run_adapters.ts');
    expect(workflow).not.toContain('scripts/parse_emails.ts');
  });

  it('shares a non-canceling concurrency group with discovery ingestion', () => {
    const backlog = readFileSync(resolve('.github/workflows/process_backlog.yml'), 'utf8');
    const ingestion = readFileSync(resolve('.github/workflows/ingest.yml'), 'utf8');

    expect(backlog).toContain('group: job-decision-pipeline');
    expect(ingestion).toContain('group: job-decision-pipeline');
    expect(ingestion).toContain('cancel-in-progress: false');
    expect(ingestion).not.toContain('cancel-in-progress: true');
  });

  it('keeps deterministic extraction and hard gates before quoted requirements and downstream work', () => {
    const worker = readFileSync(resolve('src/tasks/stageTaskWorker.ts'), 'utf8');

    const normalization = worker.indexOf('"NORMALIZE_OBSERVATION"');
    const deterministicRequirements = worker.indexOf('"EXTRACT_DETERMINISTIC_REQUIREMENTS"');
    const hardGates = worker.indexOf('"APPLY_HARD_GATES"');
    const quotedRequirements = worker.indexOf('"EXTRACT_QUOTED_REQUIREMENTS"');
    const embeddings = worker.indexOf('"PUBLISH_EMBEDDING"');
    const laneRouting = worker.indexOf('"ROUTE_LANE"');

    expect(normalization).toBeGreaterThanOrEqual(0);
    expect(deterministicRequirements).toBeGreaterThan(normalization);
    expect(hardGates).toBeGreaterThan(deterministicRequirements);
    expect(quotedRequirements).toBeGreaterThan(hardGates);
    expect(embeddings).toBeGreaterThan(quotedRequirements);
    expect(laneRouting).toBeGreaterThan(embeddings);
  });

  it('requeues matching when the active profile version changed', () => {
    const worker = readFileSync(resolve('src/tasks/stageTaskWorker.ts'), 'utf8');

    expect(worker).toContain("active_profile.id AS profile_version_id");
    expect(worker).toContain("FROM match_runs mr");
    expect(worker).toContain("mr.profile_version_id = active_profile.id");
    expect(worker).toContain(":profile:");
    expect(worker).toContain("target_jv.active_requirement_set_id");
    expect(worker).toContain("repair_existing_state");
    expect(worker).toContain("blockPipelineTask");
    expect(worker).toContain("PipelineTaskDependencyBlockedError");
  });

  it('uses a serialized worker entrypoint with strict retry mode and production SLO gates', () => {
    const script = readFileSync(resolve('scripts/process_pipeline_tasks.ts'), 'utf8');

    expect(script).toContain('pg_try_advisory_lock');
    expect(script).toContain('DATABASE_URL_UNPOOLED');
    expect(script).toContain('isPooledPostgresConnectionString');
    expect(script).toContain('EXTRACT_QUOTED_REQUIREMENTS" ? 1002 : LOCK_ID');
    expect(script).toContain('runPipelineStageTaskWorker');
    expect(script).toContain('process.once("SIGINT"');
    expect(script).toContain('process.once("SIGTERM"');
    expect(script).toContain('abortSignal: shutdownController.signal');
    expect(script).toContain('PIPELINE_TASK_WORKER_SHUTDOWN_GRACE_MS');
    expect(script).toContain('enforcePipelineWorkerExitPolicy');
    expect(script).toContain('reconcileStaleSupersededEmbeddingDeadLetters');
    expect(script).toContain('actionableCurrentDeadLetter');
    expect(script).toContain('staleHistoricalDeadLetter');
    expect(script).toContain('dead_lettered_this_run=${summary.deadLettered}');
    expect(script).toContain('successor_tasks_created_this_run=${summary.successorTasksCreated}');
    expect(script).toContain('stale_pending_reconciled_this_run=${summary.stalePendingReconciliation.stalePendingReconciledThisRun}');
    expect(script).toContain('by_reason: reconciliationReport.byReason');
    expect(script).toContain('by_task_type: reconciliationReport.byTaskType');
    expect(script).toContain('net_active_pending_delta=${activePending - activePendingBefore}');
    expect(script).toContain('PIPELINE_TASK_WORKER_RECONCILIATION_REPORT_FILE');
    expect(script).toContain('PIPELINE_TASK_WORKER_MAX_RETRY_WAIT_COUNT');
    expect(script).toContain('PIPELINE_TASK_WORKER_MAX_PENDING_AGE_SECONDS');
    expect(script).toContain('process.exitCode = workerError instanceof PipelineWorkerCancelledError ? 130 : 1');
  });
});
