/**
 * Synthetic hard-gate cases for the 2026-11 gate policy change (G01-G26).
 *
 * Descriptions are written for these tests and only model the shape of real
 * postings. Commercial employer names are invented. Universities, research
 * institutes and public hospitals are named because they are the public,
 * non-personal on-site exception list in config/policies/workability.yml.
 * No personal preference data appears here: the user's on-site exception
 * employers are represented by invented names supplied through the policy.
 */
export interface GatePolicyFixture {
  readonly id: string;
  readonly title: string;
  readonly company_name: string;
  readonly location: string;
  readonly workplace_type: string;
  readonly raw_description: string;
  readonly expectedStatus: "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";
  readonly expectedCodes?: readonly string[];
  readonly forbiddenCodes?: readonly string[];
  readonly expectedEvidence?: RegExp;
  readonly notes: string;
}

const RESEARCH_DUTIES = "Develop machine learning models in Python and PyTorch for clinical data and publish research results.";
const ENGINEERING_DUTIES = "Build data pipelines and deploy machine learning services in Python on Kubernetes.";

/** Rule 1: on-site + full-time, with research and user-preferred exceptions. */
export const ONSITE_FIXTURES = {
  G01: {
    id: "G01",
    title: "Calibration Technician (Marine Sensors)",
    company_name: "Nanyang Technological University Singapore",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `Full-time. ${RESEARCH_DUTIES}`,
    expectedStatus: "PASS",
    forbiddenCodes: ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
    expectedEvidence: /ON-SITE EXCEPTION \(RESEARCH_ROLE\).*university or research institute/,
    notes: "university employer: on-site is accepted",
  },
  G02: {
    id: "G02",
    title: "Research Scientist, Machine Learning",
    company_name: "Synthetic Robotics Pte Ltd",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `Full-time. ${RESEARCH_DUTIES}`,
    expectedStatus: "PASS",
    forbiddenCodes: ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
    expectedEvidence: /ON-SITE EXCEPTION \(RESEARCH_ROLE\).*research scientist/,
    notes: "research title at a commercial employer",
  },
  G03: {
    id: "G03",
    title: "Senior Data Scientist",
    company_name: "Synthetic Retail Analytics",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `Full-time. ${ENGINEERING_DUTIES}`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
    notes: "data scientist is an industry title, not a research exception",
  },
  G04: {
    id: "G04",
    title: "Rota Assistant (AI Lab, Pathology)",
    company_name: "Tan Tock Seng Hospital",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `One-year contract. ${RESEARCH_DUTIES}`,
    expectedStatus: "PASS",
    expectedEvidence: /ON-SITE EXCEPTION \(RESEARCH_ROLE\).*health research body/,
    notes: "hospital research unit (AI lab)",
  },
  G04B: {
    id: "G04B",
    title: "Senior Manager, Facilities",
    company_name: "Tan Tock Seng Hospital",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: "Full-time. Build Python dashboards and SQL data pipelines for building maintenance schedules.",
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
    notes: "a hospital role outside a research unit keeps the global rule",
  },
  G05: {
    id: "G05",
    title: "Senior AI Platform Engineer",
    company_name: "Northwind Markets Singapore",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `Full-time. ${ENGINEERING_DUTIES}`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
    notes: "commercial on-site with no preference list: global rule rejects (the same job passes when the employer is listed)",
  },
  G06: {
    id: "G06",
    title: "Card Settlement Backend Maintainer",
    company_name: "AcmeBankChase",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `Full-time. ${ENGINEERING_DUTIES}`,
    expectedStatus: "PASS",
    expectedEvidence: /ON-SITE EXCEPTION \(PREFERRED_EMPLOYER\)/,
    notes: "listed name 'AcmeBank' matches the employer as a name prefix",
  },
  G07: {
    id: "G07",
    title: "AI Engineer",
    company_name: "Nanyang Technological University Singapore",
    location: "Singapore",
    workplace_type: "UNKNOWN",
    raw_description: `Full-time. You will work 5 days a week in the office. ${ENGINEERING_DUTIES}`,
    expectedStatus: "PASS",
    forbiddenCodes: ["GATE_HIGH_OFFICE_DAYS"],
    expectedEvidence: /ON-SITE EXCEPTION.*5 days a week in the office/,
    notes: "explicit office days in the description are lifted for a research employer",
  },
  G07B: {
    id: "G07B",
    title: "AI Engineer",
    company_name: "Nanyang Technological University Singapore",
    location: "Singapore",
    workplace_type: "UNKNOWN",
    raw_description: `Full-time. ${ENGINEERING_DUTIES}`,
    expectedStatus: "NEEDS_VERIFICATION",
    expectedCodes: ["GATE_UNKNOWN_WORK_MODE"],
    notes: "an exception never resolves an unknown work mode (invariant 4)",
  },
  G08: {
    id: "G08",
    title: "Research Fellow (Machine Learning)",
    company_name: "National University of Singapore",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `Full-time. ${RESEARCH_DUTIES} Travel up to 40% to partner sites is required.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_TRAVEL_ABOVE_LIMIT"],
    notes: "the exception lifts on-site only; travel still rejects",
  },
} satisfies Record<string, GatePolicyFixture>;

/** Rule 2: non-technical and non-AI roles reach lane routing. */
export const FUNCTION_DOMAIN_FIXTURES = {
  G10: {
    id: "G10",
    title: "Casework Screens Product Owner",
    company_name: "Synthetic Government Technology Agency",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "Court clerks key in hundreds of forms a week. Decide which of their online screens gets rebuilt next, and why.",
    expectedStatus: "PASS",
    forbiddenCodes: ["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN", "GATE_NOT_AI_DATA"],
    notes: "government legal product role: lane routing decides",
  },
  G11: {
    id: "G11",
    title: "Broker Conduct Examiner",
    company_name: "Synthetic Financial Regulator",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "When trades look irregular, question the people involved and write up the evidence for a disciplinary hearing.",
    expectedStatus: "PASS",
    forbiddenCodes: ["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"],
    notes: "regulatory enforcement role: no Axis 1 rejection",
  },
  G12: {
    id: "G12",
    title: "Chief of Operating Model Change",
    company_name: "Synthetic Life Insurance Asia",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "Branches, claim desks and call rooms each work their own way today. Settle one way of working and show the board how far it has got.",
    expectedStatus: "PASS",
    forbiddenCodes: ["GATE_NOT_AI_DATA", "NON_TECHNICAL_FUNCTION"],
    notes: "no AI/data signal is not a hard gate",
  },
  G13: {
    id: "G13",
    title: "Audit Findings Closure Lead",
    company_name: "Synthetic Consulting Partners",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "Examiners left a client bank with open findings. Keep every fix on its date and chase whoever owns the risk.",
    expectedStatus: "PASS",
    forbiddenCodes: ["GATE_NOT_AI_DATA"],
    notes: "regulatory programme role reaches lane routing",
  },
} satisfies Record<string, GatePolicyFixture>;

/** Rule 3: work-authorization false positives and location mismatch. */
export const TERRITORY_FIXTURES = {
  G14: {
    id: "G14",
    title: "Radio Mesh Engineer, Southeast Asia",
    company_name: "Synthetic Edge Networks",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Some tooling falls under U.S. export controls, so access needs authorization and we will not sponsor an export license.`,
    expectedStatus: "PASS",
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "export-control licence condition is not a worker-territory restriction",
  },
  G15: {
    id: "G15",
    title: "Speech Technology Programme Principal",
    company_name: "Synthetic Trust Bank",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Customers in Osaka expect business-level fluency in Japanese as well as English.`,
    expectedStatus: "PASS",
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "a language requirement is not a territory restriction",
  },
  G15B: {
    id: "G15B",
    title: "Studio Integrations Designer",
    company_name: "Synthetic Voice Chat",
    location: "Singapore (Remote)",
    workplace_type: "REMOTE",
    raw_description: `${ENGINEERING_DUTIES} Fluent Mandarin and English are needed to coach studio crews in China, Taiwan and elsewhere in APAC.`,
    expectedStatus: "PASS",
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "Mandarin fluency with partners across China is not a restriction",
  },
  G15C: {
    id: "G15C",
    title: "Sr. Technical Program Manager",
    company_name: "Synthetic Pinboard",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Supplier calls run in Chinese, so working proficiency in it is expected.`,
    expectedStatus: "PASS",
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "language adjective 'Chinese' is not the China territory",
  },
  G16: {
    id: "G16",
    title: "Machine Learning Engineer",
    company_name: "Synthetic Analytics Inc",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Candidates must be authorized to work in the United States.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "an explicit restriction that excludes Singapore still rejects",
  },
  G18: {
    id: "G18",
    title: "Warehouse Telemetry Engineer",
    company_name: "Synthetic Advisory Asia",
    location: "Kuala Lumpur (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} The role is based in Malaysia for the whole contract.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_JOB_LOCATION_MISMATCH"],
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "a genuinely non-Singapore job is a location mismatch, not work authorization",
  },
} satisfies Record<string, GatePolicyFixture>;

