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

  it('uses the evaluator lineage contract and reconciles stale profile-v6 queue rows', () => {
    const script = readFileSync(resolve('scripts/run_stage1_3_staging_evaluation_smoke.ts'), 'utf8');
    const evaluator = readFileSync(resolve('scripts/evaluate_queue.ts'), 'utf8');
    const lineage = readFileSync(resolve('src/pipeline/evaluationQueueLineage.ts'), 'utf8');
    const identityGuard = readFileSync(resolve('src/db/stagingDatabaseIdentity.ts'), 'utf8');

    expect(script).toContain('STAGE3_STAGING_DATABASE_URL');
    expect(script).toContain('STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.expectedBranchId');
    expect(script).toContain('createStagingDatabaseIdentityDiagnostic');
    expect(script).toContain('console.log(identityDiagnostic)');
    expect(identityGuard).toContain('expectedBranchId: "br-orange-boat-azehba7u"');
    expect(identityGuard).toContain('knownProductionBranchId: "br-sweet-lab-azucfmoz"');
    expect(identityGuard).toContain('ep-lingering-frog-azbw8weo.c-3.ap-southeast-1.aws.neon.tech');
    expect(identityGuard).toContain('ep-damp-glade-az7npbae.c-3.ap-southeast-1.aws.neon.tech');
    expect(script).toContain('MAX_SMOKE_JOBS = 500');
    expect(script).toContain('supersedeStaleEvaluationQueueRows');
    expect(script).toContain('selectEligibleEvaluationQueueRows');
    expect(evaluator).toContain('selectEligibleEvaluationQueueRows');
    expect(evaluator).toContain('supersedeStaleEvaluationQueueRows');
    expect(script).toContain('jobVersionIds');
    expect(script).toContain("process.env.EVALUATION_EXIT_ON_RETRY_WAIT = 'false'");
    expect(script).toContain('runEvaluationQueueWithExitPolicy');
    expect(script).toContain('cohort_technical_errors');
    expect(script).toContain('newlyIntroducedStagingDebt');
    expect(script).toContain('workspaceDebtBeforeReconciliation: workspaceDebtBefore');
    expect(script).toContain('unchangedInheritedDebtIsInformational: true');
    expect(script).toContain('NEW REGRESSION CAUSED BY RELEASE');
    expect(script).toContain('PRE-EXISTING PROD DEBT (unchanged during smoke)');
    expect(script).not.toContain("--apply requires an explicit --limit=N bound.");
    expect(script).not.toContain('countValue(readModels.technical_errors) > 0');
    expect(lineage).toContain('dd.context_fingerprint = eq.context_fingerprint');
    expect(lineage).toContain('mr.context_fingerprint IS NOT NULL');
    expect(lineage).not.toContain('mr.context_fingerprint = eq.context_fingerprint');
    expect(lineage).toContain('eq.job_version_id = c.latest_job_version_id');
    expect(lineage).toContain('eq.match_run_id = c.latest_match_run_id');
    expect(lineage).toContain('eq.deterministic_decision_id = c.latest_deterministic_decision_id');
    expect(script.indexOf('if (!apply) return;')).toBeLessThan(
      script.indexOf("import('./evaluate_queue.js')")
    );
  });
});
