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
    expect(script).toContain('process.exitCode = 1');
    expect(script).toContain('await closeEvaluationQueuePool();');
    expect(script).toContain('poolClosePromise = Promise.resolve().then(() => pool.end());');
    expect(script).toMatch(/finally\s*\{\s*client\.release\(\);\s*\}/);
    expect(script).not.toMatch(/finally\s*\{\s*client\.release\(\);\s*await pool\.end\(\);/);
    const reusableWorker = script.slice(
      script.indexOf('export async function evaluateQueue'),
      script.indexOf('export function closeEvaluationQueuePool')
    );
    expect(reusableWorker).toContain('client.release();');
    expect(reusableWorker).not.toContain('pool.end()');
    expect(script).toContain('void runEvaluationQueueCli().catch');
    const cliLifecycle = script.slice(
      script.indexOf('async function runEvaluationQueueCli'),
      script.indexOf('if (process.argv[1]')
    );
    expect(cliLifecycle).toContain('finally {');
    expect(cliLifecycle).toContain('await closeEvaluationQueuePool();');
    expect(cliLifecycle).toContain('process.exitCode = outcome.exitCode');
    expect(script).not.toContain('process.exit(');
    expect(exitPolicy).toContain('stats.failed > 0 && exitOnRetryWait ? 1 : 0');
  });

  it("supports explicit bounded profile-v6 queue filtering for staging smoke", () => {
    const script = readFileSync(resolve("scripts/evaluate_queue.ts"), "utf8");
    const lineage = readFileSync(resolve("src/pipeline/evaluationQueueLineage.ts"), "utf8");

    expect(script).toContain("options.profileVersionId");
    expect(script).toContain("jobVersionIds");
    expect(lineage).toContain("eq.job_version_id = ANY");
    expect(script).toContain("options.limit");
    expect(script).toContain("Profile-scoped evaluation requires explicit job-version IDs.");
  });

  it("requires queue context to match the current deterministic artifacts", () => {
    const lineage = readFileSync(resolve("src/pipeline/evaluationQueueLineage.ts"), "utf8");

    expect(lineage).toContain("dd.context_fingerprint = eq.context_fingerprint");
    expect(lineage).toContain("dd.match_run_id = eq.match_run_id");
    expect(lineage).toContain("mr.canonical_job_id = eq.canonical_job_id");
    expect(lineage).toContain("mr.job_content_hash = jv.content_hash");
    expect(lineage).toContain("mr.context_fingerprint IS NOT NULL");
    expect(lineage).not.toContain("mr.context_fingerprint = eq.context_fingerprint");
    expect(lineage).toContain("eq.match_run_id = c.latest_match_run_id");
    expect(lineage).toContain("eq.deterministic_decision_id = c.latest_deterministic_decision_id");
    expect(lineage).toContain("eq.context_fingerprint IS NOT NULL");
  });
});
