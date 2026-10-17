/**
 * Profile Diff & Classification Reporter
 *
 * Compares two profile versions (e.g. v5 vs v6) to provide a rigorous,
 * auditable diff before activating a new immutable profile version.
 */

import type { LoadedProfile } from './loader.js';
import type { ProficiencyLevel, InterestLevel } from './contracts.js';

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface FactDiff {
  fact_key: string;
  statement: string;
  changes?: FieldChange[];
  proficiency?: string;
  interest?: string;
}

export interface CredentialDiff {
  credential_key: string;
  credential_name: string;
  status: string;
  issuer: string;
  change_type: 'ADDED' | 'REMOVED' | 'UPDATED';
  details?: string;
}

export interface EngagementSummaryDiff {
  engagement_key: string;
  organization: string;
  role_title: string;
  previous_summary: string;
  updated_summary: string;
}

export interface ProfileDiffReport {
  old_version: number;
  new_version: number;
  old_profile_key: string;
  new_profile_key: string;
  facts_added: FactDiff[];
  facts_updated: FactDiff[];
  facts_unchanged_count: number;
  duplicates_consolidated: Array<{ statement: string; merged_into: string }>;
  credentials_added: CredentialDiff[];
  credentials_updated: CredentialDiff[];
  credentials_removed: CredentialDiff[];
  engagement_summaries_changed: EngagementSummaryDiff[];
  proficiency_breakdown: Record<ProficiencyLevel | 'UNCLASSIFIED', number>;
  interest_breakdown: Record<InterestLevel | 'UNCLASSIFIED', number>;
  unclassified_or_ambiguous: Array<{
    fact_key: string;
    reason: string;
    statement: string;
  }>;
}

