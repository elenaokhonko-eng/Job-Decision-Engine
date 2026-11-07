const MAX_EMAIL_PARSE_BATCH_SIZE = 20;
const DEFAULT_EMAIL_PARSE_CONCURRENCY = 4;
const MAX_EMAIL_PARSE_CONCURRENCY = 8;
/**
 * Default wall-clock budget for one extraction run. The CI step allows 10
 * minutes; stopping new work at 7 minutes leaves room for in-flight emails to
 * commit and for the run summary to be written. Unstarted alerts stay
 * `processed = FALSE` and are picked up by the next run.
 */
export const DEFAULT_EMAIL_PARSE_MAX_RUNTIME_SECONDS = 420;
const MAX_EMAIL_PARSE_RUNTIME_SECONDS = 3_600;

export interface EmailParseArguments {
  readonly workspaceKey?: string;
  readonly userKey?: string;
  readonly replayBlocked: boolean;
  /** Alerts selected per batch (and the total for a `--replay-blocked` run). */
  readonly limit: number;
  /** Alerts staged in parallel, each in its own transaction. */
  readonly concurrency?: number;
  /** Stop starting new alerts after this many seconds. */
  readonly maxRuntimeSeconds?: number;
}

function boundedInteger(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function parseEmailParseArguments(argv: readonly string[]): EmailParseArguments {
  const values: Record<string, string> = {};
  let replayBlocked = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replay-blocked") {
      replayBlocked = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${argument ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    const key = argument.slice(2);
    if (!["workspace-key", "user-key", "limit", "concurrency", "max-runtime-seconds"].includes(key)) {
      throw new Error(`Unsupported argument: ${argument}`);
    }
    if (values[key]) throw new Error(`${argument} may only be provided once.`);
    values[key] = value;
    index += 1;
  }
  const limit = boundedInteger("limit", values.limit, MAX_EMAIL_PARSE_BATCH_SIZE, 1, MAX_EMAIL_PARSE_BATCH_SIZE);
  const concurrency = boundedInteger(
    "concurrency", values.concurrency, DEFAULT_EMAIL_PARSE_CONCURRENCY, 1, MAX_EMAIL_PARSE_CONCURRENCY,
  );
  const maxRuntimeSeconds = boundedInteger(
    "max-runtime-seconds", values["max-runtime-seconds"], DEFAULT_EMAIL_PARSE_MAX_RUNTIME_SECONDS, 1, MAX_EMAIL_PARSE_RUNTIME_SECONDS,
  );
  return {
    ...(values["workspace-key"] ? { workspaceKey: values["workspace-key"].trim() } : {}),
    ...(values["user-key"] ? { userKey: values["user-key"].trim() } : {}),
    replayBlocked,
    limit,
    concurrency,
    maxRuntimeSeconds,
  };
}

/**
 * Parameters: $1 workspace id, $2 batch size and, when `excludeAttempted` is
 * set, $3 the uuid[] of alerts already attempted in this run so a failed alert
 * (which stays `processed = FALSE`) is not re-selected in a later batch.
 */
export function buildEmailAlertSelectionQuery(replayBlocked: boolean, options: { excludeAttempted?: boolean } = {}): string {
  const exclusion = options.excludeAttempted ? "\n              AND NOT (id = ANY($3::uuid[]))" : "";
  if (!replayBlocked) {
    return `SELECT id, gmail_message_id, subject, body
            FROM raw_email_alerts
            WHERE workspace_id = $1 AND processed = FALSE${exclusion}
            ORDER BY received_at ASC NULLS FIRST, id ASC
            LIMIT $2`;
  }
  return `WITH eligible AS (
            SELECT id, gmail_message_id, subject, body, received_at,
                   CASE WHEN processed THEN 1 ELSE 0 END AS source_priority,
                   ROW_NUMBER() OVER (
                     PARTITION BY processed
                     ORDER BY received_at ASC NULLS FIRST, id ASC
                   ) AS fairness_rank
            FROM raw_email_alerts
            WHERE workspace_id = $1
              AND (
                processed = FALSE
                OR (
                  processed = TRUE
                  AND lifecycle_status = 'SOURCE_BLOCKED'
                  AND (last_error LIKE 'MISSING_POSTING_URL:%'
                    OR last_error LIKE 'EMAIL_EXTRACTION_FAILED:%')
                )
              )${exclusion}
          )
          SELECT id, gmail_message_id, subject, body
          FROM eligible
          ORDER BY fairness_rank ASC, source_priority ASC, received_at ASC NULLS FIRST, id ASC
          LIMIT $2`;
}

export function emailReplayCommand(workspaceKey: string, userKey: string, limit = 20): string {
  const escape = (value: string) => value.replace(/'/g, "''");
  return `npm run email:parse -- --workspace-key '${escape(workspaceKey)}' --user-key '${escape(userKey)}' --replay-blocked --limit ${limit}`;
}
