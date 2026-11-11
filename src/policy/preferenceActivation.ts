/**
 * Guarded, operator-approved activation of workspace preference revisions
 * (`stage3`, `lane_intent`) in any database, including production.
 *
 * It is separate from `scripts/seed_workspace_preferences.ts`, which stays a
 * staging-only seeder. This path:
 *  - is a dry run by default and runs it inside a READ ONLY transaction;
 *  - prints field names and list counts, never preference values unless
 *    `--show-values` is passed;
 *  - refuses any field the current schema does not know (Zod would otherwise
 *    strip it silently);
 *  - applies only with `--apply`, `--confirm-workspace=<uuid>`,
 *    `--expect-diff-hash=<hash from the dry run>`, `--operator`, `--reason`
 *    and `PREFERENCES_PROD_ACTIVATION_ALLOWED=true`;
 *  - creates (or reuses an identical) revision, activates it and writes an
 *    audit row in one transaction; it never updates or deletes a revision;
 *  - re-activates an earlier revision with `--rollback-to=<revision id>` under
 *    the same guards.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { z } from 'zod';

import { sha256Hex, stableStringify } from '../config/structuredLoader.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { LaneIntentPreferencesSchema } from './laneIntentContracts.js';
import { STAGE3_SCHEMA_VERSION, Stage3WorkPreferencesSchema } from './stage3Contracts.js';
import { saveWorkspacePreferenceRevision } from './workspacePreferenceRegistry.js';

export const PREFERENCE_ACTIVATION_ENV_FLAG = 'PREFERENCES_PROD_ACTIVATION_ALLOWED';
export const PREFERENCE_ACTIVATION_TOOL = 'scripts/activate_workspace_preferences.ts';
export const PREFERENCE_ACTIVATION_DIFF_SCHEMA = 'workspace_preference_activation_diff_v1';
export const PREFERENCE_CHANGE_AUDIT_TABLE = 'workspace_user_preference_change_audit';

export type PreferenceDomain = 'stage3' | 'lane_intent';
const DOMAINS: readonly PreferenceDomain[] = ['lane_intent', 'stage3'];

/**
 * Top-level sections of `work_preferences.json` that form the stage3 package.
 * Same list as `scripts/seed_workspace_preferences.ts`; other top-level keys of
 * the file belong to other preference sources and are ignored here.
 */
export const STAGE3_FILE_SECTIONS = [
  'mobility',
  'employment_structure',
  'compensation',
  'freshness',
  'application_priority_weights',
  'company_stage_preferences',
  'market_opportunities',
  'research_geographies',
  'watchlist',
  'culture_priorities',
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type PreferenceActivationRefusalCode =
  | 'UNKNOWN_FLAG'
  | 'FLAG_VALUE_REQUIRED'
  | 'CONFLICTING_FLAGS'
  | 'APPLY_ENV_FLAG_MISSING'
  | 'CONFIRM_WORKSPACE_MISSING'
  | 'CONFIRM_WORKSPACE_MISMATCH'
  | 'EXPECT_DIFF_HASH_MISSING'
  | 'DIFF_HASH_MISMATCH'
  | 'OPERATOR_MISSING'
  | 'REASON_MISSING'
  | 'NOT_WORKSPACE_OWNER'
  | 'AUDIT_TABLE_MISSING'
  | 'PREFERENCES_FILE_UNREADABLE'
  | 'PREFERENCES_FILE_INVALID_JSON'
  | 'UNKNOWN_SELECTOR'
  | 'UNKNOWN_FIELD'
  | 'SELECTED_FIELD_MISSING_IN_FILE'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'NO_CHANGE'
  | 'ROLLBACK_REVISION_NOT_FOUND'
  | 'ROLLBACK_REVISION_ALREADY_ACTIVE';

/** A refusal is an expected, operator-facing stop. Its message never contains preference values. */
export class PreferenceActivationRefusal extends Error {
  constructor(readonly code: PreferenceActivationRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PreferenceActivationRefusal';
  }
}

// ============================================================================
// Arguments
// ============================================================================

export interface PreferenceActivationArgs {
  readonly file: string | null;
  readonly only: readonly string[];
  readonly showValues: boolean;
  readonly apply: boolean;
  readonly confirmWorkspace: string | null;
  readonly expectDiffHash: string | null;
  readonly rollbackTo: string | null;
  readonly operator: string | null;
  readonly reason: string | null;
}

const VALUE_FLAGS = ['--file', '--only', '--confirm-workspace', '--expect-diff-hash', '--rollback-to', '--operator', '--reason'] as const;
const BOOLEAN_FLAGS = ['--apply', '--show-values'] as const;

export function parsePreferenceActivationArgs(argv: readonly string[]): PreferenceActivationArgs {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (eq !== -1) throw new PreferenceActivationRefusal('UNKNOWN_FLAG', `${name} takes no value.`);
      booleans.add(name);
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = eq === -1 ? '' : arg.slice(eq + 1).trim();
      if (!value) throw new PreferenceActivationRefusal('FLAG_VALUE_REQUIRED', `${name} requires a value written as ${name}=<value>.`);
      values.set(name, [...(values.get(name) ?? []), value]);
      continue;
    }
    throw new PreferenceActivationRefusal('UNKNOWN_FLAG', `Unknown argument ${name.startsWith('--') ? name : '(positional)'}.`);
  }
  const single = (name: string): string | null => {
    const list = values.get(name);
    if (!list) return null;
    if (list.length > 1) throw new PreferenceActivationRefusal('CONFLICTING_FLAGS', `${name} may be given only once.`);
    return list[0] ?? null;
  };
  const only = (values.get('--only') ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const args: PreferenceActivationArgs = {
    file: single('--file'),
    only,
    showValues: booleans.has('--show-values'),
    apply: booleans.has('--apply'),
    confirmWorkspace: single('--confirm-workspace'),
    expectDiffHash: single('--expect-diff-hash'),
    rollbackTo: single('--rollback-to'),
    operator: single('--operator'),
    reason: single('--reason'),
  };
  if (args.rollbackTo && (args.file || args.only.length > 0)) {
    throw new PreferenceActivationRefusal('CONFLICTING_FLAGS', '--rollback-to re-activates a stored revision; it cannot be combined with --file or --only.');
  }
  if (args.rollbackTo && !UUID_PATTERN.test(args.rollbackTo)) {
    throw new PreferenceActivationRefusal('ROLLBACK_REVISION_NOT_FOUND', '--rollback-to must be a revision UUID.');
  }
  return args;
}

