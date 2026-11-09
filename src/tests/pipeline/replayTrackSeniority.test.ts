import { describe, expect, it } from "vitest";

import { buildDiscoveryLocationScope, loadLocationScopeConfig } from "../../ingestion/discoveryLocationScope.js";
import { planTrackSeniorityReplay, type ReplayJob } from "../../../scripts/replay_track_seniority.js";

const SCOPE = buildDiscoveryLocationScope(loadLocationScopeConfig()!, { authorizedRegions: ["SINGAPORE"], rejectExplicitForeignTerritory: true });
const EXPERIENCE = [
  { track: "DATA_MANAGEMENT" as const, years: 16 },
  { track: "HANDS_ON_AI_DATA" as const, years: 1.5 },
];

function job(overrides: Partial<ReplayJob>): ReplayJob {
  return {
    canonical_job_id: "00000000-0000-0000-0000-000000000001",
    company_name: "Example Corp",
    title: "Machine Learning Engineer",
    outcome: "PRIORITY",
    source_name: "HIMALAYAS",
    location: "Remote",
    workplace_type: "REMOTE",
    description: "Example Corp builds payments infrastructure.",
    requirements: [],
    ...overrides,
  };
}

describe("track seniority replay plan", () => {
  it("keeps a mid-level hands-on AI role and caps a generic engineering role", () => {
    const [ml, generic] = planTrackSeniorityReplay([job({}), job({ title: "Software Engineer II" })], SCOPE, EXPERIENCE);
    expect(ml).toMatchObject({ before: "PRIORITY", after: "PRIORITY", territory: "PASS" });
    expect(generic).toMatchObject({ before: "PRIORITY", after: "REVIEW", territory: "PASS" });
  });

  it("reports a location reject or verification before any seniority change", () => {
    const [restricted, unclear] = planTrackSeniorityReplay([
      job({ description: "The base pay ranges from $75,000 to $100,000 CAD within any geographic market in Canada." }),
      job({ description: "Mexico Benefits: medical insurance." }),
    ], SCOPE, EXPERIENCE);
    expect(restricted).toMatchObject({ after: "HARD_REJECTED", territory: "HARD_REJECT" });
    expect(restricted.territory_reason).toContain("CANADA");
    expect(unclear).toMatchObject({ after: "NEEDS_VERIFICATION", territory: "NEEDS_VERIFICATION" });
  });

  it("re-gates an in-flight job that has no outcome yet without inventing one", () => {
    const [restricted, open] = planTrackSeniorityReplay([
      job({ outcome: null, description: "The base pay ranges from $75,000 to $100,000 CAD within any geographic market in Canada." }),
      job({ outcome: null }),
    ], SCOPE, EXPERIENCE);
    expect(restricted).toMatchObject({ before: null, after: "HARD_REJECTED", territory: "HARD_REJECT" });
    expect(open).toMatchObject({ before: null, after: null, territory: "PASS" });
  });
});
