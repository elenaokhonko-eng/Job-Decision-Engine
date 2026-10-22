import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("discovery ingestion workflow", () => {
  it("drains available pipeline work when discovery runs and surfaces upstream source failures", () => {
    const workflow = readFileSync(resolve(".github/workflows/ingest.yml"), "utf8");

    expect(workflow).toContain("needs: [gmail_ingestion, public_source_ingestion]");
    expect(workflow).toContain("needs.gmail_ingestion.result == 'success' || needs.public_source_ingestion.result == 'success'");
    expect(workflow).toContain("Check ingestion completeness");
    expect(workflow).toContain("needs.gmail_ingestion.result != 'success' || needs.public_source_ingestion.result != 'success'");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_EXIT_ON_RETRY_WAIT: 'false'");
    expect(workflow).toContain("PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE: ${{ vars.PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE || '200' }}");
    const gmailCleanupStep = workflow.split("name: Reconcile terminal Gmail job alerts")[1] ?? "";
    expect(gmailCleanupStep.slice(0, 220)).toContain("timeout-minutes: 20");
    expect(gmailCleanupStep).toContain("GMAIL_RECONCILIATION_LIMIT: ${{ vars.GMAIL_RECONCILIATION_LIMIT || '2000' }}");
    expect(workflow).toContain("timeout-minutes: 60");
    expect(workflow).toContain('PIPELINE_TASK_WORKER_STAGE_MAX_TASKS');
    expect(workflow).toContain('id: process_pipeline_worker');
    expect(workflow).toContain('PIPELINE_TASK_WORKER_DEAD_LETTER_REPORT_FILE: pipeline-dead-letter-health.json');
    expect(workflow).toContain('pipeline-dead-letter-health-ingestion-${{ github.run_id }}');
    expect(workflow).toContain('scripts/report_pipeline_status.ts');
  });
});
