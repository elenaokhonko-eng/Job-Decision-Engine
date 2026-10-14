import pg from "pg";
import { GmailApiClient, type GmailLabel } from "./gmailApi.js";
import { resolveWorkspaceContext } from "../workspace/context.js";

export type LineageClassification =
  | "TERMINAL"
  | "IN_FLIGHT"
  | "NO_DERIVED_OBSERVATIONS"
  | "MISSING_CANONICAL_LINEAGE"
  | "PROCESSING_ERROR";

export interface EmailAlertLineage {
  id: string;
  gmailMessageId: string | null;
  subject: string;
  lifecycleStatus: string;
  processed: boolean;
  totalObservations: number;
  totalCanonicalJobs: number;
  terminalJobsCount: number;
  inFlightJobsCount: number;
  hasProcessingError: boolean;
  classification: LineageClassification;
  isEligibleForTrash: boolean;
}

export interface ReconcileResult {
  inspectedAlerts: number;
  eligibleTerminalAlerts: number;
  trashedAlerts: number;
  inFlightAlerts: number;
  zeroLineageAlerts: number;
  missingLineageAlerts: number;
  legacyProcessedInspected: number;
  legacyProcessedToInProcessing: number;
  legacyProcessedTerminalEligible: number;
  legacyProcessedTrashed: number;
  legacyProcessedRetainedMissing: number;
  errors: string[];
}

export interface ReconcileOptions {
  pool: pg.Pool;
  gmailClient?: GmailApiClient;
  dryRun?: boolean;
  limit?: number;
  inProcessingFolderName?: string;
  legacyProcessedFolderName?: string;
}

export function classifyLineage(row: {
  total_observations: string | number;
  total_canonical_jobs: string | number;
  terminal_jobs_count: string | number;
  in_flight_jobs_count: string | number;
  has_error: boolean;
}): { classification: LineageClassification; isEligibleForTrash: boolean } {
  const totalObs = Number(row.total_observations) || 0;
  const totalCanonical = Number(row.total_canonical_jobs) || 0;
  const terminalJobs = Number(row.terminal_jobs_count) || 0;
  const inFlightJobs = Number(row.in_flight_jobs_count) || 0;
  const hasError = Boolean(row.has_error);

  // Requirement 3: Zero lineage must NEVER be automatically trashed
  if (totalObs === 0) {
    return { classification: "NO_DERIVED_OBSERVATIONS", isEligibleForTrash: false };
  }
  if (hasError) {
    return { classification: "PROCESSING_ERROR", isEligibleForTrash: false };
  }
  if (inFlightJobs > 0) {
    return { classification: "IN_FLIGHT", isEligibleForTrash: false };
  }
  if (totalCanonical < totalObs) {
    return { classification: "MISSING_CANONICAL_LINEAGE", isEligibleForTrash: false };
  }
  // All derived canonical jobs are terminal and 0 in flight
  if (terminalJobs >= totalCanonical && terminalJobs >= totalObs && inFlightJobs === 0) {
    return { classification: "TERMINAL", isEligibleForTrash: true };
  }
  return { classification: "IN_FLIGHT", isEligibleForTrash: false };
}

export async function checkEmailAlertLineage(
  pool: pg.Pool,
  workspaceId: string,
  limit: number = 500
): Promise<EmailAlertLineage[]> {
  const query = `
    SELECT
      rea.id,
      rea.gmail_message_id,
      rea.subject,
      rea.lifecycle_status,
      rea.processed,
      (rea.last_error IS NOT NULL) AS has_error,
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
    GROUP BY rea.id, rea.gmail_message_id, rea.subject, rea.lifecycle_status, rea.processed, rea.last_error
    ORDER BY rea.id ASC
    LIMIT $2
  `;

  const { rows } = await pool.query(query, [workspaceId, limit]);

  return rows.map((row) => {
    const totalObs = Number(row.total_observations) || 0;
    const totalCanonical = Number(row.total_canonical_jobs) || 0;
    const terminalJobs = Number(row.terminal_jobs_count) || 0;
    const inFlightJobs = Number(row.in_flight_jobs_count) || 0;
    const { classification, isEligibleForTrash } = classifyLineage(row);

    return {
      id: String(row.id),
      gmailMessageId: row.gmail_message_id,
      subject: row.subject,
      lifecycleStatus: row.lifecycle_status,
      processed: Boolean(row.processed),
      totalObservations: totalObs,
      totalCanonicalJobs: totalCanonical,
      terminalJobsCount: terminalJobs,
      inFlightJobsCount: inFlightJobs,
      hasProcessingError: Boolean(row.has_error),
      classification,
      isEligibleForTrash,
    };
  });
}

