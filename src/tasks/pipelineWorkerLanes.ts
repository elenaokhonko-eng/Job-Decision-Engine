/**
 * Concurrency primitives for the pipeline stage worker's lanes.
 *
 * Lanes run in one Node.js process, so counters and maps are only mutated
 * between awaits and need no further locking. These mutexes order work that
 * must not overlap inside the process; database leases (FOR UPDATE SKIP
 * LOCKED claims) still guarantee that no task is claimed twice.
 */

export const MAX_PIPELINE_WORKER_CONCURRENCY = 16;

/**
 * Task types that run at most one at a time even when several lanes are
 * active. Each entry names the shared state that is not safe to touch from two
 * tasks at once:
 *
 * - NORMALIZE_OBSERVATION: canonical-job identity is resolved with a
 *   select-then-insert inside the normalizer, so two observations of the same
 *   posting normalized concurrently could race on job/version identity.
 * - PUBLISH_EMBEDDING: every task rebuilds and locks the shared profile-fact and
 *   lane-prototype embedding inputs, seeds the shared embedding spaces and may
 *   select the same not-yet-embedded shared inputs, which would duplicate
 *   provider calls. The coordinator already overlaps provider calls inside one
 *   task (EMBEDDING_PROVIDER_CONCURRENCY).
 * - ENQUEUE_EXPLANATION: all tasks of a worker invocation share one AI budget
 *   run that is updated under REPEATABLE READ with a row lock; concurrent
 *   enqueuers would fail with serialization errors instead of sharing budget.
 */
export const SERIAL_PIPELINE_TASK_TYPES: ReadonlySet<string> = new Set([
  "NORMALIZE_OBSERVATION",
  "PUBLISH_EMBEDDING",
  "ENQUEUE_EXPLANATION",
]);

export function parsePipelineWorkerConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PIPELINE_WORKER_CONCURRENCY) {
    throw new Error(
      `PIPELINE_TASK_WORKER_CONCURRENCY must be an integer from 1 to ${MAX_PIPELINE_WORKER_CONCURRENCY}.`,
    );
  }
  return parsed;
}

/** FIFO async mutex per key. Lock order in the worker is task type, then job. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * Key that serializes tasks touching the same job inside one process, so two
 * lanes never run different stages of one job version at the same time.
 */
export function pipelineTaskTargetKey(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const field of ["job_version_id", "canonical_job_id", "observation_id"]) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return `${field}:${value.trim()}`;
  }
  return null;
}