/** Guards checked before any database connection when --apply is set. */
export function assertApplyGuards(args: PreferenceActivationArgs, env: Readonly<Record<string, string | undefined>>): void {
  if (!args.apply) return;
  if (env[PREFERENCE_ACTIVATION_ENV_FLAG] !== 'true') {
    throw new PreferenceActivationRefusal('APPLY_ENV_FLAG_MISSING', `--apply requires the environment flag ${PREFERENCE_ACTIVATION_ENV_FLAG}=true.`);
  }
  if (!args.confirmWorkspace || !UUID_PATTERN.test(args.confirmWorkspace)) {
    throw new PreferenceActivationRefusal('CONFIRM_WORKSPACE_MISSING', '--apply requires --confirm-workspace=<workspace uuid printed by the dry run>.');
  }
  if (!args.expectDiffHash || !HASH_PATTERN.test(args.expectDiffHash)) {
    throw new PreferenceActivationRefusal('EXPECT_DIFF_HASH_MISSING', '--apply requires --expect-diff-hash=<64-character diff hash printed by the dry run>.');
  }
  if (!args.operator || args.operator.length > 120 || /[\r\n]/.test(args.operator)) {
    throw new PreferenceActivationRefusal('OPERATOR_MISSING', '--apply requires --operator=<who is running this> (one line, at most 120 characters).');
  }
  if (!args.reason || args.reason.length > 1000) {
    throw new PreferenceActivationRefusal('REASON_MISSING', '--apply requires --reason=<why> (at most 1000 characters; describe the change, do not paste preference values).');
  }
}

// ============================================================================
// Schema introspection
// ============================================================================

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 20; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else {
      return current;
    }
  }
  return current;
}

function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  const inner = unwrapSchema(schema);
  return inner instanceof z.ZodObject ? (inner.shape as Record<string, z.ZodTypeAny>) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Paths of object keys the schema does not declare. Zod objects strip such
 * keys during parse, so without this check a field the deployed code does not
 * know would be dropped silently instead of refused.
 */
