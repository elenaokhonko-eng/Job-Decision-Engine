import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("evaluation queue workflow", () => {
  it("does not cancel an active leased evaluation drain", () => {
    const workflow = readFileSync(resolve(".github/workflows/queue_worker.yml"), "utf8");

    expect(workflow).toContain("group: evaluation-queue-worker");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("cancel-in-progress: true");
    expect(workflow).toContain("npx tsx scripts/evaluate_queue.ts");
    expect(workflow).toContain("DATABASE_URL_UNPOOLED: ${{ secrets.DATABASE_URL_UNPOOLED }}");
    expect(workflow).toContain("npx tsx scripts/preflight_database.ts");
    expect(workflow).toContain('EVALUATION_EXIT_ON_RETRY_WAIT: "false"');
    expect(workflow).toContain('EVALUATION_EXIT_ON_RETRY_WAIT: "false"');
  });

  it("keeps recoverable retries green while fatal queue failures remain non-zero", () => {
    const script = readFileSync(resolve("scripts/evaluate_queue.ts"), "utf8");
    const exitPolicy = readFileSync(resolve("src/pipeline/evaluationQueueExitPolicy.ts"), "utf8");

    expect(script).toContain('process.env.EVALUATION_EXIT_ON_RETRY_WAIT !== "false"');
    expect(script).toContain('runEvaluationQueueWithExitPolicy(evaluateQueue, exitOnRetryWait)');
    expect(script).toContain('process.exit(1)');
    expect(exitPolicy).toContain('stats.failed > 0 && exitOnRetryWait ? 1 : 0');
  });

  it("requires queue context to match the current deterministic artifacts", () => {
    const script = readFileSync(resolve("scripts/evaluate_queue.ts"), "utf8");

    expect(script).toContain("dd.context_fingerprint = eq.context_fingerprint");
    expect(script).toContain("mr.canonical_job_id = eq.canonical_job_id");
    expect(script).toContain("mr.job_content_hash = jv.content_hash");
    expect(script).toContain("eq.context_fingerprint IS NOT NULL");
  });
});
