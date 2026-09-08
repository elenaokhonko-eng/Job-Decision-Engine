import pg from "pg";
import dotenv from "dotenv";
import {
  applyGlobalGates,
  GLOBAL_TITLE_EXCLUSIONS,
  isTechnicalRole,
  type GateResult,
} from "../services/criteria.js";
import { GATE_VERSION } from "../contracts/version.js";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { calculateProfessionalExperienceYears, compareStructuredRequirement, type ComparableFact } from "./requirementComparators.js";
import { loadWorkabilityPolicy } from "./workabilityPolicy.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

interface PersistedRequirement {
  requirement_key: string;
  requirement_type: string;
  requirement_text: string;
  quote_text: string | null;
  structured_value: Record<string, unknown> | null;
}

function makePass(extraFacts?: Partial<GateResult["workability_facts"]>): GateResult {
  return {
    passed: true,
    status: "PASS",
    rejection_codes: [],
    evidence_quotes: [],
    workability_facts: {
      office_days_min: null,
      office_days_max: null,
      travel_pct_max: null,
      employment_type: "UNKNOWN",
      location_restriction: null,
      ...extraFacts,
    },
  };
}

function makeReject(
  codes: string[],
  evidence: string[],
  facts?: Partial<GateResult["workability_facts"]>
): GateResult {
  return {
    passed: false,
    status: "HARD_REJECT",
    rejection_code: codes[0],
    rejection_codes: codes,
    evidence_quotes: evidence,
    workability_facts: {
      office_days_min: null,
      office_days_max: null,
      travel_pct_max: null,
      employment_type: "UNKNOWN",
      location_restriction: null,
      ...facts,
    },
  };
}

function makeVerification(
  codes: string[],
  evidence: string[],
  facts?: Partial<GateResult["workability_facts"]>
): GateResult {
  return {
    passed: false,
    status: "NEEDS_VERIFICATION",
    rejection_code: codes[0],
    rejection_codes: codes,
    evidence_quotes: evidence,
    workability_facts: {
      office_days_min: null,
      office_days_max: null,
      travel_pct_max: null,
      employment_type: "UNKNOWN",
      location_restriction: null,
      ...facts,
    },
  };
}

function quoteOrText(req: PersistedRequirement): string {
  return req.quote_text || req.requirement_text;
}

