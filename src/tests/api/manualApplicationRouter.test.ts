import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchesExactFetchedPostingIdentity } from "../../api/v2/manualApplicationRouter.js";
import {
  ManualApprovalRequestSchema,
  ManualCandidateProfilesResponseSchema,
  ManualCompareResponseSchema,
  ManualDownloadResponseSchema,
  ManualFetchDescriptionResponseSchema,
  ManualPostingInputSchema,
  ManualPersistedApprovalSchema,
} from "../../contracts/manualApplication.js";
import { MANUAL_COMPARATOR_VERSION, validateManualApprovalCurrentness } from "../../documents/manualPreparation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const routerSource = fs.readFileSync(path.resolve(here, "../../api/v2/manualApplicationRouter.ts"), "utf8");
const migrationSource = fs.readFileSync(path.resolve(here, "../../../migrations/082_manual_application_preparation.sql"), "utf8");

const validPosting = {
  schema_version: "manual_application_v1" as const,
  candidate_profile_id: "55555555-5555-4555-8555-555555555555",
  source_kind: "PASTED" as const,
  title: "Data Architect",
  company: "Example",
  url: "https://example.test/careers/role",
  description: "A sufficiently detailed job description. ".repeat(4),
  location: "Singapore",
};

describe("manual application request and persistence contracts", () => {
  it("requires exact normalized fetched title/company and any supplied requisition ID", () => {
    const expected = {
      title: "Director, AI Solution Architect",
      company: "SMBC",
      requisitionId: "1441267233",
    };
    expect(matchesExactFetchedPostingIdentity(expected, {
      title: "director ai solution architect",
      companyName: "smbc",
      requisitionId: "1441267233",
    })).toBe(true);
    expect(matchesExactFetchedPostingIdentity(expected, {
      title: "Director, AI Solution Architect",
      companyName: "SMBC Group",
      requisitionId: "1441267233",
    })).toBe(false);
    expect(matchesExactFetchedPostingIdentity(expected, {
      title: "Director, AI Solution Architect",
      companyName: "SMBC",
      requisitionId: "1441267234",
    })).toBe(false);
    expect(matchesExactFetchedPostingIdentity({ title: "Role", company: "Example" }, {
      title: "Role",
      companyName: "Example Careers",
      requisitionId: null,
    })).toBe(false);
  });

  it("requires an explicit typed posting source and rejects incomplete or unknown inputs", () => {
    expect(ManualPostingInputSchema.parse(validPosting).source_kind).toBe("PASTED");
    expect(ManualPostingInputSchema.safeParse({ ...validPosting, source_kind: undefined }).success).toBe(false);
    expect(ManualPostingInputSchema.safeParse({ ...validPosting, untrusted_extra: true }).success).toBe(false);
    expect(ManualPostingInputSchema.safeParse({ ...validPosting, description: "short" }).success).toBe(false);
    expect(ManualPostingInputSchema.safeParse({ ...validPosting, url: "javascript:alert(1)" }).success).toBe(false);
    expect(ManualPostingInputSchema.safeParse({ ...validPosting, url: "https://user:pass@example.test/role" }).success).toBe(false);
    expect(ManualPostingInputSchema.safeParse({ ...validPosting, source_kind: "FETCHED" }).success).toBe(false);
    expect(ManualPostingInputSchema.safeParse({ ...validPosting, source_kind: "FETCHED", fetch_receipt_id: "77777777-7777-4777-8777-777777777777" }).success).toBe(true);
  });

  it("requires a complete retrieval receipt and exposes retry timing from safe fetch", () => {
    const response = {
      schema_version: "manual_application_v1",
      ok: true,
      fetch_receipt_id: "77777777-7777-4777-8777-777777777777",
      description: "A detailed verified job description. ".repeat(5),
      final_url: "https://example.test/role",
      provider: "EMPLOYER_WEBSITE",
      content_hash: "a".repeat(64),
      source_evidence: {
        requestedUrl: "https://example.test/role",
        resolvedUrl: "https://example.test/role",
        redirectHistory: [],
        retrievedAt: "2026-10-28T00:00:00.000Z",
        httpStatus: 200,
        contentType: "text/html",
        responseHash: "b".repeat(64),
      },
    };
    expect(ManualFetchDescriptionResponseSchema.safeParse(response).success).toBe(true);
    expect(ManualFetchDescriptionResponseSchema.safeParse({ ...response, source_evidence: undefined }).success).toBe(false);
    expect(routerSource).toContain("retry_after: retryAfter");
    expect(routerSource).toContain("manual_application_fetch_receipts");
    expect(routerSource).toContain("workspace_id=$2 AND user_id=$3 AND expires_at > NOW()");
    expect(routerSource).toContain("source_content_status: sourceContentStatus");
    expect(routerSource).toContain("source_evidence: fetchReceipt.source_evidence");
  });

  it("requires a selected workspace candidate and pins source evidence into comparison context", () => {
    expect(ManualCandidateProfilesResponseSchema.safeParse({
      schema_version: "manual_application_v1",
      ok: true,
      profiles: [{ candidate_profile_id: "55555555-5555-4555-8555-555555555555", display_name: "Candidate" }],
    }).success).toBe(true);
    expect(routerSource).toContain("router.get(\"/candidate-profiles\"");
    expect(routerSource).toContain("candidateProfileId: inputJob.candidate_profile_id");
    expect(routerSource).toContain("profile.candidate_profile_id = $2 AND profile.status = 'ACTIVE'");
    expect(routerSource).toContain("source_evidence_fingerprint: sha256(stableStringify({ source_observation_payload_hash: job.source_observation_payload_hash }))");
  });

  it("requires exact explicit approval and strict download runtime payloads", () => {
    expect(ManualApprovalRequestSchema.safeParse({ approved: true, comparison_fingerprint: "a".repeat(64) }).success).toBe(true);
    expect(ManualApprovalRequestSchema.safeParse({ approved: false, comparison_fingerprint: "a".repeat(64) }).success).toBe(false);
    expect(ManualDownloadResponseSchema.safeParse({ ok: true }).success).toBe(false);
    expect(ManualPersistedApprovalSchema.safeParse({ approved: true, id: "bad" }).success).toBe(false);
    expect(ManualCompareResponseSchema.safeParse({ ok: true, comparison: {} }).success).toBe(false);
  });

  it("pins approval to exact observation and invalidates any changed current input", () => {
    const pinned = {
      canonicalJobId: "11111111-1111-4111-8111-111111111111",
      jobVersionId: "22222222-2222-4222-8222-222222222222",
      sourceObservationId: "33333333-3333-4333-8333-333333333333",
      jobContentHash: "a".repeat(64),
      profileVersionId: "44444444-4444-4444-8444-444444444444",
      candidateProfileId: "55555555-5555-4555-8555-555555555555",
      profileContactFactIdsFingerprint: "b".repeat(64),
      profileContactFingerprint: "c".repeat(64),
      preferenceContextFingerprint: "d".repeat(64),
      requirementSetId: "66666666-6666-4666-8666-666666666666",
      comparatorVersion: MANUAL_COMPARATOR_VERSION,
      comparisonFingerprint: "e".repeat(64),
    };
    expect(validateManualApprovalCurrentness(pinned, pinned)).toEqual({ ok: true });
    for (const [key, value] of Object.entries(pinned)) {
      expect(validateManualApprovalCurrentness(pinned, { ...pinned, [key]: `${value}-changed` })).toEqual({ ok: false, reason: key });
    }
  });

  it("consumes safe-fetch and current-version APIs while keeping automatic decisions separate", () => {
    expect(routerSource).toContain("fetchJobContent(parsed.data.url");
    expect(routerSource).toContain("title: parsed.data.title");
    expect(routerSource).toContain("companyName: parsed.data.company");
    expect(routerSource).toContain("version.id = $3");
    expect(routerSource).toContain("observation.id = $4 AND observation.job_version_id = version.id");
    expect(routerSource).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(routerSource).toContain("ManualPersistedDraftSchema.parse");
    expect(routerSource).toContain("ManualPersistedApprovalSchema.parse");
    expect(routerSource).toContain("ManualDownloadResponseSchema.parse");
    expect(routerSource).toContain("ON CONFLICT (workspace_id,user_id,comparison_fingerprint,profile_contact_fact_ids) DO NOTHING RETURNING id");
    expect(routerSource).toContain("stableStringify(persistedDraft.comparison_payload) !== stableStringify(comparison)");
    expect(routerSource).toContain("manual_application_approval_contact_facts");
    expect(routerSource).not.toMatch(/INSERT\s+INTO\s+document_runs/i);
    expect(routerSource).not.toMatch(/INSERT\s+INTO\s+job_version_pipeline_state/i);
    expect(routerSource).not.toMatch(/UPDATE\s+application_records/i);
    expect(routerSource).not.toMatch(/APPLIED|SUBMITTED/);
    for (const name of [
      "manual_application_drafts_job_fk", "manual_application_drafts_source_fk",
      "manual_application_drafts_profile_fk", "manual_application_drafts_requirement_fk",
      "manual_application_approvals_comparison_context_fk", "manual_application_document_runs_approval_context_fk",
      "manual_application_document_artifacts_run_fk", "manual_application_draft_contact_facts_profile_fact_fk",
      "manual_application_fetch_receipts_membership_fk",
    ]) expect(migrationSource).toContain(name);
  });
});
