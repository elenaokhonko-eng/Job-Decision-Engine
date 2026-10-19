import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('bounded current-profile rematch guard', () => {
  it('requires staging-only writes and never replays hard gates or lane routing', () => {
    const script = readFileSync(resolve('scripts/rematch_current_actionable_profile.ts'), 'utf8');

    expect(script).toContain('STAGE3_STAGING_DATABASE_URL');
    expect(script).toContain("'LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI'");
    expect(script).toContain('rerunsHardGates: false');
    expect(script).toContain('rerunsLaneRouting: false');
  });

  it('preflights embeddings and stops before recommendation or evaluation when prerequisites are incomplete', () => {
    const script = readFileSync(resolve('scripts/rematch_current_actionable_profile.ts'), 'utf8');
    const embeddingGuard = script.indexOf('Semantic embedding prerequisites are incomplete');
    const matcher = script.indexOf('runDeterministicMatcher(pool');
    const dependencyCheck = script.indexOf("error_message = 'EMBEDDING_DEPENDENCY_INCOMPLETE'");
    const recommendationRefresh = script.indexOf('runRecommendationDecider(pool');
    const evaluationEnqueue = script.indexOf('runExplanationQueueEnqueuer(pool');

    expect(embeddingGuard).toBeGreaterThanOrEqual(0);
    expect(matcher).toBeGreaterThan(embeddingGuard);
    expect(dependencyCheck).toBeGreaterThan(matcher);
    expect(recommendationRefresh).toBeGreaterThan(dependencyCheck);
    expect(evaluationEnqueue).toBeGreaterThan(dependencyCheck);
  });
});
