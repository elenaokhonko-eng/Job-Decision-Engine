import dotenv from "dotenv";
import pg from "pg";

import { pgConnectionConfig } from "../src/db/pgSsl.js";
import { publicErrorSummary } from "../src/security/publicErrorSummary.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

/**
 * Checks that Vertex AI returns the same gemini-embedding-001 vectors as the stored ones.
 *
 *   npx tsx scripts/compare_embedding_backends.ts              # dry run: lists the sample only
 *   GEMINI_BACKEND=vertex GOOGLE_CLOUD_PROJECT=... npx tsx scripts/compare_embedding_backends.ts --run [--limit 20]
 *
 * Takes N stored inputs from the active gemini-embedding-001 768-dimension space, embeds their
 * stored input text through the configured (Vertex) backend, and reports the cosine similarity
 * with each stored vector, flagging any below 0.999. The database is read inside a READ ONLY
 * transaction and no vector is ever written. Output holds input ids and numbers only, never text.
 * Exits 1 when any input is flagged or fails to embed.
 */

export const COSINE_THRESHOLD = 0.999;

/** Stored vectors of the active gemini-embedding-001 space with their current input text. */
export const EMBEDDING_SAMPLE_SQL = `
SELECT se.embedding_input_id::text AS embedding_input_id, ei.content_text, se.embedding_values
   FROM semantic_embeddings se
   JOIN embedding_spaces es ON es.id = se.embedding_space_id AND es.workspace_id = se.workspace_id
   JOIN embedding_inputs ei ON ei.id = se.embedding_input_id AND ei.workspace_id = se.workspace_id
   WHERE se.workspace_id = $1
     AND es.active = TRUE
     AND LOWER(es.provider) = 'gemini'
     AND es.model = $2
     AND es.dimensions = $3
     AND ei.is_current = TRUE
   ORDER BY se.created_at DESC
   LIMIT $4`;
const MODEL = "gemini-embedding-001";
const DIMENSIONS = 768;

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`Vector lengths differ (${a.length} vs ${b.length}).`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) throw new Error("A vector has zero length.");
  return dot / Math.sqrt(normA * normB);
}

export interface EmbeddingComparison {
  embedding_input_id: string;
  cosine: number | null;
  flagged: boolean;
  error?: string;
}

export function summarizeEmbeddingComparisons(results: EmbeddingComparison[]) {
  const cosines = results.map((item) => item.cosine).filter((value): value is number => value !== null);
  return {
    compared: results.length,
    embedded: cosines.length,
    failed: results.filter((item) => item.error).length,
    flagged_below_threshold: results.filter((item) => item.flagged).length,
    threshold: COSINE_THRESHOLD,
    min_cosine: cosines.length ? Math.min(...cosines) : null,
    mean_cosine: cosines.length ? cosines.reduce((sum, value) => sum + value, 0) / cosines.length : null,
    ok: results.length > 0 && results.every((item) => !item.flagged && !item.error),
  };
}

function parseArgs(argv: string[]) {
  const index = argv.indexOf("--limit");
  const limit = Number.parseInt(index >= 0 ? argv[index + 1] ?? "" : "20", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit must be an integer from 1 to 500.");
  return { run: argv.includes("--run"), limit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool(pgConnectionConfig(process.env.DATABASE_URL));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const ctx = await resolveWorkspaceContext(client as any);
    const sample = await client.query<{ embedding_input_id: string; content_text: string; embedding_values: number[] }>(
      EMBEDDING_SAMPLE_SQL, [ctx.workspaceId, MODEL, DIMENSIONS, args.limit]);
    await client.query("ROLLBACK");
    console.log(JSON.stringify({
      mode: args.run ? "run" : "dry-run",
      backend: process.env.GEMINI_BACKEND || "studio",
      model: MODEL,
      dimensions: DIMENSIONS,
      sample: sample.rows.map((row) => row.embedding_input_id),
      writes: "none (READ ONLY transaction; vectors are never written)",
    }, null, 2));
    if (!args.run) {
      console.log("Dry run: pass --run (with GEMINI_BACKEND=vertex) to embed the sample and compare.");
      return;
    }
    if ((process.env.GEMINI_BACKEND || "").trim().toLowerCase() !== "vertex") {
      throw new Error("Set GEMINI_BACKEND=vertex (and GOOGLE_CLOUD_PROJECT) to compare Vertex vectors with the stored ones.");
    }
    if (sample.rows.length === 0) throw new Error("No stored gemini-embedding-001 768-dimension vectors were found.");

    process.env.EMBEDDING_PRIMARY_DIMENSIONS = String(DIMENSIONS);
    const { generateEmbeddingsWithProviderAndModel } = await import("../src/services/agent.js");
    const outcomes = await generateEmbeddingsWithProviderAndModel(
      sample.rows.map((row) => row.content_text), "gemini", MODEL);
    const results: EmbeddingComparison[] = sample.rows.map((row, index) => {
      const outcome = outcomes[index];
      if (!outcome?.ok) {
        return { embedding_input_id: row.embedding_input_id, cosine: null, flagged: false,
          error: publicErrorSummary(outcome?.error ?? "no outcome", "embedding") };
      }
      try {
        const cosine = cosineSimilarity(outcome.vector, row.embedding_values.map(Number));
        return { embedding_input_id: row.embedding_input_id, cosine, flagged: cosine < COSINE_THRESHOLD };
      } catch (error) {
        return { embedding_input_id: row.embedding_input_id, cosine: null, flagged: false,
          error: publicErrorSummary(error, "embedding") };
      }
    });
    const summary = summarizeEmbeddingComparisons(results);
    console.log(JSON.stringify({ summary, results }, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.includes("compare_embedding_backends")) {
  main().catch((error) => {
    console.error("Embedding backend comparison failed:", publicErrorSummary(error, "embedding"));
    process.exitCode = 1;
  });
}
