/**
 * gate-2026-11.7 (owner decision 2026-11-25, decision #213): GATE_HIGH_INTERACTION hard-rejects only on explicit
 * evidence. One bare phrase with no workability fact never rejects; a customer-engagement duty phrase lowers the rank
 * through the existing role-shape signal CUSTOMER_FACING_DELIVERY.
 *
 * Synthetic postings only: every employer and sentence below is written for this test.
 */
import { describe, expect, it } from "vitest";
import { evaluateHardGatesForJob, remoteTerritoryScopeForPolicy } from "../../src/pipeline/hardGate.js";
import { findExplicitSalesDuty } from "../../src/pipeline/customerFacingDuties.js";
import { assessRoleShape, ROLE_SHAPE_POLICY_VERSION } from "../../src/pipeline/roleShape.js";
import { loadWorkabilityPolicy } from "../../src/pipeline/workabilityPolicy.js";

const policy = loadWorkabilityPolicy();

function gate(title: string, description: string) {
  return evaluateHardGatesForJob({
    job: {
      title,
      company_name: "Fernquill Legal Systems",
      description,
      location: "Singapore",
      workplace_type: "HYBRID",
      employment_type: "PERMANENT",
      compensation_raw: null,
    },
    requirements: [],
    profileFacts: [],
    policy,
    stage3Preferences: {},
    territoryScope: remoteTerritoryScopeForPolicy(policy),
  });
}

const BASE = "<p>Design and build contract-analysis workflows with Python and LLM APIs for legal teams.</p>";

const BARE_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["(a) customer-journey duty", "<ul><li>Own the customer journey for our contract-review solution.</li></ul>"],
  ["(a) face of the company", "<ul><li>Serve as the face of Fernquill to enterprise legal teams.</li></ul>"],
  ["(b) experience requirement", "<p>Experience in sales engineering or solutions consulting is a plus.</p>"],
  ["(c) works with the pre-sales team", "<p>You will work with our pre-sales team on technical questions.</p>"],
  ["(c) supports pre-sales", "<p>You will support pre-sales and contract negotiation activities.</p>"],
];

describe("GATE_HIGH_INTERACTION needs explicit evidence", () => {
  it.each(BARE_PHRASES)("a single bare phrase does not hard-reject: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    expect(result.status).not.toBe("HARD_REJECT");
  });

  it("a duty phrase downranks through CUSTOMER_FACING_DELIVERY and keeps the quote as the label", () => {
    const description = `${BASE}
Own the customer journey for our contract-review solution.`;
    const shape = assessRoleShape({ title: "Legal Solutions Lead", description });
    expect(ROLE_SHAPE_POLICY_VERSION).toBe("role_shape_v2");
    expect(shape.signals).toHaveLength(1);
    expect(shape.signals[0]).toMatchObject({ code: "CUSTOMER_FACING_DELIVERY", penalty: 0.06, source: "DESCRIPTION" });
    expect(shape.signals[0]!.quote.toLowerCase()).toContain("customer journey");
    expect(shape.total_penalty).toBe(0.06);
  });

  it("text without any customer-engagement phrase has no signal", () => {
    expect(assessRoleShape({ title: "Legal Engineer", description: BASE }).signals).toEqual([]);
  });

  it.each([
    ["a quota", "<p>You will carry a quarterly sales quota for new logos.</p>"],
    ["commission-based pay", "<p>This is a commission-based position with uncapped upside.</p>"],
    ["cold outbound as a duty", "<ul><li>Cold calling and outbound prospecting to build pipeline.</li></ul>"],
  ])("explicit evidence still hard-rejects: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    expect(result.evidence_quotes[0]).toMatch(/^Explicit sales-target duty: "/);
  });

  it("a pre-sales title still hard-rejects", () => {
    const result = gate("Presales Solutions Engineer", BASE);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
  });

  it.each([
    ["duty phrase first", "<ul><li>Own the customer journey for our contract-review solution.</li><li>You will carry a quarterly sales quota.</li></ul>"],
    ["quota first", "<ul><li>You will carry a quarterly sales quota.</li><li>Own the customer journey for our contract-review solution.</li></ul>"],
  ])("a bare duty phrase plus an explicit quota in the same posting still rejects, and the quote names the quota: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    expect(result.evidence_quotes[0]).toMatch(/^Explicit sales-target duty: ".*sales quota/);
    expect(result.evidence_quotes[0]).not.toMatch(/customer journey/);
  });

  it.each([
    ["commission-free", "<p>This is a commission-free position with a fixed salary.</p>"],
    ["hedged pre-sales support", "<p>You may support pre-sales occasionally.</p>"],
  ])("does not reject, by any rule: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    expect(findExplicitSalesDuty(body.replace(/<[^>]+>/g, " . ").toLowerCase())).toBeNull();
  });

  it("a negated or hedged explicit phrase does not reject", () => {
    expect(findExplicitSalesDuty("this role does not carry a sales quota.")).toBeNull();
    expect(findExplicitSalesDuty("you may occasionally join cold calling sessions.")).toBeNull();
    expect(findExplicitSalesDuty("our securities commission clients value accuracy.")).toBeNull();
  });
});

