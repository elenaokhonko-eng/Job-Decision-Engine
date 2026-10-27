import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type ExtractedJob } from "../../contracts/index.js";
import { buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";
import {
  assessSourceEvidenceCandidate,
  clearConflictingAvailability,
  supportedVersionEvidence,
  type RefreshCandidateTarget,
} from "../../ingestion/sourceEvidenceRefresh.js";
import { generateContentHash } from "../../services/criteria.js";

const job: ExtractedJob = {
  schema_version: SCHEMA_VERSION,
  source_external_id: "posting-42",
  company_name: "Example Company",
  title: "Senior Data Engineer",
  location_raw: "Singapore",
  workplace_type_raw: "REMOTE",
  employment_type_raw: "FULL_TIME",
  compensation_raw: "UNKNOWN",
  employer_posting_url: "https://boards.greenhouse.io/example/jobs/42",
  application_url: "https://boards.greenhouse.io/example/jobs/42",
  canonical_apply_url: "https://boards.greenhouse.io/example/jobs/42",
  description_raw: "Build and maintain the company's data platform and production pipelines.",
  raw_payload: { id: "posting-42", status: "active" },
};

const target: RefreshCandidateTarget = {
  adapterSourceName: "GREENHOUSE",
  observedSourceName: "GREENHOUSE",
  sourceExternalId: "posting-42",
  sourceUrl: "https://boards.greenhouse.io/example/jobs/42",
  expectedContentHash: generateContentHash(job.company_name, job.title, job.description_raw),
};

const evidenceInput = {
  sourceName: "HIMALAYAS",
  sourcePluginKey: "himalayas",
  sourcePluginRevisionId: null,
  sourceExternalId: "posting-42",
  sourceUrl: "https://example.test/jobs/42",
  canonicalApplyUrl: "https://example.test/jobs/42",
  retrievedAt: "2026-10-26T00:00:00.000Z",
  rawPayloadHash: "a".repeat(64),
  rawPayload: {},
  companyName: "Example Company",
  title: "Senior Data Engineer",
  locationRaw: "Singapore",
  workplaceTypeRaw: "UNKNOWN",
  employmentTypeRaw: "UNKNOWN",
  compensationRaw: "UNKNOWN",
  descriptionText: "Build and maintain the company's data platform. Travel may reach 150% of working time.",
};

describe("single-version source evidence refresh assessment", () => {
  it("returns unavailable when the fetched snapshot does not contain the linked posting", () => {
    expect(assessSourceEvidenceCandidate(target, [])).toMatchObject({ kind: "UNAVAILABLE" });
  });

  it("matches an Ashby posting when a legacy URL identity meets a provider ID", () => {
    const ashbyUrl = "https://jobs.ashbyhq.com/cohere/role-42";
    const ashbyJob = {
      ...job,
      source_external_id: "ashby-role-42",
      employer_posting_url: ashbyUrl,
      application_url: ashbyUrl,
      canonical_apply_url: ashbyUrl,
    };
    const result = assessSourceEvidenceCandidate({
      adapterSourceName: "ASHBY",
      observedSourceName: "ASHBY",
      sourceExternalId: ashbyUrl,
      sourceUrl: ashbyUrl,
      expectedContentHash: generateContentHash(ashbyJob.company_name, ashbyJob.title, ashbyJob.description_raw),
    }, [ashbyJob]);

    expect(result).toMatchObject({ kind: "MATCHED", job: { source_external_id: "ashby-role-42" } });
  });

  it("recognizes quarantined Ashby records by posting URL when the stored ID is legacy URL-shaped", () => {
    const ashbyUrl = "https://jobs.ashbyhq.com/cohere/role-42";
    const result = assessSourceEvidenceCandidate({
      adapterSourceName: "ASHBY",
      observedSourceName: "ASHBY",
      sourceExternalId: ashbyUrl,
      sourceUrl: ashbyUrl,
      expectedContentHash: generateContentHash(job.company_name, job.title, job.description_raw),
    }, [], [{
      identity: "ashby-role-42",
      rawPayload: { id: "ashby-role-42", jobUrl: ashbyUrl },
      error: "invalid extracted job",
    }]);

    expect(result).toMatchObject({ kind: "UNSUPPORTED" });
  });

  it("returns conflict when the linked source identity now has different content", () => {
    const changedJob = { ...job, description_raw: "A different role description." };

    expect(assessSourceEvidenceCandidate(target, [changedJob])).toMatchObject({ kind: "CONFLICT" });
  });

  it("returns unsupported when the configured adapter does not match the observation source", () => {
    expect(assessSourceEvidenceCandidate({ ...target, adapterSourceName: "LEVER" }, [job]))
      .toMatchObject({ kind: "UNSUPPORTED" });
  });

  it("returns unsupported when a matching record fails the extracted-job contract", () => {
    expect(assessSourceEvidenceCandidate(target, [{ source_external_id: "posting-42" }]))
      .toMatchObject({ kind: "UNSUPPORTED" });
  });

  it("leaves unsupported dates, availability, and compensation unknown instead of overwriting evidence", () => {
    const evidence = buildJobSourceEvidence(evidenceInput);

    expect(evidence.availability.status).toBe("UNKNOWN");
    expect(evidence.dates.published_at.status).toBe("UNKNOWN");
    expect(evidence.dates.expires_at.status).toBe("UNKNOWN");
    expect(evidence.compensation.status).toBe("UNKNOWN");
    expect(evidence.workability.travel_pct.status).toBe("CONFLICTING");
    expect(supportedVersionEvidence(evidence)).toEqual({
      publishedAt: null,
      sourceUpdatedAt: null,
      expiresAt: null,
      availability: null,
    });
  });

  it("does not publish availability when source status fields conflict", () => {
    const rawPayload = { status: "active", isClosed: true };
    const evidence = buildJobSourceEvidence({ ...evidenceInput, sourceName: "GREENHOUSE", rawPayload });
    const conflictSafeEvidence = clearConflictingAvailability(evidence, rawPayload);

    expect(evidence.availability.status).toBe("CLOSED");
    expect(conflictSafeEvidence.availability).toMatchObject({
      status: "UNKNOWN",
      reason_code: "AVAILABILITY_CONFLICTING_SOURCE_STATUS",
      evidence: [],
    });
    expect(supportedVersionEvidence(conflictSafeEvidence).availability).toBeNull();
  });
});
