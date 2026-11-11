import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  extractCoreJobText,
  hasApprovedLaneFunction,
  hasInvestigationFunction,
  hasNonTechnicalProjectSubject,
  hasNonTechnicalRoleFamily,
  hasProductTransformationFunction,
  isRegulatorEmployer,
  legalFintechTieBreak,
  loadLanesConfig,
  matchedSector,
  matchedDomainSignals,
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

const PUBLIC_SECTOR_ABOUT = "About Us\nWe build digital government services and platforms for public agencies.\n";

const TECHNICAL_PRODUCT_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "Lead Product Manager, Legal Platforms",
    description: `${PUBLIC_SECTOR_ABOUT}What You Will Do\n- Own the product roadmap for a case-management platform used by public prosecutors.\n- Lead discovery with officers and work with engineers and designers to ship software every sprint.\n- Define success metrics and prioritise the backlog with agile delivery teams.`,
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Lead Product Manager, Courts Platform",
    description: `${PUBLIC_SECTOR_ABOUT}The Role\n- Lead a product team building digital court services.\n- Shape the product roadmap with engineering teams, designers and court administrators.\n- Use data to improve SaaS and in-house digital products.`,
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
    description: "Own the roadmap for an ESG reporting platform used by government agencies. Work with engineers on data pipelines and cloud-native APIs for sustainability disclosures.",
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
    description: "Lead the corporate transformation portfolio for an insurer: digital transformation, cloud migration and data-driven decision making across business units.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Lead, Transformation Portfolio & Strategic Initiatives",
    description: "Run the transformation portfolio and strategic initiatives office at a life insurer. Track technology transformation programmes, cloud migration and data platform milestones.",
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
    description: "Drive cross-functional technical programs at a consumer technology company across infrastructure and machine learning teams. Coordinate software engineering and data center teams, manage dependencies and land platform launches.",
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

// The user's LEGAL_REGTECH / INVESTMENT_MARKETS_FINTECH rule: banking or fintech in the title or
// employer context routes to FINTECH; pure regulatory technology at a regulatory body or a
// legal-tech company routes to LEGAL_REGTECH. Embedding scores are equal, so only the rule decides.
const SECTOR_TIE_BREAK_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "Legal Engineer, Product Specialist",
    description: "We build a legal AI platform used by law firms and in-house legal teams. You will design legal workflows on the platform with software engineers, configure document intelligence features and train lawyers on adoption.",
    expected: ["LEGAL_REGTECH"],
  },
  {
    title: "Technology Manager",
    description: "We are a digital bank and fintech serving millions of customers. Lead the engineering team that owns our financial crime and KYC platforms, run delivery of microservices and own system design decisions.",
    expected: ["INVESTMENT_MARKETS_FINTECH"],
  },
  {
    title: "Head of Regulatory Reporting IT, Banking",
    description: "Lead the IT applications team that delivers regulatory reporting systems for a universal bank: regulatory change, data pipelines, AML reporting feeds and technical delivery with software engineers.",
    expected: ["INVESTMENT_MARKETS_FINTECH"],
  },
  {
    title: "RegTech Engineer",
    description: "Join the regulatory authority's supervisory technology team. Build compliance automation and AML/KYC analytics that supervisors use to review banks, using Python data pipelines and software engineering practices.",
    expected: ["LEGAL_REGTECH"],
  },
  {
    // AI work at a financial regulator without regtech/legal wording stays CORE_AI_DATA, even
    // though the posting mentions banks and the embedding favours FINTECH.
    title: "Deputy Director, AI Development",
    description: "Join the financial regulator's technology division. Build the machine learning platform and LLM applications used across the authority, run MLOps pipelines and evaluate generative AI models; our work touches banks and financial institutions across the market.",
    favouredLane: "INVESTMENT_MARKETS_FINTECH",
    expected: ["CORE_AI_DATA"],
  },
];

// TECHNICAL_PRODUCT_TRANSFORMATION in the sectors of the other lanes...
const IN_SECTOR_PRODUCT_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "Transformation Manager, Technology Programme",
    description: "Lead a technology transformation programme at a retail bank: cloud migration of core banking systems, data pipelines for the risk function and agile delivery with engineering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Digital Product Manager",
    description: "Own digital products for a pharmaceutical company's medical affairs teams. Work with engineering teams on a cloud-native platform and with data scientists on content recommendations.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Product Manager, Clinical Data Platform",
    description: "Own the clinical data platform for a hospital group: data pipelines from electronic medical records, a cloud-native analytics layer and roadmap delivery with engineering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Technical Programme Manager, Payments Modernisation",
    description: "Run the bank's payments modernisation programme: cloud migration of payment engines, apis and integrations with card schemes, and agile delivery with software engineers.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Product Owner, Contract Analytics",
    description: "Own a legal technology product for law firms: contract analytics with machine learning engineers, data pipelines for clause extraction and a saas platform roadmap.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Digital Transformation Lead",
    description: "Lead digital transformation for a government agency: digital services for citizens, cloud migration of case systems and data pipelines with engineering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
  {
    title: "Product Lead, Legal Technology",
    description: "Lead legal technology products for a government ministry's legal service: case-management platform roadmap, software engineers and data pipelines for court filings.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["TECHNICAL_PRODUCT_TRANSFORMATION"],
  },
];