export function findUnknownKeys(schema: z.ZodTypeAny, value: unknown, prefix = ''): string[] {
  const inner = unwrapSchema(schema);
  const out: string[] = [];
  if (inner instanceof z.ZodObject && isPlainObject(value)) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    for (const key of Object.keys(value).sort()) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      const child = shape[key];
      if (!child) {
        out.push(childPath);
        continue;
      }
      out.push(...findUnknownKeys(child, value[key], childPath));
    }
  } else if (inner instanceof z.ZodArray && Array.isArray(value)) {
    const seen = new Set<string>();
    for (const item of value) {
      for (const found of findUnknownKeys(inner.element as z.ZodTypeAny, item, `${prefix}[]`)) {
        if (!seen.has(found)) {
          seen.add(found);
          out.push(found);
        }
      }
    }
  } else if (inner instanceof z.ZodRecord && isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) {
      out.push(...findUnknownKeys(inner.valueSchema as z.ZodTypeAny, value[key], prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

function domainSchema(domain: PreferenceDomain): z.ZodTypeAny {
  return domain === 'stage3' ? Stage3WorkPreferencesSchema : LaneIntentPreferencesSchema;
}

/**
 * Validate a full domain value against the deployed schema. Unknown fields and
 * schema failures are refused; the messages carry paths and Zod issue codes
 * only, because Zod messages can quote the rejected value.
 */
export function validatePreferenceDomainValue(domain: PreferenceDomain, value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new PreferenceActivationRefusal('SCHEMA_VALIDATION_FAILED', `${domain} must be a JSON object.`);
  }
  const unknown = findUnknownKeys(domainSchema(domain), value);
  if (unknown.length > 0) {
    throw new PreferenceActivationRefusal(
      'UNKNOWN_FIELD',
      `${domain} contains fields the current schema does not accept: ${unknown.map((field) => `${domain}.${field}`).join(', ')}. ` +
        'Deploy the code that defines them first (for mobility.onsite_exception_employers: PR #173), or limit the change with --only.',
    );
  }
  const parsed = domainSchema(domain).safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${domain}.${issue.path.map(String).join('.') || '(root)'} (${issue.code})`)
      .join(', ');
    throw new PreferenceActivationRefusal('SCHEMA_VALIDATION_FAILED', `${domain} does not match its schema: ${issues}.`);
  }
  return parsed.data as Record<string, unknown>;
}

// ============================================================================
// Selectors and proposals
// ============================================================================

export interface PreferenceSelector {
  readonly domain: PreferenceDomain;
  /** stage3: [section] or [section, field]; lane_intent: [] (whole package) or [key]. */
  readonly path: readonly string[];
  readonly label: string;
}

export function parsePreferenceSelector(raw: string): PreferenceSelector {
  const parts = raw.trim().split('.').filter((part) => part.length > 0);
  if (parts[0] === 'stage3') parts.shift();
  if (parts.length === 0) throw new PreferenceActivationRefusal('UNKNOWN_SELECTOR', 'Empty --only selector.');

  if (parts[0] === 'lane_intent') {
    const rest = parts.slice(1);
    if (rest.length > 1) throw new PreferenceActivationRefusal('UNKNOWN_SELECTOR', `Selector ${raw} is too deep; use lane_intent or lane_intent.<key>.`);
    const shape = objectShape(LaneIntentPreferencesSchema);
    if (rest[0] && (rest[0] === 'schema_version' || !shape?.[rest[0]])) {
      throw new PreferenceActivationRefusal('UNKNOWN_FIELD', `lane_intent.${rest[0]} is not a field of the current lane_intent schema.`);
    }
    return { domain: 'lane_intent', path: rest, label: ['lane_intent', ...rest].join('.') };
  }

  const [section, field, ...extra] = parts;
  if (extra.length > 0) throw new PreferenceActivationRefusal('UNKNOWN_SELECTOR', `Selector ${raw} is too deep; use <section> or <section>.<field>.`);
  if (!section || !(STAGE3_FILE_SECTIONS as readonly string[]).includes(section)) {
    throw new PreferenceActivationRefusal(
      'UNKNOWN_SELECTOR',
      `Unknown selector ${raw}. Use lane_intent[.<key>] or one of the stage3 sections ${STAGE3_FILE_SECTIONS.join(', ')} (optionally .<field>).`,
    );
  }
  if (field) {
    const sectionShape = objectShape(Stage3WorkPreferencesSchema.shape[section as keyof typeof Stage3WorkPreferencesSchema.shape]);
    if (!sectionShape) throw new PreferenceActivationRefusal('UNKNOWN_SELECTOR', `stage3.${section} is not an object; select the whole section.`);
    if (!sectionShape[field]) {
      throw new PreferenceActivationRefusal(
        'UNKNOWN_FIELD',
        `stage3.${section}.${field} is not accepted by the current stage3 schema ${STAGE3_SCHEMA_VERSION}. ` +
          (section === 'mobility' && field === 'onsite_exception_employers'
            ? 'It is added by PR #173; merge and deploy that first.'
            : 'Deploy the code that defines it first.'),
      );
    }
  }
  return { domain: 'stage3', path: field ? [section, field] : [section], label: ['stage3', section, ...(field ? [field] : [])].join('.') };
}

/** Without --only: every stage3 section present in the file, plus lane_intent when present. */
export function defaultPreferenceSelectors(file: Record<string, unknown>): PreferenceSelector[] {
  const selectors: PreferenceSelector[] = [];
  if (file.lane_intent !== undefined) selectors.push({ domain: 'lane_intent', path: [], label: 'lane_intent' });
  for (const section of STAGE3_FILE_SECTIONS) {
    if (file[section] !== undefined) selectors.push({ domain: 'stage3', path: [section], label: `stage3.${section}` });
  }
  return selectors;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function fileValueFor(file: Record<string, unknown>, selector: PreferenceSelector): unknown {
  const keys = selector.domain === 'lane_intent' ? ['lane_intent', ...selector.path] : [...selector.path];
  let current: unknown = file;
  for (const key of keys) {
    if (!isPlainObject(current) || current[key] === undefined) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Build the proposed value of each selected domain: the active value with only
 * the selected sections or fields replaced from the preferences file.
 */
export function buildProposedDomainValues(
  file: Record<string, unknown>,
  selectors: readonly PreferenceSelector[],
  activeValues: Readonly<Partial<Record<PreferenceDomain, Record<string, unknown>>>>,
): Partial<Record<PreferenceDomain, Record<string, unknown>>> {
  const proposals: Partial<Record<PreferenceDomain, Record<string, unknown>>> = {};
  for (const selector of selectors) {
    const fromFile = fileValueFor(file, selector);
    if (fromFile === undefined) {
      throw new PreferenceActivationRefusal(
        'SELECTED_FIELD_MISSING_IN_FILE',
        `${selector.label} is not present in the preferences file. This command does not remove fields.`,
      );
    }
    if (selector.domain === 'lane_intent' && selector.path.length === 0) {
      if (!isPlainObject(fromFile)) throw new PreferenceActivationRefusal('SCHEMA_VALIDATION_FAILED', 'lane_intent must be a JSON object.');
      proposals.lane_intent = clone(fromFile);
      continue;
    }
    const base = proposals[selector.domain]
      ?? clone(activeValues[selector.domain])
      ?? (selector.domain === 'stage3' ? { schema_version: STAGE3_SCHEMA_VERSION } : {});
    let target: Record<string, unknown> = base;
    for (const key of selector.path.slice(0, -1)) {
      const next = target[key];
      if (next === undefined) target[key] = {};
      else if (!isPlainObject(next)) throw new PreferenceActivationRefusal('SCHEMA_VALIDATION_FAILED', `${selector.domain}.${key} is not an object in the active revision.`);
      target = target[key] as Record<string, unknown>;
    }
    const leaf = selector.path[selector.path.length - 1];
    if (leaf === undefined) throw new PreferenceActivationRefusal('UNKNOWN_SELECTOR', `Selector ${selector.label} selects nothing.`);
    target[leaf] = clone(fromFile);
    proposals[selector.domain] = base;
  }
  return proposals;
}

// ============================================================================
// Diff, hash and follow-up
// ============================================================================

export interface PreferenceDiffEntry {
  readonly path: string;
  readonly change: 'ADDED' | 'REMOVED' | 'CHANGED';
  readonly valueKind: 'list' | 'value' | 'object';
  readonly itemsAdded?: number;
  readonly itemsRemoved?: number;
  readonly reordered?: boolean;
  /** Only with --show-values. */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly addedItems?: readonly unknown[];
  readonly removedItems?: readonly unknown[];
}

function multisetDifference(left: readonly unknown[], right: readonly unknown[]): unknown[] {
  const remaining = new Map<string, number>();
  for (const item of right) {
    const key = stableStringify(item);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const out: unknown[] = [];
  for (const item of left) {
    const key = stableStringify(item);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else out.push(item);
  }
  return out;
}

function diffInto(before: unknown, after: unknown, at: string, showValues: boolean, out: PreferenceDiffEntry[]): void {
  if (stableStringify(before) === stableStringify(after)) return;
  const change: PreferenceDiffEntry['change'] = before === undefined ? 'ADDED' : after === undefined ? 'REMOVED' : 'CHANGED';

  if ((isPlainObject(before) || before === undefined) && (isPlainObject(after) || after === undefined)) {
    const left = (before ?? {}) as Record<string, unknown>;
    const right = (after ?? {}) as Record<string, unknown>;
    const startLength = out.length;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      diffInto(left[key], right[key], `${at}.${key}`, showValues, out);
    }
    if (out.length === startLength) out.push({ path: at, change, valueKind: 'object' });
    return;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : [];
    const right = Array.isArray(after) ? after : [];
    const added = multisetDifference(right, left);
    const removed = multisetDifference(left, right);
    out.push({
      path: at,
      change,
      valueKind: 'list',
      itemsAdded: added.length,
      itemsRemoved: removed.length,
      ...(added.length === 0 && removed.length === 0 ? { reordered: true } : {}),
      ...(showValues ? { addedItems: added, removedItems: removed } : {}),
    });
    return;
  }

  out.push({ path: at, change, valueKind: 'value', ...(showValues ? { before, after } : {}) });
}

export function diffPreferenceValues(
  domain: PreferenceDomain,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  options: { showValues?: boolean } = {},
): PreferenceDiffEntry[] {
  const out: PreferenceDiffEntry[] = [];
  diffInto(before ?? undefined, after, domain, options.showValues === true, out);
  return out;
}

export function preferenceValueHash(value: Record<string, unknown>): string {
  // Same hash as saveWorkspacePreferenceRevision stores in preference_hash.
  return sha256Hex(stableStringify(value));
}

export interface DiffHashDomain {
  readonly domain: PreferenceDomain;
  readonly fromRevisionId: string | null;
  readonly fromPreferenceHash: string | null;
  readonly toPreferenceHash: string;
  readonly toRevisionId?: string | null;
}

/**
 * The diff hash binds the action, the workspace and user, the exact active
 * revision each domain starts from and the exact content it moves to. A
 * different file, a different selection, or another activation in between
 * all produce a different hash, so --apply runs only what was reviewed.
 */
export function computePreferenceDiffHash(input: {
  action: 'APPLY' | 'ROLLBACK';
  workspaceId: string;
  userId: string;
  domains: readonly DiffHashDomain[];
}): string {
  return sha256Hex(stableStringify({
    schema: PREFERENCE_ACTIVATION_DIFF_SCHEMA,
    action: input.action,
    workspace_id: input.workspaceId,
    user_id: input.userId,
    domains: [...input.domains]
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .map((domain) => ({
        domain: domain.domain,
        from_revision_id: domain.fromRevisionId,
        from_preference_hash: domain.fromPreferenceHash,
        to_preference_hash: domain.toPreferenceHash,
        to_revision_id: domain.toRevisionId ?? null,
      })),
  }));
}

export type FollowUpStage = 'HARD_GATE' | 'RECOMMENDATION' | 'APPLICATION_RANKING' | 'LANE_ROUTING';

export interface PreferenceFollowUp {
  readonly stage: FollowUpStage;
  readonly triggeredBy: readonly string[];
  readonly required: string;
}

/** Which deterministic stages read each preference path on main. */
const FOLLOW_UP_RULES: ReadonlyArray<{ prefix: string; stages: readonly FollowUpStage[] }> = [
  { prefix: 'stage3.mobility', stages: ['HARD_GATE', 'APPLICATION_RANKING'] },
  { prefix: 'stage3.watchlist', stages: ['HARD_GATE'] },
  { prefix: 'stage3.compensation', stages: ['HARD_GATE', 'RECOMMENDATION'] },
  { prefix: 'stage3.freshness', stages: ['HARD_GATE', 'RECOMMENDATION', 'APPLICATION_RANKING'] },
  { prefix: 'stage3.culture_priorities', stages: ['APPLICATION_RANKING'] },
  { prefix: 'stage3.application_priority_weights', stages: ['APPLICATION_RANKING'] },
  { prefix: 'lane_intent', stages: ['LANE_ROUTING', 'RECOMMENDATION'] },
];

const FOLLOW_UP_TEXT: Record<FollowUpStage, string> = {
  HARD_GATE:
    'New gate runs read the new stage3 revision at once, but stored gate decisions are not re-gated automatically. ' +
    'Re-gate the affected jobs from a reviewed dry run (scripts/replay_hard_gate_policy_2026_11.ts, or scripts/regate_job_ids.ts --ids-file for an explicit list; both come with PR #173).',
  RECOMMENDATION:
    'Stored recommendation decisions keep their pinned preference revision. They change only when DECIDE_RECOMMENDATION runs again for a job (after a re-gate, re-route or re-match).',
  APPLICATION_RANKING:
    'Application rankings are a materialized read model. Re-materialize them with scripts/materialize_application_rankings.ts after any re-gate.',
  LANE_ROUTING:
    'Route currency follows the lanes\' routing_content_hash, not lane_intent, so stored routes are not marked stale. Queued ROUTE_LANE tasks see a new preference context; re-route already-routed jobs explicitly (scripts/reroute_all_gate_pass.ts).',
};

export function describePreferenceFollowUps(entries: readonly PreferenceDiffEntry[]): PreferenceFollowUp[] {
  const byStage = new Map<FollowUpStage, Set<string>>();
  for (const entry of entries) {
    for (const rule of FOLLOW_UP_RULES) {
      if (entry.path === rule.prefix || entry.path.startsWith(`${rule.prefix}.`)) {
        for (const stage of rule.stages) {
          const set = byStage.get(stage) ?? new Set<string>();
          set.add(entry.path);
          byStage.set(stage, set);
        }
      }
    }
  }
  const order: FollowUpStage[] = ['HARD_GATE', 'LANE_ROUTING', 'RECOMMENDATION', 'APPLICATION_RANKING'];
  return order
    .filter((stage) => byStage.has(stage))
    .map((stage) => ({ stage, triggeredBy: [...(byStage.get(stage) ?? [])].sort(), required: FOLLOW_UP_TEXT[stage] }));
}

// ============================================================================
// Database access
// ============================================================================

interface ActiveRevisionRow {
  preference_domain: PreferenceDomain;
  revision_id: string;
  revision_number: number;
  preference_hash: string;
  preference_value: unknown;
}

export interface ActivePreferenceRevision {
  readonly domain: PreferenceDomain;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly preferenceHash: string;
  readonly value: Record<string, unknown>;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!isPlainObject(parsed)) throw new Error(`${label} is not a JSON object.`);
  return parsed;
}

export async function readActivePreferenceRevisions(
  client: pg.PoolClient,
  context: WorkspaceContext,
  options: { forUpdate?: boolean } = {},
): Promise<Partial<Record<PreferenceDomain, ActivePreferenceRevision>>> {
  const { rows } = await client.query<ActiveRevisionRow>(
    `SELECT active.preference_domain,
            revision.id::text AS revision_id,
            revision.revision_number,
            revision.preference_hash,
            revision.preference_value
     FROM workspace_user_preference_active_versions AS active
     JOIN workspace_user_preference_revisions AS revision
       ON revision.workspace_id = active.workspace_id
      AND revision.user_id = active.user_id
      AND revision.preference_domain = active.preference_domain
      AND revision.id = active.revision_id
     WHERE active.workspace_id = $1
       AND active.user_id = $2
       AND active.preference_domain = ANY($3::text[])
     ORDER BY active.preference_domain
     ${options.forUpdate ? 'FOR UPDATE OF active' : ''}`,
    [context.workspaceId, context.userId, DOMAINS],
  );
  const out: Partial<Record<PreferenceDomain, ActivePreferenceRevision>> = {};
  for (const row of rows) {
    out[row.preference_domain] = {
      domain: row.preference_domain,
      revisionId: row.revision_id,
      revisionNumber: Number(row.revision_number),
      preferenceHash: row.preference_hash,
      value: jsonObject(row.preference_value, `Active ${row.preference_domain} revision`),
    };
  }
  return out;
}

async function auditTableExists(client: pg.PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [PREFERENCE_CHANGE_AUDIT_TABLE],
  );
  return rows[0]?.present === true;
}

async function latestActivationEventId(
  client: pg.PoolClient,
  context: WorkspaceContext,
  domain: PreferenceDomain,
  revisionId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM workspace_user_preference_activation_events
     WHERE workspace_id = $1 AND user_id = $2 AND preference_domain = $3 AND active_revision_id = $4
     ORDER BY activated_at DESC, id DESC
     LIMIT 1`,
    [context.workspaceId, context.userId, domain, revisionId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`Activation of ${domain} wrote no activation event; the transaction is rolled back.`);
  return id;
}

async function insertChangeAudit(client: pg.PoolClient, context: WorkspaceContext, input: {
  domain: PreferenceDomain;
  action: 'APPLY' | 'ROLLBACK';
  previousRevisionId: string | null;
  activeRevisionId: string;
  previousPreferenceHash: string | null;
  activePreferenceHash: string;
  activationEventId: string;
  diffHash: string;
  operator: string;
  reason: string;
  changedPaths: readonly string[];
}): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO workspace_user_preference_change_audit (
       workspace_id, user_id, preference_domain, action,
       previous_revision_id, active_revision_id, previous_preference_hash, active_preference_hash,
       activation_event_id, diff_hash, operator, reason, changed_paths, tool
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
     RETURNING id::text AS id`,
    [
      context.workspaceId,
      context.userId,
      input.domain,
      input.action,
      input.previousRevisionId,
      input.activeRevisionId,
      input.previousPreferenceHash,
      input.activePreferenceHash,
      input.activationEventId,
      input.diffHash,
      input.operator,
      input.reason,
      JSON.stringify(input.changedPaths),
      PREFERENCE_ACTIVATION_TOOL,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Preference change audit insert returned no id.');
  return id;
}

// ============================================================================
// Command
// ============================================================================

export interface PreferenceActivationDomainReport {
  readonly domain: PreferenceDomain;
  readonly activeRevisionId: string | null;
  readonly activeRevisionNumber: number | null;
  readonly activePreferenceHash: string | null;
  readonly proposedPreferenceHash: string;
  readonly changed: boolean;
  readonly targetRevisionId?: string;
  readonly newRevisionId?: string;
  readonly newRevisionNumber?: number;
  readonly revisionReused?: boolean;
  readonly auditId?: string;
}

export interface PreferenceActivationReport {
  readonly mode: 'DRY_RUN' | 'APPLIED';
  readonly action: 'APPLY' | 'ROLLBACK';
  readonly workspaceId: string;
  readonly selectors: readonly string[];
  readonly valuesShown: boolean;
  readonly domains: readonly PreferenceActivationDomainReport[];
  readonly changes: readonly PreferenceDiffEntry[];
  readonly diffHash: string;
  readonly followUps: readonly PreferenceFollowUp[];
  readonly workabilityPolicyHashNote?: string;
  readonly auditTableReady: boolean;
  readonly nextStep: string;
}

export interface PreferenceActivationConnection {
  readonly client: pg.PoolClient;
  close(): Promise<void>;
}

export interface RunPreferenceActivationInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly connect: () => Promise<PreferenceActivationConnection>;
  readonly readFile?: (filePath: string) => Promise<string>;
  readonly defaultFile?: string;
}

export function defaultPreferencesFile(env: Readonly<Record<string, string | undefined>>): string {
  // Same directory resolution as src/profile/loader.ts.
  return path.join(env.PROFILE_DIR || 'private/profile', 'work_preferences.json');
}

async function readPreferencesFile(filePath: string, readFile: (filePath: string) => Promise<string>): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(filePath);
  } catch {
    throw new PreferenceActivationRefusal('PREFERENCES_FILE_UNREADABLE', 'The preferences file could not be read; check --file.');
  }
  let parsed: unknown;
  try {
    // A leading byte-order mark (code point 0xFEFF) is not JSON; drop it.
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // JSON.parse messages can quote file content, so they are not repeated.
    throw new PreferenceActivationRefusal('PREFERENCES_FILE_INVALID_JSON', 'The preferences file is not valid JSON.');
  }
  if (!isPlainObject(parsed)) throw new PreferenceActivationRefusal('PREFERENCES_FILE_INVALID_JSON', 'The preferences file must contain a JSON object.');
  return parsed;
}

interface Plan {
  readonly action: 'APPLY' | 'ROLLBACK';
  readonly selectors: readonly string[];
  readonly domains: Array<{
    domain: PreferenceDomain;
    active: ActivePreferenceRevision | null;
    proposed: Record<string, unknown>;
    proposedHash: string;
    targetRevisionId?: string;
    changed: boolean;
    entries: PreferenceDiffEntry[];
  }>;
  readonly diffHash: string;
}

async function planApply(
  client: pg.PoolClient,
  context: WorkspaceContext,
  file: Record<string, unknown>,
  selectors: readonly PreferenceSelector[],
  showValues: boolean,
  forUpdate: boolean,
): Promise<Plan> {
  const active = await readActivePreferenceRevisions(client, context, { forUpdate });
  const activeValues: Partial<Record<PreferenceDomain, Record<string, unknown>>> = {};
  for (const domain of DOMAINS) {
    const row = active[domain];
    if (row) activeValues[domain] = row.value;
  }
  const proposals = buildProposedDomainValues(file, selectors, activeValues);
  const domains: Plan['domains'] = [];
  for (const domain of DOMAINS) {
    const raw = proposals[domain];
    if (!raw) continue;
    const proposed = validatePreferenceDomainValue(domain, raw);
    const proposedHash = preferenceValueHash(proposed);
    const current = active[domain] ?? null;
    domains.push({
      domain,
      active: current,
      proposed,
      proposedHash,
      changed: current?.preferenceHash !== proposedHash,
      entries: diffPreferenceValues(domain, current?.value ?? null, proposed, { showValues }),
    });
  }
  return {
    action: 'APPLY',
    selectors: selectors.map((selector) => selector.label),
    domains,
    diffHash: computePreferenceDiffHash({
      action: 'APPLY',
      workspaceId: context.workspaceId,
      userId: context.userId,
      domains: domains.filter((entry) => entry.changed).map((entry) => ({
        domain: entry.domain,
        fromRevisionId: entry.active?.revisionId ?? null,
        fromPreferenceHash: entry.active?.preferenceHash ?? null,
        toPreferenceHash: entry.proposedHash,
      })),
    }),
  };
}

async function planRollback(
  client: pg.PoolClient,
  context: WorkspaceContext,
  revisionId: string,
  showValues: boolean,
  forUpdate: boolean,
): Promise<Plan> {
  const { rows } = await client.query<{ preference_domain: PreferenceDomain; preference_value: unknown; preference_hash: string }>(
    `SELECT preference_domain, preference_value, preference_hash
     FROM workspace_user_preference_revisions
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND preference_domain = ANY($4::text[])`,
    [context.workspaceId, context.userId, revisionId, DOMAINS],
  );
  const target = rows[0];
  if (!target) throw new PreferenceActivationRefusal('ROLLBACK_REVISION_NOT_FOUND', 'No stage3 or lane_intent revision with that id exists for this workspace user.');
  const domain = target.preference_domain;
  const active = (await readActivePreferenceRevisions(client, context, { forUpdate }))[domain] ?? null;
  if (active?.revisionId === revisionId) {
    throw new PreferenceActivationRefusal('ROLLBACK_REVISION_ALREADY_ACTIVE', `That revision is already the active ${domain} revision.`);
  }
  const value = jsonObject(target.preference_value, `${domain} revision`);
  // An old revision must still satisfy today's schema; otherwise the pipeline could not read it.
  validatePreferenceDomainValue(domain, value);
  const entries = diffPreferenceValues(domain, active?.value ?? null, value, { showValues });
  return {
    action: 'ROLLBACK',
    selectors: [domain],
    domains: [{ domain, active, proposed: value, proposedHash: target.preference_hash, targetRevisionId: revisionId, changed: true, entries }],
    diffHash: computePreferenceDiffHash({
      action: 'ROLLBACK',
      workspaceId: context.workspaceId,
      userId: context.userId,
      domains: [{
        domain,
        fromRevisionId: active?.revisionId ?? null,
        fromPreferenceHash: active?.preferenceHash ?? null,
        toPreferenceHash: target.preference_hash,
        toRevisionId: revisionId,
      }],
    }),
  };
}

function reportFor(
  plan: Plan,
  context: WorkspaceContext,
  options: { mode: 'DRY_RUN' | 'APPLIED'; showValues: boolean; auditTableReady: boolean; applied?: Map<PreferenceDomain, Partial<PreferenceActivationDomainReport>> },
): PreferenceActivationReport {
  const changes = plan.domains.flatMap((entry) => entry.entries);
  const touchesOnsiteList = changes.some((entry) => entry.path === 'stage3.mobility.onsite_exception_employers');
  const flag = plan.action === 'ROLLBACK' ? `--rollback-to=${plan.domains[0]?.targetRevisionId ?? '<revision id>'} ` : '';
  return {
    mode: options.mode,
    action: plan.action,
    workspaceId: context.workspaceId,
    selectors: plan.selectors,
    valuesShown: options.showValues,
    domains: plan.domains.map((entry) => ({
      domain: entry.domain,
      activeRevisionId: entry.active?.revisionId ?? null,
      activeRevisionNumber: entry.active?.revisionNumber ?? null,
      activePreferenceHash: entry.active?.preferenceHash ?? null,
      proposedPreferenceHash: entry.proposedHash,
      changed: entry.changed,
      ...(entry.targetRevisionId ? { targetRevisionId: entry.targetRevisionId } : {}),
      ...(options.applied?.get(entry.domain) ?? {}),
    })),
    changes,
    diffHash: plan.diffHash,
    followUps: describePreferenceFollowUps(changes),
    ...(touchesOnsiteList
      ? { workabilityPolicyHashNote: 'With PR #173 deployed, a non-empty mobility.onsite_exception_employers list is part of workability_policy_hash, so gate, decision and readiness rows written after activation carry a new hash.' }
      : {}),
    auditTableReady: options.auditTableReady,
    nextStep: options.mode === 'APPLIED'
      ? 'Activated. Run the follow-ups listed above; each has its own dry run.'
      : !plan.domains.some((entry) => entry.changed)
        ? 'Nothing to activate: the proposed values equal the active revisions.'
        : `Review the changes, then re-run with the same arguments plus: ${flag}--apply --confirm-workspace=${context.workspaceId} ` +
          `--expect-diff-hash=${plan.diffHash} --operator=<you> --reason=<why> and ${PREFERENCE_ACTIVATION_ENV_FLAG}=true` +
          (options.auditTableReady ? '' : ' (migration 108 must be applied first)'),
  };
}

export async function runPreferenceActivation(input: RunPreferenceActivationInput): Promise<PreferenceActivationReport> {
  const args = parsePreferenceActivationArgs(input.argv);
  assertApplyGuards(args, input.env);
  const readFile = input.readFile ?? ((filePath: string) => fs.readFile(filePath, 'utf8'));

  let file: Record<string, unknown> | null = null;
  let selectors: PreferenceSelector[] = [];
  if (!args.rollbackTo) {
    selectors = args.only.map(parsePreferenceSelector);
    file = await readPreferencesFile(args.file ?? input.defaultFile ?? defaultPreferencesFile(input.env), readFile);
    if (selectors.length === 0) selectors = defaultPreferenceSelectors(file);
    if (selectors.length === 0) throw new PreferenceActivationRefusal('NO_CHANGE', 'The preferences file has no stage3 section and no lane_intent package.');
  }

  const connection = await input.connect();
  const { client } = connection;
  let open = false;
  try {
    await client.query(args.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    open = true;
    const context = await resolveWorkspaceContext(client);
    const auditTableReady = await auditTableExists(client);

    if (args.apply) {
      if (args.confirmWorkspace?.toLowerCase() !== context.workspaceId.toLowerCase()) {
        throw new PreferenceActivationRefusal('CONFIRM_WORKSPACE_MISMATCH', '--confirm-workspace does not match the workspace this connection resolves to.');
      }
      if (context.role !== 'OWNER') {
        throw new PreferenceActivationRefusal('NOT_WORKSPACE_OWNER', 'Only the workspace OWNER may activate preferences.');
      }
      if (!auditTableReady) {
        throw new PreferenceActivationRefusal('AUDIT_TABLE_MISSING', `${PREFERENCE_CHANGE_AUDIT_TABLE} does not exist; apply migration 108 first.`);
      }
      await client.query(`SET LOCAL lock_timeout = '15s'`);
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('jdec_preference_activation'), hashtext($1))`,
        [`${context.workspaceId}:${context.userId}`],
      );
    }

    const plan = args.rollbackTo
      ? await planRollback(client, context, args.rollbackTo, args.showValues, args.apply)
      : await planApply(client, context, file as Record<string, unknown>, selectors, args.showValues, args.apply);

    if (!args.apply) {
      await client.query('ROLLBACK');
      open = false;
      return reportFor(plan, context, { mode: 'DRY_RUN', showValues: args.showValues, auditTableReady });
    }

    if (!plan.domains.some((entry) => entry.changed)) {
      throw new PreferenceActivationRefusal('NO_CHANGE', 'The proposed values equal the active revisions; nothing was written.');
    }
    if (plan.diffHash !== args.expectDiffHash) {
      throw new PreferenceActivationRefusal(
        'DIFF_HASH_MISMATCH',
        'The change differs from the reviewed dry run (the file, the selection or the active revision changed). Nothing was written; run the dry run again.',
      );
    }

    const operator = args.operator as string;
    const reason = args.reason as string;
    const applied = new Map<PreferenceDomain, Partial<PreferenceActivationDomainReport>>();
    for (const entry of plan.domains.filter((candidate) => candidate.changed)) {
      let activeRevisionId: string;
      let details: Partial<PreferenceActivationDomainReport>;
      if (plan.action === 'ROLLBACK') {
        activeRevisionId = entry.targetRevisionId as string;
        await client.query(
          `INSERT INTO workspace_user_preference_active_versions (
             workspace_id, user_id, preference_domain, revision_id, activated_by_user_id
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, user_id, preference_domain)
           DO UPDATE SET revision_id = EXCLUDED.revision_id,
                         activated_by_user_id = EXCLUDED.activated_by_user_id`,
          [context.workspaceId, context.userId, entry.domain, activeRevisionId, context.userId],
        );
        details = {};
      } else {
        const { rows: existing } = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM workspace_user_preference_revisions
           WHERE workspace_id = $1 AND user_id = $2 AND preference_domain = $3 AND preference_hash = $4
           LIMIT 1`,
          [context.workspaceId, context.userId, entry.domain, entry.proposedHash],
        );
        const saved = await saveWorkspacePreferenceRevision(client, context, {
          preferenceDomain: entry.domain,
          schemaVersion: String(entry.proposed.schema_version ?? ''),
          preferenceValue: entry.proposed,
          activate: true,
        });
        if (saved.preferenceHash !== entry.proposedHash) {
          throw new Error(`Saved ${entry.domain} revision hash differs from the reviewed hash; the transaction is rolled back.`);
        }
        activeRevisionId = saved.revisionId;
        details = { newRevisionId: saved.revisionId, newRevisionNumber: saved.revisionNumber, revisionReused: existing.length > 0 };
      }

      const now = (await readActivePreferenceRevisions(client, context))[entry.domain];
      if (now?.revisionId !== activeRevisionId || now.preferenceHash !== entry.proposedHash) {
        throw new Error(`The active ${entry.domain} revision is not the reviewed one after activation; the transaction is rolled back.`);
      }
      const activationEventId = await latestActivationEventId(client, context, entry.domain, activeRevisionId);
      const auditId = await insertChangeAudit(client, context, {
        domain: entry.domain,
        action: plan.action,
        previousRevisionId: entry.active?.revisionId ?? null,
        activeRevisionId,
        previousPreferenceHash: entry.active?.preferenceHash ?? null,
        activePreferenceHash: entry.proposedHash,
        activationEventId,
        diffHash: plan.diffHash,
        operator,
        reason,
        changedPaths: entry.entries.map((change) => change.path),
      });
      applied.set(entry.domain, { ...details, auditId });
    }

    await client.query('COMMIT');
    open = false;
    return reportFor(plan, context, { mode: 'APPLIED', showValues: args.showValues, auditTableReady, applied });
  } catch (error) {
    if (open) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Preference activation rollback failed:', rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    throw error;
  } finally {
    await connection.close();
  }
}
