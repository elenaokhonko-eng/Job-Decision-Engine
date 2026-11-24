/**
 * Guard for PIPELINE_TASK_WORKER_TASK_TYPES.
 *
 * A restricted task-type list can strand jobs: a stage whose successor is not on the list leaves its
 * jobs waiting forever (the re-gate strand: APPLY_HARD_GATES -> PUBLISH_EMBEDDING). A scheduled run
 * (GitHub Actions) must therefore either run every default type or not run at all. Local, deliberate
 * restrictions (repair and rehearsal commands) only get a warning. EXTRACT_QUOTED_REQUIREMENTS is not a
 * default type: the default worker leaves it out unless it is asked for.
 */
import { PIPELINE_STAGE_TASK_TYPES, parsePipelineTaskTypes } from "./stageTaskWorker.js";

const OPTIONAL_TYPES: ReadonlySet<string> = new Set(["EXTRACT_QUOTED_REQUIREMENTS"]);

export const DEFAULT_WORKER_TASK_TYPES: readonly string[] =
  PIPELINE_STAGE_TASK_TYPES.filter((type) => !OPTIONAL_TYPES.has(type));

/** Default task types missing from the requested list. An unset or empty list means all, so none are missing. */
export function missingDefaultTaskTypes(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  const requested = new Set<string>(parsePipelineTaskTypes(raw));
  return DEFAULT_WORKER_TASK_TYPES.filter((type) => !requested.has(type));
}

export type WorkerTaskTypeGuardResult =
  | { readonly action: "OK" }
  | { readonly action: "WARN" | "FAIL"; readonly missing: readonly string[]; readonly message: string };

export function checkWorkerTaskTypes(
  raw: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerTaskTypeGuardResult {
  const missing = missingDefaultTaskTypes(raw);
  if (missing.length === 0) return { action: "OK" };
  const scheduled = env.GITHUB_ACTIONS === "true";
  return {
    action: scheduled ? "FAIL" : "WARN",
    missing,
    message:
      `PIPELINE_TASK_WORKER_TASK_TYPES omits default task type(s) ${missing.join(", ")}; jobs whose next stage is on that list ` +
      `can wait forever. ${scheduled ? "A scheduled run must use every default type: unset the variable." : "Allowed for a deliberate local run."}`,
  };
}