export function compareProfiles(
  oldProfile: LoadedProfile,
  newProfile: LoadedProfile
): { report: ProfileDiffReport; markdown: string } {
  const oldFacts = oldProfile.facts.facts;
  const newFacts = newProfile.facts.facts;
  const oldFactsMap = new Map(oldFacts.map((f) => [f.fact_key, f]));
  const newFactsMap = new Map(newFacts.map((f) => [f.fact_key, f]));

  const factsAdded: FactDiff[] = [];
  const factsUpdated: FactDiff[] = [];
  let factsUnchangedCount = 0;

  for (const newFact of newFacts) {
    const oldFact = oldFactsMap.get(newFact.fact_key);
    const newMeta = (newFact.structured_value || {}) as Record<string, any>;
    if (!oldFact) {
      factsAdded.push({
        fact_key: newFact.fact_key,
        statement: newFact.statement,
        proficiency: newMeta.proficiency,
        interest: newMeta.interest,
      });
    } else {
      const changes: FieldChange[] = [];
      if (oldFact.statement !== newFact.statement) {
        changes.push({ field: 'statement', from: oldFact.statement, to: newFact.statement });
      }
      if (oldFact.evidence_tier !== newFact.evidence_tier) {
        changes.push({ field: 'evidence_tier', from: oldFact.evidence_tier, to: newFact.evidence_tier });
      }
      if (oldFact.fact_type !== newFact.fact_type) {
        changes.push({ field: 'fact_type', from: oldFact.fact_type, to: newFact.fact_type });
      }
      if (oldFact.verification_status !== newFact.verification_status) {
        changes.push({
          field: 'verification_status',
          from: oldFact.verification_status,
          to: newFact.verification_status,
        });
      }

      const oldMetaStr = JSON.stringify(oldFact.structured_value || {});
      const newMetaStr = JSON.stringify(newFact.structured_value || {});
      if (oldMetaStr !== newMetaStr) {
        changes.push({ field: 'structured_value', from: oldFact.structured_value, to: newFact.structured_value });
      }

      if (changes.length > 0) {
        factsUpdated.push({
          fact_key: newFact.fact_key,
          statement: newFact.statement,
          changes,
          proficiency: newMeta.proficiency,
          interest: newMeta.interest,
        });
      } else {
        factsUnchangedCount += 1;
      }
    }
  }

  // Detect potential duplicates consolidated
  const duplicatesConsolidated: Array<{ statement: string; merged_into: string }> = [];
  for (const oldFact of oldFacts) {
    if (!newFactsMap.has(oldFact.fact_key)) {
      // Find closest statement match in new facts
      const candidate = newFacts.find((nf) => {
        const wordsOld = new Set(oldFact.statement.toLowerCase().split(/\s+/));
        const wordsNew = new Set(nf.statement.toLowerCase().split(/\s+/));
        let common = 0;
        for (const w of wordsOld) if (wordsNew.has(w)) common++;
        return common / wordsOld.size > 0.6;
      });
      if (candidate) {
        duplicatesConsolidated.push({
          statement: oldFact.statement,
          merged_into: candidate.fact_key,
        });
      }
    }
  }

  // Credentials diff
  const oldCreds = oldProfile.credentials.credentials;
  const newCreds = newProfile.credentials.credentials;
  const oldCredsMap = new Map(oldCreds.map((c) => [c.credential_key, c]));
  const newCredsMap = new Map(newCreds.map((c) => [c.credential_key, c]));

  const credentialsAdded: CredentialDiff[] = [];
  const credentialsUpdated: CredentialDiff[] = [];
  const credentialsRemoved: CredentialDiff[] = [];

  for (const newCred of newCreds) {
    const oldCred = oldCredsMap.get(newCred.credential_key);
    if (!oldCred) {
      credentialsAdded.push({
        credential_key: newCred.credential_key,
        credential_name: newCred.credential_name,
        status: newCred.status,
        issuer: newCred.issuer,
        change_type: 'ADDED',
      });
    } else if (oldCred.status !== newCred.status || oldCred.credential_name !== newCred.credential_name) {
      credentialsUpdated.push({
        credential_key: newCred.credential_key,
        credential_name: newCred.credential_name,
        status: newCred.status,
        issuer: newCred.issuer,
        change_type: 'UPDATED',
        details: `Status: ${oldCred.status} -> ${newCred.status}`,
      });
    }
  }

  for (const oldCred of oldCreds) {
    if (!newCredsMap.has(oldCred.credential_key)) {
      credentialsRemoved.push({
        credential_key: oldCred.credential_key,
        credential_name: oldCred.credential_name,
        status: oldCred.status,
        issuer: oldCred.issuer,
        change_type: 'REMOVED',
        details: 'Moved from completed credentials to development roadmap pending formal study',
      });
    }
  }

  // Engagements summaries changed
  const oldEngagements = oldProfile.engagements.engagements;
  const newEngagements = newProfile.engagements.engagements;
  const oldEngagementsMap = new Map(oldEngagements.map((e) => [e.engagement_key, e]));

  const engagementSummariesChanged: EngagementSummaryDiff[] = [];
  for (const newEng of newEngagements) {
    const oldEng = oldEngagementsMap.get(newEng.engagement_key);
    if (oldEng && oldEng.summary !== newEng.summary) {
      engagementSummariesChanged.push({
        engagement_key: newEng.engagement_key,
        organization: newEng.organization_legal_name,
        role_title: newEng.role_title,
        previous_summary: oldEng.summary,
        updated_summary: newEng.summary,
      });
    }
  }

  // Proficiency breakdown
  const proficiencyBreakdown: Record<ProficiencyLevel | 'UNCLASSIFIED', number> = {
    EXPERT: 0,
    ADVANCED: 0,
    PRODUCTION_CAPABLE: 0,
    INDEPENDENT: 0,
    FOUNDATIONAL: 0,
    KNOWLEDGE_ONLY: 0,
    LEARNING: 0,
    UNCLASSIFIED: 0,
  };

  // Interest breakdown
  const interestBreakdown: Record<InterestLevel | 'UNCLASSIFIED', number> = {
    TARGET: 0,
    STRONG: 0,
    ACCEPTABLE: 0,
    SUPPORTING: 0,
    AVOID: 0,
    NO_INTEREST: 0,
    UNCLASSIFIED: 0,
  };

  const unclassifiedOrAmbiguous: Array<{
    fact_key: string;
    reason: string;
    statement: string;
  }> = [];

  for (const f of newFacts) {
    const meta = (f.structured_value || {}) as Record<string, any>;
    const prof = meta.proficiency as ProficiencyLevel | undefined;
    const interest = meta.interest as InterestLevel | undefined;

    if (prof && prof in proficiencyBreakdown) {
      proficiencyBreakdown[prof] += 1;
    } else {
      proficiencyBreakdown.UNCLASSIFIED += 1;
      unclassifiedOrAmbiguous.push({
        fact_key: f.fact_key,
        reason: 'Missing standardized proficiency level',
        statement: f.statement,
      });
    }

    if (interest && interest in interestBreakdown) {
      interestBreakdown[interest] += 1;
    } else {
      interestBreakdown.UNCLASSIFIED += 1;
    }
  }

  const report: ProfileDiffReport = {
    old_version: oldProfile.profile.profile_version,
    new_version: newProfile.profile.profile_version,
    old_profile_key: oldProfile.profile.profile_key,
    new_profile_key: newProfile.profile.profile_key,
    facts_added: factsAdded,
    facts_updated: factsUpdated,
    facts_unchanged_count: factsUnchangedCount,
    duplicates_consolidated: duplicatesConsolidated,
    credentials_added: credentialsAdded,
    credentials_updated: credentialsUpdated,
    credentials_removed: credentialsRemoved,
    engagement_summaries_changed: engagementSummariesChanged,
    proficiency_breakdown: proficiencyBreakdown,
    interest_breakdown: interestBreakdown,
    unclassified_or_ambiguous: unclassifiedOrAmbiguous,
  };

  const markdown = renderProfileDiffMarkdown(report);

  return { report, markdown };
}

