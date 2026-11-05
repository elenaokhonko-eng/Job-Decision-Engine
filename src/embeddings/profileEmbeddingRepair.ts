import crypto from "node:crypto";
import pg from "pg";
import { buildProfileFactInputText, buildEmbeddingInputs, hashText } from "./inputBuilder.js";
import { runEmbeddingBatch } from "./batchCoordinator.js";
import { getEmbeddingSpaceRegistryConfiguration } from "./spaceRegistry.js";
import { isProfileFactModelShareable } from "../profile/privacy.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

type Queryable = Pick<pg.PoolClient, "query">;

interface ProfileFactRow {
  id: string;
  embedding_node_id: string;
  fact_type: string;
  statement: string;
  structured_value: unknown;
  evidence_tier: string;
  confidentiality: string;
}

interface ExpectedProfileInput {
  sourceId: string;
  contentHash: string;
}

interface EmbeddingSpaceRow {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  normalization: string;
  distance_metric: string;
}

export type ProfileEmbeddingReadinessStatus =
  | "READY"
  | "NO_ACTIVE_PROFILE"
  | "AMBIGUOUS_ACTIVE_PROFILE"
  | "PRIMARY_SPACE_MISSING"
  | "PRIMARY_SPACE_AMBIGUOUS"
  | "PROFILE_FACTS_UNEMBEDDED";

export interface ProfileEmbeddingReadiness {
  status: ProfileEmbeddingReadinessStatus;
  activeProfileVersionId: string | null;
  activeProfileCount: number;
  expectedProfileFacts: number;
  embeddedProfileFacts: number;
  unembeddedProfileFacts: number;
  primarySpaceId: string | null;
  primarySpace: { provider: string; model: string; dimensions: number } | null;
  primarySpaceMatches: number;
  blockedProfileTasks: number;
}

export interface ProfileEmbeddingRepairResult extends ProfileEmbeddingReadiness {
  dryRun: boolean;
  profileInputsInserted: number;
  embeddingBatches: number;
  embeddingsPublished: number;
  blockedTasksReactivated: number;
}

function configuredPrimary(): { provider: string; model: string; dimensions: number } {
  const primary = getEmbeddingSpaceRegistryConfiguration().primary;
  return {
    provider: primary.provider.trim().toLowerCase(),
    model: primary.model.trim(),
    dimensions: primary.dimensions,
  };
}

async function listExpectedProfileInputs(
  client: Queryable,
  workspaceId: string,
  profileVersionId: string,
): Promise<ExpectedProfileInput[]> {
  const { rows } = await client.query<ProfileFactRow>(
    `SELECT pf.id::text AS id,
            COALESCE(pf.fact_revision_id, pf.id)::text AS embedding_node_id,
            pf.fact_type, pf.statement, pf.structured_value,
            pf.evidence_tier, pf.confidentiality
     FROM profile_facts pf
     WHERE pf.workspace_id = $1
       AND pf.profile_version_id = $2::uuid
       AND pf.fact_type <> 'CONTACT'
       AND pf.confidentiality IN ('PUBLIC', 'PRIVATE_REUSABLE')
     ORDER BY pf.created_at ASC, pf.id ASC`,
    [workspaceId, profileVersionId],
  );

  // Keep the same one-input-per-evidence-node behavior as buildEmbeddingInputs.
  // When a node has revisions in this profile version, the newest row wins.
  const bySourceId = new Map<string, ExpectedProfileInput>();
  for (const row of rows) {
    if (!isProfileFactModelShareable(row)) continue;
    const contentText = buildProfileFactInputText(row);
    bySourceId.set(row.embedding_node_id, {
      sourceId: row.embedding_node_id,
      contentHash: hashText(contentText),
    });
  }
  return [...bySourceId.values()];
}

