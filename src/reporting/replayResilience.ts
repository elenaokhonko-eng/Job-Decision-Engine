import type pg from 'pg';

/**
 * Resilience helpers for the replay rehearsal (`scripts/replay_requirement_extraction.ts`).
 *
 * A long replay on a remote branch will see dropped connections. Three rules (AGENTS.md invariant 7):
 *  1. A pg Client or Pool 'error' event never crashes the process unhandled.
 *  2. A dropped connection is reconnected and the interrupted unit of work is retried; a unit that cannot be retried fails loudly.
 *  3. Any failed or incomplete stage makes the run fail; the totals line is printed on success only.
 */

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006',
]);
const TRANSIENT_MESSAGES = [
  'connection terminated',
  'connection error',
  'terminating connection',
  'client has encountered a connection error',
  'server closed the connection',
  'connection timeout',
  'timeout exceeded when trying to connect',
  'client was closed',
];

/** True for errors that mean the connection (not the statement) failed. Statement errors are never retried. */
export function isTransientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    return TRANSIENT_MESSAGES.some((needle) => lower.includes(needle));
  }
  return false;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number) => void | Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn`; on a transient connection error wait, call `onRetry` (reconnect) and run it again. Other errors throw at once. */
export async function retryOnConnectionLoss<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientConnectionError(error) || attempt >= attempts) throw error;
      await sleep((options.baseDelayMs ?? 1000) * 2 ** (attempt - 1));
      await options.onRetry?.(error, attempt);
    }
  }
}

/** Pool errors (an idle client dropped by the server) are emitted as events; without a listener they crash the process. */
export function attachPoolErrorHandler(pool: pg.Pool, log: (message: string) => void = console.error): void {
  pool.on('error', (error) => log(`Pool connection error (the pool replaces the client): ${error.message}`));
}

/**
 * A single pg Client that survives a dropped connection. 'error' events are handled; the next query reconnects.
 * A statement outside a transaction is retried after a reconnect. A drop inside a transaction cannot be retried
 * statement by statement (the server rolled it back), so it throws and the caller retries the whole unit with
 * `retryOnConnectionLoss`.
 */
export class ResilientClient {
  private client: pg.Client | null = null;
  private broken = false;
  private inTransaction = false;
  reconnects = 0;

  constructor(
    private readonly createClient: () => pg.Client,
    private readonly options: RetryOptions & { log?: (message: string) => void } = {},
  ) {}

  private log(message: string): void {
    (this.options.log ?? console.error)(message);
  }

  async connect(): Promise<void> {
    await this.ensure();
  }

  private async ensure(): Promise<pg.Client> {
    if (this.client && !this.broken) return this.client;
    if (this.client) {
      const stale = this.client;
      this.client = null;
      await stale.end().catch(() => undefined);
    }
    const fresh = this.createClient();
    fresh.on('error', (error) => {
      this.broken = true;
      this.log(`Database connection error: ${error.message}`);
    });
    await fresh.connect();
    this.client = fresh;
    this.broken = false;
    return fresh;
  }

  private async reconnect(): Promise<void> {
    this.broken = true;
    this.reconnects += 1;
    this.log(`Reconnecting to the database (reconnect ${this.reconnects}).`);
    await this.ensure();
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const keyword = text.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    const startsTransaction = keyword === 'BEGIN' || keyword === 'START';
    const endsTransaction = keyword === 'COMMIT' || keyword === 'ROLLBACK' || keyword === 'END';
    const run = async (): Promise<pg.QueryResult<R>> => {
      const client = await this.ensure();
      return client.query<R>(text, values as never);
    };
    // A connection that dropped inside a transaction has lost the transaction: only the caller can redo it.
    if (this.inTransaction && this.broken) {
      this.inTransaction = false;
      await this.reconnect();
      if (endsTransaction) return this.endLostTransaction<R>(keyword);
      throw new Error('Connection terminated: the connection was lost inside a transaction.');
    }
    try {
      const result = await run();
      if (startsTransaction) this.inTransaction = true;
      if (endsTransaction) this.inTransaction = false;
      return result;
    } catch (error) {
      if (!isTransientConnectionError(error)) throw error;
      this.broken = true;
      if (this.inTransaction) {
        this.inTransaction = false;
        await this.reconnect();
        if (endsTransaction) return this.endLostTransaction<R>(keyword);
        throw error;
      }
      await this.reconnect();
      const result = await retryOnConnectionLoss(run, {
        ...this.options,
        attempts: this.options.attempts ?? 4,
        onRetry: async () => this.reconnect(),
      });
      if (startsTransaction) this.inTransaction = true;
      return result;
    }
  }

  /**
   * The server rolled the transaction back with the connection. A ROLLBACK is therefore already done and reports success;
   * a COMMIT did not happen and must never look as if it did. This client is for read-only transactions
   * (the replay's BEGIN READ ONLY measurement); a unit that writes inside a transaction must use its own connection.
   */
  private endLostTransaction<R extends pg.QueryResultRow>(keyword: string): pg.QueryResult<R> {
    if (keyword === 'COMMIT' || keyword === 'END') {
      throw new Error('Connection terminated: the connection was lost inside a transaction, so the COMMIT did not happen.');
    }
    return { rows: [], rowCount: 0, command: keyword, oid: 0, fields: [] } as pg.QueryResult<R>;
  }

  async end(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }
}

export interface ReplayTotals {
  routed: number;
  extracted: number;
  extractionErrors: number;
  embeddingsOk: number;
  embeddingsFailed: number;
  matched: number;
  /** Matched but held back: a mandatory qualification the matcher found short, or semantic evidence still incomplete. */
  matchHeldBack: number;
  matchErrors: number;
  decisionErrors: number;
  /** Jobs skipped because an earlier run already replayed them (resume). */
  resumedSkipped: number;
  /** Chunks that were re-run after a dropped connection. */
  chunksRetried: number;
}

export function emptyReplayTotals(): ReplayTotals {
  return {
    routed: 0, extracted: 0, extractionErrors: 0, embeddingsOk: 0, embeddingsFailed: 0,
    matched: 0, matchHeldBack: 0, matchErrors: 0, decisionErrors: 0, resumedSkipped: 0, chunksRetried: 0,
  };
}

/**
 * Failures that must make the run exit non-zero. A stage can only take the jobs it is eligible for (a hard-rejected
 * job is never extracted), so completeness is judged against what the stage itself reported as selected:
 * `extractionDiscovered` is the sum of `discovered` over the extraction calls.
 */
export function assessReplay(
  totals: ReplayTotals,
  counts: { extractionDiscovered: number; rematchOnly: boolean },
): string[] {
  const failures: string[] = [];
  if (totals.extractionErrors > 0) failures.push(`${totals.extractionErrors} extraction error(s)`);
  if (totals.embeddingsFailed > 0) failures.push(`${totals.embeddingsFailed} embedding input(s) failed`);
  if (totals.matchErrors > 0) failures.push(`${totals.matchErrors} match error(s)`);
  if (totals.decisionErrors > 0) failures.push(`${totals.decisionErrors} decision error(s)`);
  if (!counts.rematchOnly && totals.extracted + totals.extractionErrors < counts.extractionDiscovered) {
    failures.push(`extraction incomplete: ${totals.extracted} of ${counts.extractionDiscovered} selected jobs extracted`);
  }
  return failures;
}

interface QueryLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ canonical_job_id: string }> }>;
}

/**
 * Resume support: the canonical jobs whose latest job version already has an active requirement set on
 * `extractorVersion`. Re-extracting them would only create a new revision (and orphan the embeddings already
 * published for the old one), so a restarted run skips extraction for them and continues where the last one stopped.
 * Embedding publication, matching and deciding are idempotent and still run for every job in scope.
 */
export async function loadJobsOnExtractorVersion(
  client: QueryLike,
  workspaceId: string,
  canonicalJobIds: string[],
  extractorVersion: string,
): Promise<Set<string>> {
  if (canonicalJobIds.length === 0) return new Set();
  const { rows } = await client.query(
    `SELECT cj.id::text AS canonical_job_id
       FROM canonical_jobs cj
       JOIN job_versions jv ON jv.id = cj.latest_job_version_id
       JOIN requirement_sets rs ON rs.id = jv.active_requirement_set_id
       JOIN requirement_set_identities rsi ON rsi.id = rs.requirement_identity_id
      WHERE cj.workspace_id = $1
        AND cj.id = ANY($2::uuid[])
        AND rsi.deterministic_extractor_version = $3
        AND EXISTS (SELECT 1 FROM job_requirements jr WHERE jr.requirement_set_id = rs.id)`,
    [workspaceId, canonicalJobIds, extractorVersion],
  );
  return new Set(rows.map((row) => row.canonical_job_id));
}

/**
 * Funnel check after a replay: scope jobs that passed the gate but were left before matching (still PREQUALIFIED or
 * LANE_ROUTED). The replay cannot decide whether each is a real stranding, so the script prints this as a warning for the
 * availability/lane workstreams rather than failing on it.
 */
export async function countGatePassedLeftBeforeMatching(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ n: number }> }> },
  workspaceId: string,
  canonicalJobIds: string[],
): Promise<number> {
  if (canonicalJobIds.length === 0) return 0;
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM canonical_jobs cj
      WHERE cj.workspace_id = $1 AND cj.id = ANY($2::uuid[])
        AND cj.gate_decision = 'PASS'
        AND COALESCE(cj.processing_state, cj.processing_status) IN ('PREQUALIFIED', 'LANE_ROUTED')`,
    [workspaceId, canonicalJobIds],
  );
  return rows[0]?.n ?? 0;
}

