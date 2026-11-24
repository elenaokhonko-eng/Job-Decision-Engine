/**
 * Gate-owned write for "the posting or feed contradicts a known work fact": the job is flagged NEEDS_VERIFICATION, with the
 * evidence stored. It is not a re-gate and never a rejection.
 *
 *  - Writes canonical_jobs (gate_decision, rejection_reason, gate_evidence_quotes, workability_facts) and the same immutable
 *    gate_decisions audit row the gate itself writes, so verificationQuestionService finds the question from the codes and
 *    quotes, exactly as for a gate NEEDS_VERIFICATION.
 *  - Idempotent: the same code with the same quote on the current gate decision is reported as ALREADY_FLAGGED.
 *  - No-op for a hard-rejected, manually removed, archived or never-gated (RAW_STAGED) job, and for a job without a job version.
 *  - A job already past matching keeps its processing state: QUEUED_FOR_AI, EVALUATING, AI_EVALUATED, EVALUATED, DEFERRED_BUDGET
 *    and NEEDS_MANUAL_REVIEW are not moved (an in-flight or finished evaluation is not disturbed); gate_decision and the audit
 *    row carry the flag and the decider treats the job as NEEDS_VERIFICATION. Earlier states move to NEEDS_VERIFICATION.
 *  - A later normal re-gate writes its own result; the flag is replaced only when the gate itself no longer needs verification.
 *
 * The caller owns the transaction (the availability recheck calls this inside its own).
 */
import crypto from "node:crypto";
import type pg from "pg";

import { GATE_VERSION } from "../contracts/version.js";

type Queryable = Pick<pg.PoolClient, "query">;

export const FLAGGABLE_REASON_CODES = ["GATE_UNKNOWN_WORK_MODE", "NEEDS_VERIFICATION_LOCATION_DETAIL"] as const;
export type FlagReasonCode = (typeof FLAGGABLE_REASON_CODES)[number];

export interface FlagNeedsVerificationInput {
  workspaceId: string;
  jobId: string;
  reasonCode: FlagReasonCode;
  evidence: {
    /** The posting or feed words that contradict the known fact. Required: the question shows it. */
    quote: string;
    /** Where the contradiction was read (for example RECHECK_AVAILABILITY). */
    source?: string;
    /** Structured facts recorded with the conflict (known value, value seen now). */
    facts?: Record<string, unknown>;
  };
}

export type FlagNeedsVerificationResult =
  | { applied: true; stateKept: boolean; gateDecisionId: string }
  | { applied: false; reason: "NOT_FOUND" | "ARCHIVED" | "HARD_REJECTED" | "MANUALLY_REMOVED" | "RAW_STAGED" | "NO_JOB_VERSION" | "ALREADY_FLAGGED" };

/** States past matching: the flag is recorded but the processing state is left alone. */
const STATES_KEPT = new Set(["QUEUED_FOR_AI", "EVALUATING", "AI_EVALUATED", "EVALUATED", "DEFERRED_BUDGET", "NEEDS_MANUAL_REVIEW"]);

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim() !== ""))];
}

