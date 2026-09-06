import pg from "pg";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

export type RequirementImportance = "MUST" | "PREFERRED" | "NICE_TO_HAVE";
export type MatchType = "EXACT" | "SEMANTIC" | "NO_MATCH" | "UNKNOWN";

export interface RequirementMatchRow {
  requirement_id: string;
  requirement_key: string;
  importance: RequirementImportance;
  requirement_text: string;
  profile_fact_id: string | null;
  match_type: MatchType;
  match_score: number;
}

export interface SelectedRequirementClaim {
  requirementId: string;
  requirementKey: string;
  importance: RequirementImportance;
  requirementText: string;
  profileFactIds: string[];
  matchType: MatchType;
  matchScore: number;
}

function importanceRank(value: RequirementImportance): number {
  if (value === "MUST") return 0;
  if (value === "PREFERRED") return 1;
  return 2;
}

function matchRank(value: MatchType): number {
  if (value === "EXACT") return 0;
  if (value === "SEMANTIC") return 1;
  if (value === "UNKNOWN") return 2;
  return 3;
}

export function selectCoverLetterClaimPlan(
  rows: RequirementMatchRow[],
  options?: { maxRequirements?: number }
): SelectedRequirementClaim[] {
  const maxRequirements = options?.maxRequirements ?? 3;

  const eligible = rows.filter(
    (row) =>
      !!row.profile_fact_id &&
      row.match_type !== "NO_MATCH" &&
      row.match_type !== "UNKNOWN" &&
      Number(row.match_score) > 0
  );

  eligible.sort((a, b) => {
    const imp = importanceRank(a.importance) - importanceRank(b.importance);
    if (imp !== 0) return imp;
    const mt = matchRank(a.match_type) - matchRank(b.match_type);
    if (mt !== 0) return mt;
    return Number(b.match_score) - Number(a.match_score);
  });

  const seenRequirements = new Set<string>();
  const result: SelectedRequirementClaim[] = [];
  for (const row of eligible) {
    if (result.length >= maxRequirements) break;
    if (seenRequirements.has(row.requirement_id)) continue;
    seenRequirements.add(row.requirement_id);
    result.push({
      requirementId: row.requirement_id,
      requirementKey: row.requirement_key,
      importance: row.importance,
      requirementText: row.requirement_text,
      profileFactIds: row.profile_fact_id ? [row.profile_fact_id] : [],
      matchType: row.match_type,
      matchScore: Number(row.match_score),
    });
  }

  return result;
}

export async function loadRequirementMatchesForJobVersion(
  jobVersionId: string,
  matchRunId: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<RequirementMatchRow[]> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const res = await client.query<RequirementMatchRow>(
      `
        SELECT
          jr.id AS requirement_id,
          jr.requirement_key,
          jr.importance,
          jr.requirement_text,
          rem.profile_fact_id,
          rem.match_type,
          rem.match_score
        FROM requirement_evidence_matches rem
        JOIN job_requirements jr
          ON jr.workspace_id = rem.workspace_id
         AND jr.id = rem.requirement_id
        WHERE rem.workspace_id = $1
          AND rem.match_run_id = $2
          AND jr.job_version_id = $3
        ORDER BY jr.created_at ASC
      `,
      [ctx.workspaceId, matchRunId, jobVersionId]
    );
    return res.rows.map((row) => ({
      ...row,
      match_score: Number(row.match_score),
    }));
  } catch (error: any) {
    if (error?.code === "42P01") {
      return [];
    }
    throw error;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}

export async function loadProfileFactsByIds(
  profileFactIds: string[],
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<Array<{ id: string; fact_type: string; statement: string; evidence_tier: string; verification_status: string }>> {
  if (profileFactIds.length === 0) {
    return [];
  }

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
    const res = await client.query<{
      id: string;
      fact_type: string;
      statement: string;
      evidence_tier: string;
      verification_status: string;
    }>(
      `
        SELECT id, fact_type, statement, evidence_tier, verification_status
        FROM profile_facts
        WHERE workspace_id = $1
          AND id = ANY($2::uuid[])
      `,
      [ctx.workspaceId, profileFactIds]
    );

    return res.rows;
  } catch (error: any) {
    if (error?.code === "42P01") {
      return [];
    }
    throw error;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as any).release();
    }
  }
}
