import pg from "pg";
import dotenv from "dotenv";
import crypto from "crypto";
import {
  generateEmbeddingWithProvider,
  MODEL_REGISTRY,
  type EmbeddingProvider,
} from "../services/agent.js";
import { pgPoolConfig } from "../db/pgSsl.js";
import { stripHtmlToText } from "../security/sanitize.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { enqueuePipelineTask } from "../tasks/pipelineTasks.js";
import {
  loadGlobalLanesConfig,
  loadLanesConfig,
  loadWorkspaceLanesConfig,
  type GlobalLanesConfig,
  type LaneDefinition,
} from "./laneConfigLoader.js";
import { sha256Hex, stableStringify } from "../config/structuredLoader.js";
import { PersistedLaneDecisionSchema, SCHEMA_VERSION } from "../contracts/index.js";
import { resolveWorkspacePreferenceContext } from "../policy/workspacePreferenceRegistry.js";
import { SixLaneKeySchema, type LaneIntentPreferences, type LanePreferenceTaxonomy } from "../policy/laneIntentContracts.js";

export { loadGlobalLanesConfig, loadLanesConfig };
export type { GlobalLanesConfig, LaneDefinition };

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

const LANE_ROUTER_RULE_VERSION = "lane_router_v2.3.2";


// ── Cosine similarity ─────────────────────────────────────────────────────────

const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// ── Keyword negative-concept exclusion ────────────────────────────────────────

