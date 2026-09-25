import { describe, it, expect } from "vitest";
import { applyGlobalGates } from "../../src/services/criteria.js";
import { WORK_MODE_FIXTURES } from "./fixtures/h_work_mode.fixtures.js";
import { loadWorkabilityPolicy } from "../../src/pipeline/workabilityPolicy.js";

describe("Funnel V3 Independent Test Suite — Work Mode and Authorization (H01-H16)", () => {
  const policy = loadWorkabilityPolicy();

  it("H01: hybrid unspecified => employer count NULL, assumed 3/2, PASS", () => {
    const fixture = WORK_MODE_FIXTURES.H01;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
    expect(result.workability_facts.office_days_min).toBe(3);
    expect(result.workability_facts.office_days_max).toBe(3);
  });

  it("H02: employer 3 onsite pass", () => {
    const fixture = WORK_MODE_FIXTURES.H02;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
    expect(result.workability_facts.office_days_min).toBe(3);
    expect(result.workability_facts.office_days_max).toBe(3);
  });

  it("H03: explicit 4 onsite reject", () => {
    const fixture = WORK_MODE_FIXTURES.H03;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.passed).toBe(false);
    expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
    expect(result.workability_facts.office_days_min).toBe(4);
    expect(result.workability_facts.office_days_max).toBe(4);
  });

  it("H04: 2 days WFH/known five-day week = 3 onsite => PASS", () => {
    const fixture = WORK_MODE_FIXTURES.H04;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
  });

  it("H05: 3 WFH = 2 onsite => PASS", () => {
    const fixture = WORK_MODE_FIXTURES.H05;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
  });

  it("H06: 30 days leave, apply in 5 days, 5-day workweek cannot be parsed as office days", () => {
    const fixture = WORK_MODE_FIXTURES.H06;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
  });

  it("H07: simultaneous contradictory schedules must not publish MATCHED", () => {
    const fixture = WORK_MODE_FIXTURES.H07;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.passed).toBe(false);
  });

  it("H08: onsite-only reject", () => {
    const fixture = WORK_MODE_FIXTURES.H08;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
  });

  it("H09: truly missing workplace is a hard rejection with persisted policy evidence", () => {
    const fixture = WORK_MODE_FIXTURES.H09;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.passed).toBe(false);
    expect(result.rejection_codes).toEqual(["GATE_UNKNOWN_WORK_MODE"]);
    expect(result.evidence_quotes.join(" ")).toMatch(/workplace model unspecified/i);
    expect(result.workability_facts.office_days_min).toBeNull();
    expect(result.workability_facts.office_days_max).toBeNull();
    expect(result.workability_facts.attendance_basis).toBe("UNKNOWN");
  });

  it("H10: worldwide remote pass", () => {
    const fixture = WORK_MODE_FIXTURES.H10;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
    expect(result.workability_facts.office_days_min).toBe(0);
    expect(result.workability_facts.office_days_max).toBe(0);
  });

  it("H11: US-headquartered remote, no explicit work permit/citizenship => pass location rule", () => {
    const fixture = WORK_MODE_FIXTURES.H11;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
  });

  it("H12: remote role explicitly demands US right-to-work, SG-only profile => reject", () => {
    const fixture = WORK_MODE_FIXTURES.H12;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_LOCATION_RESTRICTED");
  });

  it("H13: remote with explicitly Singapore authorization => pass", () => {
    const fixture = WORK_MODE_FIXTURES.H13;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
  });

  it("H14: foreign onsite requiring actual missing visa => reject", () => {
    const fixture = WORK_MODE_FIXTURES.H14;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
  });

  it("H15: 'no work visa required' doesn't reject", () => {
    const fixture = WORK_MODE_FIXTURES.H15;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("PASS");
  });

  it("H16: hybrid assumed 3/2 + unrelated hard violation still rejects", () => {
    const fixture = WORK_MODE_FIXTURES.H16;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("NON_TARGET_ROLE_FAMILY");
  });
});
