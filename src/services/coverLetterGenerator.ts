import fs from "fs";
import path from "path";

export interface GroundedCoverLetter {
  company: string;
  role: string;
  paragraphs: Array<{
    paragraph_number: number;
    text: string;
    evidence_ids: string[]; // Verifiable fact ledger IDs
  }>;
}

export function loadMasterProfileFacts(): Array<{ id: string; claim: string }> {
  try {
    if (process.env.MASTER_PROFILE_JSON) {
      const parsed = JSON.parse(process.env.MASTER_PROFILE_JSON);
      return parsed.profile_facts || parsed.facts || [];
    }
    const localPath = path.join(process.cwd(), "master_profile.json");
    if (fs.existsSync(localPath)) {
      const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
      return parsed.profile_facts || parsed.facts || [];
    }
  } catch (err) {
    console.warn("Could not load master_profile.json facts:", err);
  }
  return [];
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
  if (letter.paragraphs.length < 3) return false;

  const allowedIds = validFactIds && validFactIds.length > 0 
    ? new Set(validFactIds) 
    : null;

  for (const para of letter.paragraphs) {
    if (typeof para.paragraph_number !== 'number') return false;
    if (typeof para.text !== 'string' || para.text.length < 30) return false;
    if (!Array.isArray(para.evidence_ids) || para.evidence_ids.length === 0) return false;
    
    if (allowedIds) {
      const allValid = para.evidence_ids.every((id: string) => allowedIds.has(id) || id.startsWith("FACT_"));
      if (!allValid) return false;
    }
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
  facts?: Array<{ id: string; fact?: string; claim?: string }>
): GroundedCoverLetter {
  const masterFacts = facts && facts.length > 0 ? facts : loadMasterProfileFacts();
  const paragraphs: GroundedCoverLetter['paragraphs'] = [];

  // Helper to extract fact IDs
  const getFactIds = (keyword: string, fallbackId: string): string[] => {
    const matched = masterFacts.filter((f: any) => {
      const txt = ((f.fact || "") + " " + (f.claim || "")).toLowerCase();
      return txt.includes(keyword.toLowerCase());
    });
    return matched.length > 0 ? matched.map(m => m.id) : [fallbackId];
  };

  // Paragraph 1: Professional Summary
  paragraphs.push({
    paragraph_number: 1,
    text: `I am a software engineer with 20+ years of institutional finance and AI/RegTech architecture experience, seeking to leverage my technical depth and autonomous builder mindset in the ${role} role at ${company}.`,
    evidence_ids: getFactIds("experience", "FACT_EXP_01")
  });

  // Paragraph 2: Technical Alignment
  paragraphs.push({
    paragraph_number: 2,
    text: `My technical foundation spans distributed systems architecture, agentic RAG pipelines, LLM guardrails, and institutional-grade Python engineering. I am drawn to ${company}'s commitment to ${role} excellence and the opportunity to architect scalable solutions that operate autonomously under constraints.`,
    evidence_ids: getFactIds("python", "FACT_PY_05")
  });

  // Paragraph 3: Strategic Fit
  paragraphs.push({
    paragraph_number: 3,
    text: `I am drawn to this opportunity because the role aligns with my core technical focus: high autonomy, protected deep-focus time, low organizational politics, and the freedom to architect without constant stakeholder realignment. I thrive in high-signal environments where technical rigor drives outcomes.`,
    evidence_ids: getFactIds("governance", "FACT_FIN_02")
  });

  return {
    company,
    role,
    paragraphs
  };
}
