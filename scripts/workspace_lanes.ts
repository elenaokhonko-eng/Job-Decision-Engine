import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import dotenv from "dotenv";
import pg from "pg";
import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";
import { LaneFileConfigSchema, type LaneFileConfig } from "../src/lanes/contracts.js";
import { withMaximumAiInterpretationsPerRun } from "../src/lanes/evaluationBudgetConfig.js";
import {
  cloneLane,
  deactivateLane,
  listActiveLaneRevisions,
  upsertLaneRevision,
} from "../src/lanes/registry.js";


type LaneRegistryEntry = {
  lane_key: string;
  config_file: string;
  enabled_by_default?: boolean;
};

type LaneRegistryFile = {
  schema_version?: string;
  config_version?: string;
  lanes: LaneRegistryEntry[];
};

function parseYamlFile<T>(filePath: string): T {
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(fs.readFileSync(filePath, "utf-8")) as T;
}

function dumpYaml(value: unknown): string {
  const dumpFn = (yaml as any).dump || (yaml as any).default?.dump || yaml;
  return dumpFn(value, { lineWidth: 120 }) as string;
}

async function cmdImport(pool: pg.Pool): Promise<void> {
  const ctx = await resolveWorkspaceContext(pool as any);
  const registryPath = path.resolve(process.cwd(), "config", "lanes", "registry.yml");
  const registry = parseYamlFile<LaneRegistryFile>(registryPath);
  let imported = 0;

  for (const entry of registry.lanes || []) {
    if (entry.enabled_by_default === false) {
      continue;
    }

    const lanePath = path.resolve(process.cwd(), "config", "lanes", entry.config_file);
    const laneConfig = LaneFileConfigSchema.parse(parseYamlFile<LaneFileConfig>(lanePath));

    await upsertLaneRevision(
      { laneKey: entry.lane_key, content: laneConfig },
      pool,
      { context: ctx, note: `import from ${entry.config_file}` }
    );
    imported += 1;
  }

  console.log(`Imported/activated ${imported} lane revision(s) into workspace ${ctx.workspaceKey}.`);
}

async function cmdExport(pool: pg.Pool): Promise<void> {
  const ctx = await resolveWorkspaceContext(pool as any);
  const lanes = await listActiveLaneRevisions(pool, { context: ctx });

  const payload = {
    schema_version: "2.2.0",
    exported_at: new Date().toISOString(),
    workspace_key: ctx.workspaceKey,
    lanes: lanes.map((lane) => ({
      lane_key: lane.laneKey,
      revision_number: lane.revisionNumber,
      content_hash: lane.contentHash,
      activated_at: lane.activatedAt,
      content: lane.content,
    })),
  };

  process.stdout.write(dumpYaml(payload));
}

async function cmdClone(pool: pg.Pool, fromLaneKey?: string, toLaneKey?: string): Promise<void> {
  if (!fromLaneKey || !toLaneKey) {
    throw new Error("clone requires FROM_LANE_KEY and TO_LANE_KEY arguments.");
  }
  const ctx = await resolveWorkspaceContext(pool as any);
  const result = await cloneLane(fromLaneKey, toLaneKey, pool, { context: ctx });
  console.log(
    `Cloned lane ${fromLaneKey} -> ${toLaneKey}. Revision ${result.revisionNumber} (hash ${result.contentHash.slice(0, 12)}...).`
  );
}

async function cmdDeactivate(pool: pg.Pool, laneKey?: string): Promise<void> {
  if (!laneKey) {
    throw new Error("deactivate requires a LANE_KEY argument.");
  }
  const ctx = await resolveWorkspaceContext(pool as any);
  const changed = await deactivateLane(laneKey, pool, { context: ctx });
  console.log(changed ? `Deactivated lane ${laneKey}.` : `Lane ${laneKey} already inactive or missing.`);
}

async function cmdSetPreference(
  pool: pg.Pool,
  laneKey?: string,
  rankRaw?: string,
  enabledRaw?: string
): Promise<void> {
  if (!laneKey || !rankRaw) {
    throw new Error("set-pref requires LANE_KEY and PRIORITY_RANK arguments.");
  }
  const priorityRank = Number(rankRaw);
  if (!Number.isFinite(priorityRank) || priorityRank < 0) {
    throw new Error(`Invalid PRIORITY_RANK: ${rankRaw}`);
  }
  const enabled = enabledRaw ? enabledRaw.toLowerCase() !== "false" : true;

  const ctx = await resolveWorkspaceContext(pool as any);
  const identityRes = await pool.query<{ id: string }>(
    `SELECT id
     FROM lane_identities
     WHERE workspace_id = $1 AND lane_key = $2
     LIMIT 1`,
    [ctx.workspaceId, laneKey]
  );
  if (identityRes.rows.length === 0) {
    throw new Error(`Lane identity not found for key ${laneKey}. Import/seed lanes first.`);
  }
  const laneIdentityId = identityRes.rows[0].id;

  await pool.query(
    `
      INSERT INTO workspace_lane_preferences (
        workspace_id,
        workspace_user_id,
        lane_identity_id,
        enabled,
        priority_rank,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (workspace_user_id, lane_identity_id)
      DO UPDATE SET
        enabled = EXCLUDED.enabled,
        priority_rank = EXCLUDED.priority_rank,
        updated_at = NOW()
    `,
    [ctx.workspaceId, ctx.userId, laneIdentityId, enabled, priorityRank]
  );

  console.log(
    `Set preference for ${laneKey}: enabled=${enabled} priority_rank=${priorityRank} (user ${ctx.userKey}, workspace ${ctx.workspaceKey}).`
  );
}

