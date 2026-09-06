import type { SourceName } from "../contracts/index.js";

export type { SourceName };

export interface RawJobObservation {
  sourceRunId: string;
  sourceName: SourceName;
  /** Lowercase manifest key (P12 source plugin registry); defaults to sourceName.toLowerCase(). */
  sourcePluginKey?: string;
  /** Active source plugin revision id (if registry is seeded). */
  sourcePluginRevisionId?: string | null;
  sourceExternalId: string;
  sourceUrl: string;
  canonicalApplyUrl?: string;

  retrievedAt: string;
  publishedAt?: string;
  expiresAt?: string;

  companyName: string;
  title: string;
  descriptionRaw: string;

  locationRaw?: string;
  workplaceTypeRaw?: string;
  employmentTypeRaw?: string;
  compensationRaw?: string;

  sourceLane: string;
  searchPlanVersion: string;
  matchedQueryId?: string;
  targetCompanyId?: string;

  rawPayload: unknown;
  rawPayloadHash: string;
}
