/**
 * Stage 3 Company & Source Planning Utility
 *
 * Generates a comprehensive dry-run intelligence report for:
 * - Target company watchlist
 * - ATS endpoints & careers feeds
 * - Remote-policy & Singapore-hiring evidence
 * - Weekly polling schedule & rate limits
 * - University & research lab targets (Europe & APAC)
 *
 * Usage:
 *   npx tsx scripts/stage3_mobility_watchlist.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadProfile } from '../src/profile/loader.js';
import {
  EmployerWatchlistPreferencesSchema,
  type EmployerWatchlistPreferences,
} from '../src/policy/stage3Contracts.js';

interface TargetCompanyPlan {
  name: string;
  selection_basis: 'USER_WATCHLIST';
  ats_discovery_status: 'TO_VERIFY';
  remote_policy_status: 'TO_VERIFY';
  singapore_employment_status: 'TO_VERIFY';
  temporary_work_abroad_status: 'TO_VERIFY';
  evidence_source_url: null;
  evidence_quote: null;
  confidence: 'UNKNOWN';
  polling_status: 'PROPOSED_DISABLED';
}

interface ResearchInstitutionPlan {
  name: string;
  country: string;
  thematic_focus: string;
  target_roles: string[];
  preference_provenance: 'USER_PROVIDED_SHORTLIST';
  employment_feasibility: 'TO_VERIFY';
  source_url: null;
}

export function generateCompanySourcePlan(
  watchlistPolicy: EmployerWatchlistPreferences = EmployerWatchlistPreferencesSchema.parse({})
) {
  const targetCompanies: TargetCompanyPlan[] = (watchlistPolicy.watchlist_companies ?? []).map((name) => ({
    name,
    selection_basis: 'USER_WATCHLIST' as const,
    ats_discovery_status: 'TO_VERIFY' as const,
    remote_policy_status: 'TO_VERIFY' as const,
    singapore_employment_status: 'TO_VERIFY' as const,
    temporary_work_abroad_status: 'TO_VERIFY' as const,
    evidence_source_url: null,
    evidence_quote: null,
    confidence: 'UNKNOWN' as const,
    polling_status: 'PROPOSED_DISABLED' as const,
  }));

  const researchInstitutions: ResearchInstitutionPlan[] = [
    {
      name: 'Karolinska Institutet (KIND / HER MIND)',
      country: 'Sweden',
      thematic_focus: 'Autism and ADHD in women, reproductive health, hormones, neurodevelopment',
      target_roles: ['Research Engineer', 'Research Software Engineer', 'Data/ML Engineer', 'Research Data Scientist'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'Maastricht University (Neuropsychology & Psychopharmacology)',
      country: 'Netherlands',
      thematic_focus: 'Psychoactive compounds, brain mechanisms, cognition, therapeutic effects',
      target_roles: ['Research Software Engineer', 'Data/ML Engineer', 'Research Data Scientist'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'Leiden University (Lifestyle Brain Interaction)',
      country: 'Netherlands',
      thematic_focus: 'Metabolic psychiatry, nutrition, ADHD and autism research',
      target_roles: ['Research Engineer', 'Bioinformatics/Data Platform Engineer', 'Research Platform Architect'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'Radboudumc / Donders Institute',
      country: 'Netherlands',
      thematic_focus: 'ADHD, autism, neurodevelopment, cognitive and neural mechanisms',
      target_roles: ['Research Software Engineer', 'Data/ML Engineer', 'Research Platform Architect'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'Duke-NUS Medical School',
      country: 'Singapore',
      thematic_focus: 'Neuroscience, behavioural disorders, AI/data research',
      target_roles: ['AI Research Infrastructure Engineer', 'Research Platform Architect', 'Research Data Scientist'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'Queensland Brain Institute',
      country: 'Australia',
      thematic_focus: 'Autism and ADHD neuroscience, neural circuits, computational neuroscience',
      target_roles: ['Research Engineer', 'Computational Research Engineer', 'Data/ML Engineer'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'University of Cambridge (Autism Research Centre / K. Lisa Yang Centre)',
      country: 'United Kingdom',
      thematic_focus: 'Multidisciplinary autism research, neuroscience, genetics, endocrinology, bioinformatics',
      target_roles: ['Research Software Engineer', 'Data/ML Engineer', 'Research Data Scientist'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'RIKEN Center for Brain Science',
      country: 'Japan',
      thematic_focus: 'Autism and neurodevelopment across neural circuits, genetics and computational science',
      target_roles: ['Computational Science Platform Engineer', 'Research Data Engineer', 'Research Software Engineer'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'NUS Medicine (Womens Health Research)',
      country: 'Singapore',
      thematic_focus: 'Womens health, reproductive longevity, digital medicine and longitudinal cohorts',
      target_roles: ['Research Platform Architect', 'Research Data Scientist', 'AI Research Infrastructure Engineer'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'University of Melbourne (Brain & Mental Health Hub / Attention Dynamics Lab)',
      country: 'Australia',
      thematic_focus: 'ADHD, autism, attention and neurodevelopment research',
      target_roles: ['Research Engineer', 'Research Software Engineer', 'Data/ML Engineer'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'University of Otago (Neuroscience)',
      country: 'New Zealand',
      thematic_focus: 'ADHD, autism, neuroscience and brain-hormone interactions',
      target_roles: ['Research Software Engineer', 'Research Data Engineer', 'Research Data Scientist'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
    {
      name: 'Wageningen University & Research',
      country: 'Netherlands',
      thematic_focus: 'Medicinal mushrooms, plants and active biological compounds',
      target_roles: ['Scientific Computing Engineer', 'Research Data Engineer', 'Research Software Engineer'],
      preference_provenance: 'USER_PROVIDED_SHORTLIST',
      employment_feasibility: 'TO_VERIFY',
      source_url: null,
    },
  ];

  return {
    targetCompanies,
    researchInstitutions,
    excludedEmployers: watchlistPolicy.excluded_employers ?? [],
    excludedOperatingModels: watchlistPolicy.excluded_operating_models ?? [],
    allowedExceptions: watchlistPolicy.allowed_exceptions ?? [],
  };
}

export function renderCompanySourcePlanMarkdown(plan: ReturnType<typeof generateCompanySourcePlan>): string {
  const lines: string[] = [];
  lines.push('# Stage 3 Company and Source Plan');
  lines.push('');
  lines.push('> Status: DRY RUN ONLY. Automated polling is disabled and requires separate owner approval.');
  lines.push('> Evidence status: No employer policy has been verified in this planning pass.');
  lines.push('');
  lines.push('## Target Employers');
  lines.push('');
  lines.push('| Company | ATS/source method | Remote policy | Singapore hiring | Temporary work abroad | Evidence | Polling |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const company of plan.targetCompanies) {
    lines.push(`| **${company.name}** | ${company.ats_discovery_status} | ${company.remote_policy_status} | ${company.singapore_employment_status} | ${company.temporary_work_abroad_status} | URL: ${company.evidence_source_url ?? 'not researched'}; quote: ${company.evidence_quote ?? 'none'}; confidence: ${company.confidence} | ${company.polling_status} |`);
  }
  lines.push('');
  lines.push('## Research Institutions and Labs');
  lines.push('');
  lines.push('These targets and research themes are from the user-provided shortlist. Employment eligibility and remote feasibility remain unverified. US universities are excluded from target preference.');
  lines.push('');
  lines.push('| Institution | Country | User-provided research fit | Target engineering roles | Employment feasibility |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const institution of plan.researchInstitutions) {
    lines.push(`| **${institution.name}** | ${institution.country} | ${institution.thematic_focus} | ${institution.target_roles.join(', ')} | ${institution.employment_feasibility} |`);
  }
  lines.push('');
  lines.push('## Weekly Discovery Proposal');
  lines.push('');
  lines.push(`- Proposed cadence: weekly for ${plan.targetCompanies.length} named employers and ${plan.researchInstitutions.length} research institutions.`);
  lines.push(`- Initial request estimate: at most ${plan.targetCompanies.length + plan.researchInstitutions.length} index/page checks per week if one public endpoint is verified per target; ATS pagination volume is not yet estimated.`);
  lines.push('- Candidate source methods: official public ATS/API or public careers page, selected only after endpoint, terms, date quality, geography, and duplicate rates are verified.');
  lines.push('- Current state: no requests are scheduled and no company source is enabled.');
  lines.push('- No authenticated scraping, access-control circumvention, or unapproved scraping will be used.');
  lines.push('');
  lines.push('## Employer Preferences and Exclusions');
  lines.push('');
  lines.push(`- Named exclusions: ${plan.excludedEmployers.length ? plan.excludedEmployers.join(', ') : 'none configured'}.`);
  lines.push(`- Operating-model exclusions: ${plan.excludedOperatingModels.length ? plan.excludedOperatingModels.join(', ') : 'none configured'}.`);
  lines.push(`- Named exceptions: ${plan.allowedExceptions.length ? plan.allowedExceptions.join(', ') : 'none configured'}.`);
  lines.push('- Recruiter introduction and staffing-agency legal employment are tracked as different relationships.');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  console.log('=== Stage 3: Company & Source Plan (DRY RUN) ===\n');
  const profile = await loadProfile();
  const watchlist = EmployerWatchlistPreferencesSchema.parse(profile.workPreferences?.watchlist ?? {});
  const plan = generateCompanySourcePlan(watchlist);
  const md = renderCompanySourcePlanMarkdown(plan);

  const outputPath = path.join('private/profile', 'stage3_company_source_plan.md');
  fs.writeFileSync(outputPath, md + '\n');

  console.log(`Plan generated at ${outputPath}; no sources enabled.`);
  console.log(`Target employers: ${plan.targetCompanies.length}`);
  console.log(`Research institutions: ${plan.researchInstitutions.length}`);
  console.log(`Proposed maximum weekly index checks: ${plan.targetCompanies.length + plan.researchInstitutions.length}`);
  console.log('All company policy and ATS endpoints remain TO_VERIFY pending owner approval.');
}

if (process.argv[1]?.endsWith('stage3_mobility_watchlist.ts') || process.argv[1]?.endsWith('stage3_mobility_watchlist.js')) {
  main().catch(console.error);
}
