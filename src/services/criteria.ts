/**
 * Custom weights and criteria configuration file for the Job Decision Engine.
 * This is designed for easy open-source customization. 
 * Forkers can simply edit this file to match their own profile and priorities.
 */

export const CANDIDATE_PROFILE = {
  name: "Elena Okhonko",
  experienceYears: 20,
  workplacePreference: "High-Autonomy Technical Architect & SME Builder",
  minAcceptableBaseSgdMonth: 22000,
  maxTravelPercentage: 10,
  idealOfficeDaysPerWeek: 2,
  maxOfficeDaysPerWeek: 3, // Exceptions allowed for specialized physical laboratory environments
  coreSkills: [
    "IT Architecture",
    "Institutional Finance ($54B+ governance)",
    "AI/RegTech Engineering",
    "Python Coding",
    "Agentic RAG Pipelines",
    "LLM Guardrails"
  ],
  nonNegotiables: [
    "No traditional Program Manager / Project Manager / Scrum Master roles",
    "No Client Relationship Management, Sales, or Presales roles",
    "No Forward Deployed Engineering (FDE) or outsourcing/consulting roles",
    "No contract roles (only permanent FTE)",
    "Travel < 10%",
    "Max 3 days in-office (unless a physical scientific lab)",
    "Low stress / organizational politics",
    "Protected deep-focus time"
  ]
};

// Stage 1: Hard Disqualifiers (Objective evidence only, no vibes)
export const HARD_DISQUALIFIERS = [
  "Mandatory travel exceeding 10%",
  "Primary role is traditional Program/Project Manager, Scrum Master, or Agile Coach",
  "Primary role is Client Relationship Management, Sales, Presales, or Quota-carrying business development",
  "Office attendance required > 3 days per week (except for specialized physical lab environments)",
  "Employment Type: Contract, Contractor, Temporary, or Freelance (must be permanent FTE)",
  "Company Type: Local Singapore banks (DBS, UOB, OCBC)",
  "Company Type: Insurance and asset management companies specifically matching 'AIA' or 'AIA Investment Management'",
  "Company Type: Job postings sourced from recruitment agencies (e.g., Argyll Scott)",
  "Company Type: Forward Deployed Engineering (FDE)",
  "Company Type: IT outsourcing/staffing (specifically exact matches for Red Hat, or external contracting agencies)",
  "Company Type: Consulting firms (Accenture, KPMG, BCG, McKinsey, Bain, Deloitte, PwC, EY, Boston Consulting Group, PricewaterhouseCoopers)",
  "Role Focus: Infrastructure Data Center, Datacenter operations, or physical Data Center management (candidate lacks experience in this specific area)",
  "Role Focus: Hardware Engineering, physical device engineering, or hardware design (candidate focuses exclusively on Software Engineering/Architecture)"
];

// Stage 2: Career Change Horizon Routes
export const CAREER_HORIZON_ROUTES = {
  SCIENTIFIC_AI_CONVERGENCE: {
    scoreRange: "90-100",
    description: "Ideal pivot. Hands-on AI/data roles directly within medical, pharma, bioinformatics, or plant-based research. Establishes the clear bridge for the PhD path."
  },
  AI_DATA_MASTERY_BRIDGE: {
    scoreRange: "75-89",
    description: "Excellent fallback. High-autonomy AI/ML architecture or Python data engineering within institutional finance or tech. Strengthens AI credentials but doesn't change the industry domain."
  },
  SCIENCE_DOMAIN_BRIDGE: {
    scoreRange: "60-74",
    description: "Good domain pivot, lower tech mastery. A role in pharma/research but leaning more toward general IT architecture or systems rather than direct AI/ML/Data work."
  },
  TECHNICAL_ARCHITECTURE_BRIDGE: {
    scoreRange: "45-59",
    description: "Status quo. Standard IT/Platform architecture in finance/corporate. Pays the bills and provides autonomy, but doesn't advance the AI or scientific pivot."
  },
  NONTECHNICAL_ADJACENCY: {
    scoreRange: "25-44",
    description: "Strategic risk. Roles leaning heavily into management, governance, or strategy with little to no hands-on technical execution."
  },
  STRATEGIC_DEAD_END: {
    scoreRange: "0-24",
    description: "Complete regression. Project management, sales, or roles in declining/legacy domains that actively harm the CV trajectory."
  }
};

// Stage 3: Present-Day Role Value (100 Points Total)
export const EVALUATION_WEIGHTS = {
  hands_on_ai_data_mastery: {
    maxPoints: 30,
    description: "Direct involvement in Python, AI, ML, Data pipelines, or agentic RAG. Is the role actively building?"
  },
  technical_creative_autonomy: {
    maxPoints: 25,
    description: "Level of control over architecture and systems. Being an SME expert. Lack of micromanagement or heavy governance layers."
  },
  role_purity_output_clarity: {
    maxPoints: 15,
    description: "Is the job clearly defined? A pure technical role vs. a kitchen-sink role (e.g., 'wear many hats', 'manage internal and external clients')."
  },
  compensation_employment_quality: {
    maxPoints: 20,
    description: "Does it meet or exceed the base SGD 22k/month? Is it permanent FTE?"
  },
  market_durability_learning_signal: {
    maxPoints: 10,
    description: "Does the tech stack and domain signal growth (AI/ML, pharma) rather than sunsetting legacy systems?"
  }
};

// Independent Axis: Neurodivergent-Friendliness (0-100)
// Scored based on evidence in the JD, independently of the 100-point core fit.
export const ND_FRIENDLY_DIMENSIONS = {
  highSupportiveFactors: [
    "Clear, direct, and written communication mentioned",
    "Asynchronous work patterns (Slack/written spec first)",
    "Protected focus blocks (e.g., 'No-meeting Wednesdays', 'Deep Work')",
    "Results-Oriented Work Environment (ROWE)",
    "Remote-first or explicit low office attendance (0-2 days)",
    "Strong global ND or disability inclusion program (e.g., AstraZeneca, Microsoft, SAP, IBM)"
  ],
  redFlags: [
    "Open office environment explicitly mentioned",
    "Heavy emphasis on 'highly collaborative physical workspaces' or 'constant video calls'",
    "Mandatory social team-bonding"
  ]
};

// Independent Axis: Politics & Stress Risk (0-100)
// Scored based on evidence in the JD, independently of the 100-point core fit.
export const POLITICS_STRESS_RISK_DIMENSIONS = {
  highRiskFactors: [
    "High corporate politics, backchannel alignment, and unwritten rules",
    "Frequent presentation/storytelling to steer committees",
    "Managing stakeholders without direct authority ('highly matrixed')",
    "Wearing dual hats as both a technical specialist and a sales/client-facing representative",
    "Buzzword: 'Fast-paced, dynamic environment' (Minor penalty unless combined with other flags)",
    "Buzzword: 'Thrive under pressure' or 'Comfortable with ambiguity'",
    "Buzzword: 'Wear many hats' or 'Roll up your sleeves' (High context-switching)",
    "Buzzword: 'Work hard, play hard' (Boundary bleed)",
    "Over-emphasis on Agile/Scrum ceremonies, daily standups, and constant collaboration"
  ]
};
