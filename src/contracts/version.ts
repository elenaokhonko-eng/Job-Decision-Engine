import { z } from "zod";

export const SCHEMA_VERSION = "2.2.0" as const;
export const LEGACY_SCHEMA_VERSIONS = ["2.0", "1.0.0"] as const;

const schemaVersions = [SCHEMA_VERSION, ...LEGACY_SCHEMA_VERSIONS] as const;

export const SchemaVersionSchema = z.enum(schemaVersions);
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