function applyNegativeExclusion(description: string, laneDef: LaneDefinition): boolean {
  if (!laneDef.negative_concepts?.length) return false;

  const d = description.toLowerCase();
  for (const nc of laneDef.negative_concepts) {
    if (containsConcept(d, nc)) {
      return true; // excluded
    }
  }
  return false;
}
export function containsConcept(text: string, concept: string): boolean {
  return conceptVariants(concept).some((variant) => {
    const normalized = variant.toLowerCase().replace(/_/g, " ").trim();
    if (!normalized) return false;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
}

const CONCEPT_ALIASES: Record<string, string[]> = {
  "ai engineering": [
    "ai engineer",
    "artificial intelligence engineer",
    "machine learning engineer",
    "ml engineer",
    "ai systems engineer",
    "applied ai",
    "applied ai engineer",
    "agentic ai",
    "agentic systems",
    "ai agent",
    "ai agents",
    "autonomous agents",
    "ai platform engineer",
    "ai/ml engineer",
    "llm engineering",
    "llm engineer",
    "ai infrastructure engineer",
    "generative ai",
    "genai",
    "foundation model",
    "foundation models",
    "pytorch",
    "deep learning engineer",
  ],
  "ml engineering": [
    "ml",
    "ml engineer",
    "machine learning engineer",
    "machine learning engineering",
    "ml engineering",
    "ml systems",
    "applied ml",
    "applied machine learning",
    "machine learning scientist",
    "ai/ml",
    "mlops",
    "model training",
    "deep learning",
  ],
  "data engineering": [
    "data engineer",
    "data engineering",
    "data pipeline",
    "data pipelines",
    "etl",
    "elt",
    "data platform",
    "data platform engineer",
    "snowflake",
    "iceberg",
    "databricks",
    "bigquery",
    "spark",
    "dbt",
    "kafka",
    "lakehouse",
    "data warehouse",
    "data lake",
    "data infrastructure",
  ],
  "software engineering": [
    "software engineer",
    "software engineering",
    "software developer",
    "developer",
    "full stack engineer",
    "full-stack engineer",
    "full stack developer",
    "full-stack developer",
    "backend engineer",
    "backend developer",
    "front-end engineer",
    "frontend engineer",
    "frontend developer",
    "systems engineer",
    "systems developer",
    "platform engineer",
    "infrastructure engineer",
    "staff engineer",
    "principal engineer",
    "lead engineer",
    "senior software engineer",
  ],
  "platform engineering": [
    "platform engineer",
    "platform engineering",
    "cloud infrastructure",
    "cloud engineer",
    "cloud engineering",
    "infrastructure engineer",
    "infrastructure lead",
    "cloud lead",
    "infrastructure",
    "devops",
    "sre",
    "site reliability engineer",
    "distributed systems",
  ],
  "ai data architecture": [
    "ai data architecture",
    "data architecture",
    "ai architecture",
    "data platform architecture",
    "data architect",
    "solutions architect",
    "solution architect",
    "cloud architect",
    "enterprise architect",
  ],
  "ai systems architecture": [
    "ai systems architect",
    "ai systems architecture",
    "ai architecture",
    "ml systems architect",
    "chief architect",
    "principal architect",
    "systems architect",
    "software architect",
  ],
  "llm infrastructure": [
    "llm infrastructure",
    "llm platform",
    "llm training",
    "llm inference",
    "llm engineering",
    "inference platform",
    "model serving",
    "foundation model infrastructure",
    "rag",
    "retrieval augmented generation",
  ],
  "ai research": [
    "ai research",
    "machine learning research",
    "deep learning research",
    "ai researcher",
    "ml researcher",
    "ai scientist",
    "research scientist",
    "applied scientist",
    "applied researcher",
    "research fellow",
  ],
  "applied research": [
    "applied research",
    "applied researcher",
    "applied scientist",
    "research associate",
    "research fellow",
    "research engineer",
    "research software engineer",
  ],
  "legal ai": [
    "legal ai",
    "legaltech",
    "legal technology",
    "legal nlp",
    "contract analytics",
    "contract intelligence",
    "legal document intelligence",
    "computational law",
  ],
  "compliance automation": [
    "compliance automation",
    "compliance engineering",
    "regtech",
    "regulatory technology",
    "regulatory compliance",
    "policy automation",
    "sanctions",
    "due diligence",
  ],
  "fraud detection": [
    "fraud detection",
    "fraud analytics",
    "fraud",
    "scams",
    "anti-fraud",
    "financial crime technology",
    "financial crime",
    "transaction monitoring",
  ],
  "document intelligence": [
    "document intelligence",
    "document ai",
    "contract analytics",
    "intelligent document processing",
    "idp",
    "nlp document",
    "text extraction",
  ],
  "scientific ml": [
    "scientific ml",
    "scientific machine learning",
    "machine learning for science",
    "computational science",
    "ai for science",
  ],
  "research engineering": [
    "research engineering",
    "research engineer",
    "research software engineer",
    "rse",
    "scientific computing",
  ],
  "bioinformatics": [
    "bioinformatics",
    "bioinformatics scientist",
    "bioinformatician",
    "bioinformaticians",
    "computational biology",
    "computational genomics",
    "genomics",
    "genomic",
    "biostatistics",
  ],
  "clinical informatics": [
    "clinical informatics",
    "clinical data science",
    "health data science",
    "clinical nlp",
    "healthcare ai",
    "medical ai",
    "health data",
  ],
  "quantitative research": [
    "quantitative research",
    "quant researcher",
    "quantitative researcher",
    "quant research",
    "quantitative systems",
    "quantitative systems architect",
    "quantitative architect",
    "quant systems architect",
    "quantitative engineer",
    "algorithmic trading",
    "quant",
    "quantitative",
    "time-series",
    "portfolio analytics",
  ],
  "investment data platform": [
    "investment data platform",
    "investment data engineering",
    "market data platform",
    "market data feeds",
    "market data infrastructure",
    "portfolio data platform",
    "trading platform",
    "capital markets data",
  ],
  "time series modelling": [
    "time series modelling",
    "time-series modelling",
    "time series modeling",
    "time-series modeling",
    "time series",
    "time-series",
    "forecasting",
  ],
  "capital markets": [
    "capital markets",
    "trading",
    "market data",
    "market data feeds",
    "algorithmic trading",
    "trading systems",
    "execution systems",
    "trading infrastructure",
    "electronic trading",
  ],
  "ai": ["artificial intelligence", "machine learning", "ml", "deep learning", "llm", "nlp", "genai", "generative ai", "ai agents", "agentic"],
  "machine learning": ["machine learning", "ml", "deep learning", "statistical learning"],
  "data platform": [
    "data platform",
    "data warehouse",
    "data lake",
    "lakehouse",
    "data pipeline",
    "snowflake",
    "databricks",
    "iceberg",
    "data architecture",
    "bigquery",
  ],
  "data intelligence": [
    "data intelligence",
    "data platform",
    "business intelligence",
    "analytics engineering",
    "data analytics",
    "data products",
    "data science",
  ],
  "data science": [
    "data science",
    "data scientist",
    "ai/ml data scientist",
    "applied statistics",
    "predictive modelling",
    "predictive modeling",
    "statistical modeling",
  ],
  "regtech": [
    "regtech",
    "regulatory technology",
    "compliance automation",
    "aml",
    "kyc",
    "anti-money laundering",
    "know your customer",
    "financial crime",
    "sanctions",
  ],
  "legaltech": ["legaltech", "legal technology", "legal ai", "contract analytics", "contract intelligence"],
  "healthcare": ["healthcare", "health data", "clinical", "medical", "life sciences"],
  "biotech": ["biotech", "biotechnology", "drug discovery", "bioinformatics", "computational biology", "genomics"],
  "pharmaceutical": ["pharmaceutical", "pharma", "drug discovery", "therapeutics"],
  "investment management": ["investment management", "asset management", "fund management", "portfolio management", "institutional investing"],
  "asset management": ["asset management", "investment management", "fund management", "portfolio management"],
  "market data": ["market data", "financial data", "securities data", "order book", "market data platform", "market feeds", "market data feeds"],
  "trading infrastructure": [
    "trading infrastructure",
    "trading systems",
    "trading platform",
    "trading platforms",
    "execution systems",
    "execution infrastructure",
    "high-frequency execution infrastructure",
    "algorithmic trading platform",
    "algorithmic trading platforms",
    "market data platform",
    "low-latency market data",
  ],
  "technical programme delivery": [
    "technical programme",
    "technical program",
    "technical programme manager",
    "technical program manager",
    "technical delivery",
  ],
  "technical project delivery": [
    "technical project",
    "technical project manager",
    "technical delivery",
  ],
  "technical product delivery": [
    "technical product",
    "technical product manager",
    "technical product owner",
    "ai product manager",
    "data product manager",
  ],
  "technical architecture": [
    "technical architect",
    "solution architect",
    "solutions architect",
    "systems architect",
    "software architect",
    "data architect",
    "ai architect",
    "cloud architect",
    "enterprise architect",
    "platform architect",
  ],
  "technical delivery": [
    "technical delivery",
    "technical delivery manager",
    "delivery manager",
    "engineering delivery",
  ],
  "digital public infrastructure": [
    "digital public infrastructure",
    "digital government infrastructure",
    "public digital infrastructure",
    "digital public goods",
    "civic tech",
  ],
  "social impact": [
    "social impact",
    "international development",
    "multilateral",
    "climate tech",
    "environmental data",
    "biodiversity",
    "public interest tech",
    "sustainable development",
    "humanitarian",
  ],
  "machine learning research": [
    "machine learning research",
    "ml research",
    "ai research",
    "research scientist",
    "neural architectures",
  ],
  "university": [
    "university",
    "institute",
    "research institute",
    "faculty",
    "academic",
    "higher education",
    "campus",
    "college",
  ],
  "academic research": [
    "academic research",
    "university research",
    "university",
    "academic",
    "academic institution",
    "research institute",
    "research lab",
    "research laboratory",
    "academic laboratory",
    "academic department",
    "faculty research",
    "higher education",
    "research fellow",
    "postdoctoral",
    "postdoc",
    "phd",
  ],
  "academic laboratory": [
    "academic laboratory",
    "academic lab",
    "university laboratory",
    "university lab",
    "faculty laboratory",
    "ai laboratory",
  ],
};

function conceptVariants(concept: string): string[] {
  const normalized = concept.toLowerCase().replace(/_/g, " ").trim();
  return [normalized, ...(CONCEPT_ALIASES[normalized] || [])];
}

function conceptScopeScore(description: string, concepts: string[] | undefined): number {
  if (!concepts || concepts.length === 0) return 1;
  return concepts.some((concept) => containsConcept(description, concept)) ? 1 : 0;
}

export interface LaneIntentPreferenceAssessment {
  readonly tieBreakAdjustment: number;
  readonly evidence: readonly string[];
}

function normalizedPreferenceText(value: string): string {
  return value.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
}

function matchingPreferenceTerms(terms: readonly string[], text: string): string[] {
  return terms.filter((term) => containsConcept(text, normalizedPreferenceText(term)));
}

export function assessLaneIntentPreference(
  laneKey: string,
  title: string,
  description: string,
  companyName: string,
  preferences: LaneIntentPreferences | null,
): LaneIntentPreferenceAssessment {
  const parsedLane = SixLaneKeySchema.safeParse(laneKey);
  const taxonomy: LanePreferenceTaxonomy | undefined = parsedLane.success
    ? preferences?.lane_preferences[parsedLane.data]
    : undefined;
  if (!taxonomy) return { tieBreakAdjustment: 0, evidence: [] };

  const roleText = normalizedPreferenceText(`${title} ${description}`);
  const organizationText = normalizedPreferenceText(companyName);
  let adjustment = 0;
  const evidence: string[] = [];
  const applyCategory = (
    label: string,
    preferred: readonly string[],
    acceptable: readonly string[],
    excluded: readonly string[],
    text: string,
    positiveWeight: number,
    excludedWeight: number,
  ): void => {
    const excludedMatch = matchingPreferenceTerms(excluded, text)[0];
    if (excludedMatch) {
      adjustment -= excludedWeight;
      evidence.push(`USER_PREFERENCE_EXCLUDED_${label}:${excludedMatch}`);
      return;
    }
    const preferredMatch = matchingPreferenceTerms(preferred, text)[0];
    if (preferredMatch) {
      adjustment += positiveWeight;
      evidence.push(`USER_PREFERENCE_PREFERRED_${label}:${preferredMatch}`);
      return;
    }
    const acceptableMatch = matchingPreferenceTerms(acceptable, text)[0];
    if (acceptableMatch) {
      adjustment += positiveWeight / 2;
      evidence.push(`USER_PREFERENCE_ACCEPTABLE_${label}:${acceptableMatch}`);
    }
  };

  applyCategory(
    "ROLE_FAMILY",
    taxonomy.preferred_role_families,
    taxonomy.acceptable_role_families,
    taxonomy.excluded_role_families,
    roleText,
    0.02,
    0.025,
  );
  applyCategory(
    "SUBDOMAIN",
    taxonomy.preferred_subdomains,
    taxonomy.acceptable_subdomains,
    taxonomy.excluded_subdomains,
    roleText,
    0.015,
    0.02,
  );
  applyCategory(
    "ORGANIZATION_TYPE",
    taxonomy.preferred_organization_types,
    taxonomy.acceptable_organization_types,
    taxonomy.excluded_organization_types,
    organizationText,
    0.01,
    0.015,
  );

  const range = taxonomy.acceptable_direct_research_share_pct;
  if (range) {
    const shares = [...roleText.matchAll(/\b(?:research|direct research)\b[^.;]{0,40}\b(\d{1,3})\s*(?:%|percent)(?![a-z])|\b(\d{1,3})\s*(?:%|percent)(?![a-z])[^.;]{0,40}\b(?:research|direct research)\b/g)];
    if (shares.length === 1) {
      const share = Number(shares[0][1] ?? shares[0][2]);
      if (Number.isFinite(share) && share <= 100) {
        const withinRange = share >= range.minimum_pct && share <= range.maximum_pct;
        adjustment += withinRange ? 0.01 : -0.01;
        evidence.push(`USER_PREFERENCE_DIRECT_RESEARCH_SHARE_${withinRange ? "WITHIN" : "OUTSIDE"}:${share}%`);
      }
    }
  }

  for (const signal of preferences?.cross_lane_work_style_signals.positive ?? []) {
    const term = normalizedPreferenceText(signal);
    if (term && containsConcept(roleText, term)) {
      adjustment += 0.01;
      evidence.push(`USER_WORK_STYLE_PREFERRED:${signal}`);
      break;
    }
  }
  for (const signal of preferences?.cross_lane_work_style_signals.negative ?? []) {
    const term = normalizedPreferenceText(signal);
    if (term && containsConcept(roleText, term)) {
      adjustment -= 0.01;
      evidence.push(`USER_WORK_STYLE_AVOID:${signal}`);
      break;
    }
  }

  return {
    tieBreakAdjustment: Math.max(-0.05, Math.min(0.05, adjustment)),
    evidence,
  };
}

const NON_TECHNICAL_ROLE_FAMILY = /\b(?:sales|business\s+development|account\s+(?:executive|manager|cto)|customer\s+success|counselor|social\s+worker|people\s+(?:partner|business)|human\s+resources|hr\b|brand(?:s)?|marketing|finance|fp\s*&\s*a|accounting|tax|designer|design\s+director|art\s+director|leather|investigator|recruiter|talent|operations?)\b/i;

export function hasNonTechnicalRoleFamily(title: string): boolean {
  return NON_TECHNICAL_ROLE_FAMILY.test(String(title || ""));
}

export function hasCoreTechnicalFunction(title: string): boolean {
  const value = String(title || "").toLowerCase();
  if (!value || hasNonTechnicalRoleFamily(value)) return false;

  return /\b(?:software|data|machine\s+learning|ml|ai|platform|cloud|devops|sre|site\s+reliability|backend|back-end|frontend|front-end|full[- ]stack|engineering|engineer|developer|architect|scientist|researcher|quantitative|bioinformatics|mlops|technical\s+(?:product|program|programme|project|delivery)|automation|cyber\s+security|security\s+engineer)\b/i.test(value);
}

export function hasApprovedLaneFunction(laneKey: string, title: string): boolean {
  if (hasNonTechnicalRoleFamily(title)) return false;
  return laneKey === "CORE_AI_DATA" ? hasCoreTechnicalFunction(title) : true;
}

export function hasRequiredInstitutionalContext(laneKey: string, text: string): boolean {
  const normalizedLane = laneKey.toUpperCase();
  const value = String(text || "");

  if (normalizedLane === "UNIVERSITY_AI_RESEARCH") {
    const explicitInstitution = /\b(?:academic\s+institution|research\s+institute|academic\s+(?:lab|laboratory)|university\s+(?:lab|laboratory)|faculty\s+research|academic\s+appointment|formal\s+academic\s+research\s+(?:program|programme)|independent\s+research\s+laboratory|public\s+research\s+institute)\b/i.test(value);
    const roleInstitutionPair = /\b(?:research|scientist|engineer|fellow|professor)\b.{0,60}\b(?:university|institute|lab|laboratory|faculty)\b|\b(?:university|institute|lab|laboratory|faculty)\b.{0,60}\b(?:research|scientist|engineer|fellow|professor)\b/i.test(value);
    return explicitInstitution || roleInstitutionPair;
  }

  if (normalizedLane === "SOCIAL_IMPACT_MULTILATERAL") {
    return /\b(?:multilateral|international\s+development|development\s+bank|world\s+bank|united\s+nations|\bUN\b\s+(?:entity|agency|programme|program)|government\s+(?:agency|ministry|department)|public\s+agency|non[- ]profit|nonprofit|humanitarian|climate\s+(?:initiative|program|programme)|digital\s+public\s+infrastructure|digital\s+public\s+goods|civic\s+tech|public\s+interest\s+tech|social\s+impact)\b/i.test(value);
  }

  return true;
}

function laneDomainScopeScore(description: string, laneKey: string, concepts: string[] | undefined): number {
  if (!hasRequiredInstitutionalContext(laneKey, description)) return 0;
  return conceptScopeScore(description, concepts);
}

type LaneCandidateEvaluation = {
  laneKey: string;
  laneDef: LaneDefinition;
  threshold: number;
  score: number;
  domainScore: number;
  functionScore: number;
  rank: number;
  enabled: boolean;
  negativeExcluded: boolean;
};

function formatRoutingScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function buildNoMatchEvidence(candidates: LaneCandidateEvaluation[]): string[] {
  const evidence = ["ROUTING_POLICY_NO_MATCH"];
  const sorted = [...candidates].sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    return a.rank - b.rank;
  });

  for (const candidate of sorted.slice(0, 4)) {
    const minDomain = candidate.laneDef.minimum_domain_score ?? 0;
    const minFunction = candidate.laneDef.minimum_function_score ?? 0;
    const blockers: string[] = [];
    if (!candidate.enabled) blockers.push("lane_disabled");
    if (candidate.negativeExcluded) blockers.push("negative_concept");
    if (candidate.score < candidate.threshold) {
      blockers.push(
        `semantic:${formatRoutingScore(candidate.score)}<${formatRoutingScore(candidate.threshold)}`
      );
    }
    if (candidate.domainScore < minDomain) {
      blockers.push(
        `domain:${formatRoutingScore(candidate.domainScore)}<${formatRoutingScore(minDomain)}`
      );
    }
    if (candidate.functionScore < minFunction) {
      blockers.push(
        `function:${formatRoutingScore(candidate.functionScore)}<${formatRoutingScore(minFunction)}`
      );
    }

    evidence.push(
      `${candidate.laneKey}:blocked_by=${blockers.join(",") || "not_selected"};` +
        `score=${formatRoutingScore(candidate.score)};` +
        `threshold=${formatRoutingScore(candidate.threshold)};` +
        `domain=${formatRoutingScore(candidate.domainScore)}/${formatRoutingScore(minDomain)};` +
        `function=${formatRoutingScore(candidate.functionScore)}/${formatRoutingScore(minFunction)}`
    );
  }

  return evidence;
}

