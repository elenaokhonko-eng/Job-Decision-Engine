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
export function validateCoverLetter(letter: any, validFactIds?: string[]): boolean {
  if (!letter || typeof letter !== 'object') return false;
  if (!letter.company || typeof letter.company !== 'string') return false;
  if (!letter.role || typeof letter.role !== 'string') return false;
  if (!Array.isArray(letter.paragraphs)) return false;
  if (letter.paragraphs.length < 1) return false;

  if (!validFactIds?.length) return false;
  const allowedIds = new Set(validFactIds);

  for (const para of letter.paragraphs) {
    if (typeof para.paragraph_number !== 'number') return false;
    if (typeof para.text !== 'string' || para.text.length < 30) return false;
    if (!Array.isArray(para.evidence_ids) || para.evidence_ids.length === 0) return false;
    
    const allValid = para.evidence_ids.every((id: string) => allowedIds.has(id));
    if (!allValid) return false;
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
  facts: Array<{ id: string; fact?: string; claim?: string }>
): GroundedCoverLetter {
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new Error("A workspace-scoped profile evidence list is required to generate a grounded cover letter.");
  }
  const eligibleFacts = facts.map((item) => ({ id: item.id.trim(), claim: (item.fact ?? item.claim ?? "").trim() }))
    .filter((item) => item.id && item.claim);
  if (eligibleFacts.length === 0) throw new Error("The selected profile has no non-empty, identified evidence statements.");
  const paragraphs: GroundedCoverLetter["paragraphs"] = eligibleFacts.slice(0, 3).map((item, index) => ({
    paragraph_number: index + 1,
    text: `The selected profile records the following evidence for the ${role} role at ${company}: ${item.claim}`,
    evidence_ids: [item.id],
  }));

  return {
    company,
    role,
    paragraphs
  };
}
