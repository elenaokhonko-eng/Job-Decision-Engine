import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface VerificationQuestionSummary {
  discoveredPendingJobs: number;
  generatedQuestions: number;
  topQuestions: Array<{
    questionKey: string;
    category: string;
    questionText: string;
    impactJobCount: number;
    suggestedOptions: string[];
    linkedJobIds?: string[];
  }>;
}

export interface VerificationQuestionRow {
  id: string;
  workspace_id: string;
  question_key: string;
  category: string;
  question_text: string;
  impact_job_count: number;
  suggested_options: unknown;
  linked_job_ids?: string[] | null;
  status: "PENDING" | "ANSWERED" | "DISMISSED";
  answer_value: unknown;
  answered_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function aggregateVerificationQuestions(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext; maxQuestions?: number }
): Promise<VerificationQuestionSummary> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const maxQuestions = options?.maxQuestions ?? 5;

    // Discover jobs currently in NEEDS_VERIFICATION with authoritative quotes and rejection codes
    const { rows: verificationJobs } = await client.query<{
      id: string;
      title: string;
      workplace_type: string;
      gate_decision: string | null;
      rejection_reason: string | null;
      rejection_reason_codes: string[] | null;
      evidence_quotes: string[] | null;
    }>(
      `SELECT c.id, c.normalized_title AS title, c.workplace_type,
              c.gate_decision, c.rejection_reason,
              c.gate_evidence_quotes AS evidence_quotes,
              COALESCE(gd.rejection_codes, '[]'::jsonb) AS rejection_reason_codes
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT rejection_codes
         FROM gate_decisions
         WHERE canonical_job_id = c.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) gd ON TRUE
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) = 'NEEDS_VERIFICATION'
       ORDER BY c.created_at DESC`,
      [ctx.workspaceId]
    );

    const countsByCategory: Record<string, { count: number; sampleQuotes: string[]; jobIds: string[] }> = {
      WORKPLACE_MODEL: { count: 0, sampleQuotes: [], jobIds: [] },
      DEGREE_SUBJECT: { count: 0, sampleQuotes: [], jobIds: [] },
      WORK_AUTH: { count: 0, sampleQuotes: [], jobIds: [] },
      EXPERIENCE_SCOPE: { count: 0, sampleQuotes: [], jobIds: [] },
      TRAVEL_PREFERENCE: { count: 0, sampleQuotes: [], jobIds: [] },
    };

    for (const job of verificationJobs) {
      const codes = (job.rejection_reason_codes || []).join(" ").toUpperCase();
      const quotes = Array.isArray(job.evidence_quotes)
        ? job.evidence_quotes.join(" ")
        : String(job.evidence_quotes || "");

      if (codes.includes("OFFICE_DAYS") || codes.includes("WORKPLACE") || /office|hybrid/i.test(quotes)) {
        countsByCategory.WORKPLACE_MODEL.count++;
        countsByCategory.WORKPLACE_MODEL.jobIds.push(job.id);
        if (countsByCategory.WORKPLACE_MODEL.sampleQuotes.length < 3 && quotes) {
          countsByCategory.WORKPLACE_MODEL.sampleQuotes.push(quotes);
        }
      } else if (codes.includes("DEGREE") || /degree|major/i.test(quotes)) {
        countsByCategory.DEGREE_SUBJECT.count++;
        countsByCategory.DEGREE_SUBJECT.jobIds.push(job.id);
        if (countsByCategory.DEGREE_SUBJECT.sampleQuotes.length < 3 && quotes) {
          countsByCategory.DEGREE_SUBJECT.sampleQuotes.push(quotes);
        }
      } else if (codes.includes("WORK_AUTH") || /authorization|visa|citizen|pr\b/i.test(quotes)) {
        countsByCategory.WORK_AUTH.count++;
        countsByCategory.WORK_AUTH.jobIds.push(job.id);
        if (countsByCategory.WORK_AUTH.sampleQuotes.length < 3 && quotes) {
          countsByCategory.WORK_AUTH.sampleQuotes.push(quotes);
        }
      } else if (codes.includes("TRAVEL") || /travel|relocat/i.test(quotes)) {
        countsByCategory.TRAVEL_PREFERENCE.count++;
        countsByCategory.TRAVEL_PREFERENCE.jobIds.push(job.id);
        if (countsByCategory.TRAVEL_PREFERENCE.sampleQuotes.length < 3 && quotes) {
          countsByCategory.TRAVEL_PREFERENCE.sampleQuotes.push(quotes);
        }
      } else if (codes.includes("EXPERIENCE") || /experience/i.test(quotes)) {
        countsByCategory.EXPERIENCE_SCOPE.count++;
        countsByCategory.EXPERIENCE_SCOPE.jobIds.push(job.id);
        if (countsByCategory.EXPERIENCE_SCOPE.sampleQuotes.length < 3 && quotes) {
          countsByCategory.EXPERIENCE_SCOPE.sampleQuotes.push(quotes);
        }
      } else {
        countsByCategory.WORKPLACE_MODEL.count++;
        countsByCategory.WORKPLACE_MODEL.jobIds.push(job.id);
      }
    }

    const questionTemplates: Record<
      string,
      { key: string; question: string; options: string[] }
    > = {
      WORKPLACE_MODEL: {
        key: "workplace_hybrid_office_days_allowed",
        question:
          "For hybrid roles with unstated office days, what is the maximum number of in-office days per week you accept?",
        options: ["1 day/week", "2 days/week (Recommended)", "3 days/week", "Fully Remote Only"],
      },
      DEGREE_SUBJECT: {
        key: "profile_degree_subjects",
        question:
          "What academic degree subjects or equivalent quantitative backgrounds should be recognized for degree requirements?",
        options: [
          "Computer Science / Software Engineering",
          "Data Science / Analytics",
          "Mathematics / Statistics",
          "Electrical / Systems Engineering",
          "Physics / Computational Science",
        ],
      },
      WORK_AUTH: {
        key: "work_authorization_jurisdictions",
        question:
          "Which work authorization regions and visa statuses apply to your profile?",
        options: [
          "Singapore Citizen / PR (Recommended)",
          "Singapore Employment Pass / S Pass Eligible",
          "US Citizen / Green Card",
          "UK / EU Settlement",
          "Worldwide Remote / Contractor",
        ],
      },
      EXPERIENCE_SCOPE: {
        key: "experience_equivalent_domains",
        question:
          "Which related domains should count toward specialized experience years (e.g. AI/ML, Data Engineering, Software Architecture)?",
        options: [
          "All Software & Data Architecture",
          "AI, Machine Learning & LLM Systems",
          "Full-Stack & Backend Systems",
        ],
      },
      TRAVEL_PREFERENCE: {
        key: "lifestyle_travel_percentage_cap",
        question: "What is your maximum acceptable business travel percentage?",
        options: ["0% (No travel)", "Up to 10%", "Up to 25%", "Up to 50%"],
      },
    };

    const topList = Object.entries(countsByCategory)
      .filter(([_, data]) => data.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, maxQuestions)
      .map(([category, data]) => {
        const tmpl = questionTemplates[category];
        return {
          questionKey: tmpl.key,
          category,
          questionText: tmpl.question,
          impactJobCount: data.count,
          suggestedOptions: tmpl.options,
          linkedJobIds: data.jobIds,
        };
      });

    for (const q of topList) {
      await client.query(
        `INSERT INTO verification_questions (
           workspace_id, question_key, category, question_text,
           impact_job_count, suggested_options, linked_job_ids, status, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'PENDING', NOW())
         ON CONFLICT (workspace_id, question_key)
         DO UPDATE SET
           impact_job_count = EXCLUDED.impact_job_count,
           question_text = EXCLUDED.question_text,
           suggested_options = EXCLUDED.suggested_options,
           linked_job_ids = EXCLUDED.linked_job_ids,
           updated_at = NOW()
         WHERE verification_questions.status = 'PENDING'`,
        [
          ctx.workspaceId,
          q.questionKey,
          q.category,
          q.questionText,
          q.impactJobCount,
          JSON.stringify(q.suggestedOptions),
          JSON.stringify(q.linkedJobIds),
        ]
      );
    }

    return {
      discoveredPendingJobs: verificationJobs.length,
      generatedQuestions: topList.length,
      topQuestions: topList,
    };
  } finally {
    if (ownsClient && typeof client.release === "function") {
      client.release();
    }
  }
}

