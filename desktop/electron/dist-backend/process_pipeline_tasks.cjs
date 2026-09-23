Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
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
let node_fs = require("node:fs");
node_fs = __toESM(node_fs, 1);
let node_path = require("node:path");
node_path = __toESM(node_path, 1);
let js_yaml = require("js-yaml");
js_yaml = __toESM(js_yaml, 1);
let path = require("path");
path = __toESM(path, 1);
let zod = require("zod");
let _google_genai = require("@google/genai");
let fs = require("fs");
fs = __toESM(fs, 1);
let url = require("url");
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
//#region src/pipeline/workModeNormalizer.ts
function normalizeWorkMode(raw) {
	const value = String(raw ?? "").trim().toLowerCase();
	if (!value) return "UNKNOWN";
	if (/(remote|work from home|wfh|telecommute|remote-first)/i.test(value)) return "REMOTE";
	if (/(hybrid|flexible hybrid|partly remote)/i.test(value)) return "HYBRID";
	if (/(on[-\s]?site|onsite|on premise|on-premise|on premises|on-premises|in[-\s]?office|office[-\s]?based)/i.test(value)) return "ONSITE";
	if (value === "unknown" || value === "unspecified" || value === "n/a" || value === "na") return "UNKNOWN";
	return "UNKNOWN";
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
function sha256Hex(input) {
	return crypto.default.createHash("sha256").update(input).digest("hex");
}
//#endregion
//#region src/pipeline/workabilityPolicy.ts
/** The five persisted verification answers understood by deterministic gates. */
var VERIFICATION_ANSWER_KEYS = {
	workplaceOfficeDays: "workplace_hybrid_office_days_allowed",
	degreeSubjects: "profile_degree_subjects",
	workAuthorization: "work_authorization_jurisdictions",
	experienceDomains: "experience_equivalent_domains",
	travelPercentage: "lifestyle_travel_percentage_cap"
};
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
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Normalize dotted country abbreviations before territory matching. Job
* boards commonly emit `U.S.`/`U.K.` in location labels; sentence splitting
* would otherwise turn those into unrelated one-letter fragments and hide an
* explicit work-territory restriction.
*/
function normalizeTerritorySearchText(value) {
	return String(value ?? "").toLowerCase().replace(/\bu\s*\.\s*s\.?/g, "us").replace(/\bu\s*\.\s*k\.?/g, "uk").replace(/\be\s*\.\s*u\.?/g, "eu");
}
function normalizeTerritory(value) {
	const normalized = String(value ?? "").trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
	if (!normalized) return null;
	return TERRITORY_ALIASES.find(([, aliases]) => aliases.includes(normalized))?.[0] ?? normalized.toUpperCase().replace(/\s+/g, "_");
}
function normalizeTerritories(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map(normalizeTerritory).filter((item) => Boolean(item)))];
}
function extractTerritories(value) {
	const text = normalizeTerritorySearchText(value);
	const found = [];
	for (const [territory, aliases] of TERRITORY_ALIASES) if (aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(text))) found.push(territory);
	return found;
}
var KNOWN_TERRITORIES = new Set(TERRITORY_ALIASES.map(([territory]) => territory));
function answerObject(content) {
	let parsed = content;
	if (typeof parsed === "string") try {
		parsed = JSON.parse(parsed);
	} catch {
		parsed = null;
	}
	const root = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	const nested = [
		root.answers,
		root.verification_answers,
		root.content
	].find((value) => value && typeof value === "object" && !Array.isArray(value));
	return nested ? nested : root;
}
function answerValue(root, key, ordinal) {
	const aliases = [
		key,
		`Q0${ordinal}`,
		`q0${ordinal}`
	];
	for (const candidate of [
		root,
		root.answers,
		root.verification_answers
	]) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const record = candidate;
		for (const alias of aliases) if (Object.prototype.hasOwnProperty.call(record, alias)) return record[alias];
	}
}
function flattenAnswerValues(value) {
	if (Array.isArray(value)) return value.flatMap(flattenAnswerValues);
	if (value && typeof value === "object") return Object.values(value).flatMap(flattenAnswerValues);
	return value === null || value === void 0 ? [] : [value];
}
function answerKeyProvided(root, key, ordinal) {
	const aliases = [
		key,
		`Q0${ordinal}`,
		`q0${ordinal}`
	];
	for (const candidate of [
		root,
		root.answers,
		root.verification_answers
	]) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const record = candidate;
		if (aliases.some((alias) => Object.prototype.hasOwnProperty.call(record, alias))) return true;
	}
	return false;
}
function answerText(value) {
	return flattenAnswerValues(value).map((item) => String(item).trim()).filter(Boolean).join(" ").toLowerCase();
}
function parseAnswerNumber(value, maximum, unitPattern) {
	const values = flattenAnswerValues(value);
	for (const item of values) {
		if (typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= maximum) return item;
		const text = String(item).trim().toLowerCase();
		if (!text) continue;
		if (/^(?:fully\s+)?remote(?:\s+only)?$|^no\s+(?:office|travel)$/i.test(text)) return 0;
		const match = text.match(unitPattern) || text.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\b`));
		if (!match) continue;
		const parsed = Number(match[1]);
		if (Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum) return parsed;
	}
	return null;
}
/** Normalize the degree-subject vocabulary used by verification answer options. */
function normalizeVerificationDegreeSubjects(value) {
	const text = answerText(value).replace(/[_-]+/g, " ");
	const subjects = [];
	const add = (subject) => {
		if (!subjects.includes(subject)) subjects.push(subject);
	};
	if (/\b(computer\s+science|computing|informatics|software\s+engineering)\b/i.test(text)) add("computer_science");
	if (/\b(data\s+science|analytics?|statistics?)\b/i.test(text)) add("data_science");
	if (/\b(mathematics?|mathematical|quantitative)\b/i.test(text)) add("mathematics");
	if (/\b(electrical|systems?)\s+engineering\b|\bengineering\b/i.test(text) && !/software\s+engineering/i.test(text)) add("engineering");
	if (/\bphysics?|computational\s+science\b/i.test(text)) add("physics");
	if (/\b(biology|biological|biomedical|biochemistry)\b/i.test(text)) add("biology");
	if (/\b(finance|financial|economics?)\b/i.test(text)) add("finance");
	if (/\b(business|management)\b/i.test(text)) add("business");
	if (/\b(law|legal\s+studies|jurisprudence)\b/i.test(text)) add("law");
	return subjects;
}
/** Normalize accepted equivalent experience domains without treating free text as evidence. */
function normalizeVerificationExperienceDomains(value) {
	const text = answerText(value);
	const domains = [];
	const add = (domain) => {
		if (!domains.includes(domain)) domains.push(domain);
	};
	if (/\b(ai|artificial\s+intelligence|machine\s+learning|\bml\b|llm|generative\s+ai|computer\s+vision)\b/i.test(text)) add("ai");
	if (/\b(software|full[- ]?stack|backend|frontend|application|coding|web)\b/i.test(text)) add("software");
	if (/\b(data|analytics?|etl|pipeline|warehous(?:e|ing)|business\s+intelligence)\b/i.test(text)) add("data");
	if (/\b(cloud|devops|infrastructure|platform|kubernetes|terraform)\b/i.test(text)) add("cloud_devops");
	return domains;
}
function normalizeVerificationAuthorizationRegions(value) {
	const regions = [];
	for (const item of flattenAnswerValues(value)) {
		for (const territory of extractTerritories(String(item))) if (KNOWN_TERRITORIES.has(territory) && !regions.includes(territory)) regions.push(territory);
		const normalized = normalizeTerritory(item);
		if (normalized && KNOWN_TERRITORIES.has(normalized) && !regions.includes(normalized)) regions.push(normalized);
	}
	return regions;
}
/**
* Convert the immutable `verification_answers` revision payload into the
* narrow contract consumed by gates. Unrecognized values intentionally yield
* no override; the caller must not infer a fact from an arbitrary string.
*/
function createVerificationAnswerContext(content, identity = {}) {
	const root = answerObject(content);
	const officeDays = parseAnswerNumber(answerValue(root, VERIFICATION_ANSWER_KEYS.workplaceOfficeDays, 1), 3, /(\d+(?:\.\d+)?)\s*days?/i);
	const travelPct = parseAnswerNumber(answerValue(root, VERIFICATION_ANSWER_KEYS.travelPercentage, 5), 100, /(\d+(?:\.\d+)?)\s*%/i);
	return {
		answerRevisionId: identity.answerRevisionId ?? null,
		revisionNumber: identity.revisionNumber ?? null,
		jobVersionId: identity.jobVersionId ?? null,
		providedAnswerKeys: Object.values(VERIFICATION_ANSWER_KEYS).filter((key, index) => answerKeyProvided(root, key, index + 1)),
		overrides: {
			workplaceOfficeDaysCap: officeDays,
			degreeSubjects: normalizeVerificationDegreeSubjects(answerValue(root, VERIFICATION_ANSWER_KEYS.degreeSubjects, 2)),
			workAuthorizationRegions: normalizeVerificationAuthorizationRegions(answerValue(root, VERIFICATION_ANSWER_KEYS.workAuthorization, 3)),
			experienceDomains: normalizeVerificationExperienceDomains(answerValue(root, VERIFICATION_ANSWER_KEYS.experienceDomains, 4)),
			travelPercentageCap: travelPct
		}
	};
}
/** Return false when a task's answer/job identity does not match its context. */
function isVerificationAnswerContextApplicable(answerContext, expected = {}) {
	if (!answerContext) return false;
	if (expected.answerRevisionId !== void 0 && expected.answerRevisionId !== null && answerContext.answerRevisionId !== expected.answerRevisionId) return false;
	if (expected.jobVersionId !== void 0 && expected.jobVersionId !== null && answerContext.jobVersionId !== null && answerContext.jobVersionId !== expected.jobVersionId) return false;
	return true;
}
function isVerificationAnswerProvided(answerContext, key) {
	return answerContext?.providedAnswerKeys?.includes(key) ?? false;
}
/** Apply only the workability axes represented by recognized answer values. */
function applyVerificationAnswerOverrides(policy, answerContext) {
	if (!answerContext) return policy;
	const overrides = answerContext.overrides;
	const next = { ...policy };
	const workplaceAnswerProvided = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.workplaceOfficeDays);
	if (overrides.workplaceOfficeDaysCap !== null || workplaceAnswerProvided) {
		if (overrides.workplaceOfficeDaysCap !== null) next.maxOfficeDaysPerWeek = overrides.workplaceOfficeDaysCap;
		next.hybridWithoutOfficeDaysAllowed = false;
	}
	const workAuthorizationAnswerProvided = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.workAuthorization);
	if (overrides.workAuthorizationRegions.length > 0) next.authorizedRegions = [...overrides.workAuthorizationRegions];
	if (workAuthorizationAnswerProvided) next.unknownWorkAuthorizationNeedsVerification = true;
	if (overrides.travelPercentageCap !== null) next.maxTravelPct = overrides.travelPercentageCap;
	return next;
}
/**
* Load one active or explicitly requested answer revision. Read failures are
* deliberately converted to `null`: answer persistence is advisory to the
* gate, and an operational registry outage must never become a career reject.
*/
async function loadVerificationAnswerContext(clientOrPool, options = {}) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	let client = clientOrPool;
	try {
		if (ownsClient) client = await clientOrPool.connect();
		const ctx = options.context ?? await resolveWorkspaceContext(client);
		const requestedRevisionId = options.answerRevisionId ?? null;
		const query = requestedRevisionId ? `SELECT cr.id, cr.revision_number, cr.content
         FROM config_definitions cd
         JOIN config_revisions cr ON cr.config_definition_id = cd.id
         WHERE cd.workspace_id = $1
           AND cd.config_key = 'verification_answers'
           AND cr.id = $2
         LIMIT 1` : `SELECT cr.id, cr.revision_number, cr.content
         FROM config_definitions cd
         JOIN config_active_revisions car ON car.config_definition_id = cd.id
         JOIN config_revisions cr ON cr.id = car.config_revision_id
         WHERE cd.workspace_id = $1
           AND cd.config_key = 'verification_answers'
         LIMIT 1`;
		const values = requestedRevisionId ? [ctx.workspaceId, requestedRevisionId] : [ctx.workspaceId];
		const row = (await client.query(query, values)).rows[0];
		if (!row) return null;
		return createVerificationAnswerContext(row.content, {
			answerRevisionId: row.id,
			revisionNumber: row.revision_number,
			jobVersionId: options.jobVersionId ?? null
		});
	} catch {
		return null;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
/**
* A territory mention is only a work-location restriction when the source
* sentence also contains an employment/location qualifier. This prevents
* references such as "US clients" from becoming false location rejections.
*/
function hasExplicitTerritoryRestriction(value, territory) {
	const canonical = normalizeTerritory(territory);
	if (!canonical) return false;
	const aliases = (TERRITORY_ALIASES.find(([key]) => key === canonical)?.[1] ?? [canonical.toLowerCase()]).map(normalizeTerritorySearchText);
	return normalizeTerritorySearchText(value).split(/[.!?;\n]+/).map((sentence) => sentence.trim()).filter(Boolean).some((sentence) => {
		return aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(sentence)) && /\b(only|required|must|mandatory|work\s+(?:in|from)|working\s+(?:in|from)|based\s+in|located\s+in|location\s*[:=-]\s*|office\s+in|on[- ]?site\s+in|authorization|authorised|authorized|eligible|rights|citizen(?:ship)?|visa|residen(?:cy|tial))\b/i.test(sentence);
	});
}
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
async function resolveWorkspaceWorkabilityPolicy(clientOrPool, options) {
	const basePolicy = loadWorkabilityPolicy();
	const fallback = {
		policy: basePolicy,
		source: "FILE",
		modeKey: null,
		modeId: null,
		policyHash: sha256Hex(stableStringify(basePolicy))
	};
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const { rows } = await client.query(`SELECT id, mode_key, content
       FROM workspace_user_preference_modes
       WHERE workspace_id = $1
         AND user_id = $2
         AND is_active = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`, [ctx.workspaceId, ctx.userId]);
		const row = rows[0];
		if (!row) return fallback;
		const policy = mergeWorkabilityPreferenceContent(basePolicy, row.content);
		return {
			policy,
			source: "ACTIVE_PREFERENCE_MODE",
			modeKey: row.mode_key,
			modeId: row.id,
			policyHash: sha256Hex(stableStringify({
				source: "ACTIVE_PREFERENCE_MODE",
				mode_id: row.id,
				mode_key: row.mode_key,
				policy
			}))
		};
	} catch (error) {
		if (error?.code === "42P01" || error?.code === "42703") return fallback;
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/security/sanitize.ts
var HTML_ENTITY_MAP = {
	nbsp: " ",
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	"#39": "'"
};
function decodeNumericEntity(code) {
	const normalized = code.toLowerCase();
	const isHex = normalized.startsWith("#x");
	const numberPart = normalized.startsWith("#") ? normalized.slice(isHex ? 2 : 1) : "";
	const value = numberPart ? Number.parseInt(numberPart, isHex ? 16 : 10) : NaN;
	if (!Number.isFinite(value) || value < 0) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}
function decodeHtmlEntities(input) {
	return input.replace(/&([a-zA-Z0-9#x]+);/g, (match, key) => {
		const mapped = HTML_ENTITY_MAP[key.toLowerCase()];
		if (mapped !== void 0) return mapped;
		if (key.startsWith("#")) return decodeNumericEntity(key) || "";
		return match;
	});
}
function normalizeWhitespace(input) {
	return input.replace(/\r\n/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
/**
* Convert HTML-ish content into readable plain text.
* - Strips script/style blocks
* - Converts common block tags into newlines
* - Drops remaining tags
* - Decodes common HTML entities
*/
function stripHtmlToText(input) {
	const raw = String(input ?? "");
	if (!raw) return "";
	return normalizeWhitespace(decodeHtmlEntities(raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<(br|br\/)\s*>/gi, "\n").replace(/<\/(p|div|section|article|header|footer|ul|ol|li|h1|h2|h3|h4|h5|h6)\s*>/gi, "\n").replace(/<(p|div|section|article|header|footer|ul|ol|li|h1|h2|h3|h4|h5|h6)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n"));
}
//#endregion
//#region src/requirements/clauseAnalysis.ts
/**
* Finds the enclosing sentence, bullet point, or delimited clause around a match span.
*/
function findEnclosingClause(text, matchStart, matchEnd) {
	const safeStart = Math.max(0, Math.min(matchStart, text.length));
	const safeEnd = Math.max(safeStart, Math.min(matchEnd, text.length));
	let startOffset = safeStart;
	while (startOffset > 0) {
		const prevChar = text[startOffset - 1];
		if (prevChar === "\n" || prevChar === "\r" || prevChar === "•" || prevChar === "	") break;
		if ((prevChar === "." || prevChar === "!" || prevChar === "?" || prevChar === ";") && startOffset < safeStart && /\s/.test(text[startOffset] || "")) break;
		startOffset--;
	}
	let endOffset = safeEnd;
	while (endOffset < text.length) {
		const char = text[endOffset];
		if (char === "\n" || char === "\r" || char === "•") break;
		if ((char === "." || char === "!" || char === "?" || char === ";") && (endOffset + 1 >= text.length || /\s/.test(text[endOffset + 1]))) {
			endOffset++;
			break;
		}
		endOffset++;
	}
	return {
		clauseText: text.slice(startOffset, endOffset).trim(),
		clausePrefix: text.slice(startOffset, safeStart),
		clauseSuffix: text.slice(safeEnd, endOffset),
		startOffset,
		endOffset
	};
}
/**
* Negation prefixes within the same clause (supports 0-4 intervening modifier words).
* Note: 'support an' is explicitly affirmative and NOT a negator.
*/
var CLAUSE_NEGATION_PREFIX_REGEX = /(?:^|[\s,;:(])(?:no|not|never|without|zero|0|free\s+of|neither|nor|doesn't|does\s+not|don't|do\s+not|won't|will\s+not|isn't|is\s+not|aren't|are\s+not|no\s+requirement\s+for)(?:\s+[\w'-]+){0,4}\s*$/i;
/**
* Negation suffixes within the same clause.
*/
var CLAUSE_NEGATION_SUFFIX_REGEX = /^\s*(?:is|are|will\s+be)?\s*(?:not\s+required|optional|not\s+expected|not\s+needed|not\s+mandatory|not\s+a\s+requirement|not\s+necessary|none|0%|zero)\b/i;
/**
* Checks whether an occurrence at the specified offsets is negated within its enclosing clause.
*/
function isOccurrenceNegated(text, matchStart, matchLengthOrEnd) {
	const clause = findEnclosingClause(text, matchStart, matchLengthOrEnd > matchStart ? matchLengthOrEnd : matchStart + matchLengthOrEnd);
	if (CLAUSE_NEGATION_PREFIX_REGEX.test(clause.clausePrefix)) return true;
	if (CLAUSE_NEGATION_SUFFIX_REGEX.test(clause.clauseSuffix)) return true;
	return false;
}
var PREFERENCE_REGEX = /\b(preferred|preference|preferable|nice\s+to\s+have|bonus|plus|optional|desired|desirable|advantageous)\b/i;
var MANDATORY_OVERRIDE_REGEX = /\b(required|mandatory|must\s+have|essential|strictly\s+required)\b/i;
var SUBCLAUSE_BOUNDARY_REGEX = /(?:;\s*|\(\s*|\)\s*|,\s*(?:but|however|although|whereas|while|yet|though|except|and|or)\s+|\b(?:but|however|although|whereas|while|yet|though|except)\s+)/gi;
/**
* Finds the enclosing subclause delimited by conjunctions, semicolons, or parentheses
* within a sentence/bullet.
*/
function findEnclosingSubclause(text, matchStart, matchEnd) {
	const clause = findEnclosingClause(text, matchStart, matchEnd);
	const safeStart = Math.max(clause.startOffset, Math.min(matchStart, clause.endOffset));
	const safeEnd = Math.max(safeStart, Math.min(matchEnd, clause.endOffset));
	let subclauseStart = clause.startOffset;
	let subclauseEnd = clause.endOffset;
	const prefixMatches = [...text.slice(clause.startOffset, safeStart).matchAll(SUBCLAUSE_BOUNDARY_REGEX)];
	if (prefixMatches.length > 0) {
		const lastMatch = prefixMatches[prefixMatches.length - 1];
		subclauseStart = clause.startOffset + (lastMatch.index ?? 0) + lastMatch[0].length;
	}
	const suffixMatches = [...text.slice(safeEnd, clause.endOffset).matchAll(SUBCLAUSE_BOUNDARY_REGEX)];
	if (suffixMatches.length > 0) {
		const firstMatch = suffixMatches[0];
		if (firstMatch.index !== void 0) subclauseEnd = safeEnd + firstMatch.index;
	}
	return {
		clauseText: text.slice(subclauseStart, subclauseEnd).trim(),
		clausePrefix: text.slice(subclauseStart, safeStart),
		clauseSuffix: text.slice(safeEnd, subclauseEnd),
		startOffset: subclauseStart,
		endOffset: subclauseEnd
	};
}
/**
* Infers requirement importance (MUST vs PREFERRED) strictly within the enclosing subclause / bullet.
* Avoids cross-sentence, cross-bullet, or cross-conjunction clause bleed.
*/
function inferClauseImportance(text, matchStart, matchEnd) {
	const subclause = findEnclosingSubclause(text, matchStart, matchEnd);
	const subclauseLower = subclause.clauseText.toLowerCase();
	if (PREFERENCE_REGEX.test(subclauseLower)) {
		if (MANDATORY_OVERRIDE_REGEX.test(subclauseLower)) {
			const suffixHasMandatory = MANDATORY_OVERRIDE_REGEX.test(subclause.clauseSuffix);
			const prefixHasMandatory = MANDATORY_OVERRIDE_REGEX.test(subclause.clausePrefix);
			const suffixHasPref = PREFERENCE_REGEX.test(subclause.clauseSuffix);
			const prefixHasPref = PREFERENCE_REGEX.test(subclause.clausePrefix);
			if (suffixHasMandatory && !suffixHasPref) return "MUST";
			if (prefixHasMandatory && !prefixHasPref) return "MUST";
			return "PREFERRED";
		}
		return "PREFERRED";
	}
	const clauseLower = findEnclosingClause(text, matchStart, matchEnd).clauseText.toLowerCase();
	if (PREFERENCE_REGEX.test(clauseLower) && !MANDATORY_OVERRIDE_REGEX.test(clauseLower)) return "PREFERRED";
	return "MUST";
}
/**
* Finds all non-overlapping matches for a set of regex patterns, respecting clause negation.
*/
function findAllMatches(text, patterns) {
	const matches = [];
	for (const pattern of patterns) {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		const regex = new RegExp(pattern.source, flags);
		let match;
		while ((match = regex.exec(text)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			matches.push({
				quote_text: match[0],
				quote_start_offset: match.index,
				quote_end_offset: match.index + match[0].length
			});
		}
	}
	return matches.sort((a, b) => a.quote_start_offset - b.quote_start_offset);
}
/**
* Finds the first non-negated match across a set of regex patterns.
*/
function findFirstNonNegatedMatch(text, patterns) {
	const allMatches = findAllMatches(text, patterns);
	for (const match of allMatches) if (!isOccurrenceNegated(text, match.quote_start_offset, match.quote_end_offset)) return match;
	return null;
}
//#endregion
//#region src/services/criteria.ts
var GLOBAL_TITLE_EXCLUSIONS = [
	/\b(human resources?|hr|recruiter|talent acquisition|people operations?|people partner)\b/i,
	/\b(executive assistant|office manager|receptionist|admin assistant|administrative assistant)\b/i,
	/\b(legal counsel|attorney|lawyer|m&a|paralegal|contracts? manager)\b/i,
	/\b(sales manager|account executive|business development representative|bdr|sdr|(?<!technical\s+)account manager)\b/i,
	/\b(marketing manager|social media|content writer|pr manager|brand manager)\b/i,
	/\b(quality assurance coordinator|manual tester|qa tester)\b/i,
	/\b(brain researcher|neuroscientist|wet lab|postdoctoral fellow)\b/i
];
var TECHNICAL_FUNCTION_KEYWORDS = [
	/\b(software engineer|data engineer|ml engineer|machine learning engineer|ai engineer)\b/i,
	/\b(full[\s-]stack|backend engineer|distributed systems|platform engineer|cloud engineer)\b/i,
	/\b(research engineer|quantitative developer|quant engineer|system architect|ai architect)\b/i,
	/\b(engineering|technology|technical|software|data|analytics?|ai|ml|digital|transformation|scientific)\s+(program|programme|project|portfolio|delivery|transformation)?\s*(manager|director|lead|head|officer|vp|vice president)\b/i,
	/\b(manager|director|lead|head|officer|vp|vice president)\s+of\s+(engineering|technology|software|data|analytics?|ai|ml|platform|cloud|systems?|digital|transformation|research|science)\b/i,
	/\b(software development|software delivery|application development|data science|data platform|data architecture|data analytics|technology transformation|digital transformation|data transformation|technical delivery|engineering delivery|engineering program|technical roadmap|product development|systems design|release management|cloud platform|platform engineering|software development lifecycle|sdlc)\b/i,
	/\b(python|typescript|go|c\+\+|rust|sql|postgres|fastapi|docker|kubernetes)\b/i,
	/\b(applied scientist|research scientist|bioinformatics|computational biolog(y|ist)|genomics?|biotech|drug discovery)\b/i,
	/\b(regtech|legaltech|compliance automation|contract analytics|knowledge engineer(ing)?|llm|agents?|rag|nlp|foundation models?|data pipeline)\b/i
];
/**
* Unified Technical Role Recognition (Axis 1)
*/
function isTechnicalRole(title, description) {
	const t = (title || "").toLowerCase();
	const d = (description || "").toLowerCase();
	const isTechnicalTitle = /\b(engineer|engineering|developer|architect|data scientist|data analyst|analytics engineer|business intelligence|machine learning|applied scientist|research scientist|scientist|quantitative researcher|quant researcher|quant developer|quantitative developer|quantitative engineer|ai researcher|software engineer|data engineer|ml platform|systems engineer|systems analyst|programmer|statistician|bioinformatician|bioinformatics scientist|bioinformatics|computational biolog(y|ist)|scientific ml|legal ai|regtech|compliance automation|contract analytics|knowledge engineer(ing)?|test automation|automation engineer|qa automation)\b/i.test(t);
	const hasTechnicalLeadershipTitle = /\b(manager|director|lead|head|officer|vp|vice president)\b/i.test(t) && /\b(engineer(?:ing)?|technology|technical|software|data|analytics?|ai|ml|machine learning|platform|cloud|systems?|digital|transformation|research|scientific|science)\b/i.test(t);
	const hasTechnicalProgramTitle = /\b(technical|technology|engineering|software|data|ai|ml|digital|transformation)\s+(program|programme|project|portfolio|delivery|transformation)\s+(manager|director|lead|head|officer|vp|vice president)\b/i.test(t);
	const buildingKeywords = [
		"python",
		"typescript",
		"javascript",
		"go",
		"golang",
		"c++",
		"rust",
		"sql",
		"postgres",
		"pytorch",
		"tensorflow",
		"scikit-learn",
		"keras",
		"jax",
		"pandas",
		"numpy",
		"spark",
		"fastapi",
		"docker",
		"kubernetes",
		"aws",
		"gcp",
		"azure",
		"distributed systems",
		"data pipeline",
		"etl",
		"data warehouse",
		"data lake",
		"lakehouse",
		"data science",
		"data platform",
		"data architecture",
		"data analytics",
		"model training",
		"fine-tuning",
		"rag",
		"agents",
		"agentic",
		"llm",
		"nlp",
		"prompt engineering",
		"bioinformatics",
		"genomics",
		"cheminformatics",
		"computational biology",
		"drug discovery",
		"regtech",
		"legaltech",
		"compliance automation",
		"contract analytics",
		"document intelligence",
		"knowledge graphs",
		"time-series",
		"portfolio analytics",
		"algorithmic trading",
		"market microstructure",
		"architecture",
		"software engineering",
		"software development",
		"software delivery",
		"application development",
		"technology transformation",
		"digital transformation",
		"data transformation",
		"technical delivery",
		"engineering delivery",
		"engineering program",
		"technical roadmap",
		"product development",
		"systems design",
		"release management",
		"cloud platform",
		"platform engineering",
		"software development lifecycle",
		"sdlc",
		"mlops",
		"ci/cd"
	];
	const shortToken = /^[a-z0-9]{1,3}$/;
	const hasKeyword = (text, kw) => {
		if (shortToken.test(kw)) {
			const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`\\b${escaped}\\b`, "i").test(text);
		}
		return text.includes(kw);
	};
	const hasBuildingEvidence = buildingKeywords.some((kw) => hasKeyword(t, kw) || hasKeyword(d, kw)) || TECHNICAL_FUNCTION_KEYWORDS.some((p) => p.test(t) || p.test(d));
	const isTechnical = isTechnicalTitle || hasTechnicalLeadershipTitle || hasTechnicalProgramTitle || hasBuildingEvidence;
	return {
		isTechnical,
		hasBuildingEvidence,
		reason: isTechnical ? void 0 : "Axis 1 Failed: Role lacks evidence of technical, building, or engineering function"
	};
}
function numericRange(match) {
	const first = Number(match[1]);
	const second = match[2] === void 0 ? first : Number(match[2]);
	return [Math.min(first, second), Math.max(first, second)];
}
/** Extract only attendance phrases; unrelated durations such as annual leave are ignored. */
function extractHybridAttendance(description) {
	const text = String(description || "").toLowerCase();
	const ranges = [];
	const officePatterns = [
		/\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:in|at)\s+(?:the\s+)?(?:office|on-?site|onsite)\b/gi,
		/\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:on-?site|onsite|in-?office)\b/gi,
		/\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:on-?site|onsite)\b/gi,
		/\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:office|on-?site|onsite)\s+days?\b/gi
	];
	const wfhPatterns = [/\b(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\s*(?:per\s*week|a\s*week|\/week)?\s*(?:wfh|work\s+from\s+home|from\s+home|remote)\b/gi, /\b(?:wfh|work\s+from\s+home|from\s+home|remote)\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(?:days?|d)\b/gi];
	for (const pattern of officePatterns) for (const match of text.matchAll(pattern)) {
		const range = numericRange(match);
		ranges.push({
			range,
			evidence: match[0]
		});
	}
	for (const pattern of wfhPatterns) for (const match of text.matchAll(pattern)) {
		const [wfhMin, wfhMax] = numericRange(match);
		ranges.push({
			range: [5 - wfhMax, 5 - wfhMin],
			evidence: match[0]
		});
	}
	if (ranges.length === 0) return null;
	const intersectionMin = Math.max(...ranges.map(({ range }) => range[0]));
	const intersectionMax = Math.min(...ranges.map(({ range }) => range[1]));
	const contradictory = intersectionMin > intersectionMax;
	const officeMin = contradictory ? Math.min(...ranges.map(({ range }) => range[0])) : intersectionMin;
	const officeMax = contradictory ? Math.max(...ranges.map(({ range }) => range[1])) : intersectionMax;
	return {
		office_days_min: Math.max(0, officeMin),
		office_days_max: Math.min(7, officeMax),
		evidence: [...new Set(ranges.map(({ evidence }) => evidence))],
		basis: "EMPLOYER_STATED",
		contradictory
	};
}
/** Return the upper bound of a travel requirement, preserving range semantics. */
function extractTravelRequirement(description) {
	const text = String(description || "").toLowerCase();
	for (const pattern of [
		/(?:travel|travelling|traveling)(?:[^.;\n%]{0,40}?)(\d+)\s*%\s*(?:-|–|to)\s*(\d+)\s*%/gi,
		/(\d+)\s*%\s*(?:-|–|to)\s*(\d+)\s*%(?:[^.;\n%]{0,40}?)(?:travel|travelling|traveling)/gi,
		/(?:travel|travelling|traveling)(?:[^.;\n%]{0,40}?)(\d+)\s*%/gi,
		/(\d+)\s*%(?:[^.;\n%]{0,40}?)(?:travel|travelling|traveling)/gi
	]) {
		const match = pattern.exec(text);
		if (!match) continue;
		const first = Number(match[1]);
		const second = match[2] === void 0 ? first : Number(match[2]);
		return {
			max_pct: Math.max(first, second),
			evidence: match[0]
		};
	}
	return null;
}
function evaluateWorkability(location, workplaceType, description, employmentType, policy = loadWorkabilityPolicy(), answerContext) {
	const effectivePolicy = applyVerificationAnswerOverrides(policy, answerContext);
	const officeDaysAnswerUnknown = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.workplaceOfficeDays) && answerContext?.overrides.workplaceOfficeDaysCap === null;
	const workAuthorizationAnswerUnknown = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.workAuthorization) && answerContext?.overrides.workAuthorizationRegions.length === 0;
	const wp = normalizeWorkMode(workplaceType);
	const loc = (location || "").toLowerCase().trim();
	const d = (description || "").toLowerCase().trim();
	const emp = (employmentType || "").toUpperCase().trim();
	const removeNonEmploymentContractPhrases = (text) => text.replace(/\bsmart contracts?\b/g, " ").replace(/\bcontract (analysis|analytics|management|automation|lifecycle|intelligence|review)\b/g, " ").replace(/\bcontracts (analysis|analytics|management|review)\b/g, " ").replace(/\s+/g, " ").trim();
	const normalizedEmp = (() => {
		if (emp.includes("CONTRACT")) return "CONTRACT";
		if (emp.includes("PERMANENT") || emp.includes("FULL_TIME") || emp === "FTE") return "PERMANENT";
		const cleaned = removeNonEmploymentContractPhrases(d);
		if (/\bcontract[- ]to[- ]hire\b/i.test(cleaned) || /\b\d{1,2}\s*(?:month|months|mo|week|weeks|wk|day|days)\s+contract\b/i.test(cleaned) || /\bcontract\s+(?:role|position|assignment|opportunity)\b/i.test(cleaned) || /\bfixed[- ]term\b/i.test(cleaned) || /\btemporary\b/i.test(cleaned) || /\bcontractor\b/i.test(cleaned)) return "CONTRACT";
		if (/\bfull[- ]?time\b/i.test(d) || /\bpermanent\b/i.test(d) || /\bfte\b/i.test(d)) return "PERMANENT";
		return "UNKNOWN";
	})();
	const baseFacts = { employment_type: normalizedEmp };
	if (normalizedEmp === "CONTRACT" && !effectivePolicy.contractAllowed) return {
		workable: false,
		needsVerify: false,
		reason: "Contract employment detected",
		reasonCode: "GATE_CONTRACT_ROLE",
		facts: baseFacts
	};
	const officeDaysMatch = d.match(/\b([1-5])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*(?:in|at)?\s*(?:the\s*)?office\b/i) || d.match(/\b([1-5])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*on-?site\b/i);
	const isExplicitOnsiteText = /\b(100%\s*on-?site|fully\s*on-?site|on-premises\s*only|lab-based|wet\s*lab|clinic-based)\b/i.test(d) || /(?:^|[|·•:])\s*(?:on-?site|onsite)\b/i.test(d) || /\b(?:location|workplace|work\s+location)\s*:\s*(?:on-?site|onsite)\b/i.test(d) || /\b(?:role|position|work|working|presence|based)\s+(?:is\s+)?(?:on-?site|onsite)\b/i.test(d) || officeDaysMatch !== null && Number(officeDaysMatch[1]) >= effectivePolicy.hardFailOfficeDaysPerWeek;
	if (!effectivePolicy.onsiteOnlyAllowed && wp === "ONSITE" || !effectivePolicy.onsiteOnlyAllowed && isExplicitOnsiteText) {
		const minDays = officeDaysMatch ? Number(officeDaysMatch[1]) : 4;
		const maxDays = officeDaysMatch ? Number(officeDaysMatch[1]) : 5;
		return {
			workable: false,
			needsVerify: false,
			reason: "Requires 100% on-premises / on-site presence (ONSITE mode not workable)",
			reasonCode: "GATE_HIGH_OFFICE_DAYS",
			facts: {
				...baseFacts,
				office_days_min: minDays,
				office_days_max: maxDays
			}
		};
	}
	const isExplicitRemoteText = /\b(?:fully\s+remote|remote[- ]first|remote\s+(?:position|role|job|work|opportunity)|remote\s+(?:from|in)\b|work\s+from\s+home|work\s+remotely)\b/i.test(d) || /(?:^|[|·•:])\s*remote\b/i.test(d) || /\b(?:location|workplace|work\s+location)\s*:\s*remote\b/i.test(d);
	const isRemote = wp === "REMOTE" || wp === "UNKNOWN" && (/\bremote\b/i.test(loc) || isExplicitRemoteText);
	const authorizedRegions = new Set(effectivePolicy.authorizedRegions);
	const locationTerritories = extractTerritories(loc);
	const descriptionTerritories = extractTerritories(d);
	const explicitlyDisallowed = effectivePolicy.rejectExplicitForeignTerritory ? [...isRemote ? [] : locationTerritories, ...descriptionTerritories.filter((territory) => hasExplicitTerritoryRestriction(d, territory))].filter((territory) => authorizedRegions.size === 0 || !authorizedRegions.has(territory)) : [];
	if (explicitlyDisallowed.length > 0) {
		const territory = explicitlyDisallowed[0];
		if (workAuthorizationAnswerUnknown) return {
			workable: true,
			needsVerify: true,
			reason: `Work authorization for ${territory} is unknown; needs manual verification`,
			facts: {
				...baseFacts,
				location_restriction: territory
			}
		};
		return {
			workable: false,
			needsVerify: false,
			reason: `Geographic restriction detected: ${territory}`,
			reasonCode: "GATE_LOCATION_RESTRICTED",
			facts: {
				...baseFacts,
				location_restriction: territory
			}
		};
	}
	if (isRemote) {
		if (locationTerritories.length === 0 && descriptionTerritories.length === 0 && !effectivePolicy.remoteWithoutTerritoryAllowed) return {
			workable: true,
			needsVerify: true,
			reason: "Remote territory is not stated and this preference mode requires it",
			facts: {
				...baseFacts,
				office_days_min: 0,
				office_days_max: 0,
				attendance_basis: "REMOTE"
			}
		};
		return {
			workable: true,
			needsVerify: false,
			facts: {
				...baseFacts,
				office_days_min: 0,
				office_days_max: 0,
				attendance_basis: "REMOTE"
			}
		};
	}
	if (wp === "HYBRID" || /\bhybrid\b/i.test(d) || /\bhybrid\b/i.test(loc)) {
		const attendance = extractHybridAttendance(d);
		if (attendance) {
			if (attendance.contradictory || attendance.office_days_max >= effectivePolicy.hardFailOfficeDaysPerWeek) return {
				workable: false,
				needsVerify: false,
				reason: attendance.contradictory ? "Hybrid attendance statements contradict one another" : "Hybrid arrangement requires 4-5 days in-office",
				reasonCode: "GATE_HIGH_OFFICE_DAYS",
				facts: {
					...baseFacts,
					office_days_min: attendance.office_days_min,
					office_days_max: attendance.office_days_max,
					attendance_basis: "EMPLOYER_STATED"
				}
			};
			if (officeDaysAnswerUnknown) return {
				workable: true,
				needsVerify: true,
				reason: "Office-day cap answer is unknown; needs manual verification",
				facts: {
					...baseFacts,
					office_days_min: attendance.office_days_min,
					office_days_max: attendance.office_days_max,
					attendance_basis: "EMPLOYER_STATED"
				}
			};
			if (attendance.office_days_max > effectivePolicy.maxOfficeDaysPerWeek) return {
				workable: false,
				needsVerify: false,
				reason: "Hybrid arrangement exceeds the accepted office-day cap",
				reasonCode: "GATE_HIGH_OFFICE_DAYS",
				facts: {
					...baseFacts,
					office_days_min: attendance.office_days_min,
					office_days_max: attendance.office_days_max,
					attendance_basis: "EMPLOYER_STATED"
				}
			};
			return {
				workable: true,
				needsVerify: false,
				facts: {
					...baseFacts,
					office_days_min: attendance.office_days_min,
					office_days_max: attendance.office_days_max,
					attendance_basis: "EMPLOYER_STATED"
				}
			};
		}
		if (officeDaysAnswerUnknown) return {
			workable: true,
			needsVerify: true,
			reason: "Office-day cap answer is unknown; needs manual verification",
			facts: {
				...baseFacts,
				office_days_min: 3,
				office_days_max: 3,
				attendance_basis: "POLICY_HYBRID_3_2"
			}
		};
		if (effectivePolicy.hybridWithoutOfficeDaysAllowed) return {
			workable: true,
			needsVerify: false,
			reason: "Hybrid attendance unspecified; applied the 3 onsite / 2 WFH policy assumption",
			facts: {
				...baseFacts,
				office_days_min: 3,
				office_days_max: 3,
				attendance_basis: "POLICY_HYBRID_3_2"
			}
		};
		return {
			workable: true,
			needsVerify: true,
			reason: "Hybrid arrangement listed without explicit office-day count",
			facts: {
				...baseFacts,
				office_days_min: null,
				office_days_max: null,
				attendance_basis: "UNKNOWN"
			}
		};
	}
	const unknownWorkModeOutcome = () => {
		const facts = {
			...baseFacts,
			office_days_min: null,
			office_days_max: null,
			attendance_basis: "UNKNOWN"
		};
		switch (effectivePolicy.unknownWorkModeDisposition) {
			case "PASS": return {
				workable: true,
				needsVerify: false,
				reason: "Workplace model unspecified; accepted by configured policy",
				reasonCode: "GATE_UNKNOWN_WORK_MODE",
				facts
			};
			case "NEEDS_VERIFICATION": return {
				workable: true,
				needsVerify: true,
				reason: "Workplace model unspecified; needs manual verification",
				reasonCode: "GATE_UNKNOWN_WORK_MODE",
				facts
			};
			default: return {
				workable: false,
				needsVerify: false,
				reason: "Workplace model unspecified; rejected by owner policy",
				reasonCode: "GATE_UNKNOWN_WORK_MODE",
				facts
			};
		}
	};
	if ([
		"office based",
		"office-based",
		"in-office",
		"in office",
		"office expectations",
		"workplace arrangement",
		"workplace expectations",
		"office to be evaluated",
		"partner discussions",
		"location flexible",
		"location tbd"
	].some((c) => d.includes(c) || loc.includes(c))) return unknownWorkModeOutcome();
	if (wp === "UNKNOWN") return unknownWorkModeOutcome();
	return {
		workable: true,
		needsVerify: false,
		facts: baseFacts
	};
}
function generateContentHash(company, title, rawDesc) {
	const payload = `${(company || "").toLowerCase().trim()}|${(title || "").toLowerCase().trim()}|${(rawDesc || "").toLowerCase().trim().slice(0, 1e3)}`;
	return crypto.default.createHash("sha256").update(payload).digest("hex");
}
function makePass$1(extraFacts) {
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
			attendance_basis: "UNKNOWN",
			...extraFacts
		}
	};
}
function makeReject$1(codes, evidence, facts) {
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
			attendance_basis: "UNKNOWN",
			...facts
		}
	};
}
function makeVerification$1(codes, evidence, facts) {
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
			attendance_basis: "UNKNOWN",
			...facts
		}
	};
}
/**
* Extract a readable text corpus from a raw job (handles string, JSON-string, or object descriptions).
*/
function extractDescriptionText(job) {
	if (!job.raw_description) return "";
	if (typeof job.raw_description === "object") {
		const d = job.raw_description;
		return stripHtmlToText([
			d.job_description || "",
			...d.key_responsibilities || [],
			...d.technical_skills || [],
			...d.qualifications_education || [],
			...d.nice_to_haves || []
		].join("\n")).toLowerCase();
	}
	if (typeof job.raw_description === "string") {
		if (job.raw_description.trim().startsWith("{")) try {
			const parsed = JSON.parse(job.raw_description);
			return stripHtmlToText([
				parsed.job_description || "",
				...parsed.key_responsibilities || [],
				...parsed.technical_skills || [],
				...parsed.qualifications_education || [],
				...parsed.nice_to_haves || []
			].join("\n")).toLowerCase();
		} catch {
			return stripHtmlToText(job.raw_description).toLowerCase();
		}
		return stripHtmlToText(job.raw_description).toLowerCase();
	}
	return "";
}
/** Find the first matching snippet from the description text for an evidence quote. */
function findEvidence(d, keywords) {
	const quotes = [];
	for (const kw of keywords) {
		const idx = d.indexOf(kw);
		if (idx !== -1) {
			const start = Math.max(0, idx - 20);
			const end = Math.min(d.length, idx + kw.length + 40);
			quotes.push(`"…${d.substring(start, end)}…"`);
		}
	}
	return quotes;
}
function findNonNegatedEvidence(d, keywords) {
	const quotes = [];
	for (const kw of keywords) {
		let startPos = 0;
		while (startPos < d.length) {
			const idx = d.indexOf(kw, startPos);
			if (idx === -1) break;
			if (!isOccurrenceNegated(d, idx, kw.length)) {
				const start = Math.max(0, idx - 20);
				const end = Math.min(d.length, idx + kw.length + 40);
				quotes.push(`"…${d.substring(start, end)}…"`);
			}
			startPos = idx + kw.length;
		}
	}
	return quotes;
}
function applyGlobalGates(job, policy = loadWorkabilityPolicy(), answerContext) {
	const effectivePolicy = applyVerificationAnswerOverrides(policy, answerContext);
	const travelAnswerProvided = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.travelPercentage);
	const travelAnswerUnknown = travelAnswerProvided && answerContext?.overrides.travelPercentageCap === null;
	const workAuthorizationAnswerUnknown = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.workAuthorization) && answerContext?.overrides.workAuthorizationRegions.length === 0;
	const t = (job.title || "").toLowerCase();
	const c = (job.company_name || "").toLowerCase();
	const d = extractDescriptionText(job);
	(job.location || "").toLowerCase();
	const wp = (job.workplace_type || "").toUpperCase();
	(job.employment_type || "").toUpperCase();
	let pendingVerification = null;
	for (const pattern of GLOBAL_TITLE_EXCLUSIONS) if (pattern.test(job.title || "")) return makeReject$1(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-target title exclusion: "${job.title}"`]);
	if (/\b(?:fde|forward[- ]deployed(?:\s+engineer(?:ing)?)?)\b/i.test(`${t} ${d}`)) {
		const evidence = findNonNegatedEvidence(d, ["forward deployed", "fde"]);
		return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], evidence.length > 0 ? evidence : [`FDE role: "${job.title}"`]);
	}
	const consultancyTitle = /\b(consult(?:ant|ancy)|advis(?:er|ory))\b/i.test(t);
	const approvedTechnicalConsultancy = /\b(?:technical|technology|engineering|software|data|ai|ml|digital|transformation)\b/i.test(t) && /\b(?:engineer(?:ing)?|architect(?:ure)?|program(?:me)?|project|product|delivery|transformation)\b/i.test(t);
	if (consultancyTitle && !approvedTechnicalConsultancy) return makeReject$1(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"], [`Generic consultancy/advisory title: "${job.title}"`]);
	const workability = evaluateWorkability(job.location || "", job.workplace_type || "", d, job.employment_type || "", effectivePolicy, answerContext);
	if (!workability.workable) {
		if (workability.reasonCode === "GATE_CONTRACT_ROLE") return makeReject$1(["GATE_CONTRACT_ROLE"], [workability.reason || "Contract role is not eligible"], workability.facts);
		if (workability.reasonCode === "GATE_LOCATION_RESTRICTED") return makeReject$1(["GATE_LOCATION_RESTRICTED"], [workability.reason || "Geographic restriction detected"], workability.facts);
		if (workability.reasonCode === "GATE_UNKNOWN_WORK_MODE") return makeReject$1(["GATE_UNKNOWN_WORK_MODE"], [workability.reason || "Workplace model is unspecified"], workability.facts);
		return makeReject$1(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], [workability.reason || "Unworkable location/workplace model"], workability.facts);
	}
	const techCheck = isTechnicalRole(job.title || "", d);
	if (!techCheck.isTechnical) return makeReject$1(["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"], [techCheck.reason || "Axis 1 Failed: Role lacks evidence of technical function"]);
	if (workability.needsVerify) pendingVerification = {
		reason: workability.reason || "Workplace model unspecified; needs manual verification",
		facts: workability.facts
	};
	if (effectivePolicy.blacklistedCompanies.some((company) => c === company || c.includes(company))) return makeReject$1(["GATE_BLACKLISTED_COMPANY"], [`Company is configured as blacklisted: "${job.company_name}"`]);
	const buildingPctBefore = d.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:time\s+)?(?:spent\s+on\s+)?(?:in\s+)?(?:building|research|hands-on|implementation|technical delivery|architecture)/i);
	const buildingPctAfter = d.match(/(?:building|research|hands-on|implementation|technical delivery|architecture)\s*(?:is|:|accounts\s+for|\()\s*(\d+(?:\.\d+)?)\s*%/i);
	const buildingPct = buildingPctBefore ? Number(buildingPctBefore[1]) : buildingPctAfter ? Number(buildingPctAfter[1]) : null;
	const buildingSnippet = buildingPctBefore?.[0] ?? buildingPctAfter?.[0] ?? null;
	const interactionPctBefore = d.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:time\s+)?(?:spent\s+on\s+)?(?:in\s+)?(?:interaction|stakeholder|client-facing|client facing)/i);
	const interactionPctAfter = d.match(/(?:interaction|stakeholder|client-facing|client facing)\s*(?:is|:|accounts\s+for|\()\s*(\d+(?:\.\d+)?)\s*%/i);
	const interactionPct = interactionPctBefore ? Number(interactionPctBefore[1]) : interactionPctAfter ? Number(interactionPctAfter[1]) : null;
	const interactionSnippet = interactionPctBefore?.[0] ?? interactionPctAfter?.[0] ?? null;
	const isBuildingFailed = buildingPct !== null && buildingPct < effectivePolicy.minimumBuildingResearchPct;
	const isInteractionFailed = interactionPct !== null && interactionPct > effectivePolicy.maximumInteractionPct;
	if (isBuildingFailed && isInteractionFailed) return makeReject$1(["GATE_BUILDING_RESEARCH_RATIO", "GATE_HIGH_INTERACTION"], [buildingSnippet ?? `${buildingPct}% building`, interactionSnippet ?? `${interactionPct}% interaction`]);
	if (isBuildingFailed) return makeReject$1(["GATE_BUILDING_RESEARCH_RATIO"], [buildingSnippet ?? `${buildingPct}% building`]);
	if (isInteractionFailed) return makeReject$1(["GATE_HIGH_INTERACTION"], [interactionSnippet ?? `${interactionPct}% interaction`]);
	const travelRequirement = extractTravelRequirement(d);
	const frequentTravelEvidence = findNonNegatedEvidence(d, ["frequent travel", "travel extensively"]);
	if (travelRequirement && travelAnswerUnknown) pendingVerification = {
		reason: "Travel cap answer is unknown; needs manual verification",
		facts: { travel_pct_max: travelRequirement.max_pct }
	};
	else if (travelRequirement && travelRequirement.max_pct > effectivePolicy.maxTravelPct) return makeReject$1(["GATE_LIFESTYLE_INCOMPATIBLE"], [travelRequirement.evidence], { travel_pct_max: travelRequirement.max_pct });
	else if (frequentTravelEvidence.length > 0 && !effectivePolicy.frequentTravelAllowed && !travelAnswerProvided) return makeReject$1(["GATE_LIFESTYLE_INCOMPATIBLE"], frequentTravelEvidence, { travel_pct_max: null });
	if (/\b(human resources|hr manager|hr generalist|hr business partner|hrbp|talent acquisition|recruiter|recruitment|people ops|people operations|people partner)\b/i.test(t)) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: HR / Talent role "${job.title}"`]);
	if (/\b(executive assistant|personal assistant|office manager|administrative assistant|admin assistant|receptionist|workplace coordinator|workplace manager|facilities manager)\b/i.test(t)) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Administrative / Office Management "${job.title}"`]);
	if (/\b(attorney|associate attorney|m&a attorney|counsel|corporate counsel|legal counsel|general counsel|lawyer|paralegal|legal assistant)\b/i.test(t) && !techCheck.isTechnical) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Legal Practice / Counsel "${job.title}"`]);
	if (/\b(account executive|sales manager|sales director|business development manager|business development executive|bdr|sdr|marketing manager|marketing director|product marketing manager|growth marketing|event coordinator)\b/i.test(t) && !techCheck.isTechnical) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Sales / Marketing "${job.title}"`]);
	if (/\b(quality assurance coordinator|qa coordinator|compliance coordinator|operations coordinator|administrative coordinator|logistics coordinator)\b/i.test(t) && !techCheck.isTechnical) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Non-technical Coordinator "${job.title}"`]);
	if (/\b(private equity associate|private equity analyst|investment banking analyst|investment banking associate|m&a analyst|m&a associate|deal advisory|commercial banker|loan officer|credit underwriter)\b/i.test(t) && !techCheck.isTechnical) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-technical title: Traditional Finance / Banking "${job.title}"`]);
	for (const kw of [
		"intern",
		"internship",
		"graduate trainee",
		"apprentice",
		"apprenticeship"
	]) if (t.includes(kw)) return makeReject$1(["GATE_EXPERIENCE_TOO_LOW"], [`Title contains: "${kw}"`]);
	const hardOnsiteKw = [
		"100% onsite",
		"100% on-site",
		"5 days on-site",
		"5 days onsite",
		"5 days a week in the office",
		"5 days per week on-site",
		"5 days per week onsite",
		"5 days a week on-site",
		"mandatory 5 days",
		"on-site only",
		"onsite only",
		"4 days in office",
		"4 days a week in the office",
		"4 days on-site",
		"4 days onsite",
		"fully on-site",
		"fully onsite",
		"on-premises only"
	];
	const hardOnsiteRegex = /\b([45])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*on-?site\b/i;
	const configuredOfficeDaysRegex = new RegExp(`\\b(\\d+)\\s*days?\\s*(?:per\\s*week|a\\s*week|\\/week)?\\s*(?:in|at)?\\s*(?:the\\s*)?(?:office|on-?site)\\b`, "i");
	const configuredOfficeDaysMatch = d.match(configuredOfficeDaysRegex);
	if (configuredOfficeDaysMatch && (Number(configuredOfficeDaysMatch[1]) >= effectivePolicy.hardFailOfficeDaysPerWeek || Number(configuredOfficeDaysMatch[1]) > effectivePolicy.maxOfficeDaysPerWeek)) return makeReject$1(["GATE_HIGH_OFFICE_DAYS"], [configuredOfficeDaysMatch[0]], {
		office_days_min: Number(configuredOfficeDaysMatch[1]),
		office_days_max: Number(configuredOfficeDaysMatch[1])
	});
	const hardOnsiteKeyword = hardOnsiteKw.find((kw) => d.includes(kw));
	const hardOnsiteMatch = d.match(hardOnsiteRegex);
	const hardOnsiteDays = hardOnsiteKeyword?.match(/\b([45])\s*days?\b/i)?.[1] ?? hardOnsiteMatch?.[1];
	const hardOnsiteAllowedByAnswer = hardOnsiteDays !== void 0 && effectivePolicy.maxOfficeDaysPerWeek >= Number(hardOnsiteDays);
	if ((hardOnsiteKeyword !== void 0 || hardOnsiteMatch !== null) && !hardOnsiteAllowedByAnswer) return makeReject$1(["GATE_HIGH_OFFICE_DAYS"], findEvidence(d, [hardOnsiteKeyword ?? hardOnsiteMatch?.[0] ?? "on-site requirement"]), {
		office_days_min: 4,
		office_days_max: 5
	});
	const ambiguousOfficeKw = [
		"office based",
		"office-based",
		"in-office",
		"in office",
		"office expectations",
		"workplace arrangement",
		"workplace expectations",
		"office to be evaluated",
		"partner discussions",
		"location flexible",
		"location tbd"
	];
	const hasExplicitDays = hardOnsiteKw.some((k) => d.includes(k)) || hardOnsiteRegex.test(d) || /\b[1-5]\s*(?:day|days)\s*(?:per week|a week|\/week)?\s*(?:in|at)?\s*(?:the\s*)?office/i.test(d) || d.includes("1 day/week") || d.includes("2 days/week") || d.includes("3 days/week") || d.includes("remote-first") || d.includes("fully remote") || d.includes("work from home");
	const hasAcceptedFlexibleWorkMode = /\bhybrid\b/i.test(d) || /\b(remote|remote-first|fully remote|work from home)\b/i.test(d) || wp === "REMOTE" || wp === "HYBRID";
	if (!hasExplicitDays && ambiguousOfficeKw.some((k) => d.includes(k)) && !pendingVerification && !hasAcceptedFlexibleWorkMode) pendingVerification = {
		reason: "Workplace model ambiguous/unspecified; needs manual verification",
		facts: {
			office_days_min: null,
			office_days_max: null
		}
	};
	const authorizedRegions = new Set(effectivePolicy.authorizedRegions);
	const locationTerritories = extractTerritories(String(job.location || ""));
	const descriptionTerritories = extractTerritories(d);
	const disallowedTerritories = effectivePolicy.rejectExplicitForeignTerritory ? [...locationTerritories, ...descriptionTerritories.filter((territory) => hasExplicitTerritoryRestriction(d, territory))].filter((territory) => authorizedRegions.size === 0 || !authorizedRegions.has(territory)) : [];
	if (disallowedTerritories.length > 0) {
		const territory = disallowedTerritories[0];
		if (!workAuthorizationAnswerUnknown) return makeReject$1(["GATE_LOCATION_RESTRICTED"], [`Explicit work territory restriction: ${territory}`], { location_restriction: territory });
		pendingVerification = {
			reason: `Work authorization for ${territory} is unknown; needs manual verification`,
			facts: { location_restriction: territory }
		};
	}
	for (const kw of [
		"shift work",
		"on-call rotation",
		"regular on-call",
		"24/7 support",
		"travel extensively",
		"frequent travel",
		"up to 50% travel",
		"up to 25% travel"
	]) if (d.includes(kw)) {
		const isShiftConflict = ["shift work"].includes(kw) && !effectivePolicy.shiftWorkAllowed;
		const isOnCallConflict = [
			"on-call rotation",
			"regular on-call",
			"24/7 support"
		].includes(kw) && !effectivePolicy.regularOnCallAllowed;
		const isTravelConflict = [
			"travel extensively",
			"frequent travel",
			"up to 50% travel",
			"up to 25% travel"
		].includes(kw) && !effectivePolicy.frequentTravelAllowed;
		if (!isShiftConflict && !isOnCallConflict && !isTravelConflict) continue;
		const evidence = findNonNegatedEvidence(d, [kw]);
		if (evidence.length === 0) continue;
		const travelPct = kw.includes("50%") ? 50 : kw.includes("25%") ? 25 : null;
		const hasTravelAnswer = answerContext?.overrides.travelPercentageCap !== null && answerContext?.overrides.travelPercentageCap !== void 0 || isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.travelPercentage);
		if (hasTravelAnswer && travelPct === null) {
			pendingVerification = {
				reason: "Travel expectation is stated without a deterministic percentage; needs manual verification",
				facts: { travel_pct_max: null }
			};
			continue;
		}
		if (hasTravelAnswer && travelPct !== null) continue;
		return makeReject$1(["GATE_LIFESTYLE_INCOMPATIBLE"], evidence, { travel_pct_max: travelPct });
	}
	for (const kw of [
		"sales engineering",
		"presales",
		"pre-sales",
		"client relationship management",
		"manage large teams",
		"escalations manager"
	]) if (d.includes(kw) && !effectivePolicy.externalClientPrimaryAllowed) {
		const evidence = findNonNegatedEvidence(d, [kw]);
		if (evidence.length === 0) continue;
		return makeReject$1(["GATE_HIGH_INTERACTION"], evidence);
	}
	const hardwareStrictTitle = [
		"hardware",
		"hardware architect",
		"gpu hardware",
		"gpu architect",
		"infrastructure data center",
		"sre",
		"site reliability",
		"construction"
	];
	const hardwareStrictDesc = [
		"hardware engineering",
		"infrastructure data center",
		"data center construction",
		"construction project"
	];
	for (const kw of hardwareStrictTitle) if (t.includes(kw)) return makeReject$1(["GATE_HARDWARE_INFRASTRUCTURE"], [`Title contains: "${kw}"`]);
	for (const kw of hardwareStrictDesc) if (d.includes(kw)) return makeReject$1(["GATE_HARDWARE_INFRASTRUCTURE"], findEvidence(d, [kw]));
	const fdeKw = ["forward deployed", "fde "];
	if (t.includes("fde") || fdeKw.some((k) => t.includes(k) || d.includes(k))) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], findEvidence(d, fdeKw));
	for (const firm of [
		"accenture",
		"kpmg",
		"bcg",
		"mckinsey",
		"bain",
		"deloitte",
		"pwc",
		"ernst & young",
		"pricewaterhousecoopers",
		"boston consulting group"
	]) if (c.includes(firm)) return makeReject$1(["GATE_CONSULTING_FIRM"], [`Company name: "${firm}"`]);
	if (c === "ey" || c === "ey pte ltd" || c.startsWith("ey ") || c.endsWith(" ey") || c.includes(" ey ")) return makeReject$1(["GATE_CONSULTING_FIRM"], [`Company name matches EY`]);
	const outsourcingKw = [
		"deployed to client",
		"work for our clients",
		"hired resource"
	];
	if (c.includes("red hat") || outsourcingKw.some((k) => d.includes(k))) return makeReject$1(["GATE_OUTSOURCING"], c.includes("red hat") ? [`Company: "red hat"`] : findEvidence(d, outsourcingKw.filter((k) => d.includes(k))));
	const contractKw = [
		"contract",
		"contractor",
		"temp",
		"temporary",
		"freelance"
	];
	if ([
		"recruitment",
		"recruiting",
		"staffing",
		"talent acquisition",
		"hays",
		"randstad",
		"pagegroup",
		"michael page",
		"adecco",
		"charterhouse",
		"huxley",
		"robert half",
		"robert walters",
		"kelly services",
		"monroe consulting",
		"recruit"
	].some((kw) => c.includes(kw)) || d.includes("on behalf of our client") || d.includes("our client is looking for") || d.includes("hiring for our client")) {
		if (contractKw.some((kw) => t.includes(kw) || d.includes(kw)) || d.includes("renewable")) return makeReject$1(["GATE_CONTRACT_ROLE"], [`Agency posting with contract terms`]);
	}
	for (const kw of contractKw) if (t.includes(kw) && !t.includes("permanent contract") && !d.includes("permanent contract")) return makeReject$1(["GATE_CONTRACT_ROLE"], [`Title contains: "${kw}"`]);
	for (const kw of [
		"manage large teams",
		"manage client teams",
		"manage client expectations",
		"client relationship management"
	]) if (d.includes(kw) && !effectivePolicy.peopleManagementPrimaryAllowed) return makeReject$1(["GATE_HEAVY_MANAGEMENT"], findEvidence(d, [kw]));
	let rolesCount = 0;
	if (d.includes("project manager") || d.includes("scrum master") || d.includes("project management")) rolesCount++;
	if (d.includes("people manager") || d.includes("people management") || d.includes("line manager")) rolesCount++;
	if (d.includes("client manager") || d.includes("delivery manager") || d.includes("account manager")) rolesCount++;
	if (d.includes("architect") || d.includes("architecture")) rolesCount++;
	if (d.includes("developer") || d.includes("engineer")) rolesCount++;
	if (rolesCount >= 4) return makeReject$1(["GATE_KITCHEN_SINK"], [`Role combines ${rolesCount} distinct function types`]);
	for (const kw of [
		"zero hands-on",
		"zero technical work",
		"steering committees",
		"vendor steering",
		"political change management"
	]) if (d.includes(kw) || t.includes(kw)) return makeReject$1(["GATE_PURE_GOVERNANCE_ZERO_BUILD"], findEvidence(d, [kw]));
	for (const kw of [
		"payments",
		"merchant acquiring",
		"remittance",
		"bnpl",
		"buy now pay later",
		"consumer lending",
		"card issuing",
		"credit card",
		"pos terminals"
	]) if (t.includes(kw)) return makeReject$1(["GATE_OUT_OF_SCOPE_DOMAIN"], [`Universal negative domain in title: "${kw}"`]);
	const aiDataShortRegex = /\b(?:ai|ml|nlp|llm|rag)\b/i;
	if (!(aiDataShortRegex.test(t) || aiDataShortRegex.test(d) || [
		"artificial intelligence",
		"machine learning",
		"data engineering",
		"data pipeline",
		"data warehouse",
		"etl",
		"sql",
		"quantitative",
		"quantitative research",
		"time-series",
		"time series",
		"portfolio analytics",
		"algorithmic trading",
		"market microstructure",
		"trading systems",
		"fintech",
		"order book",
		"computational biology",
		"bioinformatics",
		"cheminformatics",
		"genomics",
		"drug discovery",
		"clinical trial",
		"regtech",
		"legaltech",
		"fraud detection",
		"kyc",
		"aml",
		"compliance automation",
		"contract analytics",
		"digital trust",
		"deep learning",
		"agentic",
		"market data",
		"trading infrastructure",
		"software development",
		"software platform",
		"data science",
		"data analytics",
		"business intelligence",
		"data platform",
		"data architecture",
		"technology transformation",
		"digital transformation",
		"data transformation",
		"technical program",
		"technical project",
		"cloud",
		"cloud infrastructure",
		"cloud architecture",
		"solutions architect",
		"enterprise architect",
		"cloud architect",
		"microservices",
		"software architecture",
		"technical delivery",
		"techno-functional",
		"devops",
		"platform engineering",
		"engineering delivery",
		"systems architecture",
		"hands-on architecture",
		"technical discovery",
		"hands-on engineering",
		"technical transformation",
		"engineering transformation",
		"devops modernization",
		"cloud migration",
		"technical deployment",
		"technical client deployment",
		"systems engineering",
		"systems engineer",
		"data engineer",
		"data scientist",
		"data platform",
		"lakehouse",
		"ai engineer",
		"ml engineer",
		"machine learning engineer",
		"high-throughput",
		"core infrastructure"
	].some((kw) => t.includes(kw) || d.includes(kw)))) {
		if (pendingVerification) return makeVerification$1(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"], [pendingVerification.reason], pendingVerification.facts);
		return makeReject$1(["GATE_NOT_AI_DATA"], ["Axis 2 Failed: No signal found for target domains (AI/Data, RegTech, Bio/Pharma, Quant/FinTech)"]);
	}
	if (pendingVerification) return makeVerification$1(["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"], [pendingVerification.reason], pendingVerification.facts);
	return makePass$1(workability.facts);
}
function classifyDescriptionQuality(value) {
	const text = String(value ?? "").trim();
	if (text.length === 0) return {
		status: "UNKNOWN",
		reason: "DESCRIPTION_MISSING"
	};
	if (text.length < 1e3) return {
		status: "INCOMPLETE",
		reason: "DESCRIPTION_BELOW_1000_CHAR_COMPLETENESS_FLOOR"
	};
	return {
		status: "COMPLETE",
		reason: null
	};
}
//#endregion
//#region src/pipeline/normalize.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$10 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
async function runNormalization(clientOrPool, options) {
	console.log("Starting normalization of raw_job_observations...");
	const pool = clientOrPool || defaultPool$10;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	const ctx = options?.context ?? await resolveWorkspaceContext(client);
	const params = [ctx.workspaceId];
	const observationIds = options?.observationIds?.filter(Boolean) ?? [];
	const observationFilter = observationIds.length > 0 ? `AND obs.id = ANY($${params.push(observationIds)}::uuid[])` : "";
	const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0 ? Number(options?.limit) : null;
	const query = `
    SELECT obs.*
    FROM raw_job_observations obs
    WHERE obs.workspace_id = $1
      AND obs.job_version_id IS NULL
      AND COALESCE(obs.processing_status, 'PENDING') = 'PENDING'
      ${observationFilter}
    ORDER BY obs.retrieved_at ASC, obs.id ASC
    ${limit ? `LIMIT $${params.push(limit)}` : ""}
  `;
	const { rows: pendingObservations } = await client.query(query, params);
	console.log(`Found ${pendingObservations.length} pending observations.`);
	const summary = {
		totalDiscovered: pendingObservations.length,
		totalProcessed: 0,
		totalErrors: 0,
		details: []
	};
	try {
		for (const obs of pendingObservations) {
			await client.query("BEGIN");
			try {
				const normalizedContentHash = generateContentHash(obs.company_name, obs.title, obs.description_raw);
				let canonicalJobId = null;
				let isExistingJob = false;
				const checkExt = await client.query(`SELECT jv.canonical_job_id, jv.id AS job_version_id
           FROM raw_job_observations rjo
           JOIN job_versions jv ON jv.id = rjo.job_version_id
           WHERE rjo.workspace_id = $1
             AND jv.workspace_id = $1
             AND rjo.source_name = $2
             AND rjo.source_external_id = $3
           ORDER BY rjo.retrieved_at DESC
           LIMIT 1`, [
					ctx.workspaceId,
					obs.source_name,
					obs.source_external_id
				]);
				let existingVersionId = null;
				if (checkExt.rows.length > 0) {
					canonicalJobId = checkExt.rows[0].canonical_job_id;
					isExistingJob = true;
				} else {
					const checkUrl = await client.query(`SELECT id FROM canonical_jobs
             WHERE workspace_id = $1
               AND canonical_url = $2
             LIMIT 1`, [ctx.workspaceId, obs.canonical_apply_url || obs.source_url]);
					if (checkUrl.rows.length > 0) {
						canonicalJobId = checkUrl.rows[0].id;
						isExistingJob = true;
					} else {
						const checkTitleLocation = await client.query(`SELECT id FROM canonical_jobs
               WHERE workspace_id = $1
                 AND company_name = $2
                 AND normalized_title = $3
                 AND COALESCE(location, location_summary, 'Unknown') = $4
               LIMIT 1`, [
							ctx.workspaceId,
							obs.company_name,
							obs.title.toLowerCase(),
							obs.location_raw || "Unknown"
						]);
						if (checkTitleLocation.rows.length > 0) {
							canonicalJobId = checkTitleLocation.rows[0].id;
							isExistingJob = true;
						}
					}
				}
				if (!canonicalJobId) {
					const descriptionQuality = classifyDescriptionQuality(obs.description_raw);
					canonicalJobId = (await client.query(`INSERT INTO canonical_jobs (
               workspace_id,
               company_name, normalized_title, canonical_url, location, 
               workplace_type, employment_type, processing_state, processing_status,
               description_quality_status, description_quality_reason, version_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1) RETURNING id`, [
						ctx.workspaceId,
						obs.company_name,
						obs.title.toLowerCase(),
						obs.source_url,
						obs.location_raw || "Unknown",
						obs.workplace_type_raw || "UNKNOWN",
						obs.employment_type_raw || "UNKNOWN",
						"RAW_STAGED",
						"RAW_STAGED",
						descriptionQuality.status,
						descriptionQuality.reason
					])).rows[0].id;
				}
				if (!existingVersionId) existingVersionId = (await client.query(`SELECT id
             FROM job_versions
             WHERE workspace_id = $1
               AND canonical_job_id = $2
               AND content_hash = $3
             LIMIT 1`, [
					ctx.workspaceId,
					canonicalJobId,
					normalizedContentHash
				])).rows[0]?.id || null;
				let resolvedVersionId = existingVersionId;
				let createdNewVersion = false;
				if (!resolvedVersionId) {
					resolvedVersionId = (await client.query(`INSERT INTO job_versions (workspace_id, canonical_job_id, content_hash, description_text, observed_at)
             VALUES ($1, $2, $3, $4, NOW()) RETURNING id`, [
						ctx.workspaceId,
						canonicalJobId,
						normalizedContentHash,
						obs.description_raw
					])).rows[0].id;
					createdNewVersion = true;
				}
				if (createdNewVersion) {
					const descriptionQuality = classifyDescriptionQuality(obs.description_raw);
					const existingRow = (await client.query(`SELECT c.latest_job_version_id,
                    c.description_quality_status,
                    LENGTH(COALESCE(jv.description_text, '')) AS existing_desc_len
             FROM canonical_jobs c
             LEFT JOIN job_versions jv
               ON jv.workspace_id = c.workspace_id
              AND jv.id = c.latest_job_version_id
             WHERE c.workspace_id = $1
               AND c.id = $2
             LIMIT 1`, [ctx.workspaceId, canonicalJobId])).rows[0];
					const isNewVersionInferior = (existingRow?.description_quality_status === "COMPLETE" || (existingRow?.existing_desc_len ?? 0) >= 1e3) && descriptionQuality.status === "INCOMPLETE";
					const versionToSetAsLatest = isNewVersionInferior && existingRow?.latest_job_version_id ? existingRow.latest_job_version_id : resolvedVersionId;
					const statusToSet = isNewVersionInferior ? "COMPLETE" : descriptionQuality.status;
					const reasonToSet = isNewVersionInferior ? null : descriptionQuality.reason;
					await client.query(`UPDATE canonical_jobs
             SET latest_job_version_id = $1,
                 version_count = CASE
                   WHEN $2::boolean THEN COALESCE(version_count, 0) + 1
                   ELSE GREATEST(COALESCE(version_count, 0), 1)
                 END,
                 location = CASE WHEN NULLIF($3, 'Unknown') IS NULL THEN location ELSE $3 END,
                 workplace_type = CASE WHEN NULLIF($4, 'UNKNOWN') IS NULL THEN workplace_type ELSE $4 END,
                 employment_type = CASE WHEN NULLIF($5, 'UNKNOWN') IS NULL THEN employment_type ELSE $5 END,
                 description_quality_status = $8,
                 description_quality_reason = $9,
                 processing_state = CASE
                   WHEN $10::boolean THEN processing_state
                   ELSE 'RAW_STAGED'
                 END,
                 processing_status = CASE
                   WHEN $10::boolean THEN processing_status
                   ELSE 'RAW_STAGED'
                 END,
                 updated_at = NOW()
             WHERE workspace_id = $6
               AND id = $7`, [
						versionToSetAsLatest,
						isExistingJob,
						obs.location_raw || "Unknown",
						obs.workplace_type_raw || "UNKNOWN",
						obs.employment_type_raw || "UNKNOWN",
						ctx.workspaceId,
						canonicalJobId,
						statusToSet,
						reasonToSet,
						isNewVersionInferior
					]);
				}
				if (obs.id) await client.query(`UPDATE raw_job_observations
             SET job_version_id = $1, processing_status = 'PROCESSED'
             WHERE workspace_id = $2 AND id = $3`, [
					resolvedVersionId,
					ctx.workspaceId,
					obs.id
				]);
				await client.query("COMMIT");
				summary.totalProcessed++;
				summary.details.push({
					observationId: obs.id,
					canonicalJobId: canonicalJobId || void 0,
					versionId: resolvedVersionId || void 0,
					isNewJob: !isExistingJob
				});
			} catch (err) {
				await client.query("ROLLBACK");
				console.error(`❌ Failed to normalize observation ${obs.id}:`, err);
				summary.totalErrors++;
				summary.details.push({
					observationId: obs.id,
					isNewJob: false,
					error: err.message || String(err)
				});
			}
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
	console.log(`Normalization complete. Processed: ${summary.totalProcessed}, Errors: ${summary.totalErrors}`);
	return summary;
}
//#endregion
//#region src/contracts/version.ts
var SCHEMA_VERSION = "2.2.0";
var schemaVersions = [SCHEMA_VERSION, ...["2.0", "1.0.0"]];
var SchemaVersionSchema = zod.z.enum(schemaVersions);
var GATE_VERSION = SCHEMA_VERSION;
//#endregion
//#region src/requirements/contracts.ts
/**
* Job requirements contracts
* @description Zod schemas for requirement extraction, validation, and matching
* @version 2.2.0
*/
var REQUIREMENTS_SCHEMA_VERSION = SCHEMA_VERSION;
var RequirementTypeSchema = zod.z.enum([
	"OFFICE_DAYS",
	"WORK_MODE",
	"EXPERIENCE_YEARS",
	"CREDENTIAL",
	"DEGREE",
	"EMPLOYMENT_TYPE",
	"TRAVEL",
	"WORK_AUTH",
	"ON_CALL",
	"SHIFT_WORK",
	"DOMAIN",
	"FUNCTION",
	"CUSTOM"
]);
var RequirementImportanceSchema = zod.z.enum([
	"MUST",
	"PREFERRED",
	"NICE_TO_HAVE"
]);
var ExtractorTypeSchema = zod.z.enum(["DETERMINISTIC", "LLM_QUOTED"]);
var RequirementStatusSchema = zod.z.enum([
	"EXTRACTED",
	"VALIDATED",
	"REJECTED"
]);
var PipelineStageSchema = zod.z.enum([
	"NORMALIZED",
	"REQUIREMENTS_EXTRACTED",
	"GATE_EVALUATED",
	"LANE_ROUTED",
	"QUEUED_FOR_AI",
	"EVALUATING",
	"EVALUATED",
	"DOCUMENT_READY"
]);
var PipelineStageStatusSchema = zod.z.enum([
	"PENDING",
	"IN_PROGRESS",
	"COMPLETED",
	"RETRY_WAIT",
	"NEEDS_MANUAL_REVIEW",
	"FAILED"
]);
var JobRequirementSchema = zod.z.object({
	id: zod.z.string().uuid().optional(),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	requirement_key: zod.z.string().regex(/^R-[0-9]{3}$/),
	requirement_type: RequirementTypeSchema,
	importance: RequirementImportanceSchema,
	requirement_text: zod.z.string().min(5).max(4e3),
	quote_text: zod.z.string().min(5).max(4e3).nullable().optional(),
	quote_start_offset: zod.z.number().int().min(0).nullable().optional(),
	quote_end_offset: zod.z.number().int().min(0).nullable().optional(),
	structured_value: zod.z.record(zod.z.unknown()).nullable().optional(),
	extractor_type: ExtractorTypeSchema,
	extractor_version: zod.z.string().min(1).max(50),
	confidence: zod.z.number().min(0).max(1),
	status: RequirementStatusSchema.default("EXTRACTED"),
	created_at: zod.z.date().optional()
});
zod.z.object({
	id: zod.z.string().uuid().optional(),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	run_type: ExtractorTypeSchema,
	provider: zod.z.string().max(100).nullable().optional(),
	model: zod.z.string().max(100).nullable().optional(),
	status: zod.z.enum([
		"STARTED",
		"COMPLETED",
		"FAILED"
	]),
	error_message: zod.z.string().max(4e3).nullable().optional(),
	requirements_extracted: zod.z.number().int().min(0).default(0),
	response_payload: zod.z.record(zod.z.unknown()).nullable().optional(),
	started_at: zod.z.date().optional(),
	completed_at: zod.z.date().nullable().optional()
});
zod.z.object({
	id: zod.z.string().uuid().optional(),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	current_stage: PipelineStageSchema,
	stage_status: PipelineStageStatusSchema,
	attempt_count: zod.z.number().int().min(0).default(0),
	last_error: zod.z.string().max(4e3).nullable().optional(),
	next_retry_at: zod.z.date().nullable().optional(),
	created_at: zod.z.date().optional(),
	updated_at: zod.z.date().optional()
});
zod.z.object({
	id: zod.z.string().uuid().optional(),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	stage: PipelineStageSchema,
	transition_from: PipelineStageStatusSchema.nullable().optional(),
	transition_to: PipelineStageStatusSchema,
	event_type: zod.z.enum([
		"STAGE_ENTERED",
		"STAGE_COMPLETED",
		"STAGE_FAILED",
		"RETRY_SCHEDULED"
	]),
	error_message: zod.z.string().max(4e3).nullable().optional(),
	payload: zod.z.record(zod.z.unknown()).nullable().optional(),
	created_at: zod.z.date().optional()
});
var QuotedRequirementSchema = zod.z.object({
	requirement_key: zod.z.string().regex(/^R-[0-9]{3}$/),
	requirement_type: RequirementTypeSchema,
	importance: RequirementImportanceSchema,
	requirement_text: zod.z.string().min(5).max(4e3),
	quote_text: zod.z.string().min(5).max(4e3),
	quote_start_offset: zod.z.number().int().min(0).optional(),
	quote_end_offset: zod.z.number().int().min(0).optional(),
	structured_value: zod.z.record(zod.z.unknown()).optional(),
	confidence: zod.z.number().min(0).max(1)
});
var QuotedRequirementExtractorResponseSchema = zod.z.object({
	schema_version: SchemaVersionSchema.default(REQUIREMENTS_SCHEMA_VERSION),
	requirements: zod.z.array(QuotedRequirementSchema).min(1).max(25)
});
//#endregion
//#region src/requirements/deterministicExtractors.ts
var EXTRACTOR_VERSION = "deterministic_v3";
var MIN_QUOTE_LENGTH = 5;
function isQuoteBoundary(char) {
	return /[\s<>"'.,;:()[\]{}]/.test(char);
}
function trimMatch(description, start, end) {
	const raw = description.slice(start, end);
	const leading = raw.match(/^\s*/)?.[0].length ?? 0;
	const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
	const quoteStart = start + leading;
	const quoteEnd = end - trailing;
	const quote = description.slice(quoteStart, quoteEnd);
	if (!quote) return null;
	return {
		quote_text: quote,
		quote_start_offset: quoteStart,
		quote_end_offset: quoteEnd
	};
}
function expandShortMatch(description, start, end) {
	let expandedStart = start;
	let expandedEnd = end;
	let best = trimMatch(description, expandedStart, expandedEnd);
	const consumeRightToken = () => {
		while (expandedEnd < description.length && isQuoteBoundary(description[expandedEnd])) expandedEnd += 1;
		while (expandedEnd < description.length && !isQuoteBoundary(description[expandedEnd])) expandedEnd += 1;
	};
	const consumeLeftToken = () => {
		while (expandedStart > 0 && isQuoteBoundary(description[expandedStart - 1])) expandedStart -= 1;
		while (expandedStart > 0 && !isQuoteBoundary(description[expandedStart - 1])) expandedStart -= 1;
	};
	while (best && best.quote_text.length < MIN_QUOTE_LENGTH && (expandedStart > 0 || expandedEnd < description.length)) {
		const beforeStart = expandedStart;
		const beforeEnd = expandedEnd;
		consumeRightToken();
		best = trimMatch(description, expandedStart, expandedEnd);
		if (best && best.quote_text.length >= MIN_QUOTE_LENGTH) break;
		consumeLeftToken();
		best = trimMatch(description, expandedStart, expandedEnd);
		if (beforeStart === expandedStart && beforeEnd === expandedEnd) break;
	}
	return best;
}
function findFirstMatch(description, patterns) {
	for (const pattern of patterns) {
		const match = description.match(pattern);
		if (!match || typeof match.index !== "number") continue;
		const start = match.index;
		const end = start + match[0].length;
		const matchInfo = match[0].trim().length < MIN_QUOTE_LENGTH ? expandShortMatch(description, start, end) : trimMatch(description, start, end);
		if (!matchInfo || matchInfo.quote_text.length < MIN_QUOTE_LENGTH) continue;
		return matchInfo;
	}
	return null;
}
function isContractEmploymentFalsePositive(description, match) {
	const start = Math.max(0, match.quote_start_offset - 24);
	const end = Math.min(description.length, match.quote_end_offset + 48);
	const window = description.slice(start, end).toLowerCase();
	return [
		"smart contract",
		"smart contracts",
		"contract analysis",
		"contract analytics",
		"contract management",
		"contract automation",
		"contract intelligence",
		"contract lifecycle",
		"contracts analysis",
		"contracts analytics",
		"contract review"
	].some((p) => window.includes(p));
}
function findEmploymentTypeMatch(description) {
	const contractStrong = findFirstMatch(description, [
		/\bcontract[- ]to[- ]hire\b/i,
		/\b(\d{1,2})\s*(?:month|months|mo|week|weeks|wk|day|days)\s+contract\b/i,
		/\bcontract\s+(?:role|position|assignment|opportunity)\b/i,
		/\bfixed[- ]term\b/i,
		/\btemporary\b/i
	]);
	if (contractStrong && !isContractEmploymentFalsePositive(description, contractStrong)) return {
		match: contractStrong,
		employmentType: "CONTRACT"
	};
	const fullTime = findFirstMatch(description, [
		/\bfull[- ]?time\b/i,
		/\bpermanent\b/i,
		/\bfte\b/i
	]);
	if (fullTime) return {
		match: fullTime,
		employmentType: "FULL_TIME"
	};
	const partTime = findFirstMatch(description, [/\bpart[- ]?time\b/i]);
	if (partTime) return {
		match: partTime,
		employmentType: "PART_TIME"
	};
	const contractWeak = findFirstMatch(description, [/\bcontractor\b/i, /\bcontract\b/i]);
	if (contractWeak && !isContractEmploymentFalsePositive(description, contractWeak)) return {
		match: contractWeak,
		employmentType: "CONTRACT"
	};
	return null;
}
function normalizeQuoteEvidence(quote) {
	if (quote.quote_text.trim().length < MIN_QUOTE_LENGTH) return {
		quote_text: null,
		quote_start_offset: null,
		quote_end_offset: null
	};
	return {
		quote_text: quote.quote_text,
		quote_start_offset: quote.quote_start_offset,
		quote_end_offset: quote.quote_end_offset
	};
}
function buildRequirement(input, sequence, type, requirementText, quote, structuredValue, confidence = .98) {
	const evidence = normalizeQuoteEvidence(quote);
	const importance = inferClauseImportance(input.description_text, quote.quote_start_offset, quote.quote_end_offset);
	return JobRequirementSchema.parse({
		canonical_job_id: input.canonical_job_id,
		job_version_id: input.job_version_id,
		requirement_key: `R-${String(sequence).padStart(3, "0")}`,
		requirement_type: type,
		importance,
		requirement_text: requirementText,
		quote_text: evidence.quote_text,
		quote_start_offset: evidence.quote_start_offset,
		quote_end_offset: evidence.quote_end_offset,
		structured_value: structuredValue,
		extractor_type: "DETERMINISTIC",
		extractor_version: EXTRACTOR_VERSION,
		confidence
	});
}
function extractDeterministicRequirements(input) {
	const description = input.description_text;
	const requirements = [];
	const warnings = [];
	let sequence = 1;
	const officeDays = findFirstMatch(description, [/\b([1-5])\s*days?\s*(?:a|per|\/)?\s*week\s*(?:in|on)?\s*(?:the)?\s*(?:office|on[- ]?site)\b/i, /\b(?:office|on[- ]?site)\s*[\w\s]{0,30}?\b([1-5])\s*days?\b/i]);
	if (officeDays) {
		const dayMatch = officeDays.quote_text.match(/([1-5])/);
		const days = dayMatch ? Number(dayMatch[1]) : null;
		requirements.push(buildRequirement(input, sequence++, "OFFICE_DAYS", "Role requires a specific number of in-office days per week.", officeDays, { office_days_per_week: days }));
	}
	const workMode = findFirstMatch(description, [/\b(fully\s+on[- ]?site|100%\s+on[- ]?site|on[- ]?site\s+only|remote\s+first|hybrid)\b/i]);
	if (workMode) requirements.push(buildRequirement(input, sequence++, "WORK_MODE", "Role specifies a work-mode requirement.", workMode, { mode: workMode.quote_text.toUpperCase() }));
	const numericExperienceYears = findFirstMatch(description, [/\b(?:(?:at\s+least|minimum(?:\s+of)?|a\s+minimum\s+of)\s+)?\d{1,2}(?:\s*[-–]\s*\d{1,2})?\+?(?:\s+additional)?\s*(?:years|yrs)\s+(?:of\s+)?(?:[a-z][\w/&.+-]*\s+){0,8}experience\b/i]);
	const writtenExperienceYears = findFirstMatch(description, [/\b(?:(?:at\s+least|minimum(?:\s+of)?|a\s+minimum\s+of)\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:years|yrs)\s+(?:of\s+)?(?:[a-z][\w/&.+-]*\s+){0,8}experience\b/i]);
	const experienceYears = numericExperienceYears ?? writtenExperienceYears;
	if (experienceYears) {
		const yearsMatch = experienceYears.quote_text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
		const years = yearsMatch ? /^\d+$/.test(yearsMatch[1]) ? Number(yearsMatch[1]) : {
			one: 1,
			two: 2,
			three: 3,
			four: 4,
			five: 5,
			six: 6,
			seven: 7,
			eight: 8,
			nine: 9,
			ten: 10
		}[yearsMatch[1].toLowerCase()] ?? null : null;
		const experienceScope = experienceYears.quote_text.match(/\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*[-–]\s*(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten))?\+?(?:\s+additional)?\s*(?:years|yrs)\s+(?:of\s+)?(.+?)\s+experience\b/i)?.[1]?.trim().replace(/[,:;]+$/, "").replace(/^of\s*$/i, "") || null;
		requirements.push(buildRequirement(input, sequence++, "EXPERIENCE_YEARS", "Role requires minimum years of experience.", experienceYears, {
			minimum_years: years,
			...experienceScope ? { experience_scope: experienceScope } : {}
		}));
	}
	const degree = findFirstMatch(description, [/\b(?:bachelor(?:'s)?|master(?:'s)?|phd|doctorate|doctoral)(?:\s+degree)?(?:\s+in\s+[^.;\n]{1,100})?/i, /\bdegree\s+in\s+[^.;\n]{1,100}/i]);
	if (degree) requirements.push(buildRequirement(input, sequence++, "DEGREE", "Role requires a degree qualification.", degree, { degree_reference: degree.quote_text }));
	const credential = findFirstMatch(description, [/\b(CFA|CPA|CISSP|PMP|AWS\s+Certified|certification\s+required|license\s+required)\b/i]);
	if (credential) requirements.push(buildRequirement(input, sequence++, "CREDENTIAL", "Role requires a credential or certification.", credential, { credential_reference: credential.quote_text }));
	const employmentMatch = findEmploymentTypeMatch(description);
	if (employmentMatch) requirements.push(buildRequirement(input, sequence++, "EMPLOYMENT_TYPE", "Role specifies an employment type.", employmentMatch.match, { employment_type: employmentMatch.employmentType }));
	const travel = findFirstNonNegatedMatch(description, [/\bup\s+to\s+(\d{1,2})%\s+travel\b/i, /\bfrequent\s+travel\b/i]);
	if (travel) {
		const pctMatch = travel.quote_text.match(/(\d{1,2})%/);
		requirements.push(buildRequirement(input, sequence++, "TRAVEL", "Role includes travel expectations.", travel, { max_travel_pct: pctMatch ? Number(pctMatch[1]) : null }));
	}
	const workAuth = findFirstMatch(description, [/\b(work\s+authorization|work\s+rights|authorized\s+to\s+work|no\s+sponsorship)\b/i]);
	if (workAuth) requirements.push(buildRequirement(input, sequence++, "WORK_AUTH", "Role requires a specific work authorization status.", workAuth, { policy: workAuth.quote_text }));
	const onCall = findFirstNonNegatedMatch(description, [/\b(on[- ]?call\s+rotation|regular\s+on[- ]?call|24\/7\s+support)\b/i]);
	if (onCall) requirements.push(buildRequirement(input, sequence++, "ON_CALL", "Role includes on-call operations responsibility.", onCall, { on_call_required: true }));
	const shiftWork = findFirstNonNegatedMatch(description, [/\b(shift\s+work|rotating\s+shifts|night\s+shift)\b/i]);
	if (shiftWork) requirements.push(buildRequirement(input, sequence++, "SHIFT_WORK", "Role includes shift-based scheduling requirements.", shiftWork, { shift_work_required: true }));
	let functionRequirement = findFirstMatch(description, [
		/\b(?:director|head|vp|vice\s+president)\s+of\s+(?:engineering|technology|software|data(?:\s+(?:science|engineering|platform|analytics|architecture))?|analytics?|ai|ml|platform|cloud|systems?|digital|transformation|research|science)\b/i,
		/\b(?:engineering|technology|software|data|analytics?|ai|ml|digital|transformation)\s+(?:program|programme|project|portfolio|delivery|transformation)\s+(?:manager|director|lead|head|officer|vp|vice\s+president)\b/i,
		/\b(?:engineering|technology|software|data(?:\s+(?:science|engineering|platform|analytics|architecture))?|analytics?|ai|ml|platform|cloud|systems?|digital|transformation|research|science)\s+(?:manager|director|lead|head|officer|vp|vice\s+president)\b/i,
		/\b(?:machine\s+learning\s+engineer|ml\s+engineer|data\s+engineer|data\s+(?:pipeline|platform|warehouse|etl)\s+(?:engineer|developer|architect|associate|analyst|specialist)|(?:sql\s+)?etl\s+(?:engineer|developer|associate|analyst|specialist)|data\s+warehouse\s+(?:engineer|developer|associate|analyst|specialist)|platform\s+engineer|software\s+engineer|ai\s+engineer|research\s+scientist|(?:data|ai|ml|lead|principal|chief)\s+scientist|quant(?:itative)?\s+(?:engineer|developer|researcher)|bioinformatics\s+engineer|systems\s+architect|ai\s+architect|software\s+developer|full[\s-]stack\s+developer|backend\s+developer|frontend\s+developer|data\s+scientist|data\s+architect|research\s+engineer|research\s+software\s+engineer)\b/i
	]);
	if (!functionRequirement && /\b(?:project|program|programme|portfolio|delivery)\s+(?:manager|director|lead|head)\b/i.test(description) && /\b(?:software|data|analytics?|ai|ml|machine\s+learning|technology|technical|engineering|platform|cloud|digital|transformation|systems?)\b/i.test(description)) functionRequirement = findFirstMatch(description, [/\b(?:project|program|programme|portfolio|delivery)\s+(?:manager|director|lead|head)\b/i]);
	if (functionRequirement) {
		const normalized = functionRequirement.quote_text.toUpperCase().replace(/\s+/g, "_");
		requirements.push(buildRequirement(input, sequence++, "FUNCTION", "Role includes a technical function requirement.", functionRequirement, { function_key: normalized }));
	}
	const domainRequirement = findFirstMatch(description, [/\b(machine\s+learning|artificial\s+intelligence|ai\b|llm|nlp|data\s+platform|data\s+pipeline|data\s+engineering|data\s+warehouse|sql\s+etl|etl|regtech|legaltech|compliance\s+automation|bioinformatics|genomics|biotech|pharma|quant(?:itative)?|trading|fintech|market\s+data)\b/i]);
	if (domainRequirement) {
		const normalized = domainRequirement.quote_text.toUpperCase().replace(/\s+/g, "_");
		requirements.push(buildRequirement(input, sequence++, "DOMAIN", "Role includes a target technical domain requirement.", domainRequirement, { domain_key: normalized }));
	}
	if (requirements.length === 0) warnings.push("No deterministic requirements identified.");
	return {
		requirements,
		warnings
	};
}
//#endregion
//#region src/requirements/quotedRequirementExtractor.ts
function locateQuoteOffset(descriptionText, quoteText) {
	return descriptionText.indexOf(quoteText);
}
function validateQuoteOffsets(descriptionText, quoteText, quoteStartOffset, quoteEndOffset) {
	if (quoteStartOffset < 0 || quoteEndOffset <= quoteStartOffset) return false;
	return descriptionText.slice(quoteStartOffset, quoteEndOffset) === quoteText;
}
function validateQuotedRequirements(descriptionText, payload) {
	const parsed = QuotedRequirementExtractorResponseSchema.parse(payload);
	const issues = [];
	const normalizedRequirements = [];
	for (const requirement of parsed.requirements) {
		const existingStart = requirement.quote_start_offset;
		const existingEnd = requirement.quote_end_offset;
		let start = typeof existingStart === "number" ? existingStart : locateQuoteOffset(descriptionText, requirement.quote_text);
		let end = typeof existingEnd === "number" ? existingEnd : start + requirement.quote_text.length;
		if (start < 0) {
			issues.push({
				requirement_key: requirement.requirement_key,
				message: `Quote not found in description: ${requirement.quote_text}`
			});
			continue;
		}
		if (!validateQuoteOffsets(descriptionText, requirement.quote_text, start, end)) {
			issues.push({
				requirement_key: requirement.requirement_key,
				message: `Quote offsets do not match quote text at [${start}, ${end}).`
			});
			continue;
		}
		normalizedRequirements.push({
			...requirement,
			quote_start_offset: start,
			quote_end_offset: end
		});
	}
	return {
		valid: issues.length === 0,
		issues,
		requirements: normalizedRequirements
	};
}
//#endregion
//#region src/pipeline/requirementsExtractor.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$9 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
var DETERMINISTIC_VERSION = "deterministic_v3";
var QUOTED_VERSION = "quoted_v1";
var NORMALIZER_HASH = crypto.default.createHash("sha256").update("requirements_normalizer_v1").digest("hex");
var QUOTED_PROMPT_HASH = crypto.default.createHash("sha256").update(`quoted_prompt_v1|schema_version:${REQUIREMENTS_SCHEMA_VERSION}`).digest("hex");
function shouldRunQuotedExtractor() {
	return process.env.REQUIREMENTS_ENABLE_QUOTED === "true";
}
async function runDefaultQuotedRequirementProvider(input) {
	const { runQuotedRequirementProvider } = await Promise.resolve().then(() => require("./quotedProvider-Dr5jJ4Gi.cjs"));
	return runQuotedRequirementProvider(input);
}
function providerModelKey(provider, model) {
	return `${provider || "unknown"}:${model || "unknown"}`;
}
function ensureMetricBucket(summary, provider, model) {
	const key = providerModelKey(provider, model);
	if (!summary.metrics.byProviderModel[key]) summary.metrics.byProviderModel[key] = {
		attempts: 0,
		successes: 0,
		validationFailures: 0,
		providerFailures: 0,
		retries: 0
	};
	return summary.metrics.byProviderModel[key];
}
function parseProviderFailuresFromError(errorMessage) {
	const idx = errorMessage.indexOf("All model providers failed:");
	if (idx < 0) return [];
	const jsonPart = errorMessage.slice(idx + 27).trim();
	try {
		return JSON.parse(jsonPart).map((item) => ({
			provider: item.provider || "unknown",
			model: item.model || "unknown"
		}));
	} catch {
		return [];
	}
}
async function upsertPipelineState(client, job, stageStatus, lastError = null) {
	await client.query(`INSERT INTO job_version_pipeline_state (
       workspace_id,
       canonical_job_id,
       job_version_id,
       current_stage,
       stage_status,
       attempt_count,
       last_error,
       next_retry_at,
       updated_at
     )
     VALUES (
       $1,
       $2,
       $3,
       'REQUIREMENTS_EXTRACTED',
       $4,
       CASE WHEN $4 = 'RETRY_WAIT' THEN 1 ELSE 0 END,
       $5,
       CASE WHEN $4 = 'RETRY_WAIT' THEN NOW() + INTERVAL '5 minutes' ELSE NULL END,
       NOW()
     )
     ON CONFLICT (job_version_id)
     DO UPDATE SET
       current_stage = EXCLUDED.current_stage,
       stage_status = EXCLUDED.stage_status,
       attempt_count = CASE
         WHEN EXCLUDED.stage_status = 'RETRY_WAIT' THEN job_version_pipeline_state.attempt_count + 1
         ELSE job_version_pipeline_state.attempt_count
       END,
       last_error = EXCLUDED.last_error,
       next_retry_at = EXCLUDED.next_retry_at,
       updated_at = NOW()`, [
		job.workspace_id,
		job.canonical_job_id,
		job.job_version_id,
		stageStatus,
		lastError
	]);
}
function parsePositiveInt(value, fallback, max) {
	const parsed = Number.parseInt(String(value || ""), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(1, Math.min(max, parsed));
}
function truncateLogValue(value, maxLength = 500) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}
async function insertStageEvent(client, job, transitionTo, eventType, errorMessage, payload = null) {
	await client.query(`INSERT INTO pipeline_stage_events (
       workspace_id,
       canonical_job_id,
       job_version_id,
       stage,
       transition_from,
       transition_to,
       event_type,
       error_message,
       payload
     )
     VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', NULL, $4, $5, $6, $7)`, [
		job.workspace_id,
		job.canonical_job_id,
		job.job_version_id,
		transitionTo,
		eventType,
		errorMessage,
		payload
	]);
}
async function persistRequirements(client, workspaceId, requirementSetId, requirements) {
	let inserted = 0;
	for (const req of requirements) {
		const res = await client.query(`INSERT INTO job_requirements (
         workspace_id,
         canonical_job_id,
         job_version_id,
         requirement_set_id,
         requirement_key,
         requirement_type,
         importance,
         requirement_text,
         quote_text,
         quote_start_offset,
         quote_end_offset,
         structured_value,
         extractor_type,
         extractor_version,
         confidence,
         status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'VALIDATED')
       ON CONFLICT (requirement_set_id, requirement_key)
       DO NOTHING`, [
			workspaceId,
			req.canonical_job_id,
			req.job_version_id,
			requirementSetId,
			req.requirement_key,
			req.requirement_type,
			req.importance,
			req.requirement_text,
			req.quote_text ?? null,
			req.quote_start_offset ?? null,
			req.quote_end_offset ?? null,
			req.structured_value ?? null,
			req.extractor_type,
			req.extractor_version,
			req.confidence
		]);
		inserted += res.rowCount ?? 0;
	}
	return inserted;
}
function nextRequirementKey(index) {
	return `R-${String(index).padStart(3, "0")}`;
}
async function runRequirementsExtraction(clientOrPool, options = {}) {
	const pool = clientOrPool || defaultPool$9;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	console.log("[requirementsExtractor] acquiring database client");
	const client = ownsClient ? await pool.connect() : pool;
	console.log("[requirementsExtractor] database client acquired");
	const dbStatementTimeoutMs = parsePositiveInt(process.env.REQUIREMENTS_DB_STATEMENT_TIMEOUT_MS, 6e4, 3e5);
	await client.query(`SELECT set_config('statement_timeout', $1, false)`, [`${dbStatementTimeoutMs}ms`]);
	console.log(`[requirementsExtractor] statement_timeout=${dbStatementTimeoutMs}ms`);
	console.log("[requirementsExtractor] resolving workspace context");
	const ctx = options.context ?? await resolveWorkspaceContext(client);
	console.log(`[requirementsExtractor] workspace_id=${ctx.workspaceId}; loading target job versions`);
	const params = [ctx.workspaceId];
	const jobVersionIds = options.jobVersionIds?.filter(Boolean) ?? [];
	const jobVersionFilter = jobVersionIds.length > 0 ? `AND jv.id = ANY($${params.push(jobVersionIds)}::uuid[])` : "";
	const mode = options.quotedMode ?? "env";
	const quotedEnabledForSelection = mode === "with_quoted" ? true : mode === "deterministic_only" ? false : Boolean(options.quotedExtractor) || shouldRunQuotedExtractor();
	const deterministicCompleteClause = `AND (
        ps.stage_status IS DISTINCT FROM 'COMPLETED'
        OR NOT EXISTS (
          SELECT 1
          FROM requirement_extraction_runs deterministic_rer
          WHERE deterministic_rer.workspace_id = c.workspace_id
            AND deterministic_rer.job_version_id = jv.id
            AND deterministic_rer.run_type = 'DETERMINISTIC'
            AND deterministic_rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND deterministic_rer.requirement_set_id = jv.active_requirement_set_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM requirement_sets active_rs
          JOIN requirement_set_identities active_rsi
            ON active_rsi.id = active_rs.requirement_identity_id
           AND active_rsi.workspace_id = active_rs.workspace_id
          WHERE active_rs.workspace_id = c.workspace_id
            AND active_rs.id = jv.active_requirement_set_id
            AND active_rsi.deterministic_extractor_version = '${DETERMINISTIC_VERSION}'
        )
      )`;
	const completedRequirementClause = options.reprocess ? "" : quotedEnabledForSelection ? `AND (
        ps.stage_status IS DISTINCT FROM 'COMPLETED'
        OR NOT EXISTS (
          SELECT 1
          FROM requirement_extraction_runs quoted_rer
          WHERE quoted_rer.workspace_id = c.workspace_id
            AND quoted_rer.job_version_id = jv.id
            AND quoted_rer.run_type = 'LLM_QUOTED'
            AND quoted_rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND quoted_rer.requirement_set_id = jv.active_requirement_set_id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM requirement_sets active_rs
          JOIN requirement_set_identities active_rsi
            ON active_rsi.id = active_rs.requirement_identity_id
           AND active_rsi.workspace_id = active_rs.workspace_id
          WHERE active_rs.workspace_id = c.workspace_id
            AND active_rs.id = jv.active_requirement_set_id
            AND active_rsi.deterministic_extractor_version = '${DETERMINISTIC_VERSION}'
        )
      )` : deterministicCompleteClause;
	const limit = Number.isInteger(options.limit) && Number(options.limit) > 0 ? Number(options.limit) : 200;
	const queryTargetJobs = `
    SELECT
      c.workspace_id,
      c.id AS canonical_job_id,
      jv.id AS job_version_id,
      jv.content_hash,
      jv.description_text
    FROM canonical_jobs c
    JOIN job_versions jv
      ON jv.id = COALESCE(
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
     AND jv.workspace_id = c.workspace_id
    LEFT JOIN job_version_pipeline_state ps
      ON ps.workspace_id = c.workspace_id
     AND ps.job_version_id = jv.id
     AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
    WHERE c.workspace_id = $1
      AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
      AND (
        COALESCE(c.processing_state, c.processing_status) IN ('RAW_STAGED', 'PREQUALIFIED')
        OR (
          COALESCE(c.processing_state, c.processing_status) IN (
            'NEEDS_VERIFICATION', 'LANE_ROUTED', 'ROUTING_DEFERRED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
          )
        )
      )
      ${jobVersionFilter}
      ${completedRequirementClause}
      AND (
        ps.stage_status IS NULL
        OR ps.stage_status <> 'RETRY_WAIT'
        OR ps.next_retry_at IS NULL
        OR ps.next_retry_at <= NOW()
      )
    ORDER BY jv.observed_at ASC
    LIMIT $${params.push(limit)}
  `;
	const retryWindowClause = options.ignoreRetryWindow ? "" : `AND (\n        ps.stage_status IS NULL\n        OR ps.stage_status <> 'RETRY_WAIT'\n        OR ps.next_retry_at IS NULL\n        OR ps.next_retry_at <= NOW()\n      )`;
	const targetQuery = queryTargetJobs.replace(`      AND (\n        ps.stage_status IS NULL\n        OR ps.stage_status <> 'RETRY_WAIT'\n        OR ps.next_retry_at IS NULL\n        OR ps.next_retry_at <= NOW()\n      )`, retryWindowClause);
	const { rows } = await client.query(targetQuery, params);
	const jobs = rows;
	console.log(`[requirementsExtractor] loaded target job versions count=${jobs.length}`);
	const summary = {
		discovered: jobs.length,
		processed: 0,
		deterministicInserted: 0,
		quotedInserted: 0,
		quotedFailed: 0,
		errors: 0,
		metrics: {
			quotedAttempted: 0,
			quotedSucceeded: 0,
			quotedValidationFailures: 0,
			quotedProviderFailures: 0,
			retryWaitTransitions: 0,
			quotedPassRate: 0,
			byProviderModel: {}
		},
		details: []
	};
	const quotedExtractor = mode === "deterministic_only" ? void 0 : options.quotedExtractor ? options.quotedExtractor : mode === "with_quoted" || shouldRunQuotedExtractor() ? runDefaultQuotedRequirementProvider : void 0;
	const requestedFailFastOnQuotedProviderFailure = options.failFastOnQuotedProviderFailure ?? Boolean(quotedExtractor);
	const quotedProviderFailureLimit = options.quotedProviderFailureLimit ?? parsePositiveInt(process.env.REQUIREMENTS_PROVIDER_FAILURE_LIMIT, 1, 10);
	let quotedProviderFailures = 0;
	const quotedExtractorIdentityVersion = quotedExtractor ? `quoted_provider_${REQUIREMENTS_SCHEMA_VERSION}` : "none";
	console.log(`[requirementsExtractor] discovered=${jobs.length} quoted_enabled=${Boolean(quotedExtractor)} quoted_failure_policy=NON_BLOCKING requested_fail_fast=${requestedFailFastOnQuotedProviderFailure} provider_failure_limit=${quotedProviderFailureLimit}`);
	try {
		for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
			const job = jobs[jobIndex];
			const progress = `[requirementsExtractor] ${jobIndex + 1}/${jobs.length} canonical_job_id=${job.canonical_job_id} job_version_id=${job.job_version_id}`;
			const jobStartedAt = Date.now();
			console.log(`${progress} starting`);
			await client.query("BEGIN");
			try {
				await upsertPipelineState(client, job, "IN_PROGRESS");
				await insertStageEvent(client, job, "IN_PROGRESS", "STAGE_ENTERED", null, { run_type: "DETERMINISTIC" });
				const quotedEnabled = Boolean(quotedExtractor);
				const identityHash = crypto.default.createHash("sha256").update([
					job.content_hash || "",
					DETERMINISTIC_VERSION,
					quotedExtractorIdentityVersion,
					QUOTED_PROMPT_HASH,
					NORMALIZER_HASH,
					quotedEnabled ? "1" : "0"
				].join("|")).digest("hex");
				const requirementIdentityId = (await client.query(`INSERT INTO requirement_set_identities (
             workspace_id,
             canonical_job_id,
             identity_hash,
             job_content_hash,
             deterministic_extractor_version,
             quoted_extractor_version,
             quoted_prompt_hash,
             normalizer_hash,
             quoted_enabled
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (workspace_id, canonical_job_id, identity_hash)
           DO UPDATE SET identity_hash = EXCLUDED.identity_hash
           RETURNING id`, [
					ctx.workspaceId,
					job.canonical_job_id,
					identityHash,
					job.content_hash || "",
					DETERMINISTIC_VERSION,
					quotedExtractorIdentityVersion,
					QUOTED_PROMPT_HASH,
					NORMALIZER_HASH,
					quotedEnabled
				])).rows[0].id;
				const activeSetId = (await client.query(`SELECT active_requirement_set_id
           FROM job_versions
           WHERE workspace_id = $1 AND id = $2
           LIMIT 1`, [ctx.workspaceId, job.job_version_id])).rows[0]?.active_requirement_set_id ?? null;
				if (activeSetId) {
					const activeOk = await client.query(`SELECT 1
             FROM requirement_sets rs
             WHERE rs.workspace_id = $1
               AND rs.id = $2
               AND rs.requirement_identity_id = $3
             LIMIT 1`, [
						ctx.workspaceId,
						activeSetId,
						requirementIdentityId
					]);
					let activeSetIsComplete = false;
					if (activeOk.rows.length > 0) {
						activeSetIsComplete = (await client.query(`SELECT 1
               FROM requirement_extraction_runs rer
               WHERE rer.workspace_id = $1
                 AND rer.requirement_set_id = $2
                 AND rer.job_version_id = $3
                 AND rer.run_type = 'DETERMINISTIC'
                 AND rer.status = 'COMPLETED'
               LIMIT 1`, [
							ctx.workspaceId,
							activeSetId,
							job.job_version_id
						])).rows.length > 0;
						if (activeSetIsComplete && quotedExtractor) activeSetIsComplete = (await client.query(`SELECT 1
                 FROM requirement_extraction_runs rer
                 WHERE rer.workspace_id = $1
                   AND rer.requirement_set_id = $2
                   AND rer.job_version_id = $3
                   AND rer.run_type = 'LLM_QUOTED'
                   AND rer.status = 'COMPLETED'
                 LIMIT 1`, [
							ctx.workspaceId,
							activeSetId,
							job.job_version_id
						])).rows.length > 0;
						if (!activeSetIsComplete) console.warn(`${progress} active requirement set ${activeSetId} has no completed requirement extraction run for the requested mode; rebuilding`);
					}
					if (activeSetIsComplete && !options.reprocess) {
						await upsertPipelineState(client, job, "COMPLETED", null);
						await insertStageEvent(client, job, "COMPLETED", "STAGE_COMPLETED", null, {
							cached: true,
							requirement_set_id: activeSetId
						});
						await client.query("COMMIT");
						console.log(`${progress} completed cached=true requirement_set_id=${activeSetId} elapsed_ms=${Date.now() - jobStartedAt}`);
						summary.processed += 1;
						summary.details.push({
							canonicalJobId: job.canonical_job_id,
							jobVersionId: job.job_version_id,
							deterministicInserted: 0,
							quotedInserted: 0,
							warning: "requirements already active for this job_version (no-op)"
						});
						continue;
					}
				}
				const templateSetId = (await client.query(`SELECT rs.id
           FROM requirement_sets rs
           WHERE rs.workspace_id = $1
             AND rs.canonical_job_id = $2
             AND rs.requirement_identity_id = $3
             AND rs.job_version_id <> $4
           ORDER BY rs.created_at DESC
           LIMIT 1`, [
					ctx.workspaceId,
					job.canonical_job_id,
					requirementIdentityId,
					job.job_version_id
				])).rows[0]?.id ?? null;
				const revisionNumber = (await client.query(`SELECT (COALESCE(MAX(revision_number), 0) + 1)::int AS next_revision
           FROM requirement_sets
           WHERE workspace_id = $1 AND job_version_id = $2`, [ctx.workspaceId, job.job_version_id])).rows[0]?.next_revision ?? 1;
				const requirementSetId = (await client.query(`INSERT INTO requirement_sets (
             workspace_id,
             requirement_identity_id,
             canonical_job_id,
             job_version_id,
             revision_number,
             source_type,
             base_requirement_set_id,
             created_by_user_id
           )
           VALUES ($1, $2, $3, $4, $5, 'EXTRACTED', NULL, NULL)
           RETURNING id`, [
					ctx.workspaceId,
					requirementIdentityId,
					job.canonical_job_id,
					job.job_version_id,
					revisionNumber
				])).rows[0].id;
				await client.query(`UPDATE job_versions
           SET active_requirement_set_id = $3
           WHERE workspace_id = $1 AND id = $2`, [
					ctx.workspaceId,
					job.job_version_id,
					requirementSetId
				]);
				const detRunStart = await client.query(`INSERT INTO requirement_extraction_runs (
             workspace_id,
             canonical_job_id,
             job_version_id,
             requirement_set_id,
             run_type,
             provider,
             model,
             status,
             started_at
           )
           VALUES ($1, $2, $3, $4, 'DETERMINISTIC', NULL, NULL, 'STARTED', NOW())
           RETURNING id`, [
					ctx.workspaceId,
					job.canonical_job_id,
					job.job_version_id,
					requirementSetId
				]);
				let detInserted = 0;
				let quotedInserted = 0;
				let warning;
				if (templateSetId && templateSetId !== requirementSetId) {
					const countsRes = await client.query(`SELECT extractor_type, COUNT(*)::int AS n
             FROM job_requirements
             WHERE workspace_id = $1
               AND requirement_set_id = $2
               AND status = 'VALIDATED'
             GROUP BY extractor_type`, [ctx.workspaceId, templateSetId]);
					const counts = /* @__PURE__ */ new Map();
					for (const row of countsRes.rows) counts.set(row.extractor_type, row.n);
					await client.query(`INSERT INTO job_requirements (
               workspace_id,
               canonical_job_id,
               job_version_id,
               requirement_set_id,
               requirement_key,
               requirement_type,
               importance,
               requirement_text,
               quote_text,
               quote_start_offset,
               quote_end_offset,
               structured_value,
               extractor_type,
               extractor_version,
               confidence,
               status
             )
             SELECT
               $1,
               $2,
               $3,
               $4,
               jr.requirement_key,
               jr.requirement_type,
               jr.importance,
               jr.requirement_text,
               jr.quote_text,
               jr.quote_start_offset,
               jr.quote_end_offset,
               jr.structured_value,
               jr.extractor_type,
               jr.extractor_version,
               jr.confidence,
               jr.status
             FROM job_requirements jr
             WHERE jr.workspace_id = $1
               AND jr.requirement_set_id = $5
             ON CONFLICT (requirement_set_id, requirement_key) DO NOTHING`, [
						ctx.workspaceId,
						job.canonical_job_id,
						job.job_version_id,
						requirementSetId,
						templateSetId
					]);
					detInserted = counts.get("DETERMINISTIC") || 0;
					quotedInserted = counts.get("LLM_QUOTED") || 0;
					warning = `cached_from_requirement_set:${templateSetId}`;
					console.log(`${progress} copied cached requirements deterministic_inserted=${detInserted} quoted_inserted=${quotedInserted} source_requirement_set_id=${templateSetId}`);
					if (quotedExtractor && quotedInserted > 0) {
						const quotedRunStart = await client.query(`INSERT INTO requirement_extraction_runs (
                 workspace_id,
                 canonical_job_id,
                 job_version_id,
                 requirement_set_id,
                 run_type,
                 provider,
                 model,
                 status,
                 started_at
               )
               VALUES ($1, $2, $3, $4, 'LLM_QUOTED', 'CACHE', 'CACHE', 'COMPLETED', NOW())
               RETURNING id`, [
							ctx.workspaceId,
							job.canonical_job_id,
							job.job_version_id,
							requirementSetId
						]);
						await client.query(`UPDATE requirement_extraction_runs
               SET requirements_extracted = $2,
                   response_payload = $3,
                   completed_at = NOW()
               WHERE id = $1`, [
							quotedRunStart.rows[0].id,
							quotedInserted,
							{ cached_from_requirement_set_id: templateSetId }
						]);
					}
				} else {
					const deterministic = extractDeterministicRequirements({
						canonical_job_id: job.canonical_job_id,
						job_version_id: job.job_version_id,
						description_text: job.description_text
					});
					const deterministicRequirements = deterministic.requirements.map((req) => JobRequirementSchema.parse({
						...req,
						extractor_type: "DETERMINISTIC",
						extractor_version: DETERMINISTIC_VERSION
					}));
					detInserted = await persistRequirements(client, ctx.workspaceId, requirementSetId, deterministicRequirements);
					console.log(`${progress} deterministic_inserted=${detInserted}`);
					if (quotedExtractor) {
						summary.metrics.quotedAttempted += 1;
						const quotedRunStart = await client.query(`INSERT INTO requirement_extraction_runs (
                 workspace_id,
                 canonical_job_id,
                 job_version_id,
                 requirement_set_id,
                 run_type,
                 provider,
                 model,
                 status,
                 started_at
               )
               VALUES ($1, $2, $3, $4, 'LLM_QUOTED', NULL, NULL, 'STARTED', NOW())
               RETURNING id`, [
							ctx.workspaceId,
							job.canonical_job_id,
							job.job_version_id,
							requirementSetId
						]);
						try {
							console.log(`${progress} quoted provider starting`);
							const quotedResult = await quotedExtractor({
								canonicalJobId: job.canonical_job_id,
								jobVersionId: job.job_version_id,
								descriptionText: job.description_text,
								clientOrPool: client,
								workspaceContext: ctx,
								workspaceId: ctx.workspaceId
							});
							if (quotedResult?.payload) {
								const bucket = ensureMetricBucket(summary, quotedResult.provider, quotedResult.model);
								bucket.attempts += 1;
								const retriesFromAttempts = Math.max(0, (quotedResult.attempts || 1) - 1);
								const retriesFromErrors = quotedResult.errors?.length || 0;
								bucket.retries += Math.max(retriesFromAttempts, retriesFromErrors);
								const validated = validateQuotedRequirements(job.description_text, quotedResult.payload);
								if (!validated.valid) {
									summary.quotedFailed += 1;
									summary.metrics.quotedValidationFailures += 1;
									bucket.validationFailures += 1;
									warning = validated.issues.map((i) => `${i.requirement_key}: ${i.message}`).join("; ");
									console.warn(`${progress} quoted validation failed issues=${validated.issues.length} provider=${quotedResult.provider} model=${quotedResult.model}`);
									await client.query(`UPDATE requirement_extraction_runs
                     SET status = 'FAILED',
                         provider = $2,
                         model = $3,
                         error_message = $4,
                         response_payload = $5,
                         completed_at = NOW()
                     WHERE id = $1`, [
										quotedRunStart.rows[0].id,
										quotedResult.provider,
										quotedResult.model,
										warning,
										quotedResult.payload
									]);
								} else {
									const startIndex = deterministicRequirements.length + 1;
									const quotedRequirements = validated.requirements.map((req, idx) => JobRequirementSchema.parse({
										canonical_job_id: job.canonical_job_id,
										job_version_id: job.job_version_id,
										requirement_key: nextRequirementKey(startIndex + idx),
										requirement_type: req.requirement_type,
										importance: req.importance,
										requirement_text: req.requirement_text,
										quote_text: req.quote_text,
										quote_start_offset: req.quote_start_offset,
										quote_end_offset: req.quote_end_offset,
										structured_value: req.structured_value ?? null,
										extractor_type: "LLM_QUOTED",
										extractor_version: quotedResult.extractorVersion || QUOTED_VERSION,
										confidence: req.confidence
									}));
									quotedInserted = await persistRequirements(client, ctx.workspaceId, requirementSetId, quotedRequirements);
									summary.metrics.quotedSucceeded += 1;
									bucket.successes += 1;
									console.log(`${progress} quoted provider completed provider=${quotedResult.provider} model=${quotedResult.model} inserted=${quotedInserted}`);
									await client.query(`UPDATE requirement_extraction_runs
                     SET status = 'COMPLETED',
                         provider = $2,
                         model = $3,
                         requirements_extracted = $4,
                         response_payload = $5,
                         completed_at = NOW()
                     WHERE id = $1`, [
										quotedRunStart.rows[0].id,
										quotedResult.provider,
										quotedResult.model,
										quotedInserted,
										quotedResult.payload
									]);
								}
							} else {
								console.log(`${progress} quoted provider returned no payload`);
								await client.query(`UPDATE requirement_extraction_runs
                   SET status = 'COMPLETED',
                       requirements_extracted = 0,
                       completed_at = NOW()
                   WHERE id = $1`, [quotedRunStart.rows[0].id]);
							}
						} catch (quotedError) {
							summary.quotedFailed += 1;
							summary.metrics.quotedProviderFailures += 1;
							warning = quotedError instanceof Error ? quotedError.message : String(quotedError);
							const parsedFailures = parseProviderFailuresFromError(warning);
							if (parsedFailures.length > 0) for (const fail of parsedFailures) {
								const bucket = ensureMetricBucket(summary, fail.provider, fail.model);
								bucket.providerFailures += 1;
								bucket.retries += 1;
							}
							else {
								const bucket = ensureMetricBucket(summary, "unknown", "unknown");
								bucket.providerFailures += 1;
								bucket.retries += 1;
							}
							await client.query(`UPDATE requirement_extraction_runs
                 SET status = 'FAILED',
                     error_message = $2,
                     completed_at = NOW()
                 WHERE id = $1`, [quotedRunStart.rows[0].id, warning]);
							quotedProviderFailures += 1;
							console.warn(`${progress} quoted provider failed failures=${quotedProviderFailures}/${quotedProviderFailureLimit} error=${truncateLogValue(warning)}`);
						}
					}
					warning = deterministic.warnings.length > 0 ? deterministic.warnings.join("; ") : warning;
				}
				summary.deterministicInserted += detInserted;
				summary.quotedInserted += quotedInserted;
				await client.query(`UPDATE requirement_extraction_runs
           SET status = 'COMPLETED',
               requirements_extracted = $2,
               response_payload = $3,
               completed_at = NOW()
           WHERE id = $1`, [
					detRunStart.rows[0].id,
					detInserted,
					{ warning }
				]);
				await upsertPipelineState(client, job, "COMPLETED", null);
				await insertStageEvent(client, job, "COMPLETED", "STAGE_COMPLETED", null, {
					deterministic_inserted: detInserted,
					quoted_inserted: quotedInserted,
					warning,
					requirement_set_id: requirementSetId
				});
				await client.query("COMMIT");
				console.log(`${progress} completed deterministic_inserted=${detInserted} quoted_inserted=${quotedInserted} elapsed_ms=${Date.now() - jobStartedAt}`);
				summary.processed += 1;
				summary.details.push({
					canonicalJobId: job.canonical_job_id,
					jobVersionId: job.job_version_id,
					deterministicInserted: detInserted,
					quotedInserted,
					warning
				});
			} catch (error) {
				await client.query("ROLLBACK");
				summary.errors += 1;
				summary.metrics.retryWaitTransitions += 1;
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.warn(`${progress} failed elapsed_ms=${Date.now() - jobStartedAt} error=${truncateLogValue(errorMessage)}`);
				if (summary.errors <= 5) console.warn(`[requirementsExtractor] failed for canonical_job_id=${job.canonical_job_id} job_version_id=${job.job_version_id}: ${errorMessage}`);
				summary.details.push({
					canonicalJobId: job.canonical_job_id,
					jobVersionId: job.job_version_id,
					deterministicInserted: 0,
					quotedInserted: 0,
					error: errorMessage
				});
				await upsertPipelineState(client, job, "RETRY_WAIT", errorMessage);
				await insertStageEvent(client, job, "RETRY_WAIT", "RETRY_SCHEDULED", errorMessage, null);
			}
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
	summary.metrics.quotedPassRate = summary.metrics.quotedAttempted ? Number((summary.metrics.quotedSucceeded / summary.metrics.quotedAttempted).toFixed(4)) : 0;
	if (summary.errors > 0) {
		const sample = summary.details.filter((d) => d.error).slice(0, 5);
		console.warn(`[requirementsExtractor] errors=${summary.errors}. Sample failures: ${JSON.stringify(sample)}`);
	}
	console.log("Requirements extraction quoted metrics:", {
		quotedPassRate: summary.metrics.quotedPassRate,
		quotedAttempted: summary.metrics.quotedAttempted,
		quotedSucceeded: summary.metrics.quotedSucceeded,
		quotedValidationFailures: summary.metrics.quotedValidationFailures,
		quotedProviderFailures: summary.metrics.quotedProviderFailures,
		retryWaitTransitions: summary.metrics.retryWaitTransitions,
		byProviderModel: summary.metrics.byProviderModel
	});
	return summary;
}
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
/** Strict persistence variant: schema_version must be supplied by the writer. */
var PersistedGateDecisionSchema = zod.z.object({
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
/** Strict persistence variant: schema_version must be supplied by the writer. */
var PersistedLaneDecisionSchema = zod.z.object({
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
/** Strict persistence variant: schema_version must be supplied by the writer. */
var PersistedEvaluationQueueItemSchema = zod.z.object({
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
zod.z.object({
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
//#region src/pipeline/requirementComparators.ts
function calculateProfessionalExperienceYears(engagements, asOf = /* @__PURE__ */ new Date()) {
	const intervals = engagements.filter((engagement) => engagement.experience_class === "PROFESSIONAL_PRODUCTION").map((engagement) => {
		const start = new Date(engagement.start_date).getTime();
		const end = engagement.is_current || !engagement.end_date ? asOf.getTime() : new Date(engagement.end_date).getTime();
		return Number.isFinite(start) && Number.isFinite(end) && end > start ? {
			start,
			end
		} : null;
	}).filter((interval) => interval !== null).sort((left, right) => left.start - right.start);
	let coveredMonths = 0;
	let current = null;
	for (const interval of intervals) {
		if (!current) {
			current = { ...interval };
			continue;
		}
		if (interval.start <= current.end) current.end = Math.max(current.end, interval.end);
		else {
			coveredMonths += (current.end - current.start) / 26298e5;
			current = { ...interval };
		}
	}
	if (current) coveredMonths += (current.end - current.start) / 26298e5;
	return coveredMonths / 12;
}
function textForRequirement(requirement) {
	return [
		requirement.requirement_text,
		requirement.quote_text || "",
		JSON.stringify(requirement.structured_value || {})
	].join(" ").toLowerCase();
}
function textForFact(fact) {
	return [fact.statement, JSON.stringify(fact.structured_value || {})].join(" ").toLowerCase();
}
function normalizeComparableText(value) {
	return String(value ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+#.]+/g, " ").replace(/\s+/g, " ").trim();
}
function structuredStrings(value) {
	if (!value) return [];
	return Object.entries(value).flatMap(([key, raw]) => {
		if (raw === null || raw === void 0) return [];
		if (Array.isArray(raw)) return raw.map((item) => `${key}: ${String(item)}`);
		if (typeof raw === "object") return [`${key}: ${JSON.stringify(raw)}`];
		return [`${key}: ${String(raw)}`];
	});
}
var NUMBER_WORDS = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	fifteen: 15,
	twenty: 20
};
function parseNumberWord(text) {
	const normalized = text.toLowerCase().trim();
	if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
	return NUMBER_WORDS[normalized] ?? null;
}
function numberValue(value) {
	if (typeof value === "string") {
		const parsedWord = parseNumberWord(value);
		if (parsedWord !== null) return parsedWord;
	}
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function requiredYears(requirement) {
	const structured = requirement.structured_value || {};
	for (const key of [
		"minimum_years",
		"years_required",
		"min_years",
		"years"
	]) {
		const value = numberValue(structured[key]);
		if (value !== null) return value;
	}
	const match = textForRequirement(requirement).match(/(?:at least|minimum of|min\.?|over|more than)\s*(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*years?/i) || textForRequirement(requirement).match(/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*years?/i);
	return match ? parseNumberWord(match[1]) : null;
}
function factYears(fact) {
	const structured = fact.structured_value || {};
	for (const key of [
		"professional_years",
		"experience_years",
		"years",
		"years_experience"
	]) {
		const value = numberValue(structured[key]);
		if (value !== null) return value;
	}
	const months = numberValue(structured.professional_months ?? structured.experience_months);
	if (months !== null) return months / 12;
	const match = textForFact(fact).match(/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*years?/i);
	return match ? parseNumberWord(match[1]) : null;
}
function experienceInterval(fact) {
	const structured = fact.structured_value;
	if (!structured) return null;
	const startValue = structured.experience_start_date ?? structured.engagement_start_date ?? structured.start_date;
	const endValue = structured.experience_end_date ?? structured.engagement_end_date ?? structured.end_date;
	const start = new Date(String(startValue ?? "")).getTime();
	const end = endValue === null || endValue === void 0 || structured.is_current === true || structured.engagement_is_current === true ? Date.now() : new Date(String(endValue)).getTime();
	return Number.isFinite(start) && Number.isFinite(end) && end > start ? {
		start,
		end
	} : null;
}
function unionExperienceYears(intervals) {
	if (intervals.length === 0) return 0;
	const ordered = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
	let coveredMilliseconds = 0;
	let current = ordered[0];
	for (const interval of ordered.slice(1)) if (interval.start <= current.end) current = {
		start: current.start,
		end: Math.max(current.end, interval.end)
	};
	else {
		coveredMilliseconds += current.end - current.start;
		current = interval;
	}
	coveredMilliseconds += current.end - current.start;
	return coveredMilliseconds / 315576e5;
}
function normalizedScope(value) {
	return normalizeComparableText(value).replace(/\b(roles?|positions?|jobs?|experience|years?|of|in|the)\b/g, " ").replace(/\s+/g, " ").trim();
}
function experienceScopes(value) {
	if (!value || typeof value !== "object") return [];
	const record = value;
	return [
		record.experience_scope,
		record.experience_scopes,
		record.scope,
		record.domain,
		record.domains,
		record.role_family
	].flatMap((item) => Array.isArray(item) ? item : [item]).map(normalizedScope).filter(Boolean);
}
function requiredExperienceScope(requirement) {
	const structured = experienceScopes(requirement.structured_value);
	if (structured.length > 0) return structured.join(" ");
	const text = textForRequirement(requirement);
	const scoped = text.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*(?:years|yrs)\s+(?:of\s+)?(.+?)\s+experience\b/i) || text.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*years?\s+of\s+experience\s+in\s+(.+)$/i);
	return scoped?.[1] ? normalizedScope(scoped[1]) : null;
}
var SCOPE_STOP_WORDS = /* @__PURE__ */ new Set([
	"and",
	"the",
	"for",
	"with",
	"from",
	"that",
	"this",
	"all",
	"any",
	"our",
	"per",
	"you",
	"non",
	"set",
	"use",
	"pro",
	"new",
	"role",
	"roles",
	"work",
	"team",
	"teams",
	"such",
	"than",
	"more",
	"most",
	"each",
	"both",
	"must",
	"have",
	"plus",
	"years",
	"year",
	"experience",
	"experienced",
	"skills",
	"skill",
	"level",
	"related",
	"field",
	"fields",
	"equivalent",
	"environment",
	"environments",
	"building",
	"using",
	"engineering",
	"engineer",
	"engineers",
	"development",
	"developer",
	"developers",
	"operations",
	"operator",
	"management",
	"manager",
	"systems",
	"system",
	"lead",
	"senior",
	"junior",
	"staff",
	"principal",
	"architect",
	"architects",
	"analyst",
	"analysts",
	"specialist",
	"specialists",
	"consultant",
	"consultants",
	"technologies",
	"technology",
	"tech",
	"practices",
	"practice",
	"solutions",
	"solution",
	"professional",
	"services",
	"service",
	"tools",
	"tool",
	"methods",
	"method",
	"processes",
	"process"
]);
function tokenizeScope(scope) {
	return new Set(scope.toLowerCase().split(/[^a-z0-9+#]+/).filter((token) => token.length >= 2 && !SCOPE_STOP_WORDS.has(token)));
}
var DOMAIN_FAMILY_PATTERNS = [
	{
		domain: "ai",
		regex: /\b(ai|artificial intelligence|machine learning|ml|deep learning|nlp|llm|llms|generative ai|genai|computer vision)\b/i
	},
	{
		domain: "software",
		regex: /\b(software|software engineering|software development|application development|coding|full stack|backend|frontend|web development)\b/i
	},
	{
		domain: "data",
		regex: /\b(data|data engineering|data science|analytics|etl|data pipeline|data warehousing|big data|bi|business intelligence)\b/i
	},
	{
		domain: "security",
		regex: /\b(cybersecurity|security|infosec|information security|appsec|soc|penetration testing|threat)\b/i
	},
	{
		domain: "cloud_devops",
		regex: /\b(devops|cloud|site reliability|sre|infrastructure|platform|kubernetes|terraform|aws|gcp|azure)\b/i
	},
	{
		domain: "civil",
		regex: /\b(civil|civil engineering|structural|construction)\b/i
	},
	{
		domain: "mechanical",
		regex: /\b(mechanical|aerospace|automotive)\b/i
	},
	{
		domain: "electrical",
		regex: /\b(electrical|electronics|hardware|semiconductor)\b/i
	},
	{
		domain: "supply_chain",
		regex: /\b(supply chain|logistics|procurement|inventory)\b/i
	},
	{
		domain: "finance",
		regex: /\b(finance|financial|quantitative|trading|accounting|fintech|banking|investment)\b/i
	},
	{
		domain: "legal",
		regex: /\b(legal|regulatory|compliance|regtech|contract law|attorney|lawyer)\b/i
	},
	{
		domain: "health",
		regex: /\b(biomedical|biotech|pharma|healthcare|clinical|medical)\b/i
	}
];
function detectDomainFamilies(scope) {
	const families = /* @__PURE__ */ new Set();
	for (const { domain, regex } of DOMAIN_FAMILY_PATTERNS) if (regex.test(scope)) families.add(domain);
	return families;
}
/**
* Keep role shape separate from domain family. Architecture, hands-on
* engineering, research, and technical delivery are transferable but are not
* interchangeable for a scoped employer requirement.
*/
function detectRoleFamilies(scope) {
	const normalized = scope.toLowerCase();
	const families = /* @__PURE__ */ new Set();
	if (/\b(architect(?:ure)?|systems? design)\b/i.test(normalized)) families.add("architecture");
	if (/\b(engineer(?:ing)?|developer|development|coding|implementation|building|hands[- ]on)\b/i.test(normalized)) families.add("engineering");
	if (/\b(research|scientist|scientific)\b/i.test(normalized)) families.add("research");
	if (/\b(program(?:me)?|project|product|delivery|transformation|portfolio)\b/i.test(normalized)) families.add("delivery");
	return families;
}
function scopesOverlap(requiredScope, factScope) {
	const reqLower = requiredScope.toLowerCase().trim();
	const factLower = factScope.toLowerCase().trim();
	if (!reqLower || !factLower) return true;
	const reqDomains = detectDomainFamilies(reqLower);
	const factDomains = detectDomainFamilies(factLower);
	if (reqDomains.size > 0) {
		if (![...reqDomains].some((domain) => factDomains.has(domain))) return false;
	}
	const requiredRoles = detectRoleFamilies(reqLower);
	const factRoles = detectRoleFamilies(factLower);
	if (requiredRoles.size > 0 && factRoles.size > 0) {
		if (![...requiredRoles].some((role) => factRoles.has(role))) return false;
	}
	if (reqDomains.size > 0) return true;
	const requiredTokens = tokenizeScope(reqLower);
	const factTokens = tokenizeScope(factLower);
	if (requiredTokens.size === 0) return true;
	for (const token of requiredTokens) if (factTokens.has(token)) return true;
	return false;
}
function degreeLevel(text) {
	if (/\b(phd|doctorate|doctoral)\b/i.test(text)) return 3;
	if (/\b(master'?s?|msc|ma|mba)\b/i.test(text)) return 2;
	if (/\b(bachelor'?s?|undergraduate|bsc|ba)\b/i.test(text)) return 1;
	return null;
}
function degreeSubject(text) {
	const normalized = normalizeComparableText(text);
	for (const [canonical, aliases] of [
		["computer science", [
			"computer science",
			"computing",
			"software engineering",
			"informatics"
		]],
		["data science", [
			"data science",
			"analytics",
			"statistics",
			"applied statistics"
		]],
		["engineering", [
			"engineering",
			"electrical engineering",
			"computer engineering",
			"systems engineering"
		]],
		["mathematics", [
			"mathematics",
			"mathematical",
			"applied mathematics"
		]],
		["biology", [
			"biology",
			"biological",
			"biomedical",
			"biochemistry"
		]],
		["finance", [
			"finance",
			"financial",
			"economics",
			"financial economics"
		]],
		["business", [
			"business administration",
			"business management",
			"management"
		]],
		["law", [
			"law",
			"legal studies",
			"jurisprudence"
		]]
	]) if (aliases.some((alias) => normalized.includes(alias))) return canonical;
	return null;
}
function requirementCredentialIdentifier(requirement) {
	const structured = requirement.structured_value || {};
	const structuredCandidate = [
		structured.credential_id,
		structured.credential_name,
		structured.credential_reference,
		structured.certification,
		structured.license,
		structured.licence
	].find((value) => typeof value === "string" && value.trim().length > 0);
	const normalized = normalizeComparableText(String(structuredCandidate || requirement.quote_text || requirement.requirement_text || ""));
	const known = normalized.match(/\b(aws certified [a-z0-9 .+#-]+|cissp|cfa|cpa|pmp|prince2|scrum master|kubernetes|terraform|azure certified [a-z0-9 .+#-]+|google cloud [a-z0-9 .+#-]+)\b/i);
	if (known) return normalizeComparableText(known[1]);
	const genericRemoved = normalized.replace(/\b(required|required certification|preferred|certification|certificate|credential|license|licence|holder|must have|or equivalent)\b/g, " ").replace(/\s+/g, " ").trim();
	return genericRemoved.length >= 3 ? genericRemoved : null;
}
function factCredentialIdentifiers(fact) {
	const structured = fact.structured_value || {};
	return [fact.statement, ...structuredStrings(structured)].map(normalizeComparableText).filter(Boolean);
}
function factExplicitlyLacksCredential(fact, credential) {
	const structured = fact.structured_value || {};
	if ([
		"has_credential",
		"credential_present",
		"possesses_credential",
		"verified"
	].some((key) => structured[key] === false)) return true;
	const text = normalizeComparableText(`${fact.statement} ${JSON.stringify(structured)}`);
	return new RegExp(`\\b(no|not|without|missing|lacks?)\\b[^.]{0,80}\\b${credential.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "i").test(text) || new RegExp(`\\b${credential.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b[^.]{0,80}\\b(no|not|without|missing|lacks?)\\b`, "i").test(text);
}
function extractJurisdictions(value) {
	const normalized = normalizeComparableText(value);
	return [
		["united states", [
			"united states",
			"usa",
			"us"
		]],
		["canada", ["canada"]],
		["united kingdom", [
			"united kingdom",
			"uk",
			"great britain"
		]],
		["european union", ["european union", "eu"]],
		["australia", ["australia"]],
		["singapore", ["singapore"]]
	].filter(([, values]) => values.some((alias) => new RegExp(`\\b${alias.replace(/ /g, "\\s+")}\\b`, "i").test(normalized))).map(([canonical]) => canonical);
}
function explicitAuthorizationText(fact) {
	const structured = fact.structured_value || {};
	const structuredAuthorization = Object.entries(structured).filter(([key]) => /auth|eligib|jurisdiction|country|visa|citizen|right/i.test(key)).map(([, value]) => String(value)).join(" ");
	return `${fact.statement} ${structuredAuthorization}`.toLowerCase();
}
function compareStructuredRequirement(requirement, facts) {
	const requirementText = textForRequirement(requirement);
	if (requirement.requirement_type === "EXPERIENCE_YEARS") {
		const required = requiredYears(requirement);
		if (required === null) return {
			status: "UNKNOWN",
			rationale: "Required experience duration is not structured.",
			fact: null
		};
		const requiredScope = requiredExperienceScope(requirement);
		const candidates = facts.map((fact) => {
			const scopes = experienceScopes(fact.structured_value);
			if (scopes.length === 0) {
				const text = textForFact(fact);
				const scoped = text.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*(?:years|yrs)\s+(?:of\s+)?(.+?)\s+experience\b/i) || text.match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s*years?\s+of\s+experience\s+in\s+(.+)$/i);
				if (scoped?.[1]) scopes.push(normalizedScope(scoped[1]));
				else scopes.push(normalizedScope(text));
			}
			return {
				fact,
				years: factYears(fact),
				scopes,
				interval: experienceInterval(fact)
			};
		}).filter((candidate) => candidate.years !== null);
		if (candidates.length === 0) return {
			status: "UNKNOWN",
			rationale: "No structured profile experience duration is available.",
			fact: null
		};
		const scopedCandidates = requiredScope ? candidates.filter((candidate) => candidate.scopes.some((scope) => scopesOverlap(requiredScope, scope))) : candidates;
		if (requiredScope && scopedCandidates.length === 0) return {
			status: "UNKNOWN",
			rationale: `No structured profile experience duration is available for the required scope: ${requiredScope}.`,
			fact: null
		};
		const hasScopedEvidence = scopedCandidates.some((candidate) => candidate.scopes.some((scope) => {
			const normalized = scope.replace(/\s+/g, " ").trim();
			return normalized.length > 0 && !/\b(overall|professional|production)\b/i.test(normalized);
		}) || candidate.interval !== null);
		const usableCandidates = !requiredScope && hasScopedEvidence ? scopedCandidates.filter((candidate) => !candidate.scopes.some((scope) => /\b(overall|professional|production)\b/i.test(scope))) : scopedCandidates;
		const totalYears = unionExperienceYears(usableCandidates.flatMap((candidate) => candidate.interval ? [candidate.interval] : [])) + usableCandidates.filter((candidate) => candidate.interval === null).reduce((sum, candidate) => sum + candidate.years, 0);
		const representative = [...usableCandidates].sort((a, b) => b.years - a.years)[0] || [...scopedCandidates].sort((a, b) => b.years - a.years)[0];
		if (!representative) return {
			status: "UNKNOWN",
			rationale: `No structured profile experience duration is available for the required scope: ${requiredScope || "professional experience"}.`,
			fact: null
		};
		const scopeSuffix = requiredScope ? ` for ${requiredScope}` : "";
		return totalYears >= required ? {
			status: "MATCH",
			rationale: `Combined profile experience ${totalYears.toFixed(1)} years meets the ${required}-year requirement${scopeSuffix}.`,
			fact: representative.fact
		} : {
			status: "MISMATCH",
			rationale: `Combined profile experience ${totalYears.toFixed(1)} years is below the ${required}-year requirement${scopeSuffix}.`,
			fact: representative.fact
		};
	}
	if (requirement.requirement_type === "DEGREE") {
		const requiredLevel = degreeLevel(requirementText);
		if (requiredLevel === null) return {
			status: "UNKNOWN",
			rationale: "Degree level is not explicit.",
			fact: null
		};
		const requiredSubject = degreeSubject(requirementText);
		const matching = facts.find((fact) => {
			const factText = textForFact(fact);
			const level = degreeLevel(factText);
			const factSubject = degreeSubject(factText);
			return level !== null && level >= requiredLevel && (!requiredSubject || factSubject === requiredSubject);
		});
		if (matching) return {
			status: "MATCH",
			rationale: "Profile evidence contains the required degree level.",
			fact: matching
		};
		const degreeEvidence = facts.find((fact) => degreeLevel(textForFact(fact)) !== null);
		if (requiredSubject && degreeEvidence && facts.every((fact) => {
			if (degreeLevel(textForFact(fact)) === null) return true;
			return degreeSubject(textForFact(fact)) === null;
		})) return {
			status: "UNKNOWN",
			rationale: `Profile degree level is present, but the required ${requiredSubject} subject cannot be verified.`,
			fact: degreeEvidence
		};
		return degreeEvidence ? {
			status: "MISMATCH",
			rationale: requiredSubject ? `Profile degree evidence does not meet the required ${requiredSubject} degree level/subject.` : "Profile degree evidence does not meet the required degree level.",
			fact: degreeEvidence
		} : {
			status: "UNKNOWN",
			rationale: "No profile degree evidence is available.",
			fact: null
		};
	}
	if (requirement.requirement_type === "CREDENTIAL") {
		const specificCredential = requirementCredentialIdentifier(requirement);
		if (!specificCredential) return {
			status: "UNKNOWN",
			rationale: "Credential name is not explicit.",
			fact: null
		};
		const explicitAbsence = facts.find((fact) => factExplicitlyLacksCredential(fact, specificCredential));
		if (explicitAbsence) return {
			status: "MISMATCH",
			rationale: "Profile evidence explicitly confirms that the required credential is not held.",
			fact: explicitAbsence
		};
		const matching = facts.find((fact) => factCredentialIdentifiers(fact).some((value) => value.includes(specificCredential)));
		if (matching) return {
			status: "MATCH",
			rationale: "Profile evidence contains the required credential.",
			fact: matching
		};
		const credentialEvidence = facts.find((fact) => /certif|license|licence|credential/i.test(textForFact(fact)) || fact.source_type === "CREDENTIAL");
		return credentialEvidence ? {
			status: "MISMATCH",
			rationale: "Profile credential evidence does not match the required credential.",
			fact: credentialEvidence
		} : {
			status: "UNKNOWN",
			rationale: "No profile credential evidence is available.",
			fact: null
		};
	}
	if (requirement.requirement_type === "WORK_AUTH") {
		const jurisdictions = extractJurisdictions(requirementText);
		if (jurisdictions.length === 0) return {
			status: "UNKNOWN",
			rationale: "Work authorization jurisdiction is not explicit.",
			fact: null
		};
		const authorizationFacts = facts.map((fact) => ({
			fact,
			text: explicitAuthorizationText(fact),
			jurisdictions: extractJurisdictions(explicitAuthorizationText(fact))
		})).filter((candidate) => /authori[sz]|work rights|eligible to work|right to work|citizen|permanent resident|visa/i.test(candidate.text));
		const matching = authorizationFacts.find((candidate) => jurisdictions.some((jurisdiction) => candidate.jurisdictions.includes(jurisdiction)));
		return matching ? {
			status: "MATCH",
			rationale: "Profile evidence explicitly contains the required work authorization jurisdiction.",
			fact: matching.fact
		} : authorizationFacts.length > 0 ? {
			status: "MISMATCH",
			rationale: "Profile work authorization evidence does not include the required jurisdiction.",
			fact: authorizationFacts[0].fact
		} : {
			status: "UNKNOWN",
			rationale: "Required work authorization cannot be verified from profile evidence.",
			fact: null
		};
	}
	return {
		status: "UNKNOWN",
		rationale: "No exact structured comparator applies to this requirement type.",
		fact: null
	};
}
//#endregion
//#region src/pipeline/hardGate.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$8 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
function isRequirementOptional(req) {
	const importance = (req.importance || "").toUpperCase();
	if (importance === "PREFERRED" || importance === "NICE_TO_HAVE" || importance === "OPTIONAL") return true;
	const structuredImportance = String(req.structured_value?.importance || "").toUpperCase();
	if (structuredImportance === "PREFERRED" || structuredImportance === "NICE_TO_HAVE" || structuredImportance === "OPTIONAL") return true;
	if (req.structured_value?.is_required === false || req.structured_value?.required === false) return true;
	return false;
}
function makePass(extraFacts) {
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
			...extraFacts
		}
	};
}
function makeReject(codes, evidence, facts) {
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
			...facts
		}
	};
}
function makeVerification(codes, evidence, facts) {
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
			...facts
		}
	};
}
function quoteOrText(req) {
	return req.quote_text || req.requirement_text;
}
function detectOfficeDays(req) {
	const structured = req.structured_value || {};
	for (const key of [
		"office_days_per_week",
		"max_office_days_per_week",
		"office_days_max",
		"office_days_min"
	]) {
		const raw = structured[key];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	}
	return extractHybridAttendance(quoteOrText(req))?.office_days_max ?? null;
}
function detectTravelPct(req) {
	const structured = req.structured_value || {};
	for (const key of [
		"max_travel_pct",
		"travel_pct_max",
		"travel_percentage",
		"maximum_travel_pct"
	]) {
		const raw = structured[key];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	}
	return extractTravelRequirement(quoteOrText(req))?.max_pct ?? null;
}
function structuredNumber(req, keys) {
	for (const key of keys) {
		const value = req.structured_value?.[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	}
	return null;
}
function applyPersistedRequirementGates(job, deterministicRequirements, policy = loadWorkabilityPolicy(), answerContext) {
	const effectivePolicy = applyVerificationAnswerOverrides(policy, answerContext);
	const officeDaysAnswerUnknown = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.workplaceOfficeDays) && answerContext?.overrides.workplaceOfficeDaysCap === null;
	const travelAnswerUnknown = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.travelPercentage) && answerContext?.overrides.travelPercentageCap === null;
	const workAuthorizationAnswerUnknown = isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.workAuthorization) && answerContext?.overrides.workAuthorizationRegions.length === 0;
	const title = job.title || "";
	let pendingVerification = null;
	let inferredWorkabilityFacts = {};
	for (const pattern of GLOBAL_TITLE_EXCLUSIONS) if (pattern.test(title)) return makeReject(["NON_TARGET_ROLE_FAMILY", "GATE_OUT_OF_SCOPE_DOMAIN"], [`Non-target title exclusion: "${title}"`]);
	const functionRequirements = deterministicRequirements.filter((r) => r.requirement_type === "FUNCTION");
	const domainRequirements = deterministicRequirements.filter((r) => r.requirement_type === "DOMAIN");
	const hasSemanticSignals = functionRequirements.length > 0 || domainRequirements.length > 0;
	const semanticCorpus = [...functionRequirements, ...domainRequirements].map((r) => quoteOrText(r).toLowerCase()).concat(job.description ? [job.description.toLowerCase()] : []).join(" \n");
	let hasTechnicalEvidence = false;
	if (hasSemanticSignals) hasTechnicalEvidence = /(engineer|architect|developer|scientist|machine learning|artificial intelligence|ai\b|llm|nlp|data|bioinformatics|genomics|regtech|legaltech|quant|fintech|trading)/i.test(semanticCorpus);
	else hasTechnicalEvidence = isTechnicalRole(title, deterministicRequirements.map((r) => quoteOrText(r).toLowerCase()).concat(job.description ? [job.description.toLowerCase()] : []).join(" \n")).isTechnical;
	if (!hasTechnicalEvidence) return makeReject(["NON_TECHNICAL_FUNCTION", "GATE_OUT_OF_SCOPE_DOMAIN"], [hasSemanticSignals ? "Persisted FUNCTION/DOMAIN requirements indicate non-technical scope" : "Axis 1 Failed: Role lacks evidence of technical function"]);
	for (const requirement of deterministicRequirements) {
		const buildingPct = structuredNumber(requirement, [
			"building_research_pct",
			"minimum_building_research_pct",
			"hands_on_pct",
			"implementation_pct"
		]);
		if (buildingPct !== null && buildingPct < effectivePolicy.minimumBuildingResearchPct) return makeReject(["GATE_BUILDING_RESEARCH_RATIO"], [quoteOrText(requirement)], {
			office_days_min: null,
			office_days_max: null
		});
		const interactionPct = structuredNumber(requirement, [
			"interaction_pct",
			"maximum_interaction_pct",
			"stakeholder_pct",
			"client_facing_pct"
		]);
		if (interactionPct !== null && interactionPct > effectivePolicy.maximumInteractionPct) return makeReject(["GATE_HIGH_INTERACTION"], [quoteOrText(requirement)]);
		const travelPct = structuredNumber(requirement, [
			"max_travel_pct",
			"travel_pct_max",
			"travel_percentage",
			"maximum_travel_pct"
		]);
		if (travelPct !== null && travelPct > effectivePolicy.maxTravelPct) return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(requirement)], { travel_pct_max: travelPct });
	}
	const employmentReq = deterministicRequirements.find((r) => r.requirement_type === "EMPLOYMENT_TYPE");
	const normalizedEmployment = (employmentReq ? quoteOrText(employmentReq) : job.employment_type || "").toLowerCase();
	const employmentType = normalizedEmployment.includes("contract") ? "CONTRACT" : /\b(permanent|full[-_ ]?time|fte)\b/i.test(normalizedEmployment) ? "PERMANENT" : "UNKNOWN";
	if (employmentType === "CONTRACT" && !effectivePolicy.contractAllowed) return makeReject(["GATE_CONTRACT_ROLE"], [employmentReq ? quoteOrText(employmentReq) : "Structured employment_type is CONTRACT"], { employment_type: "CONTRACT" });
	const officeRequirements = deterministicRequirements.filter((r) => r.requirement_type === "OFFICE_DAYS");
	const officeReq = officeRequirements[0];
	for (const requirement of officeRequirements) {
		const days = detectOfficeDays(requirement);
		if (days !== null && days >= effectivePolicy.hardFailOfficeDaysPerWeek) return makeReject(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], [quoteOrText(requirement)], {
			office_days_min: days,
			office_days_max: days
		});
		if (days !== null && officeDaysAnswerUnknown) {
			pendingVerification = {
				codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
				evidence: [quoteOrText(requirement)],
				facts: {
					office_days_min: days,
					office_days_max: days
				}
			};
			continue;
		}
		if (days !== null && days > effectivePolicy.maxOfficeDaysPerWeek) return makeReject(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], [quoteOrText(requirement)], {
			office_days_min: days,
			office_days_max: days
		});
		if (days === null) {
			if (!effectivePolicy.hybridWithoutOfficeDaysAllowed) pendingVerification = {
				codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
				evidence: [quoteOrText(requirement)],
				facts: {
					office_days_min: null,
					office_days_max: null
				}
			};
		}
	}
	const workModeReq = deterministicRequirements.find((r) => r.requirement_type === "WORK_MODE");
	if (workModeReq) {
		const mode = quoteOrText(workModeReq).toLowerCase();
		if (!effectivePolicy.onsiteOnlyAllowed && (mode.includes("onsite only") || mode.includes("on-site only") || mode.includes("fully on-site") || mode.includes("fully onsite") || mode.includes("100% on-site") || mode.includes("100% onsite"))) return makeReject(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], [quoteOrText(workModeReq)], {
			office_days_min: effectivePolicy.hardFailOfficeDaysPerWeek,
			office_days_max: 5
		});
	}
	const travelRequirements = deterministicRequirements.filter((r) => r.requirement_type === "TRAVEL");
	const travelReq = travelRequirements[0];
	for (const requirement of travelRequirements) {
		const travelPct = detectTravelPct(requirement);
		const txt = quoteOrText(requirement).toLowerCase();
		const hasTravelAnswer = answerContext?.overrides.travelPercentageCap !== null && answerContext?.overrides.travelPercentageCap !== void 0 || isVerificationAnswerProvided(answerContext, VERIFICATION_ANSWER_KEYS.travelPercentage);
		if (travelPct !== null && travelAnswerUnknown) {
			pendingVerification = {
				codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_TRAVEL"],
				evidence: [quoteOrText(requirement)],
				facts: { travel_pct_max: travelPct }
			};
			continue;
		}
		if (travelPct !== null && travelPct > effectivePolicy.maxTravelPct) return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(requirement)], { travel_pct_max: travelPct });
		if (hasTravelAnswer && travelPct === null) pendingVerification = {
			codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_TRAVEL"],
			evidence: [quoteOrText(requirement)],
			facts: { travel_pct_max: null }
		};
		else if (!hasTravelAnswer && txt.includes("frequent travel") && !effectivePolicy.frequentTravelAllowed) return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(requirement)], { travel_pct_max: travelPct });
	}
	const onCallReq = deterministicRequirements.find((r) => r.requirement_type === "ON_CALL");
	if (onCallReq && !effectivePolicy.regularOnCallAllowed) return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(onCallReq)]);
	const shiftReq = deterministicRequirements.find((r) => r.requirement_type === "SHIFT_WORK");
	if (shiftReq && !effectivePolicy.shiftWorkAllowed) return makeReject(["GATE_LIFESTYLE_INCOMPATIBLE"], [quoteOrText(shiftReq)]);
	const workAuthReq = deterministicRequirements.find((r) => r.requirement_type === "WORK_AUTH");
	if (workAuthReq) {
		const requiredTerritories = extractTerritories(quoteOrText(workAuthReq).toLowerCase());
		const authorizedRegions = new Set(effectivePolicy.authorizedRegions);
		const foreignRequired = requiredTerritories.filter((territory) => authorizedRegions.size === 0 || !authorizedRegions.has(territory));
		if (effectivePolicy.rejectExplicitForeignTerritory && foreignRequired.length > 0 && !workAuthorizationAnswerUnknown) return makeReject(["GATE_LOCATION_RESTRICTED"], [quoteOrText(workAuthReq)], { location_restriction: foreignRequired[0] });
		if ((requiredTerritories.length === 0 || workAuthorizationAnswerUnknown && foreignRequired.length > 0) && effectivePolicy.unknownWorkAuthorizationNeedsVerification) pendingVerification = {
			codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_WORK_AUTH"],
			evidence: [quoteOrText(workAuthReq)]
		};
	}
	if (workModeReq && quoteOrText(workModeReq).toLowerCase().includes("hybrid") && officeRequirements.length === 0) {
		const attendance = extractHybridAttendance(quoteOrText(workModeReq));
		if (attendance?.contradictory || attendance && attendance.office_days_max >= effectivePolicy.hardFailOfficeDaysPerWeek) return makeReject(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], attendance?.evidence || [quoteOrText(workModeReq)], {
			office_days_min: attendance?.office_days_min ?? null,
			office_days_max: attendance?.office_days_max ?? null
		});
		if (attendance && attendance.office_days_max > effectivePolicy.maxOfficeDaysPerWeek) return makeReject(["UNWORKABLE_LOCATION_MODEL", "GATE_HIGH_OFFICE_DAYS"], attendance.evidence, {
			office_days_min: attendance.office_days_min,
			office_days_max: attendance.office_days_max
		});
		if (officeDaysAnswerUnknown) pendingVerification = {
			codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
			evidence: [quoteOrText(workModeReq)],
			facts: {
				office_days_min: attendance?.office_days_min ?? 3,
				office_days_max: attendance?.office_days_max ?? 3,
				attendance_basis: attendance ? "EMPLOYER_STATED" : "POLICY_HYBRID_3_2"
			}
		};
		else if (!attendance && effectivePolicy.hybridWithoutOfficeDaysAllowed) inferredWorkabilityFacts = {
			office_days_min: 3,
			office_days_max: 3,
			attendance_basis: "POLICY_HYBRID_3_2"
		};
		else if (!attendance && !effectivePolicy.hybridWithoutOfficeDaysAllowed) pendingVerification = {
			codes: ["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_OFFICE_DAYS"],
			evidence: [quoteOrText(workModeReq)],
			facts: {
				office_days_min: null,
				office_days_max: null
			}
		};
	}
	if (pendingVerification) return makeVerification(pendingVerification.codes, pendingVerification.evidence, {
		...inferredWorkabilityFacts,
		...pendingVerification.facts
	});
	return makePass({
		...inferredWorkabilityFacts,
		office_days_min: officeReq ? detectOfficeDays(officeReq) : inferredWorkabilityFacts.office_days_min ?? null,
		office_days_max: officeReq ? detectOfficeDays(officeReq) : inferredWorkabilityFacts.office_days_max ?? null,
		travel_pct_max: travelReq ? detectTravelPct(travelReq) : null,
		employment_type: employmentType
	});
}
function combineGateResults(results) {
	const hardReject = results.find((result) => result.status === "HARD_REJECT");
	const verification = results.find((result) => result.status === "NEEDS_VERIFICATION");
	const selected = hardReject || verification || results[0] || makePass();
	const rejectionCodes = [...new Set(results.flatMap((result) => result.rejection_codes))];
	const evidenceQuotes = [...new Set(results.flatMap((result) => result.evidence_quotes))];
	const workabilityFacts = { ...makePass().workability_facts };
	for (const result of results) for (const [key, value] of Object.entries(result.workability_facts)) {
		if (value === null || value === void 0) continue;
		const existingValue = workabilityFacts[key];
		if (value === "UNKNOWN" && existingValue !== null && existingValue !== void 0 && existingValue !== "UNKNOWN") continue;
		workabilityFacts[key] = value;
	}
	return {
		...selected,
		rejection_code: rejectionCodes[0],
		rejection_codes: rejectionCodes,
		evidence_quotes: evidenceQuotes,
		workability_facts: workabilityFacts
	};
}
function verificationDegreeSubject(value) {
	const text = value.toLowerCase().replace(/[_-]+/g, " ");
	if (/\b(computer\s+science|computing|informatics|software\s+engineering)\b/i.test(text)) return "computer_science";
	if (/\b(data\s+science|analytics?|statistics?)\b/i.test(text)) return "data_science";
	if (/\b(mathematics?|mathematical|quantitative)\b/i.test(text)) return "mathematics";
	if (/\b(electrical|systems?)\s+engineering\b|\bengineering\b/i.test(text) && !/software\s+engineering/i.test(text)) return "engineering";
	if (/\bphysics?|computational\s+science\b/i.test(text)) return "physics";
	if (/\b(biology|biological|biomedical|biochemistry)\b/i.test(text)) return "biology";
	if (/\b(finance|financial|economics?)\b/i.test(text)) return "finance";
	if (/\b(business|management)\b/i.test(text)) return "business";
	if (/\b(law|legal\s+studies|jurisprudence)\b/i.test(text)) return "law";
	return null;
}
function degreeRequirementSubject(requirement) {
	return verificationDegreeSubject([
		requirement.requirement_text,
		requirement.quote_text || "",
		JSON.stringify(requirement.structured_value || {})
	].join(" "));
}
function removeDegreeSubject(requirement) {
	const structured = Object.fromEntries(Object.entries(requirement.structured_value || {}).filter(([key]) => !/(subject|major|discipline|field)/i.test(key)));
	const level = (requirement.requirement_text || requirement.quote_text || "").match(/\b(phd|doctorate|doctoral|master'?s?|msc|ma|mba|bachelor'?s?|undergraduate|bsc|ba)\b/i)?.[0];
	return {
		...requirement,
		requirement_text: level ? `${level} degree` : requirement.requirement_text,
		quote_text: level ? `${level} degree` : requirement.quote_text,
		structured_value: structured
	};
}
function expandExperienceScope(requirement, domains) {
	const structured = { ...requirement.structured_value || {} };
	const existing = structured.experience_scope ?? structured.experience_scopes ?? structured.scope ?? structured.domain;
	structured.experience_scope = [...Array.isArray(existing) ? existing : existing ? [existing] : [], ...domains];
	return {
		...requirement,
		structured_value: structured
	};
}
function applyExactProfileGates(deterministicRequirements, profileFacts, answerContext) {
	const exactRequirements = deterministicRequirements.filter((requirement) => [
		"EXPERIENCE_YEARS",
		"CREDENTIAL",
		"DEGREE",
		"WORK_AUTH"
	].includes(requirement.requirement_type));
	if (exactRequirements.length === 0) return makePass();
	const mismatches = [];
	const mismatchEvidence = [];
	const unknowns = [];
	const unknownEvidence = [];
	for (const requirement of exactRequirements) {
		if (isRequirementOptional(requirement)) continue;
		let comparison = compareStructuredRequirement(requirement, profileFacts);
		if (comparison.status === "UNKNOWN" && answerContext) {
			if (requirement.requirement_type === "DEGREE" && answerContext.overrides.degreeSubjects.length > 0) {
				const subject = degreeRequirementSubject(requirement);
				if (subject && !answerContext.overrides.degreeSubjects.includes(subject)) comparison = {
					status: "MISMATCH",
					rationale: `Verification answer does not accept the required ${subject.replace(/_/g, " ")} degree subject.`,
					fact: null
				};
				else if (subject) comparison = compareStructuredRequirement(removeDegreeSubject(requirement), profileFacts);
			} else if (requirement.requirement_type === "EXPERIENCE_YEARS" && answerContext.overrides.experienceDomains.length > 0) comparison = compareStructuredRequirement(expandExperienceScope(requirement, answerContext.overrides.experienceDomains), profileFacts);
			else if (requirement.requirement_type === "WORK_AUTH" && answerContext.overrides.workAuthorizationRegions.length > 0) {
				const answerFact = {
					id: `verification-answer:${answerContext.answerRevisionId || "unversioned"}`,
					statement: `Verification answer explicitly authorizes work in ${answerContext.overrides.workAuthorizationRegions.join(", ")}.`,
					structured_value: { authorized_regions: answerContext.overrides.workAuthorizationRegions },
					source_type: "PROFILE_FACT"
				};
				comparison = compareStructuredRequirement(requirement, [...profileFacts, answerFact]);
			}
		}
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
async function runHardGates(clientOrPool, options) {
	console.log("Starting Hard Gate engine on RAW_STAGED canonical jobs...");
	const pool = clientOrPool || defaultPool$8;
	let passedCount = 0;
	let rejectedCount = 0;
	let needsVerificationCount = 0;
	let errorCount = 0;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	const ctx = options?.context ?? await resolveWorkspaceContext(client);
	const pipelineRunId = crypto.default.randomUUID();
	const policyResolution = await resolveWorkspaceWorkabilityPolicy(client, { context: ctx });
	console.log(`Hard Gate workability policy: ${policyResolution.source}${policyResolution.modeKey ? ` mode=${policyResolution.modeKey}` : ""} hash=${policyResolution.policyHash.slice(0, 12)}`);
	const requestedAnswerJobVersionId = options?.verificationJobVersionId ?? options?.jobVersionId ?? (options?.jobVersionIds?.length === 1 ? options.jobVersionIds[0] : null);
	let answerContext = options?.verificationAnswerContext ?? options?.answerContext ?? null;
	if (!answerContext && options?.verificationAnswerRevisionId) answerContext = await loadVerificationAnswerContext(client, {
		context: ctx,
		answerRevisionId: options.verificationAnswerRevisionId,
		jobVersionId: requestedAnswerJobVersionId
	});
	if (answerContext && !isVerificationAnswerContextApplicable(answerContext, { answerRevisionId: options?.verificationAnswerRevisionId })) answerContext = null;
	const reprocess = options?.reprocess === true;
	const params = [ctx.workspaceId, reprocess];
	const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
	const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
	const jobVersionFilter = jobVersionIds.length > 0 ? `AND jv.id = ANY($${params.push(jobVersionIds)}::uuid[])` : "";
	const canonicalJobFilter = canonicalJobIds.length > 0 ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])` : "";
	const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0 ? Number(options?.limit) : null;
	const limitClause = limit ? `LIMIT $${params.push(limit)}` : "";
	const { rows: stagedJobs } = await client.query(`
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
        AND (
          COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
          OR (
            $2::boolean = TRUE
            AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
          )
        )
        ${jobVersionFilter}
        ${canonicalJobFilter}
      ORDER BY c.created_at ASC, c.id ASC
      ${limitClause}
    `, params);
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
				const jobAnswerContext = answerContext && isVerificationAnswerContextApplicable(answerContext, { jobVersionId: job.job_version_id }) ? answerContext : null;
				const { rows: requirementRows } = await client.query(`SELECT jr.requirement_key, jr.requirement_type, jr.importance, jr.requirement_text, jr.quote_text, jr.structured_value
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
           ORDER BY jr.requirement_key ASC`, [ctx.workspaceId, job.job_version_id]);
				const deterministicRequirements = requirementRows;
				let profileFacts = [];
				if (deterministicRequirements.some((requirement) => [
					"EXPERIENCE_YEARS",
					"CREDENTIAL",
					"DEGREE",
					"WORK_AUTH"
				].includes(requirement.requirement_type))) {
					const { rows: activeProfileRows } = await client.query(`SELECT id
             FROM profile_versions
             WHERE workspace_id = $1
               AND status = 'ACTIVE'
             ORDER BY created_at DESC
             LIMIT 1`, [ctx.workspaceId]);
					const activeProfileVersionId = activeProfileRows[0]?.id ?? null;
					const { rows: profileFactRows } = await client.query(`SELECT pf.id, pf.statement, pf.structured_value
             FROM profile_facts pf
             WHERE pf.workspace_id = $1
             ${activeProfileVersionId ? "AND pf.profile_version_id = $2" : "AND FALSE"}`, activeProfileVersionId ? [ctx.workspaceId, activeProfileVersionId] : [ctx.workspaceId]);
					profileFacts = profileFactRows;
					const { rows: credentialRows } = await client.query(`SELECT pc.id, pc.credential_name, pc.issuer, pc.credential_type, pc.level
             FROM profile_credentials pc
             WHERE pc.workspace_id = $1
               ${activeProfileVersionId ? "AND pc.profile_version_id = $2" : "AND FALSE"}
             AND pc.status = 'ACTIVE'`, activeProfileVersionId ? [ctx.workspaceId, activeProfileVersionId] : [ctx.workspaceId]);
					profileFacts = profileFacts.concat(credentialRows.map((credential) => ({
						id: credential.id,
						statement: `${credential.credential_name} ${credential.issuer} ${credential.level || ""}`.trim(),
						structured_value: {
							credential_type: credential.credential_type,
							level: credential.level
						},
						source_type: "CREDENTIAL"
					})));
					const { rows: engagementRows } = await client.query(`SELECT id, start_date, end_date, is_current, experience_class,
                    engagement_type, role_title, summary, operating_model
             FROM profile_engagements
             WHERE profile_version_id = $1`, [activeProfileVersionId]);
					const experienceYears = calculateProfessionalExperienceYears(engagementRows);
					for (const engagement of engagementRows) {
						if (engagement.experience_class !== "PROFESSIONAL_PRODUCTION") continue;
						const start = new Date(engagement.start_date).getTime();
						const end = engagement.is_current || !engagement.end_date ? Date.now() : new Date(engagement.end_date).getTime();
						if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
						const years = (end - start) / 315576e5;
						profileFacts.push({
							id: engagement.id,
							statement: `${engagement.role_title}: ${engagement.summary}`,
							structured_value: {
								experience_years: years,
								experience_scope: `${engagement.role_title} ${engagement.summary}`,
								engagement_type: engagement.engagement_type,
								operating_model: engagement.operating_model,
								experience_start_date: new Date(engagement.start_date).toISOString(),
								experience_end_date: new Date(end).toISOString(),
								engagement_is_current: engagement.is_current
							},
							source_type: "PROFILE_FACT"
						});
					}
					if (experienceYears > 0) profileFacts.push({
						id: `experience:${ctx.workspaceId}`,
						statement: `${experienceYears.toFixed(1)} years of professional production experience`,
						structured_value: {
							professional_years: experienceYears,
							experience_scope: "overall professional production"
						},
						source_type: "CREDENTIAL"
					});
				}
				const requirementHints = deterministicRequirements.map((r) => r.quote_text || r.requirement_text).filter(Boolean).slice(0, 60).join("\n");
				const gateResult = combineGateResults([
					applyGlobalGates({
						...rawJobAdapter,
						raw_description: requirementHints ? `${rawJobAdapter.raw_description}\n\n---\nExtracted requirements:\n${requirementHints}` : rawJobAdapter.raw_description
					}, policyResolution.policy, jobAnswerContext),
					applyPersistedRequirementGates({
						title: rawJobAdapter.title,
						company_name: rawJobAdapter.company_name,
						employment_type: rawJobAdapter.employment_type,
						workplace_type: rawJobAdapter.workplace_type,
						description: rawJobAdapter.raw_description
					}, deterministicRequirements, policyResolution.policy, jobAnswerContext),
					applyExactProfileGates(deterministicRequirements, profileFacts, jobAnswerContext)
				]);
				let processingStatus;
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
				await client.query(`UPDATE canonical_jobs
           SET gate_decision      = $1,
               processing_state   = $2,
               processing_status  = $2,
               rejection_reason   = $3,
               gate_evidence_quotes = $4,
               workability_facts  = $5,
               primary_lane = CASE WHEN $8::boolean THEN NULL ELSE primary_lane END,
               secondary_lanes = CASE WHEN $8::boolean THEN NULL ELSE secondary_lanes END,
               lane_confidence = CASE WHEN $8::boolean THEN NULL ELSE lane_confidence END,
               lane_evidence = CASE WHEN $8::boolean THEN NULL ELSE lane_evidence END,
               semantic_score = CASE WHEN $8::boolean THEN 0.0 ELSE semantic_score END,
               deterministic_match_score = CASE WHEN $8::boolean THEN NULL ELSE deterministic_match_score END,
               deterministic_match_coverage = CASE WHEN $8::boolean THEN NULL ELSE deterministic_match_coverage END,
               latest_match_run_id = CASE WHEN $8::boolean THEN NULL ELSE latest_match_run_id END,
               latest_lane_decision_id = CASE WHEN $8::boolean THEN NULL ELSE latest_lane_decision_id END,
               latest_deterministic_decision_id = CASE WHEN $8::boolean THEN NULL ELSE latest_deterministic_decision_id END,
               recommendation_eligibility = CASE WHEN $8::boolean THEN NULL ELSE recommendation_eligibility END,
               recommendation_outcome = CASE WHEN $8::boolean THEN NULL ELSE recommendation_outcome END,
               recommendation_requirement_score = CASE WHEN $8::boolean THEN NULL ELSE recommendation_requirement_score END,
               recommendation_coverage_score = CASE WHEN $8::boolean THEN NULL ELSE recommendation_coverage_score END,
               recommendation_evidence_completeness = CASE WHEN $8::boolean THEN NULL ELSE recommendation_evidence_completeness END,
               recommendation_decided_at = CASE WHEN $8::boolean THEN NULL ELSE recommendation_decided_at END,
               updated_at         = NOW()
           WHERE workspace_id = $6
             AND id = $7`, [
					gateResult.status,
					processingStatus,
					gateResult.rejection_codes.length > 0 ? gateResult.rejection_codes.join(", ") : null,
					JSON.stringify(gateResult.evidence_quotes),
					JSON.stringify(gateResult.workability_facts),
					ctx.workspaceId,
					job.id,
					reprocess
				]);
				const persistedGateDecision = PersistedGateDecisionSchema.parse({
					schema_version: GATE_VERSION,
					canonical_job_id: job.id,
					job_version_id: job.job_version_id,
					pipeline_run_id: pipelineRunId,
					gate_version: GATE_VERSION,
					status: gateResult.status,
					rejection_codes: gateResult.rejection_codes,
					evidence_quotes: gateResult.evidence_quotes,
					workability_facts: gateResult.workability_facts,
					evaluated_at: (/* @__PURE__ */ new Date()).toISOString()
				});
				await client.query(`INSERT INTO gate_decisions (
             workspace_id,
             canonical_job_id, job_version_id, pipeline_run_id, gate_version,
             decision, rejection_codes, evidence_quotes, workability_facts
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
					ctx.workspaceId,
					persistedGateDecision.canonical_job_id,
					persistedGateDecision.job_version_id,
					persistedGateDecision.pipeline_run_id,
					persistedGateDecision.gate_version,
					persistedGateDecision.status,
					JSON.stringify(persistedGateDecision.rejection_codes),
					JSON.stringify(persistedGateDecision.evidence_quotes),
					JSON.stringify(persistedGateDecision.workability_facts)
				]);
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
		if (ownsClient && typeof client.release === "function") client.release();
	}
	console.log(`Hard Gates complete. Passed: ${passedCount}, Hard Rejected: ${rejectedCount}, Needs Verification: ${needsVerificationCount}, Errors: ${errorCount}`);
	return {
		passed: passedCount,
		hardRejected: rejectedCount,
		needsVerification: needsVerificationCount,
		errors: errorCount
	};
}
//#endregion
//#region src/db/db.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var databaseUrl$1 = process.env.DATABASE_URL;
var pool$1 = new pg.default.Pool(pgPoolConfig(databaseUrl$1));
pool$1.on("error", (err) => {
	console.error("Unexpected error on idle database client:", err.message || err);
});
async function verifyUrlLive(url, bypassLiveCheck = false) {
	if (!url) return false;
	if (bypassLiveCheck) return true;
	const validDomains = [
		"linkedin.com",
		"mycareersfuture.gov.sg",
		"efinancialcareers.com",
		"efinancialcareers.sg"
	];
	try {
		const parsed = new URL(url);
		if (!validDomains.some((domain) => parsed.hostname.includes(domain))) {
			console.log(`❌ URL Verification Failed: Domain not in scope (${url})`);
			return false;
		}
	} catch {
		console.log(`❌ URL Verification Failed: Invalid URL format (${url})`);
		return false;
	}
	if (bypassLiveCheck) return true;
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
			redirect: "follow",
			signal: AbortSignal.timeout(6e3)
		});
		if (response.status === 404 || response.status === 410) {
			console.log(`❌ URL Verification Failed: HTTP Status ${response.status} (${url})`);
			return false;
		}
		const finalUrl = response.url.toLowerCase();
		if (finalUrl.includes("expired") || finalUrl.includes("not-found") || finalUrl.includes("job-not-found") || finalUrl.includes("inactive")) {
			console.log(`❌ URL Verification Failed: Redirected to expired page: ${response.url}`);
			return false;
		}
		return true;
	} catch (err) {
		console.log(`⚠️ URL Verification Warning: Could not reach URL due to network/access restriction, allowing format-only check. (${err.message || err})`);
		return true;
	}
}
var DEFAULT_JOBS = [];
function mapRowToJob(row) {
	return {
		id: row.id,
		content_hash: row.content_hash || void 0,
		title: row.title,
		company_name: row.company_name,
		source: row.source,
		raw_description: row.raw_description,
		salary_range: row.salary_range || void 0,
		posted_date: row.posted_date ? new Date(row.posted_date).toISOString().split("T")[0] : void 0,
		location: row.location || void 0,
		careers_portal_url: row.careers_portal_url,
		processing_status: row.processing_status || void 0,
		rejection_code: row.rejection_code || void 0,
		gate_version: row.gate_version || void 0,
		primary_lane: row.primary_lane || void 0,
		secondary_lanes: row.secondary_lanes || void 0,
		lane_confidence: row.lane_confidence || void 0,
		lane_evidence: row.lane_evidence || void 0,
		source_lane: row.source_lane || void 0,
		nd_friendly_score: row.nd_friendly_score !== null ? parseInt(row.nd_friendly_score) : void 0,
		politics_stress_score: row.politics_stress_score !== null ? parseInt(row.politics_stress_score) : void 0,
		sensory_overload_index: row.sensory_overload_index !== null ? parseInt(row.sensory_overload_index) : void 0,
		biological_stress_risk: row.biological_stress_risk || void 0,
		strategic_value: row.strategic_value || void 0,
		recommended_cv_version: row.recommended_cv_version || void 0,
		next_action: row.next_action || void 0,
		is_top_ten: row.is_top_ten || false,
		nd_gate_status: row.nd_gate_status || void 0,
		nd_score: row.nd_score !== null ? parseInt(row.nd_score) : void 0,
		nd_evidence: row.nd_evidence || void 0,
		nd_risk_flags: row.nd_risk_flags || void 0,
		work_mode_status: row.work_mode_status || void 0,
		office_days: row.office_days !== null ? parseInt(row.office_days) : void 0,
		interaction_load: row.interaction_load !== null ? parseInt(row.interaction_load) : void 0,
		building_research_ratio: row.building_research_ratio !== null ? parseInt(row.building_research_ratio) : void 0,
		rejection_codes: row.rejection_codes || void 0
	};
}
async function updateCompanyRatings(companyId) {
	const statsRes = await pool$1.query(`SELECT 
       AVG(nd_friendly_score) as avg_nd,
       AVG(politics_stress_score) as avg_pol,
       AVG(sensory_overload_index) as avg_sens,
       0 as avg_focus
     FROM jobs 
     WHERE company_id = $1 AND processing_status != 'PENDING_GLOBAL_GATE'`, [companyId]);
	if (statsRes.rows.length > 0) {
		const r = statsRes.rows[0];
		const avgND = r.avg_nd ? parseFloat(r.avg_nd) : 0;
		const avgPol = r.avg_pol ? parseFloat(r.avg_pol) : 0;
		const avgSens = r.avg_sens ? parseFloat(r.avg_sens) : 0;
		const avgFocus = 0;
		const isApproved = avgND >= 70 && avgPol < 50;
		const isToxic = avgPol >= 70 || avgND < 50;
		await pool$1.query(`UPDATE companies SET
         nd_friendly_avg_score = $2,
         politics_stress_avg_score = $3,
         sensory_overload_avg_index = $4,
         focus_protection_avg_score = $5,
         is_neurodivergent_approved = $6,
         is_toxic_culture_blacklisted = $7,
         updated_at = NOW()
       WHERE id = $1`, [
			companyId,
			avgND,
			avgPol,
			avgSens,
			avgFocus,
			isApproved,
			isToxic
		]);
	}
}
var PostgresDatabase = class {
	async queryJobs(searchTerm) {
		if (!searchTerm) return (await pool$1.query("SELECT * FROM jobs ORDER BY created_at DESC")).rows.map(mapRowToJob);
		const lower = `%${searchTerm.toLowerCase()}%`;
		return (await pool$1.query(`SELECT * FROM jobs 
       WHERE title ILIKE $1 OR company_name ILIKE $1 OR raw_description::text ILIKE $1 
       ORDER BY created_at DESC`, [lower])).rows.map(mapRowToJob);
	}
	async addJob(job, bypassLiveCheck = false) {
		if (!job.processing_status || job.processing_status === "PENDING_GLOBAL_GATE") throw new Error("Cannot insert unevaluated jobs into the final jobs table.");
		let existingJob;
		if (job.content_hash) existingJob = await pool$1.query("SELECT id FROM jobs WHERE content_hash = $1", [job.content_hash]);
		else existingJob = await pool$1.query("SELECT id FROM jobs WHERE (company_name = $1 AND title = $2) OR careers_portal_url = $3", [
			job.company_name,
			job.title,
			job.careers_portal_url
		]);
		if (existingJob.rows.length > 0) {
			const existingId = existingJob.rows[0].id;
			await this.updateJobEvaluation(existingId, job);
			return mapRowToJob((await pool$1.query("SELECT * FROM jobs WHERE id = $1", [existingId])).rows[0]);
		}
		if (!await verifyUrlLive(job.careers_portal_url, bypassLiveCheck)) throw new Error(`Invalid or expired careers_portal_url: ${job.careers_portal_url}`);
		let companyId = null;
		const compRes = await pool$1.query("SELECT id FROM companies WHERE name = $1", [job.company_name]);
		if (compRes.rows.length > 0) companyId = compRes.rows[0].id;
		else {
			const industry = job.title.toLowerCase().includes("bio") || job.title.toLowerCase().includes("pharma") ? "Life Sciences & Biotech" : "Institutional Finance & Asset AI";
			companyId = (await pool$1.query("INSERT INTO companies (name, industry, website_url, careers_page_url) VALUES ($1, $2, $3, $4) RETURNING id", [
				job.company_name,
				industry,
				`https://www.${job.company_name.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
				job.careers_portal_url
			])).rows[0].id;
		}
		let finalDesc = job.raw_description;
		if (finalDesc && typeof finalDesc === "string" && !finalDesc.trim().startsWith("{")) finalDesc = JSON.stringify({
			job_description: finalDesc,
			key_responsibilities: [],
			technical_skills: [],
			qualifications_education: [],
			nice_to_haves: []
		});
		const insertJob = await pool$1.query(`INSERT INTO jobs (
        content_hash, company_name, company_id, title, source, raw_description, salary_range, location, posted_date, careers_portal_url,
        processing_status, rejection_code, gate_version, primary_lane, secondary_lanes, lane_confidence, lane_evidence, source_lane,
        nd_friendly_score, politics_stress_score, sensory_overload_index, biological_stress_risk, strategic_value, recommended_cv_version, next_action, is_top_ten,
        nd_gate_status, nd_score, nd_evidence, nd_risk_flags, work_mode_status, office_days, interaction_load, building_research_ratio, rejection_codes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35) RETURNING *`, [
			job.content_hash || null,
			job.company_name,
			companyId,
			job.title,
			job.source,
			finalDesc,
			job.salary_range || null,
			job.location || null,
			job.posted_date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
			job.careers_portal_url,
			job.processing_status || "EVALUATED",
			job.rejection_code || null,
			job.gate_version || null,
			job.primary_lane || null,
			job.secondary_lanes ? JSON.stringify(job.secondary_lanes) : null,
			job.lane_confidence || null,
			job.lane_evidence || null,
			job.source_lane || null,
			job.nd_friendly_score || null,
			job.politics_stress_score || null,
			job.sensory_overload_index || 0,
			job.biological_stress_risk || null,
			job.strategic_value || null,
			job.recommended_cv_version || null,
			job.next_action || null,
			job.is_top_ten || false,
			job.nd_gate_status || null,
			job.nd_score || null,
			job.nd_evidence || null,
			job.nd_risk_flags ? JSON.stringify(job.nd_risk_flags) : null,
			job.work_mode_status || null,
			job.office_days || null,
			job.interaction_load || null,
			job.building_research_ratio || null,
			job.rejection_codes ? JSON.stringify(job.rejection_codes) : null
		]);
		if (companyId) await updateCompanyRatings(companyId);
		return mapRowToJob(insertJob.rows[0]);
	}
	async updateJobEvaluation(id, evaluation) {
		const res = await pool$1.query(`
      UPDATE jobs SET
        processing_status = COALESCE($2, processing_status),
        rejection_code = COALESCE($3, rejection_code),
        gate_version = COALESCE($4, gate_version),
        primary_lane = COALESCE($5, primary_lane),
        secondary_lanes = COALESCE($6, secondary_lanes),
        lane_confidence = COALESCE($7, lane_confidence),
        lane_evidence = COALESCE($8, lane_evidence),
        source_lane = COALESCE($9, source_lane),
        nd_friendly_score = COALESCE($10, nd_friendly_score),
        politics_stress_score = COALESCE($11, politics_stress_score),
        sensory_overload_index = COALESCE($12, sensory_overload_index),
        biological_stress_risk = COALESCE($13, biological_stress_risk),
        strategic_value = COALESCE($14, strategic_value),
        recommended_cv_version = COALESCE($15, recommended_cv_version),
        next_action = COALESCE($16, next_action),
        careers_portal_url = COALESCE($17, careers_portal_url),
        nd_gate_status = COALESCE($18, nd_gate_status),
        nd_score = COALESCE($19, nd_score),
        nd_evidence = COALESCE($20, nd_evidence),
        nd_risk_flags = COALESCE($21, nd_risk_flags),
        work_mode_status = COALESCE($22, work_mode_status),
        office_days = COALESCE($23, office_days),
        interaction_load = COALESCE($24, interaction_load),
        building_research_ratio = COALESCE($25, building_research_ratio),
        rejection_codes = COALESCE($26, rejection_codes),
        updated_at = NOW()
      WHERE id = $1
    `, [
			id,
			evaluation.processing_status,
			evaluation.rejection_code,
			evaluation.gate_version,
			evaluation.primary_lane,
			evaluation.secondary_lanes ? JSON.stringify(evaluation.secondary_lanes) : void 0,
			evaluation.lane_confidence,
			evaluation.lane_evidence,
			evaluation.source_lane,
			evaluation.nd_friendly_score,
			evaluation.politics_stress_score,
			evaluation.sensory_overload_index,
			evaluation.biological_stress_risk,
			evaluation.strategic_value,
			evaluation.recommended_cv_version,
			evaluation.next_action,
			evaluation.careers_portal_url,
			evaluation.nd_gate_status,
			evaluation.nd_score,
			evaluation.nd_evidence,
			evaluation.nd_risk_flags ? JSON.stringify(evaluation.nd_risk_flags) : void 0,
			evaluation.work_mode_status,
			evaluation.office_days,
			evaluation.interaction_load,
			evaluation.building_research_ratio,
			evaluation.rejection_codes ? JSON.stringify(evaluation.rejection_codes) : void 0
		]);
		const jobRes = await pool$1.query("SELECT company_id FROM jobs WHERE id = $1", [id]);
		if (jobRes.rows.length > 0 && jobRes.rows[0].company_id) await updateCompanyRatings(jobRes.rows[0].company_id);
		return res.rowCount !== null && res.rowCount > 0;
	}
	async deleteJob(id) {
		const jobRes = await pool$1.query("SELECT company_id FROM jobs WHERE id = $1", [id]);
		const res = await pool$1.query("DELETE FROM jobs WHERE id = $1", [id]);
		if (jobRes.rows.length > 0 && jobRes.rows[0].company_id) await updateCompanyRatings(jobRes.rows[0].company_id);
		return res.rowCount !== null && res.rowCount > 0;
	}
	async logInteraction(question, toolsUsed, answer, trace) {
		return (await pool$1.query(`INSERT INTO interactions_log (question, tools_used, agent_trace, structured_answer) 
       VALUES ($1, $2, $3, $4) RETURNING id, created_at as timestamp, question, tools_used as "toolsUsed", agent_trace as trace, structured_answer as answer`, [
			question,
			toolsUsed,
			trace,
			JSON.stringify(answer)
		])).rows[0];
	}
	async getInteractions() {
		return (await pool$1.query(`SELECT id, created_at as timestamp, question, tools_used as "toolsUsed", structured_answer as answer, agent_trace as trace 
       FROM interactions_log ORDER BY created_at DESC`)).rows;
	}
	async clearInteractions() {
		await pool$1.query("DELETE FROM interactions_log");
	}
	/**
	* Analytics Aggregation Engine
	* Dynamically compiles company metrics from the database.
	*/
	async getNdCultureAnalytics() {
		const approved = await pool$1.query("SELECT * FROM nd_approved_companies");
		const toxic = await pool$1.query("SELECT * FROM nd_blacklisted_companies");
		const totalRes = await pool$1.query("SELECT COUNT(*) as count FROM companies");
		return {
			ndApproved: approved.rows.map((r) => ({
				company: r.name,
				industry: r.industry,
				careers_portal_url: r.careers_page_url,
				nd_friendly_score: Math.round(parseFloat(r.nd_score || "50")),
				politics_stress_score: Math.round(parseFloat(r.politics_index || "50")),
				sensory_overload_index: 30,
				avg_match_score: 85,
				is_nd_approved: true,
				is_toxic: false
			})),
			toxicBlacklist: toxic.rows.map((r) => ({
				company: r.name,
				industry: r.industry,
				careers_portal_url: r.careers_page_url,
				nd_friendly_score: Math.round(parseFloat(r.nd_score || "50")),
				politics_stress_score: Math.round(parseFloat(r.toxic_politics_score || "50")),
				sensory_overload_index: Math.round(parseFloat(r.sensory_hazard_index || "50")),
				avg_match_score: 0,
				is_nd_approved: false,
				is_toxic: true
			})),
			allCompaniesCount: parseInt(totalRes.rows[0]?.count || "0")
		};
	}
	async addRawJob(job) {
		if (job.company_name) {
			const industry = job.title.toLowerCase().includes("bio") || job.title.toLowerCase().includes("pharma") ? "Life Sciences & Biotech" : "Institutional Finance & Asset AI";
			await pool$1.query("INSERT INTO raw_companies (name, industry, website_url, careers_page_url) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING", [
				job.company_name,
				industry,
				`https://www.${job.company_name.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
				job.careers_portal_url
			]);
		}
		let finalRawDesc = job.raw_description;
		if (finalRawDesc && typeof finalRawDesc === "string" && !finalRawDesc.trim().startsWith("{")) finalRawDesc = JSON.stringify({
			job_description: finalRawDesc,
			key_responsibilities: [],
			technical_skills: [],
			qualifications_education: [],
			nice_to_haves: []
		});
		return (await pool$1.query(`INSERT INTO raw_jobs (content_hash, company_name, title, source, raw_description, salary_range, location, posted_date, careers_portal_url, processed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE) RETURNING *`, [
			job.content_hash || null,
			(job.company_name || "Unknown").substring(0, 255),
			(job.title || "Unknown").substring(0, 255),
			(job.source || "Unknown").substring(0, 50),
			finalRawDesc,
			job.salary_range ? job.salary_range.substring(0, 255) : null,
			job.location ? job.location.substring(0, 255) : null,
			job.posted_date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
			job.careers_portal_url
		])).rows[0];
	}
	async queryRawJobs(unprocessedOnly = true) {
		const queryStr = unprocessedOnly ? "SELECT * FROM raw_jobs WHERE processed = FALSE ORDER BY created_at DESC" : "SELECT * FROM raw_jobs ORDER BY created_at DESC";
		return (await pool$1.query(queryStr)).rows;
	}
	async markRawJobProcessed(id) {
		const res = await pool$1.query("UPDATE raw_jobs SET processed = TRUE, processed_at = NOW() WHERE id = $1", [id]);
		return res.rowCount !== null && res.rowCount > 0;
	}
	async resetToDefaults() {
		await pool$1.query("DELETE FROM jobs");
		await pool$1.query("DELETE FROM companies");
		await pool$1.query("DELETE FROM interactions_log");
		await pool$1.query("DELETE FROM raw_jobs");
		await pool$1.query("DELETE FROM raw_companies");
		for (const job of DEFAULT_JOBS) await this.addJob(job, true);
	}
};
new PostgresDatabase();
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
		const contentHash = sha256Hex(stableStringify(normalizedContent));
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
async function recordModelRouteInvocation(input, clientOrPool, options) {
	const isPool = (value) => {
		const maybe = value;
		return value instanceof pg.default.Pool || typeof maybe?.connect === "function" && typeof maybe?.query === "function" && "totalCount" in maybe && "idleCount" in maybe && "waitingCount" in maybe || typeof maybe?.connect === "function" && typeof maybe?.query !== "function" && typeof maybe?.release !== "function";
	};
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		return (await client.query(`
        INSERT INTO model_route_invocations (
          workspace_id,
          model_route_id,
          model_route_revision_id,
          purpose,
          provider,
          model,
          status,
          fallback_used,
          request_hash,
          request_metadata,
          response_metadata,
          latency_ms,
          cost_usd,
          tokens_prompt,
          tokens_completion,
          tokens_total,
          error_message,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
        RETURNING id
      `, [
			ctx.workspaceId,
			input.routeId ?? null,
			input.revisionId ?? null,
			input.purpose,
			input.provider ?? null,
			input.model ?? null,
			input.status,
			input.fallbackUsed === true,
			input.requestHash,
			input.requestMetadata ?? null,
			input.responseMetadata ?? null,
			input.latencyMs ?? null,
			input.costUsd ?? null,
			input.tokensPrompt ?? null,
			input.tokensCompletion ?? null,
			input.tokensTotal ?? null,
			input.errorMessage ?? null
		])).rows[0].id;
	} catch (error) {
		if (error?.code === "42P01") return null;
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/services/agent.ts
var agent_exports = /* @__PURE__ */ __exportAll({
	MODEL_REGISTRY: () => MODEL_REGISTRY,
	generateContentAudited: () => generateContentAudited,
	generateEmbedding: () => generateEmbedding,
	generateEmbeddingWithProvider: () => generateEmbeddingWithProvider,
	generateEmbeddingWithProviderAndModel: () => generateEmbeddingWithProviderAndModel,
	getGeminiClient: () => getGeminiClient,
	preflightModelRoutes: () => preflightModelRoutes
});
dotenv.default.config();
dotenv.default.config({
	path: ".env.local",
	override: true
});
var MODEL_REGISTRY = {
	EVALUATION_PRIMARY_MODEL: process.env.EVALUATION_PRIMARY_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash",
	EVALUATION_FALLBACK_MODEL: process.env.EVALUATION_FALLBACK_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
	EMBEDDING_PRIMARY_MODEL: process.env.EMBEDDING_PRIMARY_MODEL || "gemini-embedding-001",
	EMBEDDING_FALLBACK_MODEL: process.env.EMBEDDING_FALLBACK_MODEL || "text-embedding-3-small",
	DOCUMENT_PRIMARY_MODEL: process.env.DOCUMENT_PRIMARY_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash",
	DOCUMENT_FALLBACK_MODEL: process.env.DOCUMENT_FALLBACK_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
	EXTRACTION_GEMINI_MODEL: process.env.REQUIREMENTS_GEMINI_MODEL || process.env.EXTRACTION_GEMINI_MODEL || "gemini-3.5-flash-lite",
	EXTRACTION_OPENAI_MODEL: process.env.REQUIREMENTS_OPENAI_MODEL || process.env.EXTRACTION_OPENAI_MODEL || "gpt-5.6-luna"
};
function resolveProviderOrder(primaryProviderRaw) {
	const normalized = (primaryProviderRaw || "").trim().toLowerCase();
	if (normalized === "openai") return ["openai", "gemini"];
	if (normalized === "gemini") return ["gemini", "openai"];
	if (process.env.FORCE_OPENAI === "true") return ["openai", "gemini"];
	return ["gemini", "openai"];
}
function extractionPrimaryProvider() {
	return process.env.REQUIREMENTS_PRIMARY_PROVIDER || process.env.EXTRACTION_PRIMARY_PROVIDER || "openai";
}
function extractionGeminiModel() {
	return process.env.REQUIREMENTS_GEMINI_MODEL || process.env.EXTRACTION_GEMINI_MODEL || MODEL_REGISTRY.EXTRACTION_GEMINI_MODEL;
}
function extractionOpenAIModel() {
	return process.env.REQUIREMENTS_OPENAI_MODEL || process.env.EXTRACTION_OPENAI_MODEL || MODEL_REGISTRY.EXTRACTION_OPENAI_MODEL;
}
function modelRequestMaxRetries() {
	const parsed = Number.parseInt(String(process.env.MODEL_REQUEST_MAX_RETRIES || "3"), 10);
	if (!Number.isFinite(parsed)) return 3;
	return Math.max(1, Math.min(5, parsed));
}
function modelRequestTimeoutMs() {
	const parsed = Number.parseInt(String(process.env.MODEL_REQUEST_TIMEOUT_MS || "60000"), 10);
	if (!Number.isFinite(parsed)) return 6e4;
	return Math.max(5e3, Math.min(3e5, parsed));
}
function finiteUsageNumber(value) {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : void 0;
}
function finiteMoneyNumber(value) {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
function extractTokenUsage(value) {
	const usage = value?.usage || value?.usageMetadata || value?.response_metadata?.token_usage || {};
	return {
		promptTokens: finiteUsageNumber(usage.prompt_tokens ?? usage.promptTokenCount ?? usage.input_tokens ?? usage.inputTokenCount),
		completionTokens: finiteUsageNumber(usage.completion_tokens ?? usage.candidatesTokenCount ?? usage.output_tokens ?? usage.outputTokenCount),
		totalTokens: finiteUsageNumber(usage.total_tokens ?? usage.totalTokenCount ?? usage.total_tokens_count)
	};
}
function recordProviderAttempt(options, attempt) {
	if (Array.isArray(options?.__providerAttemptTelemetry)) options.__providerAttemptTelemetry.push(attempt);
}
function summarizeSuccessfulUsage(attempts, provider, model) {
	const success = [...attempts].reverse().find((attempt) => attempt.status === "COMPLETED" && attempt.provider === provider && attempt.model === model);
	if (!success) return null;
	const promptTokens = success.promptTokens ?? 0;
	const completionTokens = success.completionTokens ?? 0;
	const totalTokens = success.totalTokens ?? promptTokens + completionTokens;
	if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;
	return {
		promptTokens,
		completionTokens,
		totalTokens
	};
}
function configuredModelPricing(provider, model) {
	const raw = process.env.MODEL_PRICING_JSON;
	if (!raw || raw.trim() === "") return null;
	try {
		const parsed = JSON.parse(raw);
		const keys = [
			`${provider}:${model}`,
			model,
			provider
		];
		for (const key of keys) {
			const pricing = parsed[key];
			const inputPer1M = finiteMoneyNumber(pricing?.input_per_1m ?? pricing?.inputPer1M ?? pricing?.prompt_per_1m ?? pricing?.promptPer1M);
			const outputPer1M = finiteMoneyNumber(pricing?.output_per_1m ?? pricing?.outputPer1M ?? pricing?.completion_per_1m ?? pricing?.completionPer1M);
			if (inputPer1M !== void 0 && outputPer1M !== void 0) return {
				inputPer1M,
				outputPer1M
			};
		}
	} catch {
		return null;
	}
	return null;
}
function estimateCostUsd(provider, model, usage) {
	if (!usage) return null;
	const pricing = configuredModelPricing(provider, model);
	if (!pricing) return null;
	const cost = usage.promptTokens / 1e6 * pricing.inputPer1M + usage.completionTokens / 1e6 * pricing.outputPer1M;
	return Number(cost.toFixed(6));
}
function embeddingRequestTimeoutMs() {
	const parsed = Number.parseInt(String(process.env.EMBEDDING_REQUEST_TIMEOUT_MS || process.env.MODEL_REQUEST_TIMEOUT_MS || "30000"), 10);
	if (!Number.isFinite(parsed)) return 3e4;
	return Math.max(5e3, Math.min(12e4, parsed));
}
function isRetryableModelRequestError(error) {
	const status = Number(error?.status);
	if (Number.isFinite(status)) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
	const message = String(error?.message || error || "").toLowerCase();
	return error?.name === "AbortError" || error?.name === "TimeoutError" || message.includes("timeout") || message.includes("timed out") || message.includes("econnreset") || message.includes("etimedout") || message.includes("fetch failed") || message.includes("network");
}
var aiClient = null;
var aiClientConfigKey = null;
function getGeminiClient() {
	const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
	const apiVersionRaw = (process.env.GEMINI_API_VERSION || "").trim();
	const configKey = `${apiKey || ""}\u0000${apiVersionRaw}`;
	if (!aiClient || aiClientConfigKey !== configKey) {
		if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") throw new Error("GEMINI_API_KEY is not configured for the requested Gemini model.");
		aiClient = new _google_genai.GoogleGenAI({
			apiKey,
			apiVersion: apiVersionRaw || void 0,
			httpOptions: {
				headers: { "User-Agent": "aistudio-build" },
				timeout: 45e3
			}
		});
		aiClientConfigKey = configKey;
	}
	return aiClient;
}
_google_genai.Type.OBJECT, _google_genai.Type.STRING;
async function tryGemini(geminiKey, options) {
	const ai = getGeminiClient();
	const maxRetries = modelRequestMaxRetries();
	const timeoutMs = modelRequestTimeoutMs();
	const model = options.model || MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const startedAt = Date.now();
		try {
			console.log(`[model:gemini] model=${model} attempt=${attempt}/${maxRetries} starting timeout=${Math.round(timeoutMs / 1e3)}s`);
			const response = await ai.models.generateContent({
				model,
				contents: options.contents,
				config: {
					abortSignal: AbortSignal.timeout(timeoutMs),
					httpOptions: { timeout: timeoutMs },
					responseMimeType: options.responseMimeType,
					responseSchema: options.responseSchema,
					systemInstruction: options.systemInstruction
				}
			});
			const usage = extractTokenUsage(response);
			console.log(`[model:gemini] model=${model} attempt=${attempt}/${maxRetries} completed elapsed_ms=${Date.now() - startedAt}`);
			recordProviderAttempt(options, {
				provider: "gemini",
				model,
				attempt,
				maxAttempts: maxRetries,
				status: "COMPLETED",
				latencyMs: Date.now() - startedAt,
				...usage
			});
			return response.text || "";
		} catch (gErr) {
			const isDailyQuota = gErr.message?.includes("GenerateRequestsPerDay") || gErr.message?.includes("free_tier_requests") || gErr.message?.includes("quota");
			const isRateLimit = gErr.message?.includes("RESOURCE_EXHAUSTED") || gErr.status === 429;
			const isTimeout = gErr.name === "AbortError" || gErr.message?.includes("timeout") || gErr.message?.includes("aborted");
			const retryable = !isDailyQuota && (isRateLimit || isTimeout);
			recordProviderAttempt(options, {
				provider: "gemini",
				model,
				attempt,
				maxAttempts: maxRetries,
				status: "FAILED",
				httpStatus: finiteUsageNumber(gErr.status) ?? null,
				retryable: retryable && attempt < maxRetries,
				latencyMs: Date.now() - startedAt,
				error: gErr.message || String(gErr)
			});
			if (isDailyQuota) throw gErr;
			if ((isRateLimit || isTimeout) && attempt < maxRetries) {
				const backoffMs = Math.pow(3, attempt - 1) * 5e3;
				console.warn(`⏳ Gemini request failed (${isRateLimit ? "RateLimit" : "Timeout"}). Attempt ${attempt}/${maxRetries}. Retrying in ${backoffMs / 1e3}s...`);
				await new Promise((resolve) => setTimeout(resolve, backoffMs));
			} else throw gErr;
		}
	}
	return "";
}
async function tryOpenAICompatible(apiKey, baseUrl, model, options, isKimi = false) {
	const messages = [];
	if (options.systemInstruction) messages.push({
		role: "system",
		content: options.systemInstruction
	});
	messages.push({
		role: "user",
		content: options.contents
	});
	const maxRetries = modelRequestMaxRetries();
	const timeoutMs = modelRequestTimeoutMs();
	const providerLabel = isKimi ? "kimi" : "openai";
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const startedAt = Date.now();
		try {
			console.log(`[model:${providerLabel}] model=${model} attempt=${attempt}/${maxRetries} starting timeout=${Math.round(timeoutMs / 1e3)}s`);
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`,
					"User-Agent": "Claude-Code"
				},
				body: JSON.stringify({
					model,
					messages,
					temperature: 1,
					response_format: options.responseSchema && !isKimi ? {
						type: "json_schema",
						json_schema: {
							name: "extraction",
							strict: true,
							schema: options.responseSchema
						}
					} : options.responseMimeType === "application/json" ? { type: "json_object" } : void 0
				}),
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (!response.ok) {
				const errorText = await response.text();
				const err = /* @__PURE__ */ new Error(`API request failed with status ${response.status}: ${errorText}`);
				err.status = response.status;
				const retryAfterStr = response.headers.get("Retry-After");
				if (retryAfterStr) {
					const parsed = parseInt(retryAfterStr, 10);
					if (!isNaN(parsed)) err.retryAfterSecs = parsed;
				}
				throw err;
			}
			const data = await response.json();
			const usage = extractTokenUsage(data);
			console.log(`[model:${providerLabel}] model=${model} attempt=${attempt}/${maxRetries} completed elapsed_ms=${Date.now() - startedAt}`);
			recordProviderAttempt(options, {
				provider: providerLabel,
				model,
				attempt,
				maxAttempts: maxRetries,
				status: "COMPLETED",
				httpStatus: response.status,
				latencyMs: Date.now() - startedAt,
				...usage
			});
			return data.choices?.[0]?.message?.content || "";
		} catch (err) {
			const retryable = isRetryableModelRequestError(err);
			recordProviderAttempt(options, {
				provider: providerLabel,
				model,
				attempt,
				maxAttempts: maxRetries,
				status: "FAILED",
				httpStatus: finiteUsageNumber(err.status) ?? null,
				retryable: retryable && attempt < maxRetries,
				latencyMs: Date.now() - startedAt,
				error: err.message || String(err)
			});
			if (attempt === maxRetries || !retryable) throw err;
			const baseBackoff = Math.pow(3, attempt - 1) * 5e3;
			const backoffMs = err.retryAfterSecs ? err.retryAfterSecs * 1e3 : baseBackoff;
			console.warn(`⏳ API request failed (${baseUrl}, Status: ${err.status || "Timeout"}). Attempt ${attempt}/${maxRetries}. Retrying in ${backoffMs / 1e3}s...`);
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
		}
	}
	return "";
}
async function tryOpenAI(openaiKey, options) {
	const baseUrl = "https://api.openai.com/v1";
	const requestedModel = typeof options.model === "string" ? options.model : "";
	return tryOpenAICompatible(openaiKey, baseUrl, requestedModel && !requestedModel.toLowerCase().startsWith("gemini") ? requestedModel : process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL, options, false);
}
function inferPurposeFromModel(model) {
	if (model === MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL || model === MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL) return "DOCUMENT";
	return "EVALUATION";
}
function buildRouteDefaults(purpose) {
	if (purpose === "DOCUMENT") return {
		primaryProviderRaw: process.env.DOCUMENT_PRIMARY_PROVIDER || process.env.EVALUATION_PRIMARY_PROVIDER,
		geminiModel: MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL,
		openaiModel: MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL
	};
	if (purpose === "EMBEDDING") return {
		primaryProviderRaw: process.env.EMBEDDING_PRIMARY_PROVIDER,
		geminiModel: MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL,
		openaiModel: MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL
	};
	if (purpose === "EXTRACTION") return {
		primaryProviderRaw: extractionPrimaryProvider(),
		geminiModel: extractionGeminiModel(),
		openaiModel: extractionOpenAIModel()
	};
	return {
		primaryProviderRaw: process.env.EVALUATION_PRIMARY_PROVIDER,
		geminiModel: MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL,
		openaiModel: process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL
	};
}
function safeText(value) {
	if (typeof value === "string") return value;
	try {
		return stableStringify(value);
	} catch {
		return String(value);
	}
}
async function validateGeneratedResponseText(text, context, validator) {
	if (!text || text.trim().length === 0) throw new Error(`Model ${context.provider}:${context.model} returned empty response text.`);
	if (!validator) return;
	return validator(text, context);
}
async function generateContentAudited(options) {
	const startedAt = Date.now();
	const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	const purpose = options.purpose ?? inferPurposeFromModel(options.model);
	const routeKey = (options.routeKey || purpose.toLowerCase()).trim();
	const { primaryProviderRaw, geminiModel, openaiModel } = buildRouteDefaults(purpose);
	const order = resolveProviderOrder(primaryProviderRaw);
	const explicitModel = String(options.model || "").trim();
	const explicitIsGemini = explicitModel.toLowerCase().startsWith("gemini");
	const geminiModelForCall = explicitIsGemini && explicitModel.length > 0 ? explicitModel : geminiModel;
	const openaiModelForCall = !explicitIsGemini && explicitModel.length > 0 ? explicitModel : openaiModel;
	const defaultContent = {
		primary_provider: order[0],
		primary_model: order[0] === "gemini" ? geminiModelForCall : openaiModelForCall,
		fallback_provider: order[1],
		fallback_model: order[1] === "gemini" ? geminiModelForCall : openaiModelForCall
	};
	let routeId = null;
	let routeRevisionId = null;
	let routeContent = defaultContent;
	if (options.clientOrPool) try {
		const ctx = options.context;
		if (ctx && options.seedRoute === true) {
			const ensured = await ensureModelRouteActiveRevision({
				routeKey,
				purpose,
				description: `Auto-seeded from environment for ${purpose.toLowerCase()} route`,
				content: defaultContent
			}, options.clientOrPool, { context: ctx });
			routeId = ensured.routeId;
			routeRevisionId = ensured.revisionId;
			routeContent = ensured.content;
		} else {
			const active = await getActiveModelRouteRevision(routeKey, options.clientOrPool, ctx ? { context: ctx } : void 0);
			if (active) {
				routeId = active.routeId;
				routeRevisionId = active.revisionId;
				routeContent = active.content;
			}
		}
	} catch (error) {
		if (error?.code !== "42P01") throw error;
	}
	const attemptedErrors = [];
	const providers = [routeContent.primary_provider, routeContent.fallback_provider].filter((value, idx, arr) => arr.indexOf(value) === idx);
	const contentsText = safeText(options.contents);
	const systemText = safeText(options.systemInstruction || "");
	const schemaText = options.responseSchema ? safeText(options.responseSchema) : "";
	const requestHash = sha256Hex(stableStringify({
		purpose,
		routeKey,
		contents_sha256: sha256Hex(contentsText),
		system_sha256: sha256Hex(systemText),
		schema_sha256: schemaText ? sha256Hex(schemaText) : null,
		response_mime_type: options.responseMimeType ?? null
	}));
	const requestMetadata = {
		purpose,
		route_key: routeKey,
		response_mime_type: options.responseMimeType ?? null,
		has_schema: !!options.responseSchema,
		contents_length: contentsText.length,
		system_length: systemText.length,
		model_request_max_retries: modelRequestMaxRetries(),
		model_request_timeout_ms: modelRequestTimeoutMs()
	};
	let successText = null;
	let successValidatedPayload = void 0;
	let successProvider = "gemini";
	let successModel = options.model;
	let attempts = 0;
	const providerAttemptTelemetry = [];
	for (const provider of providers) {
		const isFallbackAttempt = provider !== routeContent.primary_provider;
		const modelForProvider = provider === routeContent.primary_provider ? routeContent.primary_model : routeContent.fallback_model;
		if (provider === "gemini") {
			if (!geminiKey) {
				attemptedErrors.push({
					provider,
					model: modelForProvider,
					error: "GEMINI_API_KEY not configured"
				});
				continue;
			}
			try {
				attempts++;
				const text = await tryGemini(geminiKey, {
					...options,
					model: modelForProvider,
					__providerAttemptTelemetry: providerAttemptTelemetry
				});
				const validatedPayload = await validateGeneratedResponseText(text, {
					provider,
					model: modelForProvider,
					purpose,
					routeKey
				}, options.validateResponseText);
				successText = text;
				successValidatedPayload = validatedPayload;
				successProvider = "gemini";
				successModel = modelForProvider;
				break;
			} catch (err) {
				const message = err?.message || String(err);
				console.warn(`âš ï¸ Gemini request failed (${message}).`);
				attemptedErrors.push({
					provider,
					model: modelForProvider,
					error: message
				});
			}
		}
		if (provider === "openai") {
			if (!openaiKey) {
				attemptedErrors.push({
					provider,
					model: modelForProvider,
					error: "OPENAI_API_KEY not configured"
				});
				continue;
			}
			try {
				attempts++;
				const text = await tryOpenAI(openaiKey, {
					...options,
					model: modelForProvider,
					__providerAttemptTelemetry: providerAttemptTelemetry
				});
				const validatedPayload = await validateGeneratedResponseText(text, {
					provider,
					model: modelForProvider,
					purpose,
					routeKey
				}, options.validateResponseText);
				successText = text;
				successValidatedPayload = validatedPayload;
				successProvider = "openai";
				successModel = modelForProvider;
				break;
			} catch (err) {
				const message = err?.message || String(err);
				console.warn(`âš ï¸ OpenAI request failed (${message}).`);
				attemptedErrors.push({
					provider,
					model: modelForProvider,
					error: message
				});
			}
		}
		if (isFallbackAttempt) {}
	}
	const latencyMs = Date.now() - startedAt;
	const fallbackUsed = successText !== null && successProvider !== routeContent.primary_provider;
	const successfulUsage = summarizeSuccessfulUsage(providerAttemptTelemetry, successProvider, successModel);
	const costUsd = estimateCostUsd(successProvider, successModel, successfulUsage);
	if (successText === null) {
		const errorMessage = `All model API calls failed. Purpose=${purpose}, route=${routeKey}, errors=${attemptedErrors.map((e) => `${e.provider}:${e.model}:${e.error}`).join(" | ")}`;
		if (options.clientOrPool && options.context) await recordModelRouteInvocation({
			routeId,
			revisionId: routeRevisionId,
			purpose,
			provider: attemptedErrors[attemptedErrors.length - 1]?.provider ?? null,
			model: attemptedErrors[attemptedErrors.length - 1]?.model ?? null,
			status: "FAILED",
			fallbackUsed: attemptedErrors.length > 1,
			requestHash,
			requestMetadata,
			responseMetadata: {
				errors: attemptedErrors,
				provider_attempts: providerAttemptTelemetry,
				internal_http_attempts: providerAttemptTelemetry.length
			},
			latencyMs,
			tokensPrompt: successfulUsage?.promptTokens ?? null,
			tokensCompletion: successfulUsage?.completionTokens ?? null,
			tokensTotal: successfulUsage?.totalTokens ?? null,
			costUsd,
			errorMessage
		}, options.clientOrPool, { context: options.context });
		throw new Error(errorMessage);
	}
	let invocationId = null;
	if (options.clientOrPool && options.context) invocationId = await recordModelRouteInvocation({
		routeId,
		revisionId: routeRevisionId,
		purpose,
		provider: successProvider,
		model: successModel,
		status: "COMPLETED",
		fallbackUsed,
		requestHash,
		requestMetadata,
		responseMetadata: {
			response_length: successText.length,
			validated_payload: successValidatedPayload !== void 0,
			errors: attemptedErrors,
			provider_attempts: providerAttemptTelemetry,
			internal_http_attempts: providerAttemptTelemetry.length
		},
		latencyMs,
		tokensPrompt: successfulUsage?.promptTokens ?? null,
		tokensCompletion: successfulUsage?.completionTokens ?? null,
		tokensTotal: successfulUsage?.totalTokens ?? null,
		costUsd
	}, options.clientOrPool, { context: options.context });
	return {
		text: successText,
		provider: successProvider,
		model: successModel,
		fallbackUsed,
		attempts,
		errors: attemptedErrors,
		latencyMs,
		routeKey,
		routeRevisionId: routeRevisionId ?? void 0,
		invocationId,
		validatedPayload: successValidatedPayload
	};
}
var geminiEmbeddingDisableByModel = /* @__PURE__ */ new Map();
function geminiEmbeddingDisableKey(model) {
	return `${(process.env.GEMINI_API_VERSION || "default").trim() || "default"}:${model}`;
}
function describeError(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
function isGeminiEmbeddingModelNotFound(error) {
	const message = describeError(error);
	try {
		const parsed = JSON.parse(message);
		const code = parsed?.error?.code;
		const status = parsed?.error?.status;
		if (code === 404 || status === "NOT_FOUND") return true;
	} catch {}
	const lowered = message.toLowerCase();
	return lowered.includes("not found for api version") || lowered.includes("not found") && lowered.includes("text-embedding") || lowered.includes("not supported for embedcontent") || lowered.includes("status\":\"not_found\"");
}
async function embedWithGeminiModel(text, model) {
	const normalizedModel = (model || "").trim();
	if (!normalizedModel) throw new Error("Gemini embedding requested but model is empty.");
	const disabled = geminiEmbeddingDisableByModel.get(geminiEmbeddingDisableKey(normalizedModel));
	if (disabled?.reason) throw new Error(`Gemini embedding disabled for ${normalizedModel}: ${disabled.reason}`);
	const ai = getGeminiClient();
	try {
		const timeoutMs = embeddingRequestTimeoutMs();
		const configuredDimensions = Number(process.env.EMBEDDING_PRIMARY_DIMENSIONS || 768);
		const outputDimensionality = Number.isInteger(configuredDimensions) && configuredDimensions > 0 ? configuredDimensions : void 0;
		const vals = (await ai.models.embedContent({
			model: normalizedModel,
			contents: text,
			config: {
				...outputDimensionality ? { outputDimensionality } : {},
				abortSignal: AbortSignal.timeout(timeoutMs),
				httpOptions: { timeout: timeoutMs }
			}
		})).embeddings?.[0]?.values;
		if (vals && vals.length > 0) return vals;
		throw new Error("Gemini embedding returned empty values");
	} catch (error) {
		if (isGeminiEmbeddingModelNotFound(error)) {
			const reason = `model not found/unsupported; set GEMINI_API_VERSION or configure EMBEDDING_PRIMARY_MODEL to one that supports embedContent`;
			const disableKey = geminiEmbeddingDisableKey(normalizedModel);
			const prior = geminiEmbeddingDisableByModel.get(disableKey) || {
				reason: "",
				logged: false
			};
			geminiEmbeddingDisableByModel.set(disableKey, {
				reason,
				logged: prior.logged
			});
			if (!prior.logged) {
				geminiEmbeddingDisableByModel.set(disableKey, {
					reason,
					logged: true
				});
				console.warn(`⚠️ Gemini embedding disabled for ${normalizedModel}: ${reason}`);
			}
		}
		throw error;
	}
}
async function embedWithOpenAIModel(text, model) {
	const openaiKey = process.env.OPENAI_API_KEY;
	if (!openaiKey) throw new Error("OpenAI embedding requested but OPENAI_API_KEY is not configured.");
	const normalizedModel = (model || "").trim();
	if (!normalizedModel) throw new Error("OpenAI embedding requested but model is empty.");
	const configuredDimensions = Number(process.env.EMBEDDING_FALLBACK_DIMENSIONS || 0);
	const supportsConfigurableDimensions = normalizedModel.startsWith("text-embedding-3-");
	const requestBody = {
		input: text,
		model: normalizedModel
	};
	if (supportsConfigurableDimensions && Number.isInteger(configuredDimensions) && configuredDimensions > 0) requestBody.dimensions = configuredDimensions;
	const timeoutMs = embeddingRequestTimeoutMs();
	const oResponse = await fetch("https://api.openai.com/v1/embeddings", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${openaiKey}`
		},
		body: JSON.stringify(requestBody),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!oResponse.ok) {
		const errText = await oResponse.text();
		throw new Error(`OpenAI embedding HTTP ${oResponse.status}: ${errText}`);
	}
	const vals = (await oResponse.json()).data?.[0]?.embedding;
	if (vals && vals.length > 0) return vals;
	throw new Error("OpenAI embedding returned empty values");
}
async function generateEmbeddingWithProvider(text, provider) {
	return generateEmbeddingWithProviderAndModel(text, provider, provider === "gemini" ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL);
}
async function generateEmbeddingWithProviderAndModel(text, provider, model) {
	if (provider === "gemini") {
		if (!(process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY)) throw new Error("Gemini embedding requested but GEMINI_API_KEY is not configured.");
		return embedWithGeminiModel(text, model);
	}
	return embedWithOpenAIModel(text, model);
}
/**
* Generate a text embedding vector. Provider order:
*  1. Gemini gemini-embedding-001 (if GEMINI_API_KEY present)
*  2. OpenAI text-embedding-3-small (if OPENAI_API_KEY present)
* THROWS if both fail or neither key is configured — never fabricates random
* or zero vectors, which would produce silent mis-classifications in laneRouter.
*/
async function generateEmbedding(text) {
	const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	const providerOrder = resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER);
	let lastError = null;
	for (const provider of providerOrder) {
		if (provider === "gemini") {
			const disabled = MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL && geminiEmbeddingDisableByModel.get(geminiEmbeddingDisableKey(MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL))?.reason;
			if (!geminiKey || disabled) continue;
		} else if (!openaiKey) continue;
		try {
			return await generateEmbeddingWithProvider(text, provider);
		} catch (error) {
			lastError = error;
			const message = describeError(error);
			if (provider === "gemini") console.warn(`⚠️ Gemini embedding failed: ${message}. Trying OpenAI fallback...`);
			else console.warn(`⚠️ OpenAI embedding failed: ${message}`);
		}
	}
	throw new Error(`Embedding generation failed: both Gemini and OpenAI providers unavailable or returned no values. Last error: ${describeError(lastError)}`);
}
/** Perform minimal live calls so invalid configured model IDs fail before ingestion. */
async function preflightModelRoutes() {
	const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	const errors = [];
	const checks = [];
	const degradedRoutes = [];
	const jsonOkSchema = {
		type: "object",
		additionalProperties: false,
		required: ["ok"],
		properties: { ok: { type: "string" } }
	};
	const checkTextRoute = async (label, purpose, geminiModel, openaiModel, primaryProviderRaw) => {
		const order = resolveProviderOrder(primaryProviderRaw);
		let routeOk = false;
		for (const [providerIndex, provider] of order.entries()) {
			const role = providerIndex === 0 ? "primary" : "fallback";
			const startedAt = Date.now();
			if (provider === "gemini") {
				if (!geminiKey) {
					checks.push({
						route: label,
						purpose,
						provider,
						model: geminiModel,
						role,
						ok: false,
						degraded: role === "primary",
						latencyMs: 0,
						error: "GEMINI_API_KEY not configured"
					});
					continue;
				}
				try {
					await tryGemini(geminiKey, {
						model: geminiModel,
						contents: purpose === "EXTRACTION" ? "Return {\"ok\":\"OK\"}." : "Reply with OK.",
						responseMimeType: purpose === "EXTRACTION" ? "application/json" : "text/plain",
						responseSchema: purpose === "EXTRACTION" ? jsonOkSchema : void 0
					});
					checks.push({
						route: label,
						purpose,
						provider,
						model: geminiModel,
						role,
						ok: true,
						degraded: role === "fallback",
						latencyMs: Date.now() - startedAt
					});
					routeOk = true;
				} catch (err) {
					checks.push({
						route: label,
						purpose,
						provider,
						model: geminiModel,
						role,
						ok: false,
						degraded: role === "primary",
						latencyMs: Date.now() - startedAt,
						error: err.message || String(err)
					});
				}
			}
			if (provider === "openai") {
				if (!openaiKey) {
					checks.push({
						route: label,
						purpose,
						provider,
						model: openaiModel,
						role,
						ok: false,
						degraded: role === "primary",
						latencyMs: 0,
						error: "OPENAI_API_KEY not configured"
					});
					continue;
				}
				try {
					await tryOpenAI(openaiKey, {
						model: openaiModel,
						contents: purpose === "EXTRACTION" ? "Return {\"ok\":\"OK\"}." : "Reply with OK.",
						responseMimeType: purpose === "EXTRACTION" ? "application/json" : "text/plain",
						responseSchema: purpose === "EXTRACTION" ? jsonOkSchema : void 0
					});
					checks.push({
						route: label,
						purpose,
						provider,
						model: openaiModel,
						role,
						ok: true,
						degraded: role === "fallback",
						latencyMs: Date.now() - startedAt
					});
					routeOk = true;
				} catch (err) {
					checks.push({
						route: label,
						purpose,
						provider,
						model: openaiModel,
						role,
						ok: false,
						degraded: role === "primary",
						latencyMs: Date.now() - startedAt,
						error: err.message || String(err)
					});
				}
			}
		}
		const routeChecks = checks.filter((check) => check.route === label);
		const primaryCheck = routeChecks.find((check) => check.role === "primary");
		const fallbackCheck = routeChecks.find((check) => check.role === "fallback");
		if (!routeOk) errors.push(`${label}: no usable provider. ${routeChecks.map((check) => `${check.provider}(${check.model}): ${check.error || "failed"}`).join(" | ")}`);
		else if (primaryCheck && !primaryCheck.ok && fallbackCheck?.ok) degradedRoutes.push(`${label}: primary ${primaryCheck.provider} failed; fallback ${fallbackCheck.provider} passed`);
		else if (primaryCheck?.ok && fallbackCheck && !fallbackCheck.ok) degradedRoutes.push(`${label}: fallback ${fallbackCheck.provider} unavailable`);
		return routeOk;
	};
	const evaluation = await checkTextRoute("evaluation", "EVALUATION", MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL, process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL, process.env.EVALUATION_PRIMARY_PROVIDER);
	const document = await checkTextRoute("document", "DOCUMENT", MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL, process.env.OPENAI_MODEL || MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL, process.env.DOCUMENT_PRIMARY_PROVIDER || process.env.EVALUATION_PRIMARY_PROVIDER);
	const extraction = await checkTextRoute("extraction", "EXTRACTION", extractionGeminiModel(), extractionOpenAIModel(), extractionPrimaryProvider());
	let embedding = false;
	const embeddingStartedAt = Date.now();
	try {
		await generateEmbedding("preflight");
		embedding = true;
		checks.push({
			route: "embedding",
			purpose: "EMBEDDING",
			provider: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0],
			model: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0] === "gemini" ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL,
			role: "primary",
			ok: true,
			degraded: false,
			latencyMs: Date.now() - embeddingStartedAt
		});
	} catch (err) {
		errors.push(`embedding: ${err.message || err}`);
		checks.push({
			route: "embedding",
			purpose: "EMBEDDING",
			provider: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0],
			model: resolveProviderOrder(process.env.EMBEDDING_PRIMARY_PROVIDER)[0] === "gemini" ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL,
			role: "primary",
			ok: false,
			degraded: false,
			latencyMs: Date.now() - embeddingStartedAt,
			error: err.message || String(err)
		});
	}
	return {
		evaluation,
		embedding,
		document,
		extraction,
		errors,
		checks,
		degradedRoutes
	};
}
//#endregion
//#region src/embeddings/batchValidator.ts
function checksumVector(values) {
	const payload = values.map((v) => v.toFixed(8)).join(",");
	return crypto.default.createHash("sha256").update(payload).digest("hex");
}
function validateEmbeddingVector(values, expectedDimensions) {
	const issues = [];
	if (!Array.isArray(values) || values.length === 0) issues.push("Embedding vector is empty.");
	for (const value of values) if (!Number.isFinite(value)) {
		issues.push("Embedding vector contains non-finite values.");
		break;
	}
	if (expectedDimensions && values.length !== expectedDimensions) issues.push(`Embedding dimension mismatch: expected ${expectedDimensions}, got ${values.length}.`);
	if (Math.sqrt(values.reduce((sum, v) => sum + v * v, 0)) === 0) issues.push("Embedding vector magnitude is zero.");
	return {
		valid: issues.length === 0,
		issues,
		checksum: checksumVector(values),
		dimensions: values.length
	};
}
//#endregion
//#region src/lanes/contracts.ts
var LaneConceptSetSchema = zod.z.object({ any: zod.z.array(zod.z.string()).optional() }).passthrough();
var LaneScopeSchema = zod.z.object({
	required_function_concepts: LaneConceptSetSchema.optional(),
	included_domain_concepts: LaneConceptSetSchema.optional(),
	excluded_domain_concepts: LaneConceptSetSchema.optional()
}).passthrough();
var LanePrototypeSchema = zod.z.object({
	prototype_key: zod.z.string().min(1).max(200),
	text: zod.z.string().min(1),
	weight: zod.z.number().min(0).max(1).optional()
}).passthrough();
var LaneRoutingSchema = zod.z.object({
	minimum_domain_score: zod.z.number().min(0).max(1).optional(),
	minimum_function_score: zod.z.number().min(0).max(1).optional(),
	minimum_semantic_score: zod.z.number().min(0).max(1).optional(),
	secondary_lane_threshold: zod.z.number().min(0).max(1).optional()
}).passthrough();
var LaneSourcingSchema = zod.z.object({
	enabled_sources: zod.z.array(zod.z.string()).optional(),
	query_sets: zod.z.array(zod.z.string()).optional()
}).passthrough();
var LaneBudgetSchema = zod.z.object({ maximum_ai_interpretations_per_run: zod.z.number().int().min(0).optional() }).passthrough();
var LaneFileConfigSchema = zod.z.object({
	schema_version: zod.z.string().optional(),
	lane_key: zod.z.string().min(1).max(200),
	display_name: zod.z.string().min(1).max(200),
	description: zod.z.string().min(1).max(4e3),
	scope: LaneScopeSchema.optional(),
	prototypes: zod.z.array(LanePrototypeSchema).optional(),
	routing: LaneRoutingSchema.optional(),
	sourcing: LaneSourcingSchema.optional(),
	budget: LaneBudgetSchema.optional(),
	positive_concepts: zod.z.array(zod.z.string()).optional(),
	negative_concepts: zod.z.array(zod.z.string()).optional(),
	semantic_threshold: zod.z.number().min(0).max(1).optional()
}).passthrough();
//#endregion
//#region src/lanes/registry.ts
async function listActiveLaneRevisions(clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const { rows } = await client.query(`
        SELECT
          li.id AS lane_identity_id,
          lr.id AS lane_revision_id,
          li.lane_key AS lane_key,
          li.status AS status,
          lr.revision_number AS revision_number,
          lr.content_hash AS content_hash,
          lr.content AS content,
          lar.activated_at AS activated_at
        FROM lane_identities li
        JOIN lane_active_revisions lar ON lar.lane_identity_id = li.id
        JOIN lane_revisions lr ON lr.id = lar.lane_revision_id
        WHERE li.workspace_id = $1
          AND li.status = 'ACTIVE'
        ORDER BY li.lane_key ASC
      `, [ctx.workspaceId]);
		return rows.map((r) => ({
			laneIdentityId: r.lane_identity_id,
			laneRevisionId: r.lane_revision_id,
			laneKey: r.lane_key,
			status: r.status,
			revisionNumber: r.revision_number,
			contentHash: r.content_hash,
			content: LaneFileConfigSchema.parse(r.content),
			activatedAt: r.activated_at
		}));
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function upsertLaneRevision(input, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	const activate = options?.activate !== false;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const parsed = LaneFileConfigSchema.parse(input.content);
		const contentHash = sha256Hex(stableStringify(parsed));
		await client.query("BEGIN");
		const laneIdentityId = (await client.query(`
        INSERT INTO lane_identities (
          workspace_id,
          lane_key,
          status,
          created_by_user_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (workspace_id, lane_key)
        DO UPDATE SET
          status = COALESCE(EXCLUDED.status, lane_identities.status),
          updated_at = NOW()
        RETURNING id
      `, [
			ctx.workspaceId,
			input.laneKey,
			options?.status ?? "ACTIVE",
			ctx.userId
		])).rows[0].id;
		const existing = await client.query(`
        SELECT id, revision_number
        FROM lane_revisions
        WHERE lane_identity_id = $1
          AND content_hash = $2
        LIMIT 1
      `, [laneIdentityId, contentHash]);
		let laneRevisionId;
		let revisionNumber;
		let inserted = false;
		if (existing.rows.length > 0) {
			laneRevisionId = existing.rows[0].id;
			revisionNumber = existing.rows[0].revision_number;
		} else {
			revisionNumber = (await client.query(`
          SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
          FROM lane_revisions
          WHERE lane_identity_id = $1
        `, [laneIdentityId])).rows[0].next;
			laneRevisionId = (await client.query(`
          INSERT INTO lane_revisions (
            lane_identity_id,
            revision_number,
            schema_version,
            content_hash,
            content,
            created_by_user_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [
				laneIdentityId,
				revisionNumber,
				input.schemaVersion ?? "2.2.0",
				contentHash,
				parsed,
				ctx.userId
			])).rows[0].id;
			inserted = true;
		}
		let activated = false;
		if (activate) {
			const fromRevisionId = (await client.query(`
          SELECT lane_revision_id
          FROM lane_active_revisions
          WHERE lane_identity_id = $1
          LIMIT 1
        `, [laneIdentityId])).rows[0]?.lane_revision_id ?? null;
			await client.query(`
          INSERT INTO lane_active_revisions (
            lane_identity_id,
            lane_revision_id,
            activated_by_user_id,
            activated_at
          )
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (lane_identity_id)
          DO UPDATE SET
            lane_revision_id = EXCLUDED.lane_revision_id,
            activated_by_user_id = EXCLUDED.activated_by_user_id,
            activated_at = NOW()
        `, [
				laneIdentityId,
				laneRevisionId,
				ctx.userId
			]);
			if (fromRevisionId !== laneRevisionId) await client.query(`
            INSERT INTO lane_activation_events (
              lane_identity_id,
              from_revision_id,
              to_revision_id,
              activated_by_user_id,
              activated_at,
              note
            )
            VALUES ($1, $2, $3, $4, NOW(), $5)
          `, [
				laneIdentityId,
				fromRevisionId,
				laneRevisionId,
				ctx.userId,
				options?.note ?? null
			]);
			activated = true;
		}
		await client.query("COMMIT");
		return {
			laneIdentityId,
			laneRevisionId,
			revisionNumber,
			contentHash,
			activated,
			inserted
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/embeddings/inputBuilder.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$7 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
function hashText(value) {
	return crypto.default.createHash("sha256").update(value).digest("hex");
}
function buildRequirementInputText(row) {
	const quote = row.quote_text ? ` Quote: ${row.quote_text}` : "";
	const structured = row.structured_value ? ` Structured: ${JSON.stringify(row.structured_value)}` : "";
	return `${row.requirement_type}: ${row.requirement_text}${quote}${structured}`.trim();
}
function buildProfileFactInputText(row) {
	const structured = row.structured_value ? ` Structured: ${JSON.stringify(row.structured_value)}` : "";
	return `${row.fact_type} (${row.evidence_tier}): ${row.statement}${structured}`.trim();
}
function buildLanePrototypeInputText(lane) {
	return ((lane.prototypes || []).map((p) => typeof p?.text === "string" ? p.text.trim() : "").filter((p) => p.length > 0).join(" ") || lane.description || lane.display_name || lane.lane_key).trim();
}
function buildJobVersionInputText(row) {
	return `${row.normalized_title}: ${row.description_text}`.trim().slice(0, 12e3);
}
async function upsertEmbeddingInput(client, candidate) {
	if ((await client.query(`SELECT content_hash
     FROM embedding_inputs
     WHERE workspace_id = $1
       AND source_type = $2
       AND source_id = $3
       AND is_current = TRUE
     FOR UPDATE`, [
		candidate.workspaceId,
		candidate.sourceType,
		candidate.sourceId
	])).rows[0]?.content_hash === candidate.contentHash) return false;
	let inputKey = candidate.inputKey;
	if ((await client.query(`SELECT 1
     FROM embedding_inputs
     WHERE workspace_id = $1
       AND input_key = $2
     LIMIT 1`, [candidate.workspaceId, inputKey])).rows.length > 0) inputKey = `${candidate.inputKey}:${crypto.default.randomUUID()}`;
	await client.query(`UPDATE embedding_inputs
     SET is_current = FALSE,
         superseded_at = COALESCE(superseded_at, NOW())
     WHERE workspace_id = $1
       AND source_type = $2
       AND source_id = $3
       AND is_current = TRUE`, [
		candidate.workspaceId,
		candidate.sourceType,
		candidate.sourceId
	]);
	const inserted = await client.query(`INSERT INTO embedding_inputs (
       workspace_id,
       input_key,
       source_type,
       source_id,
       content_text,
       content_hash,
       is_current,
       superseded_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, NULL)
     ON CONFLICT (workspace_id, input_key) DO NOTHING
     RETURNING id`, [
		candidate.workspaceId,
		inputKey,
		candidate.sourceType,
		candidate.sourceId,
		candidate.contentText,
		candidate.contentHash
	]);
	return (inserted.rowCount ?? inserted.rows.length) > 0;
}
async function buildEmbeddingInputs(clientOrPool, maxPerSource = 200, options) {
	const pool = clientOrPool || defaultPool$7;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	let inserted = 0;
	let fromRequirements = 0;
	let fromProfileFacts = 0;
	let fromJobVersions = 0;
	let fromLanePrototypes = 0;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
		const scopedToJobVersions = jobVersionIds.length > 0;
		const includeProfileFacts = options?.includeProfileFacts ?? !scopedToJobVersions;
		const includeLanePrototypes = options?.includeLanePrototypes ?? true;
		await client.query("BEGIN");
		const requirementParams = [ctx.workspaceId, maxPerSource];
		const requirementScope = scopedToJobVersions ? `AND jv.id = ANY($${requirementParams.push(jobVersionIds)}::uuid[])` : "";
		const reqRows = await client.query(`SELECT jr.id, jr.requirement_type, jr.requirement_text, jr.quote_text, jr.structured_value
       FROM job_requirements jr
       JOIN job_versions jv
         ON jv.workspace_id = jr.workspace_id
        AND jv.id = jr.job_version_id
       WHERE jr.workspace_id = $1
         AND jr.status = 'VALIDATED'
         ${requirementScope}
         AND (
           jv.active_requirement_set_id IS NULL
           OR jr.requirement_set_id = jv.active_requirement_set_id
         )
       ORDER BY jr.created_at ASC
       LIMIT $2`, requirementParams);
		for (const row of reqRows.rows) {
			const contentText = buildRequirementInputText(row);
			const contentHash = hashText(contentText);
			const inputKey = `req:${row.id}:${contentHash.slice(0, 16)}`;
			if (await upsertEmbeddingInput(client, {
				workspaceId: ctx.workspaceId,
				inputKey,
				sourceType: "JOB_REQUIREMENT",
				sourceId: row.id,
				contentText,
				contentHash
			})) {
				inserted += 1;
				fromRequirements += 1;
			}
		}
		if (includeProfileFacts) {
			const factRows = await client.query(`SELECT pf.id, COALESCE(pf.fact_revision_id, pf.id) AS embedding_node_id,
                pf.fact_type, pf.statement, pf.structured_value, pf.evidence_tier
         FROM profile_facts pf
         JOIN profile_versions pv
           ON pv.workspace_id = pf.workspace_id
          AND pv.id = pf.profile_version_id
          AND pv.status = 'ACTIVE'
         WHERE pf.workspace_id = $1
         ORDER BY pf.created_at ASC
         LIMIT $2`, [ctx.workspaceId, maxPerSource]);
			for (const row of factRows.rows) {
				const contentText = buildProfileFactInputText(row);
				const contentHash = hashText(contentText);
				const embeddingNodeId = row.embedding_node_id || row.id;
				const inputKey = `fact:${embeddingNodeId}:${contentHash.slice(0, 16)}`;
				if (await upsertEmbeddingInput(client, {
					workspaceId: ctx.workspaceId,
					inputKey,
					sourceType: "PROFILE_FACT",
					sourceId: embeddingNodeId,
					contentText,
					contentHash
				})) {
					inserted += 1;
					fromProfileFacts += 1;
				}
			}
		}
		const jobParams = [ctx.workspaceId, maxPerSource];
		const jobScope = scopedToJobVersions ? `AND jv.id = ANY($${jobParams.push(jobVersionIds)}::uuid[])` : "";
		const jobRows = await client.query(`SELECT
              jv.id,
              c.normalized_title,
              jv.description_text
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.canonical_job_id = c.id
        AND jv.id = COALESCE(
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
       WHERE c.workspace_id = $1
          AND (
            $${jobParams.length + 1}::boolean = TRUE
            OR COALESCE(c.processing_state, c.processing_status) IN ('RAW_STAGED', 'PREQUALIFIED', 'LANE_ROUTED', 'ROUTING_DEFERRED', 'MATCHED')
          )
         ${jobScope}
         AND jv.description_text IS NOT NULL
       ORDER BY jv.observed_at DESC
       LIMIT $2`, [...jobParams, scopedToJobVersions]);
		for (const row of jobRows.rows) {
			const contentText = buildJobVersionInputText(row);
			const contentHash = hashText(contentText);
			const inputKey = `job:${row.id}:${contentHash.slice(0, 16)}`;
			if (await upsertEmbeddingInput(client, {
				workspaceId: ctx.workspaceId,
				inputKey,
				sourceType: "JOB_VERSION",
				sourceId: row.id,
				contentText,
				contentHash
			})) {
				inserted += 1;
				fromJobVersions += 1;
			}
		}
		await client.query("COMMIT");
		if (!includeLanePrototypes) return {
			inserted,
			fromRequirements,
			fromProfileFacts,
			fromJobVersions,
			fromLanePrototypes
		};
		try {
			const activeLanes = await listActiveLaneRevisions(client, { context: ctx });
			for (const lane of activeLanes) {
				const contentText = buildLanePrototypeInputText(lane.content);
				const contentHash = hashText(contentText);
				const inputKey = `lane:${lane.laneRevisionId}:${contentHash.slice(0, 16)}`;
				if (await upsertEmbeddingInput(client, {
					workspaceId: ctx.workspaceId,
					inputKey,
					sourceType: "LANE_PROTOTYPE",
					sourceId: lane.laneRevisionId,
					contentText,
					contentHash
				})) {
					inserted += 1;
					fromLanePrototypes += 1;
				}
			}
		} catch (err) {
			if (err?.code !== "42P01") throw err;
		}
		return {
			inserted,
			fromRequirements,
			fromProfileFacts,
			fromJobVersions,
			fromLanePrototypes
		};
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/embeddings/spaceRegistry.ts
dotenv.default.config();
dotenv.default.config({
	path: ".env.local",
	override: true
});
var defaultPool$6 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
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
	const pool = clientOrPool || defaultPool$6;
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
//#region src/embeddings/batchCoordinator.ts
dotenv.default.config();
dotenv.default.config({
	path: ".env.local",
	override: true
});
var defaultPool$5 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
function describeEmbeddingError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}
async function recordEmbeddingInvocation(client, context, input) {
	const contentHash = sha256Hex(input.contentText);
	const requestHash = sha256Hex(stableStringify({
		purpose: "EMBEDDING",
		provider: input.provider,
		model: input.model,
		embedding_space_id: input.embeddingSpaceId,
		embedding_input_id: input.embeddingInputId,
		content_sha256: contentHash
	}));
	await recordModelRouteInvocation({
		purpose: "EMBEDDING",
		provider: input.provider,
		model: input.model,
		status: input.status,
		fallbackUsed: input.runType === "FALLBACK",
		requestHash,
		requestMetadata: {
			embedding_space_id: input.embeddingSpaceId,
			embedding_batch_id: input.embeddingBatchId,
			embedding_input_id: input.embeddingInputId,
			run_type: input.runType,
			content_sha256: contentHash,
			content_length: input.contentText.length
		},
		responseMetadata: {
			provider_attempts: [{
				provider: input.provider,
				model: input.model,
				attempt: 1,
				maxAttempts: 1,
				status: input.status,
				latencyMs: input.latencyMs,
				error: input.errorMessage ?? void 0
			}],
			internal_http_attempts: 1,
			vector_dimensions: input.vectorDimensions ?? null,
			vector_checksum: input.vectorChecksum ?? null,
			validation_issues: input.validationIssues ?? []
		},
		latencyMs: input.latencyMs,
		errorMessage: input.errorMessage ?? null
	}, client, context ? { context } : void 0);
}
async function runEmbeddingBatch(embeddingSpaceId, batchKey, runType = "PRIMARY", maxItems = 50, inputIds, fallbackFromBatchId, rerunOfBatchId, clientOrPool, options, excludeInputIds = []) {
	const pool = clientOrPool || defaultPool$5;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	const errors = [];
	try {
		const spaceRes = await client.query(`SELECT id, workspace_id, provider, model, dimensions
       FROM embedding_spaces
       WHERE id = $1 AND active = TRUE
       LIMIT 1`, [embeddingSpaceId]);
		if (spaceRes.rows.length === 0) throw new Error(`Embedding space not found or inactive: ${embeddingSpaceId}`);
		const space = spaceRes.rows[0];
		const workspaceId = space.workspace_id;
		const provider = (space.provider || "").toLowerCase();
		if (provider !== "gemini" && provider !== "openai") throw new Error(`Unsupported embedding provider for space ${space.id}: ${space.provider}`);
		const spaceModel = (space.model || "").trim();
		if (!spaceModel) throw new Error(`Embedding space ${space.id} has empty model; cannot run batch.`);
		if (options?.context && options.context.workspaceId !== workspaceId) throw new Error(`Embedding space ${space.id} is in workspace_id=${workspaceId} but context.workspaceId=${options.context.workspaceId}`);
		if (Array.isArray(inputIds) && inputIds.length === 0) {
			console.log(`[embeddings:${runType}] provider=${provider} model=${spaceModel} space=${space.id} no pending scoped inputs`);
			return {
				batchId: null,
				embeddingSpaceId: space.id,
				processed: 0,
				processedInputIds: [],
				succeeded: 0,
				failed: 0,
				failedInputIds: [],
				runType,
				errors: []
			};
		}
		const excludedInputIds = excludeInputIds.length > 0 ? excludeInputIds : null;
		const inputRes = Array.isArray(inputIds) ? await client.query(`SELECT ei.id, ei.content_text
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND ei.is_current = TRUE
             AND ei.id = ANY($2::uuid[])
             AND ($5::uuid[] IS NULL OR ei.id <> ALL($5::uuid[]))
             AND NOT EXISTS (
               SELECT 1
               FROM v_published_semantic_embeddings se
               WHERE se.workspace_id = $1
                 AND se.embedding_space_id = $3
                 AND se.embedding_input_id = ei.id
             )
           ORDER BY ei.created_at ASC
           LIMIT $4`, [
			workspaceId,
			inputIds,
			space.id,
			maxItems,
			excludedInputIds
		]) : await client.query(`SELECT ei.id, ei.content_text
           FROM embedding_inputs ei
           WHERE ei.workspace_id = $1
             AND ei.is_current = TRUE
             AND ($4::uuid[] IS NULL OR ei.id <> ALL($4::uuid[]))
             AND NOT EXISTS (
             SELECT 1
             FROM v_published_semantic_embeddings se
             WHERE se.workspace_id = $1
               AND se.embedding_space_id = $2
               AND se.embedding_input_id = ei.id
           )
           ORDER BY ei.created_at ASC
           LIMIT $3`, [
			workspaceId,
			space.id,
			maxItems,
			excludedInputIds
		]);
		if (inputRes.rows.length === 0) {
			console.log(`[embeddings:${runType}] provider=${provider} model=${spaceModel} space=${space.id} no pending inputs`);
			return {
				batchId: null,
				embeddingSpaceId: space.id,
				processed: 0,
				processedInputIds: [],
				succeeded: 0,
				failed: 0,
				failedInputIds: [],
				runType,
				errors: []
			};
		}
		const processedInputIds = inputRes.rows.map((row) => row.id);
		console.log(`[embeddings:${runType}] provider=${provider} model=${spaceModel} space=${space.id} dimensions=${space.dimensions} selected=${inputRes.rows.length} max_items=${maxItems} input_filter=${inputIds && inputIds.length > 0 ? inputIds.length : "none"}`);
		let batchId;
		await client.query("BEGIN");
		try {
			batchId = (await client.query(`INSERT INTO embedding_batches (
           workspace_id,
           embedding_space_id,
           batch_key,
           run_type,
           fallback_from_batch_id,
           rerun_of_batch_id,
           status,
           item_count,
           success_count,
           failure_count
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING', 0, 0, 0)
         RETURNING id`, [
				workspaceId,
				space.id,
				batchKey,
				runType,
				fallbackFromBatchId || null,
				rerunOfBatchId || null
			])).rows[0].id;
			console.log(`[embeddings:${runType}] batch_id=${batchId} creating ${inputRes.rows.length} batch item(s)`);
			for (const input of inputRes.rows) await client.query(`INSERT INTO embedding_batch_items (
             workspace_id,
             embedding_batch_id,
             embedding_input_id,
             status,
             attempt_count,
             error_message,
             updated_at
           )
           VALUES ($1, $2, $3, 'PENDING', 1, NULL, NOW())
           ON CONFLICT (embedding_batch_id, embedding_input_id)
           DO NOTHING`, [
				workspaceId,
				batchId,
				input.id
			]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
		let succeeded = 0;
		let failed = 0;
		const failedInputIds = [];
		for (let inputIndex = 0; inputIndex < inputRes.rows.length; inputIndex += 1) {
			const input = inputRes.rows[inputIndex];
			const itemStartedAt = Date.now();
			const progressPrefix = `[embeddings:${runType}] ${inputIndex + 1}/${inputRes.rows.length} input_id=${input.id} provider=${provider} model=${spaceModel}`;
			console.log(`${progressPrefix} starting chars=${input.content_text.length}`);
			try {
				const vector = await generateEmbeddingWithProviderAndModel(input.content_text, provider, spaceModel);
				const validation = validateEmbeddingVector(vector, space.dimensions);
				if (!validation.valid) {
					failed += 1;
					failedInputIds.push(input.id);
					errors.push(`input ${input.id}: ${validation.issues.join("; ")}`);
					console.warn(`${progressPrefix} validation_failed issues=${validation.issues.join("; ")} elapsed_ms=${Date.now() - itemStartedAt}`);
					await recordEmbeddingInvocation(client, options?.context, {
						status: "FAILED",
						workspaceId,
						embeddingSpaceId: space.id,
						embeddingBatchId: batchId,
						embeddingInputId: input.id,
						provider,
						model: spaceModel,
						runType,
						contentText: input.content_text,
						latencyMs: Date.now() - itemStartedAt,
						vectorDimensions: validation.dimensions,
						vectorChecksum: validation.checksum,
						errorMessage: validation.issues.join("; "),
						validationIssues: validation.issues
					});
					await client.query(`UPDATE embedding_batch_items
             SET status = 'FAILED',
                 error_message = $4,
                 updated_at = NOW()
             WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`, [
						workspaceId,
						batchId,
						input.id,
						validation.issues.join("; ")
					]);
					continue;
				}
				try {
					await client.query(`INSERT INTO semantic_embeddings (
               workspace_id,
               embedding_space_id,
               embedding_input_id,
               embedding_batch_id,
               vector_dimensions,
               embedding_values,
               embedding_vector,
               vector_checksum
             )
             VALUES ($1, $2, $3, $4, $5, $6, ($6::float8[])::vector, $7)
             ON CONFLICT (embedding_space_id, embedding_input_id)
             DO NOTHING`, [
						workspaceId,
						space.id,
						input.id,
						batchId,
						validation.dimensions,
						vector,
						validation.checksum
					]);
				} catch (writeErr) {
					if (writeErr?.code !== "42703" && writeErr?.code !== "42704" && writeErr?.code !== "42883" && writeErr?.code !== "42846" && writeErr?.code !== "22P02") throw writeErr;
					await client.query(`INSERT INTO semantic_embeddings (
               workspace_id,
               embedding_space_id,
               embedding_input_id,
               embedding_batch_id,
               vector_dimensions,
               embedding_values,
               vector_checksum
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (embedding_space_id, embedding_input_id)
             DO NOTHING`, [
						workspaceId,
						space.id,
						input.id,
						batchId,
						validation.dimensions,
						vector,
						validation.checksum
					]);
				}
				succeeded += 1;
				console.log(`${progressPrefix} completed dimensions=${validation.dimensions} elapsed_ms=${Date.now() - itemStartedAt}`);
				await recordEmbeddingInvocation(client, options?.context, {
					status: "COMPLETED",
					workspaceId,
					embeddingSpaceId: space.id,
					embeddingBatchId: batchId,
					embeddingInputId: input.id,
					provider,
					model: spaceModel,
					runType,
					contentText: input.content_text,
					latencyMs: Date.now() - itemStartedAt,
					vectorDimensions: validation.dimensions,
					vectorChecksum: validation.checksum
				});
				await client.query(`UPDATE embedding_batch_items
           SET status = 'COMPLETED',
               error_message = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`, [
					workspaceId,
					batchId,
					input.id
				]);
			} catch (error) {
				const message = describeEmbeddingError(error);
				failed += 1;
				failedInputIds.push(input.id);
				errors.push(`input ${input.id}: ${message}`);
				console.warn(`${progressPrefix} failed elapsed_ms=${Date.now() - itemStartedAt} error=${message}`);
				await recordEmbeddingInvocation(client, options?.context, {
					status: "FAILED",
					workspaceId,
					embeddingSpaceId: space.id,
					embeddingBatchId: batchId,
					embeddingInputId: input.id,
					provider,
					model: spaceModel,
					runType,
					contentText: input.content_text,
					latencyMs: Date.now() - itemStartedAt,
					errorMessage: message
				});
				await client.query(`UPDATE embedding_batch_items
           SET status = 'FAILED',
               error_message = $4,
               updated_at = NOW()
           WHERE workspace_id = $1 AND embedding_batch_id = $2 AND embedding_input_id = $3`, [
					workspaceId,
					batchId,
					input.id,
					message
				]);
			}
		}
		await client.query(`UPDATE embedding_batches
       SET status = $2,
           item_count = $3,
           success_count = $4,
           failure_count = $5,
           error_message = $6,
           completed_at = NOW()
       WHERE workspace_id = $7 AND id = $1`, [
			batchId,
			failed > 0 ? "FAILED" : "COMPLETED",
			inputRes.rows.length,
			succeeded,
			failed,
			errors.length > 0 ? errors.join(" | ") : null,
			workspaceId
		]);
		let publicationComplete = false;
		if (failed === 0 && succeeded === inputRes.rows.length) try {
			publicationComplete = ((await client.query(`UPDATE embedding_batches eb
           SET published_at = NOW(),
               publication_note = NULL
           WHERE eb.workspace_id = $1
             AND eb.id = $2
             AND eb.status = 'COMPLETED'
             AND eb.item_count > 0
             AND eb.item_count = (
               SELECT COUNT(*)
               FROM embedding_batch_items ebi
               WHERE ebi.workspace_id = eb.workspace_id
                 AND ebi.embedding_batch_id = eb.id
                 AND ebi.status = 'COMPLETED'
             )`, [workspaceId, batchId])).rowCount ?? 0) === 1;
		} catch (publishErr) {
			if ((typeof publishErr === "object" && publishErr !== null && "code" in publishErr ? String(publishErr.code) : void 0) !== "42703") throw publishErr;
			publicationComplete = true;
		}
		if (failed === 0 && inputRes.rows.length === 0) publicationComplete = true;
		console.log(`[embeddings:${runType}] batch_id=${batchId} completed processed=${inputRes.rows.length} succeeded=${succeeded} failed=${failed}`);
		return {
			batchId,
			batchIds: [batchId],
			embeddingSpaceId: space.id,
			processed: inputRes.rows.length,
			processedInputIds,
			succeeded,
			failed,
			failedInputIds,
			runType,
			errors,
			publicationComplete
		};
	} catch (error) {
		throw error;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
function emptyBatchSummary(embeddingSpaceId, runType) {
	return {
		batchId: null,
		batchIds: [],
		embeddingSpaceId,
		processed: 0,
		processedInputIds: [],
		succeeded: 0,
		failed: 0,
		failedInputIds: [],
		runType,
		errors: [],
		publicationComplete: true
	};
}
function mergeBatchSummaries(summaries, embeddingSpaceId, runType) {
	if (summaries.length === 0) return emptyBatchSummary(embeddingSpaceId, runType);
	const processedInputIds = [...new Set(summaries.flatMap((summary) => summary.processedInputIds))];
	const failedInputIds = [...new Set(summaries.flatMap((summary) => summary.failedInputIds))];
	const batchIds = summaries.flatMap((summary) => summary.batchIds ?? (summary.batchId ? [summary.batchId] : []));
	return {
		batchId: batchIds[0] ?? null,
		batchIds,
		embeddingSpaceId,
		processed: summaries.reduce((total, summary) => total + summary.processed, 0),
		processedInputIds,
		succeeded: summaries.reduce((total, summary) => total + summary.succeeded, 0),
		failed: summaries.reduce((total, summary) => total + summary.failed, 0),
		failedInputIds,
		runType,
		errors: summaries.flatMap((summary) => summary.errors),
		publicationComplete: summaries.every((summary) => summary.publicationComplete !== false && summary.failed === 0)
	};
}
async function drainEmbeddingBatches(embeddingSpaceId, runType, maxItems, inputIds, fallbackFromBatchId, rerunOfBatchId, client, context) {
	const requestedInputIds = inputIds ? [...new Set(inputIds)] : void 0;
	const attemptedInputIds = /* @__PURE__ */ new Set();
	const batches = [];
	while (true) {
		const batch = await runEmbeddingBatch(embeddingSpaceId, `${runType.toLowerCase()}-${Date.now()}-${batches.length}`, runType, maxItems, requestedInputIds, fallbackFromBatchId, rerunOfBatchId, client, { context }, [...attemptedInputIds]);
		if (batch.processed === 0) break;
		if (batch.processedInputIds.length === 0 || !batch.processedInputIds.some((inputId) => !attemptedInputIds.has(inputId))) break;
		batches.push(batch);
		for (const inputId of batch.processedInputIds) attemptedInputIds.add(inputId);
		if (batch.processedInputIds.length === 0) break;
		if (requestedInputIds && attemptedInputIds.size >= requestedInputIds.length) break;
	}
	return {
		summary: mergeBatchSummaries(batches, embeddingSpaceId, runType),
		batches
	};
}
async function runEmbeddingBatchWithFallback(maxItems = 100, clientOrPool, options) {
	const pool = clientOrPool || defaultPool$5;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
		const scopedToJobVersions = jobVersionIds.length > 0;
		console.log(`[embeddings] seeding embedding spaces`);
		const seeded = await seedEmbeddingSpaces(client, { context: ctx });
		console.log(`[embeddings] spaces primary=${seeded.primarySpaceId} fallback=${seeded.fallbackSpaceId}`);
		console.log(`[embeddings] building embedding inputs max_per_source=${maxItems}`);
		const inputBuild = await buildEmbeddingInputs(client, maxItems, {
			context: ctx,
			jobVersionIds,
			includeProfileFacts: options?.includeProfileFacts,
			includeLanePrototypes: options?.includeLanePrototypes
		});
		console.log(`[embeddings] input_build inserted=${inputBuild.inserted} requirements=${inputBuild.fromRequirements} profile_facts=${inputBuild.fromProfileFacts} job_versions=${inputBuild.fromJobVersions ?? 0} lane_prototypes=${inputBuild.fromLanePrototypes ?? 0}`);
		let scopedInputIds;
		if (scopedToJobVersions) {
			const { rows } = await client.query(`SELECT DISTINCT ei.id
         FROM embedding_inputs ei
         WHERE ei.workspace_id = $1
           AND ei.is_current = TRUE
           AND (
             (ei.source_type = 'JOB_VERSION' AND ei.source_id = ANY($2::uuid[]))
             OR (ei.source_type = 'JOB_REQUIREMENT' AND EXISTS (
               SELECT 1
               FROM job_requirements jr
               WHERE jr.workspace_id = ei.workspace_id
                 AND jr.id = ei.source_id
                 AND jr.job_version_id = ANY($2::uuid[])
                 AND jr.status = 'VALIDATED'
             ))
             OR (
               $3::boolean = TRUE
               AND ei.source_type = 'LANE_PROTOTYPE'
             )
             OR (
               $4::boolean = TRUE
               AND ei.source_type = 'PROFILE_FACT'
               AND EXISTS (
                 SELECT 1
                 FROM profile_facts pf
                 JOIN profile_versions pv
                   ON pv.workspace_id = pf.workspace_id
                  AND pv.id = pf.profile_version_id
                  AND pv.status = 'ACTIVE'
                 WHERE pf.workspace_id = ei.workspace_id
                   AND COALESCE(pf.fact_revision_id, pf.id) = ei.source_id
               )
             )
           )
         ORDER BY ei.id`, [
				ctx.workspaceId,
				jobVersionIds,
				options?.includeLanePrototypes ?? true,
				options?.includeProfileFacts ?? false
			]);
			scopedInputIds = rows.map((row) => row.id);
			console.log(`[embeddings] scoped input selection job_versions=${jobVersionIds.length} inputs=${scopedInputIds.length}`);
		}
		console.log(`[embeddings] draining primary batches max_items=${maxItems}`);
		const primaryDrain = await drainEmbeddingBatches(seeded.primarySpaceId, "PRIMARY", maxItems, scopedInputIds, void 0, void 0, client, ctx);
		const primary = primaryDrain.summary;
		console.log(`[embeddings] primary batches finished batches=${primaryDrain.batches.length} processed=${primary.processed} succeeded=${primary.succeeded} failed=${primary.failed}`);
		let fallback;
		if (primary.failedInputIds.length > 0) {
			const fallbackBatches = [];
			const failedByPrimaryBatch = /* @__PURE__ */ new Map();
			for (const batch of primaryDrain.batches) {
				if (!batch.batchId || batch.failedInputIds.length === 0) continue;
				failedByPrimaryBatch.set(batch.batchId, batch.failedInputIds);
			}
			for (const [primaryBatchId, failedInputIds] of failedByPrimaryBatch) {
				console.log(`[embeddings] draining fallback batches primary_batch_id=${primaryBatchId} input_count=${failedInputIds.length}`);
				const fallbackDrain = await drainEmbeddingBatches(seeded.fallbackSpaceId, "FALLBACK", maxItems, failedInputIds, primaryBatchId, primaryBatchId, client, ctx);
				fallbackBatches.push(...fallbackDrain.batches);
				if (fallbackDrain.batches.length === 0) fallbackBatches.push(emptyBatchSummary(seeded.fallbackSpaceId, "FALLBACK"));
			}
			fallback = mergeBatchSummaries(fallbackBatches, seeded.fallbackSpaceId, "FALLBACK");
			console.log(`[embeddings] fallback batches finished batches=${fallbackBatches.length} processed=${fallback.processed} succeeded=${fallback.succeeded} failed=${fallback.failed}`);
		}
		return {
			seededSpaces: seeded,
			inputBuild,
			primary,
			fallback
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
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
async function claimPipelineTasks(input, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	const limit = input.limit ?? 25;
	const leaseSeconds = input.leaseSeconds ?? 120;
	const claimedBy = input.claimedBy ?? `worker:${process.pid}`;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		await client.query("BEGIN");
		try {
			const { rows } = await client.query(`
          WITH claimable AS (
            SELECT id
            FROM pipeline_tasks
            WHERE workspace_id = $1
              AND task_type = $2
              AND (
                (
                  status IN ('PENDING', 'RETRY_WAIT')
                  AND available_at <= NOW()
                )
                OR (
                  status = 'RUNNING'
                  AND lease_expires_at <= NOW()
                )
              )
            ORDER BY available_at ASC, created_at ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED
          )
          UPDATE pipeline_tasks t
          SET status = 'RUNNING',
              lease_id = gen_random_uuid(),
              lease_expires_at = NOW() + make_interval(secs => $4::int),
              heartbeat_at = NOW(),
              claimed_by = $5,
              attempt_count = attempt_count + 1,
              last_error = CASE
                WHEN t.status = 'RUNNING' THEN COALESCE(t.last_error, 'Previous task lease expired before completion; reclaiming.')
                ELSE t.last_error
              END,
              updated_at = NOW()
          FROM claimable
          WHERE t.id = claimable.id
          RETURNING t.*
        `, [
				ctx.workspaceId,
				input.taskType,
				limit,
				leaseSeconds,
				claimedBy
			]);
			for (const row of rows) await client.query(`
            INSERT INTO pipeline_task_attempts (
              workspace_id,
              task_id,
              attempt_number,
              status,
              started_at
            )
            VALUES ($1, $2, $3, 'STARTED', NOW())
            ON CONFLICT (task_id, attempt_number)
            DO NOTHING
          `, [
				ctx.workspaceId,
				row.id,
				row.attempt_count
			]);
			await client.query("COMMIT");
			return rows.map((row) => ({
				taskId: row.id,
				taskKey: row.task_key,
				taskType: row.task_type,
				payload: row.payload,
				leaseId: row.lease_id || crypto.default.randomUUID(),
				leaseExpiresAt: row.lease_expires_at || new Date(Date.now() + leaseSeconds * 1e3).toISOString(),
				attemptNumber: row.attempt_count,
				maxAttempts: row.max_attempts
			}));
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function heartbeatPipelineTask(taskId, leaseId, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const extendSeconds = options?.extendLeaseSeconds ?? 120;
		return ((await client.query(`
        UPDATE pipeline_tasks
        SET heartbeat_at = NOW(),
            lease_expires_at = NOW() + make_interval(secs => $4::int),
            updated_at = NOW()
        WHERE workspace_id = $1
          AND id = $2
          AND status = 'RUNNING'
          AND lease_id = $3::uuid
      `, [
			ctx.workspaceId,
			taskId,
			leaseId,
			extendSeconds
		])).rowCount ?? 0) > 0;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function completePipelineTaskAndRun(task, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		await client.query("BEGIN");
		try {
			await client.query(`
          UPDATE pipeline_task_attempts
          SET status = 'COMPLETED',
              finished_at = NOW()
          WHERE workspace_id = $1
            AND task_id = $2
            AND attempt_number = $3
        `, [
				ctx.workspaceId,
				task.taskId,
				task.attemptNumber
			]);
			if ((await client.query(`
          UPDATE pipeline_tasks
          SET status = 'COMPLETED',
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = NULL,
              blocked_on = NULL,
              blocked_reason = NULL,
              repair_action = NULL,
              completed_at = NOW(),
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
        `, [
				ctx.workspaceId,
				task.taskId,
				task.leaseId
			])).rows.length === 0) throw new Error(`Lost lease while completing pipeline task ${task.taskId}.`);
			await options?.afterComplete?.(client);
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function blockPipelineTask(task, input, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		await client.query("BEGIN");
		try {
			await client.query(`
          UPDATE pipeline_task_attempts
          SET status = 'BLOCKED',
              finished_at = NOW(),
              error_message = $4
          WHERE workspace_id = $1
            AND task_id = $2
            AND attempt_number = $3
        `, [
				ctx.workspaceId,
				task.taskId,
				task.attemptNumber,
				input.reason
			]);
			if ((await client.query(`
          UPDATE pipeline_tasks
          SET status = 'BLOCKED_DEPENDENCY',
              -- available_at is NOT NULL by schema contract. Blocked tasks are
              -- excluded by status, so retain a valid timestamp rather than
              -- turning dependency blocking into a database constraint error.
              available_at = NOW(),
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = $4,
              blocked_on = $5,
              blocked_reason = $4,
              repair_action = $6,
              completed_at = NULL,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
        `, [
				ctx.workspaceId,
				task.taskId,
				task.leaseId,
				input.reason,
				input.blockedOn,
				input.repairAction
			])).rows.length === 0) throw new Error(`Lost lease while blocking pipeline task ${task.taskId}.`);
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function failPipelineTask(task, errorMessage, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	const delaySeconds = Math.min(3600, 30 * Math.pow(2, Math.max(0, task.attemptNumber - 1)));
	const availableAt = new Date(Date.now() + delaySeconds * 1e3).toISOString();
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		await client.query("BEGIN");
		try {
			await client.query(`
          UPDATE pipeline_task_attempts
          SET status = 'FAILED',
              finished_at = NOW(),
              error_message = $4
          WHERE workspace_id = $1
            AND task_id = $2
            AND attempt_number = $3
        `, [
				ctx.workspaceId,
				task.taskId,
				task.attemptNumber,
				errorMessage
			]);
			const deadLetter = task.attemptNumber >= task.maxAttempts;
			if ((await client.query(`
          UPDATE pipeline_tasks
          SET status = $4,
              available_at = COALESCE($5::timestamptz, available_at),
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = $6,
              dead_letter_reason = CASE WHEN $4 = 'DEAD_LETTER' THEN $6 ELSE dead_letter_reason END,
              blocked_on = NULL,
              blocked_reason = NULL,
              repair_action = NULL,
              completed_at = CASE WHEN $4 = 'DEAD_LETTER' THEN NOW() ELSE completed_at END,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
        `, [
				ctx.workspaceId,
				task.taskId,
				task.leaseId,
				deadLetter ? "DEAD_LETTER" : "RETRY_WAIT",
				deadLetter ? null : availableAt,
				errorMessage
			])).rows.length === 0) throw new Error(`Lost lease while failing pipeline task ${task.taskId}.`);
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
/** Release an unfinished lease after a worker cancellation without dead-lettering the task. */
async function releasePipelineTaskForRetry(task, reason, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		await client.query("BEGIN");
		try {
			const released = await client.query(`
          UPDATE pipeline_tasks
          SET status = 'RETRY_WAIT',
              available_at = NOW(),
              lease_id = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              claimed_by = NULL,
              last_error = $4,
              updated_at = NOW()
          WHERE workspace_id = $1
            AND id = $2::uuid
            AND status = 'RUNNING'
            AND lease_id = $3::uuid
          RETURNING id
        `, [
				ctx.workspaceId,
				task.taskId,
				task.leaseId,
				reason
			]);
			if (released.rows.length > 0) await client.query(`
            UPDATE pipeline_task_attempts
            SET status = 'FAILED',
                finished_at = NOW(),
                error_message = $3,
                metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('cancelled', true)
            WHERE workspace_id = $1
              AND task_id = $2::uuid
              AND attempt_number = $4
              AND status = 'STARTED'
          `, [
				ctx.workspaceId,
				task.taskId,
				reason,
				task.attemptNumber
			]);
			await client.query("COMMIT");
			return released.rows.length > 0;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/pipeline/laneConfigLoader.ts
var __filename$1 = (0, url.fileURLToPath)(require("url").pathToFileURL(__filename).href);
var __dirname$1 = path.default.dirname(__filename$1);
function parseYamlFile(filePath) {
	return (js_yaml.load || js_yaml.default?.load || js_yaml)(fs.default.readFileSync(filePath, "utf-8"));
}
function normalizeConcept(concept) {
	return concept.toLowerCase().replace(/_/g, " ").trim();
}
function dedupe(values) {
	return [...new Set(values.filter((v) => v.trim().length > 0))];
}
function laneConfigToDefinition(laneConfig) {
	const concepts = laneConfig.scope?.included_domain_concepts?.any || [];
	const requiredFunctions = laneConfig.scope?.required_function_concepts?.any || [];
	const excludedConcepts = laneConfig.scope?.excluded_domain_concepts?.any || [];
	const prototypeTexts = (laneConfig.prototypes || []).map((p) => p.text.trim()).filter((p) => p.length > 0);
	const positiveConcepts = dedupe((laneConfig.positive_concepts || concepts.map(normalizeConcept)).map((c) => c.trim()));
	const negativeConcepts = dedupe((laneConfig.negative_concepts || excludedConcepts.map(normalizeConcept)).map((c) => c.trim()));
	const primarySemanticThreshold = laneConfig.routing?.minimum_semantic_score ?? laneConfig.semantic_threshold ?? .35;
	return {
		title: laneConfig.display_name,
		description: laneConfig.description,
		threshold: primarySemanticThreshold,
		semantic_threshold: primarySemanticThreshold,
		enabled_sources: (laneConfig.sourcing?.enabled_sources || []).map((s) => s.toLowerCase()),
		title_families: dedupe(requiredFunctions.map(normalizeConcept)),
		keywords: dedupe(concepts.map(normalizeConcept)),
		positive_concepts: positiveConcepts,
		negative_concepts: negativeConcepts,
		included_domain_concepts: concepts.map(normalizeConcept),
		required_function_concepts: requiredFunctions.map(normalizeConcept),
		minimum_domain_score: laneConfig.routing?.minimum_domain_score,
		minimum_function_score: laneConfig.routing?.minimum_function_score,
		secondary_lane_threshold: laneConfig.routing?.secondary_lane_threshold,
		maximum_ai_interpretations_per_run: laneConfig.budget?.maximum_ai_interpretations_per_run ?? 0,
		prototype_query: prototypeTexts.join(" ") || laneConfig.description
	};
}
function loadGlobalLanesConfig() {
	const registryPath = path.default.resolve(__dirname$1, "../../config/lanes/registry.yml");
	if (!fs.default.existsSync(registryPath)) throw new Error(`Lane registry not found at ${registryPath}`);
	const registry = parseYamlFile(registryPath);
	if (!registry.lanes || registry.lanes.length === 0) throw new Error("Lane registry contains no lanes.");
	const lanes = {};
	for (const entry of registry.lanes) {
		if (entry.enabled_by_default === false) continue;
		const lanePath = path.default.resolve(__dirname$1, `../../config/lanes/${entry.config_file}`);
		if (!fs.default.existsSync(lanePath)) throw new Error(`Lane config file not found for ${entry.lane_key}: ${lanePath}`);
		const laneConfig = LaneFileConfigSchema.parse(parseYamlFile(lanePath));
		lanes[entry.lane_key] = laneConfigToDefinition(laneConfig);
	}
	return {
		version: registry.config_version || registry.schema_version || "2.2.0",
		description: "Authoritative multi-lane definition and semantic threshold registry",
		lanes,
		unclassified_policy: {
			label: "UNCLASSIFIED",
			fallback_behavior: "DEFER_ROUTING",
			min_similarity_floor: .25
		}
	};
}
var loadLanesConfig = loadGlobalLanesConfig;
async function loadWorkspaceLanesConfig(clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		try {
			let active = await listActiveLaneRevisions(client, { context: ctx });
			if (active.length === 0 && options?.seedIfEmpty) try {
				const registryPath = path.default.resolve(__dirname$1, "../../config/lanes/registry.yml");
				if (!fs.default.existsSync(registryPath)) throw new Error(`Lane registry not found at ${registryPath}`);
				const registry = parseYamlFile(registryPath);
				for (const entry of registry.lanes || []) {
					if (entry.enabled_by_default === false) continue;
					const lanePath = path.default.resolve(__dirname$1, `../../config/lanes/${entry.config_file}`);
					if (!fs.default.existsSync(lanePath)) throw new Error(`Lane config file not found for ${entry.lane_key}: ${lanePath}`);
					const laneConfig = LaneFileConfigSchema.parse(parseYamlFile(lanePath));
					await upsertLaneRevision({
						laneKey: entry.lane_key,
						content: laneConfig
					}, client, {
						context: ctx,
						note: `seed from ${entry.config_file}`
					});
				}
				active = await listActiveLaneRevisions(client, { context: ctx });
			} catch (seedErr) {
				console.warn(`⚠️ Failed to seed workspace lane registry from files; falling back to FILES. ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`);
				return {
					source: "FILES",
					config: loadGlobalLanesConfig()
				};
			}
			if (active.length > 0) {
				const lanes = {};
				for (const lane of active) {
					const content = lane.content;
					const key = lane.laneKey;
					lanes[key] = laneConfigToDefinition({
						...content,
						lane_key: key
					});
				}
				const version = `lanes_db_${sha256Hex(stableStringify(active.map((l) => `${l.laneKey}:${l.revisionNumber}:${l.contentHash}`).sort().join("|"))).slice(0, 12)}`;
				return {
					source: "LANE_REGISTRY_DB",
					activeLaneRevisions: active,
					config: {
						version,
						description: "Workspace lane revisions (registry-backed)",
						lanes,
						unclassified_policy: {
							label: "UNCLASSIFIED",
							fallback_behavior: "DEFER_ROUTING",
							min_similarity_floor: .25
						}
					}
				};
			}
		} catch (err) {
			if (err?.code !== "42P01") throw err;
		}
		return {
			source: "FILES",
			config: loadGlobalLanesConfig()
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/pipeline/laneRouter.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$4 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
var LANE_ROUTER_RULE_VERSION = "lane_router_v2.2.1";
var cosineSimilarity$1 = (vecA, vecB) => {
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
function applyNegativeExclusion(description, laneDef) {
	if (!laneDef.negative_concepts?.length) return false;
	const d = description.toLowerCase();
	for (const nc of laneDef.negative_concepts) if (containsConcept(d, nc)) return true;
	return false;
}
function containsConcept(text, concept) {
	return conceptVariants(concept).some((variant) => {
		const normalized = variant.toLowerCase().replace(/_/g, " ").trim();
		if (!normalized) return false;
		const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
		return new RegExp(`\\b${escaped}\\b`, "i").test(text);
	});
}
var CONCEPT_ALIASES = {
	"ai engineering": [
		"ai engineer",
		"artificial intelligence engineer",
		"machine learning engineer",
		"ml engineer",
		"ai systems engineer",
		"applied ai",
		"applied ai engineer",
		"agentic ai",
		"ai platform engineer",
		"ai/ml engineer",
		"llm engineering",
		"llm engineer",
		"ai infrastructure engineer"
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
		"ai/ml"
	],
	"data engineering": [
		"data engineer",
		"data engineering",
		"data pipeline",
		"data pipelines",
		"etl",
		"data platform"
	],
	"ai data architecture": [
		"ai data architecture",
		"data architecture",
		"ai architecture",
		"data platform architecture"
	],
	"ai systems architecture": [
		"ai systems architect",
		"ai systems architecture",
		"ai architecture",
		"ml systems architect"
	],
	"llm infrastructure": [
		"llm infrastructure",
		"llm platform",
		"llm training",
		"llm inference",
		"llm engineering",
		"inference platform",
		"model serving",
		"foundation model infrastructure"
	],
	"ai research": [
		"ai research",
		"machine learning research",
		"deep learning research",
		"ai researcher",
		"ml researcher",
		"ai scientist"
	],
	"legal ai": [
		"legal ai",
		"legaltech",
		"legal technology",
		"legal nlp",
		"contract analytics"
	],
	"compliance automation": [
		"compliance automation",
		"compliance engineering",
		"regtech",
		"regulatory technology"
	],
	"fraud detection": [
		"fraud detection",
		"fraud analytics",
		"financial crime technology"
	],
	"document intelligence": [
		"document intelligence",
		"document ai",
		"contract analytics",
		"intelligent document processing"
	],
	"scientific ml": [
		"scientific ml",
		"scientific machine learning",
		"machine learning for science"
	],
	"research engineering": [
		"research engineering",
		"research engineer",
		"research software engineer"
	],
	"bioinformatics": [
		"bioinformatics",
		"bioinformatics scientist",
		"computational biology"
	],
	"clinical informatics": [
		"clinical informatics",
		"clinical data science",
		"health data science"
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
		"algorithmic trading"
	],
	"investment data platform": [
		"investment data platform",
		"investment data engineering",
		"market data platform",
		"market data feeds",
		"market data infrastructure",
		"portfolio data platform"
	],
	"time series modelling": [
		"time series modelling",
		"time-series modelling",
		"time series modeling",
		"time-series modeling",
		"forecasting"
	],
	"ai": [
		"artificial intelligence",
		"machine learning",
		"ml",
		"deep learning",
		"llm",
		"nlp"
	],
	"machine learning": [
		"machine learning",
		"ml",
		"deep learning"
	],
	"data platform": [
		"data platform",
		"data warehouse",
		"data lake",
		"lakehouse",
		"data pipeline"
	],
	"data science": [
		"data science",
		"data scientist",
		"ai/ml data scientist",
		"applied statistics",
		"predictive modelling",
		"predictive modeling"
	],
	"regtech": [
		"regtech",
		"regulatory technology",
		"compliance automation",
		"aml",
		"kyc"
	],
	"legaltech": [
		"legaltech",
		"legal technology",
		"legal ai",
		"contract analytics"
	],
	"healthcare": [
		"healthcare",
		"health data",
		"clinical",
		"medical"
	],
	"biotech": [
		"biotech",
		"biotechnology",
		"drug discovery",
		"bioinformatics"
	],
	"pharmaceutical": [
		"pharmaceutical",
		"pharma",
		"drug discovery"
	],
	"investment management": [
		"investment management",
		"asset management",
		"fund management",
		"portfolio management"
	],
	"asset management": [
		"asset management",
		"investment management",
		"fund management"
	],
	"market data": [
		"market data",
		"financial data",
		"securities data",
		"order book"
	],
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
		"low-latency market data"
	],
	"technical programme delivery": [
		"technical programme",
		"technical program",
		"technical programme manager",
		"technical program manager",
		"technical delivery"
	],
	"technical project delivery": [
		"technical project",
		"technical project manager",
		"technical delivery"
	],
	"technical product delivery": [
		"technical product",
		"technical product manager",
		"technical product owner"
	],
	"technical architecture": [
		"technical architect",
		"solution architect",
		"systems architect",
		"software architect",
		"data architect",
		"ai architect"
	],
	"technical delivery": [
		"technical delivery",
		"technical delivery manager",
		"delivery manager",
		"engineering delivery"
	],
	"digital public infrastructure": [
		"digital public infrastructure",
		"digital government infrastructure",
		"public digital infrastructure"
	],
	"machine learning research": [
		"machine learning research",
		"ml research",
		"ai research",
		"research scientist"
	]
};
function conceptVariants(concept) {
	const normalized = concept.toLowerCase().replace(/_/g, " ").trim();
	return [normalized, ...CONCEPT_ALIASES[normalized] || []];
}
function conceptScopeScore(description, concepts) {
	if (!concepts || concepts.length === 0) return 1;
	return concepts.some((concept) => containsConcept(description, concept)) ? 1 : 0;
}
function formatRoutingScore(value) {
	return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}
function buildNoMatchEvidence(candidates) {
	const evidence = ["ROUTING_POLICY_NO_MATCH"];
	const sorted = [...candidates].sort((a, b) => {
		if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
		return a.rank - b.rank;
	});
	for (const candidate of sorted.slice(0, 4)) {
		const minDomain = candidate.laneDef.minimum_domain_score ?? 0;
		const minFunction = candidate.laneDef.minimum_function_score ?? 0;
		const blockers = [];
		if (!candidate.enabled) blockers.push("lane_disabled");
		if (candidate.negativeExcluded) blockers.push("negative_concept");
		if (candidate.score < candidate.threshold) blockers.push(`semantic:${formatRoutingScore(candidate.score)}<${formatRoutingScore(candidate.threshold)}`);
		if (candidate.domainScore < minDomain) blockers.push(`domain:${formatRoutingScore(candidate.domainScore)}<${formatRoutingScore(minDomain)}`);
		if (candidate.functionScore < minFunction) blockers.push(`function:${formatRoutingScore(candidate.functionScore)}<${formatRoutingScore(minFunction)}`);
		evidence.push(`${candidate.laneKey}:blocked_by=${blockers.join(",") || "not_selected"};score=${formatRoutingScore(candidate.score)};threshold=${formatRoutingScore(candidate.threshold)};domain=${formatRoutingScore(candidate.domainScore)}/${formatRoutingScore(minDomain)};function=${formatRoutingScore(candidate.functionScore)}/${formatRoutingScore(minFunction)}`);
	}
	return evidence;
}
function extractCoreJobText(title, description) {
	const raw = (description || "").trim();
	let mergedText = raw;
	if (raw.startsWith("{")) try {
		const parsed = JSON.parse(raw);
		const parts = [];
		if (typeof parsed?.job_description === "string") parts.push(parsed.job_description);
		if (Array.isArray(parsed?.key_responsibilities)) parts.push(parsed.key_responsibilities.join("\n"));
		if (Array.isArray(parsed?.technical_skills)) parts.push(parsed.technical_skills.join("\n"));
		if (Array.isArray(parsed?.qualifications_education)) parts.push(parsed.qualifications_education.join("\n"));
		if (Array.isArray(parsed?.nice_to_haves)) parts.push(parsed.nice_to_haves.join("\n"));
		mergedText = parts.filter(Boolean).join("\n");
	} catch {
		mergedText = raw;
	}
	const lines = stripHtmlToText(mergedText).split("\n").map((l) => l.trim()).filter(Boolean);
	const boilerplateHeadings = /* @__PURE__ */ new Set([
		"equal opportunity employer",
		"benefits & perks",
		"benefits",
		"about us",
		"diversity & inclusion",
		"diversity and inclusion"
	]);
	const sections = [];
	let current = {
		heading: null,
		body: []
	};
	const flush = () => {
		if (current.heading || current.body.length) {
			sections.push(current);
			current = {
				heading: null,
				body: []
			};
		}
	};
	for (const line of lines) {
		const normalizedHeading = line.replace(/:\s*$/, "").toLowerCase();
		if (boilerplateHeadings.has(normalizedHeading) || line.endsWith(":") && line.length <= 60) {
			flush();
			current.heading = normalizedHeading;
			continue;
		}
		current.body.push(line);
	}
	flush();
	return `${title}. ${sections.filter((s) => !s.heading || !boilerplateHeadings.has(s.heading)).flatMap((s) => s.body).join(" ").slice(0, 2e3)}`.trim();
}
async function runLaneRouting(clientOrPool, options) {
	return runLaneRouter(clientOrPool, options);
}
async function runLaneRouter(clientOrPool, options) {
	const pool = clientOrPool || defaultPool$4;
	const ctx = options?.context ?? await resolveWorkspaceContext(pool);
	const configResult = await loadWorkspaceLanesConfig(pool, {
		context: ctx,
		seedIfEmpty: true
	});
	const config = configResult.config;
	const configSourceLabel = configResult.source === "FILES" ? "config/lanes (FILES)" : "workspace lanes (DB)";
	console.log(`Starting Semantic Lane Routing from ${configSourceLabel}. Lanes version: ${config.version || "unknown"}`);
	const currentLaneRouterModelPrefix = `${LANE_ROUTER_RULE_VERSION}|${config.version ?? "lanes_unknown"}|`;
	const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
	const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
	const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0 ? Number(options?.limit) : null;
	const params = [ctx.workspaceId];
	if (jobVersionIds.length === 0) params.push(currentLaneRouterModelPrefix);
	const jobVersionFilter = jobVersionIds.length > 0 ? `AND jv.id = ANY($${params.push(jobVersionIds)}::uuid[])` : "";
	const canonicalJobFilter = canonicalJobIds.length > 0 ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])` : "";
	const limitClause = limit ? `LIMIT $${params.push(limit)}` : "";
	let jobs = [];
	try {
		jobs = (await pool.query(`
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
          AND (
            COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
           OR (
             COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED'
             AND (
               -- Explicit replay targets are allowed through even when a
               -- previous lane decision exists. This is required to repair
               -- technical/threshold deferrals after embedding or policy
               -- changes without weakening the normal idempotent scan.
               ${jobVersionIds.length > 0 ? "TRUE" : `
                 COALESCE(c.routing_disposition, 'TECHNICAL_DEFERRED') <> 'POLICY_NO_MATCH'
                 AND
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
           )
          )
          ${jobVersionFilter}
          ${canonicalJobFilter}
        ORDER BY c.created_at ASC, c.id ASC
        ${limitClause}
      `, params)).rows;
	} catch (error) {
		if (error?.code !== "42P01" && error?.code !== "42703") throw error;
		const fallbackParams = [ctx.workspaceId];
		const fallbackJobVersionFilter = jobVersionIds.length > 0 ? `AND jv.id = ANY($${fallbackParams.push(jobVersionIds)}::uuid[])` : "";
		const fallbackCanonicalJobFilter = canonicalJobIds.length > 0 ? `AND c.id = ANY($${fallbackParams.push(canonicalJobIds)}::uuid[])` : "";
		const fallbackLimitClause = limit ? `LIMIT $${fallbackParams.push(limit)}` : "";
		jobs = (await pool.query(`
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
           AND (
             COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
             OR (${jobVersionIds.length > 0 ? "COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED'" : "COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED' AND COALESCE(c.routing_disposition, 'TECHNICAL_DEFERRED') <> 'POLICY_NO_MATCH'"})
           )
          ${fallbackJobVersionFilter}
          ${fallbackCanonicalJobFilter}
        ORDER BY c.created_at ASC, c.id ASC
        ${fallbackLimitClause}
      `, fallbackParams)).rows;
	}
	console.log(`Found ${jobs.length} canonical jobs to route.`);
	if (jobs.length === 0) return {
		routed: 0,
		deferred: 0
	};
	if (process.env.PIPELINE_TASKS_SHADOW_ENQUEUE === "true") {
		let enqueued = 0;
		for (const job of jobs) {
			const taskKey = `lane_route:${job.latest_version_id}:${config.version || "unknown"}`;
			try {
				if ((await enqueuePipelineTask({
					taskType: "LANE_ROUTE_JOB_VERSION",
					taskKey,
					payload: {
						canonical_job_id: job.id,
						job_version_id: job.latest_version_id,
						lanes_version: config.version ?? null
					}
				}, pool, { context: ctx })).inserted) enqueued += 1;
			} catch (err) {
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
		provider;
		jobId;
		constructor(provider, message, jobId) {
			super(message);
			this.name = "EmbeddingRunError";
			this.provider = provider;
			this.jobId = jobId;
		}
	}
	const providerOrder = ((process.env.EMBEDDING_PRIMARY_PROVIDER || "").trim().toLowerCase() === "openai" || process.env.FORCE_OPENAI === "true" ? "openai" : "gemini") === "openai" ? ["openai", "gemini"] : ["gemini", "openai"];
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	try {
		const configuredPrimaryProvider = (process.env.EMBEDDING_PRIMARY_PROVIDER || "gemini").trim().toLowerCase();
		const configuredPrimaryModel = (process.env.EMBEDDING_PRIMARY_MODEL || MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL).trim();
		const configuredFallbackProvider = (process.env.EMBEDDING_FALLBACK_PROVIDER || "openai").trim().toLowerCase();
		const configuredFallbackModel = (process.env.EMBEDDING_FALLBACK_MODEL || MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL).trim();
		const publishedEmbeddingSets = /* @__PURE__ */ new Map();
		const laneNodeIds = (configResult.activeLaneRevisions || []).map((revision) => ({
			laneKey: revision.laneKey,
			nodeId: revision.laneRevisionId
		}));
		if (laneNodeIds.length === Object.keys(config.lanes).length && laneNodeIds.length > 0) try {
			const published = await client.query(`SELECT v.embedding_space_id,
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
           ORDER BY es.created_at DESC`, [
				ctx.workspaceId,
				jobs.map((job) => job.latest_version_id),
				laneNodeIds.map((revision) => revision.nodeId),
				configuredPrimaryProvider,
				configuredPrimaryModel,
				configuredFallbackProvider,
				configuredFallbackModel
			]);
			const grouped = /* @__PURE__ */ new Map();
			for (const row of published.rows) {
				const rows = grouped.get(row.embedding_space_id) || [];
				rows.push(row);
				grouped.set(row.embedding_space_id, rows);
			}
			for (const rows of grouped.values()) {
				const provider = rows[0]?.provider;
				if (!provider) continue;
				const parseVector = (value) => {
					if (Array.isArray(value)) return value.map(Number);
					return String(value).replace(/[{}]/g, "").split(",").map(Number).filter(Number.isFinite);
				};
				const byNode = new Map(rows.map((row) => [`${row.node_type}:${row.node_id}`, parseVector(row.embedding_values)]));
				const dimensions = Number(rows[0]?.vector_dimensions || 0);
				const laneEmbeddings = {};
				let complete = dimensions > 0;
				for (const revision of laneNodeIds) {
					const vector = byNode.get(`LANE_PROTOTYPE:${revision.nodeId}`);
					if (!vector || vector.length !== dimensions) complete = false;
					else laneEmbeddings[revision.laneKey] = vector;
				}
				const jobEmbeddings = /* @__PURE__ */ new Map();
				for (const job of jobs) {
					const vector = byNode.get(`JOB_VERSION:${job.latest_version_id}`);
					if (!vector || vector.length !== dimensions) complete = false;
					else jobEmbeddings.set(job.id, vector);
				}
				if (complete && Object.keys(laneEmbeddings).length === laneNodeIds.length && jobEmbeddings.size === jobs.length) publishedEmbeddingSets.set(provider, {
					laneEmbeddings,
					jobEmbeddings,
					dimensions,
					model: String(rows[0]?.model || "unknown")
				});
			}
		} catch (error) {
			if (error?.code !== "42P01") throw error;
		}
		const useWorkspaceLaneTables = configResult.source === "LANE_REGISTRY_DB";
		const pipelineRunId = crypto.default.randomUUID();
		const laneSnapshot = {
			source: configResult.source,
			lanes_version: config.version ?? null,
			active_lane_revisions: configResult.activeLaneRevisions?.map((lane) => ({
				lane_key: lane.laneKey,
				lane_identity_id: lane.laneIdentityId,
				lane_revision_id: lane.laneRevisionId,
				revision_number: lane.revisionNumber,
				content_hash: lane.contentHash,
				activated_at: lane.activatedAt
			})) ?? []
		};
		const loadPreferenceOrdering = async () => {
			if (!useWorkspaceLaneTables) return {
				laneRankByKey: {},
				laneEnabledByKey: {}
			};
			try {
				const { rows } = await client.query(`
            SELECT li.lane_key, wlp.enabled, wlp.priority_rank
            FROM workspace_lane_preferences wlp
            JOIN lane_identities li ON li.id = wlp.lane_identity_id
            WHERE wlp.workspace_id = $1
              AND wlp.workspace_user_id = $2
          `, [ctx.workspaceId, ctx.userId]);
				const laneRankByKey = {};
				const laneEnabledByKey = {};
				for (const row of rows) {
					laneRankByKey[row.lane_key] = row.priority_rank ?? 1e3;
					laneEnabledByKey[row.lane_key] = row.enabled !== false;
				}
				return {
					laneRankByKey,
					laneEnabledByKey
				};
			} catch (error) {
				if (error?.code === "42P01") return {
					laneRankByKey: {},
					laneEnabledByKey: {}
				};
				throw error;
			}
		};
		const preferences = await loadPreferenceOrdering();
		const preferenceRank = (laneKey) => preferences.laneRankByKey[laneKey] ?? 1e3;
		const preferenceEnabled = (laneKey) => {
			if (laneKey in preferences.laneEnabledByKey) return preferences.laneEnabledByKey[laneKey];
			return true;
		};
		const persistLaneDecision = async (params) => {
			if (!useWorkspaceLaneTables) return null;
			const embeddingModel = params.embeddingModel || (params.embeddingProvider === "gemini" ? MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL : MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL);
			const modelVersion = [
				LANE_ROUTER_RULE_VERSION,
				config.version ?? "lanes_unknown",
				`${params.embeddingProvider}:${embeddingModel}:${params.embeddingDimensions}`
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
				evaluated_at: params.evaluatedAt
			});
			const decisionHash = sha256Hex(stableStringify(decisionJson));
			try {
				const inserted = await client.query(`
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
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (workspace_id, decision_hash)
            DO NOTHING
            RETURNING id
          `, [
					ctx.workspaceId,
					params.canonicalJobId,
					params.jobVersionId,
					decisionHash,
					decisionJson.schema_version,
					modelVersion,
					laneSnapshot,
					decisionJson,
					ctx.userId
				]);
				if (inserted.rows.length > 0) return inserted.rows[0].id;
				return (await client.query(`
            SELECT id
            FROM lane_decisions
            WHERE workspace_id = $1
              AND decision_hash = $2
            LIMIT 1
          `, [ctx.workspaceId, decisionHash])).rows[0]?.id ?? null;
			} catch (error) {
				if (error?.code === "42P01") return null;
				throw error;
			}
		};
		const routeWithProvider = async (provider) => {
			console.log(`Lane routing embedding provider: ${provider}`);
			const laneEmbeddings = {};
			let prototypeDimensions = null;
			const publishedSet = publishedEmbeddingSets.get(provider);
			if (publishedSet) {
				Object.assign(laneEmbeddings, publishedSet.laneEmbeddings);
				prototypeDimensions = publishedSet.dimensions;
			}
			for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
				if (publishedSet) break;
				let vector;
				try {
					vector = await generateEmbeddingWithProvider(laneDef.prototype_query, provider);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new EmbeddingRunError(provider, `prototype embedding failed for lane ${laneKey}: ${message}`);
				}
				if (vector.length === 0) throw new EmbeddingRunError(provider, `prototype embedding was empty for lane ${laneKey}`);
				if (prototypeDimensions == null) prototypeDimensions = vector.length;
				else if (vector.length !== prototypeDimensions) throw new EmbeddingRunError(provider, `prototype embedding dimension mismatch for lane ${laneKey}: expected ${prototypeDimensions} got ${vector.length}`);
				laneEmbeddings[laneKey] = vector;
			}
			const jobEmbeddings = new Map(publishedSet?.jobEmbeddings || []);
			if (publishedSet) console.log(`Using published ${provider} embedding batch for lane routing.`);
			for (const job of jobs) {
				if (publishedSet) break;
				const coreText = extractCoreJobText(job.normalized_title, job.description_text || "");
				let jobEmbedding;
				try {
					jobEmbedding = await generateEmbeddingWithProvider(coreText, provider);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new EmbeddingRunError(provider, `job embedding failed: ${message}`, job.id);
				}
				if (jobEmbedding.length === 0 || jobEmbedding.every((value) => value === 0)) throw new EmbeddingRunError(provider, "job embedding was empty or zero-valued", job.id);
				if (prototypeDimensions !== null && jobEmbedding.length !== prototypeDimensions) throw new EmbeddingRunError(provider, `job embedding dimension mismatch: expected ${prototypeDimensions} got ${jobEmbedding.length}`, job.id);
				jobEmbeddings.set(job.id, jobEmbedding);
			}
			let routedCount = 0;
			let deferredCount = 0;
			for (const job of jobs) {
				await client.query("BEGIN");
				try {
					const jobEmbedding = jobEmbeddings.get(job.id);
					if (!jobEmbedding) throw new EmbeddingRunError(provider, "job embedding was not prepared", job.id);
					if (jobEmbedding.every((v) => v === 0)) {
						console.warn(`⚠️ Zero embedding for job ${job.id}. Deferring (never default lane).`);
						const evaluatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
							laneEvidence: ["ZERO_VECTOR_EMBEDDING"],
							evaluatedAt
						});
						if ((await client.query(`UPDATE canonical_jobs
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
                 AND latest_job_version_id = $5`, [
							ctx.workspaceId,
							job.id,
							JSON.stringify([]),
							JSON.stringify(["ZERO_VECTOR_EMBEDDING"]),
							job.latest_version_id
						]))?.rowCount === 0) {
							await client.query("COMMIT");
							continue;
						}
						if (laneDecisionId) await client.query(`UPDATE canonical_jobs
                 SET latest_lane_decision_id = $3,
                     updated_at = NOW()
                 WHERE workspace_id = $1
                   AND id = $2
                   AND latest_job_version_id = $4`, [
							ctx.workspaceId,
							job.id,
							laneDecisionId,
							job.latest_version_id
						]);
						await client.query("COMMIT");
						deferredCount++;
						continue;
					}
					if (prototypeDimensions != null && jobEmbedding.length !== prototypeDimensions) {
						console.warn(`⚠️ Embedding dimension mismatch for job ${job.id}: expected ${prototypeDimensions} got ${jobEmbedding.length}. Deferring.`);
						const evaluatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
							evaluatedAt
						});
						if ((await client.query(`UPDATE canonical_jobs
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
                 AND latest_job_version_id = $5`, [
							ctx.workspaceId,
							job.id,
							JSON.stringify([]),
							JSON.stringify([`EMBEDDING_DIM_MISMATCH:${jobEmbedding.length}!=${prototypeDimensions}`]),
							job.latest_version_id
						]))?.rowCount === 0) {
							await client.query("COMMIT");
							continue;
						}
						if (laneDecisionId) await client.query(`UPDATE canonical_jobs
                 SET latest_lane_decision_id = $3,
                     updated_at = NOW()
                 WHERE workspace_id = $1
                   AND id = $2
                   AND latest_job_version_id = $4`, [
							ctx.workspaceId,
							job.id,
							laneDecisionId,
							job.latest_version_id
						]);
						await client.query("COMMIT");
						deferredCount++;
						continue;
					}
					let bestLane = null;
					let bestScore = -1;
					const scoreMap = {};
					const domainScoreMap = {};
					const functionScoreMap = {};
					const laneEvidence = [];
					const descText = extractCoreJobText(job.normalized_title || "", job.description_text || "").toLowerCase();
					for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
						if (!preferenceEnabled(laneKey)) {
							scoreMap[laneKey] = -1;
							continue;
						}
						if (applyNegativeExclusion(descText, laneDef)) {
							scoreMap[laneKey] = -1;
							continue;
						}
						const score = cosineSimilarity$1(jobEmbedding, laneEmbeddings[laneKey]);
						scoreMap[laneKey] = score;
						domainScoreMap[laneKey] = conceptScopeScore(descText, laneDef.included_domain_concepts);
						functionScoreMap[laneKey] = conceptScopeScore(descText, laneDef.required_function_concepts);
						if (score > bestScore) {
							bestScore = score;
							bestLane = laneKey;
						}
					}
					const minSimilarityFloor = config.unclassified_policy.min_similarity_floor || .25;
					const primaryCandidates = Object.entries(config.lanes).map(([laneKey, laneDef]) => {
						return {
							laneKey,
							laneDef,
							threshold: laneDef.semantic_threshold ?? laneDef.threshold ?? minSimilarityFloor,
							score: scoreMap[laneKey] ?? -1,
							domainScore: domainScoreMap[laneKey] ?? 0,
							functionScore: functionScoreMap[laneKey] ?? 0,
							rank: preferenceRank(laneKey),
							enabled: preferenceEnabled(laneKey),
							negativeExcluded: applyNegativeExclusion(descText, laneDef)
						};
					});
					const qualifyingPrimary = primaryCandidates.filter((c) => c.enabled).filter((c) => c.score >= c.threshold).filter((c) => c.domainScore >= (c.laneDef.minimum_domain_score ?? 0)).filter((c) => c.functionScore >= (c.laneDef.minimum_function_score ?? 0)).filter((c) => !c.negativeExcluded);
					if (qualifyingPrimary.length === 0) {
						laneEvidence.push(...buildNoMatchEvidence(primaryCandidates));
						bestLane = "UNCLASSIFIED";
						bestScore = Math.max(0, bestScore);
					} else {
						qualifyingPrimary.sort((a, b) => {
							if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
							return a.rank - b.rank;
						});
						bestLane = qualifyingPrimary[0].laneKey;
						bestScore = qualifyingPrimary[0].score;
					}
					const selectedLaneDef = bestLane === "UNCLASSIFIED" ? null : config.lanes[bestLane];
					const selectedThreshold = selectedLaneDef?.semantic_threshold ?? selectedLaneDef?.threshold ?? minSimilarityFloor;
					const laneConfidence = bestLane === "UNCLASSIFIED" ? "None" : bestScore >= selectedThreshold + .2 ? "High" : bestScore >= selectedThreshold + .1 ? "Medium" : "Low";
					const secondaryCandidates = [];
					for (const [laneKey, laneDef] of Object.entries(config.lanes)) {
						if (laneKey === bestLane) continue;
						if (!preferenceEnabled(laneKey)) continue;
						const threshold = laneDef.secondary_lane_threshold ?? laneDef.semantic_threshold ?? laneDef.threshold ?? minSimilarityFloor;
						const score = scoreMap[laneKey] || 0;
						const domainScore = domainScoreMap[laneKey] ?? 0;
						const functionScore = functionScoreMap[laneKey] ?? 0;
						if (score >= threshold && domainScore >= (laneDef.minimum_domain_score ?? 0) && functionScore >= (laneDef.minimum_function_score ?? 0) && !applyNegativeExclusion(descText, laneDef)) {
							if (laneDef.positive_concepts?.some((pc) => containsConcept(descText, pc))) {
								secondaryCandidates.push({
									laneKey,
									score,
									rank: preferenceRank(laneKey)
								});
								if (laneDef.positive_concepts) {
									for (const pc of laneDef.positive_concepts) if (containsConcept(descText, pc)) {
										laneEvidence.push(`${laneKey}: "${pc}"`);
										break;
									}
								}
							}
						}
					}
					secondaryCandidates.sort((a, b) => {
						if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
						return a.rank - b.rank;
					});
					const secondaryLanes = secondaryCandidates.map((c) => c.laneKey);
					const processingStatus = bestLane === "UNCLASSIFIED" ? "ROUTING_DEFERRED" : "LANE_ROUTED";
					const finalLaneEvidence = bestLane === "UNCLASSIFIED" ? laneEvidence : [
						...laneEvidence,
						`${bestLane}:domain_score=${(domainScoreMap[bestLane] ?? 0).toFixed(3)}`,
						`${bestLane}:function_score=${(functionScoreMap[bestLane] ?? 0).toFixed(3)}`
					];
					const evaluatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
						evaluatedAt
					});
					if ((await client.query(`UPDATE canonical_jobs
             SET primary_lane       = $1,
                 semantic_score     = $2,
                 processing_state   = $3::varchar,
                 processing_status  = $3::varchar,
                 lane_confidence    = $4,
                 secondary_lanes    = $5::jsonb,
                 lane_evidence      = $6::jsonb,
                 routing_disposition = CASE
                   WHEN $3::varchar = 'LANE_ROUTED' THEN 'ROUTED'
                   WHEN $6::jsonb @> '["ROUTING_POLICY_NO_MATCH"]'::jsonb THEN 'POLICY_NO_MATCH'
                   ELSE 'TECHNICAL_DEFERRED'
                 END,
                 updated_at         = NOW()
             WHERE workspace_id = $7
               AND id = $8
               AND latest_job_version_id = $9`, [
						bestLane,
						bestScore,
						processingStatus,
						laneConfidence,
						JSON.stringify(secondaryLanes),
						JSON.stringify(finalLaneEvidence),
						ctx.workspaceId,
						job.id,
						job.latest_version_id
					]))?.rowCount === 0) {
						await client.query("COMMIT");
						continue;
					}
					if (laneDecisionId) await client.query(`UPDATE canonical_jobs
               SET latest_lane_decision_id = $3,
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $2
                 AND latest_job_version_id = $4`, [
						ctx.workspaceId,
						job.id,
						laneDecisionId,
						job.latest_version_id
					]);
					await client.query("COMMIT");
					if (bestLane === "UNCLASSIFIED") deferredCount++;
					else routedCount++;
					const scoreLabel = bestLane === "UNCLASSIFIED" ? "BestScore" : "Score";
					const reasonLabel = bestLane === "UNCLASSIFIED" && finalLaneEvidence.length > 0 ? `, Reason: ${finalLaneEvidence[0]}` : "";
					console.log(`  -> Job ${job.id} ("${job.normalized_title}"): ${bestLane} (${scoreLabel}: ${bestScore.toFixed(3)}, Status: ${processingStatus}${reasonLabel})`);
				} catch (jobErr) {
					await client.query("ROLLBACK");
					if (jobErr instanceof EmbeddingRunError) throw jobErr;
					const message = jobErr instanceof Error ? jobErr.message : String(jobErr);
					const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
					console.error(`❌ Failed to route job ${job.id}:`, jobErr);
					const evaluatedAt = (/* @__PURE__ */ new Date()).toISOString();
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
						evaluatedAt
					});
					const canonicalUpdate = await client.query(`UPDATE canonical_jobs
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
               AND latest_job_version_id = $5`, [
						ctx.workspaceId,
						job.id,
						JSON.stringify([]),
						JSON.stringify([`ROUTING_ERROR:${trimmed}`]),
						job.latest_version_id
					]);
					if (canonicalUpdate?.rowCount !== 0 && laneDecisionId) await client.query(`UPDATE canonical_jobs
               SET latest_lane_decision_id = $3,
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $2
                 AND latest_job_version_id = $4`, [
						ctx.workspaceId,
						job.id,
						laneDecisionId,
						job.latest_version_id
					]);
					if (canonicalUpdate?.rowCount !== 0) deferredCount += 1;
				}
			}
			return {
				routed: routedCount,
				deferred: deferredCount
			};
		};
		let lastError = null;
		const publishedProviderOrder = providerOrder.filter((provider) => publishedEmbeddingSets.has(provider));
		const routingProviderOrder = publishedProviderOrder.length > 0 ? publishedProviderOrder : providerOrder;
		if (publishedProviderOrder.length > 0) console.log(`Using complete published embedding space(s) for lane routing: ${publishedProviderOrder.join(", ")}`);
		for (const provider of routingProviderOrder) try {
			const result = await routeWithProvider(provider);
			console.log(`Semantic Lane Routing complete. Routed: ${result.routed}, Deferred: ${result.deferred}`);
			return result;
		} catch (error) {
			lastError = error;
			if (error instanceof EmbeddingRunError) {
				const where = error.jobId ? `job ${error.jobId}` : "prototype embeddings";
				console.warn(`⚠️ Embedding provider ${provider} failed during ${where}: ${error.message}. Trying fallback...`);
				continue;
			}
			throw error;
		}
		const message = lastError instanceof Error ? lastError.message : String(lastError || "unknown");
		const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
		let deferredCount = 0;
		for (const job of jobs) if ((await client.query(`UPDATE canonical_jobs
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
           AND latest_job_version_id = $5`, [
			ctx.workspaceId,
			job.id,
			JSON.stringify([]),
			JSON.stringify([`EMBEDDING_UNAVAILABLE:${trimmed}`]),
			job.latest_version_id
		]))?.rowCount !== 0) deferredCount += 1;
		console.warn(`⚠️ Semantic Lane Routing deferred all jobs due to embedding failure: ${trimmed}`);
		return {
			routed: 0,
			deferred: deferredCount
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/config/registry.ts
async function getActiveConfigRevision(configKey, clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const { rows } = await client.query(`
        SELECT
          cd.id AS config_definition_id,
          cr.id AS config_revision_id,
          cr.revision_number AS revision_number,
          cr.schema_version AS schema_version,
          cr.content_hash AS content_hash,
          cr.content AS content
        FROM config_definitions cd
        JOIN config_active_revisions car ON car.config_definition_id = cd.id
        JOIN config_revisions cr ON cr.id = car.config_revision_id
        WHERE cd.workspace_id = $1
          AND cd.config_key = $2
        LIMIT 1
      `, [ctx.workspaceId, configKey]);
		if (rows.length === 0) return null;
		return {
			configDefinitionId: rows[0].config_definition_id,
			configRevisionId: rows[0].config_revision_id,
			revisionNumber: rows[0].revision_number,
			schemaVersion: rows[0].schema_version,
			contentHash: rows[0].content_hash,
			content: rows[0].content
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/evidence/evidenceStrengthPolicy.ts
var EvidenceTierSchema = zod.z.enum([
	"PROFESSIONAL_PRODUCTION",
	"DEPLOYED_OPEN_SOURCE",
	"APPLIED_PROJECT",
	"COURSE_PROJECT",
	"KNOWLEDGE_ONLY"
]);
var VerificationStatusSchema = zod.z.enum([
	"VERIFIED",
	"SELF_ATTESTED",
	"UNVERIFIED"
]);
var HoursPerWeekBandSchema = zod.z.enum([
	"FULL_TIME",
	"SUBSTANTIAL_PART_TIME",
	"LIMITED"
]);
var EvidenceStrengthPolicySchema = zod.z.object({
	schema_version: zod.z.string().optional(),
	policy_key: zod.z.string().optional(),
	evidence_tier_weights: zod.z.record(EvidenceTierSchema, zod.z.number()).default({}),
	verification_status_weights: zod.z.record(VerificationStatusSchema, zod.z.number()).default({}),
	hours_per_week_band_weights: zod.z.record(HoursPerWeekBandSchema, zod.z.number()).default({})
}).passthrough();
var DEFAULT_EVIDENCE_STRENGTH_POLICY = {
	schema_version: "2.2.0",
	policy_key: "evidence_strength_v1",
	evidence_tier_weights: {
		PROFESSIONAL_PRODUCTION: 1,
		DEPLOYED_OPEN_SOURCE: .8,
		APPLIED_PROJECT: .6,
		COURSE_PROJECT: .3,
		KNOWLEDGE_ONLY: .1
	},
	verification_status_weights: {
		VERIFIED: 1,
		SELF_ATTESTED: .7,
		UNVERIFIED: .4
	},
	hours_per_week_band_weights: {
		FULL_TIME: 1,
		SUBSTANTIAL_PART_TIME: .6,
		LIMITED: .3
	}
};
function hashEvidenceStrengthPolicy(policy) {
	return sha256Hex(stableStringify(policy));
}
async function loadActiveEvidenceStrengthPolicy(clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const active = await getActiveConfigRevision("evidence_strength", client, { context: options?.context ?? await resolveWorkspaceContext(client) });
		if (!active) return {
			policy: DEFAULT_EVIDENCE_STRENGTH_POLICY,
			policyHash: hashEvidenceStrengthPolicy(DEFAULT_EVIDENCE_STRENGTH_POLICY),
			source: "DEFAULT_FALLBACK"
		};
		const parsed = EvidenceStrengthPolicySchema.parse(active.content);
		return {
			policy: parsed,
			policyHash: active.contentHash || hashEvidenceStrengthPolicy(parsed),
			source: "REGISTRY",
			configRevisionId: active.configRevisionId
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
function computeEvidenceStrength(evidenceTier, verificationStatus, policy) {
	const strength = (policy.evidence_tier_weights[evidenceTier] ?? 0) * (policy.verification_status_weights[verificationStatus] ?? 0);
	return Math.max(0, Math.min(1, Number(strength.toFixed(6))));
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
	return sha256Hex(`${PIPELINE_CONTEXT_SCHEMA_VERSION}|${stableStringify({
		workspace_id: input.workspaceId,
		task_type: input.taskType,
		task_version: input.taskVersion,
		payload: contextPayload(input.payload)
	})}`);
}
//#endregion
//#region src/pipeline/deterministicMatcher.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$3 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
var STOP_WORDS = /* @__PURE__ */ new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"this",
	"that",
	"your",
	"you",
	"our",
	"are",
	"will",
	"have",
	"has",
	"into",
	"role",
	"job",
	"years",
	"year",
	"must",
	"plus",
	"required",
	"preferred"
]);
function tokenize(text) {
	return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t)));
}
function jaccard(a, b) {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) if (b.has(item)) intersection += 1;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}
function cosineSimilarity(vecA, vecB) {
	if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < vecA.length; i += 1) {
		dot += vecA[i] * vecB[i];
		normA += vecA[i] * vecA[i];
		normB += vecB[i] * vecB[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function flattenStructuredValue(value) {
	if (!value) return "";
	return Object.values(value).map((v) => {
		if (Array.isArray(v)) return v.join(" ");
		if (typeof v === "object" && v !== null) return JSON.stringify(v);
		return String(v);
	}).join(" ");
}
function buildRequirementText(req) {
	return [
		req.requirement_type,
		req.requirement_text,
		req.quote_text || "",
		flattenStructuredValue(req.structured_value)
	].join(" ").trim();
}
function buildFactText(fact) {
	return [
		fact.fact_type,
		fact.statement,
		fact.evidence_tier,
		fact.verification_status,
		flattenStructuredValue(fact.structured_value)
	].join(" ").trim();
}
function requirementWeight(importance) {
	if (importance === "MUST") return 1;
	if (importance === "PREFERRED") return .7;
	return .4;
}
var NON_CAPABILITY_REQUIREMENT_TYPES = /* @__PURE__ */ new Set([
	"OFFICE_DAYS",
	"WORK_MODE",
	"EMPLOYMENT_TYPE",
	"TRAVEL",
	"WORK_AUTH",
	"ON_CALL",
	"SHIFT_WORK"
]);
function isCapabilityRequirementType(requirementType) {
	return !NON_CAPABILITY_REQUIREMENT_TYPES.has(requirementType);
}
function scoreMatch(requirement, fact) {
	let score = jaccard(tokenize(buildRequirementText(requirement)), tokenize(buildFactText(fact)));
	if (requirement.requirement_type === "DOMAIN" || requirement.requirement_type === "FUNCTION") {
		const structured = flattenStructuredValue(requirement.structured_value).toLowerCase();
		if (structured.length > 0 && buildFactText(fact).toLowerCase().includes(structured)) score += .2;
	}
	if (fact.fact_type === requirement.requirement_type) score += .1;
	return Math.min(1, score);
}
var SEMANTIC_MATCH_THRESHOLD = .45;
async function listSemanticEmbeddingSpaceCandidates(client, ctx) {
	try {
		const primary = await client.query(`SELECT id
       FROM embedding_spaces
       WHERE workspace_id = $1
         AND active = TRUE
         AND is_fallback_space = FALSE
       ORDER BY created_at DESC
       LIMIT 1`, [ctx.workspaceId]);
		const fallback = await client.query(`SELECT id
       FROM embedding_spaces
       WHERE workspace_id = $1
         AND active = TRUE
         AND is_fallback_space = TRUE
       ORDER BY created_at DESC
       LIMIT 1`, [ctx.workspaceId]);
		return [primary.rows[0]?.id, fallback.rows[0]?.id].filter((id) => typeof id === "string" && id.length > 0);
	} catch (error) {
		if (error?.code === "42P01") return [];
		throw error;
	}
}
async function countMatchableNodes(client, ctx, embeddingSpaceId, nodeType, nodeIds) {
	if (!embeddingSpaceId || nodeIds.length === 0) return 0;
	try {
		return (await client.query(`SELECT COUNT(DISTINCT node_id)::int AS n
       FROM v_matchable_nodes
       WHERE workspace_id = $1
         AND embedding_space_id = $2
         AND node_type = $3
         AND node_id = ANY($4::uuid[])`, [
			ctx.workspaceId,
			embeddingSpaceId,
			nodeType,
			nodeIds
		])).rows[0]?.n ?? 0;
	} catch (error) {
		if (error?.code === "42P01") return 0;
		throw error;
	}
}
async function loadNodeEmbeddings(client, ctx, embeddingSpaceId, nodeType, nodeIds) {
	if (nodeIds.length === 0) return /* @__PURE__ */ new Map();
	try {
		const res = await client.query(`SELECT node_id, vector_dimensions, embedding_values
       FROM v_matchable_nodes
       WHERE workspace_id = $1
         AND embedding_space_id = $2
         AND node_type = $3
         AND node_id = ANY($4::uuid[])`, [
			ctx.workspaceId,
			embeddingSpaceId,
			nodeType,
			nodeIds
		]);
		const out = /* @__PURE__ */ new Map();
		for (const row of res.rows) {
			const vec = Array.isArray(row.embedding_values) ? row.embedding_values.map(Number) : [];
			if (vec.length > 0 && vec.length === Number(row.vector_dimensions)) out.set(row.node_id, vec);
		}
		return out;
	} catch (error) {
		if (error?.code === "42P01") return /* @__PURE__ */ new Map();
		throw error;
	}
}
async function hasCompletedDeterministicRequirements(client, ctx, jobVersionId) {
	const { rows } = await client.query(`SELECT EXISTS (
       SELECT 1
       FROM job_versions jv
       JOIN job_version_pipeline_state ps
         ON ps.workspace_id = jv.workspace_id
        AND ps.job_version_id = jv.id
        AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
        AND ps.stage_status = 'COMPLETED'
       JOIN requirement_extraction_runs rer
         ON rer.workspace_id = jv.workspace_id
        AND rer.job_version_id = jv.id
        AND rer.run_type = 'DETERMINISTIC'
        AND rer.status = 'COMPLETED'
        AND jv.active_requirement_set_id IS NOT NULL
        AND rer.requirement_set_id = jv.active_requirement_set_id
       WHERE jv.workspace_id = $1
         AND jv.id = $2
     ) AS exists`, [ctx.workspaceId, jobVersionId]);
	return Boolean(rows[0]?.exists);
}
async function runDeterministicMatcher(clientOrPool, options) {
	console.log("Starting Deterministic Matcher...");
	const pool = clientOrPool || defaultPool$3;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	let matchedJobs = 0;
	let skippedJobs = 0;
	let errors = 0;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const profileRes = await client.query(`SELECT pv.id
       FROM profile_versions pv
       WHERE pv.workspace_id = $1
         AND pv.status = 'ACTIVE'
       ORDER BY pv.created_at DESC
       LIMIT 1`, [ctx.workspaceId]);
		if (profileRes.rows.length === 0) throw new Error("No ACTIVE profile version found; deterministic matching cannot run.");
		const profileVersionId = profileRes.rows[0].id;
		const factsRes = await client.query(`SELECT pf.id, COALESCE(pf.fact_revision_id, pf.id) AS embedding_node_id,
              pf.fact_type, pf.statement, pf.evidence_tier, pf.verification_status, pf.structured_value
       FROM profile_facts pf
       WHERE pf.workspace_id = $1
         AND pf.profile_version_id = $2`, [ctx.workspaceId, profileVersionId]);
		let credentialFacts = [];
		try {
			credentialFacts = (await client.query(`SELECT pc.id, pc.credential_name, pc.issuer, pc.credential_type, pc.level
         FROM profile_credentials pc
         JOIN profile_versions pv
           ON pv.workspace_id = pc.workspace_id
          AND pv.id = pc.profile_version_id
          AND pv.status = 'ACTIVE'
         WHERE pc.workspace_id = $1
           AND pc.status = 'ACTIVE'`, [ctx.workspaceId])).rows.map((credential) => ({
				id: credential.id,
				fact_type: credential.credential_type,
				statement: `${credential.credential_name} ${credential.issuer} ${credential.level || ""}`.trim(),
				evidence_tier: "PROFESSIONAL_PRODUCTION",
				verification_status: "VERIFIED",
				structured_value: {
					credential_type: credential.credential_type,
					level: credential.level
				},
				source_type: "CREDENTIAL"
			}));
		} catch (error) {
			if (error?.code !== "42P01") throw error;
		}
		try {
			const engagementRes = await client.query(`SELECT id, start_date, end_date, is_current, experience_class,
                engagement_type, role_title, summary, operating_model
         FROM profile_engagements
         WHERE profile_version_id = $1`, [profileVersionId]);
			const experienceYears = calculateProfessionalExperienceYears(engagementRes.rows);
			for (const engagement of engagementRes.rows) {
				if (engagement.experience_class !== "PROFESSIONAL_PRODUCTION") continue;
				const start = new Date(engagement.start_date).getTime();
				const end = engagement.is_current || !engagement.end_date ? Date.now() : new Date(engagement.end_date).getTime();
				if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
				const years = (end - start) / 315576e5;
				credentialFacts.push({
					id: engagement.id,
					fact_type: "EXPERIENCE_YEARS",
					statement: `${engagement.role_title}: ${engagement.summary}`,
					evidence_tier: "PROFESSIONAL_PRODUCTION",
					verification_status: "VERIFIED",
					structured_value: {
						experience_years: years,
						experience_scope: `${engagement.role_title} ${engagement.summary}`,
						engagement_type: engagement.engagement_type,
						operating_model: engagement.operating_model,
						experience_start_date: new Date(start).toISOString(),
						experience_end_date: new Date(end).toISOString(),
						engagement_is_current: engagement.is_current
					},
					source_type: "PROFILE_FACT"
				});
			}
			if (experienceYears > 0) credentialFacts.push({
				id: `experience:${profileVersionId}`,
				fact_type: "EXPERIENCE_YEARS",
				statement: `${experienceYears.toFixed(1)} years of professional production experience`,
				evidence_tier: "PROFESSIONAL_PRODUCTION",
				verification_status: "VERIFIED",
				structured_value: {
					professional_years: experienceYears,
					experience_scope: "overall professional production"
				},
				source_type: "CREDENTIAL"
			});
		} catch (error) {
			if (error?.code !== "42P01") throw error;
		}
		const comparisonFacts = [...factsRes.rows, ...credentialFacts];
		if (comparisonFacts.length === 0) throw new Error(`No profile facts or credentials found for ACTIVE profile version ${profileVersionId}; deterministic matching cannot run.`);
		const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
		const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
		const hasExplicitTargets = jobVersionIds.length > 0 || canonicalJobIds.length > 0;
		const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0 ? Number(options?.limit) : null;
		const jobParams = [ctx.workspaceId];
		const explicitTargetsParam = jobParams.push(hasExplicitTargets);
		const jobVersionFilter = jobVersionIds.length > 0 ? `AND COALESCE(c.latest_job_version_id, jv.id) = ANY($${jobParams.push(jobVersionIds)}::uuid[])` : "";
		const canonicalJobFilter = canonicalJobIds.length > 0 ? `AND c.id = ANY($${jobParams.push(canonicalJobIds)}::uuid[])` : "";
		const limitClause = limit ? `LIMIT $${jobParams.push(limit)}` : "";
		const { rows: jobs } = await client.query(`SELECT c.id,
              c.latest_job_version_id,
              COALESCE(c.latest_job_version_id, jv.id) AS resolved_job_version_id
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE workspace_id = $1
           AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
        WHERE c.workspace_id = $1
         AND (
           COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
           OR (
             $${explicitTargetsParam}::boolean
             AND COALESCE(c.processing_state, c.processing_status) IN (
               'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
             )
           )
         )
         AND c.primary_lane IS NOT NULL
         AND c.primary_lane != 'UNCLASSIFIED'
         ${jobVersionFilter}
         ${canonicalJobFilter}
       ORDER BY c.created_at ASC, c.id ASC
       ${limitClause}`, jobParams);
		const evidenceStrengthPolicy = await loadActiveEvidenceStrengthPolicy(client, { context: ctx });
		const evidencePolicyRevisionId = evidenceStrengthPolicy.source === "REGISTRY" ? evidenceStrengthPolicy.configRevisionId ?? null : null;
		const factIds = [...new Set(factsRes.rows.map((row) => row.embedding_node_id || row.id))];
		const embeddingSpaceCandidates = await listSemanticEmbeddingSpaceCandidates(client, ctx);
		const semanticSpaceCandidates = [];
		for (const candidate of embeddingSpaceCandidates) if (await countMatchableNodes(client, ctx, candidate, "PROFILE_FACT", factIds) === factIds.length) semanticSpaceCandidates.push(candidate);
		const factEmbeddingsBySpace = /* @__PURE__ */ new Map();
		for (const job of jobs) {
			const versionId = job.resolved_job_version_id || job.latest_job_version_id;
			if (!versionId) {
				skippedJobs += 1;
				continue;
			}
			await client.query("BEGIN");
			try {
				const jobContextRes = await client.query(`SELECT active_requirement_set_id, content_hash
           FROM job_versions
           WHERE workspace_id = $1 AND id = $2
           LIMIT 1`, [ctx.workspaceId, versionId]);
				const activeRequirementSetId = jobContextRes.rows[0]?.active_requirement_set_id ?? null;
				const jobContentHash = jobContextRes.rows[0]?.content_hash ?? null;
				const matchContextFingerprint = buildPipelineTaskContextFingerprint({
					workspaceId: ctx.workspaceId,
					taskType: "MATCH_PROFILE_EVIDENCE",
					taskVersion: "deterministic_matcher_v1",
					payload: {
						canonical_job_id: job.id,
						job_version_id: versionId,
						content_hash: jobContentHash,
						active_requirement_set_id: activeRequirementSetId,
						profile_version_id: profileVersionId,
						matcher_version: "deterministic_matcher_v1",
						evidence_strength_policy_hash: evidenceStrengthPolicy.policyHash
					}
				});
				const matchRunId = (await client.query(`INSERT INTO match_runs (
             workspace_id,
             canonical_job_id,
             job_version_id,
             profile_version_id,
             requirement_set_id,
             job_content_hash,
             context_fingerprint,
             status,
             policy_version,
             evidence_strength_policy_config_revision_id,
             evidence_strength_policy_hash
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'STARTED', 'deterministic_v1', $8, $9)
           RETURNING id`, [
					ctx.workspaceId,
					job.id,
					versionId,
					profileVersionId,
					activeRequirementSetId,
					jobContentHash,
					matchContextFingerprint,
					evidencePolicyRevisionId,
					evidenceStrengthPolicy.policyHash
				])).rows[0].id;
				const reqRes = await client.query(`SELECT jr.id,
                  jr.requirement_key,
                  jr.requirement_type,
                  jr.importance,
                  jr.requirement_text,
                  jr.quote_text,
                  jr.structured_value
           FROM job_versions jv
           JOIN job_requirements jr
             ON jr.workspace_id = jv.workspace_id
            AND (
              jv.active_requirement_set_id IS NOT NULL
              AND jr.requirement_set_id = jv.active_requirement_set_id
            )
           WHERE jv.workspace_id = $1
             AND jv.id = $2
             AND jr.status = 'VALIDATED'
           ORDER BY jr.requirement_key ASC`, [ctx.workspaceId, versionId]);
				if (reqRes.rows.length === 0) {
					if (await hasCompletedDeterministicRequirements(client, ctx, versionId)) {
						await client.query(`UPDATE match_runs
               SET status = 'COMPLETED',
                   requirement_count = 0,
                   matched_count = 0,
                   coverage_score = 0,
                   overall_match_score = 0,
                   embedding_space_id = NULL,
                   completed_at = NOW()
               WHERE id = $1`, [matchRunId]);
						const canonicalUpdate = await client.query(`UPDATE canonical_jobs
               SET deterministic_match_score = 0,
                   deterministic_match_coverage = 0,
                   latest_match_run_id = $2,
                   profile_match_status = 'NO_PROFILE_MATCH',
                   processing_state = 'MATCHED',
                   processing_status = 'MATCHED',
                   updated_at = NOW()
               WHERE workspace_id = $1
                 AND id = $3
                 AND (latest_job_version_id IS NULL OR latest_job_version_id = $4)`, [
							ctx.workspaceId,
							matchRunId,
							job.id,
							versionId
						]);
						await client.query("COMMIT");
						if (canonicalUpdate?.rowCount !== 0) matchedJobs += 1;
						continue;
					}
					await client.query(`UPDATE match_runs
             SET status = 'FAILED',
                 error_message = $2,
                 completed_at = NOW()
             WHERE id = $1`, [matchRunId, "No completed deterministic requirement extraction found; deterministic matching skipped."]);
					await client.query("COMMIT");
					errors += 1;
					continue;
				}
				const requirementIds = reqRes.rows.map((row) => row.id);
				let semanticEmbeddingSpaceId = null;
				for (const candidate of semanticSpaceCandidates) if (await countMatchableNodes(client, ctx, candidate, "JOB_REQUIREMENT", requirementIds) === requirementIds.length) {
					semanticEmbeddingSpaceId = candidate;
					break;
				}
				const factEmbeddings = semanticEmbeddingSpaceId ? factEmbeddingsBySpace.get(semanticEmbeddingSpaceId) || await loadNodeEmbeddings(client, ctx, semanticEmbeddingSpaceId, "PROFILE_FACT", factIds) : /* @__PURE__ */ new Map();
				if (semanticEmbeddingSpaceId && !factEmbeddingsBySpace.has(semanticEmbeddingSpaceId)) factEmbeddingsBySpace.set(semanticEmbeddingSpaceId, factEmbeddings);
				const requirementEmbeddings = semanticEmbeddingSpaceId && requirementIds.length > 0 ? await loadNodeEmbeddings(client, ctx, semanticEmbeddingSpaceId, "JOB_REQUIREMENT", requirementIds) : /* @__PURE__ */ new Map();
				const usedEmbeddings = !!semanticEmbeddingSpaceId && factEmbeddings.size === factIds.length && requirementEmbeddings.size === requirementIds.length;
				const scoredRequirements = reqRes.rows.filter((req) => isCapabilityRequirementType(req.requirement_type));
				let weightedScoreSum = 0;
				let weightSum = 0;
				let matchedCount = 0;
				for (const req of reqRes.rows) {
					if (!isCapabilityRequirementType(req.requirement_type)) {
						await client.query(`INSERT INTO requirement_evidence_matches (
                 workspace_id, match_run_id, requirement_id, profile_fact_id,
                 match_type, match_score, rationale, evidence
               ) VALUES ($1, $2, $3, NULL, 'UNKNOWN', 0, $4, $5)`, [
							ctx.workspaceId,
							matchRunId,
							req.id,
							"Excluded from capability matching; evaluated by deterministic workability gates.",
							JSON.stringify({
								requirement_key: req.requirement_key,
								requirement_type: req.requirement_type,
								excluded_from_capability_score: true,
								semantic_ready: usedEmbeddings
							})
						]);
						continue;
					}
					const weight = requirementWeight(req.importance);
					weightSum += weight;
					if (comparisonFacts.length === 0) {
						await client.query(`INSERT INTO requirement_evidence_matches (
                 workspace_id,
                 match_run_id,
                 requirement_id,
                 profile_fact_id,
                 match_type,
                 match_score,
                 rationale,
                 evidence
               )
               VALUES ($1, $2, $3, NULL, 'UNKNOWN', 0, $4, $5)`, [
							ctx.workspaceId,
							matchRunId,
							req.id,
							"No profile facts available for deterministic matching.",
							JSON.stringify({ reason: "NO_PROFILE_FACTS" })
						]);
						continue;
					}
					let bestFact = null;
					let bestScore = 0;
					let bestLexical = 0;
					let bestSemantic = 0;
					const reqEmbedding = usedEmbeddings ? requirementEmbeddings.get(req.id) ?? null : null;
					const structuredComparison = compareStructuredRequirement(req, comparisonFacts);
					if ([
						"EXPERIENCE_YEARS",
						"CREDENTIAL",
						"DEGREE",
						"WORK_AUTH"
					].includes(req.requirement_type) && structuredComparison.status === "UNKNOWN") {
						await client.query(`INSERT INTO requirement_evidence_matches (
                 workspace_id, match_run_id, requirement_id, profile_fact_id,
                 match_type, match_score, rationale, evidence
               ) VALUES ($1, $2, $3, NULL, 'UNKNOWN', 0, $4, $5)`, [
							ctx.workspaceId,
							matchRunId,
							req.id,
							structuredComparison.rationale,
							JSON.stringify({
								requirement_key: req.requirement_key,
								requirement_type: req.requirement_type,
								comparator: "STRUCTURED_EXACT",
								semantic_ready: usedEmbeddings
							})
						]);
						continue;
					}
					if (structuredComparison.status === "MISMATCH") {
						await client.query(`INSERT INTO requirement_evidence_matches (
                 workspace_id, match_run_id, requirement_id, profile_fact_id,
                 match_type, match_score, rationale, evidence
               ) VALUES ($1, $2, $3, $4, 'NO_MATCH', 0, $5, $6)`, [
							ctx.workspaceId,
							matchRunId,
							req.id,
							structuredComparison.fact?.id || null,
							structuredComparison.rationale,
							JSON.stringify({
								requirement_key: req.requirement_key,
								requirement_type: req.requirement_type,
								comparator: "STRUCTURED_EXACT",
								semantic_ready: usedEmbeddings
							})
						]);
						continue;
					}
					if (structuredComparison.status === "MATCH") {
						bestFact = structuredComparison.fact;
						bestScore = 1;
						bestLexical = 1;
						bestSemantic = 1;
					}
					for (const fact of factsRes.rows) {
						if (structuredComparison.status === "MATCH") break;
						const lexicalScore = scoreMatch(req, fact);
						let semanticScore = 0;
						if (reqEmbedding) {
							const factEmbedding = factEmbeddings.get(fact.embedding_node_id || fact.id);
							if (factEmbedding) semanticScore = Math.max(0, cosineSimilarity(reqEmbedding, factEmbedding));
						}
						const score = usedEmbeddings ? req.requirement_type === "FUNCTION" && semanticScore >= SEMANTIC_MATCH_THRESHOLD ? semanticScore : lexicalScore * .35 + semanticScore * .65 : lexicalScore;
						if (score > bestScore) {
							bestScore = score;
							bestLexical = lexicalScore;
							bestSemantic = semanticScore;
							bestFact = fact;
						}
					}
					const evidenceStrength = bestFact ? computeEvidenceStrength(bestFact.evidence_tier, bestFact.verification_status, evidenceStrengthPolicy.policy) : 0;
					let matchType = "NO_MATCH";
					if (structuredComparison.status === "MATCH") matchType = "EXACT";
					else if (usedEmbeddings) {
						if (bestScore >= SEMANTIC_MATCH_THRESHOLD) matchType = "SEMANTIC";
					} else matchType = "UNKNOWN";
					const isCountedMatch = matchType === "EXACT" || matchType === "SEMANTIC" && evidenceStrength >= .4;
					const weightedScore = isCountedMatch ? bestScore * evidenceStrength : 0;
					weightedScoreSum += weightedScore * weight;
					if (isCountedMatch) matchedCount += 1;
					const profileFactId = bestFact?.source_type === "CREDENTIAL" ? null : bestFact?.id || null;
					await client.query(`INSERT INTO requirement_evidence_matches (
               workspace_id,
               match_run_id,
               requirement_id,
               profile_fact_id,
               match_type,
               match_score,
               rationale,
               evidence
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
						ctx.workspaceId,
						matchRunId,
						req.id,
						profileFactId,
						matchType,
						bestScore,
						matchType === "NO_MATCH" ? "No sufficient lexical/semantic overlap found." : matchType === "UNKNOWN" ? "Semantic embedding prerequisites pending; match determination deferred." : bestFact?.source_type === "CREDENTIAL" ? `Matched against profile credential ${bestFact.id}.` : `Matched against profile fact ${bestFact?.id}.`,
						JSON.stringify({
							requirement_key: req.requirement_key,
							requirement_type: req.requirement_type,
							matched_fact_type: bestFact?.fact_type || null,
							evidence_tier: bestFact?.evidence_tier || null,
							verification_status: bestFact?.verification_status || null,
							evidence_strength: bestFact ? evidenceStrength : null,
							lexical_score: bestFact ? Number(bestLexical.toFixed(6)) : null,
							semantic_score: usedEmbeddings && bestFact ? Number(bestSemantic.toFixed(6)) : null,
							match_method: bestFact ? structuredComparison.status === "MATCH" ? "EXACT" : usedEmbeddings ? bestSemantic > bestLexical ? "EMBEDDING" : "LEXICAL" : "PENDING_EMBEDDINGS" : usedEmbeddings ? null : "PENDING_EMBEDDINGS",
							embedding_space_id: usedEmbeddings ? semanticEmbeddingSpaceId : null,
							weighted_score: bestFact ? Number(weightedScore.toFixed(6)) : null,
							semantic_ready: usedEmbeddings
						})
					]);
				}
				const reqCount = scoredRequirements.length;
				const overallScore = weightSum > 0 ? weightedScoreSum / weightSum * 100 : 0;
				const coverageScore = reqCount > 0 ? matchedCount / reqCount * 100 : 0;
				await client.query(`UPDATE match_runs
           SET status = 'COMPLETED',
               requirement_count = $2,
               matched_count = $3,
               coverage_score = $4,
               overall_match_score = $5,
               embedding_space_id = $6,
               completed_at = NOW()
           WHERE id = $1`, [
					matchRunId,
					reqCount,
					matchedCount,
					coverageScore,
					overallScore,
					usedEmbeddings ? semanticEmbeddingSpaceId : null
				]);
				const profileMatchStatus = matchedCount > 0 ? "POSITIVE_MATCH" : usedEmbeddings ? "NO_PROFILE_MATCH" : "UNKNOWN";
				const canonicalUpdate = await client.query(`UPDATE canonical_jobs
           SET deterministic_match_score = $2,
               deterministic_match_coverage = $3,
               latest_match_run_id = $4,
               profile_match_status = $6,
               processing_state = 'MATCHED',
               processing_status = 'MATCHED',
               updated_at = NOW()
           WHERE workspace_id = $1
             AND id = $5
             AND (latest_job_version_id IS NULL OR latest_job_version_id = $7)`, [
					ctx.workspaceId,
					overallScore,
					coverageScore,
					matchRunId,
					job.id,
					profileMatchStatus,
					versionId
				]);
				await client.query("COMMIT");
				if (canonicalUpdate?.rowCount !== 0) matchedJobs += 1;
			} catch (error) {
				await client.query("ROLLBACK");
				errors += 1;
				console.error(`Deterministic matching failed for canonical job ${job.id}:`, error);
			}
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
	console.log(`Deterministic Matcher complete. Matched: ${matchedJobs}, Skipped: ${skippedJobs}, Errors: ${errors}`);
	return {
		matchedJobs,
		skippedJobs,
		errors
	};
}
//#endregion
//#region src/decision/contracts.ts
/**
* Deterministic decision engine contracts
* @description Zod schemas for workability, qualification, and final decision logic
* @version 2.2.0
*/
var DECISION_SCHEMA_VERSION = SCHEMA_VERSION;
var WorkabilityDecisionSchema = zod.z.object({
	status: zod.z.enum([
		"PASS",
		"NEEDS_VERIFICATION",
		"HARD_REJECT"
	]),
	rejection_codes: zod.z.array(zod.z.string()).default([]),
	evidence_quotes: zod.z.array(zod.z.string()).default([])
});
var QualificationDecisionSchema = zod.z.object({
	status: zod.z.enum([
		"STRONG_FIT",
		"MODERATE_FIT",
		"WEAK_FIT",
		"NO_FIT"
	]),
	overall_match_score: zod.z.number().min(0).max(100),
	coverage_score: zod.z.number().min(0).max(100),
	matched_requirement_count: zod.z.number().int().min(0),
	total_requirement_count: zod.z.number().int().min(0)
});
var DeterministicDecisionSchema = zod.z.object({
	schema_version: SchemaVersionSchema.default(DECISION_SCHEMA_VERSION),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	match_run_id: zod.z.string().uuid(),
	workability: WorkabilityDecisionSchema,
	qualification: QualificationDecisionSchema,
	decision_label: zod.z.enum([
		"ADVANCE",
		"DEFER",
		"REJECT"
	]),
	rationale: zod.z.string().min(1).max(4e3),
	created_at: zod.z.date().optional()
});
var DecisionPolicySchema = zod.z.object({
	policy_version: zod.z.string().min(1).max(100),
	strong_fit_min_score: zod.z.number().min(0).max(100).default(75),
	moderate_fit_min_score: zod.z.number().min(0).max(100).default(60),
	minimum_coverage_pct: zod.z.number().min(0).max(100).default(40)
});
zod.z.object({
	schema_version: SchemaVersionSchema.default(DECISION_SCHEMA_VERSION),
	decision: DeterministicDecisionSchema,
	policy: DecisionPolicySchema
});
var RecommendationEligibilitySchema = zod.z.enum([
	"ELIGIBLE",
	"VERIFY",
	"INELIGIBLE"
]);
var RecommendationOutcomeSchema = zod.z.enum([
	"PRIORITY",
	"REVIEW",
	"TRACK",
	"SKIP"
]);
var RecommendationDecisionInputsSchema = zod.z.object({
	gate_decision: zod.z.enum([
		"PASS",
		"NEEDS_VERIFICATION",
		"HARD_REJECT"
	]).nullable(),
	requirement_score: zod.z.number().min(0).max(1).nullable(),
	coverage_score: zod.z.number().min(0).max(1).nullable(),
	evidence_completeness: zod.z.number().min(0).max(1).nullable()
});
var RecommendationDecisionOutputsSchema = zod.z.object({
	eligibility: RecommendationEligibilitySchema,
	outcome: RecommendationOutcomeSchema,
	recommendation_requirement_score: zod.z.number().min(0).max(1).nullable(),
	recommendation_coverage_score: zod.z.number().min(0).max(1).nullable(),
	recommendation_evidence_completeness: zod.z.number().min(0).max(1).nullable()
});
var RecommendationDecisionTraceSchema = zod.z.object({
	policy_version: zod.z.string().min(1).max(100),
	policy_hash: zod.z.string().min(1).max(200),
	policy_snapshot_id: zod.z.string().uuid(),
	eligibility_rule_id: zod.z.string().nullable(),
	outcome_rule_id: zod.z.string().nullable(),
	notes: zod.z.array(zod.z.string()).default([])
});
var RecommendationDecisionSchema = zod.z.object({
	schema_version: SchemaVersionSchema.default(DECISION_SCHEMA_VERSION),
	canonical_job_id: zod.z.string().uuid(),
	job_version_id: zod.z.string().uuid(),
	match_run_id: zod.z.string().uuid().nullable(),
	inputs: RecommendationDecisionInputsSchema,
	outputs: RecommendationDecisionOutputsSchema,
	trace: RecommendationDecisionTraceSchema,
	created_at: zod.z.date().optional()
});
//#endregion
//#region src/policy/ruleDsl.ts
var DecisionFieldRefSchema = zod.z.enum([
	"gate_decision",
	"eligibility",
	"requirement_score",
	"coverage_score",
	"evidence_completeness"
]);
var RuleLiteralSchema = zod.z.union([
	zod.z.string(),
	zod.z.number(),
	zod.z.boolean(),
	zod.z.null()
]);
var RuleExprSchema = zod.z.lazy(() => zod.z.discriminatedUnion("op", [
	zod.z.object({
		op: zod.z.literal("and"),
		args: zod.z.array(RuleExprSchema).min(1)
	}),
	zod.z.object({
		op: zod.z.literal("or"),
		args: zod.z.array(RuleExprSchema).min(1)
	}),
	zod.z.object({
		op: zod.z.literal("not"),
		arg: RuleExprSchema
	}),
	zod.z.object({
		op: zod.z.enum([
			"eq",
			"neq",
			"gt",
			"gte",
			"lt",
			"lte"
		]),
		field: DecisionFieldRefSchema,
		value: RuleLiteralSchema
	}),
	zod.z.object({
		op: zod.z.literal("in"),
		field: DecisionFieldRefSchema,
		values: zod.z.array(RuleLiteralSchema).min(1)
	}),
	zod.z.object({
		op: zod.z.literal("exists"),
		field: DecisionFieldRefSchema
	}),
	zod.z.object({
		op: zod.z.literal("is_null"),
		field: DecisionFieldRefSchema
	})
]));
function getDecisionFieldValue(field, ctx) {
	switch (field) {
		case "gate_decision": return ctx.gate_decision;
		case "eligibility": return ctx.eligibility;
		case "requirement_score": return ctx.requirement_score;
		case "coverage_score": return ctx.coverage_score;
		case "evidence_completeness": return ctx.evidence_completeness;
		default: return field;
	}
}
function compare(op, left, right) {
	if (op === "eq") return left === right;
	if (op === "neq") return left !== right;
	if (typeof left !== "number" || typeof right !== "number") return false;
	if (op === "gt") return left > right;
	if (op === "gte") return left >= right;
	if (op === "lt") return left < right;
	if (op === "lte") return left <= right;
	return false;
}
function evaluateRuleExpr(expr, ctx) {
	if (expr.op === "and") {
		for (const e of expr.args) if (!evaluateRuleExpr(e, ctx)) return false;
		return true;
	}
	if (expr.op === "or") {
		for (const e of expr.args) if (evaluateRuleExpr(e, ctx)) return true;
		return false;
	}
	if (expr.op === "not") return !evaluateRuleExpr(expr.arg, ctx);
	if (expr.op === "exists") {
		const value = getDecisionFieldValue(expr.field, ctx);
		return value !== null && value !== void 0;
	}
	if (expr.op === "is_null") {
		const value = getDecisionFieldValue(expr.field, ctx);
		return value === null || value === void 0;
	}
	if (expr.op === "in") {
		const value = getDecisionFieldValue(expr.field, ctx);
		return expr.values.some((v) => value === v);
	}
	return compare(expr.op, getDecisionFieldValue(expr.field, ctx), expr.value);
}
//#endregion
//#region src/policy/decisionPolicy.ts
var DecisionEligibilitySchema = zod.z.enum([
	"ELIGIBLE",
	"VERIFY",
	"INELIGIBLE"
]);
var DecisionOutcomeSchema = zod.z.enum([
	"PRIORITY",
	"REVIEW",
	"TRACK",
	"SKIP"
]);
var DecisionPolicyRuleSchema = zod.z.object({
	id: zod.z.string().min(1).max(200),
	description: zod.z.string().max(2e3).optional(),
	when: RuleExprSchema,
	set: zod.z.object({
		eligibility: DecisionEligibilitySchema.optional(),
		outcome: DecisionOutcomeSchema.optional(),
		rationale: zod.z.string().max(4e3).optional()
	}).refine((v) => Object.keys(v).length > 0, { message: "set must assign at least one field" })
}).strict();
var DecisionPolicyConfigSchema = zod.z.object({
	schema_version: zod.z.string().optional(),
	policy_version: zod.z.string().min(1).max(100).default("decision_policy_v1"),
	eligibility_rules: zod.z.array(DecisionPolicyRuleSchema).default([]),
	outcome_rules: zod.z.array(DecisionPolicyRuleSchema).default([]),
	defaults: zod.z.object({
		eligibility: DecisionEligibilitySchema.default("VERIFY"),
		outcome: DecisionOutcomeSchema.default("TRACK")
	}).default({
		eligibility: "VERIFY",
		outcome: "TRACK"
	})
}).passthrough();
var DEFAULT_DECISION_POLICY = {
	schema_version: "2.2.0",
	policy_version: "decision_policy_v1",
	eligibility_rules: [
		{
			id: "eligibility_hard_reject",
			description: "Hard gate rejection makes the job ineligible regardless of match scores.",
			when: {
				op: "eq",
				field: "gate_decision",
				value: "HARD_REJECT"
			},
			set: { eligibility: "INELIGIBLE" }
		},
		{
			id: "eligibility_needs_verification",
			description: "Unknown workability facts require verification, never an ineligible decision.",
			when: {
				op: "eq",
				field: "gate_decision",
				value: "NEEDS_VERIFICATION"
			},
			set: { eligibility: "VERIFY" }
		},
		{
			id: "eligibility_pass",
			when: {
				op: "eq",
				field: "gate_decision",
				value: "PASS"
			},
			set: { eligibility: "ELIGIBLE" }
		}
	],
	outcome_rules: [
		{
			id: "outcome_ineligible_skip",
			when: {
				op: "eq",
				field: "eligibility",
				value: "INELIGIBLE"
			},
			set: { outcome: "SKIP" }
		},
		{
			id: "outcome_missing_scores_verify_review",
			when: {
				op: "and",
				args: [{
					op: "eq",
					field: "eligibility",
					value: "VERIFY"
				}, {
					op: "or",
					args: [{
						op: "is_null",
						field: "requirement_score"
					}, {
						op: "is_null",
						field: "coverage_score"
					}]
				}]
			},
			set: { outcome: "REVIEW" }
		},
		{
			id: "outcome_missing_scores_track",
			when: {
				op: "or",
				args: [{
					op: "is_null",
					field: "requirement_score"
				}, {
					op: "is_null",
					field: "coverage_score"
				}]
			},
			set: { outcome: "TRACK" }
		},
		{
			id: "outcome_priority_thresholds",
			when: {
				op: "and",
				args: [
					{
						op: "eq",
						field: "eligibility",
						value: "ELIGIBLE"
					},
					{
						op: "gte",
						field: "requirement_score",
						value: .75
					},
					{
						op: "gte",
						field: "coverage_score",
						value: .55
					},
					{
						op: "gte",
						field: "evidence_completeness",
						value: .7
					}
				]
			},
			set: { outcome: "PRIORITY" }
		},
		{
			id: "outcome_review_threshold",
			when: {
				op: "gte",
				field: "requirement_score",
				value: .5
			},
			set: { outcome: "REVIEW" }
		}
	],
	defaults: {
		eligibility: "VERIFY",
		outcome: "TRACK"
	}
};
function hashDecisionPolicy(policy) {
	return sha256Hex(stableStringify(policy));
}
async function loadActiveDecisionPolicy(clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const active = await getActiveConfigRevision("decision_policy", client, { context: options?.context ?? await resolveWorkspaceContext(client) });
		if (!active) return {
			policy: DEFAULT_DECISION_POLICY,
			policyHash: hashDecisionPolicy(DEFAULT_DECISION_POLICY),
			source: "DEFAULT_FALLBACK"
		};
		const parsed = DecisionPolicyConfigSchema.parse(active.content);
		return {
			policy: parsed,
			policyHash: active.contentHash || hashDecisionPolicy(parsed),
			source: "REGISTRY",
			configRevisionId: active.configRevisionId,
			contentHash: active.contentHash
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
function applyRuleSet(policy, ruleSet, ctx) {
	const rules = policy[ruleSet];
	for (const rule of rules) if (evaluateRuleExpr(rule.when, ctx)) return {
		eligibility: rule.set.eligibility,
		outcome: rule.set.outcome,
		ruleId: rule.id
	};
	return { ruleId: null };
}
function evaluateDecisionPolicy(policy, inputs) {
	const notes = [];
	const ctx = {
		gate_decision: inputs.gate_decision,
		eligibility: null,
		requirement_score: inputs.requirement_score,
		coverage_score: inputs.coverage_score,
		evidence_completeness: inputs.evidence_completeness
	};
	const eligibilityHit = applyRuleSet(policy, "eligibility_rules", ctx);
	const eligibility = eligibilityHit.eligibility ?? policy.defaults.eligibility;
	if (!eligibilityHit.ruleId) notes.push("eligibility_default_applied");
	ctx.eligibility = eligibility;
	const outcomeHit = applyRuleSet(policy, "outcome_rules", ctx);
	const outcome = outcomeHit.outcome ?? policy.defaults.outcome;
	if (!outcomeHit.ruleId) notes.push("outcome_default_applied");
	return {
		eligibility,
		outcome,
		eligibilityRuleId: eligibilityHit.ruleId,
		outcomeRuleId: outcomeHit.ruleId,
		notes
	};
}
//#endregion
//#region src/policy/policySnapshot.ts
async function resolveWorkspacePolicySnapshot(clientOrPool, options) {
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(clientOrPool);
	const client = ownsClient ? await clientOrPool.connect() : clientOrPool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const decisionPolicy = await loadActiveDecisionPolicy(client, { context: ctx });
		const evidenceStrengthPolicy = await loadActiveEvidenceStrengthPolicy(client, { context: ctx });
		const resolvedSnapshot = {
			schema_version: "2.2.0",
			snapshot_version: "workspace_policy_snapshot_v1",
			workspace_id: ctx.workspaceId,
			decision_policy: {
				source: decisionPolicy.source,
				policy_version: decisionPolicy.policy.policy_version,
				policy_hash: decisionPolicy.policyHash,
				config_revision_id: decisionPolicy.configRevisionId ?? null,
				content_hash: decisionPolicy.contentHash ?? null
			},
			evidence_strength_policy: {
				source: evidenceStrengthPolicy.source,
				policy_key: evidenceStrengthPolicy.policy.policy_key ?? "evidence_strength_v1",
				policy_hash: evidenceStrengthPolicy.policyHash,
				config_revision_id: evidenceStrengthPolicy.configRevisionId ?? null
			},
			engines: {
				rule_dsl: "rule_dsl_v1",
				recommendation_decider: "recommendation_decider_v1"
			}
		};
		const snapshotHash = sha256Hex(stableStringify(resolvedSnapshot));
		const decisionRevisionId = decisionPolicy.source === "REGISTRY" ? decisionPolicy.configRevisionId ?? null : null;
		const evidenceRevisionId = evidenceStrengthPolicy.source === "REGISTRY" ? evidenceStrengthPolicy.configRevisionId ?? null : null;
		const { rows } = await client.query(`
      WITH inserted AS (
        INSERT INTO workspace_policy_snapshots (
          workspace_id,
          snapshot_hash,
          decision_policy_config_revision_id,
          evidence_strength_policy_config_revision_id,
          resolved_snapshot,
          created_by_user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (workspace_id, snapshot_hash) DO NOTHING
        RETURNING id
      )
      SELECT id FROM inserted
      UNION
      SELECT id
      FROM workspace_policy_snapshots
      WHERE workspace_id = $1
        AND snapshot_hash = $2
      LIMIT 1
      `, [
			ctx.workspaceId,
			snapshotHash,
			decisionRevisionId,
			evidenceRevisionId,
			JSON.stringify(resolvedSnapshot),
			ctx.userId
		]);
		if (rows.length === 0) throw new Error("Failed to resolve or create workspace_policy_snapshots row.");
		return {
			snapshotId: rows[0].id,
			snapshotHash,
			resolvedSnapshot,
			decisionPolicy,
			evidenceStrengthPolicy
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/pipeline/recommendationDecider.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$2 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
function asNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return null;
}
function normalizeWorkabilityFacts(value) {
	if (!value) return {};
	if (typeof value === "object") return value;
	if (typeof value === "string") try {
		return JSON.parse(value);
	} catch {
		return {};
	}
	return {};
}
function normalizeGateDecision(raw) {
	if (raw == null) return null;
	const normalized = String(raw).trim().toUpperCase();
	if (normalized === "PASS") return "PASS";
	if (normalized === "NEEDS_VERIFICATION") return "NEEDS_VERIFICATION";
	if (normalized === "HARD_REJECT") return "HARD_REJECT";
	return null;
}
function inferGateDecisionFromProcessingState(stateRaw) {
	const state = typeof stateRaw === "string" ? stateRaw.trim().toUpperCase() : "";
	if (!state) return null;
	if (state === "HARD_REJECTED") return "HARD_REJECT";
	if (state === "NEEDS_VERIFICATION") return "NEEDS_VERIFICATION";
	if (state === "RAW_STAGED") return null;
	return "PASS";
}
function computeEvidenceCompleteness(workplaceTypeRaw, workabilityFactsRaw) {
	const workplaceType = typeof workplaceTypeRaw === "string" ? workplaceTypeRaw : "UNKNOWN";
	const facts = normalizeWorkabilityFacts(workabilityFactsRaw);
	const officeDaysMax = facts["office_days_max"];
	const employmentType = facts["employment_type"];
	const travelPctMax = facts["travel_pct_max"];
	const dimensions = [
		[
			"REMOTE",
			"HYBRID",
			"ONSITE"
		].includes(workplaceType) ? 1 : 0,
		workplaceType === "REMOTE" || officeDaysMax != null ? 1 : 0,
		employmentType === "PERMANENT" || employmentType === "CONTRACT" ? 1 : 0,
		travelPctMax != null ? 1 : null
	].filter((value) => value !== null);
	const completeness = dimensions.length > 0 ? dimensions.reduce((total, value) => total + value, 0) / dimensions.length : 0;
	return Number(completeness.toFixed(3));
}
async function runRecommendationDecider(clientOrPool, options) {
	console.log("Starting Deterministic Recommendation Decider...");
	const pool = clientOrPool || defaultPool$2;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const snapshot = await resolveWorkspacePolicySnapshot(client, { context: ctx });
		const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
		const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
		const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0 ? Number(options?.limit) : null;
		const jobParams = [ctx.workspaceId];
		const jobVersionFilter = jobVersionIds.length > 0 ? `AND COALESCE(c.latest_job_version_id, lv.id) = ANY($${jobParams.push(jobVersionIds)}::uuid[])` : "";
		const canonicalJobFilter = canonicalJobIds.length > 0 ? `AND c.id = ANY($${jobParams.push(canonicalJobIds)}::uuid[])` : "";
		const limitClause = limit ? `LIMIT $${jobParams.push(limit)}` : "";
		const { rows: jobs } = await client.query(`
      SELECT
        c.id AS canonical_job_id,
        COALESCE(c.latest_job_version_id, lv.id) AS job_version_id,
        COALESCE(c.processing_state, c.processing_status) AS processing_state,
        c.gate_decision,
        c.deterministic_match_score,
        c.deterministic_match_coverage,
        c.workplace_type,
        c.routing_disposition,
        c.profile_match_status,
        c.workability_facts,
        c.latest_match_run_id,
        mr.canonical_job_id AS match_canonical_job_id,
        mr.status AS match_status,
        mr.matched_count AS match_matched_count,
        mr.profile_version_id AS match_profile_version_id,
        mr.requirement_set_id AS match_requirement_set_id,
        mr.job_content_hash AS match_job_content_hash,
        mr.context_fingerprint AS match_context_fingerprint,
        active_profile.id AS active_profile_version_id,
        lv.active_requirement_set_id,
        lv.content_hash AS job_content_hash,
        mr.embedding_space_id AS match_embedding_space_id,
        c.recommendation_eligibility,
        c.recommendation_outcome,
        c.recommendation_requirement_score,
        c.recommendation_coverage_score,
        c.recommendation_evidence_completeness,
        c.recommendation_decided_at,
        c.latest_deterministic_decision_id
      FROM canonical_jobs c
      LEFT JOIN match_runs mr
        ON mr.workspace_id = c.workspace_id
       AND mr.id = c.latest_match_run_id
      LEFT JOIN LATERAL (
        SELECT pv.id
        FROM profile_versions pv
        WHERE pv.workspace_id = c.workspace_id
          AND pv.status = 'ACTIVE'
        ORDER BY pv.created_at DESC
        LIMIT 1
      ) active_profile ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, active_requirement_set_id, content_hash
        FROM job_versions
        WHERE canonical_job_id = c.id
          AND workspace_id = $1
          AND (c.latest_job_version_id IS NULL OR id = c.latest_job_version_id)
        ORDER BY observed_at DESC
        LIMIT 1
      ) lv ON TRUE
      WHERE c.workspace_id = $1
        AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
        ${jobVersionFilter}
        ${canonicalJobFilter}
      ORDER BY c.created_at ASC, c.id ASC
      ${limitClause}
      `, jobParams);
		let updated = 0;
		let decisionsInserted = 0;
		let errors = 0;
		for (const job of jobs) {
			if (!job.job_version_id) {
				errors += 1;
				console.warn(`⚠️ Recommendation decider skipping canonical job ${job.canonical_job_id}: missing job_version_id.`);
				continue;
			}
			await client.query("BEGIN");
			try {
				const normalizedGateDecision = normalizeGateDecision(job.gate_decision) ?? inferGateDecisionFromProcessingState(job.processing_state);
				const currentMatch = job.match_status === "COMPLETED" && job.match_canonical_job_id === job.canonical_job_id && job.match_profile_version_id !== null && job.match_profile_version_id === job.active_profile_version_id && job.match_requirement_set_id !== null && job.match_requirement_set_id === job.active_requirement_set_id && job.match_job_content_hash !== null && job.match_job_content_hash === job.job_content_hash && job.match_context_fingerprint !== null;
				const requiresCurrentMatch = normalizedGateDecision === "PASS";
				const matchIsUsable = !requiresCurrentMatch || currentMatch;
				const requirementScorePct = matchIsUsable ? asNumber(job.deterministic_match_score) : null;
				const coverageScorePct = matchIsUsable ? asNumber(job.deterministic_match_coverage) : null;
				const requirementScore = requirementScorePct == null ? null : Number((requirementScorePct / 100).toFixed(3));
				const coverageScore = coverageScorePct == null ? null : Number((coverageScorePct / 100).toFixed(3));
				const evidenceCompleteness = computeEvidenceCompleteness(job.workplace_type, job.workability_facts);
				const evaluation = evaluateDecisionPolicy(snapshot.decisionPolicy.policy, {
					gate_decision: normalizedGateDecision,
					requirement_score: requirementScore,
					coverage_score: coverageScore,
					evidence_completeness: evidenceCompleteness
				});
				const semanticReady = Boolean(job.match_embedding_space_id);
				const adjustedNotes = [...evaluation.notes];
				if (requiresCurrentMatch && !currentMatch) adjustedNotes.push("current_match_required_but_missing_or_stale");
				const adjustedSemanticReady = matchIsUsable && semanticReady;
				if (job.gate_decision && normalizedGateDecision !== job.gate_decision) adjustedNotes.push(`legacy_gate_decision:${job.gate_decision}->${normalizedGateDecision ?? "null"}`);
				else if (!job.gate_decision && normalizedGateDecision) adjustedNotes.push(`gate_decision_inferred_from_state:${normalizedGateDecision}`);
				let adjustedOutcome = evaluation.outcome;
				if (requiresCurrentMatch && currentMatch && job.profile_match_status === "NO_PROFILE_MATCH" && Number(job.match_matched_count ?? 0) === 0) {
					adjustedOutcome = "SKIP";
					adjustedNotes.push("no_positive_grounded_profile_match");
				}
				if (job.routing_disposition === "POLICY_NO_MATCH") {
					adjustedOutcome = "SKIP";
					adjustedNotes.push("routing_policy_no_lane_match");
				}
				if (!(job.profile_match_status === "POSITIVE_MATCH" && coverageScore !== null && coverageScore >= 1 && requirementScore !== null && requirementScore >= .9) && (!adjustedSemanticReady || job.profile_match_status === "UNKNOWN") && adjustedOutcome === "PRIORITY") {
					adjustedOutcome = "REVIEW";
					adjustedNotes.push("priority_downgraded_semantic_pending");
				}
				const decisionJson = RecommendationDecisionSchema.parse({
					canonical_job_id: job.canonical_job_id,
					job_version_id: job.job_version_id,
					match_run_id: job.latest_match_run_id,
					inputs: {
						gate_decision: normalizedGateDecision,
						requirement_score: requirementScore,
						coverage_score: coverageScore,
						evidence_completeness: evidenceCompleteness
					},
					outputs: {
						eligibility: evaluation.eligibility,
						outcome: adjustedOutcome,
						recommendation_requirement_score: requirementScore,
						recommendation_coverage_score: coverageScore,
						recommendation_evidence_completeness: evidenceCompleteness
					},
					trace: {
						policy_version: snapshot.decisionPolicy.policy.policy_version,
						policy_hash: snapshot.decisionPolicy.policyHash,
						policy_snapshot_id: snapshot.snapshotId,
						eligibility_rule_id: evaluation.eligibilityRuleId,
						outcome_rule_id: evaluation.outcomeRuleId,
						notes: adjustedNotes
					}
				});
				const decisionHash = sha256Hex(stableStringify(decisionJson));
				const decisionContextFingerprint = buildPipelineTaskContextFingerprint({
					workspaceId: ctx.workspaceId,
					taskType: "DECIDE_RECOMMENDATION",
					taskVersion: "recommendation_decider_v1",
					payload: {
						canonical_job_id: job.canonical_job_id,
						job_version_id: job.job_version_id,
						content_hash: job.job_content_hash,
						active_requirement_set_id: job.active_requirement_set_id,
						profile_version_id: job.active_profile_version_id,
						match_run_id: job.latest_match_run_id,
						policy_snapshot_id: snapshot.snapshotId,
						policy_hash: snapshot.snapshotHash
					}
				});
				const decisionRow = await client.query(`
          WITH inserted AS (
            INSERT INTO deterministic_decisions (
              workspace_id,
              canonical_job_id,
              job_version_id,
              match_run_id,
              policy_snapshot_id,
              context_fingerprint,
              decision_hash,
              decision_json,
              recommendation_eligibility,
              recommendation_outcome,
              created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (
              workspace_id,
              canonical_job_id,
              job_version_id,
              policy_snapshot_id,
              context_fingerprint
            ) DO NOTHING
            RETURNING id, TRUE AS inserted
          )
          SELECT id, inserted FROM inserted
          UNION ALL
          SELECT id, FALSE AS inserted
          FROM deterministic_decisions
          WHERE workspace_id = $1
            AND canonical_job_id = $2
            AND job_version_id = $3
            AND policy_snapshot_id = $5
            AND context_fingerprint = $6
          ORDER BY inserted DESC
          LIMIT 1
          `, [
					ctx.workspaceId,
					job.canonical_job_id,
					job.job_version_id,
					job.latest_match_run_id,
					snapshot.snapshotId,
					decisionContextFingerprint,
					decisionHash,
					JSON.stringify(decisionJson),
					evaluation.eligibility,
					adjustedOutcome,
					ctx.userId
				]);
				const decisionId = decisionRow.rows[0]?.id;
				const inserted = Boolean(decisionRow.rows[0]?.inserted);
				if (!decisionId) throw new Error("Failed to resolve deterministic_decisions id.");
				if (inserted) decisionsInserted += 1;
				const updateRes = await client.query(`
          UPDATE canonical_jobs c
          SET recommendation_eligibility = $2,
              recommendation_outcome = $3,
              recommendation_requirement_score = $4,
              recommendation_coverage_score = $5,
              recommendation_evidence_completeness = $6,
              recommendation_decided_at = NOW(),
              latest_deterministic_decision_id = $7,
              updated_at = NOW()
          WHERE c.workspace_id = $1
            AND c.id = $8
            AND c.latest_job_version_id = $9
            AND (
              c.recommendation_eligibility IS DISTINCT FROM $2
              OR c.recommendation_outcome IS DISTINCT FROM $3
              OR c.recommendation_requirement_score IS DISTINCT FROM $4
              OR c.recommendation_coverage_score IS DISTINCT FROM $5
              OR c.recommendation_evidence_completeness IS DISTINCT FROM $6
              OR c.latest_deterministic_decision_id IS DISTINCT FROM $7
              OR c.recommendation_decided_at IS NULL
            )
          RETURNING c.id
          `, [
					ctx.workspaceId,
					evaluation.eligibility,
					adjustedOutcome,
					requirementScore,
					coverageScore,
					evidenceCompleteness,
					decisionId,
					job.canonical_job_id,
					job.job_version_id
				]);
				updated += updateRes.rowCount ?? 0;
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				errors += 1;
				console.error(`❌ Recommendation decider failed for canonical job ${job.canonical_job_id}:`, error);
			}
		}
		console.log(`Recommendation Decider complete. Updated: ${updated}`);
		return {
			updated,
			decisionsInserted,
			errors,
			policySnapshotId: snapshot.snapshotId,
			policySnapshotHash: snapshot.snapshotHash
		};
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/pipeline/explanationQueueEnqueuer.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool$1 = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
function normalizePersistedTimestamp(value) {
	if (value === null || value === void 0) return value;
	const parsed = new Date(String(value));
	return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}
function laneBudgets() {
	const configured = loadLanesConfig().lanes;
	return Object.fromEntries(Object.entries(configured).map(([lane, definition]) => [lane, Math.max(0, Math.floor(definition.maximum_ai_interpretations_per_run))]));
}
async function runExplanationQueueEnqueuer(clientOrPool, options) {
	const pool = clientOrPool || defaultPool$1;
	const isPool = (value) => typeof value.connect === "function" && !("release" in value);
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	try {
		const ctx = options?.context ?? await resolveWorkspaceContext(client);
		const jobVersionIds = options?.jobVersionIds?.filter(Boolean) ?? [];
		const canonicalJobIds = options?.canonicalJobIds?.filter(Boolean) ?? [];
		const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0 ? Number(options?.limit) : null;
		const budgetRunId = options?.budgetRunId ?? crypto.default.randomUUID();
		const budgets = laneBudgets();
		await client.query("BEGIN");
		try {
			await client.query(`INSERT INTO ai_evaluation_budget_runs (id, workspace_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW()`, [budgetRunId, ctx.workspaceId]);
			await client.query(`INSERT INTO ai_evaluation_budget_usage (
           budget_run_id, workspace_id, lane, budget_limit
         )
         SELECT $1::uuid, $2::uuid, key, GREATEST(value::int, 0)
         FROM jsonb_each_text($3::jsonb)
         ON CONFLICT (budget_run_id, lane) DO UPDATE
           SET budget_limit = EXCLUDED.budget_limit,
               updated_at = NOW()`, [
				budgetRunId,
				ctx.workspaceId,
				JSON.stringify(budgets)
			]);
			await client.query(`SELECT lane
         FROM ai_evaluation_budget_usage
         WHERE budget_run_id = $1::uuid AND workspace_id = $2::uuid
         FOR UPDATE`, [budgetRunId, ctx.workspaceId]);
			const params = [
				ctx.workspaceId,
				budgetRunId,
				JSON.stringify(budgets),
				limit
			];
			const jobVersionFilter = jobVersionIds.length > 0 ? `AND COALESCE(c.latest_job_version_id, lv.id) = ANY($${params.push(jobVersionIds)}::uuid[])` : "";
			const canonicalJobFilter = canonicalJobIds.length > 0 ? `AND c.id = ANY($${params.push(canonicalJobIds)}::uuid[])` : "";
			const { rows } = await client.query(`
        WITH lane_budgets AS (
          SELECT key AS lane, GREATEST(value::int, 0) AS budget_limit
          FROM jsonb_each_text($3::jsonb)
        ),
        budget_usage AS (
          SELECT lane, budget_limit, selected_count
          FROM ai_evaluation_budget_usage
          WHERE budget_run_id = $2::uuid
            AND workspace_id = $1::uuid
        ),
        candidates AS (
          SELECT
            c.id AS canonical_job_id,
            target_jv.id AS job_version_id,
            active_profile.id AS profile_version_id,
            mr.id AS match_run_id,
            dd.id AS deterministic_decision_id,
            target_jv.content_hash AS job_content_hash,
            dd.context_fingerprint,
            c.primary_lane AS lane,
            c.created_at AS candidate_created_at,
            COALESCE(bu.selected_count, 0) AS selected_count,
            COALESCE(lb.budget_limit, 0) AS budget_limit,
            (lb.lane IS NOT NULL) AS budget_configured,
            CASE
              WHEN COALESCE(c.deterministic_match_score, 0) > 0 THEN c.deterministic_match_score::float
              ELSE COALESCE(c.semantic_score, 0)::float
            END AS priority_score,
            ROW_NUMBER() OVER (
              PARTITION BY c.primary_lane
              ORDER BY
                CASE WHEN COALESCE(c.processing_state, c.processing_status) = 'DEFERRED_BUDGET' THEN 0 ELSE 1 END,
                CASE
                  WHEN COALESCE(c.deterministic_match_score, 0) > 0 THEN c.deterministic_match_score::float
                  ELSE COALESCE(c.semantic_score, 0)::float
                END DESC,
                c.created_at ASC,
                c.id ASC
            ) AS lane_rank
          FROM canonical_jobs c
          LEFT JOIN LATERAL (
            SELECT id, active_requirement_set_id, content_hash
            FROM job_versions
            WHERE canonical_job_id = c.id
              AND workspace_id = $1::uuid
            ORDER BY observed_at DESC
            LIMIT 1
          ) lv ON TRUE
          JOIN job_versions target_jv
            ON target_jv.workspace_id = c.workspace_id
           AND target_jv.id = COALESCE(c.latest_job_version_id, lv.id)
          CROSS JOIN LATERAL (
            SELECT pv.id
            FROM profile_versions pv
            WHERE pv.workspace_id = c.workspace_id
              AND pv.status = 'ACTIVE'
            ORDER BY pv.created_at DESC
            LIMIT 1
          ) active_profile
          JOIN match_runs mr
            ON mr.workspace_id = c.workspace_id
           AND mr.id = c.latest_match_run_id
           AND mr.job_version_id = target_jv.id
           AND mr.profile_version_id = active_profile.id
           AND mr.requirement_set_id = target_jv.active_requirement_set_id
           AND mr.job_content_hash = target_jv.content_hash
           AND mr.status = 'COMPLETED'
          JOIN deterministic_decisions dd
            ON dd.workspace_id = c.workspace_id
           AND dd.id = c.latest_deterministic_decision_id
           AND dd.canonical_job_id = c.id
           AND dd.job_version_id = target_jv.id
           AND dd.match_run_id = mr.id
           AND dd.context_fingerprint IS NOT NULL
          LEFT JOIN lane_budgets lb ON lb.lane = c.primary_lane
          LEFT JOIN budget_usage bu ON bu.lane = c.primary_lane
          WHERE c.workspace_id = $1::uuid
            AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'DEFERRED_BUDGET')
            AND c.primary_lane IS NOT NULL
            AND c.primary_lane <> 'UNCLASSIFIED'
            AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
            AND COALESCE(c.recommendation_outcome, 'TRACK') IN ('PRIORITY', 'REVIEW', 'TRACK')
            AND COALESCE(c.processing_state, c.processing_status) <> 'MANUALLY_REMOVED'
            AND NOT EXISTS (
              SELECT 1
              FROM ai_evaluations ae
              WHERE ae.workspace_id = $1::uuid
                AND ae.canonical_job_id = c.id
                AND ae.job_version_id = target_jv.id
                AND ae.profile_version_id = active_profile.id
                AND ae.match_run_id = mr.id
                AND ae.deterministic_decision_id = dd.id
                AND ae.job_content_hash = target_jv.content_hash
                AND ae.context_fingerprint = dd.context_fingerprint
            )
            AND NOT EXISTS (
              SELECT 1
              FROM evaluation_queue eq
              WHERE eq.workspace_id = $1::uuid
                AND eq.canonical_job_id = c.id
                AND eq.job_version_id = target_jv.id
                AND eq.profile_version_id = active_profile.id
                AND eq.match_run_id = mr.id
                AND eq.deterministic_decision_id = dd.id
                AND eq.job_content_hash = target_jv.content_hash
                AND eq.context_fingerprint = dd.context_fingerprint
                AND eq.status IN ('PENDING', 'EVALUATING', 'RETRY_WAIT')
            )
            ${jobVersionFilter}
            ${canonicalJobFilter}
        ),
        capacity_candidates AS (
          SELECT *
          FROM candidates
          WHERE lane_rank <= GREATEST(budget_limit - selected_count, 0)
        ),
        fair_ranked AS (
          SELECT capacity_candidates.*,
                 ROW_NUMBER() OVER (
                   ORDER BY lane_rank ASC, lane ASC, candidate_created_at ASC, canonical_job_id ASC
                 ) AS fair_rank
          FROM capacity_candidates
        ),
        selected AS (
          SELECT *
          FROM fair_ranked
          WHERE $4::int IS NULL OR fair_rank <= $4::int
        ),
        deferred_candidates AS (
          SELECT c.*, NULL::bigint AS fair_rank
          FROM candidates c
          WHERE c.lane_rank > GREATEST(c.budget_limit - c.selected_count, 0)
          UNION ALL
          SELECT fr.*
          FROM fair_ranked fr
          WHERE $4::int IS NOT NULL AND fr.fair_rank > $4::int
        ),
        inserted AS (
          INSERT INTO evaluation_queue (
            workspace_id,
            canonical_job_id,
            job_version_id,
            profile_version_id,
            match_run_id,
            deterministic_decision_id,
            job_content_hash,
            context_fingerprint,
            lane,
            priority_score,
            budget_run_id,
            status,
            enqueued_at,
            updated_at
          )
          SELECT
            $1::uuid,
            canonical_job_id,
            job_version_id,
            profile_version_id,
            match_run_id,
            deterministic_decision_id,
            job_content_hash,
            context_fingerprint,
            lane,
            priority_score,
            $2::uuid,
            'PENDING',
            NOW(),
            NOW()
          FROM selected
          WHERE job_version_id IS NOT NULL
            AND lane IS NOT NULL
          ON CONFLICT DO NOTHING
          RETURNING
            id,
            workspace_id,
            canonical_job_id,
            job_version_id,
            profile_version_id,
            match_run_id,
            deterministic_decision_id,
            job_content_hash,
            context_fingerprint,
            lane,
            priority_score,
            status,
            budget_run_id,
            available_at,
            lease_id,
            lease_expires_at,
            attempt_count,
            max_attempts,
            last_error,
            enqueued_at,
            updated_at
        ),
        deferred_rows AS (
          INSERT INTO evaluation_budget_deferrals (
            workspace_id,
            canonical_job_id,
            job_version_id,
            budget_run_id,
            lane,
            budget_limit,
            lane_rank,
            reason_code,
            evidence
          )
          SELECT
            $1::uuid,
            canonical_job_id,
            job_version_id,
            $2::uuid,
            lane,
            budget_limit,
            lane_rank,
            CASE
              WHEN budget_configured THEN 'AI_BUDGET_EXHAUSTED'
              ELSE 'AI_BUDGET_UNCONFIGURED_LANE'
            END,
            jsonb_build_object(
              'selected_count', selected_count,
              'fair_rank', fair_rank,
              'priority_score', priority_score,
              'budget_configured', budget_configured
            )
          FROM deferred_candidates
          WHERE job_version_id IS NOT NULL
            AND lane IS NOT NULL
          ON CONFLICT (budget_run_id, canonical_job_id, job_version_id) DO NOTHING
          RETURNING canonical_job_id
        ),
        updated_jobs AS (
          UPDATE canonical_jobs c
          SET processing_state = 'QUEUED_FOR_AI',
              processing_status = 'QUEUED_FOR_AI',
              updated_at = NOW()
          FROM inserted i
          WHERE c.workspace_id = $1::uuid
            AND c.id = i.canonical_job_id
            AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'DEFERRED_BUDGET')
          RETURNING c.id
        ),
        updated_deferred_jobs AS (
          UPDATE canonical_jobs c
          SET processing_state = 'DEFERRED_BUDGET',
              processing_status = 'DEFERRED_BUDGET',
              updated_at = NOW()
          FROM deferred_candidates d
          WHERE c.workspace_id = $1::uuid
            AND c.id = d.canonical_job_id
            AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'DEFERRED_BUDGET')
          RETURNING c.id
        )
        SELECT
          (SELECT COUNT(*)::int FROM inserted) AS enqueued,
          (SELECT COUNT(*)::int FROM updated_jobs) AS updated,
          (SELECT COUNT(*)::int FROM deferred_rows) AS deferred,
          COALESCE(
            (
              SELECT jsonb_agg(
                to_jsonb(inserted) || jsonb_build_object('schema_version', '2.2.0')
              )
              FROM inserted
            ),
            '[]'::jsonb
          ) AS queue_contract_items
      `, params);
			const summary = rows[0] ?? {
				enqueued: 0,
				updated: 0,
				deferred: 0,
				queue_contract_items: []
			};
			const queueContractItems = Array.isArray(summary.queue_contract_items) ? summary.queue_contract_items.map((item) => PersistedEvaluationQueueItemSchema.parse({
				...item,
				available_at: normalizePersistedTimestamp(item.available_at),
				lease_expires_at: normalizePersistedTimestamp(item.lease_expires_at),
				enqueued_at: normalizePersistedTimestamp(item.enqueued_at),
				updated_at: normalizePersistedTimestamp(item.updated_at)
			})) : [];
			if (queueContractItems.length !== Number(summary.enqueued ?? 0)) throw new Error(`Evaluation queue contract count mismatch: inserted=${summary.enqueued ?? 0}, validated=${queueContractItems.length}`);
			const result = {
				enqueued: Number(summary.enqueued ?? 0),
				updated: Number(summary.updated ?? 0),
				deferred: Number(summary.deferred ?? 0)
			};
			await client.query(`UPDATE ai_evaluation_budget_usage u
        SET selected_count = selected.lane_count,
             updated_at = NOW()
         FROM (
           SELECT lane, COUNT(*)::int AS lane_count
           FROM evaluation_queue
           WHERE workspace_id = $1::uuid
             AND budget_run_id = $2::uuid
           GROUP BY lane
         ) selected
         WHERE u.workspace_id = $1::uuid
           AND u.budget_run_id = $2::uuid
           AND u.lane = selected.lane`, [ctx.workspaceId, budgetRunId]);
			await client.query("COMMIT");
			console.log(`Explanation Queue Enqueuer complete. Enqueued: ${result.enqueued}, Updated: ${result.updated}, Deferred: ${result.deferred}`);
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => void 0);
			throw error;
		}
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region src/tasks/stageTaskWorker.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var defaultPool = new pg.default.Pool(pgPoolConfig(process.env.DATABASE_URL));
var PIPELINE_STAGE_TASK_TYPES = [
	"NORMALIZE_OBSERVATION",
	"EXTRACT_DETERMINISTIC_REQUIREMENTS",
	"APPLY_HARD_GATES",
	"EXTRACT_QUOTED_REQUIREMENTS",
	"PUBLISH_EMBEDDING",
	"ROUTE_LANE",
	"MATCH_PROFILE_EVIDENCE",
	"DECIDE_RECOMMENDATION",
	"ENQUEUE_EXPLANATION"
];
function parsePipelineTaskTypes(raw) {
	if (!raw || raw.trim() === "") return [...PIPELINE_STAGE_TASK_TYPES];
	const requested = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
	const unsupported = requested.filter((value) => !PIPELINE_STAGE_TASK_TYPES.includes(value));
	if (unsupported.length > 0) throw new Error(`Unsupported PIPELINE_TASK_WORKER_TASK_TYPES value(s): ${unsupported.join(", ")}`);
	if (requested.length === 0) throw new Error("PIPELINE_TASK_WORKER_TASK_TYPES must contain at least one task type when set.");
	return requested;
}
var defaultDependencies = {
	runNormalization,
	runRequirementsExtraction,
	runHardGates,
	runEmbeddingBatchWithFallback,
	runLaneRouting,
	runDeterministicMatcher,
	runRecommendationDecider,
	runExplanationQueueEnqueuer
};
var MODEL_BACKED_STAGE_TASK_TYPES = /* @__PURE__ */ new Set([
	"EXTRACT_QUOTED_REQUIREMENTS",
	"PUBLISH_EMBEDDING",
	"ROUTE_LANE"
]);
function isPool(value) {
	return typeof value.connect === "function" && !("release" in value);
}
function incrementSeed(summary, taskType, inserted) {
	summary.byType[taskType] ??= {
		inserted: 0,
		existing: 0
	};
	if (inserted) {
		summary.inserted += 1;
		summary.byType[taskType].inserted += 1;
	} else {
		summary.existing += 1;
		summary.byType[taskType].existing += 1;
	}
}
function incrementWorker(summary, taskType, field) {
	summary.byType[taskType] ??= {
		claimed: 0,
		completed: 0,
		blocked: 0,
		failed: 0,
		deadLettered: 0
	};
	summary.byType[taskType][field] += 1;
}
var PipelineWorkerCancelledError = class extends Error {
	constructor(message = "Pipeline task worker cancellation requested.") {
		super(message);
		this.name = "PipelineWorkerCancelledError";
	}
};
var PipelineTaskDependencyBlockedError = class extends Error {
	blockedOn;
	repairAction;
	constructor(blockedOn, repairAction, message) {
		super(message);
		this.blockedOn = blockedOn;
		this.repairAction = repairAction;
		this.name = "PipelineTaskDependencyBlockedError";
	}
};
function abortReasonMessage(signal) {
	const reason = signal.reason;
	if (reason instanceof Error) return reason.message;
	if (typeof reason === "string" && reason.trim() !== "") return reason;
	return "Pipeline task worker cancellation requested.";
}
function throwIfWorkerCancelled(signal) {
	if (signal?.aborted) throw new PipelineWorkerCancelledError(abortReasonMessage(signal));
}
function requireStringPayload(task, field) {
	const value = task.payload?.[field];
	if (typeof value === "string" && value.trim() !== "") return value;
	throw new Error(`Pipeline task ${task.taskKey} is missing string payload field ${field}.`);
}
function optionalStringPayload(task, field) {
	const payload = task.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const value = payload[field];
	return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function buildPipelineTaskKey(taskType, id, version, profileVersionId, taskVariant) {
	return `${taskType}:${id}:${version}${taskVariant ? `:${taskVariant}` : ""}${taskType === "MATCH_PROFILE_EVIDENCE" && profileVersionId ? `:profile:${profileVersionId}` : ""}`;
}
async function resolveActiveProfileVersionId(clientOrPool, ctx) {
	const { rows } = await clientOrPool.query(`SELECT pv.id
     FROM profile_versions pv
     WHERE pv.workspace_id = $1
       AND pv.status = 'ACTIVE'
     ORDER BY pv.created_at DESC
     LIMIT 1`, [ctx.workspaceId]);
	const profileVersionId = rows[0]?.id;
	if (!profileVersionId) throw new Error(`No ACTIVE profile version found for workspace_id=${ctx.workspaceId}.`);
	return profileVersionId;
}
async function enqueueStageTask(taskType, id, payload, clientOrPool, context) {
	const maxAttempts = MODEL_BACKED_STAGE_TASK_TYPES.has(taskType) ? 3 : 8;
	let taskPayload = payload;
	let profileVersionId;
	if (taskType === "MATCH_PROFILE_EVIDENCE") {
		profileVersionId = typeof payload.profile_version_id === "string" && payload.profile_version_id.trim() !== "" ? payload.profile_version_id : await resolveActiveProfileVersionId(clientOrPool, context);
		taskPayload = {
			...payload,
			profile_version_id: profileVersionId
		};
	} else if (taskType === "DECIDE_RECOMMENDATION") {
		profileVersionId = (await clientOrPool.query(`SELECT pv.id
       FROM profile_versions pv
       WHERE pv.workspace_id = $1
         AND pv.status = 'ACTIVE'
       ORDER BY pv.created_at DESC
       LIMIT 1`, [context.workspaceId])).rows[0]?.id;
		if (profileVersionId) taskPayload = {
			...payload,
			profile_version_id: profileVersionId
		};
	}
	const jobVersionId = typeof taskPayload.job_version_id === "string" ? taskPayload.job_version_id : null;
	if (jobVersionId && [
		"MATCH_PROFILE_EVIDENCE",
		"DECIDE_RECOMMENDATION",
		"ENQUEUE_EXPLANATION"
	].includes(taskType)) {
		const row = (await clientOrPool.query(`SELECT jv.active_requirement_set_id,
              jv.content_hash,
              c.latest_match_run_id,
              c.latest_deterministic_decision_id
       FROM job_versions jv
       JOIN canonical_jobs c
         ON c.workspace_id = jv.workspace_id
        AND c.id = jv.canonical_job_id
       WHERE jv.workspace_id = $1
         AND jv.id = $2
       LIMIT 1`, [context.workspaceId, jobVersionId])).rows[0];
		if (row) taskPayload = {
			...taskPayload,
			content_hash: row.content_hash,
			active_requirement_set_id: row.active_requirement_set_id,
			...taskType === "DECIDE_RECOMMENDATION" || taskType === "ENQUEUE_EXPLANATION" ? {
				match_run_id: row.latest_match_run_id,
				deterministic_decision_id: row.latest_deterministic_decision_id
			} : {}
		};
	}
	const routingReplayVersion = taskType === "ROUTE_LANE" && typeof taskPayload.routing_deferred_replay_version === "string" && taskPayload.routing_deferred_replay_version.trim() !== "" ? taskPayload.routing_deferred_replay_version.trim() : null;
	const isRepairTask = taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS" && taskPayload.repair_existing_state === true || (taskType === "PUBLISH_EMBEDDING" || taskType === "ROUTE_LANE") && taskPayload.reprocess_existing_state === true || taskType === "MATCH_PROFILE_EVIDENCE" && taskPayload.reprocess_existing_state === true || taskType === "DECIDE_RECOMMENDATION" && taskPayload.repair_existing_state === true;
	const taskVariant = routingReplayVersion ? `repair-${routingReplayVersion}` : isRepairTask ? "repair" : void 0;
	return (await enqueuePipelineTask({
		taskType,
		taskKey: buildPipelineTaskKey(taskType, id, stageVersion(taskType), profileVersionId, taskVariant),
		payload: taskPayload,
		maxAttempts,
		contextFingerprint: buildPipelineTaskContextFingerprint({
			workspaceId: context.workspaceId,
			taskType,
			taskVersion: stageVersion(taskType),
			payload: taskPayload
		})
	}, clientOrPool, { context })).inserted;
}
function stageVersion(taskType) {
	switch (taskType) {
		case "NORMALIZE_OBSERVATION": return "normalizer_v1";
		case "EXTRACT_DETERMINISTIC_REQUIREMENTS": return "deterministic_v3";
		case "APPLY_HARD_GATES": return "hard_gate_v1";
		case "EXTRACT_QUOTED_REQUIREMENTS": return "quoted_requirements_v1";
		case "PUBLISH_EMBEDDING": return "embedding_publication_v1";
		case "ROUTE_LANE": return "lane_router_v1";
		case "MATCH_PROFILE_EVIDENCE": return "deterministic_matcher_v1";
		case "DECIDE_RECOMMENDATION": return "recommendation_decider_v1";
		case "ENQUEUE_EXPLANATION": return "explanation_queue_v1";
	}
}
async function selectAndEnqueue(client, ctx, summary, taskType, sql, params, build, enabledTypes) {
	if (enabledTypes && !enabledTypes.has(taskType)) return;
	const { rows } = await client.query(sql, params);
	for (const row of rows) {
		const task = build(row);
		incrementSeed(summary, taskType, await enqueueStageTask(taskType, task.id, task.payload, client, ctx));
	}
}
async function seedRecoverablePipelineTasks(clientOrPool, options = {}) {
	const pool = clientOrPool || defaultPool;
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	const summary = {
		inserted: 0,
		existing: 0,
		byType: {}
	};
	const maxPerType = options.maxSeedPerType ?? 500;
	const includeRoutingDeferred = options.includeRoutingDeferred === true;
	const routingDeferredReplayVersion = options.routingDeferredReplayVersion?.trim() || "routing_deferred_replay_v1";
	const enabledTypes = options.taskTypes ? new Set(options.taskTypes) : void 0;
	try {
		const ctx = options.context ?? await resolveWorkspaceContext(client);
		await selectAndEnqueue(client, ctx, summary, "NORMALIZE_OBSERVATION", `SELECT obs.id AS observation_id
       FROM raw_job_observations obs
       WHERE obs.workspace_id = $1
         AND obs.job_version_id IS NULL
         AND COALESCE(obs.processing_status, 'PENDING') = 'PENDING'
       ORDER BY obs.retrieved_at ASC, obs.id ASC
       LIMIT $2`, [ctx.workspaceId, maxPerType], (row) => ({
			id: row.observation_id,
			payload: { observation_id: row.observation_id }
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "EXTRACT_DETERMINISTIC_REQUIREMENTS", `SELECT c.id AS canonical_job_id,
              jv.id AS job_version_id,
              COALESCE(c.processing_state, c.processing_status) <> 'RAW_STAGED' AS repair_existing_state
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.id = COALESCE(c.latest_job_version_id, (
          SELECT jv2.id
          FROM job_versions jv2
          WHERE jv2.workspace_id = c.workspace_id
            AND jv2.canonical_job_id = c.id
          ORDER BY jv2.observed_at DESC
          LIMIT 1
        ))
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN (
           'RAW_STAGED', 'PREQUALIFIED', 'LANE_ROUTED', 'ROUTING_DEFERRED', 'MATCHED',
           'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`, [ctx.workspaceId, maxPerType], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id,
				...row.repair_existing_state === true ? { repair_existing_state: true } : {}
			}
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "APPLY_HARD_GATES", `SELECT c.id AS canonical_job_id, jv.id AS job_version_id
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.id = COALESCE(c.latest_job_version_id, (
          SELECT jv2.id
          FROM job_versions jv2
          WHERE jv2.workspace_id = c.workspace_id
            AND jv2.canonical_job_id = c.id
          ORDER BY jv2.observed_at DESC
          LIMIT 1
        ))
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
         AND EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`, [ctx.workspaceId, maxPerType], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id,
				...row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}
			}
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "EXTRACT_QUOTED_REQUIREMENTS", `SELECT c.id AS canonical_job_id, jv.id AS job_version_id
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       WHERE c.workspace_id = $1
          AND COALESCE(c.processing_state, c.processing_status) IN ('PREQUALIFIED', 'ROUTING_DEFERRED')
         AND NOT EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'LLM_QUOTED'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`, [ctx.workspaceId, maxPerType], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id
			}
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "PUBLISH_EMBEDDING", `SELECT c.id AS canonical_job_id, jv.id AS job_version_id,
              TRUE AS reprocess_existing_state
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       WHERE c.workspace_id = $1
          AND COALESCE(c.processing_state, c.processing_status) IN ('PREQUALIFIED', 'ROUTING_DEFERRED')
         AND EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           JOIN v_published_semantic_embeddings se
             ON se.workspace_id = ei.workspace_id
            AND se.embedding_input_id = ei.id
           JOIN embedding_spaces es
             ON es.workspace_id = se.workspace_id
            AND es.id = se.embedding_space_id
           WHERE ei.workspace_id = c.workspace_id
             AND ei.source_type = 'JOB_VERSION'
             AND ei.source_id = jv.id
             AND es.is_fallback_space = FALSE
             AND LOWER(es.provider) = LOWER($3)
             AND es.model = $4
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`, [
			ctx.workspaceId,
			maxPerType,
			process.env.EMBEDDING_PRIMARY_PROVIDER || "gemini",
			process.env.EMBEDDING_PRIMARY_MODEL || "gemini-embedding-001"
		], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id,
				...row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}
			}
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "ROUTE_LANE", `SELECT c.id AS canonical_job_id, jv.id AS job_version_id,
              COALESCE(c.processing_state, c.processing_status) AS processing_state,
              TRUE AS reprocess_existing_state
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       WHERE c.workspace_id = $1
         AND (
           COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
           OR (
            $2::boolean
             AND COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED'
             AND COALESCE(c.routing_disposition, 'TECHNICAL_DEFERRED') <> 'POLICY_NO_MATCH'
             AND NOT EXISTS (
               SELECT 1
                 FROM pipeline_tasks replay_task
                WHERE replay_task.workspace_id = c.workspace_id
                  AND replay_task.task_type = 'ROUTE_LANE'
                  AND replay_task.task_key =
                    'ROUTE_LANE:' || jv.id || ':lane_router_v1:repair-' || $3::text
             )
           )
         )
         AND EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           JOIN v_published_semantic_embeddings se
             ON se.workspace_id = ei.workspace_id
            AND se.embedding_input_id = ei.id
           WHERE ei.workspace_id = c.workspace_id
             AND ei.source_type = 'JOB_VERSION'
             AND ei.source_id = jv.id
         )
       ORDER BY jv.observed_at ASC
       LIMIT $4`, [
			ctx.workspaceId,
			includeRoutingDeferred,
			routingDeferredReplayVersion,
			maxPerType
		], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id,
				...row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {},
				...includeRoutingDeferred && row.processing_state === "ROUTING_DEFERRED" ? { routing_deferred_replay_version: routingDeferredReplayVersion } : {}
			}
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "MATCH_PROFILE_EVIDENCE", `SELECT c.id AS canonical_job_id,
              COALESCE(c.latest_job_version_id, jv.id) AS job_version_id,
              active_profile.id AS profile_version_id,
              TRUE AS reprocess_existing_state
       FROM canonical_jobs c
       CROSS JOIN LATERAL (
         SELECT pv.id
         FROM profile_versions pv
         WHERE pv.workspace_id = c.workspace_id
           AND pv.status = 'ACTIVE'
         ORDER BY pv.created_at DESC
         LIMIT 1
       ) active_profile
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       JOIN job_versions target_jv
         ON target_jv.workspace_id = c.workspace_id
        AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN (
           'LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
         )
         AND c.primary_lane IS NOT NULL
         AND c.primary_lane <> 'UNCLASSIFIED'
         AND COALESCE(c.latest_job_version_id, jv.id) IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND target_jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = target_jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = target_jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
         AND (
           COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
           OR NOT EXISTS (
             SELECT 1
             FROM match_runs mr
             WHERE mr.workspace_id = c.workspace_id
               AND mr.id = c.latest_match_run_id
               AND mr.canonical_job_id = c.id
               AND mr.job_version_id = target_jv.id
               AND mr.profile_version_id = active_profile.id
               AND mr.requirement_set_id = target_jv.active_requirement_set_id
               AND mr.job_content_hash = target_jv.content_hash
               AND mr.status = 'COMPLETED'
               AND mr.context_fingerprint IS NOT NULL
               AND (
                 mr.requirement_count = 0
                 OR mr.embedding_space_id IS NOT NULL
               )
           )
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`, [ctx.workspaceId, maxPerType], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id,
				profile_version_id: row.profile_version_id,
				...row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}
			}
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "DECIDE_RECOMMENDATION", `SELECT c.id AS canonical_job_id,
              COALESCE(c.latest_job_version_id, jv.id) AS job_version_id,
              active_profile.id AS profile_version_id,
              TRUE AS repair_existing_state
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT pv.id
         FROM profile_versions pv
         WHERE pv.workspace_id = c.workspace_id
           AND pv.status = 'ACTIVE'
         ORDER BY pv.created_at DESC
         LIMIT 1
       ) active_profile ON TRUE
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN (
           'HARD_REJECTED', 'NEEDS_VERIFICATION', 'ROUTING_DEFERRED',
           'MATCHED', 'QUEUED_FOR_AI', 'NEEDS_MANUAL_REVIEW'
         )
         AND COALESCE(c.latest_job_version_id, jv.id) IS NOT NULL
         AND c.recommendation_outcome IS NULL
         AND (
           COALESCE(c.processing_state, c.processing_status) IN (
             'HARD_REJECTED', 'NEEDS_VERIFICATION', 'ROUTING_DEFERRED'
           )
           OR EXISTS (
             SELECT 1
             FROM job_versions target_jv
             JOIN profile_versions current_profile
               ON current_profile.workspace_id = target_jv.workspace_id
              AND current_profile.status = 'ACTIVE'
             JOIN match_runs current_match
               ON current_match.workspace_id = c.workspace_id
              AND current_match.canonical_job_id = c.id
              AND current_match.id = c.latest_match_run_id
              AND current_match.job_version_id = target_jv.id
              AND current_match.profile_version_id = current_profile.id
              AND current_match.requirement_set_id = target_jv.active_requirement_set_id
              AND current_match.job_content_hash = target_jv.content_hash
              AND current_match.context_fingerprint IS NOT NULL
              AND current_match.status = 'COMPLETED'
             WHERE target_jv.workspace_id = c.workspace_id
               AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
           )
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`, [ctx.workspaceId, maxPerType], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id,
				...row.profile_version_id ? { profile_version_id: row.profile_version_id } : {},
				...row.repair_existing_state === true ? { repair_existing_state: true } : {}
			}
		}), enabledTypes);
		await selectAndEnqueue(client, ctx, summary, "ENQUEUE_EXPLANATION", `SELECT c.id AS canonical_job_id, COALESCE(c.latest_job_version_id, jv.id) AS job_version_id
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI')
         AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
         AND COALESCE(c.recommendation_outcome, 'TRACK') IN ('PRIORITY', 'REVIEW')
         AND COALESCE(c.latest_job_version_id, jv.id) IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM job_versions target_jv
           JOIN profile_versions current_profile
             ON current_profile.workspace_id = target_jv.workspace_id
            AND current_profile.status = 'ACTIVE'
           JOIN match_runs current_match
             ON current_match.workspace_id = c.workspace_id
            AND current_match.canonical_job_id = c.id
            AND current_match.id = c.latest_match_run_id
            AND current_match.job_version_id = target_jv.id
            AND current_match.profile_version_id = current_profile.id
            AND current_match.requirement_set_id = target_jv.active_requirement_set_id
            AND current_match.job_content_hash = target_jv.content_hash
            AND current_match.context_fingerprint IS NOT NULL
            AND current_match.status = 'COMPLETED'
           JOIN deterministic_decisions current_decision
             ON current_decision.workspace_id = c.workspace_id
            AND current_decision.id = c.latest_deterministic_decision_id
            AND current_decision.canonical_job_id = c.id
            AND current_decision.job_version_id = target_jv.id
            AND current_decision.match_run_id = current_match.id
            AND current_decision.context_fingerprint IS NOT NULL
           WHERE target_jv.workspace_id = c.workspace_id
             AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM ai_evaluations ae
           WHERE ae.workspace_id = c.workspace_id
             AND ae.canonical_job_id = c.id
             AND ae.job_version_id = COALESCE(c.latest_job_version_id, jv.id)
             AND ae.profile_version_id IS NOT DISTINCT FROM (
               SELECT pv.id
               FROM profile_versions pv
               WHERE pv.workspace_id = c.workspace_id
                 AND pv.status = 'ACTIVE'
               ORDER BY pv.created_at DESC
               LIMIT 1
             )
             AND ae.match_run_id = c.latest_match_run_id
             AND ae.deterministic_decision_id = c.latest_deterministic_decision_id
             AND ae.job_content_hash IS NOT DISTINCT FROM (
               SELECT target_jv.content_hash
               FROM job_versions target_jv
               WHERE target_jv.workspace_id = c.workspace_id
                 AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
             )
             AND ae.context_fingerprint IS NOT NULL
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`, [ctx.workspaceId, maxPerType], (row) => ({
			id: row.job_version_id,
			payload: {
				canonical_job_id: row.canonical_job_id,
				job_version_id: row.job_version_id
			}
		}), enabledTypes);
		return summary;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
async function lookupObservationVersion(clientOrPool, ctx, observationId) {
	const { rows } = await clientOrPool.query(`SELECT jv.canonical_job_id, obs.job_version_id
     FROM raw_job_observations obs
     LEFT JOIN job_versions jv
       ON jv.workspace_id = obs.workspace_id
      AND jv.id = obs.job_version_id
     WHERE obs.workspace_id = $1
       AND obs.id = $2
     LIMIT 1`, [ctx.workspaceId, observationId]);
	return {
		canonicalJobId: rows[0]?.canonical_job_id ?? null,
		jobVersionId: rows[0]?.job_version_id ?? null
	};
}
async function lookupJobState(clientOrPool, ctx, jobVersionId) {
	const { rows } = await clientOrPool.query(`SELECT c.id AS canonical_job_id,
            COALESCE(c.processing_state, c.processing_status) AS processing_state,
            c.primary_lane,
            c.lane_evidence,
            c.routing_disposition,
            c.gate_decision,
            c.recommendation_eligibility,
            c.recommendation_outcome,
            c.latest_job_version_id
     FROM job_versions jv
     JOIN canonical_jobs c
       ON c.workspace_id = jv.workspace_id
      AND c.id = jv.canonical_job_id
     WHERE jv.workspace_id = $1
       AND jv.id = $2
     LIMIT 1`, [ctx.workspaceId, jobVersionId]);
	const row = rows[0];
	return {
		canonicalJobId: row?.canonical_job_id ?? null,
		processingState: row?.processing_state ?? null,
		primaryLane: row?.primary_lane ?? null,
		laneEvidence: row?.lane_evidence ?? null,
		routingDisposition: row?.routing_disposition ?? null,
		gateDecision: row?.gate_decision ?? null,
		recommendationEligibility: row?.recommendation_eligibility ?? null,
		recommendationOutcome: row?.recommendation_outcome ?? null,
		latestJobVersionId: row?.latest_job_version_id ?? null
	};
}
async function jobVersionHasCurrentMatch(clientOrPool, ctx, jobVersionId) {
	const { rows } = await clientOrPool.query(`SELECT EXISTS (
       SELECT 1
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.canonical_job_id = c.id
        AND jv.id = $2
       JOIN profile_versions pv
         ON pv.workspace_id = c.workspace_id
        AND pv.status = 'ACTIVE'
       JOIN match_runs mr
         ON mr.workspace_id = c.workspace_id
        AND mr.canonical_job_id = c.id
        AND mr.id = c.latest_match_run_id
        AND mr.job_version_id = jv.id
        AND mr.profile_version_id = pv.id
        AND mr.requirement_set_id = jv.active_requirement_set_id
        AND mr.job_content_hash = jv.content_hash
        AND mr.context_fingerprint IS NOT NULL
        AND mr.status = 'COMPLETED'
       WHERE c.workspace_id = $1
     ) AS exists`, [ctx.workspaceId, jobVersionId]);
	return Boolean(rows[0]?.exists);
}
async function jobVersionHasEmbedding(clientOrPool, ctx, jobVersionId, embeddingSpaceIds) {
	const { rows } = await clientOrPool.query(`SELECT EXISTS (
       SELECT 1
       FROM embedding_inputs ei
       JOIN v_published_semantic_embeddings se
         ON se.workspace_id = ei.workspace_id
        AND se.embedding_input_id = ei.id
       WHERE ei.workspace_id = $1
         AND ei.source_type = 'JOB_VERSION'
         AND ei.source_id = $2
         AND se.embedding_space_id = ANY($3::uuid[])
     ) AS exists`, [
		ctx.workspaceId,
		jobVersionId,
		embeddingSpaceIds
	]);
	return Boolean(rows[0]?.exists);
}
async function jobVersionHasCompletedRequirementsExtraction(clientOrPool, ctx, jobVersionId, runType) {
	const { rows } = await clientOrPool.query(`SELECT EXISTS (
       SELECT 1
       FROM job_version_pipeline_state ps
       JOIN job_versions jv
         ON jv.workspace_id = ps.workspace_id
        AND jv.id = ps.job_version_id
       JOIN requirement_extraction_runs rer
         ON rer.workspace_id = jv.workspace_id
        AND rer.job_version_id = jv.id
        AND rer.run_type = $3
        AND rer.status = 'COMPLETED'
        AND jv.active_requirement_set_id IS NOT NULL
        AND rer.requirement_set_id = jv.active_requirement_set_id
       WHERE jv.workspace_id = $1
         AND jv.id = $2
         AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
         AND ps.stage_status = 'COMPLETED'
       ) AS exists`, [
		ctx.workspaceId,
		jobVersionId,
		runType
	]);
	return Boolean(rows[0]?.exists);
}
function isTechnicalRoutingDeferral(state) {
	if (state.processingState !== "ROUTING_DEFERRED") return false;
	if (state.routingDisposition === "POLICY_NO_MATCH") return false;
	if (state.routingDisposition === "TECHNICAL_DEFERRED") return true;
	const evidence = String(state.laneEvidence || "");
	return [
		"ROUTING_ERROR",
		"EMBEDDING_UNAVAILABLE",
		"ZERO_VECTOR_EMBEDDING",
		"EMBEDDING_DIM_MISMATCH"
	].some((marker) => evidence.includes(marker));
}
async function markTaskTargetNeedsManualReview(task, clientOrPool, ctx, errorMessage) {
	const payload = task.payload || {};
	let canonicalJobId = typeof payload.canonical_job_id === "string" ? payload.canonical_job_id : null;
	const jobVersionId = typeof payload.job_version_id === "string" ? payload.job_version_id : null;
	if (!canonicalJobId && jobVersionId) canonicalJobId = (await lookupJobState(clientOrPool, ctx, jobVersionId)).canonicalJobId;
	if (!canonicalJobId) return;
	await clientOrPool.query(`UPDATE canonical_jobs
     SET processing_state = 'NEEDS_MANUAL_REVIEW',
         processing_status = 'NEEDS_MANUAL_REVIEW',
         rejection_reason = COALESCE(rejection_reason, $3),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2
       AND COALESCE(processing_state, processing_status) <> 'MANUALLY_REMOVED'`, [
		ctx.workspaceId,
		canonicalJobId,
		`Task ${task.taskKey} exhausted retries: ${errorMessage}`
	]);
}
async function maybeEnqueueAfterTask(taskType, task, clientOrPool, ctx) {
	const payload = task.payload || {};
	const jobVersionId = typeof payload.job_version_id === "string" ? payload.job_version_id : null;
	if (taskType === "NORMALIZE_OBSERVATION") {
		const mapping = await lookupObservationVersion(clientOrPool, ctx, requireStringPayload(task, "observation_id"));
		if (mapping.jobVersionId) await enqueueStageTask("EXTRACT_DETERMINISTIC_REQUIREMENTS", mapping.jobVersionId, {
			canonical_job_id: mapping.canonicalJobId,
			job_version_id: mapping.jobVersionId
		}, clientOrPool, ctx);
		return;
	}
	if (!jobVersionId) return;
	if (taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS") {
		const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
		const repairExistingState = payload.repair_existing_state === true;
		if (repairExistingState && (/* @__PURE__ */ new Set([
			"LANE_ROUTED",
			"MATCHED",
			"QUEUED_FOR_AI",
			"EVALUATING",
			"AI_EVALUATED",
			"EVALUATED"
		])).has(state.processingState || "") && state.primaryLane && state.primaryLane !== "UNCLASSIFIED") {
			await enqueueStageTask("MATCH_PROFILE_EVIDENCE", jobVersionId, {
				canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
				job_version_id: jobVersionId
			}, clientOrPool, ctx);
			return;
		}
		if (repairExistingState && state.processingState === "PREQUALIFIED") {
			await enqueueStageTask("PUBLISH_EMBEDDING", jobVersionId, {
				canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
				job_version_id: jobVersionId
			}, clientOrPool, ctx);
			return;
		}
		await enqueueStageTask("APPLY_HARD_GATES", jobVersionId, payload, clientOrPool, ctx);
		return;
	}
	const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
	const stagePayload = {
		canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
		job_version_id: jobVersionId,
		...payload.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}
	};
	if (taskType === "APPLY_HARD_GATES") {
		if (state.processingState === "PREQUALIFIED") await enqueueStageTask("PUBLISH_EMBEDDING", jobVersionId, stagePayload, clientOrPool, ctx);
		else if (state.processingState === "HARD_REJECTED" || state.processingState === "NEEDS_VERIFICATION") await enqueueStageTask("DECIDE_RECOMMENDATION", jobVersionId, stagePayload, clientOrPool, ctx);
		return;
	}
	if (taskType === "EXTRACT_QUOTED_REQUIREMENTS") {
		await enqueueStageTask("PUBLISH_EMBEDDING", jobVersionId, stagePayload, clientOrPool, ctx);
		return;
	}
	if (taskType === "PUBLISH_EMBEDDING") {
		await enqueueStageTask("ROUTE_LANE", jobVersionId, stagePayload, clientOrPool, ctx);
		return;
	}
	if (taskType === "ROUTE_LANE") {
		if (state.processingState === "LANE_ROUTED") await enqueueStageTask("MATCH_PROFILE_EVIDENCE", jobVersionId, stagePayload, clientOrPool, ctx);
		else if (state.processingState === "ROUTING_DEFERRED") await enqueueStageTask("DECIDE_RECOMMENDATION", jobVersionId, stagePayload, clientOrPool, ctx);
		return;
	}
	if (taskType === "MATCH_PROFILE_EVIDENCE") {
		if (![
			"LANE_ROUTED",
			"MATCHED",
			"QUEUED_FOR_AI",
			"EVALUATING",
			"AI_EVALUATED",
			"EVALUATED"
		].includes(state.processingState || "")) return;
		await enqueueStageTask("DECIDE_RECOMMENDATION", jobVersionId, stagePayload, clientOrPool, ctx);
		return;
	}
	if (taskType === "DECIDE_RECOMMENDATION" && state.recommendationEligibility === "ELIGIBLE" && (state.recommendationOutcome === "PRIORITY" || state.recommendationOutcome === "REVIEW")) await enqueueStageTask("ENQUEUE_EXPLANATION", jobVersionId, stagePayload, clientOrPool, ctx);
}
async function executeStageTask(taskType, task, clientOrPool, ctx, dependencies, budgetRunId) {
	if (taskType === "NORMALIZE_OBSERVATION") {
		const observationId = requireStringPayload(task, "observation_id");
		if ((await dependencies.runNormalization(clientOrPool, {
			context: ctx,
			observationIds: [observationId],
			limit: 1
		})).totalErrors > 0) throw new Error(`Normalization failed for observation ${observationId}.`);
		if (!(await lookupObservationVersion(clientOrPool, ctx, observationId)).jobVersionId) throw new Error(`Observation ${observationId} still has no job_version_id after normalization.`);
		return;
	}
	const jobVersionId = requireStringPayload(task, "job_version_id");
	if (taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS") {
		const reprocess = (task.payload || {}).reprocess === true;
		const currentState = await lookupJobState(clientOrPool, ctx, jobVersionId);
		if (currentState.latestJobVersionId && currentState.latestJobVersionId !== jobVersionId) return;
		if (["HARD_REJECTED", "MANUALLY_REMOVED"].includes(currentState.processingState || "")) return;
		if ((await dependencies.runRequirementsExtraction(clientOrPool, {
			context: ctx,
			jobVersionIds: [jobVersionId],
			limit: 1,
			quotedMode: "deterministic_only",
			failFastOnQuotedProviderFailure: false,
			ignoreRetryWindow: true,
			reprocess
		})).errors > 0) throw new Error(`Deterministic requirement extraction failed for job_version_id=${jobVersionId}.`);
		if (!await jobVersionHasCompletedRequirementsExtraction(clientOrPool, ctx, jobVersionId, "DETERMINISTIC")) throw new Error(`No completed deterministic requirement extraction found for job_version_id=${jobVersionId}.`);
		return;
	}
	if (taskType === "APPLY_HARD_GATES") {
		const payload = task.payload || {};
		const reprocess = payload.force_policy_recalculation === true || payload.reprocess === true;
		const currentState = await lookupJobState(clientOrPool, ctx, jobVersionId);
		if (currentState.latestJobVersionId && currentState.latestJobVersionId !== jobVersionId) return;
		if (!reprocess && currentState.processingState && currentState.processingState !== "RAW_STAGED") return;
		const verificationAnswerRevisionId = optionalStringPayload(task, "verification_answer_revision_id");
		if ((await dependencies.runHardGates(clientOrPool, {
			context: ctx,
			jobVersionIds: [jobVersionId],
			limit: 1,
			reprocess,
			verificationJobVersionId: jobVersionId,
			...verificationAnswerRevisionId ? { verificationAnswerRevisionId } : {}
		})).errors > 0) throw new Error(`Hard gate failed for job_version_id=${jobVersionId}.`);
		const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
		if (![
			"PREQUALIFIED",
			"HARD_REJECTED",
			"NEEDS_VERIFICATION"
		].includes(state.processingState || "")) throw new Error(`Hard gate left job_version_id=${jobVersionId} in unexpected state ${state.processingState}.`);
		return;
	}
	if (taskType === "EXTRACT_QUOTED_REQUIREMENTS") {
		await dependencies.runRequirementsExtraction(clientOrPool, {
			context: ctx,
			jobVersionIds: [jobVersionId],
			limit: 1,
			quotedMode: "with_quoted",
			ignoreRetryWindow: true
		});
		return;
	}
	if (taskType === "PUBLISH_EMBEDDING") {
		const maxItems = Number.parseInt(String(process.env.PIPELINE_TASK_EMBEDDING_BATCH_SIZE || "500"), 10);
		const summary = await dependencies.runEmbeddingBatchWithFallback(Number.isFinite(maxItems) && maxItems > 0 ? maxItems : 500, clientOrPool, {
			context: ctx,
			jobVersionIds: [jobVersionId],
			includeProfileFacts: true,
			includeLanePrototypes: true
		});
		const fallbackFailed = summary.fallback?.failed ?? 0;
		if (summary.primary.failed > 0 && fallbackFailed > 0) throw new Error(`Embedding publication failed for ${summary.primary.failed + fallbackFailed} input(s).`);
		if (!await jobVersionHasEmbedding(clientOrPool, ctx, jobVersionId, [summary.seededSpaces.primarySpaceId, ...summary.primary.failed > 0 && summary.fallback ? [summary.seededSpaces.fallbackSpaceId] : []])) throw new Error(`No published JOB_VERSION embedding found for job_version_id=${jobVersionId}.`);
		return;
	}
	if (taskType === "ROUTE_LANE") {
		const routeState = await lookupJobState(clientOrPool, ctx, jobVersionId);
		if (routeState.latestJobVersionId && routeState.latestJobVersionId !== jobVersionId) return;
		const summary = await dependencies.runLaneRouting(clientOrPool, {
			context: ctx,
			jobVersionIds: [jobVersionId],
			limit: 1
		});
		const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
		const processingState = state.processingState;
		if ([
			"LANE_ROUTED",
			"MATCHED",
			"QUEUED_FOR_AI",
			"EVALUATING",
			"AI_EVALUATED",
			"EVALUATED"
		].includes(processingState ?? "")) return;
		if (isTechnicalRoutingDeferral(state)) throw new Error(`Lane routing deferred due to technical evidence for job_version_id=${jobVersionId}.`);
		if (state.processingState === "ROUTING_DEFERRED" && summary.deferred >= 0) return;
		throw new Error(`Lane routing did not advance job_version_id=${jobVersionId}; state=${state.processingState}.`);
	}
	if (taskType === "MATCH_PROFILE_EVIDENCE") {
		const matchState = await lookupJobState(clientOrPool, ctx, jobVersionId);
		if (matchState.latestJobVersionId && matchState.latestJobVersionId !== jobVersionId) return;
		if (![
			"LANE_ROUTED",
			"MATCHED",
			"QUEUED_FOR_AI",
			"EVALUATING",
			"AI_EVALUATED",
			"EVALUATED"
		].includes(matchState.processingState || "")) return;
		if (!await jobVersionHasCompletedRequirementsExtraction(clientOrPool, ctx, jobVersionId, "DETERMINISTIC")) {
			await enqueueStageTask("EXTRACT_DETERMINISTIC_REQUIREMENTS", jobVersionId, {
				canonical_job_id: task.payload?.canonical_job_id,
				job_version_id: jobVersionId,
				repair_existing_state: true
			}, clientOrPool, ctx);
			throw new PipelineTaskDependencyBlockedError(`EXTRACT_DETERMINISTIC_REQUIREMENTS:${jobVersionId}`, "Run deterministic requirement extraction, then resume MATCH_PROFILE_EVIDENCE.", `Matching is blocked until deterministic requirements are current for job_version_id=${jobVersionId}.`);
		}
		const summary = await dependencies.runDeterministicMatcher(clientOrPool, {
			context: ctx,
			jobVersionIds: [jobVersionId],
			limit: 1
		});
		if (summary.errors > 0) throw new Error(`Deterministic matching reported ${summary.errors} error(s).`);
		const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
		if (state.processingState !== "MATCHED") throw new Error(`Deterministic matching left job_version_id=${jobVersionId} in state ${state.processingState}.`);
		return;
	}
	if (taskType === "DECIDE_RECOMMENDATION") {
		const decisionState = await lookupJobState(clientOrPool, ctx, jobVersionId);
		if (decisionState.latestJobVersionId && decisionState.latestJobVersionId !== jobVersionId) return;
		if (["RAW_STAGED", "PREQUALIFIED"].includes(decisionState.processingState || "")) return;
		const matchDependentStates = /* @__PURE__ */ new Set([
			"LANE_ROUTED",
			"MATCHED",
			"QUEUED_FOR_AI",
			"EVALUATING",
			"AI_EVALUATED",
			"EVALUATED"
		]);
		if (!(decisionState.processingState === "ROUTING_DEFERRED") && (decisionState.gateDecision === "PASS" || matchDependentStates.has(decisionState.processingState || "")) && !await jobVersionHasCurrentMatch(clientOrPool, ctx, jobVersionId)) {
			await enqueueStageTask("MATCH_PROFILE_EVIDENCE", jobVersionId, {
				canonical_job_id: (task.payload || {}).canonical_job_id,
				job_version_id: jobVersionId
			}, clientOrPool, ctx);
			throw new PipelineTaskDependencyBlockedError(`MATCH_PROFILE_EVIDENCE:${jobVersionId}`, "Run a current profile match, then resume DECIDE_RECOMMENDATION.", `Recommendation decision is blocked until a current match exists for job_version_id=${jobVersionId}.`);
		}
		const summary = await dependencies.runRecommendationDecider(clientOrPool, {
			context: ctx,
			jobVersionIds: [jobVersionId],
			limit: 1
		});
		if (summary.errors > 0) throw new Error(`Recommendation decider reported ${summary.errors} error(s).`);
		if (!(await lookupJobState(clientOrPool, ctx, jobVersionId)).recommendationOutcome) throw new Error(`Recommendation decider left job_version_id=${jobVersionId} without recommendation_outcome.`);
		return;
	}
	if (taskType === "ENQUEUE_EXPLANATION") await dependencies.runExplanationQueueEnqueuer(clientOrPool, {
		context: ctx,
		jobVersionIds: [jobVersionId],
		limit: 1,
		budgetRunId
	});
}
async function processClaimedTask(task, clientOrPool, ctx, options, dependencies) {
	const taskType = task.taskType;
	if (!PIPELINE_STAGE_TASK_TYPES.includes(taskType)) throw new Error(`Unsupported pipeline task type: ${task.taskType}`);
	let heartbeatTimer = null;
	if (options.heartbeatSeconds > 0) {
		heartbeatTimer = setInterval(() => {
			heartbeatPipelineTask(task.taskId, task.leaseId, clientOrPool, {
				context: ctx,
				extendLeaseSeconds: Math.max(options.heartbeatSeconds * 3, 60)
			}).catch((error) => {
				console.warn(`Pipeline task heartbeat failed for ${task.taskKey}:`, error);
			});
		}, options.heartbeatSeconds * 1e3);
		heartbeatTimer.unref?.();
	}
	try {
		await executeStageTask(taskType, task, clientOrPool, ctx, dependencies, options.budgetRunId);
		await completePipelineTaskAndRun(task, clientOrPool, {
			context: ctx,
			afterComplete: async (transactionClient) => {
				await maybeEnqueueAfterTask(taskType, task, transactionClient, ctx);
			}
		});
	} finally {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
	}
}
async function runPipelineStageTaskWorker(clientOrPool, options = {}, dependencies = defaultDependencies) {
	const pool = clientOrPool || defaultPool;
	const ownsClient = isPool(pool);
	const client = ownsClient ? await pool.connect() : pool;
	const ctx = options.context ?? await resolveWorkspaceContext(client);
	const taskTypes = options.taskTypes ?? [...PIPELINE_STAGE_TASK_TYPES];
	const maxTasks = options.maxTasks ?? 100;
	const claimBatchSize = options.claimBatchSize ?? 1;
	const leaseSeconds = options.leaseSeconds ?? 300;
	const heartbeatSeconds = options.heartbeatSeconds ?? Math.max(15, Math.floor(leaseSeconds / 3));
	const wallClockMs = options.wallClockMs ?? 33e5;
	const claimedBy = options.claimedBy ?? `stage-worker:${process.pid}`;
	const budgetRunId = options.budgetRunId?.trim() || crypto.default.randomUUID();
	const startedAt = Date.now();
	const summary = {
		seeded: null,
		claimed: 0,
		completed: 0,
		blocked: 0,
		failed: 0,
		deadLettered: 0,
		byType: {},
		errors: []
	};
	try {
		throwIfWorkerCancelled(options.abortSignal);
		if (options.seed !== false) summary.seeded = await seedRecoverablePipelineTasks(client, {
			context: ctx,
			taskTypes,
			includeRoutingDeferred: options.includeRoutingDeferred,
			routingDeferredReplayVersion: options.routingDeferredReplayVersion,
			maxSeedPerType: options.maxSeedPerType
		});
		while (summary.claimed < maxTasks && Date.now() - startedAt < wallClockMs) {
			throwIfWorkerCancelled(options.abortSignal);
			let madeProgress = false;
			for (const taskType of taskTypes) {
				throwIfWorkerCancelled(options.abortSignal);
				if (summary.claimed >= maxTasks || Date.now() - startedAt >= wallClockMs) break;
				const claimedTasks = await claimPipelineTasks({
					taskType,
					limit: Math.min(claimBatchSize, maxTasks - summary.claimed),
					leaseSeconds,
					claimedBy
				}, client, { context: ctx });
				if (claimedTasks.length === 0) continue;
				madeProgress = true;
				for (const task of claimedTasks) {
					summary.claimed += 1;
					incrementWorker(summary, task.taskType, "claimed");
					try {
						throwIfWorkerCancelled(options.abortSignal);
						await processClaimedTask(task, client, ctx, {
							heartbeatSeconds,
							budgetRunId
						}, dependencies);
						summary.completed += 1;
						incrementWorker(summary, task.taskType, "completed");
						throwIfWorkerCancelled(options.abortSignal);
					} catch (error) {
						if (error instanceof PipelineWorkerCancelledError) {
							await releasePipelineTaskForRetry(task, error.message, client, { context: ctx }).catch((releaseError) => {
								summary.errors.push({
									taskType: task.taskType,
									taskKey: task.taskKey,
									error: `Cancellation lease release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
								});
							});
							throw error;
						}
						if (error instanceof PipelineTaskDependencyBlockedError) {
							await blockPipelineTask(task, {
								blockedOn: error.blockedOn,
								reason: error.message,
								repairAction: error.repairAction
							}, client, { context: ctx });
							summary.blocked += 1;
							incrementWorker(summary, task.taskType, "blocked");
							continue;
						}
						const message = error instanceof Error ? error.message : String(error);
						const exhausted = task.attemptNumber >= task.maxAttempts;
						await failPipelineTask(task, message, client, { context: ctx });
						if (exhausted) {
							await markTaskTargetNeedsManualReview(task, client, ctx, message);
							summary.deadLettered += 1;
							incrementWorker(summary, task.taskType, "deadLettered");
						}
						summary.failed += 1;
						incrementWorker(summary, task.taskType, "failed");
						summary.errors.push({
							taskType: task.taskType,
							taskKey: task.taskKey,
							error: message
						});
					}
				}
			}
			if (!madeProgress) break;
		}
		return summary;
	} finally {
		if (ownsClient && typeof client.release === "function") client.release();
	}
}
//#endregion
//#region scripts/process_pipeline_tasks.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var LOCK_ID = 1001;
var databaseUrl = String(process.env.DATABASE_URL || "").trim();
var lockDatabaseUrl = String(process.env.DATABASE_URL_UNPOOLED || databaseUrl).trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required for the pipeline worker.");
if (isPooledPostgresConnectionString(lockDatabaseUrl)) throw new Error("Pipeline worker requires a direct/unpooled DATABASE_URL_UNPOOLED for its singleton advisory lock; pooled DATABASE_URL is reserved for task traffic.");
var pool = new pg.default.Pool(pgConnectionConfig(databaseUrl));
var lockPool = new pg.default.Pool(pgConnectionConfig(lockDatabaseUrl));
var shutdownController = new AbortController();
var shutdownSignal = null;
var forcedShutdownTimer = null;
function parsePositiveIntEnv(name, fallback, max) {
	const raw = process.env[name];
	const parsed = raw ? Number.parseInt(raw, 10) : NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return max ? Math.min(parsed, max) : parsed;
}
function parseBooleanEnv(name, fallback) {
	const raw = process.env[name];
	if (raw === void 0 || raw.trim() === "") return fallback;
	return [
		"1",
		"true",
		"yes",
		"on"
	].includes(raw.trim().toLowerCase());
}
function requestShutdown(signal) {
	if (shutdownController.signal.aborted) return;
	shutdownSignal = signal;
	const graceMs = parsePositiveIntEnv("PIPELINE_TASK_WORKER_SHUTDOWN_GRACE_MS", 6e4, 6e4);
	const message = `Pipeline task worker received ${signal}; stopping before claiming more work.`;
	console.warn(message);
	shutdownController.abort(new PipelineWorkerCancelledError(message));
	forcedShutdownTimer = setTimeout(() => {
		console.error(`Pipeline task worker did not stop within ${graceMs}ms after ${signal}; forcing exit.`);
		process.exit(130);
	}, graceMs);
	forcedShutdownTimer.unref?.();
}
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
async function processPipelineTasks() {
	console.log("====================================================");
	console.log("          PROCESS PIPELINE TASK WORKER              ");
	console.log("====================================================");
	const requestedTaskTypes = parsePipelineTaskTypes(process.env.PIPELINE_TASK_WORKER_TASK_TYPES);
	const taskTypes = requestedTaskTypes.includes("EXTRACT_QUOTED_REQUIREMENTS") && Boolean(process.env.PIPELINE_TASK_WORKER_TASK_TYPES?.trim()) || parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_QUOTED_REQUIREMENTS", false) ? requestedTaskTypes : requestedTaskTypes.filter((taskType) => taskType !== "EXTRACT_QUOTED_REQUIREMENTS");
	const lockId = taskTypes.length === 1 && taskTypes[0] === "EXTRACT_QUOTED_REQUIREMENTS" ? 1002 : LOCK_ID;
	const checkAiPreflight = parseBooleanEnv("PIPELINE_TASK_WORKER_PREFLIGHT_MODELS", true);
	const requiresExtractionRoute = taskTypes.includes("EXTRACT_QUOTED_REQUIREMENTS");
	let activeTaskTypes = [...taskTypes];
	if (checkAiPreflight && requiresExtractionRoute) {
		const { preflightModelRoutes } = await Promise.resolve().then(() => agent_exports);
		const preflight = await preflightModelRoutes();
		console.log("Model route preflight status:", {
			evaluation: preflight.evaluation,
			extraction: preflight.extraction,
			embedding: preflight.embedding,
			document: preflight.document
		});
		if (!preflight.extraction) {
			if (activeTaskTypes.length === 1 && activeTaskTypes[0] === "EXTRACT_QUOTED_REQUIREMENTS") throw new Error("Pipeline task worker configured exclusively for EXTRACT_QUOTED_REQUIREMENTS, but extraction model routes are unavailable.");
			console.warn("Extraction model routes unavailable; excluding EXTRACT_QUOTED_REQUIREMENTS from active run so deterministic tasks proceed.");
			activeTaskTypes = activeTaskTypes.filter((t) => t !== "EXTRACT_QUOTED_REQUIREMENTS");
		}
	}
	const lockClient = await lockPool.connect();
	let lockAcquired = false;
	let workerError = null;
	try {
		const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock($1) AS locked`, [lockId]);
		lockAcquired = Boolean(rows[0]?.locked);
		if (!lockAcquired) {
			console.warn("Another pipeline worker is already running. Exiting cleanly.");
			return;
		}
		const summary = await runPipelineStageTaskWorker(pool, {
			taskTypes: activeTaskTypes,
			seed: parseBooleanEnv("PIPELINE_TASK_WORKER_SEED", true),
			includeRoutingDeferred: parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_ROUTING_DEFERRED", false),
			routingDeferredReplayVersion: process.env.PIPELINE_TASK_WORKER_ROUTING_DEFERRED_REPLAY_VERSION || "routing_deferred_replay_v1",
			maxTasks: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_TASKS", 100, 1e3),
			claimBatchSize: parsePositiveIntEnv("PIPELINE_TASK_WORKER_CLAIM_BATCH_SIZE", 1, 25),
			leaseSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_LEASE_SECONDS", 300, 3600),
			heartbeatSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_HEARTBEAT_SECONDS", 60, 600),
			wallClockMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_WALL_CLOCK_MS", 33e5, 828e5),
			maxSeedPerType: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE", 500, 5e3),
			claimedBy: process.env.PIPELINE_TASK_WORKER_CLAIMED_BY || `gha-stage-worker:${process.pid}`,
			abortSignal: shutdownController.signal
		});
		console.log("Pipeline task worker summary:", JSON.stringify(summary, null, 2));
		if (shutdownController.signal.aborted) throw new PipelineWorkerCancelledError(`Pipeline task worker cancelled by ${shutdownSignal || "shutdown signal"}.`);
		const failOnRetryWait = parseBooleanEnv("PIPELINE_TASK_WORKER_EXIT_ON_RETRY_WAIT", true);
		if (summary.deadLettered > 0) throw new Error(`Pipeline task worker dead-lettered ${summary.deadLettered} task(s).`);
		if (failOnRetryWait && summary.failed > 0) throw new Error(`Pipeline task worker moved ${summary.failed} task(s) to RETRY_WAIT. See task errors above.`);
	} catch (err) {
		workerError = err instanceof Error ? err : new Error(String(err));
		console.error("Pipeline task worker failed:", workerError.message);
	} finally {
		if (forcedShutdownTimer) {
			clearTimeout(forcedShutdownTimer);
			forcedShutdownTimer = null;
		}
		if (lockAcquired) await lockClient.query(`SELECT pg_advisory_unlock($1)`, [lockId]).catch(() => {});
		lockClient.release();
		await pool.end();
		await lockPool.end();
	}
	if (workerError) {
		process.exitCode = workerError instanceof PipelineWorkerCancelledError ? 130 : 1;
		throw workerError;
	}
}
if (process.argv[1] && process.argv[1].includes("process_pipeline_tasks")) processPipelineTasks().catch(() => {
	process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 1);
});
//#endregion
exports.MODEL_REGISTRY = MODEL_REGISTRY;
exports.REQUIREMENTS_SCHEMA_VERSION = REQUIREMENTS_SCHEMA_VERSION;
exports.RequirementImportanceSchema = RequirementImportanceSchema;
exports.RequirementTypeSchema = RequirementTypeSchema;
exports.generateContentAudited = generateContentAudited;
exports.processPipelineTasks = processPipelineTasks;
exports.validateQuotedRequirements = validateQuotedRequirements;
