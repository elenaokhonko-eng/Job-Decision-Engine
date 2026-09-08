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
    expect(workflow).toContain('npx tsx scripts/process_pipeline_tasks.ts');
    expect(workflow).toContain('PIPELINE_TASK_WORKER_WALL_CLOCK_MS');
    expect(workflow).toContain('PIPELINE_TASK_WORKER_EXIT_ON_RETRY_WAIT');
    expect(workflow).not.toContain('scripts/ingest_gmail.ts');
    expect(workflow).not.toContain('scripts/run_adapters.ts');
    expect(workflow).not.toContain('scripts/parse_emails.ts');
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

  it('uses a serialized worker entrypoint that fails loudly on retryable stage errors', () => {
    const script = readFileSync(resolve('scripts/process_pipeline_tasks.ts'), 'utf8');

    expect(script).toContain('pg_try_advisory_lock');
    expect(script).toContain('runPipelineStageTaskWorker');
    expect(script).toContain('Pipeline task worker moved');
    expect(script).toContain('process.exitCode = 1');
  });
});
