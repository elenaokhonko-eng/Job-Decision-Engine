import { createHash } from "node:crypto";

import type { z } from "zod";

import { stableStringify } from "../config/structuredLoader.js";
import { DocumentOutputManifestRecordSchema } from "./contracts.js";

export type DocumentOutputManifestRecord = z.infer<typeof DocumentOutputManifestRecordSchema>;

export function parseDocumentOutputManifest(value: unknown): DocumentOutputManifestRecord {
  const parsed = DocumentOutputManifestRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error("Persisted document output manifest violates its versioned schema.");
  const { manifest_hash: manifestHash, ...manifestPayload } = parsed.data;
  const actualHash = createHash("sha256").update(stableStringify(manifestPayload)).digest("hex");
  if (actualHash !== manifestHash) throw new Error("Persisted document output manifest hash is invalid.");
  return parsed.data;
}
