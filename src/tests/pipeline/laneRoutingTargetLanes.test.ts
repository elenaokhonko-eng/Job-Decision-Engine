import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  extractCoreJobText,
  hasApprovedLaneFunction,
  hasInvestigationFunction,
  hasNonTechnicalRoleFamily,
  hasProductTransformationFunction,
  loadLanesConfig,
  routeLaneCandidates,
  stripEmployerBoilerplatePhrases,
} from "../../pipeline/laneRouter.js";
import { LaneFileConfigSchema } from "../../lanes/contracts.js";
import {
  APPROVED_STAGE2_LANE_WEIGHTS,
  LaneIntentPreferencesSchema,
  TARGET_LANE_KEYS,
} from "../../policy/laneIntentContracts.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const config = loadLanesConfig();

const NEW_LANES = ["TECHNICAL_PRODUCT_TRANSFORMATION", "INVESTIGATIONS_ENFORCEMENT"] as const;

/**
 * Production gemini-embedding-001 similarities between a job and every lane prototype sit in a
 * narrow 0.50-0.70 band, all above the 0.35-0.40 semantic minimums. The fixtures reproduce that:
 * every lane scores 0.55 and the lane the embedding favours scores 0.62, so the deterministic
 * domain and function gates decide eligibility, as they do in production.
 */
function route(title: string, description: string, favouredLane?: string) {
  return routeLaneCandidates({
    config,
    title,
    descriptionText: description,
    semanticScore: (laneKey) => (laneKey === favouredLane ? 0.62 : 0.55),
  });
}

interface RoutingFixture {
  title: string;
  description: string;
  favouredLane?: string;
  expected: readonly string[];
}

const GOVTECH_ABOUT = "About Us\nWe build digital government services and platforms for public agencies.\n";

const TECHNICAL_PRODUCT_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "Lead Product Manager (AGC)",
    description: `${GOVTECH_ABOUT}What You Will Do\n- Own the product roadmap for a case-management platform used by public prosecutors.\n- Lead discovery with officers and work with engineers and designers to ship software every sprint.\n- Define success metrics and prioritise the backlog with agile delivery teams.`,
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Lead Product Manager, Judiciary",
    description: `${GOVTECH_ABOUT}The Role\n- Lead a product team building digital court services.\n- Shape the product roadmap with engineers, designers and court administrators.\n- Use data to improve SaaS and in-house digital products.`,
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Senior Product Manager, Data Programme",
    description: "Lead the product management of a whole-of-government data programme. Prioritise data products, data analytics capabilities and APIs with engineering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Product Manager (ESG)",
    description: "Own the roadmap for an ESG reporting platform. Work with engineers on data pipelines, APIs and automation for sustainability disclosures.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Principal / Lead Product Manager",
    description: "Lead product teams that build software for public officers. Run product discovery, set the product roadmap and partner with engineers on cloud-native digital services.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Product Policy Manager / Lead",
    description: "Shape product policy for digital government services: data sharing rules, AI use guidelines and platform terms, working with product managers and engineers.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Product Lead - AI Stockbroking App",
    description: "Lead product for an AI-powered stockbroking app. Own the product roadmap for trading features and work with machine learning engineers and designers.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Technical Product Lead - AI Finance App",
    description: "Lead the technical product roadmap for an AI personal finance app. Work with backend engineers on APIs and with data scientists on recommendation models.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Corporate Transformation Director",
    description: "Lead the corporate transformation portfolio for an insurer: digital transformation, automation of operations and data-driven decision making across business units.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Lead, Transformation Portfolio & Strategic Initiatives",
    description: "Run the transformation portfolio and strategic initiatives office. Track technology transformation programmes, cloud migration and data platform milestones.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Securities Services Ops Transformation, Chief Product Owner",
    description: "Act as chief product owner for securities services operations transformation. Prioritise the backlog for automation, digital platforms and agile delivery squads.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Sr. Technical Program Manager",
    description: "Drive cross-functional technical programs across infrastructure and machine learning teams. Coordinate engineers, manage dependencies and land platform launches.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Regulatory & Controls Program Manager - Banking",
    description: "Manage a banking regulatory change programme: regulatory compliance remediation, controls automation and delivery of technology changes with engineering teams.",
    expected: ["LEGAL_REGTECH", "TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
];