async function listPrimarySpaces(
  client: Queryable,
  workspaceId: string,
  configured: ReturnType<typeof configuredPrimary>,
): Promise<EmbeddingSpaceRow[]> {
  const { rows } = await client.query<EmbeddingSpaceRow>(
    `SELECT id::text AS id, provider, model, dimensions, normalization, distance_metric
     FROM embedding_spaces
     WHERE workspace_id = $1
       AND active = TRUE
       AND is_fallback_space = FALSE
       AND LOWER(provider) = $2
       AND model = $3
       AND dimensions = $4
       AND normalization = 'L2'
       AND distance_metric = 'COSINE'
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, configured.provider, configured.model, configured.dimensions],
  );
  return rows;
}

async function inspectWithContext(
  client: Queryable,
  context: WorkspaceContext,
): Promise<{
  readiness: ProfileEmbeddingReadiness;
  expectedInputs: ExpectedProfileInput[];
}> {
  const configured = configuredPrimary();
  const [{ rows: profiles }, primarySpaces] = await Promise.all([
    client.query<{ id: string }>(
      `SELECT id::text AS id
       FROM profile_versions
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC, id ASC`,
      [context.workspaceId],
    ),
    listPrimarySpaces(client, context.workspaceId, configured),
  ]);

  const activeProfileVersionId = profiles.length === 1 ? profiles[0].id : null;
  const expectedInputs = activeProfileVersionId
    ? await listExpectedProfileInputs(client, context.workspaceId, activeProfileVersionId)
    : [];
  const selectedSpace = primarySpaces.length === 1 ? primarySpaces[0] : null;
  const inputBySourceId = new Map<string, { content_hash: string; published: boolean }>();

  if (selectedSpace && expectedInputs.length > 0) {
    const { rows: inputs } = await client.query<{
      source_id: string;
      content_hash: string;
      published: boolean;
    }>(
      `SELECT ei.source_id::text AS source_id,
              ei.content_hash,
              EXISTS (
                SELECT 1
                FROM v_published_semantic_embeddings se
                WHERE se.workspace_id = ei.workspace_id
                  AND se.embedding_space_id = $3::uuid
                  AND se.embedding_input_id = ei.id
              ) AS published
       FROM embedding_inputs ei
       WHERE ei.workspace_id = $1
         AND ei.source_type = 'PROFILE_FACT'
         AND ei.is_current = TRUE
         AND ei.source_id = ANY($2::uuid[])`,
      [context.workspaceId, expectedInputs.map((input) => input.sourceId), selectedSpace.id],
    );
    for (const input of inputs) inputBySourceId.set(input.source_id, input);
  }

  const embeddedProfileFacts = selectedSpace
    ? expectedInputs.filter((expected) => {
        const input = inputBySourceId.get(expected.sourceId);
        return input?.content_hash === expected.contentHash && input.published;
      }).length
    : 0;
  const unembeddedProfileFacts = expectedInputs.length - embeddedProfileFacts;
  const { rows: blockedRows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM pipeline_tasks
     WHERE workspace_id = $1
       AND status = 'BLOCKED_DEPENDENCY'
       AND blocked_on = 'PROFILE_VERSION_ACTIVE'
       AND repair_action = 'IMPORT_OR_ACTIVATE_PROFILE_AND_REPAIR_EMBEDDINGS'`,
    [context.workspaceId],
  );

  let status: ProfileEmbeddingReadinessStatus;
  if (profiles.length === 0) status = "NO_ACTIVE_PROFILE";
  else if (profiles.length > 1) status = "AMBIGUOUS_ACTIVE_PROFILE";
  else if (primarySpaces.length === 0) status = "PRIMARY_SPACE_MISSING";
  else if (primarySpaces.length > 1) status = "PRIMARY_SPACE_AMBIGUOUS";
  else if (unembeddedProfileFacts > 0) status = "PROFILE_FACTS_UNEMBEDDED";
  else status = "READY";

  return {
    readiness: {
      status,
      activeProfileVersionId,
      activeProfileCount: profiles.length,
      expectedProfileFacts: expectedInputs.length,
      embeddedProfileFacts,
      unembeddedProfileFacts,
      primarySpaceId: selectedSpace?.id ?? null,
      primarySpace: selectedSpace
        ? { provider: selectedSpace.provider, model: selectedSpace.model, dimensions: Number(selectedSpace.dimensions) }
        : null,
      primarySpaceMatches: primarySpaces.length,
      blockedProfileTasks: Number(blockedRows[0]?.count ?? 0),
    },
    expectedInputs,
  };
}

export async function inspectProfileEmbeddingReadiness(
  clientOrPool: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext },
): Promise<ProfileEmbeddingReadiness> {
  const isPool = typeof (clientOrPool as pg.Pool).connect === "function" && !("release" in clientOrPool);
  const client = isPool ? await (clientOrPool as pg.Pool).connect() : clientOrPool as pg.PoolClient;
  try {
    const context = options?.context ?? await resolveWorkspaceContext(client);
    return (await inspectWithContext(client, context)).readiness;
  } finally {
    if (isPool) client.release();
  }
}

