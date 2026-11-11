import { describe, expect, it } from 'vitest';

import {
  PREFERENCE_ACTIVATION_ENV_FLAG,
  PreferenceActivationRefusal,
  buildProposedDomainValues,
  computePreferenceDiffHash,
  defaultPreferenceSelectors,
  describePreferenceFollowUps,
  diffPreferenceValues,
  findUnknownKeys,
  parsePreferenceActivationArgs,
  parsePreferenceSelector,
  runPreferenceActivation,
  validatePreferenceDomainValue,
} from '../../policy/preferenceActivation.js';
import { MobilityPreferencesSchema, Stage3WorkPreferencesSchema } from '../../policy/stage3Contracts.js';

// Synthetic values only. None of these are real preferences.
const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const ONSITE_FIELD_KNOWN = 'onsite_exception_employers' in MobilityPreferencesSchema.shape;

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PreferenceActivationRefusal) return error.code;
    throw error;
  }
  throw new Error('Expected a refusal.');
}

async function asyncRefusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PreferenceActivationRefusal) return error.code;
    throw error;
  }
  throw new Error('Expected a refusal.');
}

const noConnect = async () => {
  throw new Error('The guard must refuse before connecting to a database.');
};

const fullApplyArgs = [
  '--only=watchlist.watchlist_companies',
  '--apply',
  `--confirm-workspace=${WORKSPACE}`,
  `--expect-diff-hash=${HASH}`,
  '--operator=fixture-operator',
  '--reason=fixture change',
];

describe('preference activation arguments and guards', () => {
  it('refuses unknown flags and value flags without a value', () => {
    expect(refusalCode(() => parsePreferenceActivationArgs(['--aply']))).toBe('UNKNOWN_FLAG');
    expect(refusalCode(() => parsePreferenceActivationArgs(['stage3']))).toBe('UNKNOWN_FLAG');
    expect(refusalCode(() => parsePreferenceActivationArgs(['--operator']))).toBe('FLAG_VALUE_REQUIRED');
    expect(refusalCode(() => parsePreferenceActivationArgs(['--apply=yes']))).toBe('UNKNOWN_FLAG');
    expect(refusalCode(() => parsePreferenceActivationArgs(['--rollback-to=not-a-uuid']))).toBe('ROLLBACK_REVISION_NOT_FOUND');
    expect(refusalCode(() => parsePreferenceActivationArgs([`--rollback-to=${WORKSPACE}`, '--only=mobility']))).toBe('CONFLICTING_FLAGS');
  });

  it('splits comma-separated and repeated --only selectors', () => {
    const args = parsePreferenceActivationArgs(['--only=mobility.travel_max_pct,watchlist', '--only=lane_intent']);
    expect(args.only).toEqual(['mobility.travel_max_pct', 'watchlist', 'lane_intent']);
    expect(args.apply).toBe(false);
  });

  const env = { [PREFERENCE_ACTIVATION_ENV_FLAG]: 'true' };
  const cases: Array<{ name: string; argv: string[]; env: Record<string, string>; code: string }> = [
    { name: 'the environment flag', argv: fullApplyArgs, env: {}, code: 'APPLY_ENV_FLAG_MISSING' },
    { name: 'an environment flag other than "true"', argv: fullApplyArgs, env: { [PREFERENCE_ACTIVATION_ENV_FLAG]: '1' }, code: 'APPLY_ENV_FLAG_MISSING' },
    { name: '--confirm-workspace', argv: fullApplyArgs.filter((arg) => !arg.startsWith('--confirm-workspace')), env, code: 'CONFIRM_WORKSPACE_MISSING' },
    { name: 'a UUID --confirm-workspace', argv: [...fullApplyArgs.filter((arg) => !arg.startsWith('--confirm-workspace')), '--confirm-workspace=default'], env, code: 'CONFIRM_WORKSPACE_MISSING' },
    { name: '--expect-diff-hash', argv: fullApplyArgs.filter((arg) => !arg.startsWith('--expect-diff-hash')), env, code: 'EXPECT_DIFF_HASH_MISSING' },
    { name: 'a 64-hex --expect-diff-hash', argv: [...fullApplyArgs.filter((arg) => !arg.startsWith('--expect-diff-hash')), '--expect-diff-hash=abc'], env, code: 'EXPECT_DIFF_HASH_MISSING' },
    { name: '--operator', argv: fullApplyArgs.filter((arg) => !arg.startsWith('--operator')), env, code: 'OPERATOR_MISSING' },
    { name: '--reason', argv: fullApplyArgs.filter((arg) => !arg.startsWith('--reason')), env, code: 'REASON_MISSING' },
  ];
  for (const testCase of cases) {
    it(`--apply without ${testCase.name} refuses before connecting`, async () => {
      const code = await asyncRefusalCode(runPreferenceActivation({
        argv: testCase.argv,
        env: testCase.env,
        connect: noConnect,
        readFile: async () => '{}',
      }));
      expect(code).toBe(testCase.code);
    });
  }

  it('a dry run with an unreadable or invalid file refuses without quoting file content', async () => {
    const unreadable = runPreferenceActivation({ argv: ['--file=missing.json'], env: {}, connect: noConnect, readFile: async () => { throw new Error('ENOENT'); } });
    expect(await asyncRefusalCode(unreadable)).toBe('PREFERENCES_FILE_UNREADABLE');
    try {
      await runPreferenceActivation({ argv: [], env: {}, connect: noConnect, readFile: async () => '{"secret-looking-value": ' });
      throw new Error('Expected a refusal.');
    } catch (error) {
      expect(error).toBeInstanceOf(PreferenceActivationRefusal);
      expect((error as Error).message).not.toContain('secret-looking-value');
    }
  });
});

