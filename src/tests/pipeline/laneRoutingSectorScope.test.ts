import { describe, expect, it } from "vitest";

import {
  extractEmployerContextText,
  loadLanesConfig,
  routeLaneCandidates,
  stripEmployerBoilerplatePhrases,
  stripIndustryLists,
} from "../../pipeline/laneRouter.js";

const config = loadLanesConfig();

/**
 * Production lane similarities sit in a narrow 0.50-0.70 band above every semantic minimum, so
 * the deterministic domain, function and sector checks decide eligibility. The favoured lane
 * scores 0.62 and every other lane 0.55. All employers and postings are synthetic.
 */
function route(title: string, description: string, companyName: string, favouredLane?: string) {
  return routeLaneCandidates({
    config,
    title,
    descriptionText: description,
    companyName,
    semanticScore: (laneKey) => (laneKey === favouredLane ? 0.62 : 0.55),
  });
}

const BENEFITS_SENTENCE =
  "We offer a competitive salary and comprehensive benefit offerings such as medical, dental, and flexible time off.";

const LOGISTICS_IDENTITY_ENGINEER = [
  "About Us",
  "Example Freight Co is a global logistics platform that moves freight for importers and exporters across a global supply chain.",
  "What You Will Do",
  "- Own identity and access management for the workforce: SSO, MFA, SCIM provisioning and role-based access.",
  "- Run our identity provider on cloud infrastructure with Terraform and AWS, and automate joiner-mover-leaver workflows.",
  "- Partner with security engineering on least-privilege access reviews.",
  BENEFITS_SENTENCE,
  "Example Freight Co is an equal opportunity employer and does not discriminate on the basis of race, religion, health status or medical condition.",
].join("\n");

const RETAIL_BACKEND_ENGINEER = [
  "About Us",
  "Example Stores is a retail chain with 400 retail stores and a growing online shop.",
  "The Role",
  "- Build backend services and microservices for checkout, inventory and store operations.",
  "- Run services on our cloud platform with Kubernetes, CI/CD and infrastructure as code.",
  "- Improve reliability, observability and performance of our APIs.",
  BENEFITS_SENTENCE,
].join("\n");

const RETAIL_ML_ENGINEER = [
  "About Us",
  "Example Stores is a retail chain with 400 retail stores and a growing online shop.",
  "The Role",
  "- Build machine learning models for demand forecasting and product recommendations.",
  "- Own the feature store, model training pipelines and MLOps on our data platform.",
  "- Deploy deep learning models to production with the data engineering team.",
].join("\n");

const PHARMA_FULL_STACK_ENGINEER = [
  "Example Lifecare is a global pharmaceutical and medical technology company.",
  "About Us",
  "We discover and develop medicines and medical devices used by millions of patients worldwide.",
  "What You Will Do",
  "- Build full-stack web applications with React, TypeScript and Node.js.",
  "- Design REST and GraphQL APIs and deploy them on a cloud platform.",
  "- Write automated tests and review code with a team of software engineers.",
  BENEFITS_SENTENCE,
].join("\n");

const HOSPITAL_DATA_PLATFORM_ENGINEER = [
  "About Us",
  "Example General Hospital is a public hospital and academic health system serving 1 million patients a year.",
  "The Role",
  "- Build the data platform that brings EHR, laboratory and imaging data together for clinicians.",
  "- Develop data pipelines and a lakehouse for clinical data with dbt, Spark and Airflow.",
  "- Work with clinical informatics teams on data quality and patient data privacy.",
].join("\n");

const FEDERAL_HEALTHCARE_SALESFORCE_ARCHITECT = [
  "Example Federal Consulting delivers technology programs for government clients.",
  "The Role",
  "- Provide technical leadership, solution design and architecture oversight for a large federal healthcare modernization program.",
  "- Define the enterprise Salesforce architecture, data model and integration patterns for the platform.",
  "- Lead Salesforce developers through design reviews and release planning.",
  "Preferred qualifications: experience supporting federal healthcare or health IT initiatives.",
].join("\n");