function detectOfficeDays(req: PersistedRequirement): number | null {
  const structured = req.structured_value || {};
  for (const key of ["office_days_per_week", "max_office_days_per_week", "office_days_max", "office_days_min"]) {
    const raw = structured[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  const txt = quoteOrText(req);
  const m = txt.match(/([1-5])\s*days?/i);
  return m ? Number(m[1]) : null;
}

function detectTravelPct(req: PersistedRequirement): number | null {
  const structured = req.structured_value || {};
  for (const key of ["max_travel_pct", "travel_pct_max", "travel_percentage", "maximum_travel_pct"]) {
    const raw = structured[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }
  const txt = quoteOrText(req);
  const m = txt.match(/(\d{1,2})%/);
  return m ? Number(m[1]) : null;
}

function structuredNumber(req: PersistedRequirement, keys: string[]): number | null {
  for (const key of keys) {
    const value = req.structured_value?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

export function applyPersistedRequirementGates(
  job: {
    title: string;
    company_name: string;
    employment_type?: string;
    description?: string;
  },
  deterministicRequirements: PersistedRequirement[]
): GateResult {
  const title = job.title || "";
  const policy = loadWorkabilityPolicy();
  let pendingVerification: { codes: string[]; evidence: string[]; facts?: Partial<GateResult["workability_facts"]> } | null = null;
  for (const pattern of GLOBAL_TITLE_EXCLUSIONS) {
    if (pattern.test(title)) {
      return makeReject(
        ["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"],
        [`Non-target title exclusion: "${title}"`]
      );
    }
  }

  const functionRequirements = deterministicRequirements.filter(
    (r) => r.requirement_type === "FUNCTION"
  );
  const domainRequirements = deterministicRequirements.filter(
    (r) => r.requirement_type === "DOMAIN"
  );

  const hasSemanticSignals = functionRequirements.length > 0 || domainRequirements.length > 0;
  const semanticCorpus = [...functionRequirements, ...domainRequirements]
    .map((r) => quoteOrText(r).toLowerCase())
    .concat(job.description ? [job.description.toLowerCase()] : [])
    .join(" \n");

  let hasTechnicalEvidence = false;
  if (hasSemanticSignals) {
    hasTechnicalEvidence = /(engineer|architect|developer|scientist|machine learning|artificial intelligence|ai\b|llm|nlp|data|bioinformatics|genomics|regtech|legaltech|quant|fintech|trading)/i.test(
      semanticCorpus
    );
  } else {
    const textCorpus = deterministicRequirements
      .map((r) => quoteOrText(r).toLowerCase())
      .concat(job.description ? [job.description.toLowerCase()] : [])
      .join(" \n");
    const techCheck = isTechnicalRole(title, textCorpus);
    hasTechnicalEvidence = techCheck.isTechnical;
  }

  if (!hasTechnicalEvidence) {
    return makeReject(
      ["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"],
      [
        hasSemanticSignals
          ? "Persisted FUNCTION/DOMAIN requirements indicate non-technical scope"
          : "Axis 1 Failed: Role lacks evidence of technical function",
      ]
    );
  }

  for (const requirement of deterministicRequirements) {
    const buildingPct = structuredNumber(requirement, [
      "building_research_pct",
      "minimum_building_research_pct",
      "hands_on_pct",
      "implementation_pct",
    ]);
    if (buildingPct !== null && buildingPct < policy.minimumBuildingResearchPct) {
      return makeReject(["GATE_BUILDING_RESEARCH_RATIO"], [quoteOrText(requirement)], {
        office_days_min: null,
        office_days_max: null,
      });
    }

    const interactionPct = structuredNumber(requirement, [
      "interaction_pct",
      "maximum_interaction_pct",
      "stakeholder_pct",
      "client_facing_pct",
    ]);
    if (interactionPct !== null && interactionPct > policy.maximumInteractionPct) {
      return makeReject(["GATE_HIGH_INTERACTION"], [quoteOrText(requirement)]);
    }

    const travelPct = structuredNumber(requirement, [
      "max_travel_pct",
      "travel_pct_max",
      "travel_percentage",
      "maximum_travel_pct",
    ]);
    if (travelPct !== null && travelPct > policy.maxTravelPct) {
      return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(requirement)], {
        travel_pct_max: travelPct,
      });
    }
  }

  const employmentReq = deterministicRequirements.find((r) => r.requirement_type === "EMPLOYMENT_TYPE");
  const normalizedEmployment = (employmentReq ? quoteOrText(employmentReq) : (job.employment_type || "")).toLowerCase();
  const employmentType = normalizedEmployment.includes("contract")
    ? "CONTRACT" as const
    : /\b(permanent|full[-_ ]?time|fte)\b/i.test(normalizedEmployment)
      ? "PERMANENT" as const
      : "UNKNOWN" as const;
  if (employmentType === "CONTRACT") {
    return makeReject(
      ["GATE_CONTRACT_ROLE"],
      [employmentReq ? quoteOrText(employmentReq) : "Structured employment_type is CONTRACT"],
      { employment_type: "CONTRACT" }
    );
  }

  const officeRequirements = deterministicRequirements.filter((r) => r.requirement_type === "OFFICE_DAYS");
  const officeReq = officeRequirements[0];
  for (const requirement of officeRequirements) {
    const days = detectOfficeDays(requirement);
    if (days !== null && days >= policy.hardFailOfficeDaysPerWeek) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        [quoteOrText(requirement)],
        { office_days_min: days, office_days_max: days }
      );
    }
    if (days === null) {
      pendingVerification = {
        codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
        evidence: [quoteOrText(requirement)],
        facts: { office_days_min: null, office_days_max: null },
      };
    }
  }

  const workModeReq = deterministicRequirements.find((r) => r.requirement_type === "WORK_MODE");
  if (workModeReq) {
    const mode = quoteOrText(workModeReq).toLowerCase();
    if (!policy.onsiteOnlyAllowed && (
      mode.includes("onsite only") ||
      mode.includes("on-site only") ||
      mode.includes("fully on-site") ||
      mode.includes("fully onsite") ||
      mode.includes("100% on-site") ||
      mode.includes("100% onsite")
    )) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        [quoteOrText(workModeReq)],
        { office_days_min: policy.hardFailOfficeDaysPerWeek, office_days_max: 5 }
      );
    }
  }

  const travelRequirements = deterministicRequirements.filter((r) => r.requirement_type === "TRAVEL");
  const travelReq = travelRequirements[0];
  for (const requirement of travelRequirements) {
    const travelPct = detectTravelPct(requirement);
    const txt = quoteOrText(requirement).toLowerCase();
    if ((travelPct !== null && travelPct > policy.maxTravelPct) || (txt.includes("frequent travel") && !policy.frequentTravelAllowed)) {
      return makeReject(
        ["GATE_LIFESTYLE_INCOMPATIBLE"],
        [quoteOrText(requirement)],
        { travel_pct_max: travelPct }
      );
    }
  }

  const onCallReq = deterministicRequirements.find((r) => r.requirement_type === "ON_CALL");
  if (onCallReq && !policy.regularOnCallAllowed) {
    return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(onCallReq)]);
  }

  const shiftReq = deterministicRequirements.find((r) => r.requirement_type === "SHIFT_WORK");
  if (shiftReq && !policy.shiftWorkAllowed) {
    return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(shiftReq)]);
  }

  const workAuthReq = deterministicRequirements.find((r) => r.requirement_type === "WORK_AUTH");
  if (workAuthReq) {
    const authText = quoteOrText(workAuthReq).toLowerCase();
    const blockedTerms = ["us only", "australian work rights", "canada only", "eu only", "uk only"];
    for (const term of blockedTerms) {
      if (authText.includes(term)) {
        return makeReject(
          ["GATE_LOCATION_RESTRICTED"],
          [quoteOrText(workAuthReq)],
          { location_restriction: term.toUpperCase() }
        );
      }
    }
  }

  if (workModeReq && quoteOrText(workModeReq).toLowerCase().includes("hybrid") && officeRequirements.length === 0) {
    pendingVerification = {
      codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
      evidence: [quoteOrText(workModeReq)],
      facts: { office_days_min: null, office_days_max: null },
    };
  }

  if (pendingVerification) {
    return makeVerification(pendingVerification.codes, pendingVerification.evidence, pendingVerification.facts);
  }

  return makePass({
    office_days_min: officeReq ? detectOfficeDays(officeReq) : null,
    office_days_max: officeReq ? detectOfficeDays(officeReq) : null,
    travel_pct_max: travelReq ? detectTravelPct(travelReq) : null,
    employment_type: employmentType,
  });
}