function extractCoreJobText(title: string, description: string): string {
  const raw = (description || "").trim();

  let mergedText = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as any;
      const parts: string[] = [];
      if (typeof parsed?.job_description === "string") parts.push(parsed.job_description);
      if (Array.isArray(parsed?.key_responsibilities)) parts.push(parsed.key_responsibilities.join("\n"));
      if (Array.isArray(parsed?.technical_skills)) parts.push(parsed.technical_skills.join("\n"));
      if (Array.isArray(parsed?.qualifications_education)) parts.push(parsed.qualifications_education.join("\n"));
      if (Array.isArray(parsed?.nice_to_haves)) parts.push(parsed.nice_to_haves.join("\n"));
      mergedText = parts.filter(Boolean).join("\n");
    } catch {
      mergedText = raw;
    }
  }

  const plain = stripHtmlToText(mergedText);
  const lines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const boilerplateHeadings = new Set([
    "equal opportunity employer",
    "benefits & perks",
    "benefits",
    "about us",
    "about the company",
    "about our company",
    "who we are",
    "our mission",
    "company overview",
    "company description",
    "diversity & inclusion",
    "diversity and inclusion",
    "what we offer",
    "perks",
    "our story",
  ]);

  const sections: Array<{ heading: string | null; body: string[] }> = [];
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] };

  const flush = () => {
    if (current.heading || current.body.length) {
      sections.push(current);
      current = { heading: null, body: [] };
    }
  };

  for (const line of lines) {
    const normalizedHeading = line.replace(/:\s*$/, "").toLowerCase();
    const isBoilerplateHeading = boilerplateHeadings.has(normalizedHeading);
    const isHeading = isBoilerplateHeading || (line.endsWith(":") && line.length <= 60);
    if (isHeading) {
      flush();
      current.heading = normalizedHeading;
      continue;
    }
    current.body.push(line);
  }
  flush();

  const kept = sections
    .filter((s) => !s.heading || !boilerplateHeadings.has(s.heading))
    .flatMap((s) => s.body)
    .join(" ")
    .slice(0, 2000);

  return `${title}. ${kept}`.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Export under old name for backward-compat with tests
