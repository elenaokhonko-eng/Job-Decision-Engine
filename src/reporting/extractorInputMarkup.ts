/**
 * Counts requirement quotes that contain markup, with and without the posting
 * cleaner in front of the deterministic extractor. Counts only: no posting text
 * or quote text is returned, so the result is safe to print.
 */
import pg from "pg";

import { pgConnectionConfig } from "../db/pgSsl.js";
import { extractDeterministicRequirements } from "../requirements/deterministicExtractors.js";
import { cleanPostingText } from "../security/postingText.js";
import { resolveWorkspaceContext } from "../workspace/context.js";

const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

/** A tag (real or decoded) or an HTML entity such as &lt; or &amp;. */
export const MARKUP_IN_QUOTE = /<\/?[a-zA-Z][^<>]*>|&(?:lt|gt|amp|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/i;

export interface MarkupFigures {
  readonly jobs: number;
  readonly quotes: number;
  readonly quotesWithMarkup: number;
  readonly jobsWithMarkupInAQuote: number;
}

export interface MarkupMeasurement {
  readonly postingsContainingMarkup: number;
  readonly before: MarkupFigures;
  readonly after: MarkupFigures;
}

function figures(descriptions: readonly string[]): MarkupFigures {
  let quotes = 0;
  let withMarkup = 0;
  let jobsWith = 0;
  for (const description of descriptions) {
    const { requirements } = extractDeterministicRequirements({
      canonical_job_id: ZERO_UUID,
      job_version_id: ZERO_UUID,
      description_text: description,
    });
    let jobHit = false;
    for (const requirement of requirements) {
      const quote = requirement.quote_text;
      if (!quote) continue;
      quotes += 1;
      if (MARKUP_IN_QUOTE.test(quote)) {
        withMarkup += 1;
        jobHit = true;
      }
    }
    if (jobHit) jobsWith += 1;
  }
  return { jobs: descriptions.length, quotes, quotesWithMarkup: withMarkup, jobsWithMarkupInAQuote: jobsWith };
}

export function measureQuoteMarkup(descriptions: readonly string[]): MarkupMeasurement {
  return {
    postingsContainingMarkup: descriptions.filter((d) => MARKUP_IN_QUOTE.test(d)).length,
    before: figures(descriptions),
    after: figures(descriptions.map((d) => cleanPostingText(d).text)),
  };
}

/** Latest stored description of every non-archived job. The caller must hold a READ ONLY transaction. */
export async function loadLatestDescriptions(client: pg.ClientBase, workspaceId: string): Promise<string[]> {
  const { rows } = await client.query<{ description_text: string }>(
    `SELECT jv.description_text
       FROM canonical_jobs cj
       JOIN job_versions jv ON jv.id = cj.latest_job_version_id
      WHERE cj.workspace_id = $1 AND cj.archived_at IS NULL AND jv.description_text IS NOT NULL`,
    [workspaceId],
  );
  return rows.map((row) => row.description_text);
}

/** Opens one READ ONLY transaction, measures, and always rolls back. Nothing is written. */
export async function measureQuoteMarkupFromDatabase(databaseUrl: string): Promise<MarkupMeasurement> {
  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const workspace = await resolveWorkspaceContext(client);
    return measureQuoteMarkup(await loadLatestDescriptions(client, workspace.workspaceId));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}
