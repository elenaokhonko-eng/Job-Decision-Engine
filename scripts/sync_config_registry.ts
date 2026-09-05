import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import { pgSslConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext } from '../src/workspace/context.js';
import { loadStructuredFile } from '../src/config/structuredLoader.js';
import { upsertConfigRevision } from '../src/config/registry.js';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const databaseUrl = process.env.DATABASE_URL;

const SourcesFileSchema = z
  .object({
    version: z.string().optional(),
    sources: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string(),
          })
          .passthrough()
      )
      .default([]),
  })
  .passthrough();

const LaneRegistryEntrySchema = z
  .object({
    lane_key: z.string(),
    config_file: z.string(),
    enabled_by_default: z.boolean().optional(),
  })
  .passthrough();

const LaneRegistrySchema = z
  .object({
    schema_version: z.string().optional(),
    config_version: z.string().optional(),
    lanes: z.array(LaneRegistryEntrySchema),
  })
  .passthrough();

const LaneFileSchema = z
  .object({
    schema_version: z.string().optional(),
    lane_key: z.string(),
    display_name: z.string(),
    description: z.string(),
  })
  .passthrough();

const EvidenceStrengthPolicySchema = z
  .object({
    schema_version: z.string().optional(),
    policy_key: z.string().optional(),
    evidence_tier_weights: z.record(z.number()).default({}),
    verification_status_weights: z.record(z.number()).default({}),
    hours_per_week_band_weights: z.record(z.number()).default({}),
  })
  .passthrough();

async function main(): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: pgSslConfig(databaseUrl),
  });

  try {
    const ctx = await resolveWorkspaceContext(pool as any);

    const sourcesPath = path.resolve(process.cwd(), 'config', 'sources.yml');
    const sources = await loadStructuredFile(sourcesPath, SourcesFileSchema);
    const sourcesRes = await upsertConfigRevision(
      {
        configKey: 'sources',
        configType: 'SOURCES',
        description: 'config/sources.yml',
        schemaVersion: sources.data.version ?? '2.2.0',
        content: sources.data,
      },
      pool,
      {
        context: ctx,
        note: `sync from ${sourcesPath}`,
      }
    );

    const laneRegistryPath = path.resolve(process.cwd(), 'config', 'lanes', 'registry.yml');
    const laneRegistry = await loadStructuredFile(laneRegistryPath, LaneRegistrySchema);
    const registryRes = await upsertConfigRevision(
      {
        configKey: 'lanes_registry',
        configType: 'LANES_REGISTRY',
        description: 'config/lanes/registry.yml',
        schemaVersion: laneRegistry.data.config_version ?? laneRegistry.data.schema_version ?? '2.2.0',
        content: laneRegistry.data,
      },
      pool,
      {
        context: ctx,
        note: `sync from ${laneRegistryPath}`,
      }
    );

    let laneCount = 0;
    for (const entry of laneRegistry.data.lanes) {
      const lanePath = path.resolve(process.cwd(), 'config', 'lanes', entry.config_file);
      const lane = await loadStructuredFile(lanePath, LaneFileSchema);
      await upsertConfigRevision(
        {
          configKey: `lane:${entry.lane_key}`,
          configType: 'LANE_DEFINITION',
          description: `config/lanes/${entry.config_file}`,
          schemaVersion: lane.data.schema_version ?? '2.2.0',
          content: lane.data,
        },
        pool,
        {
          context: ctx,
          note: `sync from ${lanePath}`,
        }
      );
      laneCount += 1;
    }

    const evidenceStrengthPath = path.resolve(process.cwd(), 'config', 'evidence_strength.yml');
    const evidenceStrength = await loadStructuredFile(
      evidenceStrengthPath,
      EvidenceStrengthPolicySchema
    );
    const evidenceStrengthRes = await upsertConfigRevision(
      {
        configKey: 'evidence_strength',
        configType: 'EVIDENCE_STRENGTH',
        description: 'config/evidence_strength.yml',
        schemaVersion: evidenceStrength.data.schema_version ?? '2.2.0',
        content: evidenceStrength.data,
      },
      pool,
      {
        context: ctx,
        note: `sync from ${evidenceStrengthPath}`,
      }
    );

    console.log('Config registry sync complete.');
    console.log(`- workspace: ${ctx.workspaceKey} (${ctx.workspaceId})`);
    console.log(`- sources: revision ${sourcesRes.revisionNumber} (hash ${sourcesRes.contentHash.slice(0, 12)}...)`);
    console.log(`- lanes_registry: revision ${registryRes.revisionNumber} (hash ${registryRes.contentHash.slice(0, 12)}...)`);
    console.log(`- lane definitions synced: ${laneCount}`);
    console.log(
      `- evidence_strength: revision ${evidenceStrengthRes.revisionNumber} (hash ${evidenceStrengthRes.contentHash.slice(0, 12)}...)`
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].includes('sync_config_registry')) {
  main().catch((err) => {
    console.error('sync_config_registry failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