export async function runLaneRouting(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    canonicalJobIds?: string[];
    limit?: number;
    reprocessExisting?: boolean;
  }
): Promise<{ routed: number; deferred: number }> {
  return runLaneRouter(clientOrPool, options);
}

export async function runLaneRouter(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: {
    context?: WorkspaceContext;
    jobVersionIds?: string[];
    canonicalJobIds?: string[];
    limit?: number;
    reprocessExisting?: boolean;
  }
): Promise<{ routed: number; deferred: number }> {
  const pool = clientOrPool || defaultPool;
  const ctx = options?.context ?? (await resolveWorkspaceContext(pool as any));
  const configResult = await loadWorkspaceLanesConfig(pool, {
    context: ctx,
    seedIfEmpty: true,
  });
  const config = configResult.config;
  const configSourceLabel =
    configResult.source === "FILES" ? "config/lanes (FILES)" : "workspace lanes (DB)";
  console.log(
    `Starting Semantic Lane Routing from ${configSourceLabel}. Lanes version: ${
      config.version || "unknown"
    }`
  );

  const currentLaneRouterModelPrefix =
    `${LANE_ROUTER_RULE_VERSION}|${config.version ?? "lanes_unknown"}|`;
  const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
  const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
  const hasExplicitTargets = jobVersionIds.length > 0 || canonicalJobIds.length > 0;
  const reprocessExisting = options?.reprocessExisting === true;
  const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
    ? Number(options?.limit)
    : null;
  // Explicit repair/backfill targets may replay a prior policy no-match.
  // Normal scans may only reopen one after the lane policy/model revision changes.
  const params: unknown[] = [ctx.workspaceId];
  if (!hasExplicitTargets || reprocessExisting) params.push(currentLaneRouterModelPrefix);
  const jobVersionFilter = jobVersionIds.length > 0
    ? `AND jv.id = ANY($${params.push(jobVersionIds)}::uuid[])`
    : "";
  const canonicalJobFilter = canonicalJobIds.length > 0
    ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])`
    : "";
  const limitClause = limit ? `LIMIT $${params.push(limit)}` : "";
  const replayableStateFilter = reprocessExisting
    ? `COALESCE(c.processing_state, c.processing_status) IN ('PREQUALIFIED', 'ROUTING_DEFERRED', 'UNMATCHED', 'LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED')`
    : `COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
           OR (
             COALESCE(c.processing_state, c.processing_status) IN ('ROUTING_DEFERRED', 'UNMATCHED')
             AND (
               ${hasExplicitTargets ? "TRUE" : `
                 COALESCE(c.primary_lane, 'UNCLASSIFIED') = 'UNCLASSIFIED'
                 AND (
                   c.latest_lane_decision_id IS NULL
                   OR NOT EXISTS (
                     SELECT 1
                     FROM lane_decisions ld
                     WHERE ld.workspace_id = c.workspace_id
                       AND ld.id = c.latest_lane_decision_id
                       AND LEFT(ld.model_version, LENGTH($2)) = $2
                   )
                 )
               `}
             )
           )`;
  const replayExistingDecisionFilter = reprocessExisting
    ? `AND (
         c.latest_lane_decision_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM lane_decisions ld
           WHERE ld.workspace_id = c.workspace_id
             AND ld.id = c.latest_lane_decision_id
             AND LEFT(ld.model_version, LENGTH($2)) = $2
         )
       )`
    : "";

  let jobs: any[] = [];
  try {
    // Use LATERAL join to get only the latest version's description.
    // Retry old ROUTING_DEFERRED/UNCLASSIFIED decisions when the router rules or
    // lane snapshot version changes, otherwise a bad calibration run strands jobs.
    const result = await pool.query(
      `
        SELECT c.*, jv.description_text, jv.id AS latest_version_id
        FROM canonical_jobs c
        JOIN LATERAL (
          SELECT id, description_text
          FROM job_versions
          WHERE workspace_id = $1
            AND canonical_job_id = c.id
            AND (c.latest_job_version_id IS NULL OR id = c.latest_job_version_id)
          ORDER BY observed_at DESC
          LIMIT 1
        ) jv ON TRUE
        WHERE c.workspace_id = $1
          AND c.archived_at IS NULL
          AND (${replayableStateFilter})
          ${replayExistingDecisionFilter}
          ${jobVersionFilter}
          ${canonicalJobFilter}
        ORDER BY c.created_at ASC, c.id ASC
        ${limitClause}
      `,
      params
    );
    jobs = result.rows;
  } catch (error: any) {
    if (error?.code !== "42P01" && error?.code !== "42703") {
      throw error;
    }
    const fallbackParams: unknown[] = [ctx.workspaceId];
    if (!hasExplicitTargets || reprocessExisting) fallbackParams.push(currentLaneRouterModelPrefix);
    const fallbackJobVersionFilter = jobVersionIds.length > 0
      ? `AND jv.id = ANY($${fallbackParams.push(jobVersionIds)}::uuid[])`
      : "";
    const fallbackCanonicalJobFilter = canonicalJobIds.length > 0
      ? `AND c.id = ANY($${fallbackParams.push(canonicalJobIds)}::uuid[])`
      : "";
    const fallbackLimitClause = limit ? `LIMIT $${fallbackParams.push(limit)}` : "";
    const fallback = await pool.query(
      `
        SELECT c.*, jv.description_text, jv.id AS latest_version_id
        FROM canonical_jobs c
        JOIN LATERAL (
          SELECT id, description_text
          FROM job_versions
          WHERE workspace_id = $1
            AND canonical_job_id = c.id
            AND (c.latest_job_version_id IS NULL OR id = c.latest_job_version_id)
          ORDER BY observed_at DESC
          LIMIT 1
        ) jv ON TRUE
         WHERE c.workspace_id = $1
           AND (${replayableStateFilter})
          ${replayExistingDecisionFilter}
          ${fallbackJobVersionFilter}
          ${fallbackCanonicalJobFilter}
        ORDER BY c.created_at ASC, c.id ASC
        ${fallbackLimitClause}
      `,
      fallbackParams
    );
    jobs = fallback.rows;
  }

  console.log(`Found ${jobs.length} canonical jobs to route.`);

  if (jobs.length === 0) {
    return { routed: 0, deferred: 0 };
  }

  if (process.env.PIPELINE_TASKS_SHADOW_ENQUEUE === "true") {
    let enqueued = 0;
    for (const job of jobs) {
      const taskKey = `lane_route:${job.latest_version_id}:${config.version || "unknown"}`;
      try {
        const res = await enqueuePipelineTask(
          {
            taskType: "LANE_ROUTE_JOB_VERSION",
            taskKey,
            payload: {
              canonical_job_id: job.id,
              job_version_id: job.latest_version_id,
              lanes_version: config.version ?? null,
            },
          },
          pool as any,
          { context: ctx }
        );
        if (res.inserted) {
          enqueued += 1;
        }
      } catch (err: any) {
        if (err?.code === "42P01") {
          console.warn("⚠️ pipeline_tasks table missing; skipping shadow enqueue for lane routing.");
          break;
        }
        throw err;
      }
    }
    console.log(`Shadow-enqueued ${enqueued} lane routing task(s).`);
  }

  class EmbeddingRunError extends Error {
    provider: EmbeddingProvider;
    jobId?: string;

    constructor(provider: EmbeddingProvider, message: string, jobId?: string) {
      super(message);
      this.name = "EmbeddingRunError";
      this.provider = provider;
      this.jobId = jobId;
    }
  }

  const primaryProviderRaw = (process.env.EMBEDDING_PRIMARY_PROVIDER || "").trim().toLowerCase();
  const primaryProvider: EmbeddingProvider =
    primaryProviderRaw === "openai" || process.env.FORCE_OPENAI === "true" ? "openai" : "gemini";
  const providerOrder: EmbeddingProvider[] =
    primaryProvider === "openai" ? ["openai", "gemini"] : ["gemini", "openai"];

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;
  try {
    const preferenceContext = await resolveWorkspacePreferenceContext(client as pg.PoolClient, ctx, ['lane_intent']);

    // Route only with the currently configured primary/fallback provider-model
    // pairs. Older spaces remain immutable audit history, but must not silently
    // win just because they happen to have a complete vector corpus.
    const configuredPrimaryProvider = (process.env.EMBEDDING_PRIMARY_PROVIDER || "gemini").trim().toLowerCase();
    const configuredPrimaryModel = (process.env.EMBEDDING_PRIMARY_MODEL || MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL).trim();
    const configuredFallbackProvider = (process.env.EMBEDDING_FALLBACK_PROVIDER || "openai").trim().toLowerCase();
    const configuredFallbackModel = (process.env.EMBEDDING_FALLBACK_MODEL || MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL).trim();
    type PublishedEmbeddingSet = {
      laneEmbeddings: Record<string, number[]>;
      jobEmbeddings: Map<string, number[]>;
      dimensions: number;
      model: string;
    };
    const publishedEmbeddingSets = new Map<EmbeddingProvider, PublishedEmbeddingSet>();
    const laneNodeIds = (configResult.activeLaneRevisions || [])
      .map((revision) => ({ laneKey: revision.laneKey, nodeId: revision.laneRevisionId }));
    if (laneNodeIds.length === Object.keys(config.lanes).length && laneNodeIds.length > 0) {
      try {
        const published = await client.query<{
          embedding_space_id: string;
          provider: EmbeddingProvider;
          model: string;
          node_type: string;
          node_id: string;
          vector_dimensions: number;
          embedding_values: number[] | string;
        }>(
          `SELECT v.embedding_space_id,
                  es.provider,
                  es.model,
                  v.node_type,
                  v.node_id,
                  v.vector_dimensions,
                  v.embedding_values
           FROM v_matchable_nodes v
           JOIN embedding_spaces es ON es.id = v.embedding_space_id
           WHERE v.workspace_id = $1
             AND es.active = TRUE
             AND (
               (LOWER(es.provider) = $4 AND es.model = $5)
               OR (LOWER(es.provider) = $6 AND es.model = $7)
             )
             AND ((v.node_type = 'JOB_VERSION' AND v.node_id = ANY($2::uuid[]))
               OR (v.node_type = 'LANE_PROTOTYPE' AND v.node_id = ANY($3::uuid[])))
           ORDER BY es.created_at DESC`,
          [
            ctx.workspaceId,
            jobs.map((job) => job.latest_version_id),
            laneNodeIds.map((revision) => revision.nodeId),
            configuredPrimaryProvider,
            configuredPrimaryModel,
            configuredFallbackProvider,
            configuredFallbackModel,
          ]
        );
        const grouped = new Map<string, typeof published.rows>();
        for (const row of published.rows) {
          const rows = grouped.get(row.embedding_space_id) || [];
          rows.push(row);
          grouped.set(row.embedding_space_id, rows);
        }
        for (const rows of grouped.values()) {
          const provider = rows[0]?.provider;
          if (!provider) continue;
          const parseVector = (value: number[] | string): number[] => {
            if (Array.isArray(value)) return value.map(Number);
            return String(value).replace(/[{}]/g, "").split(",").map(Number).filter(Number.isFinite);
          };
          const byNode = new Map(rows.map((row) => [`${row.node_type}:${row.node_id}`, parseVector(row.embedding_values)]));
          const dimensions = Number(rows[0]?.vector_dimensions || 0);
          const laneEmbeddings: Record<string, number[]> = {};
          let complete = dimensions > 0;
          for (const revision of laneNodeIds) {
            const vector = byNode.get(`LANE_PROTOTYPE:${revision.nodeId}`);
            if (!vector || vector.length !== dimensions) complete = false;
            else laneEmbeddings[revision.laneKey] = vector;
          }
          const jobEmbeddings = new Map<string, number[]>();
          for (const job of jobs) {
            const vector = byNode.get(`JOB_VERSION:${job.latest_version_id}`);
            if (vector && vector.length === dimensions) {
              jobEmbeddings.set(job.id, vector);
            }
          }
          if (complete && Object.keys(laneEmbeddings).length === laneNodeIds.length) {
            publishedEmbeddingSets.set(provider, {
              laneEmbeddings,
              jobEmbeddings,
              dimensions,
              model: String(rows[0]?.model || "unknown"),
            });
          }
        }
      } catch (error: any) {
        if (error?.code !== "42P01") throw error;
      }
    }

    const useWorkspaceLaneTables = configResult.source === "LANE_REGISTRY_DB";
    const pipelineRunId = crypto.randomUUID();
    const laneSnapshot = {
      source: configResult.source,
      lanes_version: config.version ?? null,
      active_lane_revisions:
        configResult.activeLaneRevisions?.map((lane) => ({
          lane_key: lane.laneKey,
          lane_identity_id: lane.laneIdentityId,
          lane_revision_id: lane.laneRevisionId,
          revision_number: lane.revisionNumber,
          content_hash: lane.contentHash,
          activated_at: lane.activatedAt,
        })) ?? [],
      preference_context_id: preferenceContext.contextId,
      lane_intent_revision_id: preferenceContext.revisionsByDomain.lane_intent ?? null,
    };

    const loadPreferenceOrdering = async (): Promise<{
      laneRankByKey: Record<string, number>;
      laneEnabledByKey: Record<string, boolean>;
    }> => {
      const versionedWeights = preferenceContext.laneIntent?.lane_weights;
      if (versionedWeights) {
        const ranked = Object.entries(versionedWeights)
          .sort(([laneA, weightA], [laneB, weightB]) => weightB - weightA || laneA.localeCompare(laneB));
        return {
          laneRankByKey: Object.fromEntries(ranked.map(([laneKey], index) => [laneKey, index])),
          laneEnabledByKey: Object.fromEntries(ranked.map(([laneKey]) => [laneKey, true])),
        };
      }
      if (!useWorkspaceLaneTables) {
        return { laneRankByKey: {}, laneEnabledByKey: {} };
      }
      try {
        const { rows } = await client.query<{
          lane_key: string;
          enabled: boolean;
          priority_rank: number;
        }>(
          `
            SELECT li.lane_key, wlp.enabled, wlp.priority_rank
            FROM workspace_lane_preferences wlp
            JOIN lane_identities li ON li.id = wlp.lane_identity_id
            WHERE wlp.workspace_id = $1
              AND wlp.workspace_user_id = $2
          `,
          [ctx.workspaceId, ctx.userId]
        );

        const laneRankByKey: Record<string, number> = {};
        const laneEnabledByKey: Record<string, boolean> = {};

        for (const row of rows) {
          laneRankByKey[row.lane_key] = row.priority_rank ?? 1000;
          laneEnabledByKey[row.lane_key] = row.enabled !== false;
        }

        return { laneRankByKey, laneEnabledByKey };
      } catch (error: any) {
        // Allow running without preferences table (pre-migration).
        if (error?.code === "42P01") {
          return { laneRankByKey: {}, laneEnabledByKey: {} };
        }
        throw error;
      }
    };

    const preferences = await loadPreferenceOrdering();
    const preferenceRank = (laneKey: string): number => preferences.laneRankByKey[laneKey] ?? 1000;
    const preferenceEnabled = (laneKey: string): boolean => {
      if (laneKey in preferences.laneEnabledByKey) {
        return preferences.laneEnabledByKey[laneKey];
      }
      return true;
    };

    const persistLaneDecision = async (params: {
      canonicalJobId: string;
      jobVersionId: string;
      embeddingProvider: EmbeddingProvider;
      embeddingModel?: string;
      embeddingDimensions: number;
      primaryLane: string;
      secondaryLanes: string[];
      laneConfidence: string;
      semanticScores: Record<string, number>;
      laneEvidence: string[];
      evaluatedAt: string;
    }): Promise<string | null> => {
      if (!useWorkspaceLaneTables) {
        return null;
      }
      const embeddingModel = params.embeddingModel || (
        params.embeddingProvider === "gemini"
          ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL
          : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL
      );
      const modelVersion = [
        LANE_ROUTER_RULE_VERSION,
        config.version ?? "lanes_unknown",
        `${params.embeddingProvider}:${embeddingModel}:${params.embeddingDimensions}`,
      ].join("|");

      const decisionJson = PersistedLaneDecisionSchema.parse({
        schema_version: SCHEMA_VERSION,
        canonical_job_id: params.canonicalJobId,
        job_version_id: params.jobVersionId,
        pipeline_run_id: pipelineRunId,
        model_version: modelVersion,
        primary_lane: params.primaryLane,
        secondary_lanes: params.secondaryLanes,
        lane_confidence: params.laneConfidence,
        semantic_scores: params.semanticScores,
        lane_evidence: params.laneEvidence,
        evaluated_at: params.evaluatedAt,
      });

      const decisionHash = sha256Hex(stableStringify({
        decision: decisionJson,
        preference_context_id: preferenceContext.contextId,
      }));

      try {
        const inserted = await client.query<{ id: string }>(
          `
            INSERT INTO lane_decisions (
              workspace_id,
              canonical_job_id,
              job_version_id,
              decision_hash,
              schema_version,
              model_version,
              lane_snapshot,
              decision_json,
              created_by_user_id,
              preference_user_id,
              preference_context_id,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
            ON CONFLICT (workspace_id, decision_hash)
            DO NOTHING
            RETURNING id
          `,
          [
            ctx.workspaceId,
            params.canonicalJobId,
            params.jobVersionId,
            decisionHash,
            decisionJson.schema_version,
            modelVersion,
            laneSnapshot,
            decisionJson,
            ctx.userId,
            preferenceContext.contextId ? ctx.userId : null,
            preferenceContext.contextId,
          ]
        );

        if (inserted.rows.length > 0) {
          return inserted.rows[0].id;
        }

        const existing = await client.query<{ id: string }>(
          `
            SELECT id
            FROM lane_decisions
            WHERE workspace_id = $1
              AND decision_hash = $2
            LIMIT 1
          `,
          [ctx.workspaceId, decisionHash]
        );
        return existing.rows[0]?.id ?? null;
      } catch (error: any) {
        // Allow running against pre-migration databases.
        if (error?.code === "42P01") {
          return null;
        }
        throw error;
      }
    };

    const routeWithProvider = async (
      provider: EmbeddingProvider
    ): Promise<{ routed: number; deferred: number }> => {
      console.log(`Lane routing embedding provider: ${provider}`);

      const laneEmbeddings: Record<string, number[]> = {};
      let prototypeDimensions: number | null = null;
      const publishedSet = publishedEmbeddingSets.get(provider);
      if (publishedSet) {
        Object.assign(laneEmbeddings, publishedSet.laneEmbeddings);
        prototypeDimensions = publishedSet.dimensions;
      }

      for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
        if (publishedSet) break;
        let vector: number[];
        try {
          vector = await generateEmbeddingWithProvider(laneDef.prototype_query, provider);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new EmbeddingRunError(
            provider,
            `prototype embedding failed for lane ${laneKey}: ${message}`
          );
        }

        if (vector.length === 0) {
          throw new EmbeddingRunError(provider, `prototype embedding was empty for lane ${laneKey}`);
        }

        if (prototypeDimensions == null) {
          prototypeDimensions = vector.length;
        } else if (vector.length !== prototypeDimensions) {
          throw new EmbeddingRunError(
            provider,
            `prototype embedding dimension mismatch for lane ${laneKey}: expected ${prototypeDimensions} got ${vector.length}`
          );
        }

        laneEmbeddings[laneKey] = vector;
      }

      const jobEmbeddings = new Map<string, number[]>(publishedSet?.jobEmbeddings || []);
      if (publishedSet) {
        console.log(`Using published ${provider} embedding batch for lane routing.`);
      }
      for (const job of jobs) {
        if (jobEmbeddings.has(job.id)) continue;
        const coreText = extractCoreJobText(job.normalized_title, job.description_text || "");
        let jobEmbedding: number[];
        try {
          jobEmbedding = await generateEmbeddingWithProvider(coreText, provider);
          if (jobEmbedding.length === 0 || jobEmbedding.every((value) => value === 0)) {
            continue;
          }
          if (prototypeDimensions !== null && jobEmbedding.length !== prototypeDimensions) {
            continue;
          }
          jobEmbeddings.set(job.id, jobEmbedding);
        } catch {
          // If individual job embedding generation fails, defer this job as TECHNICAL_DEFERRED without failing others
        }
      }

      let routedCount = 0;
      let deferredCount = 0;

      for (const job of jobs) {
        await client.query("BEGIN");
        try {
          const jobEmbedding = jobEmbeddings.get(job.id);
          if (!jobEmbedding || jobEmbedding.every((v) => v === 0)) {
            console.warn(`⚠️ Embedding unavailable for job ${job.id}. Deferring (never default lane).`);
            const evaluatedAt = new Date().toISOString();
            const laneDecisionId = await persistLaneDecision({
              canonicalJobId: job.id,
              jobVersionId: job.latest_version_id,
              embeddingProvider: provider,
              embeddingModel: publishedSet?.model,
              embeddingDimensions: jobEmbedding?.length ?? 0,
              primaryLane: "UNCLASSIFIED",
              secondaryLanes: [],
              laneConfidence: "None",
              semanticScores: {},
              laneEvidence: ["ROUTING_POLICY_NO_MATCH", "EMBEDDING_UNAVAILABLE"],
              evaluatedAt,
            });
            await client.query(
              `UPDATE canonical_jobs
               SET primary_lane = 'UNCLASSIFIED',
                   semantic_score = 0.0,
                   lane_confidence = 'None',
                   secondary_lanes = '[]'::jsonb,
                   lane_evidence = 'ROUTING_POLICY_NO_MATCH',
                   routing_disposition = 'TECHNICAL_DEFERRED',
                   processing_state = 'ROUTING_DEFERRED',
                   processing_status = 'ROUTING_DEFERRED',
                   latest_lane_decision_id = $4,
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $2
                 AND (latest_job_version_id IS NULL OR latest_job_version_id = $3)`,
              [ctx.workspaceId, job.id, job.latest_version_id, laneDecisionId]
            );
            await client.query("COMMIT");
            deferredCount += 1;
            continue;
          }

          if (prototypeDimensions != null && jobEmbedding.length !== prototypeDimensions) {
            console.warn(
              `⚠️ Embedding dimension mismatch for job ${job.id}: expected ${prototypeDimensions} got ${jobEmbedding.length}. Deferring.`
            );
            const evaluatedAt = new Date().toISOString();
            const laneDecisionId = await persistLaneDecision({
              canonicalJobId: job.id,
              jobVersionId: job.latest_version_id,
              embeddingProvider: provider,
              embeddingModel: publishedSet?.model,
              embeddingDimensions: jobEmbedding.length,
              primaryLane: "UNCLASSIFIED",
              secondaryLanes: [],
              laneConfidence: "None",
              semanticScores: {},
              laneEvidence: [`EMBEDDING_DIM_MISMATCH:${jobEmbedding.length}!=${prototypeDimensions}`],
              evaluatedAt,
            });
            const canonicalUpdate = await client.query(
              `UPDATE canonical_jobs
               SET primary_lane = 'UNCLASSIFIED',
                   semantic_score = 0.0,
                   lane_confidence = 'None',
                   secondary_lanes = $3::jsonb,
                   lane_evidence = $4::jsonb,
                   routing_disposition = 'TECHNICAL_DEFERRED',
                   processing_state = 'ROUTING_DEFERRED',
                   processing_status = 'ROUTING_DEFERRED',
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $2
                 AND latest_job_version_id = $5`,
              [
                ctx.workspaceId,
                job.id,
                JSON.stringify([]),
                JSON.stringify([`EMBEDDING_DIM_MISMATCH:${jobEmbedding.length}!=${prototypeDimensions}`]),
                job.latest_version_id,
              ]
            );
            if (canonicalUpdate?.rowCount === 0) {
              await client.query("COMMIT");
              continue;
            }
            if (laneDecisionId) {
              await client.query(
                `UPDATE canonical_jobs
                 SET latest_lane_decision_id = $3,
                     updated_at = NOW()
                 WHERE workspace_id = $1
                   AND id = $2
                   AND latest_job_version_id = $4`,
                [ctx.workspaceId, job.id, laneDecisionId, job.latest_version_id]
              );
            }
            await client.query("COMMIT");
            deferredCount++;
            continue;
          }

          let bestLane: string | null = null;
          let bestScore = -1;
          const scoreMap: Record<string, number> = {};
          const domainScoreMap: Record<string, number> = {};
          const functionScoreMap: Record<string, number> = {};
          const lanePreferenceAdjustments: Record<string, number> = {};
          const lanePreferenceEvidence: Record<string, readonly string[]> = {};
          const laneEvidence: string[] = [];
          const descText = extractCoreJobText(
            job.normalized_title || "",
            job.description_text || ""
          ).toLowerCase();

          for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
            if (!preferenceEnabled(laneKey)) {
              scoreMap[laneKey] = -1;
              continue;
            }
            // If excluded by lane's negative concepts, skip
            if (applyNegativeExclusion(descText, laneDef)) {
              scoreMap[laneKey] = -1;
              continue;
            }
            const score = cosineSimilarity(jobEmbedding, laneEmbeddings[laneKey]);
            scoreMap[laneKey] = score;
            const lanePreference = assessLaneIntentPreference(
              laneKey,
              job.normalized_title || "",
              job.description_text || "",
              String(job.company_name ?? ""),
              preferenceContext.laneIntent,
            );
            lanePreferenceAdjustments[laneKey] = lanePreference.tieBreakAdjustment;
            lanePreferenceEvidence[laneKey] = lanePreference.evidence;
            domainScoreMap[laneKey] = laneDomainScopeScore(descText, laneKey, laneDef.included_domain_concepts);
            functionScoreMap[laneKey] = !hasApprovedLaneFunction(laneKey, job.normalized_title || "")
              ? 0
              : conceptScopeScore(descText, laneDef.required_function_concepts);
            if (score > bestScore) {
              bestScore = score;
              bestLane = laneKey;
            }
          }

          const minSimilarityFloor = config.unclassified_policy.min_similarity_floor || 0.25;
          const primaryCandidates = Object.entries(config.lanes)
            .map(([laneKey, laneDef]) => {
              const threshold = laneDef.semantic_threshold ?? laneDef.threshold ?? minSimilarityFloor;
              const score = scoreMap[laneKey] ?? -1;
              const domainScore = domainScoreMap[laneKey] ?? 0;
              const functionScore = functionScoreMap[laneKey] ?? 0;
              return {
                laneKey,
                laneDef,
                threshold,
                score,
                domainScore,
                functionScore,
                rank: preferenceRank(laneKey),
                preferenceAdjustment: lanePreferenceAdjustments[laneKey] ?? 0,
                preferenceEvidence: lanePreferenceEvidence[laneKey] ?? [],
                enabled: preferenceEnabled(laneKey),
                negativeExcluded: applyNegativeExclusion(descText, laneDef),
              };
            });
          const qualifyingPrimary = primaryCandidates
            .filter((c) => c.enabled)
            .filter((c) => c.score >= c.threshold)
            .filter((c) => c.domainScore >= (c.laneDef.minimum_domain_score ?? 0))
            .filter((c) => c.functionScore >= (c.laneDef.minimum_function_score ?? 0))
            .filter((c) => !c.negativeExcluded);

          if (qualifyingPrimary.length === 0) {
            laneEvidence.push(...buildNoMatchEvidence(primaryCandidates));
            bestLane = "UNCLASSIFIED";
            bestScore = Math.max(0, bestScore);
          } else {
            qualifyingPrimary.sort((a, b) => {
              const scoreDifference = Math.abs(a.score - b.score);
              if (scoreDifference > 0.03) return b.score - a.score;
              const preferenceDifference = b.preferenceAdjustment - a.preferenceAdjustment;
              if (Math.abs(preferenceDifference) > 1e-9) return preferenceDifference;
              if (scoreDifference > 1e-9) return b.score - a.score;
              return a.rank - b.rank;
            });
            bestLane = qualifyingPrimary[0].laneKey;
            bestScore = qualifyingPrimary[0].score;
          }

          const selectedLaneDef = bestLane === "UNCLASSIFIED" ? null : config.lanes[bestLane];
          if (bestLane !== "UNCLASSIFIED") {
            laneEvidence.push(...(lanePreferenceEvidence[bestLane] ?? []));
          }
          const selectedThreshold =
            selectedLaneDef?.semantic_threshold ?? selectedLaneDef?.threshold ?? minSimilarityFloor;

          const laneConfidence =
            bestLane === "UNCLASSIFIED"
              ? "None"
              : bestScore >= selectedThreshold + 0.2
                ? "High"
                : bestScore >= selectedThreshold + 0.1
                  ? "Medium"
                  : "Low";

          // Secondary lanes: must meet per-lane threshold, have positive concept evidence, and not be excluded.
          // Preference rank is applied as a stable ordering (not a classifier).
          const secondaryCandidates: Array<{ laneKey: string; score: number; rank: number; preferenceAdjustment: number }> = [];
          for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
            if (laneKey === bestLane) continue;
            if (!preferenceEnabled(laneKey)) continue;
            const threshold = laneDef.secondary_lane_threshold
              ?? laneDef.semantic_threshold
              ?? laneDef.threshold
              ?? minSimilarityFloor;
            const score = scoreMap[laneKey] || 0;
            const domainScore = domainScoreMap[laneKey] ?? 0;
            const functionScore = functionScoreMap[laneKey] ?? 0;
            if (
              score >= threshold
              && domainScore >= (laneDef.minimum_domain_score ?? 0)
              && functionScore >= (laneDef.minimum_function_score ?? 0)
              && !applyNegativeExclusion(descText, laneDef)
            ) {
              // Require at least one positive concept match for secondary lane qualification
              const hasPositiveEvidence = laneDef.positive_concepts?.some((pc) => containsConcept(descText, pc));
              if (hasPositiveEvidence) {
                secondaryCandidates.push({
                  laneKey,
                  score,
                  rank: preferenceRank(laneKey),
                  preferenceAdjustment: lanePreferenceAdjustments[laneKey] ?? 0,
                });
                laneEvidence.push(...(lanePreferenceEvidence[laneKey] ?? []));
                if (laneDef.positive_concepts) {
                  for (const pc of laneDef.positive_concepts) {
                    if (containsConcept(descText, pc)) {
                      laneEvidence.push(`${laneKey}: "${pc}"`);
                      break;
                    }
                  }
                }
              }
            }
          }
          secondaryCandidates.sort((a, b) => {
            const scoreDifference = Math.abs(a.score - b.score);
            if (scoreDifference > 0.03) return b.score - a.score;
            const preferenceDifference = b.preferenceAdjustment - a.preferenceAdjustment;
            if (Math.abs(preferenceDifference) > 1e-9) return preferenceDifference;
            if (scoreDifference > 1e-9) return b.score - a.score;
            return a.rank - b.rank;
          });
          const secondaryLanes = secondaryCandidates.map((c) => c.laneKey);

          const noActiveLaneMatch = bestLane === "UNCLASSIFIED";
          const processingStatus = noActiveLaneMatch ? "UNMATCHED" : "LANE_ROUTED";
          const finalLaneEvidence =
            noActiveLaneMatch
              ? [...laneEvidence, "NO_ACTIVE_LANE_MATCH"]
              : [
                  ...laneEvidence,
                  `${bestLane}:domain_score=${(domainScoreMap[bestLane] ?? 0).toFixed(3)}`,
                  `${bestLane}:function_score=${(functionScoreMap[bestLane] ?? 0).toFixed(3)}`,
                ];

          const evaluatedAt = new Date().toISOString();
          const laneDecisionId = await persistLaneDecision({
            canonicalJobId: job.id,
            jobVersionId: job.latest_version_id,
            embeddingProvider: provider,
            embeddingModel: publishedSet?.model,
            embeddingDimensions: jobEmbedding.length,
            primaryLane: bestLane,
            secondaryLanes,
            laneConfidence,
            semanticScores: scoreMap,
            laneEvidence: finalLaneEvidence,
            evaluatedAt,
          });

          const canonicalUpdate = await client.query(
            `UPDATE canonical_jobs
             SET primary_lane       = $1,
                 semantic_score     = $2,
                 processing_state   = $3::varchar,
                 processing_status  = $3::varchar,
                 lane_confidence    = $4,
                 secondary_lanes    = $5::jsonb,
                 lane_evidence      = $6::jsonb,
                 routing_disposition = CASE
                   WHEN $3::varchar = 'LANE_ROUTED' THEN 'ROUTED'
                   WHEN $10::boolean THEN 'POLICY_NO_MATCH'
                   ELSE 'TECHNICAL_DEFERRED'
                 END,
                 rejection_reason = CASE
                   WHEN $3::varchar = 'LANE_ROUTED' THEN NULL
                   WHEN $10::boolean THEN 'NO_ACTIVE_LANE_MATCH'
                   ELSE rejection_reason
                 END,
                 recommendation_eligibility = CASE
                   WHEN $10::boolean THEN 'INELIGIBLE'
                   ELSE recommendation_eligibility
                 END,
                 recommendation_outcome = CASE
                   WHEN $10::boolean THEN 'SKIP'
                   ELSE recommendation_outcome
                 END,
                 updated_at         = NOW()
             WHERE workspace_id = $7
               AND id = $8
               AND latest_job_version_id = $9`,
            [
              bestLane,
              bestScore,
              processingStatus,
              laneConfidence,
              JSON.stringify(secondaryLanes),
              JSON.stringify(finalLaneEvidence),
              ctx.workspaceId,
              job.id,
              job.latest_version_id,
              noActiveLaneMatch,
            ]
          );

          if (canonicalUpdate?.rowCount === 0) {
            await client.query("COMMIT");
            continue;
          }

          if (laneDecisionId) {
            await client.query(
              `UPDATE canonical_jobs
               SET latest_lane_decision_id = $3,
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $2
                 AND latest_job_version_id = $4`,
              [ctx.workspaceId, job.id, laneDecisionId, job.latest_version_id]
            );
          }

          await client.query("COMMIT");
          if (processingStatus === "LANE_ROUTED") routedCount++;
          const scoreLabel = noActiveLaneMatch ? "BestScore" : "Score";
          const reasonLabel =
            noActiveLaneMatch && finalLaneEvidence.length > 0
              ? `, Reason: ${finalLaneEvidence[0]}`
              : "";
          console.log(
            `  -> Job ${job.id} ("${job.normalized_title}"): ${bestLane} (${scoreLabel}: ${bestScore.toFixed(3)}, Status: ${processingStatus}${reasonLabel})`
          );
        } catch (jobErr) {
          await client.query("ROLLBACK");
          if (jobErr instanceof EmbeddingRunError) {
            throw jobErr;
          }

          const message = jobErr instanceof Error ? jobErr.message : String(jobErr);
          const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
          console.error(`❌ Failed to route job ${job.id}:`, jobErr);
          const evaluatedAt = new Date().toISOString();
          const laneDecisionId = await persistLaneDecision({
            canonicalJobId: job.id,
            jobVersionId: job.latest_version_id,
            embeddingProvider: provider,
            embeddingModel: publishedSet?.model,
            embeddingDimensions: prototypeDimensions ?? 0,
            primaryLane: "UNCLASSIFIED",
            secondaryLanes: [],
            laneConfidence: "None",
            semanticScores: {},
            laneEvidence: [`ROUTING_ERROR:${trimmed}`],
            evaluatedAt,
          });
          const canonicalUpdate = await client.query(
            `UPDATE canonical_jobs
             SET primary_lane = 'UNCLASSIFIED',
                 semantic_score = 0.0,
                 lane_confidence = 'None',
                 secondary_lanes = $3::jsonb,
                 lane_evidence = $4::jsonb,
                 routing_disposition = 'TECHNICAL_DEFERRED',
                 processing_state = 'ROUTING_DEFERRED',
                 processing_status = 'ROUTING_DEFERRED',
                 updated_at = NOW()
             WHERE workspace_id = $1
               AND id = $2
               AND latest_job_version_id = $5`,
            [
              ctx.workspaceId,
              job.id,
              JSON.stringify([]),
              JSON.stringify([`ROUTING_ERROR:${trimmed}`]),
              job.latest_version_id,
            ]
          );
          if (canonicalUpdate?.rowCount !== 0 && laneDecisionId) {
            await client.query(
              `UPDATE canonical_jobs
               SET latest_lane_decision_id = $3,
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $2
                 AND latest_job_version_id = $4`,
              [ctx.workspaceId, job.id, laneDecisionId, job.latest_version_id]
            );
          }
          if (canonicalUpdate?.rowCount !== 0) deferredCount += 1;
        }
      }

      return { routed: routedCount, deferred: deferredCount };
    };

    let lastError: unknown = null;
    const publishedProviderOrder = providerOrder.filter((provider) => publishedEmbeddingSets.has(provider));
    const routingProviderOrder = publishedProviderOrder.length > 0 ? publishedProviderOrder : providerOrder;
    if (publishedProviderOrder.length > 0) {
      console.log(
        `Using complete published embedding space(s) for lane routing: ${publishedProviderOrder.join(", ")}`
      );
    }
    for (const provider of routingProviderOrder) {
      try {
        const result = await routeWithProvider(provider);
        console.log(
          `Semantic Lane Routing complete. Routed: ${result.routed}, Deferred: ${result.deferred}`
        );
        return result;
      } catch (error: unknown) {
        lastError = error;
        if (error instanceof EmbeddingRunError) {
          const where = error.jobId ? `job ${error.jobId}` : "prototype embeddings";
          console.warn(
            `⚠️ Embedding provider ${provider} failed during ${where}: ${error.message}. Trying fallback...`
          );
          continue;
        }
        throw error;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError || "unknown");
    const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
    let deferredCount = 0;

    for (const job of jobs) {
      const deferredUpdate = await client.query(
        `UPDATE canonical_jobs
         SET primary_lane = 'UNCLASSIFIED',
             semantic_score = 0.0,
             lane_confidence = 'None',
             secondary_lanes = $3::jsonb,
             lane_evidence = $4::jsonb,
             routing_disposition = 'TECHNICAL_DEFERRED',
             processing_state = 'ROUTING_DEFERRED',
             processing_status = 'ROUTING_DEFERRED',
             updated_at = NOW()
         WHERE workspace_id = $1
           AND id = $2
           AND latest_job_version_id = $5`,
        [
          ctx.workspaceId,
          job.id,
          JSON.stringify([]),
          JSON.stringify([`EMBEDDING_UNAVAILABLE:${trimmed}`]),
          job.latest_version_id,
        ]
      );
      if (deferredUpdate?.rowCount !== 0) deferredCount += 1;
    }

    console.warn(
      `⚠️ Semantic Lane Routing deferred all jobs due to embedding failure: ${trimmed}`
    );

    return { routed: 0, deferred: deferredCount };
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}
