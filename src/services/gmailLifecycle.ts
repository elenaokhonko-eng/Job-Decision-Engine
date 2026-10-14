import pg from "pg";
import { GmailApiClient } from "./gmailApi.js";
import { resolveWorkspaceContext } from "../workspace/context.js";

export interface ReconcileResult {
  inspectedAlerts: number;
  eligibleTerminalAlerts: number;
  trashedAlerts: number;
  inFlightAlerts: number;
  errors: string[];
}

export interface EmailAlertLineage {
  id: number;
  gmailMessageId: string | null;
  subject: string;
  lifecycleStatus: string;
  processed: boolean;
  totalObservations: number;
  totalCanonicalJobs: number;
  terminalJobsCount: number;
  inFlightJobsCount: number;
  isEligibleForTrash: boolean;
}

export async function checkEmailAlertLineage(
  pool: pg.Pool,
  workspaceId: string,
  limit: number = 200
): Promise<EmailAlertLineage[]> {
  const query = `
    SELECT
      rea.id,
      rea.gmail_message_id,
      rea.subject,
      rea.lifecycle_status,
      rea.processed,
      COUNT(DISTINCT rjo.id) AS total_observations,
      COUNT(DISTINCT cj.id) AS total_canonical_jobs,
      COUNT(DISTINCT CASE 
        WHEN COALESCE(cj.processing_state, cj.processing_status) IN ('HARD_REJECTED', 'UNMATCHED', 'AI_EVALUATED')
             OR cj.recommendation_outcome IS NOT NULL 
        THEN cj.id 
      END) AS terminal_jobs_count,
      COUNT(DISTINCT CASE 
        WHEN cj.id IS NOT NULL 
             AND COALESCE(cj.processing_state, cj.processing_status) NOT IN ('HARD_REJECTED', 'UNMATCHED', 'AI_EVALUATED')
             AND cj.recommendation_outcome IS NULL
        THEN cj.id 
      END) AS in_flight_jobs_count
    FROM raw_email_alerts rea
    LEFT JOIN raw_job_observations rjo 
      ON rjo.workspace_id = rea.workspace_id 
      AND (
        rjo.raw_email_alert_id = rea.id 
        OR (rea.gmail_message_id IS NOT NULL AND rjo.gmail_message_id = rea.gmail_message_id)
        OR (rea.gmail_message_id IS NOT NULL AND rjo.source_external_id LIKE 'gmail-' || rea.gmail_message_id || '-%')
      )
    LEFT JOIN job_versions jv
      ON jv.workspace_id = rjo.workspace_id
      AND jv.id = rjo.job_version_id
    LEFT JOIN canonical_jobs cj
      ON cj.workspace_id = rea.workspace_id
      AND cj.id = jv.canonical_job_id
    WHERE rea.workspace_id = $1
      AND rea.processed = TRUE
      AND rea.lifecycle_status != 'TRASHED'
    GROUP BY rea.id, rea.gmail_message_id, rea.subject, rea.lifecycle_status, rea.processed
    ORDER BY rea.id ASC
    LIMIT $2
  `;

  const { rows } = await pool.query(query, [workspaceId, limit]);

  return rows.map((row) => {
    const totalObs = Number(row.total_observations) || 0;
    const totalCanonical = Number(row.total_canonical_jobs) || 0;
    const terminalJobs = Number(row.terminal_jobs_count) || 0;
    const inFlightJobs = Number(row.in_flight_jobs_count) || 0;

    // An email is eligible for trash if:
    // 1. It yielded 0 job observations (empty alert, news digest, etc.)
    // 2. OR all extracted job observations have a corresponding canonical job that reached a terminal stage/recommendation, with 0 jobs in flight
    const isEligibleForTrash = totalObs === 0 || (totalObs > 0 && totalCanonical >= totalObs && inFlightJobs === 0 && terminalJobs >= totalCanonical);

    return {
      id: Number(row.id),
      gmailMessageId: row.gmail_message_id,
      subject: row.subject,
      lifecycleStatus: row.lifecycle_status,
      processed: Boolean(row.processed),
      totalObservations: totalObs,
      totalCanonicalJobs: totalCanonical,
      terminalJobsCount: terminalJobs,
      inFlightJobsCount: inFlightJobs,
      isEligibleForTrash,
    };
  });
}

export async function reconcileTerminalGmailAlerts(options: {
  pool: pg.Pool;
  gmailClient?: GmailApiClient;
  dryRun?: boolean;
  limit?: number;
}): Promise<ReconcileResult> {
  const { pool, gmailClient, dryRun = false, limit = 200 } = options;
  const ctx = await resolveWorkspaceContext(pool as any);
  const lineages = await checkEmailAlertLineage(pool, ctx.workspaceId, limit);

  const result: ReconcileResult = {
    inspectedAlerts: lineages.length,
    eligibleTerminalAlerts: 0,
    trashedAlerts: 0,
    inFlightAlerts: 0,
    errors: [],
  };

  for (const item of lineages) {
    if (!item.isEligibleForTrash) {
      result.inFlightAlerts += 1;
      continue;
    }

    result.eligibleTerminalAlerts += 1;

    if (dryRun) {
      continue;
    }

    try {
      if (item.gmailMessageId && gmailClient) {
        try {
          await gmailClient.markRead(item.gmailMessageId);
        } catch (markError: any) {
          // If already read or not found, proceed to trash
        }

        try {
          await gmailClient.trashMessage(item.gmailMessageId);
        } catch (trashError: any) {
          // If message was already deleted or trashed in Gmail, record and still mark DB
          console.warn(`Gmail API trash warning for message ${item.gmailMessageId}:`, trashError?.message || trashError);
        }
      }

      await pool.query(
        `UPDATE raw_email_alerts
         SET lifecycle_status = 'TRASHED',
             trashed_at = NOW(),
             marked_read_at = COALESCE(marked_read_at, NOW())
         WHERE workspace_id = $1 AND id = $2`,
        [ctx.workspaceId, item.id]
      );
      result.trashedAlerts += 1;
    } catch (err: any) {
      const msg = `Failed to trash email alert #${item.id} (${item.gmailMessageId}): ${err.message || String(err)}`;
      console.error(msg);
      result.errors.push(msg);
    }
  }

  return result;
}
