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
// 2026-11.5: a pre-sales title ("Presales", "Pre-Sales", "Pre Sales") is GATE_HIGH_INTERACTION.
// 2026-11.6: no change to any decision rule. A version-change re-gate whose outcome is unchanged only stamps the audit row
// (runHardGates versionRefresh); flagNeedsVerification records a work-fact contradiction as NEEDS_VERIFICATION (hardGate.ts).
// 2026-11.7: owner decision 2026-11-25 (decision #213): a bare pre-sales / customer-engagement duty phrase or the keywords
// "sales engineering" / "presales" / "pre-sales" no longer reject; GATE_HIGH_INTERACTION needs explicit evidence (quota, sales
// target, commission-based pay, cold outbound duty, pre-sales or FDE title, interaction share over the cap). The phrase is a
// role-shape downrank (role_shape_v2).
// 2026-11.8: commission, OTE, quota and cold calling reject only as this role's main variable pay or explicit sales duty (customerFacingDuties.ts);
// generic option lists, commission opportunities, commission paid to others and other roles' commission no longer reject.
// 2026-11.9: the pronoun "us", export-control licence boilerplate, fair-chance hiring notices and an employer's own
// licence ("authorized by ...") no longer state a worker-territory restriction; a title family (DevOps, QA, ...) rejects
// only as the title's main role, not as a qualifier after a distinct role.
export const GATE_VERSION = "gate-2026-11.9" as const;
export const PROFILE_SCHEMA_VERSION = SCHEMA_VERSION;