const GAMING_BACKEND_ENGINEER = [
  "About Us",
  "Example Games is a game studio making online multiplayer video games for 50 million players.",
  "What You Will Do",
  "- Build backend services for matchmaking and player accounts on a cloud platform.",
  "- Scale our APIs and microservices with Kubernetes and infrastructure as code.",
  "Benefits",
  "Health insurance, a wellness stipend, dental and vision coverage, and generous paid time off.",
  "We care about work-life balance and mental health.",
].join("\n");

describe("Sector scope: user fixtures", () => {
  it("routes a logistics company's identity engineer to UNCLASSIFIED, not HEALTH_BIO_PHARMA", () => {
    const result = route(
      "Senior Systems Engineer (Identity and Access)",
      LOGISTICS_IDENTITY_ENGINEER,
      "Example Freight Co",
      "HEALTH_BIO_PHARMA"
    );
    expect(result.primaryLane).toBe("UNCLASSIFIED");
    expect(result.domainScores.HEALTH_BIO_PHARMA).toBe(0);
    expect(result.laneEvidence).toContain("HEALTH_BIO_PHARMA:sector_missing");
    expect(result.laneEvidence.some((e) => e.startsWith("CORE_AI_DATA:excluded_sector="))).toBe(true);
  });

  it("does not route a generic engineering role to HEALTH_BIO_PHARMA on medical/dental benefits alone", () => {
    const description = [
      "The Role",
      "- Own identity and access management: SSO, MFA and SCIM provisioning on cloud infrastructure.",
      BENEFITS_SENTENCE,
    ].join("\n");
    const result = route("Senior Systems Engineer", description, "Example Systems", "HEALTH_BIO_PHARMA");
    expect(result.primaryLane).not.toBe("HEALTH_BIO_PHARMA");
    expect(result.domainScores.HEALTH_BIO_PHARMA).toBe(0);
  });

  it("routes a retail chain's backend engineer to UNCLASSIFIED", () => {
    const result = route("Senior Backend Engineer", RETAIL_BACKEND_ENGINEER, "Example Stores", "CORE_AI_DATA");
    expect(result.primaryLane).toBe("UNCLASSIFIED");
    expect(result.laneEvidence).toContain("CORE_AI_DATA:excluded_sector=retail chain|retail stores");
  });

  it("keeps a retail chain's machine learning engineer in CORE_AI_DATA (AI/data role exemption)", () => {
    const result = route("Machine Learning Engineer", RETAIL_ML_ENGINEER, "Example Stores", "CORE_AI_DATA");
    expect(result.primaryLane).toBe("CORE_AI_DATA");
    expect(result.laneEvidence.some((e) => e.startsWith("CORE_AI_DATA:sector_exempt="))).toBe(true);
  });

  it("keeps a retail chain's AI/data work in CORE_AI_DATA when the scope has three AI/data phrases", () => {
    const result = route("Senior Software Engineer", RETAIL_ML_ENGINEER, "Example Stores", "CORE_AI_DATA");
    expect(result.primaryLane).toBe("CORE_AI_DATA");
  });

  it("routes a pharma/medtech company's generic full-stack engineer to HEALTH_BIO_PHARMA", () => {
    const result = route(
      "Senior Full Stack Engineer",
      PHARMA_FULL_STACK_ENGINEER,
      "Example Lifecare",
      "HEALTH_BIO_PHARMA"
    );
    expect(result.primaryLane).toBe("HEALTH_BIO_PHARMA");
    const sector = result.laneEvidence.find((e) => e.startsWith("HEALTH_BIO_PHARMA:sector="));
    expect(sector).toContain("pharmaceutical");
    expect(sector).toContain("medical technology");
  });

  it("routes a hospital's data platform engineer to HEALTH_BIO_PHARMA", () => {
    const result = route(
      "Data Platform Engineer",
      HOSPITAL_DATA_PLATFORM_ENGINEER,
      "Example General Hospital",
      "HEALTH_BIO_PHARMA"
    );
    expect(result.primaryLane).toBe("HEALTH_BIO_PHARMA");
    const sector = result.laneEvidence.find((e) => e.startsWith("HEALTH_BIO_PHARMA:sector="));
    expect(sector).toContain("hospital");
    expect(sector).toContain("ehr");
  });

  it("routes a federal-healthcare Salesforce architect to HEALTH_BIO_PHARMA", () => {
    const result = route(
      "Salesforce Solutions Architect",
      FEDERAL_HEALTHCARE_SALESFORCE_ARCHITECT,
      "Example Federal Consulting",
      "HEALTH_BIO_PHARMA"
    );
    expect(result.primaryLane).toBe("HEALTH_BIO_PHARMA");
    expect(result.laneEvidence).toContain("HEALTH_BIO_PHARMA:sector=healthcare");
  });

  it("does not route a gaming company's engineer to HEALTH_BIO_PHARMA on a health-insurance benefit", () => {
    const result = route("Backend Engineer", GAMING_BACKEND_ENGINEER, "Example Games", "HEALTH_BIO_PHARMA");
    expect(result.primaryLane).not.toBe("HEALTH_BIO_PHARMA");
    expect(result.primaryLane).toBe("UNCLASSIFIED");
    expect(result.domainScores.HEALTH_BIO_PHARMA).toBe(0);
  });
});

