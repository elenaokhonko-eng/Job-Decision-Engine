export const EARLY_PIPELINE_REPLAY_STATES = [
  "RAW_STAGED",
  "PREQUALIFIED",
  "NEEDS_VERIFICATION",
  "ROUTING_DEFERRED",
  "LANE_ROUTED",
];

export const MATCH_REVALIDATION_REPLAY_STATES = ["MATCHED", "UNMATCHED"];

export const AFFECTED_HISTORICAL_REPLAY_STATES = [
  ...EARLY_PIPELINE_REPLAY_STATES,
  ...MATCH_REVALIDATION_REPLAY_STATES,
];

export function shouldReplayAffectedHistoricalJobs(jobIds: readonly string[]): boolean {
  return jobIds.length > 0;
}

export function haveSameNumericCounts(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].every((key) => before[key] === after[key]);
}