export interface SetLaneBudgetChange {
  laneKey: string;
  activeRevision: number;
  previousMaximumAiInterpretationsPerRun: number;
  nextMaximumAiInterpretationsPerRun: number;
  changed: boolean;
  /** Set when applied: the revision now active for the lane. */
  appliedRevision?: number;
  /**
   * Set when applied: whether the new revision has the same routing content as the one it
   * replaced. A budget-only change always keeps routing content, so jobs already routed stay
   * eligible for AI enqueue (see migrations/101_lane_revision_routing_content_hash.sql).
   */
  routingContentUnchanged?: boolean;
}

export interface SetLaneBudgetResult {
  mode: "APPLY" | "DRY_RUN";
  workspace: string;
  target: string;
  maximumAiInterpretationsPerRun: number;
  changes: SetLaneBudgetChange[];
}

/**
 * Sets maximum_ai_interpretations_per_run for one lane or all lanes. Applying it activates a new
 * lane revision per changed lane (revisions stay the audit trail of every budget), whose
 * routing_content_hash equals the previous revision's, so existing lane routing stays current.
 */
export async function setLaneBudget(
  clientOrPool: pg.Pool | pg.PoolClient,
  laneKeyArg: string | undefined,
  budgetRaw: string | undefined,
  options: { apply: boolean; context?: WorkspaceContext },
): Promise<SetLaneBudgetResult> {
  if (!laneKeyArg || !budgetRaw) {
    throw new Error("set-budget requires a LANE_KEY or 'all', and MAXIMUM_PER_RUN.");
  }
  const maximum = Number(budgetRaw);
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1000) {
    throw new Error("MAXIMUM_PER_RUN must be an integer from 0 to 1000.");
  }

  const ctx = options.context ?? await resolveWorkspaceContext(clientOrPool as any);
  const active = await listActiveLaneRevisions(clientOrPool, { context: ctx });
  const laneKey = laneKeyArg.toUpperCase();
  const targets = laneKey === "ALL" ? active : active.filter((lane) => lane.laneKey === laneKey);
  if (targets.length === 0) {
    throw new Error(laneKey === "ALL"
      ? "No active lane revisions found for this workspace."
      : `No active lane revision found for ${laneKey}.`);
  }

  const result: SetLaneBudgetResult = {
    mode: options.apply ? "APPLY" : "DRY_RUN",
    workspace: ctx.workspaceKey,
    target: laneKey,
    maximumAiInterpretationsPerRun: maximum,
    changes: [],
  };
  for (const lane of targets) {
    const previous = lane.content.budget?.maximum_ai_interpretations_per_run ?? 0;
    const change: SetLaneBudgetChange = {
      laneKey: lane.laneKey,
      activeRevision: lane.revisionNumber,
      previousMaximumAiInterpretationsPerRun: previous,
      nextMaximumAiInterpretationsPerRun: maximum,
      changed: previous !== maximum,
    };
    if (options.apply && change.changed) {
      const applied = await upsertLaneRevision({
        laneKey: lane.laneKey,
        content: withMaximumAiInterpretationsPerRun(lane.content, maximum),
      }, clientOrPool, {
        context: ctx,
        note: `Set maximum AI interpretations per run to ${maximum}.`,
      });
      change.appliedRevision = applied.revisionNumber;
      change.routingContentUnchanged = applied.routingContentHash === lane.routingContentHash;
      if (!change.routingContentUnchanged) {
        throw new Error(
          `Budget change for ${lane.laneKey} altered its routing content; refusing to continue. ` +
            "Revision " + String(applied.revisionNumber) + " is active; inspect it before retrying."
        );
      }
    }
    result.changes.push(change);
  }
  return result;
}

async function cmdSetBudget(
  pool: pg.Pool,
  laneKeyArg?: string,
  budgetRaw?: string,
): Promise<void> {
  const result = await setLaneBudget(pool, laneKeyArg, budgetRaw, {
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
  for (const change of result.changes) {
    if (change.appliedRevision === undefined) continue;
    console.log(
      `Activated ${change.laneKey} lane revision ${change.appliedRevision} (budget only; routing content unchanged).`
    );
  }
}

async function main(): Promise<void> {
  // Loaded here, not at import time, so importing setLaneBudget never rewrites the environment.
  dotenv.config();
  dotenv.config({ path: ".env.local", override: true });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));

  try {
    const cmd = (process.argv[2] || "import").toLowerCase();

    if (cmd === "import") {
      await cmdImport(pool);
      return;
    }
    if (cmd === "export") {
      await cmdExport(pool);
      return;
    }
    if (cmd === "clone") {
      await cmdClone(pool, process.argv[3], process.argv[4]);
      return;
    }
    if (cmd === "deactivate") {
      await cmdDeactivate(pool, process.argv[3]);
      return;
    }
    if (cmd === "set-pref") {
      await cmdSetPreference(pool, process.argv[3], process.argv[4], process.argv[5]);
      return;
    }
    if (cmd === "set-budget") {
      await cmdSetBudget(pool, process.argv[3], process.argv[4]);
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes("workspace_lanes")) {
  main().catch((err) => {
    console.error("workspace_lanes failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