/** The stage functions one replay chunk runs. Injected so the chunk logic is tested without a database. */
export interface ReplayStages {
  extract: (jobVersionIds: string[]) => Promise<{ discovered: number; processed: number; errors: number }>;
  embed: (jobVersionIds: string[]) => Promise<{ succeeded: number; failed: number }>;
  /** Only when the run re-gated: a re-gate leaves jobs before lane routing. */
  route?: (canonicalJobIds: string[]) => Promise<{ routed: number }>;
  match: (canonicalJobIds: string[]) => Promise<{ matchedJobs: number; skippedJobs: number; errors: number }>;
  decide: (canonicalJobIds: string[]) => Promise<{ errors: number }>;
}

export interface ReplayChunkInput {
  canonicalJobIds: string[];
  jobVersionIds: string[];
  /** The part of the chunk that still needs extraction (the rest were resumed). */
  extractJobVersionIds: string[];
}

export interface ReplayChunkResult {
  totals: ReplayTotals;
  extractionDiscovered: number;
  /** How many times the chunk was re-run after a dropped connection. */
  retries: number;
}

/**
 * One chunk is a unit of work. A dropped connection re-runs the whole chunk (every stage is idempotent). Totals are
 * built fresh on every attempt and returned only for the attempt that finished, so a retry never double counts.
 * A non-connection error, or running out of retries, is thrown.
 */