export async function repairProfileEmbeddings(
  clientOrPool: pg.Pool | pg.PoolClient,
  options: { context?: WorkspaceContext; apply?: boolean; batchSize?: number } = {},
): Promise<ProfileEmbeddingRepairResult> {
  const isPool = typeof (clientOrPool as pg.Pool).connect === "function" && !("release" in clientOrPool);
  const client = isPool ? await (clientOrPool as pg.Pool).connect() : clientOrPool as pg.PoolClient;
  const dryRun = options.apply !== true;
  try {
    const context = options.context ?? await resolveWorkspaceContext(client);
    const before = await inspectWithContext(client, context);
    const baseResult = {
      ...before.readiness,
      dryRun,
      profileInputsInserted: 0,
      embeddingBatches: 0,
      embeddingsPublished: 0,
      blockedTasksReactivated: 0,
    };
    if (dryRun) return baseResult;

    if (!before.readiness.activeProfileVersionId) {
      throw new Error(`Profile embedding repair cannot apply: ${before.readiness.status}.`);
    }
    if (!before.readiness.primarySpaceId) {
      throw new Error(`Profile embedding repair cannot apply: ${before.readiness.status}.`);
    }
    const inputBuild = before.readiness.unembeddedProfileFacts > 0
      ? await buildEmbeddingInputs(client, Math.max(before.expectedInputs.length, 1), {
          context,
          profileVersionId: before.readiness.activeProfileVersionId,
          includeRequirements: false,
          includeProfileFacts: true,
          includeLanePrototypes: false,
          includeJobVersions: false,
        })
      : { fromProfileFacts: 0 };
    const { rows: missingInputRows } = before.expectedInputs.length > 0
      ? await client.query<{ id: string }>(
      `SELECT ei.id::text AS id
       FROM embedding_inputs ei
       WHERE ei.workspace_id = $1
         AND ei.source_type = 'PROFILE_FACT'
         AND ei.is_current = TRUE
         AND ei.source_id = ANY($2::uuid[])
         AND NOT EXISTS (
           SELECT 1
           FROM v_published_semantic_embeddings se
           WHERE se.workspace_id = ei.workspace_id
             AND se.embedding_space_id = $3::uuid
             AND se.embedding_input_id = ei.id
         )
       ORDER BY ei.created_at ASC, ei.id ASC`,
      [
        context.workspaceId,
        before.expectedInputs.map((input) => input.sourceId),
        before.readiness.primarySpaceId,
      ],
      )
      : { rows: [] as Array<{ id: string }> };

    const batchSize = Math.max(1, Math.min(Math.floor(options.batchSize ?? 50), 500));
    let embeddingBatches = 0;
    let embeddingsPublished = 0;
    for (let offset = 0; offset < missingInputRows.length; offset += batchSize) {
      const inputIds = missingInputRows.slice(offset, offset + batchSize).map((row) => row.id);
      const batch = await runEmbeddingBatch(
        before.readiness.primarySpaceId,
        `profile-repair-${crypto.randomUUID()}`,
        "PRIMARY",
        batchSize,
        inputIds,
        undefined,
        undefined,
        client,
        { context },
      );
      if (batch.failed > 0 || batch.succeeded !== inputIds.length) {
        throw new Error(
          `Primary profile embedding batch failed: expected=${inputIds.length}, succeeded=${batch.succeeded}, failed=${batch.failed}. ${batch.errors.join("; ")}`,
        );
      }
      if (batch.processed > 0) embeddingBatches += 1;
      embeddingsPublished += batch.succeeded;
    }

    const after = await inspectWithContext(client, context);
    if (after.readiness.status !== "READY") {
      throw new Error(
        `Profile embedding repair verification failed: status=${after.readiness.status}, unembedded=${after.readiness.unembeddedProfileFacts}.`,
      );
    }

    const { rows: reactivated } = await client.query<{ id: string }>(
      `UPDATE pipeline_tasks
       SET status = 'PENDING',
           available_at = NOW(),
           lease_id = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           claimed_by = NULL,
           last_error = NULL,
           blocked_on = NULL,
           blocked_reason = NULL,
           repair_action = NULL,
           completed_at = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND status = 'BLOCKED_DEPENDENCY'
         AND blocked_on = 'PROFILE_VERSION_ACTIVE'
         AND repair_action = 'IMPORT_OR_ACTIVATE_PROFILE_AND_REPAIR_EMBEDDINGS'
       RETURNING id::text AS id`,
      [context.workspaceId],
    );

    return {
      ...after.readiness,
      dryRun: false,
      profileInputsInserted: inputBuild.fromProfileFacts,
      embeddingBatches,
      embeddingsPublished,
      blockedTasksReactivated: reactivated.length,
    };
  } finally {
    if (isPool) client.release();
  }
}
