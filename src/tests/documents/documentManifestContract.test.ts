import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { stableStringify } from "../../config/structuredLoader.js";
import {
  DocumentOutputManifestRecordSchema,
  DocumentOutputManifestSchema,
} from "../../documents/contracts.js";
import { parseDocumentOutputManifest } from "../../documents/outputManifest.js";

const validManifest = {
  schema_version: "document_output_manifest_v1",
  json_path: "scripts/exports/candidate.cv.json",
  docx_path: "scripts/exports/candidate.docx",
  docx_sha256: "a".repeat(64),
  pdf_path: "scripts/exports/candidate.pdf",
  pdf_sha256: "b".repeat(64),
};

describe("versioned document output manifest", () => {
  it("accepts a complete DOCX/PDF manifest and persisted hash", () => {
    expect(DocumentOutputManifestSchema.safeParse(validManifest).success).toBe(true);
    expect(DocumentOutputManifestRecordSchema.safeParse({
      ...validManifest,
      manifest_hash: "c".repeat(64),
    }).success).toBe(true);
  });

  it("validates the persisted manifest hash over the versioned payload", () => {
    const manifestHash = createHash("sha256").update(stableStringify(validManifest)).digest("hex");
    expect(parseDocumentOutputManifest({ ...validManifest, manifest_hash: manifestHash }))
      .toMatchObject(validManifest);
    expect(() => parseDocumentOutputManifest({ ...validManifest, manifest_hash: "d".repeat(64) }))
      .toThrow(/manifest hash/i);
  });

  it("rejects missing schema versions, invalid hashes, partial PDFs, and unknown keys", () => {
    expect(DocumentOutputManifestSchema.safeParse({
      ...validManifest,
      schema_version: undefined,
    }).success).toBe(false);
    expect(DocumentOutputManifestSchema.safeParse({
      ...validManifest,
      docx_sha256: "not-a-hash",
    }).success).toBe(false);
    expect(DocumentOutputManifestSchema.safeParse({
      ...validManifest,
      pdf_sha256: null,
    }).success).toBe(false);
    expect(DocumentOutputManifestSchema.safeParse({
      ...validManifest,
      untracked_value: "not allowed",
    }).success).toBe(false);
  });
});
