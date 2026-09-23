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
let crypto = require("crypto");
crypto = __toESM(crypto, 1);
let express = require("express");
express = __toESM(express, 1);
let http = require("http");
http = __toESM(http, 1);
let net = require("net");
net = __toESM(net, 1);
let pg = require("pg");
pg = __toESM(pg, 1);
let node_fs = require("node:fs");
node_fs = __toESM(node_fs, 1);
let node_path = require("node:path");
node_path = __toESM(node_path, 1);
let js_yaml = require("js-yaml");
js_yaml = __toESM(js_yaml, 1);
let path = require("path");
path = __toESM(path, 1);
let zod = require("zod");
let dotenv = require("dotenv");
dotenv = __toESM(dotenv, 1);
let fs = require("fs");
fs = __toESM(fs, 1);
let url = require("url");
let node_child_process = require("node:child_process");
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
/**
* Session-scoped advisory locks are not safe through a transaction pooler.
* Neon pooled endpoints conventionally contain "pooler" in their hostname.
*/
function isPooledPostgresConnectionString(connectionString) {
	const trimmed = String(connectionString || "").trim();
	if (!trimmed) return false;
	try {
		const parsed = new URL(trimmed);
		return isPostgresUrl(parsed) && /(?:^|[-.])pooler(?:[.-]|$)/i.test(parsed.hostname);
	} catch {
		return false;
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
//#endregion
//#region src/workspace/context.ts
var DEFAULT_WORKSPACE_KEY = "default";
var DEFAULT_USER_KEY = "local_user";
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
//#region src/tasks/pipelineTasks.ts
async function enqueuePipelineTask(input, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const availableAt = input.availableAt ? input.availableAt.toISOString() : null;
		const contextFingerprint = input.contextFingerprint ?? "legacy_pipeline_context_v1";
		const maxAttempts = input.maxAttempts ?? 8;
		const inserted = await client.query(`
        INSERT INTO pipeline_tasks (
          workspace_id,
          task_type,
          task_key,
          payload,
          context_fingerprint,
          status,
          available_at,
          max_attempts,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 'PENDING', COALESCE($6::timestamptz, NOW()), $7, NOW(), NOW())
        ON CONFLICT (workspace_id, task_key, context_fingerprint)
        DO NOTHING
        RETURNING id
      `, [
			ctx.workspaceId,
			input.taskType,
			input.taskKey,
			input.payload,
			contextFingerprint,
			availableAt,
			maxAttempts
		]);
		if (inserted.rows.length > 0) return {
			taskId: inserted.rows[0].id,
			inserted: true,
			reactivated: false
		};
		const existing = await client.query(`
        SELECT id, status
        FROM pipeline_tasks
        WHERE workspace_id = $1
          AND task_key = $2
          AND context_fingerprint = $3
        LIMIT 1
      `, [
			ctx.workspaceId,
			input.taskKey,
			contextFingerprint
		]);
		if (existing.rows.length === 0) throw new Error(`Failed to enqueue task (no insert and no existing row): ${input.taskKey}`);
		if (existing.rows[0].status === "BLOCKED_DEPENDENCY") {
			const reactivated = await client.query(`
          UPDATE pipeline_tasks
          SET status = 'PENDING',
              available_at = NOW(),
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = NULL,
              blocked_on = NULL,
              blocked_reason = NULL,
              repair_action = NULL,
              completed_at = NULL,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'BLOCKED_DEPENDENCY'
          RETURNING id
        `, [ctx.workspaceId, existing.rows[0].id]);
			return {
				taskId: existing.rows[0].id,
				inserted: false,
				reactivated: reactivated.rows.length > 0
			};
		}
		return {
			taskId: existing.rows[0].id,
			inserted: false,
			reactivated: false
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/config/structuredLoader.ts
function isPlainObject(value) {
	return !!value && typeof value === "object" && value.constructor === Object;
}
function sortRecursively(value) {
	if (Array.isArray(value)) return value.map(sortRecursively);
	if (isPlainObject(value)) {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = sortRecursively(value[key]);
		return out;
	}
	return value;
}
function stableStringify(value) {
	return JSON.stringify(sortRecursively(value));
}
function sha256Hex$1(input) {
	return crypto.default.createHash("sha256").update(input).digest("hex");
}
//#endregion
//#region src/pipeline/workabilityPolicy.ts
var defaults = {
	unknownWorkModeDisposition: "HARD_REJECT",
	onsiteOnlyAllowed: false,
	maxOfficeDaysPerWeek: 3,
	hardFailOfficeDaysPerWeek: 4,
	hybridWithoutOfficeDaysAllowed: true,
	authorizedRegions: ["SINGAPORE"],
	remoteWithoutTerritoryAllowed: true,
	rejectExplicitForeignTerritory: true,
	unknownWorkAuthorizationNeedsVerification: false,
	maxTravelPct: 20,
	contractAllowed: false,
	minimumBuildingResearchPct: 60,
	maximumInteractionPct: 40,
	preferredBuildingResearchPct: 85,
	preferredInteractionPct: 15,
	regularOnCallAllowed: false,
	shiftWorkAllowed: false,
	frequentTravelAllowed: false,
	externalClientPrimaryAllowed: false,
	peopleManagementPrimaryAllowed: false,
	blacklistedCompanies: []
};
var TERRITORY_ALIASES = [
	["SINGAPORE", ["singapore", "sg"]],
	["UNITED_STATES", [
		"united states",
		"usa",
		"u.s.",
		"us",
		"new york",
		"boston",
		"chicago",
		"austin",
		"seattle",
		"san francisco",
		"los angeles"
	]],
	["CANADA", [
		"canada",
		"toronto",
		"vancouver",
		"montreal"
	]],
	["EUROPEAN_UNION", [
		"european union",
		"eu",
		"europe"
	]],
	["UNITED_KINGDOM", [
		"united kingdom",
		"uk",
		"great britain",
		"england",
		"london",
		"manchester",
		"edinburgh"
	]],
	["AUSTRALIA", [
		"australia",
		"australian",
		"sydney",
		"melbourne",
		"brisbane",
		"perth"
	]],
	["NEW_ZEALAND", [
		"new zealand",
		"auckland",
		"wellington"
	]],
	["ROMANIA", [
		"romania",
		"romanian",
		"bucharest"
	]],
	["GERMANY", [
		"germany",
		"german",
		"berlin",
		"munich",
		"frankfurt"
	]],
	["FRANCE", [
		"france",
		"french",
		"paris"
	]],
	["SPAIN", [
		"spain",
		"spanish",
		"madrid",
		"barcelona"
	]],
	["ITALY", [
		"italy",
		"italian",
		"rome",
		"milan"
	]],
	["NETHERLANDS", [
		"netherlands",
		"dutch",
		"amsterdam"
	]],
	["BELGIUM", [
		"belgium",
		"belgian",
		"brussels"
	]],
	["SWITZERLAND", [
		"switzerland",
		"swiss",
		"zurich",
		"geneva"
	]],
	["AUSTRIA", [
		"austria",
		"austrian",
		"vienna"
	]],
	["IRELAND", [
		"ireland",
		"irish",
		"dublin"
	]],
	["PORTUGAL", [
		"portugal",
		"portuguese",
		"lisbon"
	]],
	["POLAND", [
		"poland",
		"polish",
		"warsaw",
		"krakow"
	]],
	["CZECHIA", [
		"czechia",
		"czech republic",
		"prague"
	]],
	["GREECE", [
		"greece",
		"greek",
		"athens"
	]],
	["DENMARK", [
		"denmark",
		"danish",
		"copenhagen"
	]],
	["SWEDEN", [
		"sweden",
		"swedish",
		"stockholm"
	]],
	["NORWAY", [
		"norway",
		"norwegian",
		"oslo"
	]],
	["FINLAND", [
		"finland",
		"finnish",
		"helsinki"
	]],
	["INDIA", [
		"india",
		"indian",
		"bangalore",
		"bengaluru",
		"mumbai",
		"delhi",
		"hyderabad",
		"chennai"
	]],
	["MALAYSIA", [
		"malaysia",
		"malaysian",
		"kuala lumpur"
	]],
	["PHILIPPINES", [
		"philippines",
		"filipino",
		"manila"
	]],
	["INDONESIA", [
		"indonesia",
		"indonesian",
		"jakarta"
	]],
	["THAILAND", [
		"thailand",
		"thai",
		"bangkok"
	]],
	["VIETNAM", [
		"vietnam",
		"vietnamese",
		"hanoi",
		"ho chi minh"
	]],
	["JAPAN", [
		"japan",
		"japanese",
		"tokyo"
	]],
	["CHINA", [
		"china",
		"chinese",
		"beijing",
		"shanghai",
		"shenzhen"
	]],
	["HONG_KONG", ["hong kong"]],
	["TAIWAN", [
		"taiwan",
		"taiwanese",
		"taipei"
	]],
	["SOUTH_KOREA", [
		"south korea",
		"korean",
		"seoul"
	]],
	["ISRAEL", [
		"israel",
		"israeli",
		"tel aviv"
	]],
	["UNITED_ARAB_EMIRATES", [
		"united arab emirates",
		"uae",
		"dubai",
		"abu dhabi"
	]],
	["SOUTH_AFRICA", [
		"south africa",
		"south african",
		"johannesburg",
		"cape town"
	]],
	["BRAZIL", [
		"brazil",
		"brazilian",
		"sao paulo",
		"rio de janeiro"
	]],
	["MEXICO", [
		"mexico",
		"mexican",
		"mexico city"
	]],
	["ARGENTINA", [
		"argentina",
		"argentinian",
		"buenos aires"
	]],
	["CHILE", [
		"chile",
		"chilean",
		"santiago"
	]],
	["COLOMBIA", [
		"colombia",
		"colombian",
		"bogota"
	]]
];
function normalizeTerritory(value) {
	const normalized = String(value ?? "").trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
	if (!normalized) return null;
	return TERRITORY_ALIASES.find(([, aliases]) => aliases.includes(normalized))?.[0] ?? normalized.toUpperCase().replace(/\s+/g, "_");
}
function normalizeTerritories(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(normalizeTerritory).filter((item) => Boolean(item)))];
}
new Set(TERRITORY_ALIASES.map(([territory]) => territory));
function finiteNumber(value, fallback) {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
function finitePolicyNumber(value, fallback, min, max) {
	const parsed = finiteNumber(value, fallback);
	return Math.min(max, Math.max(min, parsed));
}
function booleanValue(value, fallback) {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if ([
			"true",
			"yes",
			"1",
			"allow",
			"allowed"
		].includes(normalized)) return true;
		if ([
			"false",
			"no",
			"0",
			"deny",
			"blocked"
		].includes(normalized)) return false;
	}
	return fallback;
}
function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function firstDefined(...values) {
	return values.find((value) => value !== void 0 && value !== null);
}
function stringArray(value) {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item).trim()).filter(Boolean);
}
function normalizeHardFailDays(maxOfficeDays, hardFailDays) {
	return Math.min(5, Math.max(maxOfficeDays + 1, hardFailDays));
}
function normalizeUnknownWorkModeDisposition(value) {
	const normalized = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
	if (normalized === "PASS" || normalized === "HARD_REJECT" || normalized === "NEEDS_VERIFICATION") return normalized;
	return defaults.unknownWorkModeDisposition;
}
function loadWorkabilityPolicy() {
	const filePath = node_path.default.resolve(process.cwd(), "config/policies/workability.yml");
	if (!node_fs.default.existsSync(filePath)) return defaults;
	const document = (js_yaml.load || js_yaml.default?.load || js_yaml)(node_fs.default.readFileSync(filePath, "utf8"));
	const workMode = document?.global_workability_gates?.work_mode ?? {};
	const territory = document?.global_workability_gates?.territory ?? {};
	const operations = document?.global_workability_gates?.operations ?? {};
	const composition = document?.global_workability_gates?.work_composition ?? {};
	const configuredHardFail = finiteNumber(workMode.max_office_days_hard_fail, defaults.hardFailOfficeDaysPerWeek);
	const configuredMaxOffice = finiteNumber(workMode.max_office_days_per_week, defaults.maxOfficeDaysPerWeek);
	return {
		unknownWorkModeDisposition: normalizeUnknownWorkModeDisposition(firstDefined(workMode.unknown_work_mode_policy, workMode.unknownWorkModePolicy)),
		onsiteOnlyAllowed: workMode.onsite_only_allowed === true,
		maxOfficeDaysPerWeek: configuredMaxOffice,
		hardFailOfficeDaysPerWeek: normalizeHardFailDays(configuredMaxOffice, configuredHardFail),
		hybridWithoutOfficeDaysAllowed: booleanValue(firstDefined(workMode.hybrid_without_office_days_allowed), defaults.hybridWithoutOfficeDaysAllowed),
		authorizedRegions: normalizeTerritories(firstDefined(territory.authorized_regions, document?.authorized_regions) ?? defaults.authorizedRegions),
		remoteWithoutTerritoryAllowed: booleanValue(firstDefined(territory.remote_without_territory_allowed), defaults.remoteWithoutTerritoryAllowed),
		rejectExplicitForeignTerritory: booleanValue(firstDefined(territory.reject_explicit_foreign_territory), defaults.rejectExplicitForeignTerritory),
		unknownWorkAuthorizationNeedsVerification: booleanValue(firstDefined(territory.unknown_work_authorization_needs_verification), defaults.unknownWorkAuthorizationNeedsVerification),
		maxTravelPct: finiteNumber(document?.global_workability_gates?.travel?.max_travel_pct, defaults.maxTravelPct),
		contractAllowed: document?.global_workability_gates?.employment?.contract_allowed === true,
		minimumBuildingResearchPct: finiteNumber(composition.minimum_building_research_pct, defaults.minimumBuildingResearchPct),
		maximumInteractionPct: finiteNumber(composition.maximum_interaction_pct, defaults.maximumInteractionPct),
		preferredBuildingResearchPct: finiteNumber(composition.preferred_building_research_pct, defaults.preferredBuildingResearchPct ?? 85),
		preferredInteractionPct: finiteNumber(composition.preferred_interaction_pct, defaults.preferredInteractionPct ?? 15),
		regularOnCallAllowed: operations.regular_on_call_allowed === true,
		shiftWorkAllowed: operations.shift_work_allowed === true,
		frequentTravelAllowed: operations.frequent_travel_allowed === true,
		externalClientPrimaryAllowed: composition.external_client_primary_allowed === true,
		peopleManagementPrimaryAllowed: composition.people_management_primary_allowed === true,
		blacklistedCompanies: Array.isArray(document?.blacklisted_companies) ? document.blacklisted_companies.map((value) => String(value).trim().toLowerCase()).filter(Boolean) : defaults.blacklistedCompanies
	};
}
function mergeWorkabilityPreferenceContent(basePolicy, content) {
	const root = objectValue(content);
	const workability = objectValue(firstDefined(root.workability, root.hard_constraints));
	const territory = objectValue(firstDefined(workability.territory, root.territory));
	const operations = objectValue(firstDefined(workability.operations, root.operations));
	const composition = objectValue(firstDefined(workability.work_composition, root.work_composition));
	const allowedWorkModes = stringArray(firstDefined(workability.work_modes, workability.allowed_work_modes, root.work_modes)).map((mode) => mode.toUpperCase().replace(/[-\s]+/g, "_"));
	const maxOfficeDays = finitePolicyNumber(firstDefined(workability.max_office_days_per_week, workability.maxOfficeDaysPerWeek, root.max_office_days_per_week), basePolicy.maxOfficeDaysPerWeek, 0, 5);
	const hardFailDays = finitePolicyNumber(firstDefined(workability.max_office_days_hard_fail, workability.hard_fail_office_days_per_week, root.max_office_days_hard_fail), basePolicy.hardFailOfficeDaysPerWeek, 1, 5);
	const employmentTypes = stringArray(firstDefined(workability.employment_types, workability.allowed_employment_types, root.employment_types)).map((type) => type.toUpperCase().replace(/[-\s]+/g, "_"));
	return {
		...basePolicy,
		unknownWorkModeDisposition: normalizeUnknownWorkModeDisposition(firstDefined(workability.unknown_work_mode_policy, workability.unknownWorkModePolicy, root.unknown_work_mode_policy, root.unknownWorkModePolicy) ?? basePolicy.unknownWorkModeDisposition),
		onsiteOnlyAllowed: allowedWorkModes.length > 0 ? allowedWorkModes.some((mode) => mode === "ONSITE" || mode === "ON_SITE") : booleanValue(firstDefined(workability.onsite_only_allowed, workability.onsiteOnlyAllowed, root.onsite_only_allowed), basePolicy.onsiteOnlyAllowed),
		maxOfficeDaysPerWeek: maxOfficeDays,
		hardFailOfficeDaysPerWeek: normalizeHardFailDays(maxOfficeDays, hardFailDays),
		hybridWithoutOfficeDaysAllowed: booleanValue(firstDefined(workability.hybrid_without_office_days_allowed, workability.hybridWithoutOfficeDaysAllowed, root.hybrid_without_office_days_allowed), basePolicy.hybridWithoutOfficeDaysAllowed),
		authorizedRegions: normalizeTerritories(firstDefined(workability.authorized_regions, workability.authorizedRegions, territory.authorized_regions, root.authorized_regions) ?? basePolicy.authorizedRegions),
		remoteWithoutTerritoryAllowed: booleanValue(firstDefined(workability.remote_without_territory_allowed, workability.remoteWithoutTerritoryAllowed, territory.remote_without_territory_allowed, root.remote_without_territory_allowed), basePolicy.remoteWithoutTerritoryAllowed),
		rejectExplicitForeignTerritory: booleanValue(firstDefined(workability.reject_explicit_foreign_territory, workability.rejectExplicitForeignTerritory, territory.reject_explicit_foreign_territory, root.reject_explicit_foreign_territory), basePolicy.rejectExplicitForeignTerritory),
		unknownWorkAuthorizationNeedsVerification: booleanValue(firstDefined(workability.unknown_work_authorization_needs_verification, workability.unknownWorkAuthorizationNeedsVerification, territory.unknown_work_authorization_needs_verification, root.unknown_work_authorization_needs_verification), basePolicy.unknownWorkAuthorizationNeedsVerification),
		maxTravelPct: finitePolicyNumber(firstDefined(workability.max_travel_pct, workability.maxTravelPct, root.max_travel_pct), basePolicy.maxTravelPct, 0, 100),
		contractAllowed: employmentTypes.length > 0 ? employmentTypes.some((type) => type === "CONTRACT" || type === "CONTRACTOR") : booleanValue(firstDefined(workability.contract_allowed, workability.contractAllowed, workability.contract_roles_allowed, root.contract_allowed), basePolicy.contractAllowed),
		minimumBuildingResearchPct: finitePolicyNumber(firstDefined(composition.minimum_building_research_pct, workability.minimum_building_research_pct, root.minimum_building_research_pct), basePolicy.minimumBuildingResearchPct, 0, 100),
		maximumInteractionPct: finitePolicyNumber(firstDefined(composition.maximum_interaction_pct, workability.maximum_interaction_pct, root.maximum_interaction_pct), basePolicy.maximumInteractionPct, 0, 100),
		regularOnCallAllowed: booleanValue(firstDefined(operations.regular_on_call_allowed, workability.regular_on_call_allowed, workability.on_call_allowed, root.on_call_allowed), basePolicy.regularOnCallAllowed),
		shiftWorkAllowed: booleanValue(firstDefined(operations.shift_work_allowed, workability.shift_work_allowed, root.shift_work_allowed), basePolicy.shiftWorkAllowed),
		frequentTravelAllowed: booleanValue(firstDefined(operations.frequent_travel_allowed, workability.frequent_travel_allowed, root.frequent_travel_allowed), basePolicy.frequentTravelAllowed),
		externalClientPrimaryAllowed: booleanValue(firstDefined(composition.external_client_primary_allowed, workability.external_client_primary_allowed, root.external_client_primary_allowed), basePolicy.externalClientPrimaryAllowed),
		peopleManagementPrimaryAllowed: booleanValue(firstDefined(composition.people_management_primary_allowed, workability.people_management_primary_allowed, root.people_management_primary_allowed), basePolicy.peopleManagementPrimaryAllowed),
		blacklistedCompanies: stringArray(firstDefined(root.blacklisted_companies, workability.blacklisted_companies)).map((value) => value.toLowerCase()).concat(basePolicy.blacklistedCompanies).filter((value, index, all) => value && all.indexOf(value) === index)
	};
}
//#endregion
//#region src/api/v2/auth.ts
function safeEqual(a, b) {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return crypto.default.timingSafeEqual(left, right);
}
function bearerFromAuthorizationHeader(value) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	const match = raw.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	return match[1].trim();
}
function apiAuthMiddleware() {
	return (req, res, next) => {
		const requiredToken = (process.env.JDEC_API_TOKEN || process.env.API_TOKEN || "").trim();
		if (!requiredToken) {
			if (process.env.NODE_ENV === "production") {
				res.status(500).json({
					ok: false,
					error: "Server misconfigured: set JDEC_API_TOKEN (or API_TOKEN) to enable /api/v2 authentication."
				});
				return;
			}
			return next();
		}
		const provided = bearerFromAuthorizationHeader(req.header("authorization"));
		if (!provided || !safeEqual(provided, requiredToken)) {
			res.setHeader("WWW-Authenticate", "Bearer realm=\"job-decision-engine\", charset=\"UTF-8\"");
			res.status(401).json({
				ok: false,
				error: "Unauthorized."
			});
			return;
		}
		return next();
	};
}
//#endregion
//#region src/api/v2/cursor.ts
function encodeCursor(cursor) {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
function decodeCursor(value) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		if (typeof parsed.t !== "string" || typeof parsed.id !== "string") return null;
		if (!parsed.t.trim() || !parsed.id.trim()) return null;
		return {
			t: parsed.t,
			id: parsed.id
		};
	} catch {
		return null;
	}
}
//#endregion
//#region src/db/migrate.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var __filename$1 = (0, url.fileURLToPath)(require("url").pathToFileURL(__filename).href);
var __dirname$1 = path.default.dirname(__filename$1);
var MIGRATIONS_LOCK_NAMESPACE = "job_decision_engine_migrations";
var MIGRATIONS_GLOBAL_LOCK_NAMESPACE = "job_decision_engine_migrations_global";
function isPool(value) {
	const maybe = value;
	return typeof maybe?.connect === "function" && typeof maybe?.query === "function" && "totalCount" in maybe && "idleCount" in maybe && "waitingCount" in maybe;
}
function resolveMigrationsDir() {
	const candidates = [
		process.env.JDEC_MIGRATIONS_DIR,
		path.default.resolve(process.cwd(), "migrations"),
		path.default.resolve(__dirname$1, "../../migrations"),
		path.default.resolve(__dirname$1, "../migrations"),
		path.default.resolve(__dirname$1, "migrations"),
		typeof process.resourcesPath === "string" ? path.default.join(process.resourcesPath, "migrations") : null,
		typeof process.resourcesPath === "string" ? path.default.join(process.resourcesPath, "app.asar", "migrations") : null
	].filter((p) => typeof p === "string" && p.length > 0);
	for (const candidate of candidates) if (fs.default.existsSync(candidate)) return candidate;
	throw new Error(`Migrations directory not found in candidates: ${candidates.join(", ")}`);
}
function getMigrationsList() {
	const migrationsDir = resolveMigrationsDir();
	return fs.default.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && !f.startsWith(".")).sort();
}
async function getMigrationStatus(clientOrPool) {
	const pool = clientOrPool;
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	try {
		const tableRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = current_schema()
        AND table_name = 'schema_migrations'
      ) as exists;
    `);
		const isInitialized = Boolean(tableRes.rows[0]?.exists);
		const allMigrations = getMigrationsList();
		if (!isInitialized) return {
			isInitialized: false,
			total: allMigrations.length,
			appliedCount: 0,
			pendingCount: allMigrations.length,
			applied: [],
			pending: allMigrations
		};
		const { rows } = await client.query(`SELECT version FROM schema_migrations ORDER BY version ASC`);
		const appliedSet = new Set(rows.map((r) => r.version));
		const applied = allMigrations.filter((m) => appliedSet.has(m));
		const pending = allMigrations.filter((m) => !appliedSet.has(m));
		return {
			isInitialized: true,
			total: allMigrations.length,
			appliedCount: applied.length,
			pendingCount: pending.length,
			applied,
			pending
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function runMigrations(clientOrPool) {
	const migrationsDir = resolveMigrationsDir();
	const pool = clientOrPool;
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	let schemaLockAcquired = false;
	try {
		await client.query(`SELECT pg_advisory_lock(hashtext($1), hashtext(current_schema()))`, [MIGRATIONS_LOCK_NAMESPACE]);
		schemaLockAcquired = true;
		await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
		const { rows } = await client.query(`SELECT version FROM schema_migrations ORDER BY version ASC`);
		const applied = new Set(rows.map((r) => r.version));
		const files = fs.default.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && !f.startsWith(".")).sort();
		const newlyApplied = [];
		for (const file of files) {
			if (applied.has(file)) continue;
			console.log(`Applying migration: ${file}...`);
			const filePath = path.default.join(migrationsDir, file);
			const sqlContent = fs.default.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
			const requiresGlobalExtensionLock = /\bCREATE\s+EXTENSION\b/i.test(sqlContent);
			let globalExtensionLockAcquired = false;
			try {
				if (requiresGlobalExtensionLock) {
					await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [MIGRATIONS_GLOBAL_LOCK_NAMESPACE]);
					globalExtensionLockAcquired = true;
				}
				await client.query("BEGIN");
				try {
					await client.query(sqlContent);
					await client.query(`INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())`, [file]);
					await client.query("COMMIT");
					console.log(`✅ Applied migration: ${file}`);
					newlyApplied.push(file);
				} catch (err) {
					await client.query("ROLLBACK");
					console.error(`❌ Migration failed on ${file}:`, err.message);
					throw err;
				}
			} finally {
				if (globalExtensionLockAcquired) await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [MIGRATIONS_GLOBAL_LOCK_NAMESPACE]).catch(() => void 0);
			}
		}
		return newlyApplied;
	} finally {
		if (schemaLockAcquired) await client.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext(current_schema()))`, [MIGRATIONS_LOCK_NAMESPACE]).catch(() => void 0);
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
if (process.argv[1] === (0, url.fileURLToPath)(require("url").pathToFileURL(__filename).href)) {
	const migrationDatabaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
	if (isPooledPostgresConnectionString(migrationDatabaseUrl)) throw new Error("Migration runner requires DATABASE_URL_UNPOOLED when DATABASE_URL points to a pooled endpoint.");
	runMigrations(new pg.default.Pool(pgPoolConfig(migrationDatabaseUrl))).then((applied) => {
		console.log(`Migration runner finished. Applied ${applied.length} migrations.`);
		process.exit(0);
	}).catch((err) => {
		console.error("Migration runner failed:", err);
		process.exit(1);
	});
}
//#endregion
//#region src/embeddings/spaceRegistry.ts
dotenv.default.config();
dotenv.default.config({
	path: ".env.local",
	override: true
});
var defaultPool$1 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
function stableSpaceKey(prefix, parts) {
	return `${prefix}_${crypto.default.createHash("sha256").update(parts.map((p) => p.trim()).join("|")).digest("hex").slice(0, 12)}`;
}
async function upsertSpace(client, params) {
	const normalizedProvider = params.provider.trim().toLowerCase();
	const normalizedModel = params.model.trim();
	const inserted = await client.query(`INSERT INTO embedding_spaces (
       workspace_id,
       space_key,
       provider,
       model,
       dimensions,
       normalization,
       distance_metric,
       is_fallback_space,
       active
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
     ON CONFLICT (workspace_id, space_key)
     DO NOTHING
     RETURNING id`, [
		params.workspaceId,
		params.spaceKey,
		normalizedProvider,
		normalizedModel,
		params.dimensions,
		params.normalization,
		params.distanceMetric,
		params.isFallback
	]);
	if (inserted.rows.length > 0) return inserted.rows[0].id;
	const existing = await client.query(`SELECT id, provider, model, dimensions, normalization, distance_metric, is_fallback_space, active
     FROM embedding_spaces
     WHERE workspace_id = $1
       AND space_key = $2
     LIMIT 1`, [params.workspaceId, params.spaceKey]);
	if (existing.rows.length === 0) throw new Error(`Embedding space insert unexpectedly conflicted but no row found for key ${params.spaceKey}.`);
	const row = existing.rows[0];
	const mismatches = [];
	if ((row.provider || "").trim().toLowerCase() !== normalizedProvider) mismatches.push(`provider=${row.provider} expected=${normalizedProvider}`);
	if ((row.model || "").trim() !== normalizedModel) mismatches.push(`model=${row.model} expected=${normalizedModel}`);
	if (Number(row.dimensions) !== Number(params.dimensions)) mismatches.push(`dimensions=${row.dimensions} expected=${params.dimensions}`);
	if ((row.normalization || "").trim() !== params.normalization) mismatches.push(`normalization=${row.normalization} expected=${params.normalization}`);
	if ((row.distance_metric || "").trim() !== params.distanceMetric) mismatches.push(`distance_metric=${row.distance_metric} expected=${params.distanceMetric}`);
	if (Boolean(row.is_fallback_space) !== Boolean(params.isFallback)) mismatches.push(`is_fallback_space=${row.is_fallback_space} expected=${params.isFallback}`);
	if (mismatches.length > 0) throw new Error(`Embedding space ${params.spaceKey} already exists with different configuration (${mismatches.join(" | ")}). Create a new space_key to change embedding model/provider/dimensions; do not mutate an existing space.`);
	if (!row.active) await client.query(`UPDATE embedding_spaces
       SET active = TRUE
       WHERE workspace_id = $1 AND id = $2`, [params.workspaceId, row.id]);
	return row.id;
}
async function seedEmbeddingSpaces(clientOrPool, options) {
	const pool = clientOrPool || defaultPool$1;
	const maybe = pool;
	const ownsClient = pool instanceof pg.default.Pool || typeof maybe?.connect === "function" && typeof maybe?.query === "function" && "totalCount" in maybe && "idleCount" in maybe && "waitingCount" in maybe || typeof maybe?.connect === "function" && typeof maybe?.query !== "function" && typeof maybe?.release !== "function";
	const client = ownsClient ? await pool.connect() : pool;
	const primaryProvider = process.env.EMBEDDING_PRIMARY_PROVIDER || "gemini";
	const fallbackProvider = process.env.EMBEDDING_FALLBACK_PROVIDER || "openai";
	const primaryModel = process.env.EMBEDDING_PRIMARY_MODEL || "gemini-embedding-001";
	const fallbackModel = process.env.EMBEDDING_FALLBACK_MODEL || "text-embedding-3-small";
	const primaryDimensions = Number(process.env.EMBEDDING_PRIMARY_DIMENSIONS || 768);
	const fallbackDimensions = Number(process.env.EMBEDDING_FALLBACK_DIMENSIONS || 1536);
	const normalization = "L2";
	const distanceMetric = "COSINE";
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		await client.query("BEGIN");
		const primarySpaceKey = stableSpaceKey("primary", [
			primaryProvider,
			primaryModel,
			String(primaryDimensions),
			normalization,
			distanceMetric
		]);
		const fallbackSpaceKey = stableSpaceKey("fallback", [
			fallbackProvider,
			fallbackModel,
			String(fallbackDimensions),
			normalization,
			distanceMetric
		]);
		const primarySpaceId = await upsertSpace(client, {
			workspaceId: ctx.workspaceId,
			spaceKey: primarySpaceKey,
			provider: primaryProvider,
			model: primaryModel,
			dimensions: primaryDimensions,
			normalization,
			distanceMetric,
			isFallback: false
		});
		const fallbackSpaceId = await upsertSpace(client, {
			workspaceId: ctx.workspaceId,
			spaceKey: fallbackSpaceKey,
			provider: fallbackProvider,
			model: fallbackModel,
			dimensions: fallbackDimensions,
			normalization,
			distanceMetric,
			isFallback: true
		});
		await client.query("COMMIT");
		return {
			primarySpaceId,
			fallbackSpaceId
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/modelRoutes/registry.ts
function asPurpose(value) {
	const normalized = (value || "").toUpperCase();
	if (normalized === "EVALUATION" || normalized === "EMBEDDING" || normalized === "DOCUMENT" || normalized === "EXTRACTION") return normalized;
	throw new Error(`Unsupported model route purpose: ${value}`);
}
function asProvider(value) {
	const normalized = (value || "").toLowerCase();
	if (normalized === "gemini" || normalized === "openai") return normalized;
	throw new Error(`Unsupported model provider: ${value}`);
}
function normalizeRouteContent(input) {
	return {
		primary_provider: asProvider(input.primary_provider),
		primary_model: String(input.primary_model || "").trim(),
		fallback_provider: asProvider(input.fallback_provider),
		fallback_model: String(input.fallback_model || "").trim()
	};
}
async function ensureModelRouteActiveRevision(input, clientOrPool, options) {
	const isPool = (value) => {
		const maybe = value;
		return value instanceof pg.default.Pool || typeof maybe?.connect === "function" && typeof maybe?.query === "function" && "totalCount" in maybe && "idleCount" in maybe && "waitingCount" in maybe || typeof maybe?.connect === "function" && typeof maybe?.query !== "function" && typeof maybe?.release !== "function";
	};
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	const routeKey = String(input.routeKey || "").trim();
	if (!routeKey) throw new Error("routeKey is required to ensure a model route revision.");
	const normalizedContent = normalizeRouteContent(input.content);
	if (!normalizedContent.primary_model || !normalizedContent.fallback_model) throw new Error(`Model route ${routeKey} requires both primary_model and fallback_model.`);
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const purpose = asPurpose(input.purpose);
		const contentHash = sha256Hex$1(stableStringify(normalizedContent));
		await client.query("BEGIN");
		try {
			const routeId = (await client.query(`
          INSERT INTO model_routes (
            workspace_id,
            route_key,
            purpose,
            status,
            description,
            created_by_user_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'ACTIVE', $4, $5, NOW(), NOW())
          ON CONFLICT (workspace_id, route_key)
          DO UPDATE SET
            purpose = EXCLUDED.purpose,
            status = 'ACTIVE',
            description = COALESCE(EXCLUDED.description, model_routes.description),
            updated_at = NOW()
          RETURNING id
        `, [
				ctx.workspaceId,
				routeKey,
				purpose,
				input.description ?? null,
				ctx.userId
			])).rows[0].id;
			const existingRev = await client.query(`
          SELECT id, revision_number
          FROM model_route_revisions
          WHERE model_route_id = $1
            AND content_hash = $2
          LIMIT 1
        `, [routeId, contentHash]);
			let revisionId;
			let revisionNumber;
			if (existingRev.rows.length > 0) {
				revisionId = existingRev.rows[0].id;
				revisionNumber = existingRev.rows[0].revision_number;
			} else {
				revisionNumber = (await client.query(`
            SELECT COALESCE(MAX(revision_number), 0)::int + 1 AS next
            FROM model_route_revisions
            WHERE model_route_id = $1
          `, [routeId])).rows[0].next;
				revisionId = (await client.query(`
            INSERT INTO model_route_revisions (
              model_route_id,
              revision_number,
              schema_version,
              content_hash,
              content,
              created_by_user_id,
              created_at
            )
            VALUES ($1, $2, '2.2.0', $3, $4, $5, NOW())
            RETURNING id
          `, [
					routeId,
					revisionNumber,
					contentHash,
					normalizedContent,
					ctx.userId
				])).rows[0].id;
			}
			const currentRevisionId = (await client.query(`
          SELECT model_route_revision_id
          FROM model_route_active_revisions
          WHERE model_route_id = $1
          LIMIT 1
        `, [routeId])).rows[0]?.model_route_revision_id ?? null;
			const needsActivation = !currentRevisionId || currentRevisionId !== revisionId;
			if (!currentRevisionId) await client.query(`
            INSERT INTO model_route_active_revisions (
              model_route_id,
              model_route_revision_id,
              activated_by_user_id,
              activated_at
            )
            VALUES ($1, $2, $3, NOW())
          `, [
				routeId,
				revisionId,
				ctx.userId
			]);
			else if (needsActivation) await client.query(`
            UPDATE model_route_active_revisions
            SET model_route_revision_id = $2,
                activated_by_user_id = $3,
                activated_at = NOW()
            WHERE model_route_id = $1
          `, [
				routeId,
				revisionId,
				ctx.userId
			]);
			if (needsActivation) await client.query(`
            INSERT INTO model_route_activation_events (
              model_route_id,
              from_revision_id,
              to_revision_id,
              activated_by_user_id,
              activated_at,
              note
            )
            VALUES ($1, $2, $3, $4, NOW(), $5)
          `, [
				routeId,
				currentRevisionId,
				revisionId,
				ctx.userId,
				input.note ?? null
			]);
			await client.query("COMMIT");
			const activatedAt = (/* @__PURE__ */ new Date()).toISOString();
			return {
				routeId,
				routeKey,
				purpose,
				revisionId,
				revisionNumber,
				contentHash,
				content: normalizedContent,
				activatedAt
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function getActiveModelRouteRevision(routeKey, clientOrPool, options) {
	const isPool = (value) => {
		const maybe = value;
		return value instanceof pg.default.Pool || typeof maybe?.connect === "function" && typeof maybe?.query === "function" && "totalCount" in maybe && "idleCount" in maybe && "waitingCount" in maybe || typeof maybe?.connect === "function" && typeof maybe?.query !== "function" && typeof maybe?.release !== "function";
	};
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const res = await client.query(`
        SELECT
          mr.id AS route_id,
          mr.route_key,
          mr.purpose,
          mrr.id AS revision_id,
          mrr.revision_number,
          mrr.content_hash,
          mrr.content,
          mar.activated_at
        FROM model_routes mr
        JOIN model_route_active_revisions mar
          ON mar.model_route_id = mr.id
        JOIN model_route_revisions mrr
          ON mrr.id = mar.model_route_revision_id
        WHERE mr.workspace_id = $1
          AND mr.route_key = $2
          AND mr.status = 'ACTIVE'
        LIMIT 1
      `, [ctx.workspaceId, routeKey]);
		if (res.rows.length === 0) return null;
		const row = res.rows[0];
		return {
			routeId: row.route_id,
			routeKey: row.route_key,
			purpose: asPurpose(row.purpose),
			revisionId: row.revision_id,
			revisionNumber: Number(row.revision_number),
			contentHash: row.content_hash,
			content: normalizeRouteContent(row.content),
			activatedAt: row.activated_at
		};
	} catch (error) {
		if (error?.code === "42P01") return null;
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/api/v2/setupRouter.ts
function asyncHandler$1(handler) {
	return (req, res, next) => {
		Promise.resolve(handler(req, res, next)).catch(next);
	};
}
function sanitizeErrorMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/(?:password|pwd)=([^\s;&]+)/gi, "password=[REDACTED]").replace(/key=([a-zA-Z0-9_\-]{8,})/gi, "key=[REDACTED]").replace(/Bearer\s+([a-zA-Z0-9_\-\.]{8,})/gi, "Bearer [REDACTED]");
}
function deriveDirectConnectionString(connectionString) {
	try {
		const parsed = new URL(connectionString.trim());
		if (parsed.hostname.includes("-pooler")) {
			parsed.hostname = parsed.hostname.replace("-pooler", "");
			return parsed.toString();
		}
	} catch {}
	return connectionString;
}
function createSetupRouter(deps = {}) {
	const router = express.default.Router();
	router.use(express.default.json({ limit: "1mb" }));
	function getActivePool() {
		if (deps.getPool) return deps.getPool();
		if (deps.pool) return deps.pool;
		const dbUrl = (process.env.DATABASE_URL || "").trim();
		if (!dbUrl) return null;
		return new pg.default.Pool(pgPoolConfig(dbUrl));
	}
	router.get("/status", asyncHandler$1(async (_req, res) => {
		const dbUrl = (process.env.DATABASE_URL || "").trim();
		const hasDb = Boolean(dbUrl);
		let dbConnected = false;
		let migrationStatus = null;
		let dbError = null;
		if (hasDb) try {
			const testPool = getActivePool();
			if (testPool) {
				const client = await testPool.connect();
				try {
					await client.query("SELECT 1");
					dbConnected = true;
					migrationStatus = await getMigrationStatus(client);
				} finally {
					client.release();
				}
			}
		} catch (err) {
			dbConnected = false;
			dbError = sanitizeErrorMessage(err);
		}
		const geminiConfigured = Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY);
		const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
		let modelRoutesConfigured = false;
		let activeRoutes = [];
		if (dbConnected && migrationStatus?.isInitialized) try {
			const pool = getActivePool();
			if (pool) {
				const ctx = await resolveWorkspaceContext(pool, {
					workspaceKey: DEFAULT_WORKSPACE_KEY,
					userKey: DEFAULT_USER_KEY
				});
				for (const { routeKey } of [
					{
						routeKey: "embedding_default",
						purpose: "EMBEDDING"
					},
					{
						routeKey: "routing_default",
						purpose: "EVALUATION"
					},
					{
						routeKey: "evaluation_default",
						purpose: "EVALUATION"
					},
					{
						routeKey: "document_default",
						purpose: "DOCUMENT"
					},
					{
						routeKey: "extraction_default",
						purpose: "EXTRACTION"
					}
				]) {
					const active = await getActiveModelRouteRevision(routeKey, pool, { context: ctx }).catch(() => null);
					if (active) activeRoutes.push({
						purpose: active.purpose,
						provider: active.content.primary_provider,
						model: active.content.primary_model
					});
				}
				const configuredPurposes = new Set(activeRoutes.map((route) => route.purpose));
				modelRoutesConfigured = configuredPurposes.has("EMBEDDING") && configuredPurposes.has("EVALUATION");
			}
		} catch {}
		const isComplete = dbConnected && Boolean(migrationStatus?.isInitialized) && (migrationStatus?.pendingCount ?? 1) === 0 && (geminiConfigured || openaiConfigured) && modelRoutesConfigured;
		res.json({
			ok: true,
			database: {
				configured: hasDb,
				connected: dbConnected,
				isInitialized: migrationStatus?.isInitialized ?? false,
				appliedCount: migrationStatus?.appliedCount ?? 0,
				pendingCount: migrationStatus?.pendingCount ?? 0,
				appliedMigrations: migrationStatus?.appliedCount ?? 0,
				pendingMigrations: migrationStatus?.pendingCount ?? 0,
				totalCount: migrationStatus?.total ?? 0,
				error: dbError
			},
			aiProviders: {
				gemini: geminiConfigured,
				openai: openaiConfigured
			},
			ai: {
				geminiConfigured,
				openaiConfigured
			},
			modelRoutes: {
				configured: modelRoutesConfigured,
				routes: activeRoutes,
				embedding: activeRoutes.find((r) => r.purpose === "EMBEDDING")?.model ?? null,
				evaluation: activeRoutes.find((r) => r.purpose === "EVALUATION")?.model ?? null,
				document: activeRoutes.find((r) => r.purpose === "DOCUMENT")?.model ?? null,
				extraction: activeRoutes.find((r) => r.purpose === "EXTRACTION")?.model ?? null
			},
			isComplete
		});
	}));
	router.post("/database/test", asyncHandler$1(async (req, res) => {
		const rawUrl = String(req.body?.databaseUrl || "").trim();
		const rawDirectUrl = String(req.body?.databaseUrlDirect || "").trim();
		if (!rawUrl) {
			res.status(400).json({
				ok: false,
				error: "Database connection URL is required."
			});
			return;
		}
		const isPooled = isPooledPostgresConnectionString(rawUrl);
		const directUrl = rawDirectUrl || (isPooled ? deriveDirectConnectionString(rawUrl) : rawUrl);
		let client = null;
		try {
			const config = pgConnectionConfig(directUrl);
			client = new pg.default.Client({
				...config,
				connectionTimeoutMillis: 1e4
			});
			await client.connect();
			const testRes = await client.query(`
          SELECT 
            version() as pg_version,
            current_database() as db_name,
            current_user as db_user
        `);
			const status = await getMigrationStatus(client);
			res.json({
				ok: true,
				isPooled,
				directUrlDerived: isPooled && !rawDirectUrl ? directUrl : void 0,
				databaseName: testRes.rows[0]?.db_name,
				databaseUser: testRes.rows[0]?.db_user,
				postgresVersion: (testRes.rows[0]?.pg_version || "").split(" ")[0] || "PostgreSQL",
				schemaStatus: {
					isInitialized: status.isInitialized,
					appliedCount: status.appliedCount,
					totalCount: status.total,
					pendingCount: status.pendingCount
				}
			});
		} catch (err) {
			res.status(400).json({
				ok: false,
				error: `Database connection test failed: ${sanitizeErrorMessage(err)}`,
				hint: isPooled && !rawDirectUrl ? "When using a pooled connection string, please also provide the direct unpooled connection string (without -pooler in the hostname)." : void 0
			});
		} finally {
			if (client) await client.end().catch(() => void 0);
		}
	}));
	router.post("/database/initialize", asyncHandler$1(async (req, res) => {
		const rawUrl = String(req.body?.databaseUrl || process.env.DATABASE_URL || "").trim();
		const rawDirectUrl = String(req.body?.databaseUrlDirect || process.env.DATABASE_URL_UNPOOLED || "").trim();
		const isPooled = isPooledPostgresConnectionString(rawUrl);
		const directUrl = rawDirectUrl || (isPooled ? deriveDirectConnectionString(rawUrl) : rawUrl);
		if (!directUrl) {
			res.status(400).json({
				ok: false,
				error: "No direct database connection URL available."
			});
			return;
		}
		let client = null;
		try {
			const config = pgConnectionConfig(directUrl);
			client = new pg.default.Client({
				...config,
				connectionTimeoutMillis: 15e3
			});
			await client.connect();
			const applied = await runMigrations(client);
			await seedEmbeddingSpaces(client);
			const ctx = await resolveWorkspaceContext(client, {
				workspaceKey: DEFAULT_WORKSPACE_KEY,
				userKey: DEFAULT_USER_KEY
			});
			deps.onDatabaseInitialized?.({
				databaseUrl: rawUrl || directUrl,
				databaseUrlDirect: directUrl
			});
			res.json({
				ok: true,
				applied,
				appliedCount: applied.length,
				workspaceId: ctx.workspaceId,
				userId: ctx.userId
			});
		} catch (err) {
			res.status(500).json({
				ok: false,
				error: `Database initialization failed: ${sanitizeErrorMessage(err)}`
			});
		} finally {
			if (client) await client.end().catch(() => void 0);
		}
	}));
	router.post("/ai/test", asyncHandler$1(async (req, res) => {
		const provider = String(req.body?.provider || "").trim().toLowerCase();
		const apiKey = String(req.body?.apiKey || "").trim();
		if (!apiKey) {
			res.status(400).json({
				ok: false,
				error: "API key is required."
			});
			return;
		}
		if (provider === "gemini") try {
			const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(1e4) });
			if (!resp.ok) {
				const msg = (await resp.json().catch(() => ({})))?.error?.message || `HTTP ${resp.status}`;
				res.status(400).json({
					ok: false,
					error: `Google Gemini verification failed: ${msg}`
				});
				return;
			}
			const data = await resp.json();
			const models = Array.isArray(data.models) ? data.models.map((m) => m.name.replace(/^models\//, "")) : [];
			res.json({
				ok: true,
				provider: "gemini",
				models
			});
		} catch (err) {
			res.status(400).json({
				ok: false,
				error: `Failed to connect to Google Gemini API: ${sanitizeErrorMessage(err)}`
			});
		}
		else if (provider === "openai") try {
			const resp = await fetch("https://api.openai.com/v1/models", {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(1e4)
			});
			if (!resp.ok) {
				const msg = (await resp.json().catch(() => ({})))?.error?.message || `HTTP ${resp.status}`;
				res.status(400).json({
					ok: false,
					error: `OpenAI verification failed: ${msg}`
				});
				return;
			}
			const data = await resp.json();
			const models = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
			res.json({
				ok: true,
				provider: "openai",
				models
			});
		} catch (err) {
			res.status(400).json({
				ok: false,
				error: `Failed to connect to OpenAI API: ${sanitizeErrorMessage(err)}`
			});
		}
		else res.status(400).json({
			ok: false,
			error: `Unsupported AI provider: ${provider}`
		});
	}));
	router.post("/routes", asyncHandler$1(async (req, res) => {
		const pool = getActivePool();
		if (!pool) {
			res.status(400).json({
				ok: false,
				error: "Database is not connected."
			});
			return;
		}
		let routes = req.body?.routes;
		if (!routes || typeof routes !== "object") {
			const provider = String(req.body?.provider || "gemini").toLowerCase();
			const embeddingModel = req.body?.embeddingModel;
			const evaluationModel = req.body?.evaluationModel;
			const documentModel = req.body?.documentModel;
			const extractionModel = req.body?.extractionModel;
			if (embeddingModel || evaluationModel || documentModel || extractionModel) routes = {
				embedding: embeddingModel ? {
					provider,
					model: embeddingModel
				} : void 0,
				evaluation: evaluationModel ? {
					provider,
					model: evaluationModel
				} : void 0,
				document: documentModel ? {
					provider,
					model: documentModel
				} : void 0,
				extraction: extractionModel ? {
					provider,
					model: extractionModel
				} : void 0
			};
		}
		if (!routes || typeof routes !== "object") {
			res.status(400).json({
				ok: false,
				error: "Invalid routes configuration."
			});
			return;
		}
		const configured = [];
		const client = await pool.connect();
		try {
			const ctx = await resolveWorkspaceContext(client, {
				workspaceKey: DEFAULT_WORKSPACE_KEY,
				userKey: DEFAULT_USER_KEY
			});
			const routeDefs = [
				{
					key: "embedding_default",
					purpose: "EMBEDDING",
					conf: routes.embedding
				},
				{
					key: "routing_default",
					purpose: "EVALUATION",
					conf: routes.routing || routes.evaluation
				},
				{
					key: "evaluation_default",
					purpose: "EVALUATION",
					conf: routes.evaluation
				},
				{
					key: "single_job_evaluation",
					purpose: "EVALUATION",
					conf: routes.evaluation
				},
				{
					key: "batch_evaluation",
					purpose: "EVALUATION",
					conf: routes.evaluation
				},
				{
					key: "document_default",
					purpose: "DOCUMENT",
					conf: routes.document || routes.evaluation
				},
				{
					key: "extraction_default",
					purpose: "EXTRACTION",
					conf: routes.extraction || routes.evaluation
				},
				{
					key: "requirements_extraction",
					purpose: "EXTRACTION",
					conf: routes.extraction || routes.evaluation
				}
			];
			for (const def of routeDefs) {
				if (!def.conf || !def.conf.model) continue;
				const provider = (def.conf.provider || "gemini").toLowerCase();
				const fallbackProvider = def.conf.fallbackProvider || provider;
				const fallbackModel = def.conf.fallbackModel || def.conf.model;
				const revision = await ensureModelRouteActiveRevision({
					routeKey: def.key,
					purpose: def.purpose,
					content: {
						primary_provider: provider,
						primary_model: def.conf.model,
						fallback_provider: fallbackProvider,
						fallback_model: fallbackModel
					}
				}, client, { context: ctx });
				configured.push(revision);
			}
			res.json({
				ok: true,
				routes: configured
			});
		} catch (err) {
			res.status(500).json({
				ok: false,
				error: `Failed to configure routes: ${sanitizeErrorMessage(err)}`
			});
		} finally {
			client.release();
		}
	}));
	return router;
}
//#endregion
//#region src/config/registry.ts
async function upsertConfigRevision(input, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	const activate = options?.activate !== false;
	const manageTransaction = options?.manageTransaction !== false;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const contentHash = sha256Hex$1(stableStringify(input.content));
		if (manageTransaction) await client.query("BEGIN");
		const configDefinitionId = (await client.query(`INSERT INTO config_definitions (
         workspace_id,
         config_key,
         config_type,
         description,
         created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, config_key)
       DO UPDATE SET
         config_type = EXCLUDED.config_type,
         description = EXCLUDED.description,
         updated_at = NOW()
       RETURNING id`, [
			ctx.workspaceId,
			input.configKey,
			input.configType,
			input.description ?? null,
			ctx.userId
		])).rows[0].id;
		const existingRevision = await client.query(`SELECT id, revision_number
       FROM config_revisions
       WHERE config_definition_id = $1
         AND content_hash = $2
       LIMIT 1`, [configDefinitionId, contentHash]);
		let configRevisionId;
		let revisionNumber;
		if (existingRevision.rows.length > 0) {
			configRevisionId = existingRevision.rows[0].id;
			revisionNumber = existingRevision.rows[0].revision_number;
		} else {
			revisionNumber = (await client.query(`SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
         FROM config_revisions
         WHERE config_definition_id = $1`, [configDefinitionId])).rows[0].next;
			configRevisionId = (await client.query(`INSERT INTO config_revisions (
           config_definition_id,
           revision_number,
           schema_version,
           content_hash,
           content,
           created_by_user_id
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`, [
				configDefinitionId,
				revisionNumber,
				input.schemaVersion ?? "2.2.0",
				contentHash,
				input.content,
				ctx.userId
			])).rows[0].id;
		}
		let activated = false;
		if (activate) {
			const fromRevisionId = (await client.query(`SELECT config_revision_id
         FROM config_active_revisions
         WHERE config_definition_id = $1
         LIMIT 1`, [configDefinitionId])).rows[0]?.config_revision_id ?? null;
			await client.query(`INSERT INTO config_active_revisions (
           config_definition_id,
           config_revision_id,
           activated_by_user_id,
           activated_at
         )
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (config_definition_id)
         DO UPDATE SET
           config_revision_id = EXCLUDED.config_revision_id,
           activated_by_user_id = EXCLUDED.activated_by_user_id,
           activated_at = NOW()`, [
				configDefinitionId,
				configRevisionId,
				ctx.userId
			]);
			if (fromRevisionId !== configRevisionId) await client.query(`INSERT INTO config_activation_events (
             config_definition_id,
             from_revision_id,
             to_revision_id,
             activated_by_user_id,
             activated_at,
             note
           )
           VALUES ($1, $2, $3, $4, NOW(), $5)`, [
				configDefinitionId,
				fromRevisionId,
				configRevisionId,
				ctx.userId,
				options?.note ?? null
			]);
			activated = true;
		}
		if (manageTransaction) await client.query("COMMIT");
		return {
			configDefinitionId,
			configRevisionId,
			revisionNumber,
			contentHash,
			activated
		};
	} catch (error) {
		if (manageTransaction) await client.query("ROLLBACK");
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/pipeline/artifactContext.ts
var PIPELINE_CONTEXT_SCHEMA_VERSION = "pipeline_context_v1";
var CONTEXT_PAYLOAD_KEYS = [
	"canonical_job_id",
	"job_version_id",
	"content_hash",
	"active_requirement_set_id",
	"requirement_extraction_run_id",
	"match_run_id",
	"profile_version_id",
	"workability_policy_hash",
	"lane_policy_version",
	"embedding_space_id",
	"embedding_model",
	"matcher_version",
	"policy_snapshot_id",
	"policy_hash",
	"evidence_strength_policy_hash",
	"evaluation_schema_version",
	"prompt_hash",
	"model_route",
	"force_policy_recalculation",
	"reprocess",
	"repair_existing_state",
	"reassessment_reason",
	"verification_answer_revision_id"
];
function contextPayload(payload) {
	return Object.fromEntries(CONTEXT_PAYLOAD_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(payload, key)).map((key) => [key, payload[key]]));
}
function buildPipelineTaskContextFingerprint(input) {
	return sha256Hex$1(`${PIPELINE_CONTEXT_SCHEMA_VERSION}|${stableStringify({
		workspace_id: input.workspaceId,
		task_type: input.taskType,
		task_version: input.taskVersion,
		payload: contextPayload(input.payload)
	})}`);
}
//#endregion
//#region src/services/verificationQuestionService.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
async function getPendingVerificationQuestions(clientOrPool, options) {
	const pool = clientOrPool || defaultPool;
	const ctx = options?.context ?? await resolveWorkspaceContext(pool);
	const { rows } = await pool.query(`SELECT *
     FROM verification_questions
     WHERE workspace_id = $1
       AND status = 'PENDING'
     ORDER BY impact_job_count DESC, created_at ASC`, [ctx.workspaceId]);
	return rows;
}
async function answerVerificationQuestion(clientOrPool, questionKey, answer, options) {
	const pool = clientOrPool || defaultPool;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const normalizedKey = String(questionKey || "").trim();
		await client.query("BEGIN");
		try {
			const qRes = await client.query(`SELECT *
         FROM verification_questions
         WHERE workspace_id = $1 AND question_key = $2
         FOR UPDATE`, [ctx.workspaceId, normalizedKey]);
			if (qRes.rows.length === 0) throw new Error(`Verification question '${normalizedKey}' not found.`);
			const question = qRes.rows[0];
			const linkedIds = Array.isArray(question.linked_job_ids) ? question.linked_job_ids : [];
			await client.query(`UPDATE verification_questions
         SET status = 'ANSWERED',
             answer_value = $3::jsonb,
             answered_at = NOW(),
             updated_at = NOW()
         WHERE workspace_id = $1 AND question_key = $2`, [
				ctx.workspaceId,
				normalizedKey,
				JSON.stringify(answer)
			]);
			const activeAnswer = await client.query(`SELECT cr.content
         FROM config_definitions cd
         JOIN config_active_revisions car ON car.config_definition_id = cd.id
         JOIN config_revisions cr ON cr.id = car.config_revision_id
         WHERE cd.workspace_id = $1
           AND cd.config_key = 'verification_answers'
         LIMIT 1`, [ctx.workspaceId]);
			const answerRevision = await upsertConfigRevision({
				configKey: "verification_answers",
				configType: "verification_preferences",
				description: "User verification answers for hard gates",
				schemaVersion: "1.0.0",
				content: {
					...activeAnswer.rows[0]?.content && typeof activeAnswer.rows[0].content === "object" ? activeAnswer.rows[0].content : {},
					[normalizedKey]: answer
				}
			}, client, {
				context: ctx,
				activate: true,
				note: `Updated answer for ${normalizedKey}`,
				manageTransaction: false
			});
			let resumedCount = 0;
			if (linkedIds.length > 0) {
				resumedCount = (await client.query(`UPDATE canonical_jobs
           SET processing_state = 'RAW_STAGED',
               processing_status = 'RAW_STAGED',
               gate_decision = NULL,
               rejection_reason = NULL,
               gate_evidence_quotes = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1
             AND id = ANY($2::uuid[])
             AND COALESCE(processing_state, processing_status) = 'NEEDS_VERIFICATION'`, [ctx.workspaceId, linkedIds])).rowCount ?? 0;
				const { rows: resumedJobs } = await client.query(`SELECT c.id AS canonical_job_id,
                  COALESCE(c.latest_job_version_id, (
                    SELECT jv.id FROM job_versions jv
                    WHERE jv.workspace_id = c.workspace_id AND jv.canonical_job_id = c.id
                    ORDER BY jv.observed_at DESC LIMIT 1
                  )) AS job_version_id
           FROM canonical_jobs c
           WHERE c.workspace_id = $1
             AND c.id = ANY($2::uuid[])`, [ctx.workspaceId, linkedIds]);
				for (const rj of resumedJobs) if (rj.job_version_id) {
					const taskKey = `APPLY_HARD_GATES:${rj.job_version_id}:hard_gate_v2`;
					const taskPayload = {
						canonical_job_id: rj.canonical_job_id,
						job_version_id: rj.job_version_id,
						verification_answer_revision_id: answerRevision.configRevisionId
					};
					const contextFingerprint = buildPipelineTaskContextFingerprint({
						workspaceId: ctx.workspaceId,
						taskType: "APPLY_HARD_GATES",
						taskVersion: "hard_gate_v2",
						payload: taskPayload
					});
					await client.query(`INSERT INTO pipeline_tasks (
                 workspace_id,
                 task_type,
                 task_key,
                 payload,
                 context_fingerprint,
                 status,
                 available_at,
                 max_attempts,
                 created_at,
                 updated_at
               )
               VALUES ($1, 'APPLY_HARD_GATES', $2, $3::jsonb, $4, 'PENDING', NOW(), 8, NOW(), NOW())
               ON CONFLICT (workspace_id, task_key, context_fingerprint)
               DO UPDATE SET
                 status = 'PENDING',
                 available_at = NOW(),
                 lease_id = NULL,
                 lease_expires_at = NULL,
                 attempt_count = 0,
                 last_error = NULL,
                 dead_letter_reason = NULL,
                 completed_at = NULL,
                 updated_at = NOW()`, [
						ctx.workspaceId,
						taskKey,
						JSON.stringify(taskPayload),
						contextFingerprint
					]);
				}
			}
			await client.query("COMMIT");
			return {
				ok: true,
				resumedJobCount: resumedCount
			};
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function dismissVerificationQuestion(clientOrPool, questionKey, options) {
	const pool = clientOrPool || defaultPool;
	const ctx = options?.context ?? await resolveWorkspaceContext(pool);
	const normalizedKey = String(questionKey || "").trim();
	await pool.query(`UPDATE verification_questions
     SET status = 'DISMISSED',
         updated_at = NOW()
     WHERE workspace_id = $1 AND question_key = $2`, [ctx.workspaceId, normalizedKey]);
	return { ok: true };
}
//#endregion
//#region src/contracts/version.ts
var SCHEMA_VERSION = "2.2.0";
var schemaVersions = [SCHEMA_VERSION, ...["2.0", "1.0.0"]];
var SchemaVersionSchema = zod.z.enum(schemaVersions);
//#endregion
//#region src/readModels/contracts.ts
/**
* Read model contracts
* @description Zod schemas for Streamlit and report consumers of canonical data
* @version 2.2.0
*/
var READ_MODEL_SCHEMA_VERSION = SCHEMA_VERSION;
var ShortlistRowV2Schema = zod.z.object({
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	title: zod.z.string().min(1),
	company: zod.z.string().min(1),
	canonical_url: zod.z.string().min(1),
	source: zod.z.string().min(1),
	location: zod.z.string().min(1),
	workplace_type: zod.z.string().min(1),
	employment_type: zod.z.string().min(1),
	description: zod.z.string().nullable(),
	gate_status: zod.z.enum([
		"PASS",
		"NEEDS_VERIFICATION",
		"HARD_REJECT"
	]),
	rejection_codes: zod.z.array(zod.z.string()).nullable(),
	gate_evidence_quotes: zod.z.array(zod.z.string()).nullable(),
	primary_lane: zod.z.string().nullable(),
	secondary_lanes: zod.z.array(zod.z.string()).nullable().default([]),
	lane_confidence: zod.z.string().nullable().default("None"),
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
	recommendation_decided_at: zod.z.coerce.date().nullable(),
	nd_friendly_score: zod.z.number().nullable().default(null),
	politics_stress_score: zod.z.number().nullable().default(null),
	sensory_overload_index: zod.z.number().nullable().default(null),
	next_action: zod.z.string().nullable().default(null),
	strategic_value: zod.z.string().nullable().default(null),
	recommended_cv_version: zod.z.string().nullable().default(null),
	evaluation_summary: zod.z.string().nullable().default(null),
	eval_provider: zod.z.string().nullable().default(null),
	eval_is_fallback: zod.z.boolean().nullable().default(null),
	version_mismatch: zod.z.boolean(),
	observed_at: zod.z.coerce.date(),
	evaluated_at: zod.z.coerce.date().nullable(),
	queue_status: zod.z.string().nullable().default(null),
	latest_match_run_id: zod.z.string().uuid().nullable().default(null),
	cv_document_run_id: zod.z.string().uuid().nullable().default(null),
	cover_letter_document_run_id: zod.z.string().uuid().nullable().default(null),
	document_ready: zod.z.boolean().default(false),
	current_artifact_status: zod.z.string().default("CURRENTNESS_UNKNOWN"),
	current_artifact_reason: zod.z.string().nullable().default(null),
	blocked_task_count: zod.z.number().int().min(0).default(0)
}).passthrough();
var RejectedJobRowSchema = zod.z.object({
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid().nullable(),
	title: zod.z.string().min(1),
	company: zod.z.string().min(1),
	canonical_url: zod.z.string().min(1).nullable(),
	source: zod.z.string().min(1),
	processing_state: zod.z.string().min(1),
	rejection_reason: zod.z.string().nullable(),
	gate_status: zod.z.enum([
		"PASS",
		"NEEDS_VERIFICATION",
		"HARD_REJECT"
	]),
	rejection_codes: zod.z.array(zod.z.string()).nullable(),
	gate_evidence_quotes: zod.z.array(zod.z.string()).nullable(),
	description: zod.z.string().nullable(),
	nd_friendly_score: zod.z.coerce.number().nullable(),
	politics_stress_score: zod.z.coerce.number().nullable(),
	sensory_overload_index: zod.z.coerce.number().nullable(),
	observed_at: zod.z.coerce.date().nullable()
});
var StreamlitJobDetailSchema = zod.z.object({
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	title: zod.z.string(),
	company: zod.z.string(),
	strategic_value: zod.z.string().nullable(),
	evaluation_summary: zod.z.string().nullable(),
	workability_facts: zod.z.record(zod.z.unknown()).nullable(),
	lane_matches: zod.z.array(zod.z.unknown()).nullable(),
	gate_evidence_quotes: zod.z.array(zod.z.string()).nullable()
});
var PipelineHealthSchema = zod.z.object({
	generated_at: zod.z.coerce.date(),
	counts_by_status: zod.z.record(zod.z.string(), zod.z.number().int().min(0)),
	version_mismatch_count: zod.z.number().int().min(0),
	document_ready_count: zod.z.number().int().min(0)
});
var DocumentStatusSchema = zod.z.object({
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	latest_match_run_id: zod.z.string().uuid().nullable(),
	cv_document_run_id: zod.z.string().uuid().nullable(),
	cover_letter_document_run_id: zod.z.string().uuid().nullable(),
	document_ready: zod.z.boolean()
});
zod.z.object({
	schema_version: SchemaVersionSchema.default(READ_MODEL_SCHEMA_VERSION),
	shortlist_row: ShortlistRowV2Schema,
	job_detail: StreamlitJobDetailSchema,
	pipeline_health: PipelineHealthSchema,
	document_status: DocumentStatusSchema
});
//#endregion
//#region src/api/v2/router.ts
function asyncHandler(handler) {
	return (req, res, next) => {
		Promise.resolve(handler(req, res, next)).catch(next);
	};
}
function workspaceKeyFromRequest(req) {
	return String(req.header("x-workspace-key") || "").trim() || (process.env.WORKSPACE_KEY || "default").trim();
}
function userKeyFromRequest(req) {
	return String(req.header("x-user-key") || "").trim() || (process.env.WORKSPACE_USER_KEY || process.env.USER_KEY || "local_user").trim();
}
function sha256Hex(payload) {
	return crypto.default.createHash("sha256").update(payload).digest("hex");
}
function previewWorkabilityPolicy(content) {
	const policy = mergeWorkabilityPreferenceContent(loadWorkabilityPolicy(), content);
	return {
		policy,
		policy_hash: sha256Hex(stableStringify(policy))
	};
}
function parsePositiveInt(value, fallback, options) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	const candidate = Number.isFinite(parsed) ? parsed : fallback;
	const min = options?.min ?? 1;
	const max = options?.max ?? 1e3;
	return Math.max(min, Math.min(max, candidate));
}
function isUuid(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
var APPLICATION_STATUSES = [
	"INTENT",
	"READY_TO_APPLY",
	"SUBMITTED",
	"FOLLOW_UP",
	"INTERVIEW",
	"OFFER",
	"REJECTED",
	"WITHDRAWN",
	"CLOSED"
];
function parseApplicationStatus(value, fallback = "INTENT") {
	const normalized = String(value ?? fallback).trim().toUpperCase();
	return APPLICATION_STATUSES.includes(normalized) ? normalized : null;
}
function parseOptionalIsoDate(value) {
	if (value === void 0) return void 0;
	if (value === null) return null;
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const date = new Date(trimmed);
	return Number.isNaN(date.getTime()) ? void 0 : date.toISOString();
}
function jsonObjectOrEmpty(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
async function withTransaction(pool, fn) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		try {
			const result = await fn(client);
			await client.query("COMMIT");
			return result;
		} catch (err) {
			await client.query("ROLLBACK").catch(() => void 0);
			throw err;
		}
	} finally {
		client.release();
	}
}
function createApiV2Router(deps = {}) {
	const router = express.default.Router();
	router.use(express.default.json({ limit: "1mb" }));
	let databaseConfigured = Boolean(deps.pool || String(process.env.DATABASE_URL || "").trim());
	let pool = deps.pool ?? new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
	const resolveContext = deps.resolveContext ?? resolveWorkspaceContext;
	router.use(apiAuthMiddleware());
	router.use("/setup", createSetupRouter({
		pool: databaseConfigured ? pool : void 0,
		getPool: () => databaseConfigured ? pool : null,
		onDatabaseInitialized: ({ databaseUrl, databaseUrlDirect }) => {
			process.env.DATABASE_URL = databaseUrl;
			process.env.DATABASE_URL_UNPOOLED = databaseUrlDirect;
			if (!deps.pool) pool = new pg.default.Pool(pgPoolConfig(databaseUrl));
			databaseConfigured = true;
		}
	}));
	router.use(asyncHandler(async (req, res, next) => {
		if (!databaseConfigured) {
			res.status(503).json({
				ok: false,
				error: "DATABASE_NOT_CONFIGURED",
				message: "Database is not configured yet. Complete the desktop setup wizard to connect your database."
			});
			return;
		}
		try {
			req.workspaceContext = await resolveContext(pool, {
				workspaceKey: workspaceKeyFromRequest(req),
				userKey: userKeyFromRequest(req)
			});
			next();
		} catch (err) {
			res.status(503).json({
				ok: false,
				error: "DATABASE_NOT_INITIALIZED",
				message: "Database schema is not initialized yet. Complete the desktop setup wizard to install the schema."
			});
		}
	}));
	router.get("/health", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		res.json({
			ok: true,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			workspace_key: ctx.workspaceKey,
			user_key: ctx.userKey
		});
	}));
	router.get("/shortlist", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const limit = parsePositiveInt(req.query.limit, 250, {
			min: 1,
			max: 500
		});
		const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);
		const params = [ctx.workspaceId];
		let cursorClause = "";
		if (cursor) {
			params.push(cursor.t, cursor.id);
			cursorClause = "AND (s.observed_at, s.canonical_job_id) < ($2::timestamptz, $3::uuid)";
		}
		params.push(limit);
		const { rows } = await pool.query(`
          SELECT
            s.canonical_job_id,
            s.job_version_id,
            s.title,
            s.company,
            s.canonical_url,
            s.source,
            s.location,
            s.workplace_type,
            s.employment_type,
            s.description,
            s.gate_status,
            s.rejection_codes,
            s.gate_evidence_quotes,
            s.primary_lane,
            s.secondary_lanes,
            s.lane_confidence,
            s.priority_score,
            s.deterministic_match_score,
            s.deterministic_match_coverage,
            s.processing_state,
            s.processing_status,
            s.recommendation_eligibility,
            s.recommendation_outcome,
            s.recommendation_requirement_score,
            s.recommendation_coverage_score,
            s.recommendation_evidence_completeness,
            s.recommendation_decided_at,
            s.nd_friendly_score,
            s.politics_stress_score,
            s.sensory_overload_index,
            s.next_action,
            s.strategic_value,
            s.recommended_cv_version,
            s.evaluation_summary,
            s.eval_provider,
            s.eval_is_fallback,
            s.version_mismatch,
            s.observed_at,
            s.evaluated_at,
            s.lane_matches,
            s.workability_facts,
            s.queue_status,
            s.latest_match_run_id,
            s.cv_document_run_id,
            s.cover_letter_document_run_id,
            s.document_ready,
            s.current_artifact_status,
            s.current_artifact_reason,
            s.blocked_task_count
          FROM v_canonical_shortlist_scoped s
          WHERE s.workspace_id = $1
          ${cursorClause}
          ORDER BY s.observed_at DESC, s.canonical_job_id DESC
          LIMIT $${params.length}
        `, params);
		const validatedRows = rows.map((row) => ShortlistRowV2Schema.parse(row));
		const last = validatedRows.length > 0 ? validatedRows[validatedRows.length - 1] : null;
		const next_cursor = validatedRows.length === limit && last?.observed_at && last?.canonical_job_id ? encodeCursor({
			t: new Date(last.observed_at).toISOString(),
			id: String(last.canonical_job_id)
		}) : null;
		res.json({
			ok: true,
			jobs: validatedRows,
			next_cursor
		});
	}));
	router.get("/rejected", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const limit = parsePositiveInt(req.query.limit, 50, {
			min: 1,
			max: 200
		});
		const { rows } = await pool.query(`
          SELECT
            a.id AS canonical_job_id,
            a.job_version_id,
            a.title,
            a.company,
            a.careers_portal_url AS canonical_url,
            a.source,
            a.status AS processing_state,
            a.rejection_reason,
            a.gate_status,
            a.rejection_codes,
            a.gate_evidence_quotes,
            a.description,
            a.nd_friendly_score,
            a.politics_stress_score,
            a.sensory_overload_index,
            a."postedDate"::timestamptz AS observed_at
          FROM v_rejected_jobs_audit_scoped a
          WHERE a.workspace_id = $1
          ORDER BY observed_at DESC, a.id DESC
          LIMIT $2
        `, [ctx.workspaceId, limit]);
		const validatedRows = rows.map((row) => RejectedJobRowSchema.parse(row));
		res.json({
			ok: true,
			jobs: validatedRows
		});
	}));
	router.delete("/jobs/:id", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const jobId = String(req.params.id || "").trim();
		if (!jobId) {
			res.status(400).json({
				ok: false,
				error: "job id is required"
			});
			return;
		}
		const result = await pool.query(`
          UPDATE canonical_jobs
          SET processing_state = 'MANUALLY_REMOVED',
              processing_status = 'MANUALLY_REMOVED',
              rejection_reason = 'Manually removed via /api/v2',
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2::uuid
        `, [ctx.workspaceId, jobId]);
		res.json({
			ok: true,
			updated: (result.rowCount ?? 0) > 0
		});
	}));
	router.post("/observations/manual", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const title = String(req.body?.title || "").trim();
		const company = String(req.body?.company || "").trim();
		const source = String(req.body?.source || "MANUAL_STREAMLIT").trim();
		const description = String(req.body?.description || "").trim();
		const salaryRange = String(req.body?.salaryRange || "UNKNOWN").trim();
		const location = String(req.body?.location || "Singapore").trim();
		const careersUrl = String(req.body?.careers_portal_url || "").trim();
		if (!title || !company || !description) {
			res.status(400).json({
				ok: false,
				error: "Missing required fields: title, company, description."
			});
			return;
		}
		const rawPayload = JSON.stringify({
			company_name: company,
			title,
			description,
			source,
			careers_portal_url: careersUrl
		});
		const rawPayloadHash = sha256Hex(rawPayload);
		try {
			const insertedRow = await withTransaction(pool, async (tx) => {
				const sourceRunId = (await tx.query(`INSERT INTO source_runs (workspace_id, status)
             VALUES ($1, 'MANUAL_STREAMLIT')
             RETURNING id`, [ctx.workspaceId])).rows[0].id;
				const extId = `manual-${rawPayloadHash.slice(0, 16)}`;
				return (await tx.query(`
              INSERT INTO raw_job_observations (
                workspace_id,
                source_run_id,
                source_name,
                source_external_id,
                source_url,
                retrieved_at,
                company_name,
                title,
                description_raw,
                location_raw,
                workplace_type_raw,
                employment_type_raw,
                compensation_raw,
                canonical_apply_url,
                source_lane,
                search_plan_version,
                raw_payload,
                raw_payload_hash
              )
              VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, 'UNKNOWN', 'UNKNOWN', $10, $5, 'UNKNOWN', '1.0', $11::jsonb, $12)
              ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING
              RETURNING id
            `, [
					ctx.workspaceId,
					sourceRunId,
					source,
					extId,
					careersUrl,
					company,
					title,
					description,
					location,
					salaryRange,
					rawPayload,
					rawPayloadHash
				])).rows[0] ?? null;
			});
			res.json({
				ok: true,
				inserted: !!insertedRow,
				raw_observation_id: insertedRow?.id ?? null
			});
		} catch (err) {
			throw err;
		}
	}));
	router.post("/observations/linkedin", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : Array.isArray(req.body) ? req.body : [];
		if (!Array.isArray(jobs) || jobs.length === 0) {
			res.status(400).json({
				ok: false,
				error: "Body must be { jobs: [...] } (or an array of jobs)."
			});
			return;
		}
		try {
			const result = await withTransaction(pool, async (tx) => {
				const sourceRunId = (await tx.query(`INSERT INTO source_runs (workspace_id, status)
             VALUES ($1, 'LINKEDIN_IMPORT')
             RETURNING id`, [ctx.workspaceId])).rows[0].id;
				let inserted = 0;
				let skipped = 0;
				for (const job of jobs) {
					const title = String(job?.title || "").trim();
					const company = String(job?.company || "").trim();
					const url = String(job?.url || "").trim();
					const description = String(job?.description || "").trim();
					const location = String(job?.location || "Singapore").trim();
					if (!title || !company || !url || !description) {
						skipped += 1;
						continue;
					}
					const rawPayload = JSON.stringify(job);
					const rawPayloadHash = sha256Hex(rawPayload);
					const extId = `linkedin-${rawPayloadHash.slice(0, 16)}`;
					if ((await tx.query(`
                INSERT INTO raw_job_observations (
                  workspace_id,
                  source_run_id,
                  source_name,
                  source_external_id,
                  source_url,
                  retrieved_at,
                  company_name,
                  title,
                  description_raw,
                  location_raw,
                  workplace_type_raw,
                  employment_type_raw,
                  compensation_raw,
                  canonical_apply_url,
                  source_lane,
                  search_plan_version,
                  raw_payload,
                  raw_payload_hash
                )
                VALUES ($1, $2, 'LINKEDIN', $3, $4, NOW(), $5, $6, $7, $8, 'UNKNOWN', 'PERMANENT', 'UNKNOWN', $4, 'UNKNOWN', '1.0', $9::jsonb, $10)
                ON CONFLICT (workspace_id, raw_payload_hash) DO NOTHING
                RETURNING id
              `, [
						ctx.workspaceId,
						sourceRunId,
						extId,
						url,
						company,
						title,
						description,
						location,
						rawPayload,
						rawPayloadHash
					])).rows.length > 0) inserted += 1;
					else skipped += 1;
				}
				return {
					inserted,
					skipped
				};
			});
			res.json({
				ok: true,
				inserted: result.inserted,
				skipped: result.skipped
			});
		} catch (err) {
			throw err;
		}
	}));
	router.get("/analytics/companies", asyncHandler(async (_req, res) => {
		const { rows } = await pool.query(`
          SELECT
            name as "Company",
            industry as "Industry",
            nd_friendly_avg_score as "Avg Autonomy Score",
            politics_stress_avg_score as "Avg Politics Score",
            sensory_overload_avg_index as "Avg Sensory Index",
            focus_protection_avg_score as "Avg Focus Score",
            is_neurodivergent_approved as "Approved",
            is_toxic_culture_blacklisted as "Toxic"
          FROM companies
          ORDER BY nd_friendly_avg_score DESC
        `);
		res.json({
			ok: true,
			companies: rows
		});
	}));
	router.get("/sources/health", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const { rows } = await pool.query(`
          SELECT
            sp.source_key,
            sp.display_name,
            sp.kind,
            sp.status,
            spr.revision_number AS active_revision_number,
            spr.content->'compliance'->>'access_basis' AS access_basis,
            spr.content->'compliance'->>'terms_url' AS terms_url,
            spr.content->'compliance'->>'attribution_required' AS attribution_required,
            COUNT(rjo.id)::int AS observation_count,
            MAX(rjo.retrieved_at) AS last_observed_at
          FROM source_plugins sp
          LEFT JOIN source_plugin_active_revisions spar
            ON spar.source_plugin_id = sp.id
          LEFT JOIN source_plugin_revisions spr
            ON spr.id = spar.source_plugin_revision_id
          LEFT JOIN raw_job_observations rjo
            ON rjo.workspace_id = sp.workspace_id
           AND rjo.source_plugin_key = sp.source_key
          WHERE sp.workspace_id = $1
          GROUP BY
            sp.source_key,
            sp.display_name,
            sp.kind,
            sp.status,
            spr.revision_number,
            access_basis,
            terms_url,
            attribution_required
          ORDER BY last_observed_at DESC NULLS LAST, sp.source_key ASC
        `, [ctx.workspaceId]);
		res.json({
			ok: true,
			sources: rows
		});
	}));
	router.get("/tasks", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const limit = parsePositiveInt(req.query.limit, 100, {
			min: 1,
			max: 250
		});
		const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);
		const params = [ctx.workspaceId];
		let cursorClause = "";
		if (cursor) {
			params.push(cursor.t, cursor.id);
			cursorClause = "AND (t.created_at, t.id) < ($2::timestamptz, $3::uuid)";
		}
		params.push(limit);
		const { rows } = await pool.query(`
          SELECT
            t.id,
            t.task_type,
            t.task_key,
            t.context_fingerprint,
            t.status,
            t.available_at,
            t.lease_id,
            t.lease_expires_at,
            t.heartbeat_at,
            t.claimed_by,
            t.attempt_count,
            t.max_attempts,
            t.last_error,
            t.dead_letter_reason,
            t.blocked_on,
            t.blocked_reason,
            t.repair_action,
            t.created_at,
            t.updated_at,
            t.completed_at
          FROM pipeline_tasks t
          WHERE t.workspace_id = $1
          ${cursorClause}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT $${params.length}
        `, params);
		const last = rows.length > 0 ? rows[rows.length - 1] : null;
		const next_cursor = rows.length === limit && last?.created_at && last?.id ? encodeCursor({
			t: new Date(last.created_at).toISOString(),
			id: String(last.id)
		}) : null;
		res.json({
			ok: true,
			tasks: rows,
			next_cursor
		});
	}));
	router.post("/tasks", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const taskType = String(req.body?.task_type || "").trim();
		const payload = req.body?.payload;
		const maxAttempts = req.body?.max_attempts;
		const availableAtRaw = req.body?.available_at;
		if (!taskType) {
			res.status(400).json({
				ok: false,
				error: "task_type is required."
			});
			return;
		}
		let taskKey = String(req.body?.task_key || "").trim();
		if (!taskKey) {
			const idempotencyKey = String(req.header("idempotency-key") || "").trim();
			if (!idempotencyKey) {
				res.status(400).json({
					ok: false,
					error: "Provide task_key or Idempotency-Key header."
				});
				return;
			}
			taskKey = `${taskType}:${idempotencyKey}`;
		}
		const availableAt = typeof availableAtRaw === "string" && availableAtRaw.trim() ? new Date(availableAtRaw.trim()) : void 0;
		if (availableAt && Number.isNaN(availableAt.getTime())) {
			res.status(400).json({
				ok: false,
				error: "available_at must be an ISO datetime string."
			});
			return;
		}
		const queued = await enqueuePipelineTask({
			taskType,
			taskKey,
			payload,
			maxAttempts: typeof maxAttempts === "number" ? Math.max(1, Math.min(20, Math.floor(maxAttempts))) : void 0,
			availableAt
		}, pool, { context: ctx });
		res.status(201).json({
			ok: true,
			task_id: queued.taskId,
			inserted: queued.inserted
		});
	}));
	router.get("/applications", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const limit = parsePositiveInt(req.query.limit, 100, {
			min: 1,
			max: 250
		});
		const status = req.query.status !== void 0 ? parseApplicationStatus(req.query.status) : null;
		if (req.query.status !== void 0 && !status) {
			res.status(400).json({
				ok: false,
				error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}.`
			});
			return;
		}
		const { rows } = await pool.query(`
          SELECT
            application_record_id,
            canonical_job_id,
            job_version_id,
            title,
            company,
            canonical_url,
            processing_state,
            processing_status,
            recommendation_eligibility,
            recommendation_outcome,
            primary_lane,
            secondary_lanes,
            application_status,
            submission_url,
            cv_document_run_id,
            cover_letter_document_run_id,
            notes,
            handoff_payload,
            target_submit_at,
            submitted_at,
            follow_up_at,
            last_action_at,
            created_at,
            updated_at
          FROM v_application_tracker
          WHERE workspace_id = $1
            AND user_id = $2
            AND ($3::text IS NULL OR application_status = $3)
          ORDER BY updated_at DESC, application_record_id DESC
          LIMIT $4
        `, [
			ctx.workspaceId,
			ctx.userId,
			status,
			limit
		]);
		res.json({
			ok: true,
			applications: rows
		});
	}));
	router.post("/applications", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const canonicalJobId = String(req.body?.canonical_job_id || "").trim();
		const requestedJobVersionId = String(req.body?.job_version_id || "").trim() || null;
		const status = parseApplicationStatus(req.body?.status, "INTENT");
		const hasTargetSubmitAt = Object.prototype.hasOwnProperty.call(req.body ?? {}, "target_submit_at");
		const hasFollowUpAt = Object.prototype.hasOwnProperty.call(req.body ?? {}, "follow_up_at");
		const targetSubmitAt = parseOptionalIsoDate(req.body?.target_submit_at);
		const followUpAt = parseOptionalIsoDate(req.body?.follow_up_at);
		const handoffPayload = jsonObjectOrEmpty(req.body?.handoff_payload);
		const notes = req.body?.notes != null ? String(req.body.notes).trim() || null : null;
		const submissionUrl = req.body?.submission_url != null ? String(req.body.submission_url).trim() || null : null;
		const cvDocumentRunId = req.body?.cv_document_run_id != null ? String(req.body.cv_document_run_id).trim() || null : null;
		const coverLetterDocumentRunId = req.body?.cover_letter_document_run_id != null ? String(req.body.cover_letter_document_run_id).trim() || null : null;
		if (!canonicalJobId) {
			res.status(400).json({
				ok: false,
				error: "canonical_job_id is required."
			});
			return;
		}
		if (!isUuid(canonicalJobId) || requestedJobVersionId !== null && !isUuid(requestedJobVersionId)) {
			res.status(400).json({
				ok: false,
				error: "canonical_job_id and job_version_id must be UUID strings."
			});
			return;
		}
		if (!status) {
			res.status(400).json({
				ok: false,
				error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}.`
			});
			return;
		}
		if (hasTargetSubmitAt && targetSubmitAt === void 0 || hasFollowUpAt && followUpAt === void 0) {
			res.status(400).json({
				ok: false,
				error: "target_submit_at and follow_up_at must be ISO datetime strings when provided."
			});
			return;
		}
		const record = await withTransaction(pool, async (client) => {
			const job = (await client.query(`
            SELECT c.id AS canonical_job_id,
                   jv.id AS job_version_id,
                   c.canonical_url,
                   current_shortlist.current_artifact_status,
                   current_shortlist.current_artifact_reason,
                   current_shortlist.recommendation_eligibility
            FROM canonical_jobs c
            JOIN job_versions jv
              ON jv.workspace_id = c.workspace_id
             AND jv.id = COALESCE(
               $3::uuid,
               c.latest_job_version_id,
               (
                 SELECT jv2.id
                 FROM job_versions jv2
                 WHERE jv2.workspace_id = c.workspace_id
                   AND jv2.canonical_job_id = c.id
                 ORDER BY jv2.observed_at DESC
                 LIMIT 1
               )
             )
            LEFT JOIN v_canonical_shortlist_scoped current_shortlist
              ON current_shortlist.workspace_id = c.workspace_id
             AND current_shortlist.canonical_job_id = c.id
             AND current_shortlist.job_version_id = jv.id
            WHERE c.workspace_id = $1
              AND c.id = $2::uuid
            LIMIT 1
          `, [
				ctx.workspaceId,
				canonicalJobId,
				requestedJobVersionId
			])).rows[0];
			if (!job) return null;
			if (job.current_artifact_status !== "CURRENT_OR_NOT_APPLICABLE") return {
				handoffBlocked: true,
				error: "The job does not have a current decision artifact. Re-run the pipeline before creating an application handoff.",
				reason: job.current_artifact_reason ?? job.current_artifact_status ?? "CURRENT_ARTIFACT_UNAVAILABLE"
			};
			if (job.recommendation_eligibility !== "ELIGIBLE") return {
				handoffBlocked: true,
				error: "The job is not deterministically eligible for application handoff.",
				reason: job.recommendation_eligibility ?? "RECOMMENDATION_NOT_ELIGIBLE"
			};
			const previous = (await client.query(`
            SELECT id, status
            FROM application_records
            WHERE workspace_id = $1
              AND user_id = $2
              AND canonical_job_id = $3
              AND job_version_id = $4
            LIMIT 1
          `, [
				ctx.workspaceId,
				ctx.userId,
				job.canonical_job_id,
				job.job_version_id
			])).rows[0] ?? null;
			const applicationRecordId = (await client.query(`
            INSERT INTO application_records (
              workspace_id,
              user_id,
              canonical_job_id,
              job_version_id,
              status,
              submission_url,
              cv_document_run_id,
              cover_letter_document_run_id,
              notes,
              handoff_payload,
              target_submit_at,
              submitted_at,
              follow_up_at,
              last_action_at,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, COALESCE($6, $7), $8, $9, $10, $11::jsonb,
              $12::timestamptz,
              CASE WHEN $5 = 'SUBMITTED' THEN NOW() ELSE NULL END,
              $13::timestamptz,
              NOW(),
              NOW()
            )
            ON CONFLICT (workspace_id, user_id, canonical_job_id, job_version_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              submission_url = EXCLUDED.submission_url,
              cv_document_run_id = COALESCE(EXCLUDED.cv_document_run_id, application_records.cv_document_run_id),
              cover_letter_document_run_id = COALESCE(EXCLUDED.cover_letter_document_run_id, application_records.cover_letter_document_run_id),
              notes = COALESCE(EXCLUDED.notes, application_records.notes),
              handoff_payload = CASE
                WHEN EXCLUDED.handoff_payload = '{}'::jsonb THEN application_records.handoff_payload
                ELSE EXCLUDED.handoff_payload
              END,
              target_submit_at = COALESCE(EXCLUDED.target_submit_at, application_records.target_submit_at),
              submitted_at = CASE
                WHEN EXCLUDED.status = 'SUBMITTED' THEN COALESCE(application_records.submitted_at, NOW())
                ELSE application_records.submitted_at
              END,
              follow_up_at = COALESCE(EXCLUDED.follow_up_at, application_records.follow_up_at),
              last_action_at = NOW(),
              updated_at = NOW()
            RETURNING id
          `, [
				ctx.workspaceId,
				ctx.userId,
				job.canonical_job_id,
				job.job_version_id,
				status,
				submissionUrl,
				job.canonical_url,
				cvDocumentRunId,
				coverLetterDocumentRunId,
				notes,
				JSON.stringify(handoffPayload),
				targetSubmitAt ?? null,
				followUpAt ?? null
			])).rows[0].id;
			await client.query(`
            INSERT INTO application_events (
              workspace_id,
              application_record_id,
              event_type,
              from_status,
              to_status,
              note,
              event_payload,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          `, [
				ctx.workspaceId,
				applicationRecordId,
				previous ? "STATUS_CHANGED" : "CREATED",
				previous?.status ?? null,
				status,
				notes,
				JSON.stringify({
					...handoffPayload,
					submission_url: submissionUrl ?? job.canonical_url,
					cv_document_run_id: cvDocumentRunId,
					cover_letter_document_run_id: coverLetterDocumentRunId
				}),
				ctx.userId
			]);
			const { rows } = await client.query(`
            SELECT
              application_record_id,
              canonical_job_id,
              job_version_id,
              title,
              company,
              canonical_url,
              processing_state,
              processing_status,
              recommendation_eligibility,
              recommendation_outcome,
              primary_lane,
              secondary_lanes,
              application_status,
              submission_url,
              cv_document_run_id,
              cover_letter_document_run_id,
              notes,
              handoff_payload,
              target_submit_at,
              submitted_at,
              follow_up_at,
              last_action_at,
              created_at,
              updated_at
            FROM v_application_tracker
            WHERE workspace_id = $1
              AND user_id = $2
              AND application_record_id = $3
            LIMIT 1
          `, [
				ctx.workspaceId,
				ctx.userId,
				applicationRecordId
			]);
			return rows[0] ?? null;
		});
		if (!record) {
			res.status(404).json({
				ok: false,
				error: "Canonical job/version not found."
			});
			return;
		}
		if (typeof record === "object" && record !== null && record.handoffBlocked === true) {
			const blocked = record;
			res.status(409).json({
				ok: false,
				error: blocked.error,
				reason: blocked.reason
			});
			return;
		}
		res.status(201).json({
			ok: true,
			application: record
		});
	}));
	router.patch("/applications/:id", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const applicationRecordId = String(req.params.id || "").trim();
		const requestedStatus = req.body?.status !== void 0 ? parseApplicationStatus(req.body.status) : void 0;
		const notes = req.body?.notes !== void 0 ? String(req.body.notes || "").trim() || null : void 0;
		const followUpAt = parseOptionalIsoDate(req.body?.follow_up_at);
		const eventPayload = jsonObjectOrEmpty(req.body?.event_payload);
		if (!applicationRecordId) {
			res.status(400).json({
				ok: false,
				error: "application id is required."
			});
			return;
		}
		if (!isUuid(applicationRecordId)) {
			res.status(400).json({
				ok: false,
				error: "application id must be a UUID string."
			});
			return;
		}
		if (requestedStatus === null) {
			res.status(400).json({
				ok: false,
				error: `status must be one of: ${APPLICATION_STATUSES.join(", ")}.`
			});
			return;
		}
		if (followUpAt === void 0 && req.body?.follow_up_at !== void 0) {
			res.status(400).json({
				ok: false,
				error: "follow_up_at must be an ISO datetime string when provided."
			});
			return;
		}
		const updated = await withTransaction(pool, async (client) => {
			const current = (await client.query(`
            SELECT id, status
            FROM application_records
            WHERE workspace_id = $1
              AND user_id = $2
              AND id = $3::uuid
            LIMIT 1
          `, [
				ctx.workspaceId,
				ctx.userId,
				applicationRecordId
			])).rows[0];
			if (!current) return null;
			const nextStatus = requestedStatus ?? current.status;
			await client.query(`
            UPDATE application_records
            SET status = $4,
                notes = COALESCE($5, notes),
                follow_up_at = COALESCE($6::timestamptz, follow_up_at),
                submitted_at = CASE
                  WHEN $4 = 'SUBMITTED' THEN COALESCE(submitted_at, NOW())
                  ELSE submitted_at
                END,
                last_action_at = NOW(),
                updated_at = NOW()
            WHERE workspace_id = $1
              AND user_id = $2
              AND id = $3::uuid
          `, [
				ctx.workspaceId,
				ctx.userId,
				applicationRecordId,
				nextStatus,
				notes ?? null,
				followUpAt ?? null
			]);
			await client.query(`
            INSERT INTO application_events (
              workspace_id,
              application_record_id,
              event_type,
              from_status,
              to_status,
              note,
              event_payload,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          `, [
				ctx.workspaceId,
				applicationRecordId,
				current.status === nextStatus ? "NOTE_ADDED" : "STATUS_CHANGED",
				current.status,
				nextStatus,
				notes ?? null,
				JSON.stringify(eventPayload),
				ctx.userId
			]);
			const { rows } = await client.query(`
            SELECT
              application_record_id,
              canonical_job_id,
              job_version_id,
              title,
              company,
              canonical_url,
              processing_state,
              processing_status,
              recommendation_eligibility,
              recommendation_outcome,
              primary_lane,
              secondary_lanes,
              application_status,
              submission_url,
              cv_document_run_id,
              cover_letter_document_run_id,
              notes,
              handoff_payload,
              target_submit_at,
              submitted_at,
              follow_up_at,
              last_action_at,
              created_at,
              updated_at
            FROM v_application_tracker
            WHERE workspace_id = $1
              AND user_id = $2
              AND application_record_id = $3
            LIMIT 1
          `, [
				ctx.workspaceId,
				ctx.userId,
				applicationRecordId
			]);
			return rows[0] ?? null;
		});
		if (!updated) {
			res.status(404).json({
				ok: false,
				error: "Application record not found."
			});
			return;
		}
		res.json({
			ok: true,
			application: updated
		});
	}));
	router.get("/applications/:id/events", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const applicationRecordId = String(req.params.id || "").trim();
		const limit = parsePositiveInt(req.query.limit, 100, {
			min: 1,
			max: 250
		});
		if (!isUuid(applicationRecordId)) {
			res.status(400).json({
				ok: false,
				error: "application id must be a UUID string."
			});
			return;
		}
		if ((await pool.query(`
          SELECT id
          FROM application_records
          WHERE workspace_id = $1
            AND user_id = $2
            AND id = $3::uuid
          LIMIT 1
        `, [
			ctx.workspaceId,
			ctx.userId,
			applicationRecordId
		])).rows.length === 0) {
			res.status(404).json({
				ok: false,
				error: "Application record not found."
			});
			return;
		}
		const { rows } = await pool.query(`
          SELECT
            id,
            application_record_id,
            event_type,
            from_status,
            to_status,
            note,
            event_payload,
            created_at
          FROM application_events
          WHERE workspace_id = $1
            AND application_record_id = $2::uuid
          ORDER BY created_at DESC, id DESC
          LIMIT $3
        `, [
			ctx.workspaceId,
			applicationRecordId,
			limit
		]);
		res.json({
			ok: true,
			events: rows
		});
	}));
	router.get("/accessibility", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const { rows } = await pool.query(`
          SELECT
            quiet_mode,
            reduced_motion,
            high_contrast,
            density,
            font_scale,
            show_emojis,
            updated_at
          FROM workspace_user_accessibility_settings
          WHERE workspace_id = $1
            AND user_id = $2
          LIMIT 1
        `, [ctx.workspaceId, ctx.userId]);
		const defaults = {
			quiet_mode: false,
			reduced_motion: false,
			high_contrast: false,
			density: "comfortable",
			font_scale: 1,
			show_emojis: true
		};
		res.json({
			ok: true,
			settings: rows[0] ? {
				...defaults,
				...rows[0]
			} : defaults
		});
	}));
	router.put("/accessibility", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const body = req.body ?? {};
		for (const key of [
			"quiet_mode",
			"reduced_motion",
			"high_contrast",
			"show_emojis"
		]) if (body[key] !== void 0 && typeof body[key] !== "boolean") {
			res.status(400).json({
				ok: false,
				error: `${key} must be boolean.`
			});
			return;
		}
		if (body.density !== void 0 && body.density !== "comfortable" && body.density !== "compact") {
			res.status(400).json({
				ok: false,
				error: "density must be one of: comfortable, compact."
			});
			return;
		}
		if (body.font_scale !== void 0) {
			if (typeof body.font_scale !== "number" || Number.isNaN(body.font_scale)) {
				res.status(400).json({
					ok: false,
					error: "font_scale must be a number."
				});
				return;
			}
			if (body.font_scale < .8 || body.font_scale > 1.5) {
				res.status(400).json({
					ok: false,
					error: "font_scale must be between 0.80 and 1.50."
				});
				return;
			}
		}
		const updated = await withTransaction(pool, async (client) => {
			const { rows: existingRows } = await client.query(`
            SELECT quiet_mode, reduced_motion, high_contrast, density, font_scale, show_emojis
            FROM workspace_user_accessibility_settings
            WHERE workspace_id = $1 AND user_id = $2
            LIMIT 1
          `, [ctx.workspaceId, ctx.userId]);
			const base = existingRows[0] || {
				quiet_mode: false,
				reduced_motion: false,
				high_contrast: false,
				density: "comfortable",
				font_scale: 1,
				show_emojis: true
			};
			const next = {
				quiet_mode: body.quiet_mode ?? base.quiet_mode,
				reduced_motion: body.reduced_motion ?? base.reduced_motion,
				high_contrast: body.high_contrast ?? base.high_contrast,
				density: body.density ?? base.density,
				font_scale: body.font_scale ?? base.font_scale,
				show_emojis: body.show_emojis ?? base.show_emojis
			};
			const { rows } = await client.query(`
            INSERT INTO workspace_user_accessibility_settings (
              workspace_id,
              user_id,
              quiet_mode,
              reduced_motion,
              high_contrast,
              density,
              font_scale,
              show_emojis
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (workspace_id, user_id)
            DO UPDATE SET
              quiet_mode = EXCLUDED.quiet_mode,
              reduced_motion = EXCLUDED.reduced_motion,
              high_contrast = EXCLUDED.high_contrast,
              density = EXCLUDED.density,
              font_scale = EXCLUDED.font_scale,
              show_emojis = EXCLUDED.show_emojis,
              updated_at = NOW()
            RETURNING quiet_mode, reduced_motion, high_contrast, density, font_scale, show_emojis, updated_at
          `, [
				ctx.workspaceId,
				ctx.userId,
				next.quiet_mode,
				next.reduced_motion,
				next.high_contrast,
				next.density,
				next.font_scale,
				next.show_emojis
			]);
			return rows[0];
		});
		res.json({
			ok: true,
			settings: updated
		});
	}));
	router.get("/preference-modes", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const { rows } = await pool.query(`
          SELECT
            mode_key,
            display_name,
            description,
            is_active,
            content,
            updated_at
          FROM workspace_user_preference_modes
          WHERE workspace_id = $1
            AND user_id = $2
          ORDER BY is_active DESC, updated_at DESC
        `, [ctx.workspaceId, ctx.userId]);
		res.json({
			ok: true,
			modes: rows
		});
	}));
	router.post("/preference-modes", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const modeKey = String(req.body?.mode_key || "").trim();
		const displayName = String(req.body?.display_name || "").trim();
		const description = req.body?.description != null ? String(req.body?.description || "").trim() : null;
		const content = req.body?.content ?? {};
		if (!modeKey || !modeKey.match(/^[a-z][a-z0-9_]{2,63}$/)) {
			res.status(400).json({
				ok: false,
				error: "mode_key must match ^[a-z][a-z0-9_]{2,63}$."
			});
			return;
		}
		if (!displayName) {
			res.status(400).json({
				ok: false,
				error: "display_name is required."
			});
			return;
		}
		if (!content || typeof content !== "object" || Array.isArray(content)) {
			res.status(400).json({
				ok: false,
				error: "content must be a JSON object."
			});
			return;
		}
		const mode = await withTransaction(pool, async (client) => {
			const { rows } = await client.query(`
            INSERT INTO workspace_user_preference_modes (
              workspace_id,
              user_id,
              mode_key,
              display_name,
              description,
              content,
              is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, FALSE)
            ON CONFLICT (workspace_id, user_id, mode_key)
            DO UPDATE SET
              display_name = EXCLUDED.display_name,
              description = EXCLUDED.description,
              content = EXCLUDED.content,
              updated_at = NOW()
            RETURNING mode_key, display_name, description, is_active, content, updated_at
          `, [
				ctx.workspaceId,
				ctx.userId,
				modeKey,
				displayName,
				description,
				JSON.stringify(content)
			]);
			return rows[0];
		});
		res.status(201).json({
			ok: true,
			mode
		});
	}));
	router.post("/preference-modes/preview", asyncHandler(async (req, res) => {
		const content = req.body?.content ?? {};
		if (!content || typeof content !== "object" || Array.isArray(content)) {
			res.status(400).json({
				ok: false,
				error: "content must be a JSON object."
			});
			return;
		}
		const preview = previewWorkabilityPolicy(content);
		res.json({
			ok: true,
			...preview
		});
	}));
	router.post("/preference-modes/activate", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const modeKey = String(req.body?.mode_key || "").trim();
		if (!modeKey) {
			res.status(400).json({
				ok: false,
				error: "mode_key is required."
			});
			return;
		}
		const activation = await withTransaction(pool, async (client) => {
			await client.query(`
            UPDATE workspace_user_preference_modes
            SET is_active = FALSE, updated_at = NOW()
            WHERE workspace_id = $1
              AND user_id = $2
              AND is_active = TRUE
              AND mode_key <> $3
          `, [
				ctx.workspaceId,
				ctx.userId,
				modeKey
			]);
			const { rows } = await client.query(`
            UPDATE workspace_user_preference_modes
            SET is_active = TRUE, updated_at = NOW()
            WHERE workspace_id = $1
              AND user_id = $2
              AND mode_key = $3
            RETURNING mode_key, display_name, description, is_active, content, updated_at
          `, [
				ctx.workspaceId,
				ctx.userId,
				modeKey
			]);
			const mode = rows[0] || null;
			if (!mode) return {
				mode: null,
				recalculationEnqueued: 0,
				recalculationExisting: 0
			};
			const recalculationCandidates = await client.query(`
            SELECT
              c.id AS canonical_job_id,
              COALESCE(c.latest_job_version_id, lv.id) AS job_version_id
            FROM canonical_jobs c
            LEFT JOIN LATERAL (
              SELECT id
              FROM job_versions
              WHERE workspace_id = c.workspace_id
                AND canonical_job_id = c.id
              ORDER BY observed_at DESC
              LIMIT 1
            ) lv ON TRUE
            WHERE c.workspace_id = $1
              AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
              AND COALESCE(c.latest_job_version_id, lv.id) IS NOT NULL
            ORDER BY c.created_at ASC, c.id ASC
          `, [ctx.workspaceId]);
			let recalculationEnqueued = 0;
			let recalculationExisting = 0;
			const modeRevision = Number.isFinite(Date.parse(String(mode.updated_at))) ? String(Date.parse(String(mode.updated_at))) : crypto.default.randomUUID();
			for (const candidate of recalculationCandidates.rows) if ((await enqueuePipelineTask({
				taskType: "APPLY_HARD_GATES",
				taskKey: `APPLY_HARD_GATES:${candidate.job_version_id}:preference:${mode.mode_key}:${modeRevision}`,
				payload: {
					canonical_job_id: candidate.canonical_job_id,
					job_version_id: candidate.job_version_id,
					force_policy_recalculation: true,
					preference_mode_key: mode.mode_key,
					preference_mode_updated_at: mode.updated_at
				},
				maxAttempts: 8
			}, client, { context: ctx })).inserted) recalculationEnqueued += 1;
			else recalculationExisting += 1;
			return {
				mode,
				recalculationEnqueued,
				recalculationExisting
			};
		});
		if (!activation.mode) {
			res.status(404).json({
				ok: false,
				error: "Mode not found."
			});
			return;
		}
		res.json({
			ok: true,
			mode: activation.mode,
			recalculation_enqueued: activation.recalculationEnqueued,
			recalculation_existing: activation.recalculationExisting
		});
	}));
	router.get("/verification-questions", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const questions = await getPendingVerificationQuestions(pool, { context: ctx });
		res.json({
			ok: true,
			questions
		});
	}));
	router.post("/verification-questions/:key/answer", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const questionKey = String(req.params.key || "").trim();
		const answer = req.body?.answer;
		if (!questionKey) {
			res.status(400).json({
				ok: false,
				error: "question key is required."
			});
			return;
		}
		if (answer === void 0 || answer === null || answer === "") {
			res.status(400).json({
				ok: false,
				error: "answer is required."
			});
			return;
		}
		try {
			const result = await answerVerificationQuestion(pool, questionKey, answer, { context: ctx });
			res.json({
				ok: true,
				resumedJobCount: result.resumedJobCount
			});
		} catch (err) {
			res.status(400).json({
				ok: false,
				error: err.message || String(err)
			});
		}
	}));
	router.post("/verification-questions/:key/dismiss", asyncHandler(async (req, res) => {
		const ctx = req.workspaceContext;
		const questionKey = String(req.params.key || "").trim();
		if (!questionKey) {
			res.status(400).json({
				ok: false,
				error: "question key is required."
			});
			return;
		}
		try {
			const result = await dismissVerificationQuestion(pool, questionKey, { context: ctx });
			res.json({
				ok: true,
				dismissed: result.ok
			});
		} catch (err) {
			res.status(400).json({
				ok: false,
				error: err.message || String(err)
			});
		}
	}));
	router.use((err, _req, res, _next) => {
		console.error("Unhandled /api/v2 error:", err);
		if (res.headersSent) return;
		res.status(500).json({
			ok: false,
			error: err?.message || "Unexpected server error."
		});
	});
	return router;
}
//#endregion
//#region src/desktop/workerSupervisor.ts
var DESKTOP_WORKER_KINDS = [
	"pipeline",
	"evaluation",
	"recovery"
];
var WORKER_DEFINITIONS = [
	{
		kind: "pipeline",
		bundledFile: "process_pipeline_tasks.cjs",
		developmentScript: "process_pipeline_tasks.ts",
		args: []
	},
	{
		kind: "evaluation",
		bundledFile: "evaluate_queue.cjs",
		developmentScript: "evaluate_queue.ts",
		args: []
	},
	{
		kind: "recovery",
		bundledFile: "reconcile_pipeline.cjs",
		developmentScript: "reconcile_pipeline.ts",
		args: ["--json"]
	}
];
var DEFAULT_RESTART_BASE_MS = 1e3;
var DEFAULT_RESTART_MAX_MS = 6e4;
var DEFAULT_STABLE_RUN_MS = 6e4;
var DEFAULT_SHUTDOWN_GRACE_MS = 5e3;
function definitionFor(kind) {
	const definition = WORKER_DEFINITIONS.find((candidate) => candidate.kind === kind);
	if (!definition) throw new Error(`Unsupported desktop worker kind: ${kind}`);
	return definition;
}
function defaultFileExists(filePath) {
	return node_fs.default.existsSync(filePath);
}
function isElectronRuntime() {
	return Boolean(process.versions.electron);
}
function desktopWorkersEnabled(env = process.env) {
	return String(env.JDEC_DESKTOP_ENABLE_WORKERS || "").trim().toLowerCase() !== "false";
}
function resolveWorkerCommand(kind, options) {
	const definition = definitionFor(kind);
	const fileExists = options.fileExists ?? defaultFileExists;
	const nodeExecutable = options.nodeExecutable ?? process.execPath;
	const bundledDir = options.bundledDir;
	const bundledEntrypoint = bundledDir ? node_path.default.join(bundledDir, definition.bundledFile) : null;
	const projectRoot = options.projectRoot ?? (options.isPackaged ? null : process.cwd());
	const developmentEntrypoint = projectRoot ? node_path.default.join(projectRoot, "scripts", definition.developmentScript) : null;
	const tsxCliPath = options.tsxCliPath ?? (projectRoot ? node_path.default.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs") : null);
	if (!options.isPackaged && Boolean(projectRoot && developmentEntrypoint && tsxCliPath) && fileExists(developmentEntrypoint) && fileExists(tsxCliPath) && projectRoot && developmentEntrypoint && tsxCliPath) return {
		executable: nodeExecutable,
		args: [
			tsxCliPath,
			developmentEntrypoint,
			...definition.args
		],
		cwd: projectRoot,
		source: "development-ts",
		entrypoint: developmentEntrypoint
	};
	if (bundledEntrypoint && fileExists(bundledEntrypoint)) return {
		executable: nodeExecutable,
		args: [bundledEntrypoint],
		cwd: bundledDir,
		source: "bundled",
		entrypoint: bundledEntrypoint
	};
	return null;
}
function emptyWorkerStatus(kind) {
	return {
		kind,
		state: "not_started",
		pid: null,
		lastStartAt: null,
		lastExitAt: null,
		restartCount: 0,
		reason: null
	};
}
function parsePositiveNumber(value, fallback) {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function isActiveState(state) {
	return state === "starting" || state === "running" || state === "backoff";
}
function exitReason(code, signal) {
	return `worker_exit: exit_code=${code ?? "null"} signal=${signal ?? "null"}`;
}
var DesktopWorkerSupervisor = class {
	env;
	isPackaged;
	bundledDir;
	projectRoot;
	resolveCommand;
	spawn;
	now;
	restartBaseMs;
	restartMaxMs;
	stableRunMs;
	shutdownGraceMs;
	logger;
	desiredRunning = false;
	lifecycleState = "not_started";
	globalReason = null;
	runtimes;
	constructor(options = {}) {
		this.env = options.env ?? process.env;
		this.isPackaged = options.isPackaged ?? Boolean(process.versions.electron && process.defaultApp === false);
		this.bundledDir = options.bundledDir;
		this.projectRoot = options.projectRoot;
		this.resolveCommand = options.resolveCommand ?? ((kind, resolutionOptions) => resolveWorkerCommand(kind, resolutionOptions));
		this.spawn = options.spawn ?? ((command, env) => this.spawnChild(command, env));
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
		this.restartBaseMs = parsePositiveNumber(options.restartBaseMs, DEFAULT_RESTART_BASE_MS);
		this.restartMaxMs = Math.max(this.restartBaseMs, parsePositiveNumber(options.restartMaxMs, DEFAULT_RESTART_MAX_MS));
		this.stableRunMs = parsePositiveNumber(options.stableRunMs, DEFAULT_STABLE_RUN_MS);
		this.shutdownGraceMs = parsePositiveNumber(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS);
		this.logger = options.logger ?? ((message) => console.warn(message));
		this.runtimes = Object.fromEntries(DESKTOP_WORKER_KINDS.map((kind) => [kind, {
			status: emptyWorkerStatus(kind),
			process: null,
			restartTimer: null,
			startedAtMs: null,
			consecutiveRestarts: 0,
			stopResolve: null
		}]));
	}
	async start() {
		if (this.desiredRunning && this.lifecycleState !== "stopped") return;
		this.desiredRunning = true;
		this.lifecycleState = "starting";
		await this.refresh();
	}
	async refresh() {
		if (!this.desiredRunning) return;
		if (!desktopWorkersEnabled(this.env)) {
			this.globalReason = "disabled_by_env";
			this.lifecycleState = "disabled";
			this.stopWorkersForConfiguration("disabled", this.globalReason);
			return;
		}
		if (!String(this.env.DATABASE_URL || "").trim()) {
			this.globalReason = "DATABASE_URL is required for desktop workers.";
			this.lifecycleState = "misconfigured";
			this.stopWorkersForConfiguration("misconfigured", this.globalReason);
			return;
		}
		this.globalReason = null;
		for (const kind of DESKTOP_WORKER_KINDS) {
			const runtime = this.runtimes[kind];
			if (runtime.process || runtime.restartTimer || isActiveState(runtime.status.state)) continue;
			this.launch(kind);
		}
		this.recomputeLifecycleState();
	}
	async stop() {
		if (!this.desiredRunning && this.lifecycleState === "stopped") return;
		this.desiredRunning = false;
		this.lifecycleState = "stopping";
		this.globalReason = "shutdown";
		const waits = [];
		for (const runtime of Object.values(this.runtimes)) {
			if (runtime.restartTimer) {
				clearTimeout(runtime.restartTimer);
				runtime.restartTimer = null;
			}
			if (!runtime.process) {
				runtime.status = {
					...runtime.status,
					state: "stopped",
					pid: null,
					reason: "shutdown"
				};
				continue;
			}
			const child = runtime.process;
			waits.push(new Promise((resolve) => {
				let forceTimer = null;
				const finishStop = () => {
					if (forceTimer) clearTimeout(forceTimer);
					forceTimer = null;
					runtime.stopResolve = null;
					resolve();
				};
				runtime.stopResolve = finishStop;
				forceTimer = setTimeout(() => {
					if (runtime.process) try {
						runtime.process.kill("SIGKILL");
					} catch {}
					finishStop();
				}, this.shutdownGraceMs);
				forceTimer?.unref?.();
				try {
					child.kill("SIGTERM");
				} catch {
					finishStop();
				}
			}));
		}
		await Promise.all(waits);
		for (const runtime of Object.values(this.runtimes)) {
			runtime.process = null;
			runtime.status = {
				...runtime.status,
				state: "stopped",
				pid: null,
				reason: "shutdown"
			};
		}
		this.lifecycleState = "stopped";
	}
	getStatus() {
		const workers = Object.fromEntries(DESKTOP_WORKER_KINDS.map((kind) => {
			return [kind, { ...this.runtimes[kind].status }];
		}));
		return {
			enabled: desktopWorkersEnabled(this.env),
			state: this.lifecycleState,
			reason: this.globalReason,
			workers
		};
	}
	spawnChild(command, env) {
		const childEnv = { ...env };
		if (isElectronRuntime()) childEnv.ELECTRON_RUN_AS_NODE = "1";
		const child = (0, node_child_process.spawn)(command.executable, command.args, {
			cwd: command.cwd,
			env: childEnv,
			shell: false,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		child.stdout?.resume();
		child.stderr?.resume();
		return child;
	}
	launch(kind) {
		if (!this.desiredRunning || !desktopWorkersEnabled(this.env) || !String(this.env.DATABASE_URL || "").trim()) return;
		const runtime = this.runtimes[kind];
		const command = this.resolveCommand(kind, {
			isPackaged: this.isPackaged,
			bundledDir: this.bundledDir,
			projectRoot: this.projectRoot
		});
		if (!command) {
			runtime.status = {
				...runtime.status,
				state: "misconfigured",
				pid: null,
				reason: this.isPackaged ? "bundled_worker_entrypoint_missing" : "development_worker_entrypoint_unavailable"
			};
			this.globalReason = runtime.status.reason;
			this.recomputeLifecycleState();
			return;
		}
		const startedAt = this.now();
		runtime.startedAtMs = startedAt.getTime();
		runtime.status = {
			...runtime.status,
			state: "starting",
			pid: null,
			lastStartAt: startedAt.toISOString(),
			reason: `starting:${command.source}`
		};
		this.recomputeLifecycleState();
		let child;
		try {
			child = this.spawn(command, {
				...this.env,
				JDEC_DESKTOP_WORKER_KIND: kind
			});
		} catch (error) {
			this.handleFailure(kind, error instanceof Error ? error.message : String(error));
			return;
		}
		runtime.process = child;
		runtime.status = {
			...runtime.status,
			state: "running",
			pid: child.pid ?? null,
			reason: `running:${command.source}`
		};
		this.recomputeLifecycleState();
		let handled = false;
		const finish = (code, signal, reason) => {
			if (handled) return;
			handled = true;
			this.handleExit(kind, child, code, signal, reason);
		};
		child.once("error", (error) => finish(null, null, `worker_error: ${error.message}`));
		child.once("exit", (code, signal) => finish(code, signal));
	}
	handleFailure(kind, reason) {
		const runtime = this.runtimes[kind];
		runtime.consecutiveRestarts += 1;
		runtime.status = {
			...runtime.status,
			state: "backoff",
			pid: null,
			lastExitAt: this.now().toISOString(),
			restartCount: runtime.status.restartCount + 1,
			reason
		};
		this.scheduleRestart(kind);
	}
	handleExit(kind, child, code, signal, explicitReason) {
		const runtime = this.runtimes[kind];
		if (runtime.process !== child) return;
		runtime.process = null;
		runtime.stopResolve?.();
		runtime.stopResolve = null;
		const endedAt = this.now();
		if ((runtime.startedAtMs === null ? 0 : endedAt.getTime() - runtime.startedAtMs) >= this.stableRunMs) runtime.consecutiveRestarts = 0;
		runtime.consecutiveRestarts += 1;
		runtime.status = {
			...runtime.status,
			state: this.desiredRunning && desktopWorkersEnabled(this.env) && String(this.env.DATABASE_URL || "").trim() ? "backoff" : !this.desiredRunning ? "stopped" : !desktopWorkersEnabled(this.env) ? "disabled" : "misconfigured",
			pid: null,
			lastExitAt: endedAt.toISOString(),
			restartCount: runtime.status.restartCount + 1,
			reason: explicitReason ?? exitReason(code, signal)
		};
		if (runtime.status.state === "backoff") this.scheduleRestart(kind);
		else this.recomputeLifecycleState();
	}
	scheduleRestart(kind) {
		const runtime = this.runtimes[kind];
		if (!this.desiredRunning || !desktopWorkersEnabled(this.env) || !String(this.env.DATABASE_URL || "").trim()) {
			this.recomputeLifecycleState();
			return;
		}
		if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
		const exponent = Math.max(0, runtime.consecutiveRestarts - 1);
		const delay = Math.min(this.restartMaxMs, this.restartBaseMs * Math.pow(2, exponent));
		runtime.status = {
			...runtime.status,
			state: "backoff"
		};
		this.logger(`Desktop ${kind} worker exited; restarting in ${delay}ms.`);
		runtime.restartTimer = setTimeout(() => {
			runtime.restartTimer = null;
			this.launch(kind);
		}, delay);
		runtime.restartTimer.unref?.();
		this.recomputeLifecycleState();
	}
	stopWorkersForConfiguration(state, reason) {
		for (const runtime of Object.values(this.runtimes)) {
			if (runtime.restartTimer) {
				clearTimeout(runtime.restartTimer);
				runtime.restartTimer = null;
			}
			if (runtime.process) {
				try {
					runtime.process.kill("SIGTERM");
				} catch {}
				runtime.process = null;
			}
			runtime.status = {
				...runtime.status,
				state,
				pid: null,
				reason
			};
		}
	}
	recomputeLifecycleState() {
		if (!this.desiredRunning) return;
		if (!desktopWorkersEnabled(this.env)) {
			this.lifecycleState = "disabled";
			return;
		}
		if (!String(this.env.DATABASE_URL || "").trim()) {
			this.lifecycleState = "misconfigured";
			return;
		}
		const statuses = Object.values(this.runtimes).map((runtime) => runtime.status);
		if (statuses.some((status) => isActiveState(status.state))) {
			this.lifecycleState = "running";
			return;
		}
		if (statuses.some((status) => status.state === "misconfigured")) {
			this.lifecycleState = "misconfigured";
			return;
		}
		this.lifecycleState = "starting";
	}
};
function createWorkerSupervisor(options = {}) {
	return new DesktopWorkerSupervisor(options);
}
//#endregion
//#region src/desktop/localServer.ts
async function findAvailablePort(preferredPort, host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const tester = net.default.createServer();
		tester.once("error", (err) => {
			if (err.code === "EADDRINUSE") resolve(findAvailablePort(preferredPort + 1, host));
			else reject(err);
		});
		tester.once("listening", () => {
			tester.close(() => resolve(preferredPort));
		});
		tester.listen(preferredPort, host);
	});
}
async function startLocalServer(options = {}) {
	const host = options.host || "127.0.0.1";
	const actualPort = await findAvailablePort(options.port || 3217, host);
	const token = options.token || process.env.JDEC_API_TOKEN || crypto.default.randomBytes(32).toString("hex");
	process.env.JDEC_API_TOKEN = token;
	if (options.databaseUrl) process.env.DATABASE_URL = options.databaseUrl;
	if (options.databaseUrlDirect) process.env.DATABASE_URL_UNPOOLED = options.databaseUrlDirect;
	if (options.geminiApiKey) process.env.GEMINI_API_KEY = options.geminiApiKey;
	if (options.openaiApiKey) process.env.OPENAI_API_KEY = options.openaiApiKey;
	const app = (0, express.default)();
	const workerSupervisor = options.workerSupervisor ?? createWorkerSupervisor({
		env: process.env,
		isPackaged: options.workerPackaged ?? false,
		bundledDir: options.workerBundleDir,
		projectRoot: options.workerProjectRoot
	});
	app.use((req, res, next) => {
		const rawHost = String(req.headers.host || "").split(":")[0].toLowerCase();
		if (rawHost !== "127.0.0.1" && rawHost !== "localhost") {
			res.status(403).json({
				ok: false,
				error: "Loopback access only"
			});
			return;
		}
		next();
	});
	const getStatus = () => ({
		ok: true,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		api: {
			state: "running",
			host,
			port: actualPort,
			apiBaseUrl: `http://${host}:${actualPort}/api/v2`
		},
		workers: workerSupervisor.getStatus()
	});
	app.get([
		"/health",
		"/status",
		"/api/v2/status"
	], (_req, res) => {
		res.json(getStatus());
	});
	app.use((_req, _res, next) => {
		workerSupervisor.refresh();
		next();
	});
	app.use("/api/v2", createApiV2Router());
	const server = http.default.createServer(app);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(actualPort, host, () => {
			resolve();
		});
	});
	const instance = {
		server,
		port: actualPort,
		host,
		token,
		apiBaseUrl: `http://${host}:${actualPort}/api/v2`,
		workerSupervisor,
		getStatus,
		close: async () => {
			await workerSupervisor.stop();
			await new Promise((resolve, reject) => {
				server.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		},
		updateConfig: (config) => {
			if (config.databaseUrl !== void 0) process.env.DATABASE_URL = config.databaseUrl;
			if (config.databaseUrlDirect !== void 0) process.env.DATABASE_URL_UNPOOLED = config.databaseUrlDirect;
			if (config.geminiApiKey !== void 0) process.env.GEMINI_API_KEY = config.geminiApiKey;
			if (config.openaiApiKey !== void 0) process.env.OPENAI_API_KEY = config.openaiApiKey;
			workerSupervisor.refresh();
		}
	};
	await workerSupervisor.start();
	return instance;
}
if (process.argv[1]?.includes("localServer")) startLocalServer().then((inst) => {
	console.log(`Local Job Decision Engine server listening at ${inst.apiBaseUrl}`);
}).catch((err) => {
	console.error("Failed to start local server:", err);
	process.exit(1);
});
//#endregion
exports.findAvailablePort = findAvailablePort;
exports.startLocalServer = startLocalServer;