// ...but not outside them, even with the same technology vocabulary. The last four are
// in-sector employers whose project is not technology work.
const OUT_OF_SECTOR_PRODUCT_FIXTURES: readonly RoutingFixture[] = [
  {
    title: "Project Manager, Hospital Redevelopment",
    description: "Deliver the redevelopment of a hospital wing for a construction contractor: construction works, subcontractors and handover. Use the digital platform for site reporting and the cloud platform for document control; track data analytics dashboards.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Programme Manager, Campus Estates",
    description: "Run the university's campus estates programme: facilities management, cleaning contracts and maintenance. Roll out a room-booking digital platform and data analytics dashboards for space use.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Events Programme Manager",
    description: "Plan the non-profit's galas and donor events. Promote events through digital channels, use data analytics for donor segmentation and manage venues and suppliers.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Project Manager, Office Fit-out",
    description: "Manage the law firm's office fit-out: contractors, furniture, moves and budget. Coordinate the digital platform for move bookings and the cloud platform for floor plans with the IT team.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Digital Transformation Manager",
    description: "Lead digital transformation for a luxury hotel group: cloud migration of property systems, data pipelines for guest analytics and agile delivery with engineering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Technology Programme Manager, Construction",
    description: "Run the construction firm's site technology programme: cloud migration of project systems, data pipelines from site sensors and software development with engineering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "E-commerce Product Owner",
    description: "Own the online store for a homeware retailer: cloud-native storefront, data pipelines for merchandising and agile delivery with engineering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Digital Product Manager, Fashion",
    description: "Lead digital products for a fashion house's online boutique: product roadmap, cloud migration of the storefront, data pipelines for collections and engineering teams across studios.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
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
    // Banking in the employer context: the sector rule routes it to FINTECH ahead of CORE_AI_DATA.
    expected: ["INVESTMENT_MARKETS_FINTECH"],
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
    title: "Project Manager",
    description: "Deliver a mid-rise residential construction project: site programme, subcontractors and budget. Use scheduling software, run agile stand-ups with site teams and track automation of daily reports.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Programme Manager, Events",
    description: "Run the hotel events programme: weddings, conferences and banqueting. Manage booking software and automation tools for confirmations, and coordinate venue and catering teams.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Product Owner, Private Label Apparel",
    description: "Own the private-label apparel range: trend research, supplier sampling, pricing and in-store launches. Work with the API team occasionally on product data feeds for the online store.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Campaign Manager, Marketing",
    description: "Plan and run multichannel campaigns, manage agencies and budgets, and use marketing automation software to report performance to the product team.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Facilities Project Manager",
    description: "Manage office fit-outs and building maintenance projects, vendors and health-and-safety compliance. Oversee building automation systems and facilities software upgrades.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "HR Transformation Lead",
    description: "Lead the HR transformation programme: operating model redesign, HRIS software rollout, agile ways of working and automation of payroll processes.",
    favouredLane: "TECHNICAL_PRODUCT_TRANSFORMATION",
    expected: ["UNCLASSIFIED"],
  },
  {
    title: "Transformation Manager, Retail Operations",
    description: "Lead store operations transformation: layout changes, staffing models and supplier processes, with occasional software and automation pilots.",
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
      "Lead Product Manager, Legal Platforms",
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

describe("Technical product lane domain signals", () => {
  const lane = config.lanes.TECHNICAL_PRODUCT_TRANSFORMATION;

  it("needs two distinct technology, data or AI phrases", () => {
    expect(lane.minimum_domain_signals).toBe(2);
    expect(matchedDomainSignals("scheduling software, agile stand-ups, the api team and automation tools", lane.included_domain_concepts)).toEqual([]);
    expect(matchedDomainSignals("cloud migration and data pipelines for the platform", lane.included_domain_concepts))
      .toEqual(["cloud migration", "data pipelines"]);
  });

  it("does not count a phrase contained in a longer matched phrase twice", () => {
    expect(matchedDomainSignals("we run cloud platforms", lane.included_domain_concepts)).toEqual(["cloud platforms"]);
  });
});

describe("Sector rules", () => {
  it("applies the LEGAL_REGTECH / FINTECH tie-break in its documented order", () => {
    expect(legalFintechTieBreak("Head of Regulatory Reporting IT, Banking", "A regulator", "")).toBe("INVESTMENT_MARKETS_FINTECH");
    expect(legalFintechTieBreak("RegTech Engineer", "", "Join the regulatory authority, which supervises banks.")).toBe("LEGAL_REGTECH");
    expect(legalFintechTieBreak("Legal Engineer", "", "A legal AI platform for law firms.")).toBe("LEGAL_REGTECH");
    expect(legalFintechTieBreak("Technology Manager", "", "We are a digital bank and fintech.")).toBe("INVESTMENT_MARKETS_FINTECH");
    expect(legalFintechTieBreak("Compliance Engineer", "", "We build compliance software.")).toBeNull();
  });

  it("keeps a regulator's AI role out of FINTECH unless the title names banking or fintech", () => {
    expect(isRegulatorEmployer("", "Join the financial regulator's technology division.")).toBe(true);
    expect(isRegulatorEmployer("A Digital Bank", "We are a digital bank.")).toBe(false);
    expect(isRegulatorEmployer("A Hedge Fund", "An asset manager regulated by the monetary authority.")).toBe(false);
    const regulatorAi = SECTOR_TIE_BREAK_FIXTURES.find((f) => f.title === "Deputy Director, AI Development")!;
    const result = route(regulatorAi.title, regulatorAi.description, regulatorAi.favouredLane);
    expect(result.primaryLane).toBe("CORE_AI_DATA");
    expect(result.laneEvidence).toContain("SECTOR_REGULATOR_EMPLOYER:CORE_AI_DATA_OVER_INVESTMENT_MARKETS_FINTECH");

    const bankingTitle = route("AI Engineer, Banking Supervision Platforms", regulatorAi.description, "INVESTMENT_MARKETS_FINTECH");
    expect(bankingTitle.primaryLane).toBe("INVESTMENT_MARKETS_FINTECH");
    const investmentTitle = route("Lead Data Architect (Investment Management)", `${regulatorAi.description} Support portfolio management and asset management data.`, "INVESTMENT_MARKETS_FINTECH");
    expect(investmentTitle.primaryLane).toBe("INVESTMENT_MARKETS_FINTECH");
  });

  it("records the tie-break and the matched sector as evidence", () => {
    const tieBreak = route(SECTOR_TIE_BREAK_FIXTURES[1].title, SECTOR_TIE_BREAK_FIXTURES[1].description);
    expect(tieBreak.laneEvidence).toContain("SECTOR_TIE_BREAK:INVESTMENT_MARKETS_FINTECH_OVER_LEGAL_REGTECH");
    const product = route(IN_SECTOR_PRODUCT_FIXTURES[0].title, IN_SECTOR_PRODUCT_FIXTURES[0].description, "TECHNICAL_PRODUCT_TRANSFORMATION");
    expect(product.laneEvidence.some((e) => e.startsWith("TECHNICAL_PRODUCT_TRANSFORMATION:sector=") && e.includes("bank"))).toBe(true);
  });

  it("requires one of the other lanes' sectors for TECHNICAL_PRODUCT_TRANSFORMATION", () => {
    const sectors = config.lanes.TECHNICAL_PRODUCT_TRANSFORMATION.required_sector_concepts;
    expect(sectors).toHaveLength(7);
    expect(matchedSector("a luxury hotel group and a fashion house", sectors)).toEqual([]);
    expect(matchedSector("a pharmaceutical company", sectors)).toEqual(["pharmaceutical"]);
  });

  it("excludes non-technical project subjects from the product lane", () => {
    expect(hasNonTechnicalProjectSubject("Project Manager, Hospital Redevelopment", "")).toBe(true);
    expect(hasNonTechnicalProjectSubject("Events Programme Manager", "")).toBe(true);
    expect(hasNonTechnicalProjectSubject("Project Manager", "manage the office fit-out and moves")).toBe(true);
    // A technical qualifier in the title keeps scope mentions of facilities from excluding the role.
    expect(hasNonTechnicalProjectSubject("Technical Programme Manager", "migrate facilities management systems to the cloud")).toBe(false);
    expect(hasNonTechnicalProjectSubject("Project Manager", "deliver cloud migration and data pipelines for the bank")).toBe(false);
  });

  it("reads the product-lane sector from the job's own scope, not the employer's About Us", () => {
    const sectors = config.lanes.TECHNICAL_PRODUCT_TRANSFORMATION.required_sector_concepts;
    expect(matchedSector("a university and an academic environment", sectors)).toEqual([]);
    const aboutOnly = route(
      "Digital Transformation Manager",
      "About Us\nWe are a leading bank.\nThe Role\nLead digital transformation for our hotel portfolio: cloud migration of property systems and data pipelines with engineering teams.",
      "TECHNICAL_PRODUCT_TRANSFORMATION",
    );
    expect(aboutOnly.primaryLane).toBe("UNCLASSIFIED");
  });

  it("treats a technology-adjacent director or head as a product-lane title", () => {
    expect(hasProductTransformationFunction("Deputy Director, Digital Platforms")).toBe(true);
    expect(hasProductTransformationFunction("Head of Technology")).toBe(true);
    expect(hasProductTransformationFunction("Director of Catering")).toBe(false);
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
    ...SECTOR_TIE_BREAK_FIXTURES,
    ...IN_SECTOR_PRODUCT_FIXTURES,
    ...OUT_OF_SECTOR_PRODUCT_FIXTURES,
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
