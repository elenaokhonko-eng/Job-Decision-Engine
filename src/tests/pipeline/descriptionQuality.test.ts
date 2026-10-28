import { describe, expect, it } from "vitest";
import {
  classifyDescriptionQuality,
  completeRetrievedPostingPredicate,
  MIN_COMPLETE_DESCRIPTION_CHARS,
  sourceContentEvidencePredicate,
} from "../../pipeline/descriptionQuality.js";

describe("description quality policy", () => {
  it("builds a scoped source evidence predicate and rejects untrusted SQL expressions", () => {
    expect(sourceContentEvidencePredicate("version.workspace_id", "version.id")).toContain(
      "source_content_observation.job_version_id = version.id",
    );
    expect(sourceContentEvidencePredicate("version.workspace_id", "version.id")).toContain(
      "source_content_observation.source_name <> 'GMAIL_ALERT'",
    );
    expect(() => sourceContentEvidencePredicate("version.workspace_id; DROP TABLE jobs", "version.id")).toThrow(
      "trusted identifiers",
    );
  });

  it("requires fetched source, response hashes, identity, and a matching persisted version", () => {
    const predicate = completeRetrievedPostingPredicate("derived");
    expect(predicate).toContain("derived.raw_payload#>>'{source_evidence,responseHash}'");
    expect(predicate).toContain("derived.raw_payload#>>'{posting,title}' = derived.title");
    expect(predicate).toContain("retrieved_version.description_text = derived.description_raw");
    expect(() => completeRetrievedPostingPredicate("derived; DROP TABLE jobs")).toThrow("trusted identifiers");
  });

  it("classifies missing and short source text as enrichment debt", () => {
    expect(classifyDescriptionQuality("")).toEqual({
      status: "UNKNOWN",
      reason: "DESCRIPTION_MISSING",
    });
    expect(classifyDescriptionQuality("x".repeat(MIN_COMPLETE_DESCRIPTION_CHARS - 1))).toEqual({
      status: "INCOMPLETE",
      reason: "DESCRIPTION_HAS_INSUFFICIENT_SUBSTANTIVE_CONTENT",
    });
  });

  it("accepts a concise but complete posting with responsibilities and qualification sections", () => {
    const concisePosting = [
      "About the role: Build and operate a research data platform used by scientists.",
      "Responsibilities: Design services, implement data workflows, and support production releases.",
      "Requirements: Experience with Python, cloud systems, and cross-functional technical delivery.",
      "The position is full-time and based in Singapore with a hybrid work arrangement.",
    ].join(" ");

    expect(concisePosting.length).toBeLessThan(MIN_COMPLETE_DESCRIPTION_CHARS);
    expect(classifyDescriptionQuality(concisePosting)).toEqual({ status: "COMPLETE", reason: null });
  });

  it("rejects long cookie or login shells as incomplete source evidence", () => {
    const shell = `Accept all cookies. Sign in to continue. Enable JavaScript. ${"Please accept cookie preferences to continue. ".repeat(60)}`;
    expect(classifyDescriptionQuality(shell)).toMatchObject({
      status: "INCOMPLETE",
      reason: "DESCRIPTION_CONSISTS_OF_ACCESS_OR_COOKIE_SHELL",
    });
  });

  it("rejects generic company copy without job duties and qualifications", () => {
    const generic = [
      "Example Org is a global company with a diverse team and collaborative culture.",
      "We offer competitive benefits, professional development, flexible programs, and opportunities to make an impact.",
      "Our values include integrity, respect, inclusion, teamwork, innovation, and service to our customers.",
      "Join our talent community to learn about future opportunities and hear from our people.",
      "We are an equal opportunity employer and welcome applicants from every background.",
      "Explore our locations, teams, stories, events, benefits, and frequently asked questions.",
      "Candidate privacy information and accommodation details are available on our careers website.",
    ].join(" ");
    expect(generic.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(generic.split(/\s+/).length).toBeLessThanOrEqual(100);
    expect(classifyDescriptionQuality(generic).status).toBe("INCOMPLETE");
  });

  it("recognizes a substantive full-length posting as complete", () => {
    const fullPosting = [
      "About the role: Build and operate a research data platform used by scientists.",
      "Responsibilities: Design services, implement data workflows, and support production releases.",
      "Requirements: Experience with Python, cloud systems, and cross-functional technical delivery.",
    ].join(" ").repeat(8);

    expect(fullPosting.length).toBeGreaterThanOrEqual(MIN_COMPLETE_DESCRIPTION_CHARS);
    expect(classifyDescriptionQuality(fullPosting)).toEqual({ status: "COMPLETE", reason: null });
  });
});
