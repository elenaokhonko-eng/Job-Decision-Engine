/**
 * Custom weights and criteria configuration file for the Job Decision Engine.
 * This is designed for easy open-source customization. 
 * Forkers can simply edit this file to match their own profile and priorities.
 */

export const CANDIDATE_PROFILE = {
  name: "Elena Okhonko",
  age: 44,
  experienceYears: 20,
  neurotype: "2E auDHD (Managed via atomoxetine/guanfacine)",
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
  // Axis 1: Technical & Creative Autonomy (30%)
  technical_autonomy: {
    maxPoints: 30,
    description: "Hands-on architecture, direct coding, complex solutioning, and low meeting/presentation overhead."
  },
  // Axis 2: Compensation & Capital Potential (25%)
  compensation_potential: {
    maxPoints: 25,
    description: "Ability to hit the SGD 22k+/month base salary and accumulate SGD 1M in 3-4 years."
  },
  // Axis 3: Domain Relevance (20%)
  domain_relevance: {
    maxPoints: 20,
    description: "Alignment with Institutional Finance AI/RegTech (Track A) or Pharma/Bioinformatics research (Track B)."
  },
  // Axis 4: Environmental & Biological Guardrails (15%)
  environment_guardrails: {
    maxPoints: 15,
    description: "Low-stress, high-clarity culture, asynchronous workflow, and perimenopause/auDHD-friendly support."
  },
  // Axis 5: Future-Proofing & Netherlands Mobility (10%)
  future_mobility: {
    maxPoints: 10,
    description: "Direct paths toward relocating to the Netherlands or supporting a planned plant-based/pharma PhD pivot."
  }
};

export const HARD_DISQUALIFIERS = [
  "Mandatory travel exceeding 10%",
  "Primary role is traditional Program/Project Manager or Scrum Master (lack of hands-on coding/architecture)",
  "Primary role is Client Relationship Management, Sales, Presales, or Quota-carrying business development",
  "Office attendance required > 3 days per week (except for specialized physical lab environments)",
  "Clear indicators of high political overhead, intense bureaucratic alignment, or presentation-heavy workloads"
];

/**
 * Neurodivergent (ND) & auDHD Nervous System Culture Metrics.
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
    "Frequent change in priorities or chaotic scrum sprints",
    "Heavy client hand-holding or emotional labor",
    "Mandatory social team-bonding or high sensory overload (open office noise)"
  ]
};
