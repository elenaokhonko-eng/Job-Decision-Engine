import { z } from "zod";

export const SCHEMA_VERSION = "2.2.0" as const;
export const LEGACY_SCHEMA_VERSIONS = ["2.0", "1.0.0"] as const;

const schemaVersions = [SCHEMA_VERSION, ...LEGACY_SCHEMA_VERSIONS] as const;

export const SchemaVersionSchema = z.enum(schemaVersions);
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

// Version pins for persisted artifacts (kept central to avoid drift across stages).
export const GATE_VERSION = SCHEMA_VERSION;
export const PROFILE_SCHEMA_VERSION = SCHEMA_VERSION;

