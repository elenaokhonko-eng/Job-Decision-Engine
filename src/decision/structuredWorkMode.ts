/**
 * Work mode that a source states in a structured field, read strictly.
 *
 * Pure. The re-check task uses it to fill a work mode that an older ingest left unknown, from the
 * payload that was stored with the observation. It never guesses: a value outside the allow-list
 * stays UNKNOWN, so the job keeps needing verification instead of getting an invented answer.
 *
 * Workday payloads carry `jobPostingInfo.remoteType`. Clear values: Hybrid, Hybrid Work, Onsite,
 * Fully Onsite, On-Site (and Remote). Ambiguous values such as "Office - Flexible" or
 * "Not Applicable" say nothing about where the work is done and stay UNKNOWN.
 */
export type StructuredWorkMode = "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";

const CLEAR_REMOTE_TYPES: ReadonlyMap<string, Exclude<StructuredWorkMode, "UNKNOWN">> = new Map([
  ["hybrid", "HYBRID"],
  ["hybrid work", "HYBRID"],
  ["onsite", "ONSITE"],
  ["on-site", "ONSITE"],
  ["on site", "ONSITE"],
  ["fully onsite", "ONSITE"],
  ["fully on-site", "ONSITE"],
  ["remote", "REMOTE"],
]);

export function workModeFromWorkdayRemoteType(remoteType: unknown): StructuredWorkMode {
  if (typeof remoteType !== "string") return "UNKNOWN";
  return CLEAR_REMOTE_TYPES.get(remoteType.trim().toLowerCase().replace(/\s+/g, " ")) ?? "UNKNOWN";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** The remoteType a Workday observation stored (detail.jobPostingInfo.remoteType), or null when absent. */
export function workdayRemoteTypeFromPayload(rawPayload: unknown): string | null {
  const root = record(rawPayload);
  const detail = record(root?.detail);
  const info = record(detail?.jobPostingInfo) ?? record(root?.jobPostingInfo);
  const value = info?.remoteType;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Work mode the stored observation states in a structured field. Only a Workday observation is read;
 * every other source returns UNKNOWN here (their work mode comes through the normal normalizer).
 */
export function structuredWorkModeFromObservation(sourceName: string, rawPayload: unknown): StructuredWorkMode {
  if (sourceName.toUpperCase() !== "WORKDAY") return "UNKNOWN";
  return workModeFromWorkdayRemoteType(workdayRemoteTypeFromPayload(rawPayload));
}
