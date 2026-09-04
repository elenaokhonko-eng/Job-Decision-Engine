import pg from "pg";
import dotenv from "dotenv";
import {
  applyGlobalGates,
  GLOBAL_TITLE_EXCLUSIONS,
  isTechnicalRole,
  type GateResult,
} from "../services/criteria.js";
import { GATE_VERSION } from "../contracts/version.js";
import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

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
  const raw = req.structured_value?.office_days_per_week;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  const txt = quoteOrText(req);
  const m = txt.match(/([1-5])\s*days?/i);
  return m ? Number(m[1]) : null;
}

function detectTravelPct(req: PersistedRequirement): number | null {
  const raw = req.structured_value?.max_travel_pct;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  const txt = quoteOrText(req);
  const m = txt.match(/(\d{1,2})%/);
  return m ? Number(m[1]) : null;
}

function applyPersistedRequirementGates(
  job: {
    title: string;
    company_name: string;
    employment_type?: string;
  },
  deterministicRequirements: PersistedRequirement[]
): GateResult {
  const title = job.title || "";
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
    .join(" \n");

  let hasTechnicalEvidence = false;
  if (hasSemanticSignals) {
    hasTechnicalEvidence = /(engineer|architect|developer|scientist|machine learning|artificial intelligence|ai\b|llm|nlp|data|bioinformatics|genomics|regtech|legaltech|quant|fintech|trading)/i.test(
      semanticCorpus
    );
  } else {
    const textCorpus = deterministicRequirements
      .map((r) => quoteOrText(r).toLowerCase())
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

  const employmentReq = deterministicRequirements.find((r) => r.requirement_type === "EMPLOYMENT_TYPE");
  const normalizedEmployment = (employmentReq ? quoteOrText(employmentReq) : (job.employment_type || "")).toLowerCase();
  if (normalizedEmployment.includes("contract")) {
    return makeReject(
      ["GATE_CONTRACT_ROLE"],
      [employmentReq ? quoteOrText(employmentReq) : "Structured employment_type is CONTRACT"],
      { employment_type: "CONTRACT" }
    );
  }

  const officeReq = deterministicRequirements.find((r) => r.requirement_type === "OFFICE_DAYS");
  if (officeReq) {
    const days = detectOfficeDays(officeReq);
    if (days !== null && days >= 4) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        [quoteOrText(officeReq)],
        { office_days_min: days, office_days_max: days }
      );
    }
    if (days === null) {
      return makeVerification(
        ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
        [quoteOrText(officeReq)],
        { office_days_min: null, office_days_max: null }
      );
    }
  }

  const workModeReq = deterministicRequirements.find((r) => r.requirement_type === "WORK_MODE");
  if (workModeReq) {
    const mode = quoteOrText(workModeReq).toLowerCase();
    if (
      mode.includes("onsite only") ||
      mode.includes("on-site only") ||
      mode.includes("fully on-site") ||
      mode.includes("fully onsite") ||
      mode.includes("100% on-site") ||
      mode.includes("100% onsite")
    ) {
      return makeReject(
        ["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"],
        [quoteOrText(workModeReq)],
        { office_days_min: 4, office_days_max: 5 }
      );
    }
  }

  const travelReq = deterministicRequirements.find((r) => r.requirement_type === "TRAVEL");
  if (travelReq) {
    const travelPct = detectTravelPct(travelReq);
    const txt = quoteOrText(travelReq).toLowerCase();
    if ((travelPct !== null && travelPct >= 25) || txt.includes("frequent travel")) {
      return makeReject(
        ["GATE_LIFESTYLE_INCOMPATIBLE"],
        [quoteOrText(travelReq)],
        { travel_pct_max: travelPct }
      );
    }
  }

  const onCallReq = deterministicRequirements.find((r) => r.requirement_type === "ON_CALL");
  if (onCallReq) {
    return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(onCallReq)]);
  }

  const shiftReq = deterministicRequirements.find((r) => r.requirement_type === "SHIFT_WORK");
  if (shiftReq) {
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

  if (workModeReq && quoteOrText(workModeReq).toLowerCase().includes("hybrid") && !officeReq) {
    return makeVerification(
      ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
      [quoteOrText(workModeReq)],
      { office_days_min: null, office_days_max: null }
    );
  }

  return makePass({
    office_days_min: officeReq ? detectOfficeDays(officeReq) : null,
    office_days_max: officeReq ? detectOfficeDays(officeReq) : null,
    travel_pct_max: travelReq ? detectTravelPct(travelReq) : null,
    employment_type: normalizedEmployment.includes("permanent") ? "PERMANENT" : "UNKNOWN",
  });
}

export async function runHardGates(clientOrPool?: pg.Pool | pg.PoolClient): Promise<{ passed: number; hardRejected: number; needsVerification: number }> {
  console.log("Starting Hard Gate engine on RAW_STAGED canonical jobs...");
  const pool = clientOrPool || defaultPool;

  const { rows: stagedJobs } = await pool.query(`
    SELECT c.*, jv.description_text, jv.id AS job_version_id
    FROM canonical_jobs c
    JOIN job_versions jv ON jv.id = COALESCE(
      c.latest_job_version_id,
      (
        SELECT jv2.id
        FROM job_versions jv2
        WHERE jv2.canonical_job_id = c.id
        ORDER BY jv2.observed_at DESC
        LIMIT 1
      )
    )
    WHERE COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
  `);

  console.log(`Found ${stagedJobs.length} canonical jobs to gate.`);

  let passedCount = 0;
  let rejectedCount = 0;
  let needsVerificationCount = 0;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;
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
           FROM job_requirements
           WHERE job_version_id = $1
             AND extractor_type = 'DETERMINISTIC'
             AND status IN ('EXTRACTED', 'VALIDATED')
           ORDER BY requirement_key ASC`,
          [job.job_version_id]
        );

        const deterministicRequirements = requirementRows as PersistedRequirement[];
        const requirementHints = deterministicRequirements
          .map((r) => r.quote_text || r.requirement_text)
          .filter(Boolean)
          .slice(0, 60)
          .join("\n");

        const gateResult = applyGlobalGates({
          ...(rawJobAdapter as any),
          raw_description: requirementHints
            ? `${rawJobAdapter.raw_description}\n\n---\nExtracted requirements:\n${requirementHints}`
            : rawJobAdapter.raw_description,
        } as any);

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
           WHERE id = $6`,
          [
            gateResult.status,
            processingStatus,
            gateResult.rejection_codes.length > 0 ? gateResult.rejection_codes.join(", ") : null,
            JSON.stringify(gateResult.evidence_quotes),
            JSON.stringify(gateResult.workability_facts),
            job.id
          ]
        );

        // Write immutable gate_decisions audit row (invariant 6)
        await client.query(
          `INSERT INTO gate_decisions (
             canonical_job_id, job_version_id, gate_version,
             decision, rejection_codes, evidence_quotes, workability_facts
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
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
        console.error(`❌ Failed to gate job ${job.id}:`, err);
      }
    }
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }

  console.log(
    `Hard Gates complete. Passed: ${passedCount}, Hard Rejected: ${rejectedCount}, Needs Verification: ${needsVerificationCount}`
  );
  return { passed: passedCount, hardRejected: rejectedCount, needsVerification: needsVerificationCount };
}
