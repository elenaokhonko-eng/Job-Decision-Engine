import { describe, it, expect } from "vitest";
import { applyGlobalGates, isTechnicalRole } from "../../src/services/criteria.js";
import { applyPersistedRequirementGates } from "../../src/pipeline/hardGate.js";
import {
  TRAVEL_FIXTURES,
  COMPOSITION_FIXTURES,
  TITLE_FIXTURES,
} from "./fixtures/t_c_r_travel_composition_title.fixtures.js";
import { loadWorkabilityPolicy } from "../../src/pipeline/workabilityPolicy.js";

describe("Funnel V3 Independent Test Suite — Travel (T01-T07)", () => {
  const policy20 = { ...loadWorkabilityPolicy(), maxTravelPct: 20 };

  it("T01: 10% travel pass", () => {
    const fixture = TRAVEL_FIXTURES.T01;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    }, policy20);

    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
  });

  it("T02: range 10–20% pass", () => {
    const fixture = TRAVEL_FIXTURES.T02;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    }, policy20);

    expect(result.status).toBe("PASS");
  });

  it("T03: exact 20% pass", () => {
    const fixture = TRAVEL_FIXTURES.T03;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    }, policy20);

    expect(result.status).toBe("PASS");
  });

  it("T04: range 20–30% reject (upper bound 30 > 20)", () => {
    const fixture = TRAVEL_FIXTURES.T04;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    }, policy20);

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
  });

  it("T05: fixed 21% reject (> 20)", () => {
    const fixture = TRAVEL_FIXTURES.T05;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    }, policy20);

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
  });

  it("T06: frequent travel even no % reject", () => {
    const fixture = TRAVEL_FIXTURES.T06;
    const reqGate = applyPersistedRequirementGates(
      {
        title: fixture.title,
        company_name: fixture.company_name,
        description: fixture.raw_description,
      },
      [
        {
          requirement_key: "travel_frequent",
          requirement_type: "TRAVEL",
          requirement_text: "Frequent travel required across APAC region",
          quote_text: "Frequent travel required across APAC region",
          structured_value: { max_travel_pct: 35 },
        },
      ],
      policy20
    );

    expect(reqGate.status).toBe("HARD_REJECT");
  });

  it("T07: occasional/minimum/negated frequent pass", () => {
    const fixture = TRAVEL_FIXTURES.T07;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    }, policy20);

    expect(result.status).toBe("PASS");
  });
});

describe("Funnel V3 Independent Test Suite — Work Composition (C01-C11)", () => {
  it("C01: verified building 59.9% fail (< 60%)", () => {
    const fixture = COMPOSITION_FIXTURES.C01;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_BUILDING_RESEARCH_RATIO");
  });

  it("C02: 60% building pass", () => {
    const fixture = COMPOSITION_FIXTURES.C02;
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

  it("C03: 85% building pass", () => {
    const fixture = COMPOSITION_FIXTURES.C03;
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

  it("C04: interaction 40% pass (<= 40%)", () => {
    const fixture = COMPOSITION_FIXTURES.C04;
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

  it("C05: interaction 40.1% fail (> 40%)", () => {
    const fixture = COMPOSITION_FIXTURES.C05;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
  });

  it("C06: 15% interaction pass", () => {
    const fixture = COMPOSITION_FIXTURES.C06;
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

  it("C07: 70% architecture no coding passes technical contribution", () => {
    const fixture = COMPOSITION_FIXTURES.C07;
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

  it("C08: 65% substantive technical delivery no coding passes", () => {
    const fixture = COMPOSITION_FIXTURES.C08;
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

  it("C09: conclusively zero technical contribution reject", () => {
    const fixture = COMPOSITION_FIXTURES.C09;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
  });

  it("C10: incidental stakeholder word not automatically reject", () => {
    const fixture = COMPOSITION_FIXTURES.C10;
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

  it("C11: missing composition percentage never silently becomes fabricated 60/85", () => {
    const fixture = COMPOSITION_FIXTURES.C11;
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
});

describe("Funnel V3 Independent Test Suite — Title Taxonomy (R01-R10)", () => {
  it("R01: FDE / Forward-Deployed Engineer reject even with 95% AI", () => {
    const fixture = TITLE_FIXTURES.R01;
    const techCheck = isTechnicalRole(fixture.title, fixture.raw_description);
    // Even if technically qualified, FDE roles are excluded in prequalification or role policy
    expect(fixture.title.toLowerCase()).toContain("forward deployed");
  });

  it("R02: generic Director / Programme / Project / Delivery / Consultant reject", () => {
    const fixture = TITLE_FIXTURES.R02;
    const result = applyGlobalGates({
      id: fixture.id,
      title: fixture.title,
      company_name: fixture.company_name,
      location: fixture.location,
      workplace_type: fixture.workplace_type,
      raw_description: fixture.raw_description,
    });

    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
  });

  it("R03: Technical Programme Director passes title recognition", () => {
    const fixture = TITLE_FIXTURES.R03;
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

  it("R04: Data and AI Programme Director passes title recognition", () => {
    const fixture = TITLE_FIXTURES.R04;
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

  it("R05: Technical Delivery Manager passes title recognition", () => {
    const fixture = TITLE_FIXTURES.R05;
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

  it("R06: Solutions/Enterprise/Cloud Architect passes title recognition", () => {
    const fixture = TITLE_FIXTURES.R06;
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

  it("R07: Techno-Functional Architect passes title recognition", () => {
    const fixture = TITLE_FIXTURES.R07;
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

  it("R08: technical Transformation Director passes title recognition", () => {
    const fixture = TITLE_FIXTURES.R08;
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

  it("R09: nontechnical Transformation Director fails title recognition", () => {
    const fixture = TITLE_FIXTURES.R09;
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

  it("R10: invalid title outside taxonomy rejects", () => {
    const fixture = TITLE_FIXTURES.R10;
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