function combineGateResults(results: GateResult[]): GateResult {
  const hardReject = results.find((result) => result.status === "HARD_REJECT");
  const verification = results.find((result) => result.status === "NEEDS_VERIFICATION");
  const selected = hardReject || verification || results[0] || makePass();
  const rejectionCodes = [...new Set(results.flatMap((result) => result.rejection_codes))];
  const evidenceQuotes = [...new Set(results.flatMap((result) => result.evidence_quotes))];

  const workabilityFacts = { ...makePass().workability_facts };
  for (const result of results) {
    for (const [key, value] of Object.entries(result.workability_facts)) {
      if (value !== null && value !== undefined) {
        (workabilityFacts as Record<string, unknown>)[key] = value;
      }
    }
  }

  return {
    ...selected,
    rejection_code: rejectionCodes[0],
    rejection_codes: rejectionCodes,
    evidence_quotes: evidenceQuotes,
    workability_facts: workabilityFacts,
  };
}

function applyExactProfileGates(
  deterministicRequirements: PersistedRequirement[],
  profileFacts: ComparableFact[]
): GateResult {
  const exactRequirements = deterministicRequirements.filter((requirement) =>
    ["EXPERIENCE_YEARS", "CREDENTIAL", "DEGREE", "WORK_AUTH"].includes(requirement.requirement_type)
  );
  if (exactRequirements.length === 0) return makePass();

  const mismatches: string[] = [];
  const mismatchEvidence: string[] = [];
  const unknowns: string[] = [];
  const unknownEvidence: string[] = [];
  for (const requirement of exactRequirements) {
    const comparison = compareStructuredRequirement(requirement, profileFacts);
    if (comparison.status === "MISMATCH") {
      mismatches.push(`GATE_${requirement.requirement_type}_MISMATCH`);
      mismatchEvidence.push(comparison.rationale);
    } else if (comparison.status === "UNKNOWN") {
      unknowns.push(`NEEDS_VERIFICATION_${requirement.requirement_type}`);
      unknownEvidence.push(comparison.rationale);
    }
  }

  if (mismatches.length > 0) return makeReject(mismatches, mismatchEvidence);
  if (unknowns.length > 0) return makeVerification(unknowns, unknownEvidence);
  return makePass();
}