describe('preference selectors and schema checks', () => {
  it('accepts known sections and fields and refuses unknown ones', () => {
    expect(parsePreferenceSelector('mobility.travel_max_pct')).toEqual({ domain: 'stage3', path: ['mobility', 'travel_max_pct'], label: 'stage3.mobility.travel_max_pct' });
    expect(parsePreferenceSelector('stage3.watchlist')).toEqual({ domain: 'stage3', path: ['watchlist'], label: 'stage3.watchlist' });
    expect(parsePreferenceSelector('lane_intent.lane_weights').domain).toBe('lane_intent');
    expect(refusalCode(() => parsePreferenceSelector('work_mode'))).toBe('UNKNOWN_SELECTOR');
    expect(refusalCode(() => parsePreferenceSelector('mobility.not_a_field'))).toBe('UNKNOWN_FIELD');
    expect(refusalCode(() => parsePreferenceSelector('lane_intent.schema_version'))).toBe('UNKNOWN_FIELD');
    expect(refusalCode(() => parsePreferenceSelector('mobility.a.b'))).toBe('UNKNOWN_SELECTOR');
  });

  it('accepts mobility.onsite_exception_employers only when the deployed stage3 schema defines it', () => {
    if (ONSITE_FIELD_KNOWN) {
      expect(parsePreferenceSelector('mobility.onsite_exception_employers').path).toEqual(['mobility', 'onsite_exception_employers']);
    } else {
      expect(refusalCode(() => parsePreferenceSelector('mobility.onsite_exception_employers'))).toBe('UNKNOWN_FIELD');
      expect(refusalCode(() => validatePreferenceDomainValue('stage3', {
        schema_version: '3.0.0',
        mobility: { onsite_exception_employers: ['Example Labs'] },
      }))).toBe('UNKNOWN_FIELD');
    }
  });

  it('finds keys that Zod would otherwise strip, including nested and array items', () => {
    expect(findUnknownKeys(Stage3WorkPreferencesSchema, {
      schema_version: '3.0.0',
      mobility: { travel_max_pct: 10, mystery: true },
      employment_structure: { structure_ranking: ['SG_EMPLOYEE'], extra_floor: 1 },
      culture_priorities: [{ priority_order: 1, name: 'x', configured_weight: 5, note: 'y' }],
      top_level_extra: {},
    })).toEqual([
      'culture_priorities[].note',
      'employment_structure.extra_floor',
      'mobility.mystery',
      'top_level_extra',
    ]);
  });

  it('reports schema failures by path and issue code without the rejected values', () => {
    try {
      validatePreferenceDomainValue('stage3', {
        schema_version: '3.0.0',
        mobility: { preferred_work_mode: 'SECRET_MODE_VALUE' },
        application_priority_weights: { base_rank_pct: 50, freshness_pct: 20, remote_freedom_pct: 7 },
      });
      throw new Error('Expected a refusal.');
    } catch (error) {
      expect(error).toBeInstanceOf(PreferenceActivationRefusal);
      const refusal = error as PreferenceActivationRefusal;
      expect(refusal.code).toBe('SCHEMA_VALIDATION_FAILED');
      expect(refusal.message).toContain('stage3.mobility.preferred_work_mode');
      expect(refusal.message).toContain('stage3.application_priority_weights');
      expect(refusal.message).not.toContain('SECRET_MODE_VALUE');
      expect(refusal.message).not.toContain('77');
    }
  });

  it('builds proposals from the active value and replaces only the selected field', () => {
    const active = { schema_version: '3.0.0', mobility: { travel_max_pct: 10 }, watchlist: { watchlist_companies: ['Alpha Labs'] } };
    const file = { mobility: { travel_max_pct: 30 }, watchlist: { watchlist_companies: ['Alpha Labs', 'Beta Works'] } };
    const proposals = buildProposedDomainValues(file, [parsePreferenceSelector('watchlist.watchlist_companies')], { stage3: active });
    expect(proposals.stage3).toEqual({ schema_version: '3.0.0', mobility: { travel_max_pct: 10 }, watchlist: { watchlist_companies: ['Alpha Labs', 'Beta Works'] } });
    expect(active.watchlist.watchlist_companies).toEqual(['Alpha Labs']);
    expect(refusalCode(() => buildProposedDomainValues({}, [parsePreferenceSelector('watchlist.watchlist_companies')], { stage3: active })))
      .toBe('SELECTED_FIELD_MISSING_IN_FILE');
  });

  it('defaults to every stage3 section present in the file plus lane_intent', () => {
    const selectors = defaultPreferenceSelectors({ mobility: {}, watchlist: {}, lane_intent: {}, work_mode: {} });
    expect(selectors.map((selector) => selector.label)).toEqual(['lane_intent', 'stage3.mobility', 'stage3.watchlist']);
  });
});