const INVESTIGATION_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "Deputy / Assistant Director, Enforcement (Investigator)",
    description: "Investigate suspected breaches of securities law and market misconduct. Gather evidence, interview witnesses and recommend enforcement actions to the regulator's enforcement committee.",
    favouredLane: "INVESTIGATIONS_ENFORCEMENT",
    expected: ["INVESTIGATIONS_ENFORCEMENT"],
  },
  {
    title: "[ID] Manager, Investigation Department",
    description: "Lead investigations into offences under corporate and business registration statutes. Manage case officers, record statements and prepare cases for prosecution.",
    favouredLane: "INVESTIGATIONS_ENFORCEMENT",
    expected: ["INVESTIGATIONS_ENFORCEMENT"],
  },
  {
    title: "Investigation Officer",
    description: "Investigate employers for statutory non-compliance with contribution obligations. Interview parties, analyse records and recommend enforcement action or prosecution.",
    favouredLane: "INVESTIGATIONS_ENFORCEMENT",
    expected: ["INVESTIGATIONS_ENFORCEMENT"],
  },
  {
    title: "Financial Crime Investigator",
    description: "Investigate suspected money laundering, fraud and sanctions breaches. Prepare suspicious transaction reports and support law-enforcement requests.",
    favouredLane: "INVESTIGATIONS_ENFORCEMENT",
    expected: ["INVESTIGATIONS_ENFORCEMENT"],
  },
  {
    title: "Senior Fraud Investigator, Compliance",
    description: "Lead fraud investigations across payment channels, perform forensic analysis of transactions and escalate financial crime cases.",
    favouredLane: "INVESTIGATIONS_ENFORCEMENT",
    expected: ["INVESTIGATIONS_ENFORCEMENT"],
  },
];

const ENGINEERING_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "DevOps Engineering Lead (Vice President)",
    description: "Lead a DevOps team running CI/CD pipelines, Kubernetes clusters and infrastructure as code with Terraform on AWS and Azure for trading applications.",
    expected: ["CORE_AI_DATA", "INVESTMENT_MARKETS_FINTECH"],
  },
  {
    title: "Digital Software Engineer Senior Manager (Vice President)",
    description: "Manage software engineers building microservices and distributed systems for digital banking channels. Own system design, code quality and the SDLC.",
    expected: ["CORE_AI_DATA"],
  },
  {
    title: "SVP, Cloud Architect",
    description: "Own the cloud architecture of an exchange's capital markets platforms: hybrid cloud landing zones, Kubernetes, resilience and security for trading systems.",
    favouredLane: "INVESTMENT_MARKETS_FINTECH",
    expected: ["CORE_AI_DATA", "INVESTMENT_MARKETS_FINTECH"],
  },
  {
    title: "Technical Lead",
    description: "Lead the engineering squad of a digital wealth management platform. Design APIs and microservices for portfolio management and fund investing features.",
    favouredLane: "INVESTMENT_MARKETS_FINTECH",
    expected: ["INVESTMENT_MARKETS_FINTECH"],
  },
];

// Roles outside the target areas stay UNCLASSIFIED even with technology vocabulary.
const OUT_OF_SCOPE_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "Enterprise Sales Director",
    description: "Sell digital transformation, cloud and AI software to enterprise accounts and own the regional sales quota.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Senior Specialist Sales Engineer - Cloud",
    description: "Support account executives with cloud security demos, proofs of concept and Kubernetes integration questions.",
    favouredLane: "CORE_AI_DATA",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Brand Marketing Manager",
    description: "Own the brand campaigns for our digital products and work with product managers on launches.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Finance Manager",
    description: "Lead month-end close and budgeting for the technology transformation programme and software spend.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Principal Designer - AI Workflows & Processes",
    description: "Design AI-assisted workflows for public officers with product managers and engineers.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Store Loss Prevention Investigator",
    description: "Investigate shoplifting and fraud incidents in retail stores and support loss prevention programmes.",
    favouredLane: "INVESTIGATIONS_ENFORCEMENT",
    expected: ["UNCLASSIFIED"],
  },
];