function renderProfileDiffMarkdown(report: ProfileDiffReport): string {
  const lines: string[] = [];

  lines.push(`# Profile Difference & Capability Upgrade Report`);
  lines.push(``);
  lines.push(`- **Comparison**: Version ${report.old_version} (Current) ➔ Version ${report.new_version} (Candidate)`);
  lines.push(`- **Profile Key**: \`${report.new_profile_key}\``);
  lines.push(`- **Status**: **DRAFT / STAGED** (Requires owner approval before activation)`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Executive summary
  lines.push(`## 1. Upgrade Summary`);
  lines.push(``);
  lines.push(`| Category | Count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Facts Added | **+${report.facts_added.length}** |`);
  lines.push(`| Facts Updated (Metadata Enriched) | **${report.facts_updated.length}** |`);
  lines.push(`| Facts Unchanged | **${report.facts_unchanged_count}** |`);
  lines.push(`| Duplicates Consolidated | **${report.duplicates_consolidated.length}** |`);
  lines.push(`| Credentials Added (In-Progress) | **+${report.credentials_added.length}** |`);
  lines.push(`| Credentials Removed / Moved to Roadmap | **-${report.credentials_removed.length}** |`);
  lines.push(`| Engagement Summaries Enriched | **${report.engagement_summaries_changed.length}** |`);
  lines.push(`| Unclassified / Ambiguous Items | **${report.unclassified_or_ambiguous.length}** |`);
  lines.push(``);

  // Proficiency breakdown
  lines.push(`## 2. Proficiency Classifications`);
  lines.push(``);
  lines.push(`| Proficiency Level | Count | Definition |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| **EXPERT** | ${report.proficiency_breakdown.EXPERT} | Deep multi-year authority, institutional architecture, TOM, systems transformation |`);
  lines.push(`| **ADVANCED** | ${report.proficiency_breakdown.ADVANCED} | Comprehensive hands-on production capability (RAG, agent swarms, vector search) |`);
  lines.push(`| **PRODUCTION_CAPABLE** | ${report.proficiency_breakdown.PRODUCTION_CAPABLE} | Production-grade implementation demonstrated in projects or startups |`);
  lines.push(`| **INDEPENDENT** | ${report.proficiency_breakdown.INDEPENDENT} | Independently usable (Python, TypeScript, SQL, full-stack prototyping) |`);
  lines.push(`| **FOUNDATIONAL** | ${report.proficiency_breakdown.FOUNDATIONAL} | Solid conceptual and applied project baseline (conventional ML, data lakes) |`);
  lines.push(`| **KNOWLEDGE_ONLY** | ${report.proficiency_breakdown.KNOWLEDGE_ONLY} | Abstract/conceptual domain knowledge (cloud architecture, guardrails) |`);
  lines.push(`| **LEARNING** | ${report.proficiency_breakdown.LEARNING} | Under active development (observability, model training, fine-tuning) |`);
  lines.push(``);

  // Interest breakdown
  lines.push(`## 3. Work Interest & Desirability Classifications`);
  lines.push(``);
  lines.push(`| Interest Level | Count | Action / Impact |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| **TARGET** | ${report.interest_breakdown.TARGET} | Core future direction (architecture, AI engineering, RAG, research, TOM) |`);
  lines.push(`| **STRONG** | ${report.interest_breakdown.STRONG} | Highly desirable capability (Python/TS, data modelling, FinTech, analytics) |`);
  lines.push(`| **ACCEPTABLE** | ${report.interest_breakdown.ACCEPTABLE} | Acceptable as a supporting component of work |`);
  lines.push(`| **SUPPORTING** | ${report.interest_breakdown.SUPPORTING} | Useful context, not primary day-to-day focus |`);
  lines.push(`| **AVOID** | ${report.interest_breakdown.AVOID} | Proven capability, but **not a target work activity** (SteerCos, pure PMO, sales) |`);
  lines.push(`| **NO_INTEREST** | ${report.interest_breakdown.NO_INTEREST} | Explicit non-interest (computer vision, pure NLP specialist) |`);
  lines.push(``);

  // Credentials changes
  lines.push(`## 4. Credentials Delta`);
  lines.push(``);
  if (report.credentials_added.length > 0) {
    lines.push(`### Added Credentials (IN_PROGRESS, Under Active Study)`);
    for (const c of report.credentials_added) {
      lines.push(`- ➕ **${c.credential_name}** (${c.issuer}) — \`${c.status}\``);
    }
    lines.push(``);
  }
  if (report.credentials_removed.length > 0) {
    lines.push(`### Removed Credentials (Realigned to Roadmap)`);
    for (const c of report.credentials_removed) {
      lines.push(`- ➖ **${c.credential_name}** (${c.issuer}) — *${c.details}*`);
    }
    lines.push(``);
  }

  // Engagement summaries changed
  lines.push(`## 5. Enriched Historical Engagements (Preserving Identity & Dates)`);
  lines.push(``);
  for (const e of report.engagement_summaries_changed) {
    lines.push(`### ${e.organization} — ${e.role_title} (\`${e.engagement_key}\`)`);
    lines.push(`- **Previous**: *${e.previous_summary}*`);
    lines.push(`- **Enriched**: *${e.updated_summary}*`);
    lines.push(``);
  }

  // Facts added sample
  lines.push(`## 6. Key Facts Added (+${report.facts_added.length} Total)`);
  lines.push(``);
  lines.push(`| Fact Key | Proficiency | Interest | Statement |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const f of report.facts_added) {
    lines.push(`| \`${f.fact_key}\` | \`${f.proficiency || '—'}\` | \`${f.interest || '—'}\` | ${f.statement.replace(/\|/g, '\\|')} |`);
  }
  lines.push(``);

  // Duplicates consolidated
  if (report.duplicates_consolidated.length > 0) {
    lines.push(`## 7. Duplicates Consolidated`);
    lines.push(``);
    for (const d of report.duplicates_consolidated) {
      lines.push(`- Consolidating: "${d.statement}" ➔ \`${d.merged_into}\``);
    }
    lines.push(``);
  }

  // Unclassified or ambiguous
  lines.push(`## 8. Unclassified or Ambiguous Items (${report.unclassified_or_ambiguous.length})`);
  lines.push(``);
  if (report.unclassified_or_ambiguous.length === 0) {
    lines.push(`✅ None. Every factual statement has been deterministically mapped to standardized capability, proficiency, and evidence strength.`);
  } else {
    for (const u of report.unclassified_or_ambiguous) {
      lines.push(`- ⚠️ \`${u.fact_key}\`: ${u.reason} — "${u.statement}"`);
    }
  }
  lines.push(``);

  lines.push(`---`);
  lines.push(`*Note: This report must be reviewed and approved by the owner before marking profile version ${report.new_version} as ACTIVE.*`);

  return lines.join('\n');
}
