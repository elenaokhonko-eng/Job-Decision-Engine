/**
 * Weekly board yield for the pipeline status report: for each source and each ATS board / feed,
 * how many jobs first seen in the window were staged, hard-rejected, passed the gates, were
 * AI-evaluated and reached PRIORITY or REVIEW. A board with no gate pass after
 * BOARD_YIELD_ZERO_PASS_MIN_STAGED staged jobs is flagged so its target lanes or slug can be
 * reviewed. Read-only. Reported only when PIPELINE_BOARD_YIELD_REPORT_ENABLED is "true".
 */

export const BOARD_YIELD_WINDOW_DAYS = 7;
export const BOARD_YIELD_ZERO_PASS_MIN_STAGED = 20;

export function boardYieldReportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.PIPELINE_BOARD_YIELD_REPORT_ENABLED ?? "").trim().toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error('PIPELINE_BOARD_YIELD_REPORT_ENABLED must be "true" or "false".');
}

/**
 * One row per (source, board). The board is the runner's checkpoint target taken from the job's
 * first STAGED/DUPLICATE disposition ("ats:<company id>" or "feed:<plugin>"); jobs without one
 * (Gmail, saved exports, manual intake) use their source plugin key or source name.
 * "passed_gates" counts PASS and NEEDS_VERIFICATION (not hard-rejected).
 * $1 workspace id, $2 window in days.
 */
export const BOARD_YIELD_SQL = `
  WITH window_jobs AS (
    SELECT c.id, c.recommendation_outcome
    FROM canonical_jobs c
    WHERE c.workspace_id = $1
      AND c.is_test_fixture = FALSE
      AND c.created_at >= NOW() - make_interval(days => $2::int)
  ),
  first_obs AS (
    SELECT DISTINCT ON (v.canonical_job_id)
      v.canonical_job_id, o.id AS observation_id, o.source_name, o.source_plugin_key
    FROM window_jobs w
    JOIN job_versions v ON v.workspace_id = $1 AND v.canonical_job_id = w.id
    JOIN raw_job_observations o ON o.workspace_id = $1 AND o.job_version_id = v.id
    ORDER BY v.canonical_job_id, o.retrieved_at ASC, o.id ASC
  ),
  latest_gate AS (
    SELECT DISTINCT ON (g.canonical_job_id) g.canonical_job_id, g.decision
    FROM gate_decisions g
    JOIN window_jobs w ON w.id = g.canonical_job_id
    WHERE g.workspace_id = $1
    ORDER BY g.canonical_job_id, g.created_at DESC, g.id DESC
  )
  SELECT
    COALESCE(f.source_name, 'UNKNOWN') AS source,
    COALESCE(board.board, f.source_plugin_key, f.source_name, 'UNKNOWN') AS board,
    COUNT(*)::int AS staged,
    COUNT(*) FILTER (WHERE g.decision = 'HARD_REJECT')::int AS hard_rejected,
    COUNT(*) FILTER (WHERE g.decision IN ('PASS', 'NEEDS_VERIFICATION'))::int AS passed_gates,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM ai_evaluations e WHERE e.workspace_id = $1 AND e.canonical_job_id = f.canonical_job_id
    ))::int AS evaluated,
    COUNT(*) FILTER (WHERE w.recommendation_outcome IN ('PRIORITY', 'REVIEW'))::int AS priority_review
  FROM first_obs f
  JOIN window_jobs w ON w.id = f.canonical_job_id
  LEFT JOIN latest_gate g ON g.canonical_job_id = f.canonical_job_id
  LEFT JOIN LATERAL (
    SELECT regexp_replace(d.plan_key, ':[A-Z][A-Z0-9_]*$', '') AS board
    FROM source_candidate_dispositions d
    WHERE d.workspace_id = $1
      AND d.job_observation_id = f.observation_id
      AND d.disposition IN ('STAGED', 'DUPLICATE')
    ORDER BY d.fetched_at ASC, d.id ASC
    LIMIT 1
  ) board ON TRUE
  GROUP BY 1, 2
  ORDER BY staged DESC, source, board
`;

export interface BoardYieldRow {
  readonly source: string;
  readonly board: string;
  readonly staged: number;
  readonly hard_rejected: number;
  readonly passed_gates: number;
  readonly evaluated: number;
  readonly priority_review: number;
}

export interface BoardYieldSummary {
  readonly window_days: number;
  readonly zero_pass_min_staged: number;
  readonly boards: ReadonlyArray<BoardYieldRow & { readonly zero_pass_flag: boolean }>;
  readonly flagged_boards: readonly string[];
}

export function summarizeBoardYield(rows: readonly BoardYieldRow[], windowDays = BOARD_YIELD_WINDOW_DAYS): BoardYieldSummary {
  const boards = rows.map((row) => {
    const normalized = {
      source: row.source,
      board: row.board,
      staged: Number(row.staged),
      hard_rejected: Number(row.hard_rejected),
      passed_gates: Number(row.passed_gates),
      evaluated: Number(row.evaluated),
      priority_review: Number(row.priority_review),
    };
    return { ...normalized, zero_pass_flag: normalized.staged >= BOARD_YIELD_ZERO_PASS_MIN_STAGED && normalized.passed_gates === 0 };
  });
  return {
    window_days: windowDays,
    zero_pass_min_staged: BOARD_YIELD_ZERO_PASS_MIN_STAGED,
    boards,
    flagged_boards: boards.filter((row) => row.zero_pass_flag).map((row) => `${row.source} ${row.board}`),
  };
}