export async function runHardGates(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext; jobVersionIds?: string[]; canonicalJobIds?: string[]; limit?: number }
): Promise<{ passed: number; hardRejected: number; needsVerification: number; errors: number }> {
  console.log("Starting Hard Gate engine on RAW_STAGED canonical jobs...");
  const pool = clientOrPool || defaultPool;

  let passedCount = 0;
  let rejectedCount = 0;
  let needsVerificationCount = 0;
  let errorCount = 0;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));
  const params: unknown[] = [ctx.workspaceId];
  const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
  const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
  const jobVersionFilter = jobVersionIds.length > 0
    ? `AND jv.id = ANY($${params.push(jobVersionIds)}::uuid[])`
    : "";
  const canonicalJobFilter = canonicalJobIds.length > 0
    ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])`
    : "";
  const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
    ? Number(options?.limit)
    : null;
  const limitClause = limit ? `LIMIT $${params.push(limit)}` : "";

  const { rows: stagedJobs } = await client.query(
    `
      SELECT c.*, jv.description_text, jv.id AS job_version_id
      FROM canonical_jobs c
      JOIN job_versions jv ON jv.id = COALESCE(
        c.latest_job_version_id,
        (
          SELECT jv2.id
          FROM job_versions jv2
          WHERE jv2.workspace_id = $1
            AND jv2.canonical_job_id = c.id
          ORDER BY jv2.observed_at DESC
          LIMIT 1
        )
      )
      WHERE c.workspace_id = $1
        AND jv.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
        ${jobVersionFilter}
        ${canonicalJobFilter}
      ORDER BY c.created_at ASC, c.id ASC
      ${limitClause}
    `,
    params
  );

  console.log(`Found ${stagedJobs.length} canonical jobs to gate.`);
  try {
    for (const job of stagedJobs) {
      await client.query("BEGIN");
      try {
        const rawJobAdapter = {
          id: job.id,
          title: job.normalized_title,
          company_name: job.company_name,
          source: "canonical",
          raw_description: job.description_text,
          careers_portal_url: job.canonical_url,
          location: job.location,
          workplace_type: job.workplace_type,
          employment_type: job.employment_type
        };

        const { rows: requirementRows } = await client.query(
          `SELECT requirement_key, requirement_type, requirement_text, quote_text, structured_value
           FROM job_versions jv
           JOIN job_requirements jr
             ON jr.workspace_id = jv.workspace_id
            AND (
              (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
              OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
            )
           WHERE jv.workspace_id = $1
             AND jv.id = $2
             AND jr.status = 'VALIDATED'
           ORDER BY jr.requirement_key ASC`,
          [ctx.workspaceId, job.job_version_id]
        );

        const deterministicRequirements = requirementRows as PersistedRequirement[];
        let profileFacts: ComparableFact[] = [];
        if (deterministicRequirements.some((requirement) =>
          ["EXPERIENCE_YEARS", "CREDENTIAL", "DEGREE", "WORK_AUTH"].includes(requirement.requirement_type)
        )) {
          const { rows: activeProfileRows } = await client.query<{ id: string }>(
            `SELECT id
             FROM profile_versions
             WHERE workspace_id = $1
               AND status = 'ACTIVE'
             ORDER BY created_at DESC
             LIMIT 1`,
            [ctx.workspaceId]
          );
          const activeProfileVersionId = activeProfileRows[0]?.id ?? null;
          const { rows: profileFactRows } = await client.query(
            `SELECT pf.id, pf.statement, pf.structured_value
             FROM profile_facts pf
             WHERE pf.workspace_id = $1
             ${activeProfileVersionId ? "AND pf.profile_version_id = $2" : "AND FALSE"}`,
            activeProfileVersionId ? [ctx.workspaceId, activeProfileVersionId] : [ctx.workspaceId]
          );
          profileFacts = profileFactRows as ComparableFact[];
          const { rows: credentialRows } = await client.query(
            `SELECT pc.id, pc.credential_name, pc.issuer, pc.credential_type, pc.level
             FROM profile_credentials pc
             WHERE pc.workspace_id = $1
               ${activeProfileVersionId ? "AND pc.profile_version_id = $2" : "AND FALSE"}
             AND pc.status = 'ACTIVE'`,
            activeProfileVersionId ? [ctx.workspaceId, activeProfileVersionId] : [ctx.workspaceId]
          );
          profileFacts = profileFacts.concat(
            credentialRows.map((credential: any) => ({
              id: credential.id,
              statement: `${credential.credential_name} ${credential.issuer} ${credential.level || ""}`.trim(),
              structured_value: { credential_type: credential.credential_type, level: credential.level },
              source_type: "CREDENTIAL" as const,
            }))
          );
          const { rows: engagementRows } = await client.query(
            `SELECT start_date, end_date, is_current, experience_class
             FROM profile_engagements
             WHERE profile_version_id = $1`,
            [activeProfileVersionId]
          );
          const experienceYears = calculateProfessionalExperienceYears(engagementRows);
          if (experienceYears > 0) {
            profileFacts.push({
              id: `experience:${ctx.workspaceId}`,
              statement: `${experienceYears.toFixed(1)} years of professional production experience`,
              structured_value: { professional_years: experienceYears },
              source_type: "CREDENTIAL",
            });
          }
        }
        const requirementHints = deterministicRequirements
          .map((r) => r.quote_text || r.requirement_text)
          .filter(Boolean)
          .slice(0, 60)
          .join("\n");

        const globalGateResult = applyGlobalGates({
          ...(rawJobAdapter as any),
          raw_description: requirementHints
            ? `${rawJobAdapter.raw_description}\n\n---\nExtracted requirements:\n${requirementHints}`
            : rawJobAdapter.raw_description,
        } as any);
        const persistedGateResult = applyPersistedRequirementGates(
          {
            title: rawJobAdapter.title,
            company_name: rawJobAdapter.company_name,
            employment_type: rawJobAdapter.employment_type,
            description: rawJobAdapter.raw_description,
          },
          deterministicRequirements
        );
        const exactProfileGateResult = applyExactProfileGates(deterministicRequirements, profileFacts);
        const gateResult = combineGateResults([globalGateResult, persistedGateResult, exactProfileGateResult]);

        let processingStatus: string;
        switch (gateResult.status) {
          case "HARD_REJECT":
            processingStatus = "HARD_REJECTED";
            rejectedCount++;
            break;
          case "NEEDS_VERIFICATION":
            processingStatus = "NEEDS_VERIFICATION";
            needsVerificationCount++;
            break;
          default:
            processingStatus = "PREQUALIFIED";
            passedCount++;
        }

        // Update canonical job with gate outcome + structured workability facts + evidence
        await client.query(
          `UPDATE canonical_jobs
           SET gate_decision      = $1,
               processing_state   = $2,
               processing_status  = $2,
               rejection_reason   = $3,
               gate_evidence_quotes = $4,
               workability_facts  = $5,
               updated_at         = NOW()
           WHERE workspace_id = $6
             AND id = $7`,
          [
            gateResult.status,
            processingStatus,
            gateResult.rejection_codes.length > 0 ? gateResult.rejection_codes.join(", ") : null,
            JSON.stringify(gateResult.evidence_quotes),
            JSON.stringify(gateResult.workability_facts),
            ctx.workspaceId,
            job.id
          ]
        );

        // Write immutable gate_decisions audit row (invariant 6)
        await client.query(
          `INSERT INTO gate_decisions (
             workspace_id,
             canonical_job_id, job_version_id, gate_version,
             decision, rejection_codes, evidence_quotes, workability_facts
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            ctx.workspaceId,
            job.id,
            job.job_version_id,
            GATE_VERSION,
            gateResult.status,
            JSON.stringify(gateResult.rejection_codes),
            JSON.stringify(gateResult.evidence_quotes),
            JSON.stringify(gateResult.workability_facts)
          ]
        );

        await client.query("COMMIT");

        const codeStr = gateResult.rejection_codes.length ? ` [${gateResult.rejection_codes.join(", ")}]` : "";
        console.log(`-> ${job.company_name} - ${job.normalized_title} : ${gateResult.status}${codeStr}`);
      } catch (err) {
        await client.query("ROLLBACK");
        errorCount++;
        console.error(`❌ Failed to gate job ${job.id}:`, err);
      }
    }
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }

  console.log(
    `Hard Gates complete. Passed: ${passedCount}, Hard Rejected: ${rejectedCount}, Needs Verification: ${needsVerificationCount}, Errors: ${errorCount}`
  );
  return {
    passed: passedCount,
    hardRejected: rejectedCount,
    needsVerification: needsVerificationCount,
    errors: errorCount,
  };
}
