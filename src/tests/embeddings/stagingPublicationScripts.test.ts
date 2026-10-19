import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Stage 1–3 staging-only model scripts', () => {
  it('publishes only profile facts and current requirements through the primary canonical path', () => {
    const script = readFileSync(resolve('scripts/publish_stage1_3_staging_embeddings.ts'), 'utf8');

    expect(script).toContain('STAGE3_STAGING_DATABASE_URL');
    expect(script).toContain("EXPECTED_STAGING_BRANCH_ID = 'br-orange-boat-azehba7u'");
    expect(script).toContain("model: 'gemini-embedding-001'");
    expect(script).toContain('dimensions: 768');
    expect(script).toContain('includeProfileFacts: true');
    expect(script).toContain('profileVersionId: activeProfile.id');
    expect(script).toContain('includeJobVersions: false');
    expect(script).toContain('includeLanePrototypes: false');
    expect(script).toContain('allowFallback: false');
    expect(script).toContain('expectedPrimarySpaceId: PRIMARY_SPACE.id');
    expect(script).toContain('if (!apply) return;');
    expect(script.indexOf('if (!apply) return;')).toBeLessThan(
      script.indexOf("await import('../src/embeddings/batchCoordinator.js')")
    );
    expect(script).not.toContain('INSERT INTO semantic_embeddings');
  });

  it('scopes the evaluation smoke to active profile-v6 queue items and a small limit', () => {
    const script = readFileSync(resolve('scripts/run_stage1_3_staging_evaluation_smoke.ts'), 'utf8');

    expect(script).toContain('STAGE3_STAGING_DATABASE_URL');
    expect(script).toContain("EXPECTED_STAGING_BRANCH_ID = 'br-orange-boat-azehba7u'");
    expect(script).toContain('MAX_SMOKE_JOBS = 500');
    expect(script).toContain('eq.profile_version_id = $2');
    expect(script).toContain('eq.enqueued_at >= $3');
    expect(script).toContain('jobVersionIds');
    expect(script).toContain("process.env.EVALUATION_EXIT_ON_RETRY_WAIT = 'false'");
    expect(script).toContain('runEvaluationQueueWithExitPolicy');
    expect(script.indexOf('if (!apply || candidates.length === 0) return;')).toBeLessThan(
      script.indexOf("import('./evaluate_queue.js')")
    );
  });
});