export async function getPendingVerificationQuestions(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<VerificationQuestionRow[]> {
  const pool = clientOrPool || defaultPool;
  const ctx = options?.context ?? (await resolveWorkspaceContext(pool as any));
  const { rows } = await pool.query<VerificationQuestionRow>(
    `SELECT *
     FROM verification_questions
     WHERE workspace_id = $1
       AND status = 'PENDING'
     ORDER BY impact_job_count DESC, created_at ASC`,
    [ctx.workspaceId]
  );
  return rows;
}

export async function answerVerificationQuestion(
  clientOrPool: pg.Pool | pg.PoolClient,
  questionKey: string,
  answer: unknown,
  options?: { context?: WorkspaceContext }
): Promise<{ ok: boolean; resumedJobCount: number }> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const normalizedKey = String(questionKey || "").trim();

    await client.query("BEGIN");
    try {
      const qRes = await client.query<VerificationQuestionRow>(
        `SELECT *
         FROM verification_questions
         WHERE workspace_id = $1 AND question_key = $2
         FOR UPDATE`,
        [ctx.workspaceId, normalizedKey]
      );

      if (qRes.rows.length === 0) {
        throw new Error(`Verification question '${normalizedKey}' not found.`);
      }

      const question = qRes.rows[0];
      const linkedIds = Array.isArray(question.linked_job_ids) ? question.linked_job_ids : [];

      await client.query(
        `UPDATE verification_questions
         SET status = 'ANSWERED',
             answer_value = $3::jsonb,
             answered_at = NOW(),
             updated_at = NOW()
         WHERE workspace_id = $1 AND question_key = $2`,
        [ctx.workspaceId, normalizedKey, JSON.stringify(answer)]
      );

      let resumedCount = 0;
      if (linkedIds.length > 0) {
        const updateRes = await client.query(
          `UPDATE canonical_jobs
           SET processing_state = 'RAW_STAGED',
               processing_status = 'RAW_STAGED',
               gate_decision = NULL,
               rejection_reason = NULL,
               gate_evidence_quotes = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1
             AND id = ANY($2::uuid[])
             AND COALESCE(processing_state, processing_status) = 'NEEDS_VERIFICATION'`,
          [ctx.workspaceId, linkedIds]
        );
        resumedCount = updateRes.rowCount ?? 0;
      }

      await client.query("COMMIT");
      return { ok: true, resumedJobCount: resumedCount };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    if (ownsClient && typeof client.release === "function") {
      client.release();
    }
  }
}

export async function dismissVerificationQuestion(
  clientOrPool: pg.Pool | pg.PoolClient,
  questionKey: string,
  options?: { context?: WorkspaceContext }
): Promise<{ ok: boolean }> {
  const pool = clientOrPool || defaultPool;
  const ctx = options?.context ?? (await resolveWorkspaceContext(pool as any));
  const normalizedKey = String(questionKey || "").trim();
  await pool.query(
    `UPDATE verification_questions
     SET status = 'DISMISSED',
         updated_at = NOW()
     WHERE workspace_id = $1 AND question_key = $2`,
    [ctx.workspaceId, normalizedKey]
  );
  return { ok: true };
}
