import { z } from "zod";

export const SCHEMA_VERSION = "2.3.0" as const;
export const LEGACY_SCHEMA_VERSIONS = ["2.2.0", "2.0", "1.0.0"] as const;

const schemaVersions = [SCHEMA_VERSION, ...LEGACY_SCHEMA_VERSIONS] as const;

export const SchemaVersionSchema = z.enum(schemaVersions);
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

// Version pins for persisted artifacts (kept central to avoid drift across stages).
// Gate-logic version, independent of the schema version. Bump it whenever gate
// semantics change so stored decisions can be selected by the logic that wrote them.
// 2026-11: on-site exceptions, Axis 1/2 rejects removed, title families as NON_TARGET_ROLE_FAMILY,
// precise travel/on-call/shift/location codes.
// 2026-11.2: foreign citizenship and government security-clearance requirements are
// WORK_AUTHORIZATION_INCOMPATIBLE with quoted evidence.
// 2026-11.3: workplace perk phrases are neutral work-mode evidence; for a
// Singapore-located job an explicit on-site statement overrides the assumed-hybrid default.
// 2026-11.4: a "Job Location:" / "Location:" header line fills an unknown structured location;
// "Work Type: Office Working" is full on-site; each gate verification names its own open fact;
// pre-sales / post-sales / customer-engagement role duties are GATE_HIGH_INTERACTION for any title.
export const GATE_VERSION = "gate-2026-11.4" as const;
export const PROFILE_SCHEMA_VERSION = SCHEMA_VERSION;