describe("Sector scope: review regressions (PR #179) stay in scope", () => {
  it("routes a health insurer's claims-data platform engineer to HEALTH_BIO_PHARMA", () => {
    const description = [
      "Example Health Plan is a health insurer serving 2 million members.",
      "The Role",
      "- Build pipelines for claims and member data on our cloud platform.",
      "- Own the platform services that provider and care-management teams depend on.",
      BENEFITS_SENTENCE,
    ].join("\n");
    const result = route("Platform Engineer, Claims Data", description, "Example Health Plan", "HEALTH_BIO_PHARMA");
    expect(result.primaryLane).toBe("HEALTH_BIO_PHARMA");
    expect(result.laneEvidence.find((e) => e.startsWith("HEALTH_BIO_PHARMA:sector="))).toContain("health insurer");
  });

  it("keeps 'a health insurance company' in the employer description as a health signal", () => {
    const description = [
      "About Us",
      "Example Cover is a health insurance company for families and employers.",
      "The Role",
      "- Build pipelines for claims and member data on our cloud platform.",
    ].join("\n");
    const result = route("Platform Engineer, Claims Data", description, "Example Cover", "HEALTH_BIO_PHARMA");
    expect(result.primaryLane).toBe("HEALTH_BIO_PHARMA");
    expect(result.laneEvidence.find((e) => e.startsWith("HEALTH_BIO_PHARMA:sector="))).toContain("health insurance company");
  });

  it("routes a hospital group's systems engineer with no clinical wording to HEALTH_BIO_PHARMA", () => {
    const description = [
      "About Us",
      "Example Healthcare Group operates five hospitals in Singapore.",
      "The Role",
      "- Maintain servers, networks, identity and backups for our sites.",
      "- Automate infrastructure with scripts and configuration management.",
    ].join("\n");
    const result = route("Systems Engineer", description, "Example Healthcare Group", "HEALTH_BIO_PHARMA");
    expect(result.primaryLane).toBe("HEALTH_BIO_PHARMA");
    expect(result.domainScores.HEALTH_BIO_PHARMA).toBe(1);
  });

  it("routes a travel-insurance insurtech's backend engineer to INVESTMENT_MARKETS_FINTECH, not UNCLASSIFIED", () => {
    const description = [
      "About Us",
      "Example Assure is an insurtech offering travel insurance and payments to airlines and travel companies.",
      "The Role",
      "- Build backend services for policy purchase, card payments and claims payouts.",
      "- Run our services on a cloud platform with Kubernetes.",
    ].join("\n");
    const result = route("Senior Backend Engineer, Payments", description, "Example Assure", "INVESTMENT_MARKETS_FINTECH");
    expect(result.primaryLane).toBe("INVESTMENT_MARKETS_FINTECH");
    expect(result.laneEvidence.some((e) => e.includes("excluded_sector="))).toBe(false);
  });

  it("keeps 'pension plan administration' as role substance, not a perk clause", () => {
    const text = "experience in pension plan administration or financial services industry experience using azure devops for test management";
    expect(stripEmployerBoilerplatePhrases(text)).toContain("azure devops");
    expect(stripEmployerBoilerplatePhrases("we offer a pension plan, dental cover and paid time off")).not.toContain("dental");
  });

  it("routes a health-and-wellbeing provider's QA analyst to HEALTH_BIO_PHARMA", () => {
    const description = [
      "Example Health is a global-leading health and well-being provider improving health outcomes for millions.",
      "The Role",
      "- Test our pension and benefits administration software and track defects in Azure DevOps.",
      "- Experience in pension plan administration is an asset.",
    ].join("\n");
    const result = route("Quality Assurance Analyst", description, "Example Health", "HEALTH_BIO_PHARMA");
    expect(result.primaryLane).toBe("HEALTH_BIO_PHARMA");
  });

  it("documents the known false negative: a game studio engineer with only two AI/data phrases", () => {
    const description = [
      "About Us",
      "Example Games is a game studio making video games.",
      "The Role",
      "- Build machine learning models on our data platform.",
    ].join("\n");
    const result = route("Senior Engineer", description, "Example Games", "CORE_AI_DATA");
    expect(result.primaryLane).toBe("UNCLASSIFIED");
  });

  it("still treats 'travel insurance' in a perk clause as a benefit", () => {
    const description = [
      "About Us",
      "Example Games is a game studio making video games.",
      "The Role",
      "- Build backend services on a cloud platform with Kubernetes.",
      "We offer dental cover, travel insurance and paid time off.",
    ].join("\n");
    const result = route("Backend Engineer", description, "Example Games", "INVESTMENT_MARKETS_FINTECH");
    expect(result.primaryLane).toBe("UNCLASSIFIED");
  });
});

