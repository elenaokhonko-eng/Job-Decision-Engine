import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  GEMINI_FLEX_CALL_DEADLINE_DEFAULT_MS,
  GEMINI_FLEX_REQUEST_TIMEOUT_DEFAULT_MS,
} from "../../services/modelCallResilience.js";

interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  "timeout-minutes"?: number;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
}

const WORKFLOWS = ["queue_worker", "process_backlog", "ingest"] as const;
/** Scripts whose steps can make a Flex call (quoted extraction in the worker; evaluations). */
const FLEX_CAPABLE_RUN = /scripts\/(process_pipeline_tasks|evaluate_queue|run_scoped_pilot)\.ts/;

function jobs(workflow: string): Record<string, WorkflowJob> {
  const parsed = load(readFileSync(resolve(`.github/workflows/${workflow}.yml`), "utf8")) as { jobs: Record<string, WorkflowJob> };
  return parsed.jobs;
}

/** The value after `||` in `${{ vars.X || 'default' }}`. */
function defaultOf(expression: string | undefined): number {
  const match = /\|\|\s*'(\d+)'\s*\}\}/.exec(expression ?? "");
  if (!match) throw new Error(`No numeric default in ${expression}`);
  return Number(match[1]);
}

const minutes = (ms: number) => ms / 60_000;

describe("Flex PayGo timeouts in the pipeline workflows", () => {
  it("passes the Flex timeout variables, with the code defaults, to every job that can call Flex", () => {
    for (const workflow of WORKFLOWS) {
      for (const [name, job] of Object.entries(jobs(workflow))) {
        if (!(job.steps ?? []).some((step) => FLEX_CAPABLE_RUN.test(step.run ?? ""))) continue;
        expect(job.env?.GEMINI_FLEX_REQUEST_TIMEOUT_MS, `${workflow}.${name}`)
          .toBe("${{ vars.GEMINI_FLEX_REQUEST_TIMEOUT_MS || '600000' }}");
        expect(job.env?.GEMINI_FLEX_CALL_DEADLINE_MS, `${workflow}.${name}`)
          .toBe("${{ vars.GEMINI_FLEX_CALL_DEADLINE_MS || '900000' }}");
        expect(defaultOf(job.env?.GEMINI_FLEX_REQUEST_TIMEOUT_MS)).toBe(GEMINI_FLEX_REQUEST_TIMEOUT_DEFAULT_MS);
        expect(defaultOf(job.env?.GEMINI_FLEX_CALL_DEADLINE_MS)).toBe(GEMINI_FLEX_CALL_DEADLINE_DEFAULT_MS);
      }
    }
  });

  it("passes the role-specific OpenAI fallback models next to the shared OPENAI_MODEL", () => {
    let checked = 0;
    for (const workflow of WORKFLOWS) {
      for (const [name, job] of Object.entries(jobs(workflow))) {
        for (const step of job.steps ?? []) {
          if (!step.env?.OPENAI_MODEL) continue;
          const label = `${workflow}.${name}: ${step.name}`;
          expect(step.env.EVALUATION_FALLBACK_MODEL, label).toBe("${{ vars.EVALUATION_FALLBACK_MODEL || '' }}");
          expect(step.env.DOCUMENT_FALLBACK_MODEL, label).toBe("${{ vars.DOCUMENT_FALLBACK_MODEL || '' }}");
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it("gives every Flex-capable step room for its run budget plus one full Flex call deadline", () => {
    const flexCallMinutes = minutes(GEMINI_FLEX_CALL_DEADLINE_DEFAULT_MS);
    // One Flex request plus the standard retry must fit inside the call deadline.
    expect(GEMINI_FLEX_CALL_DEADLINE_DEFAULT_MS).toBeGreaterThanOrEqual(GEMINI_FLEX_REQUEST_TIMEOUT_DEFAULT_MS + 60_000);
    let checked = 0;
    for (const workflow of WORKFLOWS) {
      for (const [name, job] of Object.entries(jobs(workflow))) {
        for (const step of job.steps ?? []) {
          const run = step.run ?? "";
          if (!FLEX_CAPABLE_RUN.test(run)) continue;
          const label = `${workflow}.${name}: ${step.name}`;
          const timeout = step["timeout-minutes"];
          expect(timeout, `${label} needs timeout-minutes`).toBeTypeOf("number");
          let required: number;
          if (run.includes("process_pipeline_tasks")) {
            // The worker stops claiming at its wall clock; one task claimed just before may run a
            // full Flex call. Two minutes cover seeding/reconciliation and the shutdown grace.
            required = minutes(defaultOf(step.env?.PIPELINE_TASK_WORKER_WALL_CLOCK_MS)) + flexCallMinutes + 2;
          } else if (run.includes("evaluate_queue")) {
            // Must be bounded: an unbounded queue drain cannot be sized against a step timeout.
            required = minutes(defaultOf(step.env?.EVALUATION_QUEUE_WALL_CLOCK_MS)) + flexCallMinutes + 2;
          } else {
            // Scoped pilot: a 15 min worker budget with one Flex call in flight, then one evaluation.
            required = 15 + flexCallMinutes + flexCallMinutes + 2;
          }
          expect(timeout!, label).toBeGreaterThanOrEqual(required);
          expect(job["timeout-minutes"] ?? 360, `${label} job limit`).toBeGreaterThan(timeout!);
          checked += 1;
        }
      }
    }
    // queue_worker: evaluation + scoped pilot; process_backlog: worker; ingest: worker + evaluation.
    expect(checked).toBe(5);
  });
});
