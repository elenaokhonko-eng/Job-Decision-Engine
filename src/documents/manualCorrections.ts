import crypto from "node:crypto";

import type { ManualRowCorrection } from "../contracts/manualApplication.js";
import { manualFitCheck, matchableEvidence, type ManualEvidence } from "./manualPreparation.js";

/**
 * The candidate's review of a manual comparison: per requirement row, accept or change the evidence,
 * or mark the requirement NOT_APPLICABLE, GAP or PARTIAL with an optional gap sentence in their own
 * words. The stored comparison is never rewritten; documents are built from the comparison with the
 * approval's corrections applied, and the corrections are fingerprinted into the approval.
 */

const DEFAULT_GAP = "No direct evidence was found in your profile. It stays unmatched in your documents; absence is not proof of inability.";
const CHOSEN_BY_CANDIDATE = "Chosen by you on the review screen.";

export class ManualCorrectionError extends Error {
  constructor(readonly issues: string[]) {
    super(`Review corrections are not valid: ${issues.join(" ")}`);
  }
}

/** Sorted by requirement key, gap sentences trimmed: the form that is stored and fingerprinted. */
export function normaliseCorrections(corrections: readonly ManualRowCorrection[]): ManualRowCorrection[] {
  return [...corrections]
    .map((row) => ({
      requirement_key: row.requirement_key,
      status: row.status,
      evidence_ids: [...row.evidence_ids],
      ...(row.gap_sentence?.trim() ? { gap_sentence: row.gap_sentence.trim() } : {}),
    }))
    .sort((left, right) => left.requirement_key.localeCompare(right.requirement_key));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the normalised corrections, or "" when the candidate changed nothing. */
export function correctionsFingerprint(corrections: readonly ManualRowCorrection[]): string {
  const normalised = normaliseCorrections(corrections);
  return normalised.length === 0 ? "" : crypto.createHash("sha256").update(stableStringify(normalised)).digest("hex");
}

/**
 * The comparison the documents are built from. Rows marked NOT_APPLICABLE leave the rows and
 * requirements; GAP rows lose their evidence; ACCEPTED and PARTIAL rows carry exactly the chosen
 * evidence, which must be document-eligible (work-done facts or credentials). A candidate's gap
 * sentence is kept on the row for the letter. The fit check is recomputed. Throws
 * ManualCorrectionError naming every unknown requirement or ineligible evidence id.
 */
export function applyManualCorrections(comparison: Record<string, any>, corrections: readonly ManualRowCorrection[]): Record<string, any> {
  if (corrections.length === 0) return comparison;
  const rows = Array.isArray(comparison.rows) ? comparison.rows as Array<Record<string, any>> : [];
  const evidence = Array.isArray(comparison.evidence) ? comparison.evidence as ManualEvidence[] : [];
  const eligible = new Map(matchableEvidence(evidence).map((item) => [item.id, item]));
  const rowKeys = new Set(rows.map((row) => String(row.requirement_key)));
  const issues: string[] = [];
  const byKey = new Map<string, ManualRowCorrection>();
  for (const correction of normaliseCorrections(corrections)) {
    if (!rowKeys.has(correction.requirement_key)) issues.push(`${correction.requirement_key} is not a requirement in this comparison.`);
    if (byKey.has(correction.requirement_key)) issues.push(`${correction.requirement_key} is corrected more than once.`);
    const ineligible = correction.evidence_ids.filter((id) => !eligible.has(id));
    if (ineligible.length > 0) issues.push(`${correction.requirement_key} cites evidence that is not a document-eligible fact or credential (${ineligible.join(", ")}).`);
    byKey.set(correction.requirement_key, correction);
  }
  if (issues.length > 0) throw new ManualCorrectionError(issues);

  const correctedRows = rows.flatMap((row) => {
    const correction = byKey.get(String(row.requirement_key));
    if (!correction) return [row];
    if (correction.status === "NOT_APPLICABLE") return [];
    const proposed = new Map((Array.isArray(row.evidence) ? row.evidence : []).map((item: { id: string }) => [item.id, item]));
    const chosen = correction.evidence_ids.map((id) => proposed.get(id) ?? (() => {
      const item = eligible.get(id)!;
      return { id: item.id, type: item.evidence_type, label: item.label, statement: item.statement, justification: CHOSEN_BY_CANDIDATE };
    })());
    return [{
      ...row,
      evidence: chosen,
      gap: correction.status === "ACCEPTED" ? (chosen.length === 0 ? DEFAULT_GAP : null)
        : correction.gap_sentence ?? (correction.status === "GAP" ? DEFAULT_GAP : null),
      review_status: correction.status,
      ...(correction.gap_sentence ? { candidate_gap_note: correction.gap_sentence } : {}),
    }];
  });
  const notApplicable = new Set([...byKey.values()].filter((row) => row.status === "NOT_APPLICABLE").map((row) => row.requirement_key));
  return {
    ...comparison,
    requirements: (Array.isArray(comparison.requirements) ? comparison.requirements : [])
      .filter((requirement: { requirement_key: string }) => !notApplicable.has(requirement.requirement_key)),
    rows: correctedRows,
    fit: manualFitCheck(correctedRows as Array<{ requirement_key: string; importance: string; requirement: string; evidence: unknown[] }>),
  };
}