describe("Sector scope: benefit, perk and EEO words are never health signals", () => {
  // Each phrase sits in an otherwise generic engineering posting at an employer of unknown sector.
  const BOILERPLATE_PHRASES = [
    "We provide health insurance for you and your family.",
    "Medical benefits start on day one.",
    "Enjoy our wellness program and a monthly wellness stipend.",
    "We invest in employee wellbeing.",
    "Dental and vision coverage are included.",
    "Medical, dental and vision plans for all staff.",
    "Private healthcare and a multisport card.",
    "Healthcare, 401(k) matching and paid time off.",
    "You will follow our health and safety policies.",
    "Occupational health support is available.",
    "We value work-life balance.",
    "You will escalate issues to customer care.",
    "Be patient and curious when debugging.",
    "Join our innovation lab.",
    "Include a short biography with your application.",
    "We support your mental health.",
    "Life insurance and a pension plan.",
    "We do not discriminate on the basis of health status, medical condition or genetic information.",
    "Medical leave and parental leave are available.",
  ];

  it.each(BOILERPLATE_PHRASES)("ignores: %s", (phrase) => {
    const description = [
      "The Role",
      "- Build backend services and REST APIs on a cloud platform with Kubernetes.",
      "- Improve CI/CD pipelines and observability.",
      phrase,
    ].join("\n");
    const result = route("Senior Software Engineer", description, "Example Systems", "HEALTH_BIO_PHARMA");
    expect(result.domainScores.HEALTH_BIO_PHARMA).toBe(0);
    expect(result.primaryLane).not.toBe("HEALTH_BIO_PHARMA");
  });
});

