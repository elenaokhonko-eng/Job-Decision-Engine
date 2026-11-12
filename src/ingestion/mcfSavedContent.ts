/**
 * Stored MyCareersFuture saved-jobs export content, consulted by the
 * FETCH_JOB_CONTENT task before any network fetch. The user has retired MCF
 * page fetching, so a Gmail MCF alert card is otherwise parked; when the user
 * has exported the same job (same MCF job UUID) from their own browser, that
 * export is the posting content. It is persisted without an HTTP fetch receipt,
 * so content completeness alone never establishes that the job is still open;
 * only the posting facts the export read from MCF's job details (posting and
 * expiry dates, open/closed status with its check time) are carried over.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type { RawJobObservation } from "./types.js";
import { classifyDescriptionQuality } from "../pipeline/descriptionQuality.js";
import { savedPostingMatchesDiscovery } from "./linkedInSavedExport.js";
import { pickPostingFactPayload } from "./postingFacts.js";
import type { SavedPostingObservationInput } from "./linkedInSavedContent.js";
import {
  MCF_SAVED_CONTENT_PROVENANCE,
  MCF_SAVED_PLUGIN_KEY,
  MCF_SAVED_SOURCE_NAME,
  mcfEmploymentTypeRaw,
  MCF_SINGAPORE_ONLY_LOCATION,
  mcfJobUuidFromUrl,
} from "./mcfSavedExport.js";

type Queryable = Pick<pg.PoolClient, "query">;

export function mcfSavedExternalId(mcfJobUuid: string): string {
  return `mcf-job:${mcfJobUuid}`;
}

export interface StoredMcfSavedPosting {
  readonly observationId: string;
  readonly mcfJobUuid: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly companyName: string;
  readonly description: string;
  readonly location: string | null;
  readonly compensation: string | null;
  readonly employmentType: string | null;
  readonly postedAt: string | null;
  readonly expiresAt: string | null;
  /** Root posting-fact fields of the saved export (postingFacts.ts); empty when the export had none. */
  readonly postingFacts?: Record<string, unknown>;
  readonly importedAt: string;
  readonly exportPayloadHash: string;
}

export type McfSavedPostingLookup =
  | { readonly kind: "NOT_MCF" }
  | { readonly kind: "NONE" }
  | { readonly kind: "UNUSABLE"; readonly reason: "TITLE_MISMATCH" | "COMPANY_MISMATCH" | "DESCRIPTION_INCOMPLETE"; readonly observationId: string }
  | { readonly kind: "FOUND"; readonly posting: StoredMcfSavedPosting };

/** Latest imported export for the MCF job behind a discovery URL, checked against the discovery identity. */
export async function findStoredMcfSavedPosting(
  client: Queryable,
  workspaceId: string,
  discovery: { readonly sourceUrl: string; readonly title: string; readonly companyName: string },
): Promise<McfSavedPostingLookup> {
  const mcfJobUuid = mcfJobUuidFromUrl(discovery.sourceUrl);
  if (!mcfJobUuid) return { kind: "NOT_MCF" };
  const { rows } = await client.query<{
    id: string;
    source_url: string;
    title: string;
    company_name: string;
    description_raw: string;
    location_raw: string | null;
    compensation_raw: string | null;
    employment_type: string | null;
    posted_at: string | null;
    expires_at: string | null;
    retrieved_at: Date | string;
    raw_payload_hash: string;
    raw_payload: unknown;
  }>(
    `SELECT id::text AS id, source_url, title, company_name, description_raw, location_raw, compensation_raw,
            raw_payload#>>'{exported_item,employmentType}' AS employment_type,
            raw_payload#>>'{exported_item,postedAt}' AS posted_at,
            raw_payload#>>'{exported_item,expiresAt}' AS expires_at,
            retrieved_at, raw_payload_hash, raw_payload
     FROM raw_job_observations
     WHERE workspace_id = $1
       AND source_name = $2
       AND source_external_id = $3
       AND derived_from_observation_id IS NULL
     ORDER BY retrieved_at DESC, id DESC
     LIMIT 1`,
    [workspaceId, MCF_SAVED_SOURCE_NAME, mcfSavedExternalId(mcfJobUuid)],
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
      mcfJobUuid,
      canonicalUrl: row.source_url,
      title: row.title,
      companyName: row.company_name,
      description: row.description_raw,
      location: row.location_raw,
      compensation: row.compensation_raw,
      employmentType: row.employment_type,
      postedAt: row.posted_at,
      expiresAt: row.expires_at,
      postingFacts: pickPostingFactPayload(row.raw_payload),
      importedAt: new Date(row.retrieved_at).toISOString(),
      exportPayloadHash: row.raw_payload_hash,
    },
  };
}

/**
 * The posting observation derived from a Gmail MCF discovery card and its saved
 * export. The payload is deterministic (retrieved_at is the import time), so a
 * repeated attach resolves to the same observation by payload hash.
 */
export function mcfSavedPostingDerivedObservation(
  discoveryObservationId: string,
  posting: StoredMcfSavedPosting,
): SavedPostingObservationInput & Pick<RawJobObservation, "employmentTypeRaw"> {
  const postingRecord = {
    title: posting.title,
    companyName: posting.companyName,
    description: posting.description,
    canonicalUrl: posting.canonicalUrl,
    location: posting.location,
    compensationRaw: posting.compensation,
    employmentType: posting.employmentType,
    postedAt: posting.postedAt,
    expiresAt: posting.expiresAt,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(postingRecord), "utf8").digest("hex");
  const rawPayload = {
    // Present only when the export read them, so earlier attaches keep their payload hash.
    ...(posting.postingFacts ?? {}),
    source_content_status: "COMPLETE",
    content_provenance: MCF_SAVED_CONTENT_PROVENANCE,
    discovery_observation_id: discoveryObservationId,
    saved_export_observation_id: posting.observationId,
    saved_export_payload_hash: posting.exportPayloadHash,
    mcf_job_uuid: posting.mcfJobUuid,
    canonical_url: posting.canonicalUrl,
    imported_at: posting.importedAt,
    content_hash: contentHash,
    posting: postingRecord,
  };
  return {
    sourceName: MCF_SAVED_SOURCE_NAME,
    sourcePluginKey: MCF_SAVED_PLUGIN_KEY,
    sourceExternalId: mcfSavedExternalId(posting.mcfJobUuid),
    sourceUrl: posting.canonicalUrl,
    canonicalApplyUrl: posting.canonicalUrl,
    retrievedAt: posting.importedAt,
    companyName: posting.companyName,
    title: posting.title,
    descriptionRaw: posting.description,
    // MCF lists only jobs in Singapore; a hidden address still places the job there.
    locationRaw: posting.location ?? MCF_SINGAPORE_ONLY_LOCATION,
    workplaceTypeRaw: "UNKNOWN",
    employmentTypeRaw: mcfEmploymentTypeRaw(posting.employmentType),
    ...(posting.compensation ? { compensationRaw: posting.compensation } : {}),
    sourceLane: "UNKNOWN",
    searchPlanVersion: "posting_fetch_v1",
    derivedFromObservationId: discoveryObservationId,
    rawPayload,
  };
}
