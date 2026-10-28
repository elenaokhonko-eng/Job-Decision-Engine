import { describe, expect, it } from "vitest";
import {
  assessJobArchiveAge,
  referenceIsOlderThanCutoff,
  subtractCalendarMonths,
  type JobArchiveVersionEvidence,
} from "../../services/jobArchivePolicy.js";

const runStartedAt = new Date("2026-10-27T19:15:00.000Z");

function supportedDate(value: string, basis: "PUBLISHED_AT" | "GENUINE_REPOST_AT") {
  return {
    status: "SUPPORTED",
    value,
    basis,
    raw_value: value,
    timestamp_unit: "ISO_STRING",
    evidence: [{ quote_text: `${basis}: ${value}` }],
  };
}

describe("job archive age policy", () => {
  it("uses an evidenced genuine repost date before the original publication date", () => {
    const versions: JobArchiveVersionEvidence[] = [{
      source_posting_identity_hash: "posting-1",
      source_published_at: "2026-04-01T00:00:00.000Z",
      reposted_at: "2026-08-01T00:00:00.000Z",
      first_seen_at: "2026-03-31T00:00:00.000Z",
      date_evidence: {
        published_at: supportedDate("2026-04-01T00:00:00.000Z", "PUBLISHED_AT"),
        reposted_at: supportedDate("2026-08-01T00:00:00.000Z", "GENUINE_REPOST_AT"),
      },
    }];

    expect(assessJobArchiveAge(versions, "posting-1", runStartedAt)).toMatchObject({
      status: "REFERENCE_FOUND",
      referenceAt: new Date("2026-08-01T00:00:00.000Z"),
      ageBasis: "GENUINE_REPOST_DATE",
      publicationDateUnknown: false,
    });
  });

  it("uses the earliest observation across repeated versions when publication date is unknown", () => {
    const versions: JobArchiveVersionEvidence[] = [
      {
        source_posting_identity_hash: "posting-1",
        first_seen_at: "2026-06-01T00:00:00.000Z",
        observation_first_seen_at: "2026-06-01T00:00:00.000Z",
        date_evidence: {},
      },
      {
        source_posting_identity_hash: "posting-1",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        observation_first_seen_at: "2026-06-01T00:00:00.000Z",
        date_evidence: {},
      },
    ];

    expect(assessJobArchiveAge(versions, "posting-1", runStartedAt)).toMatchObject({
      status: "REFERENCE_FOUND",
      referenceAt: new Date("2026-06-01T00:00:00.000Z"),
      ageBasis: "OBSERVED_AGE_PUBLICATION_UNKNOWN",
      publicationDateUnknown: true,
    });
  });

  it("rejects future and contradictory source dates instead of falling back to observation age", () => {
    const future: JobArchiveVersionEvidence[] = [{
      source_published_at: "2026-10-28T00:00:00.000Z",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      date_evidence: { published_at: supportedDate("2026-10-28T00:00:00.000Z", "PUBLISHED_AT") },
    }];
    const contradictory: JobArchiveVersionEvidence[] = [{
      source_published_at: "2026-04-01T00:00:00.000Z",
      reposted_at: "2026-03-01T00:00:00.000Z",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      date_evidence: {
        published_at: supportedDate("2026-04-01T00:00:00.000Z", "PUBLISHED_AT"),
        reposted_at: supportedDate("2026-03-01T00:00:00.000Z", "GENUINE_REPOST_AT"),
      },
    }];

    expect(assessJobArchiveAge(future, null, runStartedAt)).toMatchObject({
      status: "INVALID_DATE",
      reasonCode: "FUTURE_SOURCE_DATE",
    });
    expect(assessJobArchiveAge(contradictory, null, runStartedAt)).toMatchObject({
      status: "INVALID_DATE",
      reasonCode: "CONTRADICTORY_SOURCE_DATES",
    });
  });

  it("uses a strict three-calendar-month cutoff", () => {
    const cutoff = new Date("2026-07-31T12:00:00.000Z");

    expect(referenceIsOlderThanCutoff(new Date(cutoff.getTime() - 1), cutoff)).toBe(true);
    expect(referenceIsOlderThanCutoff(cutoff, cutoff)).toBe(false);
    expect(referenceIsOlderThanCutoff(new Date(cutoff.getTime() + 1), cutoff)).toBe(false);
  });

  it("subtracts calendar months with end-of-month clamping", () => {
    expect(subtractCalendarMonths(new Date("2026-10-31T19:15:00.000Z"), 3).toISOString())
      .toBe("2026-07-31T19:15:00.000Z");
    expect(subtractCalendarMonths(new Date("2026-05-31T19:15:00.000Z"), 3).toISOString())
      .toBe("2026-02-28T19:15:00.000Z");
    expect(subtractCalendarMonths(new Date("2024-05-31T19:15:00.000Z"), 3).toISOString())
      .toBe("2024-02-29T19:15:00.000Z");
  });

  it("reads nested source evidence and does not use source-update time as posting age", () => {
    const nestedEvidence: JobArchiveVersionEvidence[] = [{
      source_posting_identity_hash: "posting-1",
      first_seen_at: "2026-06-01T00:00:00.000Z",
      observation_first_seen_at: "2026-06-01T00:00:00.000Z",
      date_evidence: {
        schema_version: "job_source_evidence_v1",
        dates: {
          published_at: { status: "UNKNOWN", value: null, basis: "UNKNOWN", raw_value: null, evidence: [] },
          reposted_at: { status: "UNKNOWN", value: null, basis: "UNKNOWN", raw_value: null, evidence: [] },
          source_updated_at: supportedDate("2026-10-20T00:00:00.000Z", "PUBLISHED_AT"),
        },
      },
    }];

    expect(assessJobArchiveAge(nestedEvidence, "posting-1", runStartedAt)).toMatchObject({
      status: "REFERENCE_FOUND",
      referenceAt: new Date("2026-06-01T00:00:00.000Z"),
      ageBasis: "OBSERVED_AGE_PUBLICATION_UNKNOWN",
      publicationDateUnknown: true,
    });
  });
});
