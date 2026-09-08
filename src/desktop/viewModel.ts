import type { ApplicationRecord, ShortlistRow } from "../contracts/index.js";
import type { PipelineTaskRow, SourceHealthRow } from "../sdk/index.js";

export interface DesktopCounts {
  totalJobs: number;
  priorityJobs: number;
  needsVerificationJobs: number;
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

export function jobOutcomeLabel(job: Pick<ShortlistRow, "recommendation_outcome" | "gate_status" | "processing_state">): string {
  if (job.recommendation_outcome) return job.recommendation_outcome;
  if (job.gate_status === "NEEDS_VERIFICATION") return "VERIFY";
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
    priorityJobs: jobs.filter((job) => job.recommendation_outcome === "PRIORITY").length,
    needsVerificationJobs: jobs.filter((job) => job.gate_status === "NEEDS_VERIFICATION").length,
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
