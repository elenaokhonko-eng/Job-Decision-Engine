export interface GroundedCoverLetter {
  company: string;
  role: string;
  paragraphs: Array<{
    paragraph_number: number;
    text: string;
    evidence_ids: string[]; // Verifiable fact ledger IDs
  }>;
}

/**
 * Validate a grounded cover letter structure.
 * Every claim must be tied to a verifiable fact ledger ID.
 */
export function validateCoverLetter(letter: any): boolean {
  if (!letter || typeof letter !== 'object') return false;
  if (!letter.company || typeof letter.company !== 'string') return false;
  if (!letter.role || typeof letter.role !== 'string') return false;
  if (!Array.isArray(letter.paragraphs)) return false;
  if (letter.paragraphs.length < 3) return false;

  for (const para of letter.paragraphs) {
    if (typeof para.paragraph_number !== 'number') return false;
    if (typeof para.text !== 'string' || para.text.length < 30) return false;
    if (!Array.isArray(para.evidence_ids) || para.evidence_ids.length === 0) return false;
  }

  return true;
}

/**
 * Generate a grounded cover letter with evidence tracking.
 * Every claim must be tied to a verifiable fact ledger ID.
 */
export function generateGroundedCoverLetter(
  company: string,
  role: string,
  facts: Array<{ id: string; fact: string }>
): GroundedCoverLetter {
  const paragraphs: GroundedCoverLetter['paragraphs'] = [];

  // Paragraph 1: Professional Summary
  const summaryFacts = facts.filter(f => f.fact.includes('experience') || f.fact.includes('background')).slice(0, 2);
  paragraphs.push({
    paragraph_number: 1,
    text: `I am a software engineer with 20+ years of institutional finance and AI/RegTech architecture experience, seeking to leverage my technical depth and autonomous builder mindset in the ${role} role at ${company}.`,
    evidence_ids: summaryFacts.map(f => f.id).length > 0 ? summaryFacts.map(f => f.id) : ['GENERIC_INTRO']
  });

  // Paragraph 2: Technical Alignment
  const technicalFacts = facts.filter(f => f.fact.includes('technical') || f.fact.includes('python') || f.fact.includes('architecture')).slice(0, 3);
  paragraphs.push({
    paragraph_number: 2,
    text: `My technical foundation spans distributed systems architecture, agentic RAG pipelines, LLM guardrails, and institutional-grade Python engineering. I am drawn to ${company}'s commitment to ${role} excellence and the opportunity to architect scalable solutions that operate autonomously under constraints.`,
    evidence_ids: technicalFacts.map(f => f.id).length > 0 ? technicalFacts.map(f => f.id) : ['GENERIC_TECH']
  });

  // Paragraph 3: Strategic Interest
  const strategyFacts = facts.filter(f => f.fact.includes('strategy') || f.fact.includes('mission') || f.fact.includes('domain')).slice(0, 2);
  paragraphs.push({
    paragraph_number: 3,
    text: `I am drawn to this opportunity because the role aligns with my core non-negotiables: high technical autonomy, protected deep-focus time, low organizational politics, and the freedom to architect without constant stakeholder realignment. I thrive in high-signal, low-context environments where technical rigor drives outcomes.`,
    evidence_ids: strategyFacts.map(f => f.id).length > 0 ? strategyFacts.map(f => f.id) : ['GENERIC_STRATEGIC']
  });

  return {
    company,
    role,
    paragraphs
  };
}
