export type NormalizedWorkMode = "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";

export function normalizeWorkMode(raw: unknown): NormalizedWorkMode {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return "UNKNOWN";
  }

  if (/(remote|work from home|wfh|telecommute|remote-first)/i.test(value)) {
    return "REMOTE";
  }

  if (/(hybrid|flexible hybrid|partly remote)/i.test(value)) {
    return "HYBRID";
  }

  if (/(on[-\s]?site|onsite|on premise|on-premise|on premises|on-premises|in[-\s]?office|office[-\s]?based)/i.test(value)) {
    return "ONSITE";
  }

  if (value === "unknown" || value === "unspecified" || value === "n/a" || value === "na") {
    return "UNKNOWN";
  }

  return "UNKNOWN";
}

export function inferWorkModeFromSignals(input: {
  workplaceTypeRaw?: unknown;
  locationRaw?: unknown;
  isRemoteFlag?: unknown;
}): NormalizedWorkMode {
  if (typeof input.isRemoteFlag === "boolean") {
    if (input.isRemoteFlag) {
      return "REMOTE";
    }
  }

  const fromWorkplace = normalizeWorkMode(input.workplaceTypeRaw);
  if (fromWorkplace !== "UNKNOWN") {
    return fromWorkplace;
  }

  const location = String(input.locationRaw ?? "");
  const fromLocation = normalizeWorkMode(location);
  if (fromLocation !== "UNKNOWN") {
    return fromLocation;
  }

  // If a non-empty location is present and does not indicate remote/hybrid,
  // treat it as onsite by default (unknown is preserved when location is missing).
  if (location.trim().length > 0 && !/unknown/i.test(location)) {
    return "ONSITE";
  }

  return "UNKNOWN";
}