describe("Sector scope: evidence text", () => {
  it("removes a benefits enumeration without a following insurance/coverage word", () => {
    const stripped = stripEmployerBoilerplatePhrases(BENEFITS_SENTENCE.toLowerCase());
    expect(stripped).not.toMatch(/medical|dental/);
  });

  it("keeps clinical role text that is not a benefits clause", () => {
    const text = "build the data platform for clinical data and patient records.";
    expect(stripEmployerBoilerplatePhrases(text)).toBe(text);
  });

  it("removes industry lists naming another industry but keeps health-only lists", () => {
    expect(stripIndustryLists("industries like finance, manufacturing, defense, healthcare, and the public sector run"))
      .not.toContain("healthcare");
    expect(stripIndustryLists("critical infrastructure including medical devices, power grids and telecommunication networks"))
      .not.toContain("medical devices");
    expect(stripIndustryLists("work with clinicians, nurses and patients across the hospital"))
      .toBe("work with clinicians, nurses and patients across the hospital");
  });

  it("reads the employer context from the opening and About Us, never from a Benefits section", () => {
    const description = [
      "The Role",
      "- Build backend services.",
      "About Us",
      "We are a medical technology company.",
      "Benefits",
      "Hospital cash plan and private healthcare.",
    ].join("\n");
    const context = extractEmployerContextText("Example Co", description);
    expect(context).toContain("medical technology company");
    expect(context).not.toContain("hospital");
    expect(context).not.toContain("private healthcare");
  });

  it("does not let an industry served by the employer make it a health employer", () => {
    const description = [
      "About Us",
      "Example AI builds AI systems for customers in finance, manufacturing, defense, healthcare, and the public sector.",
      "The Role",
      "- Build backend services on a cloud platform with Kubernetes.",
    ].join("\n");
    const result = route("Senior Backend Engineer", description, "Example AI", "HEALTH_BIO_PHARMA");
    expect(result.primaryLane).not.toBe("HEALTH_BIO_PHARMA");
  });
});

describe("Sector scope: other lanes", () => {
  it("routes a logistics company's security engineer to UNCLASSIFIED instead of LEGAL_REGTECH", () => {
    const description = [
      "About Us",
      "Example Freight Co is a global logistics platform for freight forwarding.",
      "What You Will Do",
      "- Detect and respond to threats, investigate fraud and account-takeover attempts.",
      "- Build detection rules and automation on cloud infrastructure.",
    ].join("\n");
    const result = route("Senior Security Engineer, Detection & Response", description, "Example Freight Co", "LEGAL_REGTECH");
    expect(result.primaryLane).toBe("UNCLASSIFIED");
    expect(result.laneEvidence.some((e) => e.startsWith("LEGAL_REGTECH:excluded_sector="))).toBe(true);
  });

  it("keeps a fintech for restaurants in INVESTMENT_MARKETS_FINTECH (a covered sector overrides)", () => {
    const description = [
      "About Us",
      "Example Pay is a fintech providing payments and banking for restaurants and hospitality businesses.",
      "The Role",
      "- Build backend services for card payments and merchant banking on a cloud platform.",
    ].join("\n");
    const result = route("Principal Backend Engineer", description, "Example Pay", "INVESTMENT_MARKETS_FINTECH");
    expect(result.primaryLane).toBe("INVESTMENT_MARKETS_FINTECH");
  });

  it("keeps a software company's generic engineer in CORE_AI_DATA without a technology-sector phrase", () => {
    const description = [
      "About Us",
      "Example Base builds an open-source Postgres development platform.",
      "The Role",
      "- Build backend services and the cloud platform that runs customer databases with Kubernetes.",
    ].join("\n");
    const result = route("Software Engineer", description, "Example Base", "CORE_AI_DATA");
    expect(result.primaryLane).toBe("CORE_AI_DATA");
  });

  it("does not read 'timezones & logistics' or 'a collaborative fashion' as uncovered sectors", () => {
    const description = [
      "The Role",
      "- Build backend services on a cloud platform with Kubernetes, working in a collaborative fashion.",
      "Timezones & logistics: full-time, remote in APAC.",
    ].join("\n");
    const result = route("Software Engineer", description, "Example Base", "CORE_AI_DATA");
    expect(result.primaryLane).toBe("CORE_AI_DATA");
  });

  it("keeps the TECHNICAL_PRODUCT_TRANSFORMATION sector requirement: AI phrases do not waive it", () => {
    const description = [
      "The Role",
      "- Own the roadmap for our AI products: generative AI assistants, machine learning features and MLOps tooling.",
      "- Work with engineers on data pipelines.",
    ].join("\n");
    const result = route("AI Product Manager", description, "Example Co", "TECHNICAL_PRODUCT_TRANSFORMATION");
    expect(result.primaryLane).not.toBe("TECHNICAL_PRODUCT_TRANSFORMATION");
  });
});
