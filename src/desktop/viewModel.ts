import type { ApplicationRecord, ShortlistRow } from "../contracts/index.js";
import type { PipelineTaskRow, SourceHealthRow } from "../sdk/index.js";

export interface DesktopCounts {
  totalJobs: number;
  priorityJobs: number;
  manualActionJobs: number;
  processingAutomaticallyJobs: number;
  technicalErrorJobs: number;
  activeApplications: number;
  submittedApplications: number;
  runningTasks: number;
  failingSources: number;
}

export function safeExternalHref(value: string | null | undefined): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function jobOutcomeLabel(job: Pick<
  ShortlistRow,
  | "recommendation_outcome"
  | "gate_status"
  | "processing_state"
  | "current_artifact_status"
  | "requires_user_action"
  | "pipeline_display_category"
>): string {
  if (job.requires_user_action) return "ACTION REQUIRED";
  if (job.pipeline_display_category === "TECHNICAL_ERROR") return "ERROR";
  if (
    job.pipeline_display_category === "PROCESSING_AUTOMATICALLY" ||
    job.current_artifact_status !== "CURRENT_OR_NOT_APPLICABLE"
  ) {
    return "PROCESSING";
  }
  if (job.processing_state === "UNMATCHED") return "UNMATCHED";
  if (job.recommendation_outcome) return job.recommendation_outcome;
  if (job.gate_status === "HARD_REJECT") return "SKIP";
  return job.processing_state || "TRACK";
}

export function summarizeDesktopCounts(
  jobs: ShortlistRow[],
  applications: ApplicationRecord[],
  tasks: PipelineTaskRow[],
  sources: SourceHealthRow[]
): DesktopCounts {
  const activeApplicationStatuses = new Set(["INTENT", "READY_TO_APPLY", "FOLLOW_UP", "INTERVIEW", "OFFER"]);
  return {
    totalJobs: jobs.length,
    priorityJobs: jobs.filter((job) =>
      job.pipeline_display_category === "COMPLETED" && job.recommendation_outcome === "PRIORITY"
    ).length,
    manualActionJobs: jobs.filter((job) => job.requires_user_action).length,
    processingAutomaticallyJobs: jobs.filter((job) =>
      job.pipeline_display_category === "PROCESSING_AUTOMATICALLY"
    ).length,
    technicalErrorJobs: jobs.filter((job) =>
      job.pipeline_display_category === "TECHNICAL_ERROR"
    ).length,
    activeApplications: applications.filter((application) =>
      activeApplicationStatuses.has(application.application_status)
    ).length,
    submittedApplications: applications.filter((application) => application.application_status === "SUBMITTED").length,
    runningTasks: tasks.filter((task) => ["PENDING", "RUNNING", "RETRY_WAIT"].includes(task.status)).length,
    failingSources: sources.filter((source) => source.status !== "ACTIVE").length,
  };
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  const diffMs = Date.now() - date.getTime();
  const absMinutes = Math.max(0, Math.floor(Math.abs(diffMs) / 60000));
  if (absMinutes < 1) return "now";
  if (absMinutes < 60) return `${absMinutes}m`;
  const hours = Math.floor(absMinutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
