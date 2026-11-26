/**
 * gate-2026-11.4 rejected pre-sales, post-sales and customer-engagement roles (GATE_HIGH_INTERACTION).
 * gate-2026-11.7 (owner decision 2026-11-25, decision #213): the duty phrases are read the same way but only
 * downrank; the explicit-evidence rejection is covered in gate_high_interaction_explicit_evidence.test.ts.
 *
 * Synthetic postings only: employer names are invented and the descriptions paraphrase
 * the shape of real postings. Building for customers, customer data and stakeholder
 * work are never enough.
 */
import { describe, expect, it } from "vitest";
import { evaluateHardGatesForJob, remoteTerritoryScopeForPolicy } from "../../src/pipeline/hardGate.js";
import { findCustomerFacingRoleDuty } from "../../src/pipeline/customerFacingDuties.js";
import { loadWorkabilityPolicy } from "../../src/pipeline/workabilityPolicy.js";

const policy = loadWorkabilityPolicy();

function fullGate(title: string, company: string, description: string, workplaceType = "HYBRID") {
  return evaluateHardGatesForJob({
    job: {
      title,
      company_name: company,
      description,
      location: "Singapore",
      workplace_type: workplaceType,
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

const BOILERPLATE = [
  "<h3>About Us</h3><p>We are a leading platform trusted by thousands of customers worldwide.</p>",
  "<h3>Benefits</h3><p>We offer flexible hybrid work, learning budgets and health insurance.</p>",
  "<p>We are an equal opportunity employer and welcome all qualified applicants regardless of background.</p>",
].join("");

const CUSTOMER_SOLUTIONS_ARCHITECT = `
<p>Quillbyte AI is hiring a Customer Platform Architect in Singapore (hybrid).</p>
<h3>What you'll do</h3>
<ul>
<li>Be responsible for the entire customer journey, starting at scoping and ending at go-live.</li>
<li>Run regular customer engagements so that teams keep using our tooling.</li>
<li>Agree proof-of-value milestones and exit measures with prospective customers.</li>
<li>Write Python services that score and serve language models for customer rollouts.</li>
</ul>
<h3>Customer Success</h3>
<p>After launch you pair closely with our Customer Success team.</p>
${BOILERPLATE}`;

const LEGAL_ENGINEER_ADOPTION = `
<p>Lexora Systems builds AI for in-house legal teams. We are hiring a Legal Engineer – Adoption Advisor in Singapore (hybrid).</p>
<p>The Legal Engineer – Adoption Advisor serves as the face of Lexora in Vietnam, setting up our drafting tool for in-house lawyers.</p>
<p>This role sits within Lexora's post-sales organization and teams up with Account Executives on adoption and renewal.</p>
<ul><li>Maintain clause templates and reusable prompts.</li></ul>
${BOILERPLATE}`;

describe("findCustomerFacingRoleDuty", () => {
  it.each([
    ["This role sits within our post-sales organization.", "post-sales organization"],
    ["You will be part of the pre-sales team for APAC.", "pre-sales team"],
    ["You will join the Customer Success team.", "customer success team"],
    ["• Responsible for the entire customer journey.", "entire customer journey"],
    ["Set proof-of-value timelines and success criteria with prospective customers.", "proof-of-value"],
    ["Deliver an early proof of concept to a customer before the quarter ends.", "to a customer"],
    ["Respond to RFPs from enterprise buyers.", "respond to rfps"],
    ["Reporting to the VP of Customer Success, you will lead the renewals organization.", "vp of customer success"],
    ["You will serve as the face of the company to customers.", "face of the company"],
    ["Run technical demos with prospects.", "demos with prospects"],
    ["You will serve as the face of Brightquay in Japan.", "face of"],
    ["Regular customer engagements to unblock adoption.", "regular customer engagements"],
    ["Partner with Account Executives to drive expansion and renewal.", "account executives"],
    ["Responsibilities: Deliver product demos to prospects.", "demos to prospects"],
    ["Run proofs of concept with prospective customers.", "prospective customers"],
    ["Run PoCs with prospective customers.", "pocs"],
    ["In this role you partner with our account executives on onboarding plans and renewals.", "account executives"],
  ])("reads %s", (text, fragment) => {
    expect(findCustomerFacingRoleDuty(text.toLowerCase())).toContain(fragment);
  });

  it.each([
    "Build tools used by our customers.",
    "Model customer data for churn analytics.",
    "Work with business stakeholders to define data contracts.",
    "Our Customer Success team sits within the operations group.",
    "Our customer success managers are responsible for the customer journey.",
    "This is not a pre-sales role and has no customer-facing duties.",
    "We offer benefits to every member of the customer success team.",
    "We are an equal opportunity employer; our post-sales organization welcomes all qualified applicants.",
    "Engineers who partner with sales to close deals use our platform.",
    "PoC leadership: run short PoCs that test an idea, agreeing what good looks like first.",
    "Customer champion duties: act as the voice of the customer when internal priorities are set.",
    "Act as a key representative for data governance initiatives across APAC.",
    "You will be part of the platform solution engineering group that maintains shared tooling.",
    "Support RFP estimation and technical scoping for complex initiatives.",
    "Owns renewal rate reporting and variance analysis against plan.",
    "What you'll be doing: own customer lifecycle demand gen.",
    "Prototype proof of concept tools, now and then alongside partner customers.",
    "About the role: the deal desk team works closely with our sales organisation on large bids.",
  ])("ignores %s", (text) => {
    expect(findCustomerFacingRoleDuty(text.toLowerCase())).toBeNull();
  });
});

describe("GATE_HIGH_INTERACTION for pre-sales and post-sales roles", () => {
  // gate-2026-11.7 (owner decision 2026-11-25): duty phrases alone no longer reject; they downrank (roleShape.ts).
  it("does not reject a Customer Platform Architect with customer-journey and proof-of-value duties", () => {
    const result = fullGate("Customer Platform Architect", "Quillbyte AI", CUSTOMER_SOLUTIONS_ARCHITECT);
    expect(result.status).toBe("PASS");
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    expect(findCustomerFacingRoleDuty(CUSTOMER_SOLUTIONS_ARCHITECT.replace(/<[^>]+>/g, " . ").toLowerCase())).toContain("entire customer journey");
  });

  it.each(["UNKNOWN", "ASSUMED_HYBRID", "HYBRID"])("does not reject a post-sales Legal Engineer – Adoption Advisor (stored %s)", (mode) => {
    const result = fullGate("Legal Engineer – Adoption Advisor", "Lexora Systems", LEGAL_ENGINEER_ADOPTION, mode);
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    expect(result.status).not.toBe("HARD_REJECT");
  });

  it.each([
    ["Machine Learning Engineer", "Tidewell Labs", `<p>Build ML tools used by our customers in Python and PyTorch. Own model training and evaluation pipelines.</p>${BOILERPLATE}`],
    ["Data Architect", "Harbourline Data", `<p>Design the enterprise data architecture, working with business stakeholders to define data contracts and lineage in SQL and dbt.</p>${BOILERPLATE}`],
    ["Legal Engineer", "Northfield Legal Tech", `<p>Build internal legal workflows and contract-automation tools for our in-house legal team using Python and LLM APIs.</p>${BOILERPLATE}`],
    ["Solutions Architect", "Corvane Systems", `<p>Design internal data and cloud platforms for our engineering teams. Define the software architecture, data model and deployment pipeline for internal services.</p>${BOILERPLATE}`],
  ])("still passes a %s that builds for customers or internal teams", (title, company, description) => {
    const result = fullGate(title, company, description);
    expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
    expect(result.status).toBe("PASS");
  });
});

/**
 * PR #181 review rows 1-18: engineering, data, AI and legal-tech wording that must never be
 * read as a pre-sales or customer-engagement role. Each must pass the full gate under every
 * stored work mode, as it does on main.
 */
const HYB = "<p>Hybrid working, 3 days in office.</p>";
const REVIEW_MUST_PASS: ReadonlyArray<readonly [string, string]> = [
  ["AI Engineer", "<ul><li>Run POCs of new GenAI models to improve customer experience.</li></ul>"],
  ["Machine Learning Engineer", "<ul><li>Lead proofs of concept for new recommendation models that improve customer retention.</li></ul>"],
  ["AI Engineer", "<ul><li>Deliver proof of value for internal GenAI use cases.</li></ul>"],
  ["AI Strategy Lead", "<ul><li>Drive a clear POV on responsible AI adoption across the bank.</li></ul>"],
  ["Data Analyst", "<p>You will partner with leaders in our Customer Success organization to model churn.</p>"],
  ["Analytics Engineer", "<p>You'll build dashboards used by managers in the customer success team.</p>"],
  ["Data Engineer", "<p>You will build data pipelines for teams in the post-sales organisation.</p>"],
  ["Data Analyst", "<p>You will report to the Head of Customer Success Analytics.</p>"],
  ["Marketing Data Scientist", "<ul><li>Own customer journey analytics and attribution modelling.</li></ul>"],
  ["Data Analyst", "<ul><li>Lead the customer journey data model across web and app.</li></ul>"],
  ["Data Scientist", "<ul><li>Drive upsell and cross-sell through propensity models.</li></ul>"],
  ["Data Scientist", "<ul><li>Own renewal propensity models for the subscription business.</li></ul>"],
  ["Legal Technology Manager", "<ul><li>Lead RFPs to select contract lifecycle management vendors.</li></ul>"],
  ["Data Platform Lead", "<ul><li>Own RFPs for data platform tooling and vendor evaluation.</li></ul>"],
  ["Head of Data", "<ul><li>Serve as the face of the data team to business stakeholders.</li></ul>"],
  ["ML Engineer", "<ul><li>Give demos to internal customers of new model features.</li></ul>"],
  ["Senior Data Engineer", "<p>You will join the customer engagement platform team, building ML that powers messaging.</p>"],
  ["ML Engineer", "<p>You will partner with account managers to understand needs and improve adoption of ML features.</p>"],
];

describe("PR #181 review: data, ML and legal-tech wording is not a customer-facing role", () => {
  for (const [index, [title, body]] of REVIEW_MUST_PASS.entries()) {
    it.each(["UNKNOWN", "HYBRID"])(`row ${index + 1}: ${title} passes (stored %s)`, (mode) => {
      const result = fullGate(title, "Zentrolabs", `${HYB}${body}`, mode);
      expect(result.rejection_codes).not.toContain("GATE_HIGH_INTERACTION");
      expect(result.status).toBe("PASS");
    });
    it(`row ${index + 1}: ${title} is not hard-rejected (stored ASSUMED_HYBRID)`, () => {
      const result = fullGate(title, "Zentrolabs", `${HYB}${body}`, "ASSUMED_HYBRID");
      expect(result.status).not.toBe("HARD_REJECT");
      expect(findCustomerFacingRoleDuty(body.replace(/<[^>]+>/g, "\n").toLowerCase())).toBeNull();
    });
  }
});