export async function checkSingleEmailAlertLineage(
  pool: pg.Pool,
  workspaceId: string,
  gmailMessageId: string
): Promise<EmailAlertLineage | null> {
  const query = `
    SELECT
      rea.id,
      rea.gmail_message_id,
      rea.subject,
      rea.lifecycle_status,
      rea.processed,
      (rea.last_error IS NOT NULL) AS has_error,
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
      AND rea.gmail_message_id = $2
    GROUP BY rea.id, rea.gmail_message_id, rea.subject, rea.lifecycle_status, rea.processed, rea.last_error
    LIMIT 1
  `;

  const { rows } = await pool.query(query, [workspaceId, gmailMessageId]);
  if (rows.length === 0) return null;

  const row = rows[0];
  const { classification, isEligibleForTrash } = classifyLineage(row);

  return {
    id: String(row.id),
    gmailMessageId: row.gmail_message_id,
    subject: row.subject,
    lifecycleStatus: row.lifecycle_status,
    processed: Boolean(row.processed),
    totalObservations: Number(row.total_observations) || 0,
    totalCanonicalJobs: Number(row.total_canonical_jobs) || 0,
    terminalJobsCount: Number(row.terminal_jobs_count) || 0,
    inFlightJobsCount: Number(row.in_flight_jobs_count) || 0,
    hasProcessingError: Boolean(row.has_error),
    classification,
    isEligibleForTrash,
  };
}

