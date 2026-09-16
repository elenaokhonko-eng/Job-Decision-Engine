const require_process_pipeline_tasks = require("./process_pipeline_tasks.cjs");
//#region src/requirements/quotedProvider.ts
var quotedRequirementProviderSchema = {
	type: "object",
	additionalProperties: false,
	required: ["schema_version", "requirements"],
	properties: {
		schema_version: {
			type: "string",
			enum: [require_process_pipeline_tasks.REQUIREMENTS_SCHEMA_VERSION]
		},
		requirements: {
			type: "array",
			minItems: 1,
			maxItems: 25,
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"requirement_key",
					"requirement_type",
					"importance",
					"requirement_text",
					"quote_text",
					"confidence"
				],
				properties: {
					requirement_key: {
						type: "string",
						pattern: "^R-[0-9]{3}$"
					},
					requirement_type: {
						type: "string",
						enum: require_process_pipeline_tasks.RequirementTypeSchema.options
					},
					importance: {
						type: "string",
						enum: require_process_pipeline_tasks.RequirementImportanceSchema.options
					},
					requirement_text: {
						type: "string",
						minLength: 5,
						maxLength: 4e3
					},
					quote_text: {
						type: "string",
						minLength: 5,
						maxLength: 4e3
					},
					confidence: {
						type: "number",
						minimum: 0,
						maximum: 1
					}
				}
			}
		}
	}
};
function buildPrompt(input) {
	return [
		"Extract job requirements using exact verbatim quotes from the supplied job description.",
		"Return STRICT JSON matching the provided schema.",
		"Rules:",
		`- schema_version must be "${require_process_pipeline_tasks.REQUIREMENTS_SCHEMA_VERSION}".`,
		"- Do not invent or paraphrase quote_text.",
		"- Every quote_text must appear verbatim in the description.",
		"- Confidence must be 0..1.",
		"- Include only concrete requirements.",
		"",
		`canonical_job_id: ${input.canonicalJobId}`,
		`job_version_id: ${input.jobVersionId}`,
		"",
		"Job description:",
		input.descriptionText
	].join("\n");
}
function cleanJsonResponseText(rawText) {
	let cleaned = rawText.trim();
	if (cleaned.startsWith("```json")) cleaned = cleaned.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
	else if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
	const startIdx = cleaned.indexOf("{");
	const endIdx = cleaned.lastIndexOf("}");
	if (startIdx >= 0 && endIdx > startIdx) cleaned = cleaned.substring(startIdx, endIdx + 1);
	return cleaned;
}
function parseAndValidateQuotedPayload(input, rawText) {
	let payload;
	try {
		payload = JSON.parse(cleanJsonResponseText(rawText));
	} catch (error) {
		throw new Error(`Quoted requirement provider returned invalid JSON: ${error.message || String(error)}`);
	}
	const validated = require_process_pipeline_tasks.validateQuotedRequirements(input.descriptionText, payload);
	if (!validated.valid) throw new Error(`Quoted requirement validation failed: ${validated.issues.map((issue) => `${issue.requirement_key}: ${issue.message}`).join("; ")}`);
	return {
		schema_version: require_process_pipeline_tasks.REQUIREMENTS_SCHEMA_VERSION,
		requirements: validated.requirements
	};
}
async function runQuotedRequirementProvider(input) {
	const prompt = buildPrompt(input);
	const response = await require_process_pipeline_tasks.generateContentAudited({
		purpose: "EXTRACTION",
		routeKey: "requirements_extraction",
		model: require_process_pipeline_tasks.MODEL_REGISTRY.EXTRACTION_OPENAI_MODEL,
		contents: prompt,
		responseMimeType: "application/json",
		responseSchema: quotedRequirementProviderSchema,
		systemInstruction: "You are a strict requirement extractor. Return valid JSON only.",
		validateResponseText: (text) => parseAndValidateQuotedPayload(input, text),
		clientOrPool: input.clientOrPool,
		context: input.workspaceContext
	});
	return {
		payload: response.validatedPayload ?? parseAndValidateQuotedPayload(input, response.text),
		provider: response.provider,
		model: response.model,
		extractorVersion: `quoted_provider_${require_process_pipeline_tasks.REQUIREMENTS_SCHEMA_VERSION}`,
		attempts: response.attempts,
		fallbackUsed: response.fallbackUsed,
		errors: response.errors
	};
}
//#endregion
exports.runQuotedRequirementProvider = runQuotedRequirementProvider;