describe('preference diff output', () => {
  const before = { schema_version: '3.0.0', mobility: { travel_max_pct: 10, living_travel_excluded_regions: ['North', 'South'] }, watchlist: {} };
  const after = { schema_version: '3.0.0', mobility: { travel_max_pct: 20, living_travel_excluded_regions: ['South', 'East', 'West'], preferred_work_mode: 'HYBRID' }, watchlist: {} };

  it('lists changed field names and list counts without values by default', () => {
    const entries = diffPreferenceValues('stage3', before, after);
    expect(entries).toEqual([
      { path: 'stage3.mobility.living_travel_excluded_regions', change: 'CHANGED', valueKind: 'list', itemsAdded: 2, itemsRemoved: 1 },
      { path: 'stage3.mobility.preferred_work_mode', change: 'ADDED', valueKind: 'value' },
      { path: 'stage3.mobility.travel_max_pct', change: 'CHANGED', valueKind: 'value' },
    ]);
    const text = JSON.stringify(entries);
    for (const value of ['North', 'East', 'West', 'HYBRID']) expect(text).not.toContain(value);
  });

  it('shows list items and values only with showValues', () => {
    const entries = diffPreferenceValues('stage3', before, after, { showValues: true });
    expect(entries[0]).toMatchObject({ addedItems: ['East', 'West'], removedItems: ['North'] });
    expect(entries[2]).toMatchObject({ before: 10, after: 20 });
  });

  it('reports a pure reorder and a first revision', () => {
    expect(diffPreferenceValues('stage3', { a: ['x', 'y'] }, { a: ['y', 'x'] })).toEqual([
      { path: 'stage3.a', change: 'CHANGED', valueKind: 'list', itemsAdded: 0, itemsRemoved: 0, reordered: true },
    ]);
    expect(diffPreferenceValues('stage3', null, { schema_version: '3.0.0', mobility: {} })).toEqual([
      { path: 'stage3.mobility', change: 'ADDED', valueKind: 'object' },
      { path: 'stage3.schema_version', change: 'ADDED', valueKind: 'value' },
    ]);
  });

  it('names the re-gate and re-route work each change needs', () => {
    const followUps = describePreferenceFollowUps([
      { path: 'stage3.mobility.travel_max_pct', change: 'CHANGED', valueKind: 'value' },
      { path: 'lane_intent.lane_weights.CORE_AI_DATA', change: 'CHANGED', valueKind: 'value' },
      { path: 'stage3.research_geographies.preferred_regions', change: 'CHANGED', valueKind: 'list' },
    ]);
    expect(followUps.map((followUp) => followUp.stage)).toEqual(['HARD_GATE', 'LANE_ROUTING', 'RECOMMENDATION', 'APPLICATION_RANKING']);
    expect(followUps[0]?.triggeredBy).toEqual(['stage3.mobility.travel_max_pct']);
    expect(describePreferenceFollowUps([{ path: 'stage3.research_geographies.preferred_regions', change: 'CHANGED', valueKind: 'list' }])).toEqual([]);
  });

  it('binds the diff hash to the starting revision and the target content', () => {
    const base = { action: 'APPLY' as const, workspaceId: WORKSPACE, userId: WORKSPACE };
    const domain = { domain: 'stage3' as const, fromRevisionId: 'r1', fromPreferenceHash: 'h1', toPreferenceHash: 'h2' };
    const hash = computePreferenceDiffHash({ ...base, domains: [domain] });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePreferenceDiffHash({ ...base, domains: [domain] })).toBe(hash);
    expect(computePreferenceDiffHash({ ...base, domains: [{ ...domain, fromRevisionId: 'r0' }] })).not.toBe(hash);
    expect(computePreferenceDiffHash({ ...base, domains: [{ ...domain, toPreferenceHash: 'h3' }] })).not.toBe(hash);
    expect(computePreferenceDiffHash({ ...base, action: 'ROLLBACK', domains: [domain] })).not.toBe(hash);
  });
});