export async function flagNeedsVerification(
  client: Queryable,
  input: FlagNeedsVerificationInput,
): Promise<FlagNeedsVerificationResult> {
  if (!FLAGGABLE_REASON_CODES.includes(input.reasonCode)) {
    throw new Error(`flagNeedsVerification: ${String(input.reasonCode)} is not a flaggable reason code.`);
  }
  const quote = input.evidence.quote.trim();
  if (!quote) throw new Error("flagNeedsVerification: evidence.quote is required.");

  const { rows } = await client.query<{
    archived_at: string | null;
    gate_decision: string | null;
    state: string | null;
    latest_job_version_id: string | null;
    workability_facts: Record<string, unknown> | null;
    gate_evidence_quotes: unknown;
  }>(
    `SELECT archived_at, gate_decision, COALESCE(processing_state, processing_status) AS state,
            latest_job_version_id, workability_facts, gate_evidence_quotes
       FROM canonical_jobs
      WHERE workspace_id = $1 AND id = $2
      FOR UPDATE`,
    [input.workspaceId, input.jobId],
  );
  const job = rows[0];
  if (!job) return { applied: false, reason: "NOT_FOUND" };
  if (job.archived_at) return { applied: false, reason: "ARCHIVED" };
  if (job.gate_decision === "HARD_REJECT" || job.state === "HARD_REJECTED") return { applied: false, reason: "HARD_REJECTED" };
  if (job.state === "MANUALLY_REMOVED") return { applied: false, reason: "MANUALLY_REMOVED" };
  if (job.state === "RAW_STAGED" || job.gate_decision === null) return { applied: false, reason: "RAW_STAGED" };
  if (!job.latest_job_version_id) return { applied: false, reason: "NO_JOB_VERSION" };

  const previous = (await client.query<{
    decision: string;
    rejection_codes: unknown;
    evidence_quotes: unknown;
    workability_policy_hash: string | null;
  }>(
    `SELECT decision, rejection_codes, evidence_quotes, workability_policy_hash
       FROM gate_decisions
      WHERE workspace_id = $1 AND canonical_job_id = $2 AND job_version_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [input.workspaceId, input.jobId, job.latest_job_version_id],
  )).rows[0];

  const previousCodes = Array.isArray(previous?.rejection_codes) ? uniqueStrings(previous.rejection_codes) : [];
  const previousQuotes = Array.isArray(previous?.evidence_quotes) ? uniqueStrings(previous.evidence_quotes) : [];
  if (previous?.decision === "NEEDS_VERIFICATION" && previousCodes.includes(input.reasonCode) && previousQuotes.includes(quote)) {
    return { applied: false, reason: "ALREADY_FLAGGED" };
  }

  const codes = uniqueStrings([...(previous?.decision === "NEEDS_VERIFICATION" ? previousCodes : []), input.reasonCode, "NEEDS_VERIFICATION"]);
  const currentQuotes = Array.isArray(job.gate_evidence_quotes) ? uniqueStrings(job.gate_evidence_quotes) : [];
  const quotes = uniqueStrings([...currentQuotes, quote]);
  const facts = {
    ...(job.workability_facts ?? {}),
    facts_conflict: {
      reason_code: input.reasonCode,
      source: input.evidence.source ?? null,
      facts: input.evidence.facts ?? null,
      recorded_at: new Date().toISOString(),
    },
  };
  const stateKept = job.state !== null && STATES_KEPT.has(job.state);

  await client.query(
    `UPDATE canonical_jobs
        SET gate_decision = 'NEEDS_VERIFICATION',
            rejection_reason = $3,
            gate_evidence_quotes = $4::jsonb,
            workability_facts = $5::jsonb,
            processing_state = CASE WHEN $6::boolean THEN processing_state ELSE 'NEEDS_VERIFICATION' END,
            processing_status = CASE WHEN $6::boolean THEN processing_status ELSE 'NEEDS_VERIFICATION' END,
            updated_at = NOW()
      WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL`,
    [input.workspaceId, input.jobId, codes.join(", "), JSON.stringify(quotes), JSON.stringify(facts), stateKept],
  );
  const audit = await client.query<{ id: string }>(
    `INSERT INTO gate_decisions (
       workspace_id, canonical_job_id, job_version_id, pipeline_run_id, gate_version, workability_policy_hash,
       decision, rejection_codes, evidence_quotes, workability_facts
     ) VALUES ($1, $2, $3, $4, $5, $6, 'NEEDS_VERIFICATION', $7::jsonb, $8::jsonb, $9::jsonb)
     RETURNING id`,
    [
      input.workspaceId,
      input.jobId,
      job.latest_job_version_id,
      crypto.randomUUID(),
      GATE_VERSION,
      previous?.workability_policy_hash ?? null,
      JSON.stringify(codes),
      JSON.stringify(quotes),
      JSON.stringify(facts),
    ],
  );
  return { applied: true, stateKept, gateDecisionId: audit.rows[0]!.id };
}
