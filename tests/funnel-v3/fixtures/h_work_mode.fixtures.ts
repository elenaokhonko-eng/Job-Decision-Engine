export interface TestJobFixture {
  id: string;
  title: string;
  company_name: string;
  location?: string;
  workplace_type?: string;
  employment_type?: string;
  raw_description: string;
  expectedStatus: "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";
  expectedRejectionCode?: string;
  expectedFacts?: {
    office_days_min?: number | null;
    office_days_max?: number | null;
    travel_pct_max?: number | null;
    employment_type?: "PERMANENT" | "CONTRACT" | "UNKNOWN";
    location_restriction?: string | null;
  };
  notes: string;
}

export const WORK_MODE_FIXTURES: Record<string, TestJobFixture> = {
  H01: {
    id: "H01",
    title: "Lead AI Engineer",
    company_name: "Apex AI Labs",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "We are looking for a Lead AI Engineer to build LLM pipelines. This is a hybrid role with flexible working arrangements.",
    expectedStatus: "PASS",
    expectedFacts: {
      office_days_min: 3,
      office_days_max: 3,
      employment_type: "UNKNOWN",
    },
    notes: "hybrid unspecified => employer count NULL, assumed 3/2, PASS",
  },
  H02: {
    id: "H02",
    title: "Senior Machine Learning Engineer",
    company_name: "FinTech Innovations",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "Senior Machine Learning Engineer building quantitative models. Workplace model is hybrid: 3 days per week in the office and 2 days remote.",
    expectedStatus: "PASS",
    expectedFacts: {
      office_days_min: 3,
      office_days_max: 3,
    },
    notes: "employer 3 onsite pass",
  },
  H03: {
    id: "H03",
    title: "Principal Data Architect",
    company_name: "Enterprise Bank",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "Enterprise data architecture leadership. Requirements: 4 days in office per week, 1 day work from home.",
    expectedStatus: "HARD_REJECT",
    expectedRejectionCode: "GATE_HIGH_OFFICE_DAYS",
    expectedFacts: {
      office_days_min: 4,
      office_days_max: 4,
    },
    notes: "explicit 4 onsite reject",
  },
  H04: {
    id: "H04",
    title: "AI Platform Engineer",
    company_name: "CloudScale Systems",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "Building distributed AI inference infrastructure. Schedule: 2 days work from home per week, remaining days in our downtown office.",
    expectedStatus: "PASS",
    expectedFacts: {
      office_days_min: 3,
      office_days_max: 3,
    },
    notes: "2 days WFH/known five-day week = 3 onsite => PASS",
  },
  H05: {
    id: "H05",
    title: "Bioinformatics Pipeline Engineer",
    company_name: "Genomics Asia",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "Developing next-generation sequencing pipelines. Schedule: 3 days work from home per week, 2 days in the collaborative lab office.",
    expectedStatus: "PASS",
    expectedFacts: {
      office_days_min: 2,
      office_days_max: 2,
    },
    notes: "3 WFH = 2 onsite => PASS",
  },
  H06: {
    id: "H06",
    title: "Staff Data Engineer",
    company_name: "Atlas Data",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "Staff Data Engineer for lakehouse systems. Benefits include 30 days annual leave. Please apply in 5 days. Standard 5-day workweek with flexible hybrid policy.",
    expectedStatus: "PASS",
    notes: "30 days leave, apply in 5 days, 5-day workweek cannot be parsed as office days",
  },
  H07: {
    id: "H07",
    title: "Distributed Systems Architect",
    company_name: "Paradox Tech",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "100% remote working position across all teams. Mandatory 5 days on-site in office required for all architectural duties.",
    expectedStatus: "HARD_REJECT",
    expectedRejectionCode: "GATE_HIGH_OFFICE_DAYS",
    notes: "simultaneous contradictory schedules must not publish MATCHED",
  },
  H08: {
    id: "H08",
    title: "MLOps Systems Engineer",
    company_name: "Hardware Co",
    location: "Singapore",
    workplace_type: "ONSITE",
    raw_description: "MLOps engineer managing on-premise GPU clusters. Role is 100% on-site at our data center.",
    expectedStatus: "HARD_REJECT",
    expectedRejectionCode: "GATE_HIGH_OFFICE_DAYS",
    notes: "onsite-only reject",
  },
  H09: {
    id: "H09",
    title: "Natural Language Processing Engineer",
    company_name: "Stealth Startup",
    location: "",
    workplace_type: "UNKNOWN",
    raw_description: "Join our NLP team to build custom domain LLMs using Python and PyTorch. Competitive compensation and equity.",
    expectedStatus: "NEEDS_VERIFICATION",
    notes: "truly missing workplace after bounded extraction produces NEEDS_VERIFICATION with user policy, not false employer onsite assertion",
  },
  H10: {
    id: "H10",
    title: "Staff Quantitative Developer",
    company_name: "Global Alpha Capital",
    location: "Worldwide Remote",
    workplace_type: "REMOTE",
    raw_description: "Fully remote position for a Staff Quantitative Developer. Design low-latency trading data feeds and market simulators. Open to talent anywhere in the world.",
    expectedStatus: "PASS",
    expectedFacts: {
      office_days_min: 0,
      office_days_max: 0,
    },
    notes: "worldwide remote pass",
  },
  H11: {
    id: "H11",
    title: "AI Solutions Architect",
    company_name: "Bay Area AI Inc",
    location: "Remote",
    workplace_type: "REMOTE",
    raw_description: "Headquartered in San Francisco, CA. We are a remote-first organization hiring global AI Solutions Architects to build customer RAG pipelines.",
    expectedStatus: "PASS",
    notes: "US-headquartered remote, no explicit work permit/citizenship => pass location rule",
  },
  H12: {
    id: "H12",
    title: "Cloud Infrastructure Architect",
    company_name: "US Federal Tech",
    location: "United States (Remote)",
    workplace_type: "REMOTE",
    raw_description: "Remote role. Must possess active US Citizenship or US Green Card and be authorized to work in the United States without sponsorship.",
    expectedStatus: "HARD_REJECT",
    expectedRejectionCode: "GATE_LOCATION_RESTRICTED",
    expectedFacts: {
      location_restriction: "UNITED_STATES",
    },
    notes: "remote role explicitly demands US right-to-work, SG-only profile => reject",
  },
  H13: {
    id: "H13",
    title: "Principal RegTech Architect",
    company_name: "Asia Compliance Network",
    location: "Singapore (Remote)",
    workplace_type: "REMOTE",
    raw_description: "Principal Architect for AML/KYC graph analytics. Fully remote, must be based in Singapore or hold valid Singapore work authorization.",
    expectedStatus: "PASS",
    notes: "remote with explicitly Singapore authorization => pass",
  },
  H14: {
    id: "H14",
    title: "Quantitative Research Director",
    company_name: "London Capital Partners",
    location: "London, UK",
    workplace_type: "ONSITE",
    raw_description: "On-site trading floor director in London. Candidates must have existing UK right to work and attend 5 days on-site.",
    expectedStatus: "HARD_REJECT",
    notes: "foreign onsite requiring missing visa and high office days => reject",
  },
  H15: {
    id: "H15",
    title: "Applied AI Researcher",
    company_name: "Decentralized Science",
    location: "Remote",
    workplace_type: "REMOTE",
    raw_description: "Applied AI Researcher for foundation model development. Fully remote. No work visa required as we engage via global remote employment arrangements.",
    expectedStatus: "PASS",
    notes: "'no work visa required' does not trigger false positive location rejection",
  },
  H16: {
    id: "H16",
    title: "Human Resources Director",
    company_name: "Apex AI Labs",
    location: "Singapore",
    workplace_type: "HYBRID",
    raw_description: "HR Director overseeing talent acquisition and employee relations. Flexible hybrid schedule with 2 days remote.",
    expectedStatus: "HARD_REJECT",
    expectedRejectionCode: "NON_TARGET_ROLE_FAMILY",
    notes: "hybrid assumed 3/2 + unrelated hard violation (HR title) still rejects",
  },
};
