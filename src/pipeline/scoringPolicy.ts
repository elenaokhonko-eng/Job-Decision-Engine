/**
 * Job ranking score policy.
 *
 * `legacy_weighted_v1` is the weighted share of all requirements (the matcher's original score).
 * `topk_capability_semantic_v1` ranks a job by how well its best capability requirements are
 * covered by profile evidence: the mean semantic similarity of its top K capability requirements.
 *
 * Why (docs/requirement-extraction.md, replay experiments on the replay branch, 5-fold CV):
 *  - word overlap alone separates saved from non-fit jobs no better than chance (0.51);
 *  - years, degree and certificate rows match almost every job, so they add no ranking signal;
 *  - the share of all requirements punishes a long posting for bullets nobody matches. The top-K
 *    mean is stable across K = 3..12 (0.77-0.84). K is fixed at 7, the middle of that plateau.
 *
 * Years, degrees and credentials leave the ranking SCORE only. They are still compared against the
 * profile and still produce mandatory-qualification failures and the career-track cap; that logic
 * is not changed here. A top-K score rewards the best matches and says nothing about gaps, so
 * `unmatchedMustHaves` is reported beside each job (a must-have penalty in the score did not help:
 * it lowered separation in every tested weight).
 */

export const LEGACY_SCORING_POLICY = 'legacy_weighted_v1';
export const TOPK_SCORING_POLICY = 'topk_capability_semantic_v1';
export type ScoringPolicy = typeof LEGACY_SCORING_POLICY | typeof TOPK_SCORING_POLICY;

/** Fixed at the middle of the measured plateau (K = 6..8). Do not tune further on the same data. */
export const TOPK_K = 7;

/** The flag. Anything other than the policy name keeps the legacy score. */
export function activeScoringPolicy(env: NodeJS.ProcessEnv = process.env): ScoringPolicy {
  return env.SCORING_POLICY?.trim() === TOPK_SCORING_POLICY ? TOPK_SCORING_POLICY : LEGACY_SCORING_POLICY;
}

/** Requirement types that are checks, not ranking evidence. */
export const NON_RANKING_REQUIREMENT_TYPES: ReadonlySet<string> = new Set([
  'EXPERIENCE_YEARS',
  'DEGREE',
  'CREDENTIAL',
  'WORK_AUTH',
  'OFFICE_DAYS',
  'WORK_MODE',
  'EMPLOYMENT_TYPE',
  'TRAVEL',
  'ON_CALL',
  'SHIFT_WORK',
]);

export function isRankingRequirementType(requirementType: string): boolean {
  return !NON_RANKING_REQUIREMENT_TYPES.has(requirementType);
}

export interface RankingEvidenceRow {
  requirementType: string;
  importance: string;
  matchType: 'EXACT' | 'SEMANTIC' | 'NO_MATCH' | 'UNKNOWN';
  /** Cosine similarity of the requirement to its best profile fact, 0..1; null when not computed. */
  semanticScore: number | null;
}

export interface TopKScore {
  /** 0..100. */
  score: number;
  /** Ranking requirements that contributed (at most K). */
  contributing: number;
  /** Ranking requirements considered. */
  considered: number;
}

/** Mean semantic similarity of the K best capability requirements, scaled to 0..100. */
export function topKCapabilityScore(rows: readonly RankingEvidenceRow[], k: number = TOPK_K): TopKScore {
  const values = rows
    .filter((row) => isRankingRequirementType(row.requirementType))
    .map((row) => (row.semanticScore !== null && Number.isFinite(row.semanticScore) ? Math.max(0, Math.min(1, row.semanticScore)) : 0))
    .sort((a, b) => b - a);
  const top = values.slice(0, Math.max(1, k));
  const considered = values.length;
  if (top.length === 0 || considered === 0) return { score: 0, contributing: 0, considered: 0 };
  const mean = top.reduce((sum, value) => sum + value, 0) / top.length;
  return { score: Number((mean * 100).toFixed(6)), contributing: top.length, considered };
}

/** MUST capability requirements with no counted match (NO_MATCH or UNKNOWN). Shown beside a job. */
export function unmatchedMustHaves(rows: readonly RankingEvidenceRow[]): { unmatched: number; total: number } {
  const must = rows.filter((row) => isRankingRequirementType(row.requirementType) && row.importance === 'MUST');
  return { unmatched: must.filter((row) => row.matchType !== 'EXACT' && row.matchType !== 'SEMANTIC').length, total: must.length };
}

/**
 * The matcher policy version written to match_runs and compared by task currentness. The top-K
 * score has its own version, so turning the flag on makes older matches superseded and re-matches
 * them under the new score.
 */
export function matcherPolicyVersionFor(policy: ScoringPolicy, legacyVersion: string): string {
  return policy === TOPK_SCORING_POLICY ? `${legacyVersion}+${TOPK_SCORING_POLICY}` : legacyVersion;
}
