import crypto from "node:crypto";
import pg from "pg";

import { CONTACT_FACT_DEFINITIONS, ContactFactRevisionSchema } from "../profile/contactFactContract.js";

export interface DocumentContactInfo {
  readonly full_name?: string;
  readonly location?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly linkedin?: string;
  readonly work_authorisation?: string;
}

export interface CvContactInfo {
  readonly full_name: string;
  readonly location: string;
  readonly email: string;
  readonly phone: string;
  readonly linkedin?: string;
  readonly work_authorisation?: string;
}

interface ProfileContactFactRow extends pg.QueryResultRow {
  readonly id: string;
  readonly fact_key: string;
  readonly fact_type: string;
  readonly structured_value: unknown;
  readonly verification_status: string;
  readonly confidentiality: string;
}

export interface ProfileContactSnapshot {
  readonly contact: DocumentContactInfo;
  readonly factIds: readonly string[];
  readonly fingerprint: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resolveDocumentContactInfo(
  profileContactFacts: readonly ProfileContactFactRow[],
  candidateName: string,
): DocumentContactInfo {
  const resolved: Record<string, string> = {};
  const graphValues = new Map<keyof DocumentContactInfo, string>();

  for (const fact of profileContactFacts) {
    if (fact.fact_type !== "CONTACT" || fact.confidentiality !== "PRIVATE_INTERNAL" ||
        !["VERIFIED", "SELF_ATTESTED"].includes(fact.verification_status)) continue;
    const parsed = ContactFactRevisionSchema.safeParse(fact);
    if (!parsed.success) throw new Error(`Profile contact fact ${fact.fact_key} violates the contact fact contract.`);
    const definition = CONTACT_FACT_DEFINITIONS[parsed.data.fact_key];
    const previous = graphValues.get(definition.field);
    if (previous && previous !== parsed.data.structured_value.value) {
      throw new Error(`Multiple active profile contact facts conflict for ${definition.field}.`);
    }
    graphValues.set(definition.field, parsed.data.structured_value.value);
  }

  for (const [field, value] of graphValues) resolved[field] = value;
  if (!resolved.full_name && candidateName.trim()) resolved.full_name = candidateName.trim();

  return {
    ...(resolved.full_name ? { full_name: resolved.full_name } : {}),
    ...(resolved.location ? { location: resolved.location } : {}),
    ...(resolved.email ? { email: resolved.email } : {}),
    ...(resolved.phone ? { phone: resolved.phone } : {}),
    ...(resolved.linkedin ? { linkedin: resolved.linkedin } : {}),
    ...(resolved.work_authorisation ? { work_authorisation: resolved.work_authorisation } : {}),
  };
}

export async function loadProfileContactSnapshot(
  clientOrPool: pg.Pool | pg.PoolClient,
  workspaceId: string,
  profileVersionId: string,
  candidateName: string,
): Promise<ProfileContactSnapshot> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const result = await client.query<ProfileContactFactRow>(
      `SELECT id::text, fact_key, fact_type, structured_value, verification_status, confidentiality
       FROM profile_facts
       WHERE workspace_id = $1
         AND profile_version_id = $2
         AND fact_type = 'CONTACT'
         AND confidentiality = 'PRIVATE_INTERNAL'
         AND verification_status IN ('VERIFIED', 'SELF_ATTESTED')
         AND is_current = TRUE
       ORDER BY fact_key`,
      [workspaceId, profileVersionId],
    );
    const orderedRows = [...result.rows].sort((left, right) => left.fact_key.localeCompare(right.fact_key));
    const fingerprint = crypto.createHash("sha256").update(stableStringify({
      facts: orderedRows,
      candidateNameFallback: candidateName.trim(),
    })).digest("hex");
    return {
      contact: resolveDocumentContactInfo(orderedRows, candidateName),
      factIds: orderedRows.map((row) => row.id),
      fingerprint,
    };
  } finally {
    if (ownsClient) client.release();
  }
}

export async function loadProfileContactInfo(
  clientOrPool: pg.Pool | pg.PoolClient,
  workspaceId: string,
  profileVersionId: string,
  candidateName: string,
): Promise<DocumentContactInfo> {
  return (await loadProfileContactSnapshot(clientOrPool, workspaceId, profileVersionId, candidateName)).contact;
}

export function requireDocumentCandidateName(contact: DocumentContactInfo): string {
  const fullName = contact.full_name?.trim();
  if (!fullName) throw new Error("Active profile contact information is missing the candidate name (full_name).");
  return fullName;
}

export function requireCvContactInfo(contact: DocumentContactInfo): CvContactInfo {
  const fullName = requireDocumentCandidateName(contact);
  const location = contact.location?.trim();
  const email = contact.email?.trim();
  const phone = contact.phone?.trim();
  const missing = [
    !location && "location",
    !email && "email",
    !phone && "phone",
  ].filter((field): field is string => Boolean(field));
  if (!fullName || !location || !email || !phone) {
    throw new Error(`Active profile contact information is missing required fields: ${missing.join(", ")}.`);
  }
  return {
    full_name: fullName,
    location,
    email,
    phone,
    ...(contact.linkedin?.trim() ? { linkedin: contact.linkedin.trim() } : {}),
    ...(contact.work_authorisation?.trim() ? { work_authorisation: contact.work_authorisation.trim() } : {}),
  };
}

export function formatContactLine(contact: DocumentContactInfo): string {
  return [contact.location, contact.phone, contact.email, contact.linkedin]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .join(" | ");
}
