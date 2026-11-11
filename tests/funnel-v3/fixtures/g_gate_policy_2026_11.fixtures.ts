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
    title: "Research Engineer I (Artificial Intelligence)",
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
    title: "Senior Executive (AI Lab - Healthcare)",
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
    title: "Lead Software Engineer, Markets Technology",
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
    title: "Lead Product Manager (Courts and Legal Services)",
    company_name: "Synthetic Government Technology Agency",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "Lead product discovery for digital services used by courts and legal officers. Prioritise the roadmap with policy owners and agency stakeholders.",
    expectedStatus: "PASS",
    forbiddenCodes: ["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN", "GATE_NOT_AI_DATA"],
    notes: "government legal product role: lane routing decides",
  },
  G11: {
    id: "G11",
    title: "Assistant Director, Enforcement (Investigator)",
    company_name: "Synthetic Financial Regulator",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "Investigate breaches of securities regulations, interview witnesses, and prepare enforcement case papers.",
    expectedStatus: "PASS",
    forbiddenCodes: ["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"],
    notes: "regulatory enforcement role: no Axis 1 rejection",
  },
  G12: {
    id: "G12",
    title: "Corporate Transformation Director",
    company_name: "Synthetic Life Insurance Asia",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "Drive the enterprise transformation portfolio, define operating-model changes, and report benefits to the executive committee.",
    expectedStatus: "PASS",
    forbiddenCodes: ["GATE_NOT_AI_DATA", "NON_TECHNICAL_FUNCTION"],
    notes: "no AI/data signal is not a hard gate",
  },
  G13: {
    id: "G13",
    title: "Regulatory & Controls Program Manager - Banking",
    company_name: "Synthetic Consulting Partners",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: "Run a regulatory remediation programme for a bank, track control milestones, and coordinate risk owners.",
    expectedStatus: "PASS",
    forbiddenCodes: ["GATE_NOT_AI_DATA"],
    notes: "regulatory programme role reaches lane routing",
  },
} satisfies Record<string, GatePolicyFixture>;

/** Rule 3: work-authorization false positives and location mismatch. */
export const TERRITORY_FIXTURES = {
  G14: {
    id: "G14",
    title: "Senior Customer Engineer, APAC (Based in Singapore)",
    company_name: "Synthetic Edge Networks",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Please note that any offer of employment may be conditioned on your authorization to receive software or technology controlled under U.S. export laws without sponsorship for an export license.`,
    expectedStatus: "PASS",
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "export-control licence condition is not a worker-territory restriction",
  },
  G15: {
    id: "G15",
    title: "VP, AI Solution Lead",
    company_name: "Synthetic Trust Bank",
    location: "Singapore (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Business-level proficiency in English and Japanese (written and spoken) is required for communication with Japanese-speaking stakeholders.`,
    expectedStatus: "PASS",
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "a language requirement is not a territory restriction",
  },
  G15B: {
    id: "G15B",
    title: "Solutions Architect, Singapore",
    company_name: "Synthetic Voice Chat",
    location: "Singapore (Remote)",
    workplace_type: "REMOTE",
    raw_description: `${ENGINEERING_DUTIES} Professional fluency in Mandarin and English, required to lead technical relationships with game studio partners across Greater China and the APAC region.`,
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
    raw_description: `${ENGINEERING_DUTIES} Business-level proficiency in Chinese is required for this role.`,
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
    title: "Data & AI - Data Engineer",
    company_name: "Synthetic Advisory Asia",
    location: "Kuala Lumpur (Hybrid)",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} This is a manager-level role based in Malaysia.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_JOB_LOCATION_MISMATCH"],
    forbiddenCodes: ["WORK_AUTHORIZATION_INCOMPATIBLE"],
    notes: "a genuinely non-Singapore job is a location mismatch, not work authorization",
  },
} satisfies Record<string, GatePolicyFixture>;

export const REMOTE_LIST_DESCRIPTION = [
  "Biology & Bioinformatics Research Specialist (MSc/PhD).",
  "LOCATION: Remote - US, Canada, Australia, New Zealand, UK, Southeast Asia, and broader APAC.",
  "Build bioinformatics pipelines in Python.",
].join("\n");

/** Rule 4: precise travel, on-call and shift codes. */
export const LIFESTYLE_FIXTURES = {
  G21: {
    id: "G21",
    title: "Senior Solutions Architect",
    company_name: "Synthetic GPU Systems",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: `${ENGINEERING_DUTIES} Ability to travel up to 25% and support occasional weekend work when required.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_TRAVEL_ABOVE_LIMIT"],
    forbiddenCodes: ["GATE_LIFESTYLE_INCOMPATIBLE"],
    expectedEvidence: /^Travel above \d+%: the posting states up to 25%$/,
    notes: "travel above the limit has its own code",
  },
  G22: {
    id: "G22",
    title: "Engineering Manager - Asian Timezones",
    company_name: "Synthetic Digital Assets",
    location: "Singapore (Remote)",
    workplace_type: "REMOTE",
    raw_description: `${ENGINEERING_DUTIES} Own incident response, on-call rotations, and post-mortem leadership.`,
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
    raw_description: `${ENGINEERING_DUTIES} This is a presales advisory role focused on deal velocity.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_HIGH_INTERACTION"],
    notes: "presales stays a hard reject",
  },
  G25B: {
    id: "G25B",
    title: "Research Engineer (Presales)",
    company_name: "National University of Singapore",
    location: "Singapore (On-site)",
    workplace_type: "ONSITE",
    raw_description: `${ENGINEERING_DUTIES} This is a presales advisory role focused on deal velocity.`,
    expectedStatus: "HARD_REJECT",
    expectedCodes: ["GATE_HIGH_INTERACTION"],
    notes: "an on-site exception never lifts the presales gate",
  },
} satisfies Record<string, GatePolicyFixture>;
