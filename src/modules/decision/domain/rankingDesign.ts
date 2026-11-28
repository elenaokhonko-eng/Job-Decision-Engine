/**
 * The ranking design: the owner's role types, statuses, sectors and employer lists. It is profile data and lives in
 * private/profile/ranking_design.json; the repository holds only this schema and an invented example
 * (fixtures/ranking_design.example.json). No preference has a default here: a missing or invalid design fails. Pure.
 */
import { z } from "zod";

/** What a title says the job is. The design maps each kind to one of its role types. */
export const ROLE_KINDS = [
  "AI_ENGINEERING",
  "ARCHITECTURE",
  "RESEARCH_ENGINEERING",
  "DATA_ML",
  "SOFTWARE",
  "PRODUCT",
  "DELIVERY_MANAGEMENT",
  "AI_STRATEGY_LEADERSHIP",
  "ENGINEERING_MANAGEMENT",
  "FORWARD_DEPLOYED",
] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** Lane tags of config/companies.yml that describe what a role does, not what the employer does: never an industry. */
export const FUNCTION_TAGS: readonly string[] = ["CORE_AI_DATA", "TECHNICAL_PRODUCT_TRANSFORMATION"];

const Name = z.string().trim().min(1);
const Status = z.enum(["TARGET", "NEUTRAL", "TRANSITION", "NEVER"]);
export type RoleStatus = z.infer<typeof Status>;

const RoleTypeSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: Name,
  priority: z.number().int().positive(),
  /** The status when no conditional status below applies. */
  status: Status,
  kinds: z.array(z.enum(ROLE_KINDS)).min(1),
  ordering: z.enum(["STANDARD", "LOAD_AWARE"]),
  /** Conditional statuses, tried in this order. */
  status_when: z.object({
    external_client_facing: Status.optional(),
    consulting_employer: Status.optional(),
    in_house: Status.optional(),
  }).strict().optional(),
  /** A known fact against a requirement leaves the job out of the lists. An unknown fact never does. */
  requires: z.object({
    work_modes: z.array(z.enum(["REMOTE", "HYBRID", "ONSITE"])).min(1).optional(),
    max_travel_percent: z.number().min(0).max(100).optional(),
    top_technology_employer: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type RoleType = z.infer<typeof RoleTypeSchema>;

export const RankingDesignSchema = z.object({
  schema_version: z.literal("ranking_design_v1"),
  industries: z.object({ preferred: z.array(Name).min(1), neutral: z.array(Name), never: z.array(Name) }).strict(),
  /** config/companies.yml tag to industry, for the tags that really name the employer's industry. */
  company_tag_industries: z.record(Name, Name),
  /** The private employer-industry list. `names` are the ways the employer is written. */
  employers: z.array(z.object({ industry: Name, names: z.array(Name).min(1) }).strict()),
  /** Words in an employer's name that state its industry. */
  employer_name_words: z.array(z.object({ industry: Name, words: z.array(Name).min(1) }).strict()),
  /**
   * Employers with their own sector decision, which overrides every other source. A design that holds the list is
   * unusable until it is approved; a design without it overrides nothing.
   */
  employer_override: z.object({ approved: z.boolean(), industry: Name, employers: z.array(Name).min(1) }).strict().optional(),
  consulting: z.object({ employers: z.array(Name), employer_name_words: z.array(Name) }).strict(),
  top_technology_employers: z.array(Name),
  /** Title words or phrases that put a role out of every list. */
  never_role_title_phrases: z.array(Name),
  /** A people-management role, or an engineering-management title, whose posting shows no hands-on work. */
  management_without_hands_on: z.enum(["NEVER", "KEEP"]),
  role_types: z.array(RoleTypeSchema).min(1),
  /** An unknown role never leaves the pool, so it cannot be NEVER. */
  unknown_role_status: z.enum(["TARGET", "NEUTRAL", "TRANSITION"]),
  stakeholder_heavy_min_mentions: z.number().int().positive(),
  lists: z.object({
    size: z.number().int().positive(),
    overall_size: z.number().int().positive(),
    comparison_size: z.number().int().nonnegative(),
    /** How many of the comparison jobs have an unknown role type; the rest have a known one. */
    comparison_unknown_role_size: z.number().int().nonnegative(),
    comparison_band: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    /** The overall list takes unsaved jobs only; saved jobs stay in the per-type lists. */
    overall_from_unsaved_only: z.boolean().default(true),
    seed: Name,
  }).strict(),
}).strict().superRefine((design, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  const declared = [...design.industries.preferred, ...design.industries.neutral, ...design.industries.never];
  if (new Set(declared).size !== declared.length) fail("An industry is listed twice in `industries`.");
  const referenced = [
    ...Object.values(design.company_tag_industries),
    ...design.employers.map((entry) => entry.industry),
    ...design.employer_name_words.map((entry) => entry.industry),
    ...(design.employer_override ? [design.employer_override.industry] : []),
  ];
  if (referenced.some((industry) => !declared.includes(industry))) fail("An industry is used but not declared in `industries`.");
  for (const tag of Object.keys(design.company_tag_industries)) {
    if (FUNCTION_TAGS.includes(tag)) fail(`Tag ${tag} describes the role, not the employer's industry.`);
  }
  const kinds = design.role_types.flatMap((type) => type.kinds);
  for (const kind of ROLE_KINDS) {
    const uses = kinds.filter((value) => value === kind).length;
    if (uses !== 1) fail(`Role kind ${kind} must belong to exactly one role type (found ${uses}).`);
  }
  for (const field of ["key", "priority"] as const) {
    if (new Set(design.role_types.map((type) => type[field])).size !== design.role_types.length) {
      fail(`Role type ${field} values must be unique.`);
    }
  }
  if (design.lists.comparison_band[0] >= design.lists.comparison_band[1]) fail("lists.comparison_band must be increasing.");
  if (design.lists.comparison_unknown_role_size > design.lists.comparison_size) {
    fail("lists.comparison_unknown_role_size cannot exceed lists.comparison_size.");
  }
});
export type RankingDesign = z.infer<typeof RankingDesignSchema>;

/** Parses the design. Errors name fields and rules, never the private values around them. */
export function parseRankingDesign(text: string): RankingDesign {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("The ranking design is not valid JSON.");
  }
  const result = RankingDesignSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join(".") || "(design)"}: ${issue.message}`);
    throw new Error(`The ranking design is invalid:\n${problems.join("\n")}`);
  }
  return result.data;
}

/** The override list decides sectors, so no list is built until the owner has approved it. */
export function requireApprovedDesign(design: RankingDesign): void {
  if (design.employer_override && !design.employer_override.approved) {
    throw new Error(
      "Refusing to build review lists: employer_override.approved is false in the ranking design. " +
      "The owner approves that employer list, then sets it to true.",
    );
  }
}
