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
  MobilityPreferencesSchema,
  type EmployerWatchlistPreferences,
} from '../src/policy/stage3Contracts.js';

interface TargetCompanyPlan {
  name: string;
  category: string;
  ats_type: 'GREENHOUSE' | 'ASHBY' | 'LEVER' | 'WORKDAY' | 'CAREERS_PAGE';
  feed_url: string;
  singapore_hiring_support: 'DIRECT_ENTITY' | 'EOR_SUPPORTED' | 'REMOTE_ELIGIBLE' | 'TO_VERIFY';
  remote_policy_summary: string;
  polling_frequency: string;
}

interface ResearchInstitutionPlan {
  name: string;
  country: string;
  thematic_focus: string;
  target_roles: string[];
  careers_url: string;
}

export function generateCompanySourcePlan(
  watchlistPolicy: EmployerWatchlistPreferences = EmployerWatchlistPreferencesSchema.parse({})
) {
  const targetCompanies: TargetCompanyPlan[] = [
    {
      name: 'Supabase',
      category: 'DATABASE_DATA_PLATFORMS',
      ats_type: 'ASHBY',
      feed_url: 'https://api.ashbyhq.com/posting-api/job-board/supabase',
      singapore_hiring_support: 'EOR_SUPPORTED',
      remote_policy_summary: 'Fully remote, distributed global team with Singapore eligibility.',
      polling_frequency: 'Weekly (Mondays 08:00 SGT)',
    },
    {
      name: 'Neon',
      category: 'DATABASE_DATA_PLATFORMS',
      ats_type: 'ASHBY',
      feed_url: 'https://api.ashbyhq.com/posting-api/job-board/neon',
      singapore_hiring_support: 'EOR_SUPPORTED',
      remote_policy_summary: 'Remote-first global database infrastructure team.',
      polling_frequency: 'Weekly (Mondays 08:00 SGT)',
    },
    {
      name: 'Clerk',
      category: 'DEVELOPER_INFRASTRUCTURE',
      ats_type: 'ASHBY',
      feed_url: 'https://api.ashbyhq.com/posting-api/job-board/clerk',
      singapore_hiring_support: 'EOR_SUPPORTED',
      remote_policy_summary: 'Developer authentication platform, remote-friendly.',
      polling_frequency: 'Weekly (Mondays 08:00 SGT)',
    },
    {
      name: 'MongoDB',
      category: 'DATABASE_DATA_PLATFORMS',
      ats_type: 'GREENHOUSE',
      feed_url: 'https://boards-api.greenhouse.io/v1/boards/mongodb/jobs',
      singapore_hiring_support: 'DIRECT_ENTITY',
      remote_policy_summary: 'Registered Singapore entity (MongoDB Singapore Pte Ltd); remote & hybrid roles.',
      polling_frequency: 'Weekly (Tuesdays 08:00 SGT)',
    },
    {
      name: 'Google',
      category: 'CLOUD_PLATFORMS',
      ats_type: 'CAREERS_PAGE',
      feed_url: 'https://careers.google.com/api/v3/search/',
      singapore_hiring_support: 'DIRECT_ENTITY',
      remote_policy_summary: 'Major Singapore campus (Google Asia Pacific); cloud architecture & AI roles.',
      polling_frequency: 'Weekly (Tuesdays 08:00 SGT)',
    },
    {
      name: 'Microsoft',
      category: 'CLOUD_PLATFORMS',
      ats_type: 'CAREERS_PAGE',
      feed_url: 'https://careers.microsoft.com/services/jobs',
      singapore_hiring_support: 'DIRECT_ENTITY',
      remote_policy_summary: 'Microsoft Singapore entity; Azure, cloud solution architect & AI positions.',
      polling_frequency: 'Weekly (Tuesdays 08:00 SGT)',
    },
    {
      name: 'NVIDIA',
      category: 'AI_FOUNDATION_MODELS',
      ats_type: 'WORKDAY',
      feed_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
      singapore_hiring_support: 'DIRECT_ENTITY',
      remote_policy_summary: 'NVIDIA Singapore entity; AI infrastructure, solutions architect, software platforms.',
      polling_frequency: 'Weekly (Wednesdays 08:00 SGT)',
    },
    {
      name: 'GitHub',
      category: 'DEVELOPER_TOOLS',
      ats_type: 'GREENHOUSE',
      feed_url: 'https://boards-api.greenhouse.io/v1/boards/github/jobs',
      singapore_hiring_support: 'DIRECT_ENTITY',
      remote_policy_summary: 'Fully remote-first culture; Singapore remote employment supported.',
      polling_frequency: 'Weekly (Wednesdays 08:00 SGT)',
    },
    {
      name: 'Cursor (Anysphere)',
      category: 'DEVELOPER_TOOLS',
      ats_type: 'ASHBY',
      feed_url: 'https://api.ashbyhq.com/posting-api/job-board/anysphere',
      singapore_hiring_support: 'REMOTE_ELIGIBLE',
      remote_policy_summary: 'AI code editor, high autonomy, distributed systems focus.',
      polling_frequency: 'Weekly (Wednesdays 08:00 SGT)',
    },
    {
      name: 'Discord',
      category: 'AI_NATIVE_PRODUCTS',
      ats_type: 'GREENHOUSE',
      feed_url: 'https://boards-api.greenhouse.io/v1/boards/discord/jobs',
      singapore_hiring_support: 'REMOTE_ELIGIBLE',
      remote_policy_summary: 'Distributed engineering teams, infrastructure and platform engineering.',
      polling_frequency: 'Weekly (Thursdays 08:00 SGT)',
    },
    {
      name: 'LangChain',
      category: 'AGENTIC_AI_INFRASTRUCTURE',
      ats_type: 'ASHBY',
      feed_url: 'https://api.ashbyhq.com/posting-api/job-board/langchain',
      singapore_hiring_support: 'REMOTE_ELIGIBLE',
      remote_policy_summary: 'Leading agentic AI orchestration framework; distributed engineering team.',
      polling_frequency: 'Weekly (Thursdays 08:00 SGT)',
    },
    {
      name: 'Grab',
      category: 'AI_NATIVE_PRODUCTS',
      ats_type: 'CAREERS_PAGE',
      feed_url: 'https://grab.careers/jobs/',
      singapore_hiring_support: 'DIRECT_ENTITY',
      remote_policy_summary: 'Headquartered in Singapore; AI platform, fintech, and data infrastructure.',
      polling_frequency: 'Weekly (Fridays 08:00 SGT)',
    },
    {
      name: 'Harvey AI',
      category: 'LEGALTECH',
      ats_type: 'ASHBY',
      feed_url: 'https://api.ashbyhq.com/posting-api/job-board/harvey',
      singapore_hiring_support: 'TO_VERIFY',
      remote_policy_summary: 'Frontier legal AI platform; solutions architecture & enterprise deployments.',
      polling_frequency: 'Weekly (Fridays 08:00 SGT)',
    },
  ];

  const researchInstitutions: ResearchInstitutionPlan[] = [
    {
      name: 'Karolinska Institutet (HER MIND & KIND Labs)',
      country: 'Sweden',
      thematic_focus: 'ADHD + Autism in women, reproductive health, neurodevelopmental biomarkers',
      target_roles: ['Research Engineer', 'Data Platform Architect', 'Computational Neuroscientist'],
      careers_url: 'https://ki.se/en/about/work-at-ki',
    },
    {
      name: 'Maastricht University (Neuropsychology & Psychopharmacology)',
      country: 'Netherlands',
      thematic_focus: 'Psychoactive compounds, brain mechanisms, cognition and psychiatric therapeutics',
      target_roles: ['Research Software Engineer', 'Data/ML Engineer', 'Research Data Scientist'],
      careers_url: 'https://www.maastrichtuniversity.nl/about-um/working-at-um',
    },
    {
      name: 'Leiden University (Lifestyle Brain Interaction Lab)',
      country: 'Netherlands',
      thematic_focus: 'Metabolic psychiatry, nutrition, ADHD and autism neurology',
      target_roles: ['Research Platform Engineer', 'Bioinformatics Platform Specialist'],
      careers_url: 'https://www.universiteitleiden.nl/en/vacancies',
    },
    {
      name: 'Duke-NUS Medical School',
      country: 'Singapore',
      thematic_focus: 'Neuroscience & behavioural disorders, AI wearables, personalised medicine',
      target_roles: ['AI Research Infrastructure Engineer', 'Research Platform Architect'],
      careers_url: 'https://www.duke-nus.edu.sg/about/careers',
    },
    {
      name: 'University of Cambridge (Autism Research Centre)',
      country: 'United Kingdom',
      thematic_focus: 'Multidisciplinary autism science, genetics, sex differences, longitudinal data',
      target_roles: ['Research Software Engineer', 'Data Systems Specialist'],
      careers_url: 'https://www.jobs.cam.ac.uk/',
    },
    {
      name: 'RIKEN Center for Brain Science',
      country: 'Japan',
      thematic_focus: 'Neural circuits, computational neuroscience, neurodevelopmental disorders',
      target_roles: ['Computational Science Platform Engineer', 'Data Engineer'],
      careers_url: 'https://www.riken.jp/en/careers/',
    },
  ];

  return { targetCompanies, researchInstitutions };
}