describe("commission counts only as pay (owner decision 2026-11-25)", () => {
  it.each([
    ["100% commission-based", "<p>The compensation is 100% commission-based.</p>"],
    ["commission-only", "<p>This is a commission-only position.</p>"],
    ["base plus commission", "<p>We offer a base salary plus commission.</p>"],
    ["earn commission on sales", "<p>You will earn commission on sales you close.</p>"],
  ])("rejects, quoting the pay sentence: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    expect(result.evidence_quotes[0]).toMatch(/^Explicit sales-target duty: ".*commission/);
  });

  it.each([
    ["commission-free", "<p>This is a commission-free role with a fixed salary.</p>"],
    ["no commission", "<p>There is no commission in this role.</p>"],
    ["does not include commission", "<p>The package does not include commission.</p>"],
    ["European Commission", "<p>You will analyse European Commission regulations on AI.</p>"],
    ["Securities and Exchange Commission", "<p>You will interpret Securities and Exchange Commission filings.</p>"],
    ["commissioning of systems", "<p>You will support the commissioning of new data systems.</p>"],
    ["commissioned work", "<p>You will review commissioned work from external research partners.</p>"],
    ["bonus without commission", "<p>Compensation is a base salary plus an annual performance bonus.</p>"],
  ])("does not reject: %s", (_label, body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
  });
});

describe("sales-engineer and pre-sales TITLES keep rejecting; solutions titles pass", () => {
  it.each(["Sales Engineer", "Senior Sales Engineer - Singapore", "Pre-Sales Engineer", "Presales Consultant", "Pre-Sales Solutions Consultant", "Sales Engineering Lead"])(
    "title %s rejects",
    (title) => {
      const result = gate(title, BASE);
      expect(result.status).toBe("HARD_REJECT");
      expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    },
  );

  it.each(["Solutions Engineer", "Solution Architect", "Senior Solutions Architect", "Implementation Manager"])("title %s passes", (title) => {
    const result = gate(title, BASE);
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    expect(result.status).toBe("PASS");
  });

  it("a sales-engineering mention in the body of a non-sales title does not reject", () => {
    const result = gate("Legal Solutions Lead", `${BASE}<p>Experience in sales engineering is a plus.</p>`);
    expect(result.status).not.toBe("HARD_REJECT");
  });
});

