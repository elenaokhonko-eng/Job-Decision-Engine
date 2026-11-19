import { describe, expect, it } from 'vitest';
import { STAGE1_3_STAGING_IDENTITY_EXPECTATIONS as EXPECTED } from '../../db/stagingDatabaseIdentity.js';
import { requireApprovedReplayTarget } from '../../reporting/replayGuard.js';

const stagingHost = EXPECTED.approvedStagingHostnames[0];
const productionHost = EXPECTED.knownProductionHostnames[0];

describe('requireApprovedReplayTarget', () => {
  it('accepts the approved staging branch', () => {
    const result = requireApprovedReplayTarget(
      `postgresql://u:p@${stagingHost}/neondb`,
      { databaseName: 'neondb', branchId: EXPECTED.expectedBranchId },
    );
    expect(result.branchId).toBe(EXPECTED.expectedBranchId);
  });

  it('refuses the production host and the production branch, and never echoes the URL', () => {
    const secretUrl = `postgresql://user:hunter2@${productionHost}/neondb`;
    expect(() =>
      requireApprovedReplayTarget(secretUrl, { databaseName: 'neondb', branchId: EXPECTED.knownProductionBranchId }),
    ).toThrow(/Refusing to replay/);
    try {
      requireApprovedReplayTarget(secretUrl, { databaseName: 'neondb', branchId: EXPECTED.knownProductionBranchId });
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
    }
    // A production host is refused even when the branch id is unknown.
    expect(() =>
      requireApprovedReplayTarget(`postgresql://u:p@${productionHost}/neondb`, { databaseName: 'neondb', branchId: null }),
    ).toThrow(/Refusing to replay/);
  });

  it('refuses an unknown branch or database, and accepts only an explicitly supplied replay branch', () => {
    const url = 'postgresql://u:p@ep-other.c-3.ap-southeast-1.aws.neon.tech/neondb';
    expect(() => requireApprovedReplayTarget(url, { databaseName: 'neondb', branchId: 'br-unknown-123' })).toThrow();
    expect(() => requireApprovedReplayTarget(url, { databaseName: 'other', branchId: EXPECTED.expectedBranchId })).toThrow();
    expect(requireApprovedReplayTarget(url, { databaseName: 'neondb', branchId: 'br-new-replay-1' }, 'br-new-replay-1').branchId).toBe(
      'br-new-replay-1',
    );
  });
});