describe("Target-lane registry contract", () => {
  it("registers eight target lanes and the lane-intent contract names the same keys", () => {
    const registry = yaml.load(
      fs.readFileSync(path.join(repoRoot, "config/lanes/registry.yml"), "utf8")
    ) as { lanes: Array<{ lane_key: string; config_file: string; enabled_by_default: boolean }> };
    const registryKeys = registry.lanes.map((lane) => lane.lane_key);

    expect([...registryKeys].sort()).toEqual([...TARGET_LANE_KEYS].sort());
    expect(Object.keys(config.lanes)).toEqual(registryKeys);
    for (const lane of registry.lanes) {
      const content = LaneFileConfigSchema.parse(
        yaml.load(fs.readFileSync(path.join(repoRoot, "config/lanes", lane.config_file), "utf8"))
      );
      expect(content.lane_key).toBe(lane.lane_key);
      expect(lane.lane_key).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
    }
    for (const laneKey of NEW_LANES) {
      const lane = config.lanes[laneKey];
      expect(lane.required_function_concepts?.length).toBeGreaterThan(0);
      expect(lane.included_domain_concepts?.length).toBeGreaterThan(0);
      expect(lane.prototype_query.length).toBeGreaterThan(50);
      expect(lane.maximum_ai_interpretations_per_run).toBeGreaterThan(0);
    }
  });

  it("keeps the Streamlit lane filter in step with the registry", () => {
    const streamlitContracts = fs.readFileSync(path.join(repoRoot, "streamlit_workspace_contracts.py"), "utf8");
    const block = streamlitContracts.match(/TARGET_LANE_KEYS = \(([\s\S]*?)\)/);
    expect(block).not.toBeNull();
    const pythonKeys = [...(block?.[1] ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
    const registry = yaml.load(
      fs.readFileSync(path.join(repoRoot, "config/lanes/registry.yml"), "utf8")
    ) as { lanes: Array<{ lane_key: string }> };
    expect(pythonKeys).toEqual(registry.lanes.map((lane) => lane.lane_key));

    const streamlitApp = fs.readFileSync(path.join(repoRoot, "streamlit_app.py"), "utf8");
    expect(streamlitApp).toContain('st.sidebar.selectbox("Filter Target Lane", list(LANE_FILTER_OPTIONS))');
  });

  it("accepts stored six-lane preferences unchanged and eight-lane preferences additively", () => {
    expect(LaneIntentPreferencesSchema.parse({ lane_weights: APPROVED_STAGE2_LANE_WEIGHTS }).lane_weights)
      .toEqual(APPROVED_STAGE2_LANE_WEIGHTS);

    const eightLane = LaneIntentPreferencesSchema.parse({
      lane_weights: { ...APPROVED_STAGE2_LANE_WEIGHTS, CORE_AI_DATA: 15, TECHNICAL_PRODUCT_TRANSFORMATION: 5, INVESTIGATIONS_ENFORCEMENT: 5 },
      lane_preferences: { INVESTIGATIONS_ENFORCEMENT: { preferred_role_families: ["REGULATORY_INVESTIGATOR"] } },
    });
    expect(eightLane.lane_weights.TECHNICAL_PRODUCT_TRANSFORMATION).toBe(5);
    expect(eightLane.lane_preferences.INVESTIGATIONS_ENFORCEMENT?.preferred_role_families).toEqual(["REGULATORY_INVESTIGATOR"]);

    expect(() => LaneIntentPreferencesSchema.parse({
      lane_weights: { ...APPROVED_STAGE2_LANE_WEIGHTS, TECHNICAL_PRODUCT_TRANSFORMATION: 5 },
    })).toThrow(/must total 100; received 105/);
    expect(() => LaneIntentPreferencesSchema.parse({
      lane_weights: APPROVED_STAGE2_LANE_WEIGHTS,
      lane_preferences: { NOT_A_LANE: {} },
    })).toThrow();
  });
});

describe("Lane title families", () => {
  it("approves product, programme and transformation titles only for the product lane family", () => {
    for (const title of [
      "Lead Product Manager (AGC)",
      "Product Policy Manager / Lead",
      "Securities Services Ops Transformation, Chief Product Owner",
      "Sr. Technical Program Manager",
      "Head, Technology Transformation",
      "Deputy Director - Digital Products & Platforms",
      "AI Portfolio Manager",
    ]) {
      expect(hasProductTransformationFunction(title), title).toBe(true);
    }
    for (const title of ["Portfolio Manager, Global Equities", "Brand Manager", "Senior Data Engineer", "Sales Director, Digital Transformation"]) {
      expect(hasProductTransformationFunction(title), title).toBe(false);
    }
  });

  it("approves investigator titles only for INVESTIGATIONS_ENFORCEMENT", () => {
    expect(hasInvestigationFunction("Deputy / Assistant Director, Enforcement (Investigator)")).toBe(true);
    expect(hasInvestigationFunction("Investigation Officer")).toBe(true);
    expect(hasInvestigationFunction("Forensic Accountant")).toBe(true);
    expect(hasInvestigationFunction("Fraud Analyst")).toBe(true);
    expect(hasInvestigationFunction("Fraud Detection Engineer")).toBe(false);
    expect(hasInvestigationFunction("Sales Investigator Liaison")).toBe(false);
    expect(hasApprovedLaneFunction("INVESTIGATIONS_ENFORCEMENT", "Financial Crimes Investigator")).toBe(true);
    for (const laneKey of ["CORE_AI_DATA", "LEGAL_REGTECH", "TECHNICAL_PRODUCT_TRANSFORMATION"]) {
      expect(hasApprovedLaneFunction(laneKey, "Financial Crimes Investigator")).toBe(false);
    }
  });

  it("treats finance as a role family but not as a product domain", () => {
    expect(hasNonTechnicalRoleFamily("Finance Manager")).toBe(true);
    expect(hasNonTechnicalRoleFamily("Head of Finance")).toBe(true);
    expect(hasNonTechnicalRoleFamily("VP, Finance")).toBe(true);
    expect(hasNonTechnicalRoleFamily("Technical Product Lead - AI Finance")).toBe(false);
    expect(hasNonTechnicalRoleFamily("Technical Product Lead - AI Finance App")).toBe(false);
    expect(hasNonTechnicalRoleFamily("Engineer, Finance Platform")).toBe(false);
  });
});

describe("Routing evidence text", () => {
  it("keeps the role description after an About Us block that ends at a bare heading", () => {
    const text = extractCoreJobText(
      "Senior Applied Engineer",
      "About Us\nWe are a physics AI company.\nWhat You Will Do\n- Deploy machine learning models for engineering simulation.\nRequirements\n- Python and PyTorch.",
    );
    expect(text).toContain("Deploy machine learning models");
    expect(text).toContain("Python and PyTorch");
  });

  it("still drops a boilerplate section that runs to the end of the description", () => {
    const text = extractCoreJobText("Data Engineer", "Build data pipelines.\nBenefits:\nhealthcare coverage and paid leave for you and your family.");
    expect(text).toContain("Build data pipelines");
    expect(text).not.toContain("healthcare coverage");
  });

  it("removes employee-benefit and recruitment-scam phrases from scope evidence", () => {
    const scrubbed = stripEmployerBoilerplatePhrases(
      "Generous healthcare coverage, support for your mental health, and how to avoid recruitment fraud."
    ).toLowerCase();
    expect(scrubbed).not.toMatch(/healthcare|mental health|fraud/);
  });
});

describe("Target-lane routing fixtures", () => {
  const cases = [
    ...TECHNICAL_PRODUCT_FIXTURES,
    ...INVESTIGATION_FIXTURES,
    ...ENGINEERING_FIXTURES,
    ...OUT_OF_SCOPE_FIXTURES,
  ];

  it.each(cases.map((fixture) => [fixture.title, fixture] as const))("routes %s", (_title, fixture) => {
    const result = route(fixture.title, fixture.description, fixture.favouredLane);
    expect(fixture.expected, result.laneEvidence.join(" | ")).toContain(result.primaryLane);
    if (result.primaryLane === "UNCLASSIFIED") {
      expect(result.processingStatus).toBe("UNMATCHED");
      expect(result.laneEvidence[0]).toBe("ROUTING_POLICY_NO_MATCH");
      expect(result.laneEvidence).toContain("NO_ACTIVE_LANE_MATCH");
    } else {
      expect(result.processingStatus).toBe("LANE_ROUTED");
      expect(result.laneEvidence).toContain(`${result.primaryLane}:domain_score=1.000`);
      expect(result.laneEvidence).toContain(`${result.primaryLane}:function_score=1.000`);
    }
  });

  it("routes a long description on scope terms after the first 2,000 characters", () => {
    const filler = "The team values clear written communication and ownership. ".repeat(40);
    const result = route(
      "Assistant Director (Cloud Platforms)",
      `${filler}\nYou will run Kubernetes and hybrid cloud platforms with infrastructure as code.`,
    );
    expect(filler.length).toBeGreaterThan(2000);
    expect(result.primaryLane).toBe("CORE_AI_DATA");
  });

  it("does not let benefits or recruitment-scam boilerplate create a health or regtech domain", () => {
    const result = route(
      "Principal Software Engineer",
      "Build microservices and distributed systems for merchant checkout. Benefits include healthcare coverage and support for your mental health. Learn how to avoid recruitment fraud on our careers site.",
      "HEALTH_BIO_PHARMA",
    );
    expect(result.domainScores.HEALTH_BIO_PHARMA).toBe(0);
    expect(result.domainScores.LEGAL_REGTECH).toBe(0);
    expect(result.primaryLane).toBe("CORE_AI_DATA");
  });

  it("keeps the semantic minimum binding: a lane below its threshold never routes", () => {
    const fixture = INVESTIGATION_FIXTURES[0];
    const result = routeLaneCandidates({
      config,
      title: fixture.title,
      descriptionText: fixture.description,
      semanticScore: (laneKey) => (laneKey === "INVESTIGATIONS_ENFORCEMENT" ? 0.2 : 0.1),
    });
    expect(result.primaryLane).toBe("UNCLASSIFIED");
    expect(result.laneEvidence.join(" ")).toContain("INVESTIGATIONS_ENFORCEMENT:blocked_by=semantic:0.200<0.350");
  });
});