export async function reconcileTerminalGmailAlerts(
  options: ReconcileOptions
): Promise<ReconcileResult> {
  const {
    pool,
    gmailClient,
    dryRun = false,
    limit = 500,
    inProcessingFolderName = "Jobs-Alerts-In-Processing",
    legacyProcessedFolderName = "Jobs-Alerts-Processed",
  } = options;

  const ctx = await resolveWorkspaceContext(pool as any);
  const lineages = await checkEmailAlertLineage(pool, ctx.workspaceId, limit);

  const result: ReconcileResult = {
    inspectedAlerts: lineages.length,
    eligibleTerminalAlerts: 0,
    trashedAlerts: 0,
    inFlightAlerts: 0,
    zeroLineageAlerts: 0,
    missingLineageAlerts: 0,
    legacyProcessedInspected: 0,
    legacyProcessedToInProcessing: 0,
    legacyProcessedTerminalEligible: 0,
    legacyProcessedTrashed: 0,
    legacyProcessedRetainedMissing: 0,
    errors: [],
  };

  let inProcessingLabel: GmailLabel | undefined;
  let legacyLabel: GmailLabel | undefined;

  if (gmailClient) {
    try {
      const labels = await gmailClient.listLabels();
      inProcessingLabel = labels.find((l) => l.name === inProcessingFolderName);
      legacyLabel = labels.find((l) => l.name === legacyProcessedFolderName);
    } catch (labelListErr: any) {
      console.warn("Could not list Gmail labels during reconciliation setup:", labelListErr?.message || labelListErr);
    }
  }

  const processedMessageIds = new Set<string>();

  // 1. Process active staged/parsed raw_email_alerts
  for (const item of lineages) {
    if (item.gmailMessageId) {
      processedMessageIds.add(item.gmailMessageId);
    }

    if (item.classification === "NO_DERIVED_OBSERVATIONS") {
      result.zeroLineageAlerts += 1;
      result.inFlightAlerts += 1;
      continue;
    }

    if (item.classification === "MISSING_CANONICAL_LINEAGE") {
      result.missingLineageAlerts += 1;
      result.inFlightAlerts += 1;
      continue;
    }

    if (!item.isEligibleForTrash) {
      result.inFlightAlerts += 1;
      continue;
    }

    result.eligibleTerminalAlerts += 1;

    if (dryRun) {
      continue;
    }

    // Required Order (Section 2):
    // all derived jobs confirmed terminal
    // -> gmailClient.markRead(messageId)
    // -> persist marked_read_at only after successful/idempotent read transition
    // -> remove In-Processing label
    // -> move message to Trash
    // -> persist trashed_at / lifecycle_status=TRASHED
    try {
      if (item.gmailMessageId && gmailClient) {
        let markReadSucceeded = false;
        try {
          await gmailClient.markRead(item.gmailMessageId);
          markReadSucceeded = true;
        } catch (markError: any) {
          const msg = String(markError?.message || markError);
          if (/already|not found|404/i.test(msg)) {
            markReadSucceeded = true;
          } else {
            result.errors.push(`markRead failed for message ${item.gmailMessageId}: ${msg}`);
          }
        }

        if (!markReadSucceeded) {
          continue;
        }

        // Persist marked_read_at after successful/idempotent read transition
        await pool.query(
          `UPDATE raw_email_alerts
           SET marked_read_at = COALESCE(marked_read_at, NOW())
           WHERE workspace_id = $1 AND id = $2`,
          [ctx.workspaceId, item.id]
        );

        // Remove In-Processing label
        try {
          const removeLabelIds: string[] = [];
          if (inProcessingLabel?.id) removeLabelIds.push(inProcessingLabel.id);
          if (legacyLabel?.id) removeLabelIds.push(legacyLabel.id);
          if (removeLabelIds.length > 0) {
            await gmailClient.modifyMessageLabels(item.gmailMessageId, {
              removeLabelIds,
            });
          }
        } catch (removeLabelErr: any) {
          console.warn(`Label removal warning for ${item.gmailMessageId}:`, removeLabelErr?.message || removeLabelErr);
        }

        // Move message to Trash
        try {
          await gmailClient.trashMessage(item.gmailMessageId);
        } catch (trashError: any) {
          const msg = String(trashError?.message || trashError);
          if (!/already|not found|404/i.test(msg)) {
            result.errors.push(`trashMessage failed for message ${item.gmailMessageId}: ${msg}`);
          }
        }

        // Persist trashed_at / lifecycle_status=TRASHED
        await pool.query(
          `UPDATE raw_email_alerts
           SET lifecycle_status = 'TRASHED',
               trashed_at = NOW(),
               marked_read_at = COALESCE(marked_read_at, NOW())
           WHERE workspace_id = $1 AND id = $2`,
          [ctx.workspaceId, item.id]
        );
        result.trashedAlerts += 1;
      } else {
        // Postgres-only reconciliation
        await pool.query(
          `UPDATE raw_email_alerts
           SET lifecycle_status = 'TRASHED',
           trashed_at = NOW(),
           marked_read_at = COALESCE(marked_read_at, NOW())
         WHERE workspace_id = $1 AND id = $2`,
          [ctx.workspaceId, item.id]
        );
        result.trashedAlerts += 1;
      }
    } catch (err: any) {
      const msg = `Failed to trash email alert #${item.id} (${item.gmailMessageId}): ${err.message || String(err)}`;
      console.error(msg);
      result.errors.push(msg);
    }
  }

  // 2. Section 6: Migrate legacy Jobs-Alerts-Processed messages safely
  if (gmailClient && legacyLabel) {
    try {
      const legacyMessageIds = await gmailClient.listMessageIdsByLabel(legacyLabel.id, 250);
      result.legacyProcessedInspected = legacyMessageIds.length;

      for (const legacyId of legacyMessageIds) {
        if (processedMessageIds.has(legacyId)) {
          continue;
        }
        processedMessageIds.add(legacyId);

        const lineage = await checkSingleEmailAlertLineage(pool, ctx.workspaceId, legacyId);

        if (!lineage || lineage.classification === "NO_DERIVED_OBSERVATIONS" || lineage.classification === "MISSING_CANONICAL_LINEAGE") {
          // Missing lineage: retain message -> do NOT Trash -> report explicitly
          result.legacyProcessedRetainedMissing += 1;
          console.log(`[LEGACY_MIGRATION] Retaining legacy message ${legacyId}: missing or incomplete lineage in database.`);
          continue;
        }

        if (lineage.isEligibleForTrash) {
          // Terminal lineage: mark read -> remove old Processed label -> Trash
          result.legacyProcessedTerminalEligible += 1;

          if (!dryRun) {
            try {
              await gmailClient.markRead(legacyId);
              if (lineage.id) {
                await pool.query(
                  `UPDATE raw_email_alerts SET marked_read_at = COALESCE(marked_read_at, NOW()) WHERE workspace_id = $1 AND id = $2`,
                  [ctx.workspaceId, lineage.id]
                );
              }
              await gmailClient.modifyMessageLabels(legacyId, {
                removeLabelIds: [legacyLabel.id],
              });
              await gmailClient.trashMessage(legacyId);
              if (lineage.id) {
                await pool.query(
                  `UPDATE raw_email_alerts SET lifecycle_status = 'TRASHED', trashed_at = NOW(), marked_read_at = COALESCE(marked_read_at, NOW()) WHERE workspace_id = $1 AND id = $2`,
                  [ctx.workspaceId, lineage.id]
                );
              }
              result.legacyProcessedTrashed += 1;
            } catch (err: any) {
              result.errors.push(`Failed to trash legacy terminal message ${legacyId}: ${err?.message || String(err)}`);
            }
          }
        } else {
          // Nonterminal lineage: remove old Processed label -> add Jobs-Alerts-In-Processing -> keep message in Gmail
          result.legacyProcessedToInProcessing += 1;

          if (!dryRun) {
            try {
              const inProc = inProcessingLabel || (await gmailClient.ensureLabel(inProcessingFolderName));
              await gmailClient.modifyMessageLabels(legacyId, {
                addLabelIds: [inProc.id],
                removeLabelIds: [legacyLabel.id],
              });
              if (lineage.id) {
                await pool.query(
                  `UPDATE raw_email_alerts SET lifecycle_status = 'IN_PROCESSING', in_processing_at = COALESCE(in_processing_at, NOW()) WHERE workspace_id = $1 AND id = $2`,
                  [ctx.workspaceId, lineage.id]
                );
              }
            } catch (err: any) {
              result.errors.push(`Failed to migrate legacy message ${legacyId} to in-processing: ${err?.message || String(err)}`);
            }
          }
        }
      }
    } catch (legacyErr: any) {
      console.warn("Legacy Processed migration inspection warning:", legacyErr?.message || legacyErr);
    }
  }

  return result;
}