export function renderCompanySourcePlanMarkdown(plan: ReturnType<typeof generateCompanySourcePlan>): string {
  const lines: string[] = [];

  lines.push('# Stage 3: Target Company & Sourcing Strategy Plan (Dry-Run)');
  lines.push('');
  lines.push('> **Status**: DRY-RUN PROPOSAL — Requires owner approval before enabling automated polling');
  lines.push('> **Home Employment Base**: Singapore | **Primary Target**: Remote-First Engineering & Architecture');
  lines.push('> **Coverage**: Named Tech Watchlist, Remote Developer Platforms, Europe & APAC Research Institutes');
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## 1. Named Target-Company Watchlist & Polling Adapters');
  lines.push('');
  lines.push('| Company | Category | ATS Engine | Singapore Support | Remote Policy | Polling Cadence |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of plan.targetCompanies) {
    lines.push(`| **${c.name}** | \`${c.category}\` | \`${c.ats_type}\` | **${c.singapore_hiring_support}** | ${c.remote_policy_summary} | ${c.polling_frequency} |`);
  }
  lines.push('');

  lines.push('## 2. Research Institutions & Academic Labs (Europe & APAC Focus)');
  lines.push('');
  lines.push('*Excludes US universities as instructed; focuses on Sweden, Netherlands, UK, Singapore, Australia, and Japan.*');
  lines.push('');
  lines.push('| Institution | Country | Thematic Research Overlap | Targeted Engineering Roles |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of plan.researchInstitutions) {
    lines.push(`| **${r.name}** | ${r.country} | ${r.thematic_focus} | ${r.target_roles.join(', ')} |`);
  }
  lines.push('');

  lines.push('## 3. Weekly Polling Strategy & Compliance Controls');
  lines.push('');
  lines.push('- **Polling Volume**: Estimated ~15-20 API/web requests per week.');
  lines.push('- **Access Protocols**: Uses official public ATS endpoints (Ashby posting-api, Greenhouse boards-api) with zero authenticated scraping.');
  lines.push('- **Deduplication Invariant**: Every observed posting is deduplicated against `canonical_jobs` by `source_external_id` and normalized URL before ingest.');
  lines.push('- **Freshness Invariant**: Discovered postings with authoritative age >60 days are filtered immediately by `GATE_STALE_POSTING`.');
  lines.push('');

  lines.push('## 4. Employer Exclusions & Guardrails');
  lines.push('');
  lines.push('- ❌ **Excluded Traditional Insurers**: AIA, Great Eastern, Mercer, Prudential (traditional Singapore insurance operating models).');
  lines.push('- ❌ **Excluded Audit & Body-Shopping Firms**: PwC, Deloitte, EY, KPMG, Tata Consultancy Services (TCS), NTT Data, Wipro, Infosys.');
  lines.push('- ❌ **Excluded Staffing Models**: Third-party recruitment agency employment (recruiter as legal employer rather than introducer).');
  lines.push('- ✅ **Allowed Exceptions**: Configurable exceptions (e.g. EPAM) explicitly supported without weakening general exclusion.');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  console.log('=== Stage 3: Company & Sourcing Strategy Plan ===\n');
  const plan = generateCompanySourcePlan();
  const md = renderCompanySourcePlanMarkdown(plan);

  const outputPath = path.join('private/profile', 'stage3_company_source_plan.md');
  fs.writeFileSync(outputPath, md + '\n');

  console.log(`✓ Dry-run company & sourcing plan generated at ${outputPath}`);
  console.log(`  - Target Companies: ${plan.targetCompanies.length}`);
  console.log(`  - Research Institutions: ${plan.researchInstitutions.length}`);
  console.log(`  - Weekly Polling Cadence: Scheduled weekly per target`);
  console.log(`  - Compliance: Public ATS APIs only, no scraping`);
}

if (process.argv[1]?.endsWith('stage3_mobility_watchlist.ts') || process.argv[1]?.endsWith('stage3_mobility_watchlist.js')) {
  main().catch(console.error);
}