export async function runReplayChunk(
  stages: ReplayStages,
  chunk: ReplayChunkInput,
  options: { rematchOnly: boolean; maxRetries: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void },
): Promise<ReplayChunkResult> {
  const sleep = options.sleep ?? defaultSleep;
  let retries = 0;
  for (;;) {
    const totals = emptyReplayTotals();
    let extractionDiscovered = 0;
    try {
      if (!options.rematchOnly) {
        if (chunk.extractJobVersionIds.length > 0) {
          const extraction = await stages.extract(chunk.extractJobVersionIds);
          extractionDiscovered += extraction.discovered;
          totals.extracted += extraction.processed;
          totals.extractionErrors += extraction.errors;
        }
        const embeddings = await stages.embed(chunk.jobVersionIds);
        totals.embeddingsOk += embeddings.succeeded;
        totals.embeddingsFailed += embeddings.failed;
      }
      if (stages.route) totals.routed += (await stages.route(chunk.canonicalJobIds)).routed;
      const matching = await stages.match(chunk.canonicalJobIds);
      totals.matched += matching.matchedJobs;
      totals.matchHeldBack += matching.skippedJobs;
      totals.matchErrors += matching.errors;
      totals.decisionErrors += (await stages.decide(chunk.canonicalJobIds)).errors;
      return { totals, extractionDiscovered, retries };
    } catch (error) {
      if (!isTransientConnectionError(error) || retries >= options.maxRetries) throw error;
      retries += 1;
      (options.log ?? console.error)(`Chunk lost its connection (${error instanceof Error ? error.message : String(error)}); retrying (${retries}/${options.maxRetries}).`);
      await sleep(2000 * retries);
    }
  }
}

/** Add a finished chunk to the run totals (the resume and retry counters are kept by the caller). */
export function addChunkTotals(into: ReplayTotals, chunk: ReplayTotals): void {
  for (const key of Object.keys(chunk) as Array<keyof ReplayTotals>) {
    if (key !== 'resumedSkipped' && key !== 'chunksRetried') into[key] += chunk[key];
  }
}

/** Broken-funnel guard: a first chunk that matched or held back nothing means the jobs never reached the matcher. */
export function assertFirstChunkReachedMatcher(totals: ReplayTotals, isFirstChunk: boolean): void {
  if (isFirstChunk && totals.matched + totals.matchHeldBack === 0) {
    throw new Error('The first chunk matched 0 jobs: they did not reach the matcher. Stopping.');
  }
}
