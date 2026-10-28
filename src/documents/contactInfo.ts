import fs from "node:fs";
import path from "node:path";

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
  readonly fact_key: string;
  readonly fact_type: string;
  readonly structured_value: unknown;
  readonly verification_status: string;
  readonly confidentiality: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? Object.fromEntries(Object.entries(candidate))
    : null;
}

function fallbackContact(value: unknown): DocumentContactInfo {
  const record = asRecord(value);
  if (!record) return {};
  const contact = asRecord(record.contact) ?? record;
  const take = (primary: string, alternate?: string): string | undefined => {
    const candidate = contact[primary] ?? (alternate ? contact[alternate] : undefined);
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
  };
  return {
    full_name: take("full_name", "name"),
    location: take("location"),
    email: take("email"),
    phone: take("phone"),
    linkedin: take("linkedin"),
    work_authorisation: take("work_authorisation"),
  };
}

function optionalEnvironmentJson(name: string): unknown | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function legacyContactFallback(): DocumentContactInfo {
  const root = process.cwd();
  const sources: unknown[] = [];
  const masterProfilePath = path.join(root, "master_profile.json");
  const contactPath = path.join(root, "private", "profile", "contact.json");

  if (fs.existsSync(masterProfilePath)) sources.push(JSON.parse(fs.readFileSync(masterProfilePath, "utf8")));
  if (fs.existsSync(contactPath)) sources.push(JSON.parse(fs.readFileSync(contactPath, "utf8")));
  const masterProfile = optionalEnvironmentJson("MASTER_PROFILE_JSON");
  if (masterProfile) sources.push(masterProfile);
  const documentContact = optionalEnvironmentJson("DOCUMENT_CONTACT_JSON");
  if (documentContact) sources.push(documentContact);

  const merged: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(fallbackContact(source))) {
      if (typeof value === "string") merged[key] = value;
    }
  }
  return merged;
}

export function resolveDocumentContactInfo(
  profileContactFacts: readonly ProfileContactFactRow[],
  fallback: unknown,
  candidateName: string,
): DocumentContactInfo {
  const resolved: Record<string, string> = Object.fromEntries(
    Object.entries(fallbackContact(fallback)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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

export async function loadProfileContactInfo(
  clientOrPool: pg.Pool | pg.PoolClient,
  workspaceId: string,
  profileVersionId: string,
  candidateName: string,
): Promise<DocumentContactInfo> {
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === "function" && !("release" in value);
  const ownsClient = isPool(clientOrPool);
  const client = ownsClient ? await clientOrPool.connect() : clientOrPool;

  try {
    const result = await client.query<ProfileContactFactRow>(
      `SELECT fact_key, fact_type, structured_value, verification_status, confidentiality
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
    const graphContact = resolveDocumentContactInfo(result.rows, null, candidateName);
    const graphHasRequiredContact = Boolean(
      graphContact.full_name && graphContact.location && graphContact.email && graphContact.phone,
    );
    return graphHasRequiredContact
      ? graphContact
      : resolveDocumentContactInfo(result.rows, legacyContactFallback(), candidateName);
  } finally {
    if (ownsClient) client.release();
  }
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
