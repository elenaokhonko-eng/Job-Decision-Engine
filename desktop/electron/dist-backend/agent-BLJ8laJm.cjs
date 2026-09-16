const require_evaluate_queue = require("./evaluate_queue.cjs");
let pg = require("pg");
pg = require_evaluate_queue.__toESM(pg, 1);
let dotenv = require("dotenv");
dotenv = require_evaluate_queue.__toESM(dotenv, 1);
let crypto = require("crypto");
crypto = require_evaluate_queue.__toESM(crypto, 1);
require("zod");
let _google_genai = require("@google/genai");
require("js-yaml");
//#region src/db/db.ts
dotenv.default.config();
dotenv.default.config({ path: ".env.local" });
var databaseUrl = process.env.DATABASE_URL;
var pool = new pg.default.Pool(require_evaluate_queue.pgPoolConfig(databaseUrl));
pool.on("error", (err) => {
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
	const statsRes = await pool.query(`SELECT 
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
		await pool.query(`UPDATE companies SET
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
		if (!searchTerm) return (await pool.query("SELECT * FROM jobs ORDER BY created_at DESC")).rows.map(mapRowToJob);
		const lower = `%${searchTerm.toLowerCase()}%`;
		return (await pool.query(`SELECT * FROM jobs 
       WHERE title ILIKE $1 OR company_name ILIKE $1 OR raw_description::text ILIKE $1 
       ORDER BY created_at DESC`, [lower])).rows.map(mapRowToJob);
	}
	async addJob(job, bypassLiveCheck = false) {
		if (!job.processing_status || job.processing_status === "PENDING_GLOBAL_GATE") throw new Error("Cannot insert unevaluated jobs into the final jobs table.");
		let existingJob;
		if (job.content_hash) existingJob = await pool.query("SELECT id FROM jobs WHERE content_hash = $1", [job.content_hash]);
		else existingJob = await pool.query("SELECT id FROM jobs WHERE (company_name = $1 AND title = $2) OR careers_portal_url = $3", [
			job.company_name,
			job.title,
			job.careers_portal_url
		]);
		if (existingJob.rows.length > 0) {
			const existingId = existingJob.rows[0].id;
			await this.updateJobEvaluation(existingId, job);
			return mapRowToJob((await pool.query("SELECT * FROM jobs WHERE id = $1", [existingId])).rows[0]);
		}
		if (!await verifyUrlLive(job.careers_portal_url, bypassLiveCheck)) throw new Error(`Invalid or expired careers_portal_url: ${job.careers_portal_url}`);
		let companyId = null;
		const compRes = await pool.query("SELECT id FROM companies WHERE name = $1", [job.company_name]);
		if (compRes.rows.length > 0) companyId = compRes.rows[0].id;
		else {
			const industry = job.title.toLowerCase().includes("bio") || job.title.toLowerCase().includes("pharma") ? "Life Sciences & Biotech" : "Institutional Finance & Asset AI";
			companyId = (await pool.query("INSERT INTO companies (name, industry, website_url, careers_page_url) VALUES ($1, $2, $3, $4) RETURNING id", [
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
		const insertJob = await pool.query(`INSERT INTO jobs (
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
		const res = await pool.query(`
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
		const jobRes = await pool.query("SELECT company_id FROM jobs WHERE id = $1", [id]);
		if (jobRes.rows.length > 0 && jobRes.rows[0].company_id) await updateCompanyRatings(jobRes.rows[0].company_id);
		return res.rowCount !== null && res.rowCount > 0;
	}
	async deleteJob(id) {
		const jobRes = await pool.query("SELECT company_id FROM jobs WHERE id = $1", [id]);
		const res = await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
		if (jobRes.rows.length > 0 && jobRes.rows[0].company_id) await updateCompanyRatings(jobRes.rows[0].company_id);
		return res.rowCount !== null && res.rowCount > 0;
	}
	async logInteraction(question, toolsUsed, answer, trace) {
		return (await pool.query(`INSERT INTO interactions_log (question, tools_used, agent_trace, structured_answer) 
       VALUES ($1, $2, $3, $4) RETURNING id, created_at as timestamp, question, tools_used as "toolsUsed", agent_trace as trace, structured_answer as answer`, [
			question,
			toolsUsed,
			trace,
			JSON.stringify(answer)
		])).rows[0];
	}
	async getInteractions() {
		return (await pool.query(`SELECT id, created_at as timestamp, question, tools_used as "toolsUsed", structured_answer as answer, agent_trace as trace 
       FROM interactions_log ORDER BY created_at DESC`)).rows;
	}
	async clearInteractions() {
		await pool.query("DELETE FROM interactions_log");
	}
	/**
	* Analytics Aggregation Engine
	* Dynamically compiles company metrics from the database.
	*/
	async getNdCultureAnalytics() {
		const approved = await pool.query("SELECT * FROM nd_approved_companies");
		const toxic = await pool.query("SELECT * FROM nd_blacklisted_companies");
		const totalRes = await pool.query("SELECT COUNT(*) as count FROM companies");
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
			await pool.query("INSERT INTO raw_companies (name, industry, website_url, careers_page_url) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING", [
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
		return (await pool.query(`INSERT INTO raw_jobs (content_hash, company_name, title, source, raw_description, salary_range, location, posted_date, careers_portal_url, processed)
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
		return (await pool.query(queryStr)).rows;
	}
	async markRawJobProcessed(id) {
		const res = await pool.query("UPDATE raw_jobs SET processed = TRUE, processed_at = NOW() WHERE id = $1", [id]);
		return res.rowCount !== null && res.rowCount > 0;
	}
	async resetToDefaults() {
		await pool.query("DELETE FROM jobs");
		await pool.query("DELETE FROM companies");
		await pool.query("DELETE FROM interactions_log");
		await pool.query("DELETE FROM raw_jobs");
		await pool.query("DELETE FROM raw_companies");
		for (const job of DEFAULT_JOBS) await this.addJob(job, true);
	}
};
new PostgresDatabase();
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
		const ctx = options?.context ?? await require_evaluate_queue.resolveWorkspaceContext(client);
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
		const ctx = options?.context ?? await require_evaluate_queue.resolveWorkspaceContext(client);
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
		const ctx = options?.context ?? await require_evaluate_queue.resolveWorkspaceContext(client);
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
new Set([
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
].map(([territory]) => territory));
//#endregion
//#region src/services/agent.ts
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
function isRetryableModelRequestError(error) {
	const status = Number(error?.status);
	if (Number.isFinite(status)) return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
	const message = String(error?.message || error || "").toLowerCase();
	return error?.name === "AbortError" || error?.name === "TimeoutError" || message.includes("timeout") || message.includes("timed out") || message.includes("econnreset") || message.includes("etimedout") || message.includes("fetch failed") || message.includes("network");
}
function checkModelRegistryPreflight() {
	const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	const evalOrder = resolveProviderOrder(process.env.EVALUATION_PRIMARY_PROVIDER);
	const primaryProvider = evalOrder[0];
	const fallbackProvider = evalOrder[1];
	const warnings = [];
	const hasGemini = !!(geminiKey && geminiKey.trim() !== "" && geminiKey !== "MY_GEMINI_API_KEY");
	const hasOpenAI = !!(openaiKey && openaiKey.trim() !== "");
	const primaryAvailable = primaryProvider === "openai" ? hasOpenAI : hasGemini;
	const fallbackAvailable = fallbackProvider === "openai" ? hasOpenAI : hasGemini;
	if (!primaryAvailable) warnings.push(`Primary provider (${primaryProvider}) credentials are missing or placeholder.`);
	if (!fallbackAvailable) warnings.push(`Fallback provider (${fallbackProvider}) credentials are missing or placeholder.`);
	return {
		ok: primaryAvailable || fallbackAvailable,
		warnings,
		primaryAvailable,
		fallbackAvailable
	};
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
function cleanJsonResponseText(rawText) {
	let cleaned = rawText.trim();
	if (cleaned.startsWith("```json")) cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
	else if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
	const startCandidates = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((idx) => idx >= 0);
	const startIdx = startCandidates.length > 0 ? Math.min(...startCandidates) : -1;
	if (startIdx < 0) return cleaned;
	const endIdx = cleaned[startIdx] === "{" ? cleaned.lastIndexOf("}") : cleaned.lastIndexOf("]");
	if (endIdx > startIdx) return cleaned.substring(startIdx, endIdx + 1);
	return cleaned;
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
function hasOwnField(value, field) {
	return Object.prototype.hasOwnProperty.call(value, field);
}
function requireStringField(value, field) {
	if (!hasOwnField(value, field) || typeof value[field] !== "string" || value[field].trim().length === 0) throw new Error(`Evaluation output missing required string field "${field}".`);
	return value[field];
}
function requirePresentField(value, field) {
	if (!hasOwnField(value, field)) throw new Error(`Evaluation output missing required field "${field}".`);
}
function requireScoreField(value, field) {
	const score = value[field];
	if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error(`Evaluation output field "${field}" must be an integer from 0 to 100.`);
}
function parseStrictSingleEvaluationPayload(rawText, job) {
	let parsed;
	try {
		parsed = JSON.parse(cleanJsonResponseText(rawText));
	} catch (parseErr) {
		throw new Error(`Failed to parse evaluation response JSON: ${parseErr.message}. Raw text: ${rawText.slice(0, 200)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Evaluation output must be a single JSON object.");
	const root = parsed;
	const jobPayload = Array.isArray(root.evaluated_jobs) ? root.evaluated_jobs[0] : root;
	if (Array.isArray(root.evaluated_jobs) && root.evaluated_jobs.length !== 1) throw new Error(`Evaluation output must contain exactly one evaluated job; received ${root.evaluated_jobs.length}.`);
	if (!jobPayload || typeof jobPayload !== "object" || Array.isArray(jobPayload)) throw new Error("Evaluation output contained no valid job payload.");
	const reportedCanonicalJobId = requireStringField(jobPayload, "canonical_job_id");
	if (reportedCanonicalJobId !== job.canonicalJobId) throw new Error(`Evaluation identity mismatch: response canonical_job_id ${reportedCanonicalJobId} does not match request ${job.canonicalJobId}`);
	const reportedJobVersionId = requireStringField(jobPayload, "job_version_id");
	if (reportedJobVersionId !== job.jobVersionId) throw new Error(`Evaluation identity mismatch: response job_version_id ${reportedJobVersionId} does not match request ${job.jobVersionId}`);
	if ((typeof root.evaluation_summary === "string" ? root.evaluation_summary : typeof jobPayload.evaluation_summary === "string" ? jobPayload.evaluation_summary : "").trim().length === 0) throw new Error("Evaluation output missing required string field \"evaluation_summary\".");
	for (const field of [
		"primary_lane",
		"secondary_lanes",
		"lane_confidence",
		"lane_evidence",
		"rejection_codes",
		"strategic_value",
		"recommended_cv_version",
		"next_action"
	]) requirePresentField(jobPayload, field);
	if (!Array.isArray(jobPayload.secondary_lanes)) throw new Error("Evaluation output field \"secondary_lanes\" must be an array.");
	if (!Array.isArray(jobPayload.rejection_codes)) throw new Error("Evaluation output field \"rejection_codes\" must be an array.");
	for (const field of [
		"nd_score",
		"nd_friendly_score",
		"politics_stress_score",
		"sensory_overload_index",
		"building_research_ratio",
		"interaction_load"
	]) requireScoreField(jobPayload, field);
	return {
		root,
		jobPayload
	};
}
function buildEvaluationResultFromValidatedPayload(validated, job, pipelineRunId, attemptNum, response) {
	const { root, jobPayload } = validated;
	const evaluationSummary = typeof root.evaluation_summary === "string" ? root.evaluation_summary : jobPayload.evaluation_summary;
	return require_evaluate_queue.EvaluationResultSchema.parse({
		schema_version: require_evaluate_queue.SCHEMA_VERSION,
		canonical_job_id: jobPayload.canonical_job_id,
		job_version_id: jobPayload.job_version_id,
		pipeline_run_id: pipelineRunId,
		provider: response.provider,
		model: response.model,
		attempt: attemptNum,
		is_fallback: response.fallbackUsed,
		degraded_state: response.fallbackUsed,
		evaluation_summary: evaluationSummary,
		primary_lane: jobPayload.primary_lane,
		secondary_lanes: jobPayload.secondary_lanes,
		lane_confidence: jobPayload.lane_confidence,
		lane_evidence: jobPayload.lane_evidence,
		nd_score: jobPayload.nd_score,
		nd_friendly_score: jobPayload.nd_friendly_score,
		politics_stress_score: jobPayload.politics_stress_score,
		sensory_overload_index: jobPayload.sensory_overload_index,
		building_research_ratio: jobPayload.building_research_ratio,
		interaction_load: jobPayload.interaction_load,
		rejection_codes: jobPayload.rejection_codes,
		strategic_value: jobPayload.strategic_value,
		recommended_cv_version: jobPayload.recommended_cv_version,
		next_action: jobPayload.next_action,
		evaluated_at: (/* @__PURE__ */ new Date()).toISOString()
	});
}
/**
* Pure evaluation function for a single canonical job version.
* - No database-query tools
* - No side-effect database writes
* - Exactly one result returned
* - Strict canonical_job_id and job_version_id identity validation
* - Requires explicit score fields so missing model output cannot become synthetic defaults
*/
async function evaluateSingleCanonicalJob(job, pipelineRunId = crypto.default.randomUUID(), attemptNum = 1) {
	if (!job.candidateProfileContext || job.candidateProfileContext.trim().length === 0) throw new Error("AI evaluation requires an active database-backed candidateProfileContext; refusing fixed in-code profile fallback.");
	const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;
	if (!geminiKey && !openaiKey) throw new Error("CRITICAL API KEY CONFLICT: Neither GEMINI_API_KEY nor OPENAI_API_KEY environment variables are configured.");
	const trace = [];
	const prompt = `
You are an expert Executive Career Architect and AI Decision Engine.
Evaluate the single job below strictly against candidate fit, lane classifications, and neurodivergent-friendly metrics.

### ACTIVE DATABASE-BACKED CANDIDATE CONTEXT:
${job.candidateProfileContext}

### JOB DETAILS:
- Canonical Job ID: ${job.canonicalJobId}
- Job Version ID: ${job.jobVersionId}
- Job Title: ${job.normalizedTitle}
- Company: ${job.companyName}
- Careers Portal URL: ${job.canonicalUrl}
- Pre-routed Candidate Lane: ${job.candidateLane || "CORE_AI_DATA"}
- Workability Facts: ${JSON.stringify(job.workabilityFacts || {})}

### DESCRIPTION:
${job.descriptionText}

### MANDATED INSTRUCTIONS:
1. Classify into primary_lane ("CORE_AI_DATA", "LEGAL_REGTECH", "HEALTH_BIO_PHARMA", "INVESTMENT_MARKETS_FINTECH", or null).
2. Score nd_score, nd_friendly_score, politics_stress_score, sensory_overload_index, building_research_ratio, interaction_load as integers (0-100).
3. Set next_action to one of: "PRIORITY_APPLY", "APPLY_AFTER_VERIFICATION", "LOW_STRATEGIC_VALUE", "REJECTED".
4. Echo canonical_job_id and job_version_id exactly as supplied above.
5. Output EXACTLY ONE JSON object conforming to this shape:
{
  "evaluation_summary": "Overall synthesis",
  "evaluated_jobs": [
    {
      "canonical_job_id": "${job.canonicalJobId}",
      "job_version_id": "${job.jobVersionId}",
      "primary_lane": "CORE_AI_DATA | LEGAL_REGTECH | HEALTH_BIO_PHARMA | INVESTMENT_MARKETS_FINTECH | null",
      "secondary_lanes": ["string"],
      "lane_confidence": "High | Medium | Low",
      "lane_evidence": "string",
      "nd_score": 0,
      "nd_friendly_score": 0,
      "politics_stress_score": 0,
      "sensory_overload_index": 0,
      "building_research_ratio": 0,
      "interaction_load": 0,
      "rejection_codes": ["string"],
      "strategic_value": "string",
      "recommended_cv_version": "HEALTH_BIO_PHARMA | LEGAL_REGTECH | INVESTMENT_MARKETS_FINTECH | CORE_AI_DATA | None",
      "next_action": "PRIORITY_APPLY | APPLY_AFTER_VERIFICATION | LOW_STRATEGIC_VALUE | REJECTED"
    }
  ]
}
`;
	const systemInstruction = `You are an AI decision engine evaluating a single canonical job. Return a single JSON object.`;
	const openaiEvalModelForRoute = process.env.OPENAI_MODEL || MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL;
	trace.push("Attempting strict single-job evaluation through audited model routing...");
	const response = await generateContentAudited({
		purpose: "EVALUATION",
		routeKey: "single_job_evaluation",
		model: openaiEvalModelForRoute,
		contents: prompt,
		responseMimeType: "application/json",
		systemInstruction,
		validateResponseText: (text, validationContext) => {
			const validated = parseStrictSingleEvaluationPayload(text, job);
			buildEvaluationResultFromValidatedPayload(validated, job, pipelineRunId, attemptNum, {
				provider: validationContext.provider,
				model: validationContext.model,
				fallbackUsed: false
			});
			return validated;
		}
	});
	const validatedResult = buildEvaluationResultFromValidatedPayload(response.validatedPayload ?? parseStrictSingleEvaluationPayload(response.text, job), job, pipelineRunId, attemptNum, response);
	trace.push(`Strict single-job evaluation completed via ${response.provider} (${response.model}); fallback_used=${response.fallbackUsed}.`);
	return {
		evaluatedJob: validatedResult,
		provider: response.provider,
		model: response.model,
		fallbackUsed: response.fallbackUsed,
		attempts: response.attempts,
		errors: response.errors.map((error) => `${error.provider}:${error.model}: ${error.error}`),
		degraded: response.fallbackUsed,
		trace
	};
}
//#endregion
exports.checkModelRegistryPreflight = checkModelRegistryPreflight;
exports.evaluateSingleCanonicalJob = evaluateSingleCanonicalJob;
