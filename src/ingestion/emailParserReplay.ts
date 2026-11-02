const MAX_EMAIL_PARSE_BATCH_SIZE = 20;

export interface EmailParseArguments {
  readonly workspaceKey?: string;
  readonly userKey?: string;
  readonly replayBlocked: boolean;
  readonly limit: number;
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
    if (!["workspace-key", "user-key", "limit"].includes(key)) throw new Error(`Unsupported argument: ${argument}`);
    if (values[key]) throw new Error(`${argument} may only be provided once.`);
    values[key] = value;
    index += 1;
  }
  const limit = values.limit === undefined ? MAX_EMAIL_PARSE_BATCH_SIZE : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EMAIL_PARSE_BATCH_SIZE) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_EMAIL_PARSE_BATCH_SIZE}.`);
  }
  return {
    ...(values["workspace-key"] ? { workspaceKey: values["workspace-key"].trim() } : {}),
    ...(values["user-key"] ? { userKey: values["user-key"].trim() } : {}),
    replayBlocked,
    limit,
  };
}

export function buildEmailAlertSelectionQuery(replayBlocked: boolean): string {
  if (!replayBlocked) {
    return `SELECT id, gmail_message_id, subject, body
            FROM raw_email_alerts
            WHERE workspace_id = $1 AND processed = FALSE
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
              )
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
