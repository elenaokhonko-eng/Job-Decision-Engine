/**
 * Stored LinkedIn saved-jobs export content, consulted by the FETCH_JOB_CONTENT
 * task before any network fetch. LinkedIn posting pages require sign-in, so a
 * Gmail LinkedIn alert card is otherwise blocked; when the user has exported the
 * same job (same LinkedIn job id) from their own browser, that export is the
 * posting content. It is persisted without an HTTP fetch receipt, so it completes
 * the content fetch but never establishes that the job is still open.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { RawJobObservation } from "./types.js";
import { classifyDescriptionQuality } from "../pipeline/descriptionQuality.js";
import { linkedInJobIdFromUrl } from "./searchApi/searchApiClient.js";
import {
  LINKEDIN_SAVED_CONTENT_PROVENANCE,
  LINKEDIN_SAVED_PLUGIN_KEY,
  LINKEDIN_SAVED_SOURCE_NAME,
  linkedInWorkplaceTypeFromLocation,
  savedPostingMatchesDiscovery,
} from "./linkedInSavedExport.js";

type Queryable = Pick<pg.PoolClient, "query">;

export function linkedInSavedExternalId(linkedInJobId: string): string {
  return `linkedin-job:${linkedInJobId}`;
}

export interface StoredLinkedInSavedPosting {
  readonly observationId: string;
  readonly linkedInJobId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly companyName: string;
  readonly description: string;
  readonly location: string | null;
  readonly compensation: string | null;
  readonly postedAt: string | null;
  readonly importedAt: string;
  readonly exportPayloadHash: string;
}

export type SavedPostingLookup =
  | { readonly kind: "NOT_LINKEDIN" }
  | { readonly kind: "NONE" }
  | { readonly kind: "UNUSABLE"; readonly reason: "TITLE_MISMATCH" | "COMPANY_MISMATCH" | "DESCRIPTION_INCOMPLETE"; readonly observationId: string }
  | { readonly kind: "FOUND"; readonly posting: StoredLinkedInSavedPosting };

/** Latest imported export for the LinkedIn job behind a discovery URL, checked against the discovery identity. */
export async function findStoredLinkedInSavedPosting(
  client: Queryable,
  workspaceId: string,
  discovery: { readonly sourceUrl: string; readonly title: string; readonly companyName: string },
): Promise<SavedPostingLookup> {
  const linkedInJobId = linkedInJobIdFromUrl(discovery.sourceUrl);
  if (!linkedInJobId) return { kind: "NOT_LINKEDIN" };
  const { rows } = await client.query<{
    id: string;
    source_url: string;
    title: string;
    company_name: string;
    description_raw: string;
    location_raw: string | null;
    compensation_raw: string | null;
    posted_at: string | null;
    retrieved_at: Date | string;
    raw_payload_hash: string;
  }>(
    `SELECT id::text AS id, source_url, title, company_name, description_raw, location_raw, compensation_raw,
            raw_payload#>>'{exported_item,postedAt}' AS posted_at, retrieved_at, raw_payload_hash
     FROM raw_job_observations
     WHERE workspace_id = $1
       AND source_name = $2
       AND source_external_id = $3
       AND derived_from_observation_id IS NULL
     ORDER BY retrieved_at DESC, id DESC
     LIMIT 1`,
    [workspaceId, LINKEDIN_SAVED_SOURCE_NAME, linkedInSavedExternalId(linkedInJobId)],
  );
  const row = rows[0];
  if (!row) return { kind: "NONE" };
  const identity = savedPostingMatchesDiscovery(discovery, { title: row.title, companyName: row.company_name });
  if (!identity.matches) return { kind: "UNUSABLE", reason: identity.reason, observationId: row.id };
  if (classifyDescriptionQuality(row.description_raw).status !== "COMPLETE") {
    return { kind: "UNUSABLE", reason: "DESCRIPTION_INCOMPLETE", observationId: row.id };
  }
  return {
    kind: "FOUND",
    posting: {
      observationId: row.id,
      linkedInJobId,
      canonicalUrl: row.source_url,
      title: row.title,
      companyName: row.company_name,
      description: row.description_raw,
      location: row.location_raw,
      compensation: row.compensation_raw,
      postedAt: row.posted_at,
      importedAt: new Date(row.retrieved_at).toISOString(),
      exportPayloadHash: row.raw_payload_hash,
    },
  };
}

export type SavedPostingObservationInput = Omit<RawJobObservation, "sourceRunId" | "rawPayloadHash"> & {
  readonly derivedFromObservationId: string;
  readonly rawPayload: Record<string, unknown>;
};

/**
 * The posting observation derived from a Gmail discovery card and its saved
 * export. The payload is deterministic (retrieved_at is the import time), so a
 * repeated attach resolves to the same observation by payload hash.
 */
export function savedPostingDerivedObservation(
  discoveryObservationId: string,
  posting: StoredLinkedInSavedPosting,
): SavedPostingObservationInput {
  const postingRecord = {
    title: posting.title,
    companyName: posting.companyName,
    description: posting.description,
    canonicalUrl: posting.canonicalUrl,
    location: posting.location,
    compensationRaw: posting.compensation,
    postedAt: posting.postedAt,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(postingRecord), "utf8").digest("hex");
  const rawPayload = {
    source_content_status: "COMPLETE",
    content_provenance: LINKEDIN_SAVED_CONTENT_PROVENANCE,
    discovery_observation_id: discoveryObservationId,
    saved_export_observation_id: posting.observationId,
    saved_export_payload_hash: posting.exportPayloadHash,
    linkedin_job_id: posting.linkedInJobId,
    canonical_url: posting.canonicalUrl,
    imported_at: posting.importedAt,
    content_hash: contentHash,
    posting: postingRecord,
  };
  return {
    sourceName: LINKEDIN_SAVED_SOURCE_NAME,
    sourcePluginKey: LINKEDIN_SAVED_PLUGIN_KEY,
    sourceExternalId: linkedInSavedExternalId(posting.linkedInJobId),
    sourceUrl: posting.canonicalUrl,
    canonicalApplyUrl: posting.canonicalUrl,
    retrievedAt: posting.importedAt,
    companyName: posting.companyName,
    title: posting.title,
    descriptionRaw: posting.description,
    ...(posting.location ? { locationRaw: posting.location } : {}),
    workplaceTypeRaw: linkedInWorkplaceTypeFromLocation(posting.location),
    employmentTypeRaw: "UNKNOWN",
    ...(posting.compensation ? { compensationRaw: posting.compensation } : {}),
    sourceLane: "UNKNOWN",
    searchPlanVersion: "posting_fetch_v1",
    derivedFromObservationId: discoveryObservationId,
    rawPayload,
  };
}