export const REMOTE_LIST_DESCRIPTION = [
  "Volcano Monitoring Analyst, two-year contract.",
  "LOCATION: Remote - US, Chile, Iceland, UK, Southeast Asia, and wider APAC.",
  "Maintain Python scripts that clean tremor readings.",
].join("\n");

/** Rule 4: precise travel, on-call and shift codes. */
export const LIFESTYLE_FIXTURES = {
  G21: {
    id: "G21",
    title: "Senior Solutions Architect",
    company_name: "Synthetic GPU Systems",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Expect travel up to 25% for site surveys, with the odd weekend visit.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_TRAVEL_ABOVE_LIMIT"],
    forbiddenCodes: ["GATE_LIFESTYLE_INCOMPATIBLE"],
    expectedEvidence: /^Travel above \d+%: the posting states up to 25%$/,
    notes: "travel above the limit has its own code",
  },
  G22: {
    id: "G22",
    title: "Platform Duty Lead, APAC",
    company_name: "Synthetic Digital Assets",
    location: "Singapore (Remote)",
    workplace_type: "REMOTE",
    raw_description: `${ENGINEERING_DUTIES} Every sixth week you join the on-call rotation, then write up any outage.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_ON_CALL_REQUIRED"],
    forbiddenCodes: ["GATE_LIFESTYLE_INCOMPATIBLE"],
    notes: "on-call stays a reject under the active preference, with its own code",
  },
} satisfies Record<string, GatePolicyFixture>;

/** Rule 5: unchanged gates. */
export const UNCHANGED_FIXTURES = {
  G25: {
    id: "G25",
    title: "Solutions Engineer",
    company_name: "Synthetic Payments Cloud",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} A slice of each week is presales support for the product team.`,
    expectedStatus: "PASS",
    expectedCodes: [],
    notes: "gate-2026-11.7: a bare presales phrase in the description does not reject (it downranks); a presales title still does (G25B)",
  },
  G25B: {
    id: "G25B",
    title: "Research Engineer (Presales)",
    company_name: "National University of Singapore",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `${ENGINEERING_DUTIES} A slice of each week is presales support for the product team.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_HIGH_INTERACTION"],
    notes: "an on-site exception never lifts the presales gate",
  },
} satisfies Record<string, GatePolicyFixture>;
