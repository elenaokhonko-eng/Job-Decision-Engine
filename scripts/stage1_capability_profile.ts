/**
 * Stage 1 Capability Profile Command-Line Utility
 *
 * Usage:
 *   npx tsx scripts/stage1_capability_profile.ts --generate
 *   npx tsx scripts/stage1_capability_profile.ts --diff
 *   npx tsx scripts/stage1_capability_profile.ts --rematch
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadProfile } from '../src/profile/loader.js';
import { generateCapabilityProfile } from '../src/profile/capabilityProfileGenerator.js';
import { compareProfiles } from '../src/profile/profileDiff.js';
import { rematchActionableJobs } from '../src/pipeline/deterministicMatcher.js';

async function main() {
  const args = process.argv.slice(2);
  const doGenerate = args.includes('--generate') || args.length === 0;
  const doDiff = args.includes('--diff') || args.length === 0;
  const doRematch = args.includes('--rematch');

  console.log('=== Stage 1 Capability Profile V1 ===');

  if (doGenerate) {
    console.log('\n--- Generating Derived Artifacts ---');
    const loaded = await loadProfile();
    const { capabilityProfile, markdown } = generateCapabilityProfile(loaded, {
      profileVersionId: `v${loaded.profile.profile_version}`,
    });

    const jsonPath = path.join('private/profile', 'capability_profile.json');
    const mdPath = path.join('private/profile', 'skills.md');

    fs.writeFileSync(jsonPath, JSON.stringify(capabilityProfile, null, 2) + '\n');
    fs.writeFileSync(mdPath, markdown + '\n');

    console.log(`✓ Wrote ${jsonPath} (${Object.keys(capabilityProfile.evidence_index).length} facts indexed)`);
    console.log(`✓ Wrote ${mdPath} (${markdown.split('\n').length} lines)`);
  }

  if (doDiff) {
    console.log('\n--- Generating Version Diff Report ---');
    const v5Dir = 'private/profile_v5';
    if (!fs.existsSync(v5Dir)) {
      console.warn(`Old profile directory ${v5Dir} not found; skipping diff.`);
    } else {
      const oldProfile = await loadProfile(v5Dir);
      const newProfile = await loadProfile('private/profile');

      const { report, markdown } = compareProfiles(oldProfile, newProfile);
      const diffReportPath = path.join('private/profile', 'profile_diff_report.md');
      fs.writeFileSync(diffReportPath, markdown + '\n');

      console.log(`✓ Profile Diff Report generated at ${diffReportPath}`);
      console.log(`  - Version ${report.old_version} -> Version ${report.new_version}`);
      console.log(`  - Facts Added: +${report.facts_added.length}`);
      console.log(`  - Facts Updated: ${report.facts_updated.length}`);
      console.log(`  - Credentials Added: +${report.credentials_added.length}`);
      console.log(`  - Credentials Removed/Roadmapped: -${report.credentials_removed.length}`);
      console.log(`  - Engagement Summaries Changed: ${report.engagement_summaries_changed.length}`);
      console.log(`  - Unclassified / Ambiguous: ${report.unclassified_or_ambiguous.length}`);
    }
  }

  if (doRematch) {
    console.log('\n--- Running Bounded Actionable Jobs Rematch ---');
    try {
      const summary = await rematchActionableJobs();
      console.log(`✓ Bounded rematch complete:`, summary);
    } catch (error: any) {
      console.error('Bounded rematch error:', error?.message || error);
    }
  }

  console.log('\nStage 1 Capability Profile processing complete.');
}

main().catch((err) => {
  console.error('Execution failed:', err);
  process.exit(1);
});
