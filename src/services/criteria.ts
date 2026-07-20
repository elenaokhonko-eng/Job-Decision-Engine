/**
 * Custom weights and criteria configuration file for the Job Decision Engine.
 * This is designed for easy open-source customization. 
 * Forkers can simply edit this file to match their own profile and priorities.
 */

export const CANDIDATE_PROFILE = {
  name: "Elena Okhonko",
  age: 44,
  experienceYears: 20,
  workplacePreference: "High-Autonomy Technical Architect & SME Builder",
  targetCompSgdMonth: 22000,
  maxTravelPercentage: 10,
  maxOfficeDaysPerWeek: 3,
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
    "Travel < 10%",
    "Max 3 days in-office",
    "Low stress / organizational politics",
    "Protected deep-focus time"
  ]
};

export const EVALUATION_WEIGHTS = {
  // Axis 4: Environmental & Biological Guardrails (30%)
  environment_guardrails: {
    maxPoints: 30,
    description: "Low-stress, high-clarity culture, protected focus blocks, asynchronous workflow, and high-autonomy builder support."
  },
  // Axis 1: Technical & Creative Autonomy (25%)
  technical_autonomy: {
    maxPoints: 25,
    description: "Autonomy and expert SME roles (hands-on architecture, direct code, or complex transformation program solutioning; autonomous decision-making as an SME expert across modern tech stacks - FE, BE, DB/SQL; no low-frequency coding; no hardcore C/C++)."
  },
  // Axis 3: Domain Relevance (20%)
  domain_relevance: {
    maxPoints: 20,
    description: "Alignment with Track A (Private banks, wealth management, supranationals like GIC/Temasek, top 20 fund managers/world banks - excluding local banks, major European banks & insurers, hedge funds, growth AI startups) or Track B (Medical, pharma, bioinformatics, plant-based medical research - extra weighting for plant medical research)."
  },
  // Axis 2: Compensation & Capital Potential (15%)
  compensation_potential: {
    maxPoints: 15,
    description: "Ability to hit/exceed the SGD 22k+/month base salary."
  },
  // Axis 5: Future-Proofing (10%)
  future_mobility: {
    maxPoints: 10,
    description: "Combination of specific job growth trajectory, technical domain trajectory (growing AI/ML/Data Science vs dying domain), and company industry (growing vs sunset)."
  }
};

export const HARD_DISQUALIFIERS = [
  "Mandatory travel exceeding 10%",
  "Primary role is traditional Program/Project Manager or Scrum Master (lack of hands-on coding/architecture)",
  "Primary role is Client Relationship Management, Sales, Presales, or Quota-carrying business development",
  "Office attendance required > 3 days per week (except for specialized physical lab environments)",
  "Clear indicators of high political overhead, intense bureaucratic alignment, or presentation-heavy workloads",
  "Local Singapore banks: DBS, UOB, OCBC (automatic rejection)",
  "Insurance and asset management companies: AIA, AIAIM (AIA Investment Management)",
  "Job postings sourced from recruitment agencies: Argyll Scott"
];

/**
 * High-Autonomy Workplace Culture & Focus Metrics.
 * These are used to run database analytics on which companies are supportive or toxic.
 */
export const ND_CULTURE_CRITERIA = {
  highSupportiveFactors: [
    "Clear, direct, and written communication over unwritten rules",
    "Asynchronous work patterns (Slack/written spec first, fewer live standups)",
    "Protected focus blocks (e.g., 'No-meeting Wednesdays')",
    "Results-Oriented Work Environment (ROWE) instead of seat-time surveillance",
    "Transparent and predictable salary/evaluation structure"
  ],
  highToxicFactors: [
    "High corporate politics, backchannel alignment, and unwritten rules",
    "Frequent presentation/storytelling to steer committees",
    "Managing stakeholders without direct authority or influencing people who do not directly report to the role",
    "Wearing dual hats as both a technical specialist and a sales/client-facing representative simultaneously",
    "Frequent change in priorities or chaotic scrum sprints",
    "Heavy client hand-holding or emotional labor",
    "Mandatory social team-bonding or high sensory overload (open office noise)"
  ]
};
