import { describe, expect, it, vi } from "vitest";
import {
  extractTerritories,
  inferTerritoryOperator,
  normalizeTerritories,
  hasExplicitTerritoryRestriction,
  loadWorkabilityPolicy,
  mergeWorkabilityPreferenceContent,
  resolveWorkspaceWorkabilityPolicy,
} from "../../pipeline/workabilityPolicy.js";
import type { WorkspaceContext } from "../../workspace/context.js";

describe("workspace workability policy", () => {
  it("recognizes dotted territory abbreviations in work-location text", () => {
    expect(extractTerritories("Location: 100% Remote (U.S.)")).toContain("UNITED_STATES");
    expect(hasExplicitTerritoryRestriction("Location: 100% Remote (U.S. only)", "UNITED_STATES")).toBe(true);
    expect(hasExplicitTerritoryRestriction("Serve U.S. clients from anywhere", "UNITED_STATES")).toBe(false);
  });

  it("normalizes the owner and posting territories to the same canonical country code", () => {
    expect(normalizeTerritories(["Singapore", "Australia"])).toEqual(["SINGAPORE", "AUSTRALIA"]);
    expect(normalizeTerritories(["SINGAPORE"])).toEqual(["SINGAPORE"]);
    expect(inferTerritoryOperator("Candidates must be authorized to work in Singapore or Australia.")).toBe("ANY");
    expect(inferTerritoryOperator("Must be authorized in Singapore and Australia.")).toBe("ALL");
    expect(inferTerritoryOperator("Must be based in Singapore and collaborate with US customer teams.")).toBe("UNKNOWN");
  });

  it("distinguishes worker territory restrictions from employer/company locations", () => {
    expect(hasExplicitTerritoryRestriction("Must be authorized to work in the United States", "UNITED_STATES")).toBe(true);
    expect(hasExplicitTerritoryRestriction("Candidates must reside in Canada", "CANADA")).toBe(true);
    expect(hasExplicitTerritoryRestriction("Only applicants based in Germany", "GERMANY")).toBe(true);
    expect(hasExplicitTerritoryRestriction("US work authorization required", "UNITED_STATES")).toBe(true);
    expect(hasExplicitTerritoryRestriction("Remote eligible only in Bulgaria", "BULGARIA")).toBe(true);
    expect(hasExplicitTerritoryRestriction("UK right to work required", "UNITED_KINGDOM")).toBe(true);

    expect(hasExplicitTerritoryRestriction("Company location: New York", "UNITED_STATES")).toBe(false);
    expect(hasExplicitTerritoryRestriction("Remote — United States", "UNITED_STATES")).toBe(false);
    expect(hasExplicitTerritoryRestriction("HQ: California", "UNITED_STATES")).toBe(false);
    expect(hasExplicitTerritoryRestriction("We are an early-stage startup based in Canada", "CANADA")).toBe(false);
    expect(hasExplicitTerritoryRestriction("Employer based in Canada", "CANADA")).toBe(false);
    expect(hasExplicitTerritoryRestriction("Serve U.S. clients from anywhere", "UNITED_STATES")).toBe(false);
  });

  it("merges active preference mode content into hard-gate policy fields", () => {
    const merged = mergeWorkabilityPreferenceContent(loadWorkabilityPolicy(), {
      workability: {
        work_modes: ["REMOTE", "HYBRID"],
        max_office_days_per_week: 2,
        max_travel_pct: 25,
        on_call_allowed: true,
        shift_work_allowed: true,
        employment_types: ["PERMANENT", "CONTRACT"],
      },
    });

    expect(merged.onsiteOnlyAllowed).toBe(false);
    expect(merged.maxOfficeDaysPerWeek).toBe(2);
    expect(merged.hardFailOfficeDaysPerWeek).toBeGreaterThanOrEqual(3);
    expect(merged.maxTravelPct).toBe(25);
    expect(merged.contractAllowed).toBe(true);
    expect(merged.regularOnCallAllowed).toBe(true);
    expect(merged.shiftWorkAllowed).toBe(true);
    expect(merged.authorizedRegions).toEqual(["SINGAPORE"]);
    expect(merged.hybridWithoutOfficeDaysAllowed).toBe(true);
  });

  it("applies the actual UI hard_constraints payload, including zero and false values", () => {
    const merged = mergeWorkabilityPreferenceContent(loadWorkabilityPolicy(), {
      schema_version: "2.2.0",
      hard_constraints: {
        work_modes: ["REMOTE"],
        max_office_days_per_week: 0,
        max_travel_pct: 0,
        employment_types: ["FULL_TIME"],
        on_call_allowed: false,
        shift_work_allowed: false,
        authorized_regions: ["Australia"],
        hybrid_without_office_days_allowed: false,
      },
    });

    expect(merged.maxOfficeDaysPerWeek).toBe(0);
    expect(merged.maxTravelPct).toBe(0);
    expect(merged.onsiteOnlyAllowed).toBe(false);
    expect(merged.contractAllowed).toBe(false);
    expect(merged.regularOnCallAllowed).toBe(false);
    expect(merged.authorizedRegions).toEqual(["AUSTRALIA"]);
    expect(merged.hybridWithoutOfficeDaysAllowed).toBe(false);
    expect(merged.shiftWorkAllowed).toBe(false);
  });

  it("resolves the active database preference mode for the current workspace user", async () => {
    const context: WorkspaceContext = {
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceKey: "default",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      userKey: "local_user",
      role: "OWNER",
    };
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("workspace_user_preference_modes");
      return {
        rows: [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            mode_key: "contract_friendly",
            content: {
              workability: {
                max_office_days_per_week: 1,
                contract_allowed: true,
                shift_work_allowed: false,
              },
            },
          },
        ],
      };
    });

    const result = await resolveWorkspaceWorkabilityPolicy({ query } as any, { context });

    expect(result.source).toBe("ACTIVE_PREFERENCE_MODE");
    expect(result.modeKey).toBe("contract_friendly");
    expect(result.policy.maxOfficeDaysPerWeek).toBe(1);
    expect(result.policy.contractAllowed).toBe(true);
    expect(result.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("falls back to file policy when preference modes are not migrated", async () => {
    const context: WorkspaceContext = {
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceKey: "default",
      userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      userKey: "local_user",
      role: "OWNER",
    };
    const query = vi.fn(async () => {
      const err: any = new Error("relation does not exist");
      err.code = "42P01";
      throw err;
    });

    const result = await resolveWorkspaceWorkabilityPolicy({ query } as any, { context });

    expect(result.source).toBe("FILE");
    expect(result.modeKey).toBeNull();
    expect(result.policy.contractAllowed).toBe(false);
  });
});
