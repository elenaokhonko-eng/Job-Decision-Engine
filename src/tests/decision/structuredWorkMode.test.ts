import { describe, expect, it } from "vitest";

import {
  structuredWorkModeFromObservation,
  workModeFromWorkdayRemoteType,
} from "../../decision/structuredWorkMode.js";

describe("workModeFromWorkdayRemoteType", () => {
  it.each([
    ["Hybrid", "HYBRID"],
    ["Hybrid Work", "HYBRID"],
    ["Onsite", "ONSITE"],
    ["Fully Onsite", "ONSITE"],
    ["On-Site", "ONSITE"],
    ["  fully   onsite ", "ONSITE"],
    ["Remote", "REMOTE"],
  ])("%s is clear: %s", (value, expected) => {
    expect(workModeFromWorkdayRemoteType(value)).toBe(expected);
  });

  it.each(["Office - Flexible", "Not Applicable", "Flexible", "", "Partially Remote", null, undefined, 3])(
    "%s is ambiguous and stays unknown",
    (value) => {
      expect(workModeFromWorkdayRemoteType(value)).toBe("UNKNOWN");
    },
  );
});

describe("structuredWorkModeFromObservation", () => {
  const payload = (remoteType: string) => ({ workday: { tenant: "t" }, detail: { jobPostingInfo: { remoteType } } });

  it("reads the stored Workday detail", () => {
    expect(structuredWorkModeFromObservation("WORKDAY", payload("Hybrid"))).toBe("HYBRID");
    expect(structuredWorkModeFromObservation("workday", payload("Fully Onsite"))).toBe("ONSITE");
  });

  it("keeps an ambiguous Workday value unknown", () => {
    expect(structuredWorkModeFromObservation("WORKDAY", payload("Office - Flexible"))).toBe("UNKNOWN");
    expect(structuredWorkModeFromObservation("WORKDAY", payload("Not Applicable"))).toBe("UNKNOWN");
  });

  it("does not read other sources or malformed payloads", () => {
    expect(structuredWorkModeFromObservation("GREENHOUSE", payload("Hybrid"))).toBe("UNKNOWN");
    expect(structuredWorkModeFromObservation("WORKDAY", null)).toBe("UNKNOWN");
    expect(structuredWorkModeFromObservation("WORKDAY", { detail: "x" })).toBe("UNKNOWN");
  });
});
