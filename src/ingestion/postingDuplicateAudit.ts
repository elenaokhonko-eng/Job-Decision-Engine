import { createHash } from "node:crypto";

export interface PostingDuplicateRecord {
  readonly workspace_id: string;
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly source_posting_identity_hash: string;
  readonly company_name: string;
  readonly location: string | null;
  readonly canonical_created_at: string;
  readonly current_version_observation_count: number;
}

export interface PostingDuplicateMappingCandidate {
  readonly proposal_id: string;
  readonly workspace_id: string;
  readonly source_posting_identity_hash: string;
  readonly normalized_company: string;
  readonly normalized_location: string;
  readonly proposed_survivor_canonical_job_id: string;
  readonly duplicate_canonical_job_ids: readonly string[];
  readonly members: readonly PostingDuplicateRecord[];
  readonly disposition: "REVIEW_REQUIRED_NO_DATA_MERGED";
}

export interface PostingDuplicateAuditReport {
  readonly schema_version: "posting_duplicate_audit_v1";
  readonly source_identity_groups: number;
  readonly candidate_groups: number;
  readonly candidate_canonical_jobs: number;
  readonly proposed_duplicate_links: number;
  readonly identity_collision_groups: number;
  readonly insufficient_identity_groups: number;
  readonly mappings: readonly PostingDuplicateMappingCandidate[];
}

function normalizeCompany(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return normalized === "unknown" || normalized === "unknown company" ? "" : normalized;
}

function normalizeLocation(value: string | null): string {
  const tokens = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || ["unknown", "unspecified", "not specified", "n a"].includes(tokens.join(" "))) return "";
  if (tokens.length === 1 && ["remote", "worldwide", "global"].includes(tokens[0] ?? "")) return "";
  return tokens.sort().join(" ");
}

function proposalId(record: PostingDuplicateRecord, company: string, location: string): string {
  return createHash("sha256")
    .update([record.workspace_id, record.source_posting_identity_hash, company, location].join("\u001f"))
    .digest("hex");
}

function survivorOrder(left: PostingDuplicateRecord, right: PostingDuplicateRecord): number {
  if (left.current_version_observation_count !== right.current_version_observation_count) {
    return right.current_version_observation_count - left.current_version_observation_count;
  }
  const creationOrder = left.canonical_created_at.localeCompare(right.canonical_created_at);
  return creationOrder || left.canonical_job_id.localeCompare(right.canonical_job_id);
}

export function buildPostingDuplicateAuditReport(
  records: readonly PostingDuplicateRecord[],
): PostingDuplicateAuditReport {
  const identityGroups = new Map<string, PostingDuplicateRecord[]>();
  for (const record of records) {
    const key = `${record.workspace_id}\u001f${record.source_posting_identity_hash}`;
    const group = identityGroups.get(key) ?? [];
    group.push(record);
    identityGroups.set(key, group);
  }

  const mappings: PostingDuplicateMappingCandidate[] = [];
  let identityCollisionGroups = 0;
  let insufficientIdentityGroups = 0;
  for (const group of identityGroups.values()) {
    const distinctCanonicalIds = new Set(group.map((record) => record.canonical_job_id));
    if (distinctCanonicalIds.size < 2) continue;
    const hasUnverifiedIdentity = group.some((record) => !normalizeCompany(record.company_name) || !normalizeLocation(record.location));
    if (hasUnverifiedIdentity) insufficientIdentityGroups += 1;

    const locationGroups = new Map<string, PostingDuplicateRecord[]>();
    for (const record of group) {
      const company = normalizeCompany(record.company_name);
      const location = normalizeLocation(record.location);
      const key = `${company}\u001f${location}`;
      const samePosting = locationGroups.get(key) ?? [];
      samePosting.push(record);
      locationGroups.set(key, samePosting);
    }
    if (locationGroups.size > 1) identityCollisionGroups += 1;

    for (const subgroup of locationGroups.values()) {
      if (new Set(subgroup.map((record) => record.canonical_job_id)).size < 2) continue;
      const company = normalizeCompany(subgroup[0]?.company_name ?? "");
      const location = normalizeLocation(subgroup[0]?.location ?? null);
      if (!company || !location) {
        if (!hasUnverifiedIdentity) insufficientIdentityGroups += 1;
        continue;
      }
      const ordered = [...subgroup].sort(survivorOrder);
      const survivor = ordered[0];
      if (!survivor) continue;
      mappings.push({
        proposal_id: proposalId(survivor, company, location),
        workspace_id: survivor.workspace_id,
        source_posting_identity_hash: survivor.source_posting_identity_hash,
        normalized_company: company,
        normalized_location: location,
        proposed_survivor_canonical_job_id: survivor.canonical_job_id,
        duplicate_canonical_job_ids: ordered.slice(1).map((record) => record.canonical_job_id),
        members: ordered,
        disposition: "REVIEW_REQUIRED_NO_DATA_MERGED",
      });
    }
  }

  mappings.sort((left, right) =>
    left.workspace_id.localeCompare(right.workspace_id)
      || left.source_posting_identity_hash.localeCompare(right.source_posting_identity_hash)
      || left.proposal_id.localeCompare(right.proposal_id)
  );
  return {
    schema_version: "posting_duplicate_audit_v1",
    source_identity_groups: identityGroups.size,
    candidate_groups: mappings.length,
    candidate_canonical_jobs: mappings.reduce((count, mapping) => count + mapping.members.length, 0),
    proposed_duplicate_links: mappings.reduce((count, mapping) => count + mapping.duplicate_canonical_job_ids.length, 0),
    identity_collision_groups: identityCollisionGroups,
    insufficient_identity_groups: insufficientIdentityGroups,
    mappings,
  };
}