describe("commission as pay: owner and reviewer cases", () => {
  it.each([
    "<p>OTE 80k base + 40k commission.</p>",
    "<p>Total earnings include commission.</p>",
    "<p>The package includes commission.</p>",
    "<p>Base salary plus uncapped commission.</p>",
    "<p>You receive commission on every deal you close.</p>",
  ])("rejects: %s", (body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
    expect(result.evidence_quotes[0]).toMatch(/commission/);
  });

  it.each([
    "<p>You will work with Commission staff and regulators on AI policy.</p>",
    "<p>You will engage with commission officials on data standards.</p>",
    "<p>You will track the Commission's guidance on AI.</p>",
    "<p>You will summarise Law Commission reports.</p>",
    "<p>You will monitor Competition Commission decisions.</p>",
    "<p>You will follow regulatory commission rules for data sharing.</p>",
    "<p>You will map EU commission directives to controls.</p>",
    "<p>You will map European commission proposals to controls.</p>",
    "<p>You will compare commission rates charged by brokers in a pricing study.</p>",
  ])("does not reject: %s", (body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
  });

  it("stays fast on a large adversarial text (bounded quantifiers)", () => {
    const text = `${"commission ".repeat(7000)}${"plus ".repeat(7000)}`;
    const started = Date.now();
    findExplicitSalesDuty(text);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("commission about other roles or a company-wide policy does not reject", () => {
  it.each([
    "<p>Most sales positions are eligible for commission under the applicable plan.</p>",
    "<p>We offer a competitive commission structure for some roles.</p>",
    "<p>Sales team members earn commission under the company plan.</p>",
    "<p>Certain positions are commission-based.</p>",
  ])("does not reject: %s", (body) => {
    const result = gate("Senior Database Architect", `${BASE}${body}`);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
  });

  it.each([
    "<p>Your pay is a base salary plus commission.</p>",
    "<p>This role is commission-based.</p>",
    "<p>You will earn commission on every deal.</p>",
    "<p>Compensation: OTE with uncapped commission.</p>",
  ])("this role's pay line still rejects: %s", (body) => {
    const result = gate("Senior Database Architect", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
  });
});

describe("commission: runtime on hostile text, verb use and eligibility", () => {
  it.each([
    ["commission x10000", "commission ".repeat(10000)],
    ["commission, x10000", "commission, ".repeat(10000)],
  ])("stays fast on a large clause: %s", (label, text) => {
    const started = performance.now();
    const found = findExplicitSalesDuty(text);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
    // No pay context in these commission-only texts: nothing to find.
    expect(found, label).toBeNull();
  });

  it("a hostile clause with a pay word still rejects, and is fast", () => {
    const text = `${"commission, ".repeat(10000)} base plus commission`;
    const started = performance.now();
    expect(findExplicitSalesDuty(text)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });

  it.each([
    "<p>You will commission and manage vendor contracts, with a base of operations in Berlin.</p>",
    "<p>You will commission artwork, paid per piece.</p>",
    "<p>You will commission equipment for the lab.</p>",
    "<p>You may need to commission new data sources for the base layer.</p>",
  ])("commission used as a verb does not reject: %s", (body) => {
    const result = gate("Legal Solutions Lead", `${BASE}${body}`);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
  });

  it.each([
    "<p>This role is commission eligible.</p>",
    "<p>This role is commission-eligible.</p>",
    "<p>You are eligible for commission.</p>",
    "<p>You are eligible for sales commission.</p>",
    "<p>You are entitled to commission on closed deals.</p>",
    "<p>Sales roles earn commission, and you will receive commission too.</p>",
  ])("this role's commission eligibility rejects: %s", (body) => {
    const result = gate("Senior Database Architect", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
  });

  it("other roles' eligibility does not reject", () => {
    const result = gate("Senior Database Architect", `${BASE}<p>Most sales positions are eligible for commission.</p>`);
    expect(result.status).not.toBe("HARD_REJECT");
  });
});

it("a hostile quota clause is found (first match) and is fast", () => {
  const started = performance.now();
  expect(findExplicitSalesDuty("carry a quota ".repeat(10000))).not.toBeNull();
  expect(performance.now() - started).toBeLessThan(250);
});

// gate-2026-11.8: commission rejects only as this role's main variable pay or an explicit sales duty. Synthetic text only.
describe("commission scope (gate-2026-11.8)", () => {
  it.each([
    ["generic option list", "<p>In addition to base pay, we offer a performance-driven annual bonus or commission.</p>"],
    ["bonus, commission, or incentive program", "<p>You may be eligible for a bonus, commission, or incentive program.</p>"],
    ["eligible for a bonus, commission, or incentive program", "<p>Eligible for a bonus, commission, or incentive program.</p>"],
    ["commission opportunities without a structure", "<p>Base salary paid in USD + commission opportunities.</p>"],
    ["affiliate commissions paid to others", "<p>You will track affiliate commissions and reconcile partner payouts.</p>"],
    ["referral commission for others", "<p>You will administer the referral commission programme for the sales team.</p>"],
    ["other roles", "<p>Most sales positions are eligible for commission under the applicable plan.</p>"],
    ["cold calling as experience", "<p>Experience in cold calling is helpful but not required.</p>"],
    ["cold calling done by a team", "<p>You will manage an intake team that handles scheduling, and the sales group does cold calling.</p>"],
    ["negated cold calling duty", "<p>This role does not involve cold calling.</p>"],
  ])("does not reject: %s", (_label, body) => {
    const result = gate("Senior Database Architect", `${BASE}${body}`);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
  });

  it.each([
    ["commission-only sales role", "<p>This is a commission-only sales position.</p>"],
    ["commission-based", "<p>Pay is 100% commission-based.</p>"],
    ["uncapped commission", "<p>You will have uncapped commission on new accounts.</p>"],
    ["OTE with commission", "<p>Base + commission OTE $110,000-$140,000.</p>"],
    ["OTE 80k base + 40k commission", "<p>OTE 80k base + 40k commission.</p>"],
    ["on-target earnings with variable pay", "<p>On-target earnings of $120,000 with a variable component tied to bookings.</p>"],
    ["on-target earnings with a quota", "<p>On-target earnings assume you meet a quarterly sales target.</p>"],
    ["base plus commission structure", "<p>Compensation is base salary plus commission.</p>"],
    ["earn commission on sales", "<p>You will earn commission on sales you close.</p>"],
    ["quota duty", "<p>You will carry a quarterly sales quota.</p>"],
    ["cold calling duty", "<p>You will make daily cold calls to new prospects.</p>"],
    ["clause-initial cold calling", "<ul><li>Cold calling and outbound prospecting to build pipeline.</li></ul>"],
    ["mixed case", "<p>Sales roles earn commission, and you will receive commission too.</p>"],
  ])("rejects: %s", (_label, body) => {
    const result = gate("Senior Database Architect", `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
  });

  it.each([
    ["100KB commission", "commission ".repeat(10000)],
    ["100KB commission,", "commission, ".repeat(10000)],
    ["1MB commission", "commission ".repeat(100000)],
    ["1MB base plus", "base plus ".repeat(100000)],
    ["1MB OTE", "ote ".repeat(250000)],
  ])("stays fast on hostile text: %s", (_label, text) => {
    const started = performance.now();
    findExplicitSalesDuty(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// Owner rulings 2026-11-26 (option 2). Synthetic paraphrases only.
describe("commission scope: dry-run patterns and owner rulings", () => {
  it.each([
    ["pre-K: end-of-semester commission based on performance (bonus-like)", "<p>Pay is $16-$22 per hour, plus an end-of-semester commission based on performance, targeting 15% of yearly salary.</p>"],
    ["commission as a performance bonus for a non-sales role", "<p>Staff receive a performance bonus, sometimes called commission, each term.</p>"],
    ["affiliate specialist: track affiliate commissions", "<p>Track affiliate commissions, payouts and creator performance.</p>"],
    ["director: variable commission for quota-based roles", "<p>Compensation includes base salary, an equity incentive plan and variable commission (for quota-based roles).</p>"],
    ["engineering boilerplate: bonus or commission", "<p>In addition to base pay, we offer a performance-driven annual bonus or commission.</p>"],
    ["generic eligibility list", "<p>You may be eligible for a bonus, commission, or incentive program.</p>"],
    ["tuition-fee commission paid to an agency", "<p>The agency takes a commission on tuition fees it collects from families.</p>"],
    ["enrolment quota", "<p>Each classroom has an enrolment quota of 18 children.</p>"],
    ["school-store sales", "<p>You will help run the school store sales on Fridays.</p>"],
    ["other team does cold calling", "<p>Our SDR team does cold calling; you will receive qualified leads.</p>"],
    ["experience in cold calling", "<p>Experience in cold calling is a plus.</p>"],
  ])("does not reject: %s", (_label, body) => {
    const result = gate("Early Childhood Teacher", `${BASE}${body}`);
    expect(result.status).not.toBe("HARD_REJECT");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
  });

  it.each([
    ["lead intake manager: cold outbound as the role's duty", "Lead Intake Manager", "<ul><li>Cold calling and cold emailing: conduct structured outbound campaigns targeting priority markets.</li></ul>"],
    ["sales development representative", "Sales Development Representative", "<p>Base + commission OTE $60,000-$80,000.</p>"],
    ["inside sales", "Inside Sales Executive", "<p>Base + commission OTE $110,000-$140,000.</p>"],
    ["business development", "Business Development Manager", "<p>OTE 80k base + 40k commission.</p>"],
    ["commission-only structure", "Territory Manager", "<p>This is a commission-only position.</p>"],
    ["is commission based", "Territory Lead", "<p>Your pay is commission based.</p>"],
    ["OTE alone", "Growth Lead", "<p>On-target earnings of $100,000.</p>"],
    ["stated quota", "Partnerships Lead", "<p>You will carry an annual quota.</p>"],
  ])("rejects: %s", (_label, title, body) => {
    const result = gate(title, `${BASE}${body}`);
    expect(result.status).toBe("HARD_REJECT");
    expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
  });
});
