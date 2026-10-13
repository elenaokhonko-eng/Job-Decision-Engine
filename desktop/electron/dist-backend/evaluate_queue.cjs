Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let pg = require("pg");
pg = __toESM(pg, 1);
let dotenv = require("dotenv");
dotenv = __toESM(dotenv, 1);
let crypto = require("crypto");
crypto = __toESM(crypto, 1);
let zod = require("zod");
//#region src/contracts/version.ts
var SCHEMA_VERSION = "2.2.0";
var schemaVersions = [SCHEMA_VERSION, ...["2.0", "1.0.0"]];
var SchemaVersionSchema = zod.z.enum(schemaVersions);
var GATE_VERSION = SCHEMA_VERSION;
var PROFILE_SCHEMA_VERSION = SCHEMA_VERSION;
//#endregion
//#region src/contracts/sourcePlugin.ts
var SourceKeySchema = zod.z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);
var SourcePluginKindSchema = zod.z.enum([
	"ats",
	"json_api",
	"rss",
	"atom",
	"schema_org",
	"email_alert",
	"manual_import"
]);
var SourcePluginStatusSchema = zod.z.enum([
	"active",
	"experimental",
	"disabled",
	"deprecated"
]);
var SourcePluginCapabilitiesSchema = zod.z.object({
	discovery: zod.z.boolean(),
	pagination: zod.z.boolean(),
	incremental: zod.z.boolean(),
	location_filter: zod.z.boolean(),
	work_mode_evidence: zod.z.boolean()
});
var SourcePluginComplianceSchema = zod.z.object({
	access_basis: zod.z.enum([
		"official_api",
		"public_feed",
		"user_supplied",
		"manual_import",
		"documented_permission"
	]),
	terms_url: zod.z.string().url(),
	license: zod.z.string().nullable().optional(),
	attribution_required: zod.z.boolean(),
	attribution_text: zod.z.string().nullable().optional(),
	authenticated_scraping: zod.z.literal(false),
	reviewed_at: zod.z.string().optional()
});
var SourcePluginScheduleSchema = zod.z.object({
	enabled: zod.z.boolean(),
	interval_minutes: zod.z.number().int().min(15).max(10080),
	jitter_seconds: zod.z.number().int().min(0).max(3600).default(0)
});
var SourcePluginRetrySchema = zod.z.object({
	max_attempts: zod.z.number().int().min(0).max(10),
	base_delay_ms: zod.z.number().int().min(100),
	max_delay_ms: zod.z.number().int().min(100)
});
var SourcePluginRateLimitSchema = zod.z.object({
	requests_per_minute: zod.z.number().int().min(1),
	items_per_run: zod.z.number().int().min(1).nullable()
});
var SourcePluginPaginationSchema = zod.z.object({
	strategy: zod.z.enum([
		"none",
		"page",
		"cursor",
		"link_header",
		"updated_since"
	]),
	page_parameter: zod.z.string().nullable().optional(),
	cursor_json_path: zod.z.string().nullable().optional(),
	next_link_json_path: zod.z.string().nullable().optional(),
	checkpoint_field: zod.z.string().nullable().optional()
});
var SourcePluginQuerySchema = zod.z.object({
	keywords: zod.z.array(zod.z.string()).optional(),
	locations: zod.z.array(zod.z.string()).optional(),
	work_modes: zod.z.array(zod.z.enum([
		"REMOTE",
		"HYBRID",
		"ONSITE",
		"UNKNOWN"
	])).optional(),
	lane_keys: zod.z.array(zod.z.string()).optional()
}).optional();
var SourcePluginRequestSchema = zod.z.object({
	endpoint: zod.z.string().url(),
	timeout_ms: zod.z.number().int().min(1e3).max(12e4),
	headers_from_secret_keys: zod.z.array(zod.z.string()).default([]).optional(),
	retry: SourcePluginRetrySchema,
	rate_limit: SourcePluginRateLimitSchema,
	pagination: SourcePluginPaginationSchema,
	query: SourcePluginQuerySchema
});
var SourcePluginMappingSchema = zod.z.object({
	external_id: zod.z.string(),
	title: zod.z.string(),
	company: zod.z.string(),
	description: zod.z.string(),
	url: zod.z.string(),
	location: zod.z.string(),
	work_mode: zod.z.string(),
	employment_type: zod.z.string(),
	posted_at: zod.z.string().nullable().optional(),
	updated_at: zod.z.string().nullable().optional()
});
zod.z.object({
	schema_version: zod.z.literal(SCHEMA_VERSION),
	source_key: SourceKeySchema,
	display_name: zod.z.string().min(1).max(100),
	kind: SourcePluginKindSchema,
	status: SourcePluginStatusSchema,
	capabilities: SourcePluginCapabilitiesSchema,
	compliance: SourcePluginComplianceSchema,
	schedule: SourcePluginScheduleSchema,
	request: SourcePluginRequestSchema,
	mapping: SourcePluginMappingSchema
});
//#endregion
//#region src/contracts/index.ts
var SourceNameSchema = zod.z.enum([
	"GMAIL_ALERT",
	"GREENHOUSE",
	"LEVER",
	"ASHBY",
	"HIMALAYAS",
	"JOBICY",
	"REMOTIVE",
	"WE_WORK_REMOTELY",
	"STARTUP_JOBS",
	"MANUAL_IMPORT",
	"MANUAL_STREAMLIT",
	"LINKEDIN"
]);
zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	source_type: SourceNameSchema,
	source_id: zod.z.string().min(1),
	source_run_id: zod.z.string().uuid(),
	observed_at: zod.z.string().datetime(),
	raw_payload_hash: zod.z.string().min(1),
	raw_payload: zod.z.string().min(1),
	metadata: zod.z.record(zod.z.unknown()).default({})
});
zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	source_external_id: zod.z.string().min(1).optional(),
	company_name: zod.z.string().min(1),
	title: zod.z.string().min(1),
	location_raw: zod.z.string().default("Unknown"),
	workplace_type_raw: zod.z.string().default("UNKNOWN"),
	employment_type_raw: zod.z.string().default("UNKNOWN"),
	compensation_raw: zod.z.string().default("UNKNOWN"),
	canonical_apply_url: zod.z.string().url().or(zod.z.string().min(1)),
	description_raw: zod.z.string().min(1),
	published_at: zod.z.string().datetime().optional(),
	feed_delay_hours: zod.z.number().nonnegative().optional(),
	source_attribution: zod.z.string().min(1).optional(),
	raw_payload: zod.z.unknown().optional()
});
zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	id: zod.z.string().uuid(),
	workspace_id: zod.z.string().uuid(),
	source_type: SourceNameSchema,
	source_id: zod.z.string().min(1),
	source_run_id: zod.z.string().uuid(),
	source_plugin_key: zod.z.string().min(1).nullable().default(null),
	source_plugin_revision_id: zod.z.string().uuid().nullable().default(null),
	source_external_id: zod.z.string().min(1).nullable().default(null),
	source_url: zod.z.string().min(1).nullable().default(null),
	observed_at: zod.z.string().datetime(),
	retrieved_at: zod.z.string().datetime(),
	company_name_raw: zod.z.string().min(1),
	title_raw: zod.z.string().min(1),
	location_raw: zod.z.string().default("Unknown"),
	workplace_type_raw: zod.z.string().default("UNKNOWN"),
	employment_type_raw: zod.z.string().default("UNKNOWN"),
	compensation_raw: zod.z.string().default("UNKNOWN"),
	canonical_apply_url: zod.z.string().min(1),
	source_lane: zod.z.string().min(1).nullable().default(null),
	search_plan_version: zod.z.string().min(1).default("1.0"),
	description_text: zod.z.string().min(1),
	raw_payload: zod.z.unknown().nullable().default(null),
	raw_payload_hash: zod.z.string().min(1),
	processing_status: zod.z.enum([
		"PENDING",
		"PROCESSED",
		"PARSE_FAILED",
		"FETCH_FAILED",
		"DESCRIPTION_INCOMPLETE"
	]).default("PENDING"),
	error_history: zod.z.array(zod.z.record(zod.z.unknown())).default([]),
	job_version_id: zod.z.string().uuid().nullable().default(null)
});
zod.z.object({
	schema_version: SchemaVersionSchema,
	workspace_id: zod.z.string().uuid(),
	source_run_id: zod.z.string().uuid(),
	source_type: SourceNameSchema,
	source_plugin_key: zod.z.string().min(1),
	source_plugin_revision_id: zod.z.string().uuid().nullable(),
	source_external_id: zod.z.string().min(1).nullable(),
	source_url: zod.z.string().min(1).nullable(),
	retrieved_at: zod.z.string().datetime(),
	company_name_raw: zod.z.string().min(1),
	title_raw: zod.z.string().min(1),
	description_text: zod.z.string().min(1),
	location_raw: zod.z.string().nullable(),
	workplace_type_raw: zod.z.string().nullable(),
	employment_type_raw: zod.z.string().nullable(),
	compensation_raw: zod.z.string().nullable(),
	canonical_apply_url: zod.z.string().min(1).nullable(),
	source_lane: zod.z.string().min(1).nullable(),
	search_plan_version: zod.z.string().min(1),
	raw_payload: zod.z.unknown(),
	raw_payload_hash: zod.z.string().min(1)
});
zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().min(1),
	company_name: zod.z.string().min(1),
	normalized_title: zod.z.string().min(1),
	canonical_url: zod.z.string().min(1),
	location_summary: zod.z.string().default("Unknown"),
	workplace_type: zod.z.enum([
		"REMOTE",
		"HYBRID",
		"ONSITE",
		"UNKNOWN"
	]).default("UNKNOWN"),
	employment_type: zod.z.string().default("UNKNOWN"),
	description_text: zod.z.string().min(1),
	version_number: zod.z.number().int().positive().default(1),
	observed_at: zod.z.string().datetime(),
	processing_state: zod.z.enum([
		"RAW_STAGED",
		"HARD_REJECTED",
		"MANUALLY_REMOVED",
		"NEEDS_VERIFICATION",
		"PREQUALIFIED",
		"ROUTING_DEFERRED",
		"LANE_ROUTED",
		"MATCHED",
		"SEMANTIC_SHORTLISTED",
		"QUEUED_FOR_AI",
		"DEFERRED_BUDGET",
		"EVALUATING",
		"AI_EVALUATED",
		"EVALUATED",
		"RETRY_WAIT",
		"NEEDS_MANUAL_REVIEW",
		"REJECTED_AFTER_EVALUATION"
	]).default("RAW_STAGED"),
	processing_status: zod.z.enum([
		"RAW_STAGED",
		"HARD_REJECTED",
		"MANUALLY_REMOVED",
		"NEEDS_VERIFICATION",
		"PREQUALIFIED",
		"ROUTING_DEFERRED",
		"LANE_ROUTED",
		"MATCHED",
		"SEMANTIC_SHORTLISTED",
		"QUEUED_FOR_AI",
		"DEFERRED_BUDGET",
		"EVALUATING",
		"AI_EVALUATED",
		"EVALUATED",
		"RETRY_WAIT",
		"NEEDS_MANUAL_REVIEW",
		"REJECTED_AFTER_EVALUATION"
	]).default("RAW_STAGED"),
	recommendation_eligibility: zod.z.enum([
		"ELIGIBLE",
		"VERIFY",
		"INELIGIBLE"
	]).nullable().default(null),
	recommendation_outcome: zod.z.enum([
		"PRIORITY",
		"REVIEW",
		"TRACK",
		"SKIP"
	]).nullable().default(null),
	recommendation_requirement_score: zod.z.number().min(0).max(1).nullable().default(null),
	recommendation_coverage_score: zod.z.number().min(0).max(1).nullable().default(null),
	recommendation_evidence_completeness: zod.z.number().min(0).max(1).nullable().default(null),
	recommendation_decided_at: zod.z.string().datetime().nullable().default(null)
});
/**
* 5. Workability Facts
* Persisted deterministic workability evidence shared by gate, queue, and UI.
*/
var WorkabilityFactsSchema = zod.z.object({
	office_days_min: zod.z.number().int().min(0).max(7).nullable(),
	office_days_max: zod.z.number().int().min(0).max(7).nullable(),
	travel_pct_max: zod.z.number().min(0).max(100).nullable(),
	employment_type: zod.z.enum([
		"PERMANENT",
		"CONTRACT",
		"UNKNOWN"
	]),
	location_restriction: zod.z.string().nullable()
});
function toEvaluationWorkabilityFacts(facts) {
	const parsed = WorkabilityFactsSchema.parse(facts);
	return {
		locationEligibility: parsed.location_restriction ? "FAIL" : "PASS",
		officeDays: parsed.office_days_max ?? "UNKNOWN",
		travelPercentage: parsed.travel_pct_max ?? "UNKNOWN",
		isContract: parsed.employment_type === "CONTRACT"
	};
}
zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().min(1),
	pipeline_run_id: zod.z.string().uuid(),
	gate_version: zod.z.string().min(1),
	status: zod.z.enum([
		"PASS",
		"NEEDS_VERIFICATION",
		"HARD_REJECT"
	]),
	rejection_codes: zod.z.array(zod.z.string()).default([]),
	evidence_quotes: zod.z.array(zod.z.string()).default([]),
	workability_facts: WorkabilityFactsSchema,
	evaluated_at: zod.z.string().datetime()
}).extend({ schema_version: SchemaVersionSchema });
/**
* 6. Lane Decision
* Multi-lane semantic classification outcome.
*/
var LaneKeySchema = zod.z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().min(1),
	pipeline_run_id: zod.z.string().uuid(),
	model_version: zod.z.string().min(1),
	primary_lane: LaneKeySchema.nullable(),
	secondary_lanes: zod.z.array(LaneKeySchema).default([]),
	lane_confidence: zod.z.enum([
		"High",
		"Medium",
		"Low",
		"None"
	]),
	semantic_scores: zod.z.record(LaneKeySchema, zod.z.number()).default({}),
	lane_evidence: zod.z.array(zod.z.string()).default([]),
	evaluated_at: zod.z.string().datetime()
}).extend({ schema_version: SchemaVersionSchema });
zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	id: zod.z.string().uuid(),
	workspace_id: zod.z.string().uuid(),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().min(1),
	profile_version_id: zod.z.string().uuid().nullable().default(null),
	match_run_id: zod.z.string().uuid().nullable().default(null),
	deterministic_decision_id: zod.z.string().uuid().nullable().default(null),
	job_content_hash: zod.z.string().min(1).nullable().default(null),
	context_fingerprint: zod.z.string().min(1).nullable().default(null),
	lane: LaneKeySchema,
	priority_score: zod.z.number(),
	status: zod.z.enum([
		"PENDING",
		"EVALUATING",
		"COMPLETED",
		"RETRY_WAIT",
		"FAILED",
		"NEEDS_MANUAL_REVIEW"
	]).default("PENDING"),
	budget_run_id: zod.z.string().uuid().nullable().default(null),
	available_at: zod.z.string().datetime().nullable().default(null),
	lease_id: zod.z.string().uuid().nullable().default(null),
	lease_expires_at: zod.z.string().datetime().nullable().default(null),
	attempt_count: zod.z.number().int().nonnegative().default(0),
	max_attempts: zod.z.number().int().positive().default(3),
	last_error: zod.z.string().nullable().default(null),
	enqueued_at: zod.z.string().datetime(),
	updated_at: zod.z.string().datetime()
}).extend({ schema_version: SchemaVersionSchema });
/**
* 8. Evaluation Result
* Full structured LLM output with cultural, risk, and career scoring.
*/
var EvaluationResultSchema = zod.z.object({
	schema_version: SchemaVersionSchema.default(SCHEMA_VERSION),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().min(1),
	pipeline_run_id: zod.z.string().uuid(),
	provider: zod.z.enum([
		"gemini",
		"openai",
		"local",
		"mock"
	]),
	model: zod.z.string().min(1),
	attempt: zod.z.number().int().positive().default(1),
	is_fallback: zod.z.boolean().default(false),
	degraded_state: zod.z.boolean().default(false),
	evaluation_summary: zod.z.string().min(1),
	primary_lane: LaneKeySchema.nullable(),
	secondary_lanes: zod.z.array(LaneKeySchema).default([]),
	lane_confidence: zod.z.enum([
		"High",
		"Medium",
		"Low"
	]),
	lane_evidence: zod.z.string().default(""),
	nd_score: zod.z.number().int().min(0).max(100),
	nd_friendly_score: zod.z.number().int().min(0).max(100),
	politics_stress_score: zod.z.number().int().min(0).max(100),
	sensory_overload_index: zod.z.number().int().min(0).max(100),
	building_research_ratio: zod.z.number().int().min(0).max(100),
	interaction_load: zod.z.number().int().min(0).max(100),
	rejection_codes: zod.z.array(zod.z.string()).default([]),
	strategic_value: zod.z.string().default(""),
	recommended_cv_version: zod.z.string().default("None"),
	next_action: zod.z.enum([
		"PRIORITY_APPLY",
		"APPLY_AFTER_VERIFICATION",
		"LOW_STRATEGIC_VALUE",
		"REJECTED"
	]),
	evaluated_at: zod.z.string().datetime()
});
var ApplicationStatusSchema = zod.z.enum([
	"INTENT",
	"READY_TO_APPLY",
	"SUBMITTED",
	"FOLLOW_UP",
	"INTERVIEW",
	"OFFER",
	"REJECTED",
	"WITHDRAWN",
	"CLOSED"
]);
zod.z.object({
	application_record_id: zod.z.string().uuid(),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	title: zod.z.string().min(1),
	company: zod.z.string().min(1),
	canonical_url: zod.z.string().min(1).nullable().default(null),
	processing_state: zod.z.string().nullable().default(null),
	processing_status: zod.z.string().nullable().default(null),
	recommendation_eligibility: zod.z.enum([
		"ELIGIBLE",
		"VERIFY",
		"INELIGIBLE"
	]).nullable().default(null),
	recommendation_outcome: zod.z.enum([
		"PRIORITY",
		"REVIEW",
		"TRACK",
		"SKIP"
	]).nullable().default(null),
	primary_lane: LaneKeySchema.nullable().default(null),
	secondary_lanes: zod.z.array(LaneKeySchema).nullable().default(null),
	application_status: ApplicationStatusSchema,
	submission_url: zod.z.string().nullable().default(null),
	cv_document_run_id: zod.z.string().uuid().nullable().default(null),
	cover_letter_document_run_id: zod.z.string().uuid().nullable().default(null),
	notes: zod.z.string().nullable().default(null),
	handoff_payload: zod.z.record(zod.z.unknown()).default({}),
	target_submit_at: zod.z.string().datetime().nullable().default(null),
	submitted_at: zod.z.string().datetime().nullable().default(null),
	follow_up_at: zod.z.string().datetime().nullable().default(null),
	last_action_at: zod.z.string().datetime(),
	created_at: zod.z.string().datetime(),
	updated_at: zod.z.string().datetime()
});
zod.z.object({
	id: zod.z.string().uuid(),
	application_record_id: zod.z.string().uuid(),
	event_type: zod.z.enum([
		"CREATED",
		"STATUS_CHANGED",
		"DOCUMENT_LINKED",
		"NOTE_ADDED",
		"SUBMISSION_HANDOFF",
		"FOLLOW_UP_SCHEDULED"
	]),
	from_status: ApplicationStatusSchema.nullable().default(null),
	to_status: ApplicationStatusSchema.nullable().default(null),
	note: zod.z.string().nullable().default(null),
	event_payload: zod.z.record(zod.z.unknown()).default({}),
	created_at: zod.z.string().datetime()
});
zod.z.object({
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().min(1),
	title: zod.z.string().min(1),
	company: zod.z.string().min(1),
	canonical_url: zod.z.string().min(1),
	source: SourceNameSchema.default("GMAIL_ALERT"),
	location: zod.z.string().default("Unknown"),
	workplace_type: zod.z.string().default("UNKNOWN"),
	employment_type: zod.z.string().default("UNKNOWN"),
	description: zod.z.string().nullable().default(null),
	gate_status: zod.z.enum([
		"PASS",
		"NEEDS_VERIFICATION",
		"HARD_REJECT"
	]),
	rejection_codes: zod.z.array(zod.z.string()).nullable().default(null),
	gate_evidence_quotes: zod.z.array(zod.z.string()).nullable().default(null),
	primary_lane: LaneKeySchema.nullable(),
	secondary_lanes: zod.z.array(LaneKeySchema).default([]),
	lane_confidence: zod.z.enum([
		"High",
		"Medium",
		"Low",
		"None"
	]).default("None"),
	priority_score: zod.z.number().nullable().default(null),
	deterministic_match_score: zod.z.number().nullable().default(null),
	deterministic_match_coverage: zod.z.number().nullable().default(null),
	processing_state: zod.z.string(),
	processing_status: zod.z.string(),
	recommendation_eligibility: zod.z.enum([
		"ELIGIBLE",
		"VERIFY",
		"INELIGIBLE"
	]).nullable().default(null),
	recommendation_outcome: zod.z.enum([
		"PRIORITY",
		"REVIEW",
		"TRACK",
		"SKIP"
	]).nullable().default(null),
	recommendation_requirement_score: zod.z.number().min(0).max(1).nullable().default(null),
	recommendation_coverage_score: zod.z.number().min(0).max(1).nullable().default(null),
	recommendation_evidence_completeness: zod.z.number().min(0).max(1).nullable().default(null),
	recommendation_decided_at: zod.z.string().datetime().nullable().default(null),
	nd_friendly_score: zod.z.number().int().min(0).max(100).nullable().default(null),
	politics_stress_score: zod.z.number().int().min(0).max(100).nullable().default(null),
	sensory_overload_index: zod.z.number().int().min(0).max(100).nullable().default(null),
	next_action: zod.z.string().nullable().default(null),
	strategic_value: zod.z.string().nullable().default(null),
	recommended_cv_version: zod.z.string().nullable().default(null),
	evaluation_summary: zod.z.string().nullable().default(null),
	eval_provider: zod.z.string().nullable().default(null),
	eval_is_fallback: zod.z.boolean().nullable().default(null),
	version_mismatch: zod.z.boolean().default(false),
	observed_at: zod.z.string().datetime(),
	evaluated_at: zod.z.string().datetime().nullable().default(null),
	lane_matches: zod.z.array(zod.z.unknown()).nullable().default(null),
	workability_facts: zod.z.record(zod.z.unknown()).nullable().default(null),
	queue_status: zod.z.string().nullable().default(null),
	latest_match_run_id: zod.z.string().uuid().nullable().default(null),
	cv_document_run_id: zod.z.string().uuid().nullable().default(null),
	cover_letter_document_run_id: zod.z.string().uuid().nullable().default(null),
	document_ready: zod.z.boolean().default(false),
	current_artifact_status: zod.z.string().default("CURRENTNESS_UNKNOWN"),
	current_artifact_reason: zod.z.string().nullable().default(null),
	blocked_task_count: zod.z.number().int().min(0).default(0)
});
//#endregion
//#region src/db/pgSsl.ts
/**
* Canonical SSL configuration for all pg.Pool instances.
*
* - Local (localhost / 127.0.0.1 / CI container): no SSL needed.
* - All remote connections (Neon, RDS, Cloud SQL, etc.): require a valid cert.
*
* NEVER use rejectUnauthorized: false. It silently bypasses TLS verification
* and makes database connections vulnerable to MITM attacks.
*/
function pgSslConfig(connectionString) {
	if (!connectionString) return false;
	return isLocalPostgresConnectionString(connectionString) ? false : { rejectUnauthorized: true };
}
function pgConnectionConfig(connectionString) {
	const normalizedConnectionString = normalizePgConnectionString(connectionString);
	return {
		connectionString: normalizedConnectionString,
		ssl: pgSslConfig(normalizedConnectionString)
	};
}
var pgPoolConfig = pgConnectionConfig;
function normalizePgConnectionString(connectionString) {
	if (!connectionString) return connectionString;
	const trimmed = connectionString.trim();
	if (!trimmed) return connectionString;
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		return connectionString;
	}
	if (!isPostgresUrl(parsed)) return connectionString;
	const targetSslMode = isLocalPostgresUrl(parsed) ? "disable" : "verify-full";
	if (parsed.searchParams.get("sslmode")?.toLowerCase() !== targetSslMode) parsed.searchParams.set("sslmode", targetSslMode);
	return parsed.toString();
}
function isLocalPostgresConnectionString(connectionString) {
	const trimmed = connectionString.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("/") || trimmed.startsWith("socket:")) return true;
	try {
		const parsed = new URL(trimmed);
		if (!isPostgresUrl(parsed)) return false;
		return isLocalPostgresUrl(parsed);
	} catch {
		const lower = trimmed.toLowerCase();
		return lower.includes("localhost") || lower.includes("127.0.0.1") || lower.includes("::1");
	}
}
function isPostgresUrl(parsed) {
	const protocol = parsed.protocol.toLowerCase();
	return protocol === "postgres:" || protocol === "postgresql:";
}
function isLocalPostgresUrl(parsed) {
	const host = parsed.hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
function getWorkspaceKeyFromEnv() {
	return (process.env.WORKSPACE_KEY || "default").trim();
}
function getUserKeyFromEnv() {
	return (process.env.WORKSPACE_USER_KEY || process.env.USER_KEY || "local_user").trim();
}
async function resolveWorkspaceContext(client, options) {
	const workspaceKey = (options?.workspaceKey || getWorkspaceKeyFromEnv()).trim();
	const userKey = (options?.userKey || getUserKeyFromEnv()).trim();
	const { rows } = await client.query(`
      SELECT
        w.id AS workspace_id,
        u.id AS user_id,
        m.role AS role
      FROM workspaces w
      JOIN workspace_memberships m ON m.workspace_id = w.id
      JOIN workspace_users u ON u.id = m.user_id
      WHERE w.workspace_key = $1
        AND u.user_key = $2
        AND m.status = 'ACTIVE'
      LIMIT 1
    `, [workspaceKey, userKey]);
	if (rows.length === 0) throw new Error(`Unauthorized: no ACTIVE membership for user_key=${userKey} in workspace_key=${workspaceKey}`);
	return {
		workspaceId: rows[0].workspace_id,
		workspaceKey,
		userId: rows[0].user_id,
		userKey,
		role: rows[0].role
	};
}
//#endregion
//#region scripts/evaluate_queue.ts
dotenv.default.config();
dotenv.default.config({
	path: ".env.local",
	override: true
});
var pool = new pg.default.Pool(pgConnectionConfig(process.env.DATABASE_URL));
/** Exponential backoff: 30s, 60s, 120s, … capped at 30 minutes */
function nextAvailableAt(attemptCount) {
	return `NOW() + INTERVAL '${Math.min(30 * Math.pow(2, attemptCount), 1800)} seconds'`;
}
async function evaluateQueue() {
	console.log("====================================================");
	console.log("         STAGE 0: AI EVALUATION PROCESSOR           ");
	console.log("====================================================");
	const { evaluateSingleCanonicalJob, checkModelRegistryPreflight } = await Promise.resolve().then(() => require("./agent-BLJ8laJm.cjs"));
	const pipelineRunId = crypto.default.randomUUID();
	const client = await pool.connect();
	let processedCount = 0;
	let failedCount = 0;
	let manualReviewCount = 0;
	let eligibleCount = 0;
	try {
		const preflight = checkModelRegistryPreflight();
		if (!preflight.ok) throw new Error(`Model registry preflight failed: ${preflight.warnings.join(" | ")}`);
		const ctx = await resolveWorkspaceContext(client);
		const { rows: queueItems } = await client.query(`SELECT eq.*, c.normalized_title, c.company_name, c.canonical_url,
              c.gate_decision, c.workability_facts,
              jv.description_text, eq.job_version_id AS resolved_job_version_id,
              gd.id AS resolved_gate_decision_id
       FROM evaluation_queue eq
       JOIN canonical_jobs c
         ON c.id = eq.canonical_job_id
        AND c.workspace_id = eq.workspace_id
       JOIN job_versions jv
         ON jv.id = eq.job_version_id
        AND jv.workspace_id = eq.workspace_id
       JOIN deterministic_decisions dd
         ON dd.workspace_id = eq.workspace_id
        AND dd.id = eq.deterministic_decision_id
        AND dd.canonical_job_id = eq.canonical_job_id
        AND dd.job_version_id = eq.job_version_id
        AND dd.match_run_id = eq.match_run_id
        AND dd.context_fingerprint = eq.context_fingerprint
       LEFT JOIN gate_decisions gd
         ON gd.workspace_id = eq.workspace_id
        AND gd.canonical_job_id = eq.canonical_job_id
        AND gd.job_version_id = eq.job_version_id
       WHERE eq.workspace_id = $1
         AND (
           (eq.status = 'PENDING')
           OR (eq.status = 'RETRY_WAIT' AND (eq.available_at IS NULL OR eq.available_at <= NOW()))
           OR (eq.status = 'EVALUATING' AND eq.lease_expires_at < NOW())
         )
         AND eq.profile_version_id IS NOT NULL
         AND eq.match_run_id = c.latest_match_run_id
         AND eq.deterministic_decision_id = c.latest_deterministic_decision_id
         AND eq.job_content_hash = jv.content_hash
         AND eq.context_fingerprint IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM profile_versions pv
           WHERE pv.workspace_id = eq.workspace_id
             AND pv.id = eq.profile_version_id
             AND pv.status = 'ACTIVE'
         )
         AND EXISTS (
           SELECT 1
           FROM match_runs mr
           WHERE mr.workspace_id = eq.workspace_id
             AND mr.id = eq.match_run_id
             AND mr.canonical_job_id = eq.canonical_job_id
             AND mr.job_version_id = eq.job_version_id
             AND mr.profile_version_id = eq.profile_version_id
             AND mr.requirement_set_id = jv.active_requirement_set_id
             AND mr.job_content_hash = jv.content_hash
             AND mr.context_fingerprint IS NOT NULL
             AND mr.status = 'COMPLETED'
         )
       ORDER BY eq.priority_score DESC`, [ctx.workspaceId]);
		eligibleCount = queueItems.length;
		console.log(`Found ${queueItems.length} items eligible for AI evaluation. Pipeline run: ${pipelineRunId}`);
		let candidateProfileContext = "";
		if (queueItems.length > 0) {
			const profileVersion = (await client.query(`SELECT pv.id, cp.display_name, pv.source_hash
         FROM profile_versions pv
         JOIN candidate_profiles cp
           ON cp.workspace_id = pv.workspace_id
          AND cp.id = pv.candidate_profile_id
         WHERE pv.workspace_id = $1
           AND pv.status = 'ACTIVE'
         ORDER BY pv.created_at DESC
         LIMIT 1`, [ctx.workspaceId])).rows[0];
			if (!profileVersion) throw new Error("AI evaluation requires an ACTIVE database-backed profile version.");
			const [factsRes, credentialsRes, preferenceRes] = await Promise.all([
				client.query(`SELECT fact_key, fact_type, statement, structured_value,
                  evidence_tier, verification_status, confidentiality
           FROM profile_facts
           WHERE workspace_id = $1
             AND profile_version_id = $2
             AND verification_status IN ('VERIFIED', 'SELF_ATTESTED')
           ORDER BY fact_key`, [ctx.workspaceId, profileVersion.id]),
				client.query(`SELECT credential_key, credential_name, issuer, credential_type,
                  level, status, verification_status
           FROM profile_credentials
           WHERE workspace_id = $1
             AND profile_version_id = $2
             AND status = 'ACTIVE'
             AND verification_status IN ('VERIFIED', 'SELF_ATTESTED')
           ORDER BY credential_key`, [ctx.workspaceId, profileVersion.id]),
				client.query(`SELECT mode_key, content
           FROM workspace_user_preference_modes
           WHERE workspace_id = $1
             AND user_id = $2
             AND is_active = TRUE
           ORDER BY updated_at DESC
           LIMIT 1`, [ctx.workspaceId, ctx.userId])
			]);
			candidateProfileContext = JSON.stringify({
				profile_version_id: profileVersion.id,
				profile_display_name: profileVersion.display_name,
				profile_source_hash: profileVersion.source_hash,
				verified_profile_facts: factsRes.rows,
				verified_credentials: credentialsRes.rows,
				active_workability_preference_mode: preferenceRes.rows[0] ?? null
			});
		}
		for (const item of queueItems) {
			console.log(`\nEvaluating: [${item.lane}] ${item.normalized_title} at ${item.company_name}`);
			if (item.attempt_count >= (item.max_attempts || 3)) {
				console.warn(`⚠️ Maximum attempts (${item.max_attempts || 3}) exhausted for job ${item.canonical_job_id}. Moving to NEEDS_MANUAL_REVIEW.`);
				await client.query("BEGIN");
				try {
					if (((await client.query(`UPDATE evaluation_queue
             SET status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2
               AND (
                 status IN ('PENDING', 'RETRY_WAIT')
                 OR (status = 'EVALUATING' AND lease_expires_at < NOW())
               )
               AND attempt_count >= COALESCE(max_attempts, 3)
             RETURNING id`, [ctx.workspaceId, item.id])).rowCount ?? 0) > 0) {
						await client.query(`UPDATE canonical_jobs
               SET processing_state = 'NEEDS_MANUAL_REVIEW',
                   processing_status = 'NEEDS_MANUAL_REVIEW',
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $2
                 AND latest_job_version_id = $3`, [
							ctx.workspaceId,
							item.canonical_job_id,
							item.job_version_id
						]);
						manualReviewCount++;
					} else console.log(`Item ${item.id} changed state before manual-review fencing; skipping stale worker update.`);
					await client.query("COMMIT");
				} catch (mErr) {
					await client.query("ROLLBACK");
					throw mErr;
				}
				continue;
			}
			const { rows: leaseRows } = await client.query(`UPDATE evaluation_queue
         SET status = 'EVALUATING',
             lease_id = gen_random_uuid(),
             lease_expires_at = NOW() + INTERVAL '5 minutes',
             attempt_count = attempt_count + 1,
             updated_at = NOW()
         WHERE id = $1
           AND workspace_id = $2
           AND (status IN ('PENDING', 'RETRY_WAIT') OR (status = 'EVALUATING' AND lease_expires_at < NOW()))
         RETURNING *`, [item.id, ctx.workspaceId]);
			if (leaseRows.length === 0) {
				console.log(`Item ${item.id} already leased by another worker. Skipping.`);
				continue;
			}
			const activeLease = leaseRows[0];
			const attemptNum = activeLease.attempt_count;
			const activeLeaseId = activeLease.lease_id;
			const heartbeat = setInterval(() => {
				client.query(`UPDATE evaluation_queue
           SET lease_expires_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
           WHERE workspace_id = $1 AND id = $2 AND lease_id = $3`, [
					ctx.workspaceId,
					item.id,
					activeLeaseId
				]).then((result) => {
					if ((result.rowCount ?? 0) === 0) console.warn(`Lease fence lost for evaluation queue item ${item.id}.`);
				}).catch((error) => {
					console.warn(`Lease heartbeat failed for evaluation queue item ${item.id}:`, error);
				});
			}, 6e4);
			const jobVersionId = item.job_version_id;
			if (!jobVersionId) {
				console.warn(`⚠️ No job_version_id found for canonical job ${item.canonical_job_id}. Moving to RETRY_WAIT.`);
				failedCount++;
				await client.query(`UPDATE evaluation_queue SET status = 'RETRY_WAIT', last_error = $1,
           available_at = ${nextAvailableAt(attemptNum)}, lease_id = NULL, lease_expires_at = NULL, updated_at = NOW()
           WHERE workspace_id = $2 AND id = $3 AND lease_id = $4`, [
					"No job_version found",
					ctx.workspaceId,
					item.id,
					activeLeaseId
				]);
				clearInterval(heartbeat);
				continue;
			}
			const gateDecisionId = item.resolved_gate_decision_id || null;
			const evalReq = {
				canonicalJobId: item.canonical_job_id,
				jobVersionId,
				gateDecisionId: gateDecisionId || "LEGACY_NO_GATE_RECORD",
				gateVersion: GATE_VERSION,
				candidateLanes: [{
					lane: item.lane,
					semanticScore: item.priority_score,
					evidence: []
				}],
				workabilityFacts: toEvaluationWorkabilityFacts(item.workability_facts || {
					office_days_min: null,
					office_days_max: null,
					travel_pct_max: null,
					employment_type: "UNKNOWN",
					location_restriction: null
				}),
				unknownFields: [],
				profileVersion: PROFILE_SCHEMA_VERSION,
				evaluationSchemaVersion: SCHEMA_VERSION
			};
			try {
				const evalExecution = await evaluateSingleCanonicalJob({
					canonicalJobId: item.canonical_job_id,
					jobVersionId,
					normalizedTitle: item.normalized_title,
					companyName: item.company_name,
					canonicalUrl: item.canonical_url,
					descriptionText: item.description_text || "No description provided.",
					gateDecisionId,
					gateDecision: item.gate_decision || "PASS",
					candidateLane: item.lane,
					priorityScore: item.priority_score,
					workabilityFacts: evalReq.workabilityFacts,
					candidateProfileContext
				}, pipelineRunId, attemptNum);
				const validatedResult = EvaluationResultSchema.parse(evalExecution.evaluatedJob);
				console.log(`  -> AI Evaluation complete: Provider = ${validatedResult.provider} (${validatedResult.model}), Confidence = ${validatedResult.lane_confidence}, Action = ${validatedResult.next_action}, Fallback = ${validatedResult.is_fallback}`);
				await client.query("BEGIN");
				try {
					if (((await client.query(`UPDATE canonical_jobs
             SET processing_state = 'AI_EVALUATED',
                 processing_status = 'AI_EVALUATED',
                 updated_at = NOW()
             WHERE workspace_id = $1
               AND id = $2
               AND latest_job_version_id = $3`, [
						ctx.workspaceId,
						item.canonical_job_id,
						jobVersionId
					])).rowCount ?? 0) === 0) console.warn(`Canonical job ${item.canonical_job_id} is no longer current for version ${jobVersionId}; preserving evaluation lineage without changing current state.`);
					await client.query(`INSERT INTO ai_evaluations (
              workspace_id,
              canonical_job_id, job_version_id, gate_decision, gate_version,
              lane_matches, workability_facts, unknown_fields, profile_version, evaluation_schema_version,
              profile_version_id, match_run_id, deterministic_decision_id, job_content_hash, context_fingerprint,
              provider, model, attempt, is_fallback, degraded_state, full_evaluation_payload, evaluated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())`, [
						ctx.workspaceId,
						item.canonical_job_id,
						jobVersionId,
						item.gate_decision || "PASS",
						GATE_VERSION,
						JSON.stringify([{
							lane: item.lane,
							semanticScore: item.priority_score,
							evidence: validatedResult.lane_evidence
						}]),
						JSON.stringify(item.workability_facts || {}),
						JSON.stringify([]),
						PROFILE_SCHEMA_VERSION,
						SCHEMA_VERSION,
						item.profile_version_id,
						item.match_run_id,
						item.deterministic_decision_id,
						item.job_content_hash,
						item.context_fingerprint,
						validatedResult.provider,
						validatedResult.model,
						validatedResult.attempt,
						validatedResult.is_fallback,
						validatedResult.degraded_state,
						JSON.stringify(validatedResult)
					]);
					await client.query(`INSERT INTO evaluation_attempts (
               workspace_id, canonical_job_id, job_version_id, attempt_number, provider, model, status, error_message, latency_ms
             ) VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', NULL, NULL)`, [
						ctx.workspaceId,
						item.canonical_job_id,
						jobVersionId,
						attemptNum,
						validatedResult.provider,
						validatedResult.model
					]);
					if (((await client.query(`UPDATE evaluation_queue
             SET status = 'COMPLETED', lease_id = NULL, lease_expires_at = NULL, available_at = NULL, updated_at = NOW()
             WHERE workspace_id = $1 AND id = $2 AND lease_id = $3
             RETURNING id`, [
						ctx.workspaceId,
						item.id,
						activeLeaseId
					])).rowCount ?? 0) === 0) throw new Error("Evaluation lease fence lost before completion.");
					await client.query("COMMIT");
					processedCount++;
					clearInterval(heartbeat);
				} catch (txErr) {
					await client.query("ROLLBACK");
					throw txErr;
				}
			} catch (err) {
				clearInterval(heartbeat);
				console.error(`❌ Evaluation failed for queue item ${item.id}:`, err.message || err);
				failedCount++;
				await client.query(`INSERT INTO evaluation_attempts (
             workspace_id, canonical_job_id, job_version_id, attempt_number, provider, model, status, error_message, latency_ms
           )
           SELECT $1, $2, $3, $4, $5, $6, 'FAILED', $7, NULL
           WHERE EXISTS (
             SELECT 1
             FROM evaluation_queue
             WHERE workspace_id = $1 AND id = $8 AND lease_id = $9
           )`, [
					ctx.workspaceId,
					item.canonical_job_id,
					jobVersionId,
					attemptNum,
					item.attempt_count > 0 ? "fallback-chain" : "primary-chain",
					"unknown",
					err.message || String(err),
					item.id,
					activeLeaseId
				]);
				const availableAtExpr = nextAvailableAt(attemptNum);
				if (((await client.query(`UPDATE evaluation_queue
           SET status = 'RETRY_WAIT',
               last_error = $1,
               available_at = ${availableAtExpr},
               lease_id = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE workspace_id = $2 AND id = $3 AND lease_id = $4
           RETURNING id`, [
					err.message || String(err),
					ctx.workspaceId,
					item.id,
					activeLeaseId
				])).rowCount ?? 0) === 0) console.warn(`Lease fence lost while scheduling retry for evaluation queue item ${item.id}.`);
			}
		}
	} finally {
		client.release();
		await pool.end();
	}
	const summary = `\n✅ Queue evaluation complete. Processed: ${processedCount}, Retrying: ${failedCount}, Manual Review: ${manualReviewCount}`;
	console.log(summary);
	return {
		processed: processedCount,
		failed: failedCount,
		manualReview: manualReviewCount,
		eligible: eligibleCount
	};
}
if (process.argv[1] && process.argv[1].includes("evaluate_queue")) evaluateQueue().then((stats) => {
	const strictExitOnRetryWait = process.env.EVALUATION_EXIT_ON_RETRY_WAIT !== "false";
	if (stats.failed > 0 && strictExitOnRetryWait) {
		console.error(`❌ ${stats.failed} evaluation(s) failed and were moved to RETRY_WAIT. Exiting non-zero.`);
		process.exit(1);
	}
	if (stats.failed > 0 && !strictExitOnRetryWait) console.warn(`⚠️ ${stats.failed} evaluation(s) moved to RETRY_WAIT; exiting zero for retry-drain worker mode.`);
	process.exit(0);
}).catch((err) => {
	console.error("Fatal queue evaluation error:", err);
	process.exit(1);
});
//#endregion
exports.EvaluationResultSchema = EvaluationResultSchema;
exports.SCHEMA_VERSION = SCHEMA_VERSION;
exports.__toESM = __toESM;
exports.evaluateQueue = evaluateQueue;
exports.pgPoolConfig = pgPoolConfig;
exports.resolveWorkspaceContext = resolveWorkspaceContext;
