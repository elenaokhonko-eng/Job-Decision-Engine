export type SourceName = 
  | "greenhouse"
  | "GREENHOUSE"
  | "ashby"
  | "ASHBY"
  | "lever"
  | "LEVER"
  | "himalayas"
  | "HIMALAYAS"
  | "startup_jobs"
  | "jobicy"
  | "remotive"
  | "email_alert"
  | "GMAIL_ALERT";

export interface RawJobObservation {
  sourceRunId: string;
  sourceName: SourceName;
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
