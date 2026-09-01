import { describe, it, expect } from "vitest";
import { applyGlobalGates } from "../../services/criteria.js";

type GateInput = {
	title: string;
	description: string;
	workplace_type?: string;
	employment_type?: string;
	location?: string;
};

function runGate(input: GateInput) {
	return applyGlobalGates({
		id: "test-job",
		source: "unit-test",
		source_id: "unit-test-id",
		company_name: "Test Company",
		title: input.title,
		raw_description: input.description,
		location: input.location ?? "Singapore",
		workplace_type: input.workplace_type ?? "REMOTE",
		employment_type: input.employment_type ?? "PERMANENT"
	} as any);
}

const technicalResponsibilities = [
	"Build and ship production ML models for document intelligence.",
	"Develop Python services and SQL data pipelines for model evaluation.",
	"Design RAG workflows and evaluate LLM outputs using strict quality gates."
].join(" ");

describe("criteria gates regression coverage", () => {
	it("does not hard reject legal AI and RegTech technical roles", () => {
		const result = runGate({
			title: "Associate Director, Legal AI & RegTech",
			description: `${technicalResponsibilities} Domain focus: legal ai, regtech, compliance automation.`
		});

		expect(result.rejection_codes).not.toContain("NON_TECHNICAL_FUNCTION");
		expect(result.rejection_codes).not.toContain("GATE_OUT_OF_SCOPE_DOMAIN");
	});

	it("does not hard reject bioinformatics AI scientist roles", () => {
		const result = runGate({
			title: "Senior Bioinformatics AI Scientist",
			description: `${technicalResponsibilities} Domain focus: bioinformatics, computational biology, genomics.`
		});

		expect(result.rejection_codes).not.toContain("NON_TECHNICAL_FUNCTION");
		expect(result.rejection_codes).not.toContain("GATE_OUT_OF_SCOPE_DOMAIN");
	});

	it("keeps equivalent responsibilities technical across title families", () => {
		const titles = [
			"AI Researcher",
			"Applied Scientist",
			"Machine Learning Engineer",
			"AI Architect"
		];

		for (const title of titles) {
			const result = runGate({
				title,
				description: technicalResponsibilities
			});
			expect(result.rejection_codes, `Unexpected rejection for ${title}`).not.toContain("NON_TECHNICAL_FUNCTION");
		}
	});

	it("rejects pure compliance language without technical building evidence", () => {
		const result = runGate({
			title: "Compliance Operations Manager",
			description: "Drive regulatory reporting, policy governance, and committee updates."
		});

		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
	});

	it("hard rejects explicit ONSITE workplace type", () => {
		const result = runGate({
			title: "Machine Learning Engineer",
			description: technicalResponsibilities,
			workplace_type: "ONSITE"
		});

		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
	});

	it("requires verification for hybrid roles without day count", () => {
		const result = runGate({
			title: "Applied Scientist",
			description: `${technicalResponsibilities} This is a hybrid role with office attendance expectations.`,
			workplace_type: "HYBRID"
		});

		expect(result.status).toBe("NEEDS_VERIFICATION");
		expect(result.rejection_codes).toContain("NEEDS_VERIFICATION");
	});

	it("hard rejects structured contract employment", () => {
		const result = runGate({
			title: "Senior Data Engineer",
			description: technicalResponsibilities,
			employment_type: "CONTRACT"
		});

		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("GATE_CONTRACT_ROLE");
	});
});
