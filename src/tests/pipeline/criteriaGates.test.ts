import { describe, it, expect } from "vitest";
import { applyGlobalGates } from "../../services/criteria.js";
import { applyPersistedRequirementGates } from "../../pipeline/hardGate.js";
import { loadWorkabilityPolicy, type WorkabilityPolicy } from "../../pipeline/workabilityPolicy.js";

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
			"AI Architect",
			"Technical Program Manager",
			"Director of Engineering",
			"Director of Data",
			"Engineering Manager",
			"Head of Data Science",
			"Data Lead",
			"Data Analyst",
			"Analytics Engineer",
			"Technical Product Manager",
			"Lead Scientist",
			"Transformation Programme Director",
		];

		for (const title of titles) {
			const result = runGate({
				title,
				description: technicalResponsibilities
			});
			expect(result.rejection_codes, `Unexpected rejection for ${title}`).not.toContain("NON_TECHNICAL_FUNCTION");
		}
	});

	it("accepts broad project and program titles when the description proves technical scope", () => {
		for (const title of ["Project Manager", "Program Director", "Transformation Manager"]) {
			const result = runGate({
				title,
				description: "Lead software development and data platform delivery across the digital transformation roadmap."
			});
			expect(result.rejection_codes, `Unexpected rejection for ${title}`).not.toContain("NON_TECHNICAL_FUNCTION");
			expect(result.rejection_codes, `Unexpected domain rejection for ${title}`).not.toContain("GATE_NOT_AI_DATA");
		}
	});

	it("does not promote generic project management without technical evidence", () => {
		const result = runGate({
			title: "Project Manager",
			description: "Coordinate event logistics, budgets, meeting schedules, and stakeholder updates."
		});

		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("NON_TECHNICAL_FUNCTION");
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

	it("accepts hybrid roles without an exact day count under the active policy", () => {
		const result = runGate({
			title: "Applied Scientist",
			description: `${technicalResponsibilities} This is a hybrid role with office attendance expectations.`,
			workplace_type: "HYBRID"
		});

		expect(result.status).toBe("PASS");
		expect(result.rejection_codes).not.toContain("NEEDS_VERIFICATION");
	});

	it("uses explicit description work-mode headings when structured workplace data is unknown", () => {
		const remote = runGate({
			title: "Machine Learning Engineer",
			description: `${technicalResponsibilities} Full-time · Remote`,
			location: "",
			workplace_type: "",
		});
		const onsite = runGate({
			title: "Machine Learning Engineer",
			description: `${technicalResponsibilities} Full-time · Onsite`,
			location: "",
			workplace_type: "",
		});

		expect(remote.status).toBe("PASS");
		expect(onsite.status).toBe("HARD_REJECT");
		expect(onsite.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
	});

	it("can restore strict hybrid verification through user policy", () => {
		const policy: WorkabilityPolicy = {
			...loadWorkabilityPolicy(),
			hybridWithoutOfficeDaysAllowed: false,
		};
		const result = applyGlobalGates({
			id: "test-job",
			source: "unit-test",
			source_id: "unit-test-id",
			company_name: "Test Company",
			title: "Applied Scientist",
			raw_description: `${technicalResponsibilities} This is a hybrid role with office attendance expectations.`,
			location: "Singapore",
			workplace_type: "HYBRID",
			employment_type: "PERMANENT",
		} as any, policy);

		expect(result.status).toBe("NEEDS_VERIFICATION");
		expect(result.rejection_codes).toContain("NEEDS_VERIFICATION_OFFICE_DAYS");
	});

	it("uses the explicit unknown-work-mode policy instead of inventing evidence", () => {
		const base = {
			id: "test-job",
			source: "unit-test",
			source_id: "unit-test-id",
			company_name: "Test Company",
			title: "Applied Scientist",
			raw_description: technicalResponsibilities,
			location: "Singapore",
			workplace_type: "UNKNOWN",
			employment_type: "PERMANENT",
		};

		const accepted = applyGlobalGates(base as any, {
			...loadWorkabilityPolicy(),
			unknownWorkModeDisposition: "PASS",
		});
		const rejected = applyGlobalGates(base as any, {
			...loadWorkabilityPolicy(),
			unknownWorkModeDisposition: "HARD_REJECT",
		});

		expect(accepted.status).toBe("PASS");
		expect(rejected.status).toBe("HARD_REJECT");
		expect(rejected.rejection_codes).toContain("GATE_UNKNOWN_WORK_MODE");
	});

	it("rejects explicit foreign work territory but accepts unqualified remote", () => {
		const foreign = runGate({
			title: "Applied Scientist",
			description: `${technicalResponsibilities} Remote - United States only.`,
			location: "Remote - United States",
			workplace_type: "REMOTE",
		});
		const unqualified = runGate({
			title: "Applied Scientist",
			description: `${technicalResponsibilities} Remote role with no foreign territory restriction stated.`,
			location: "Remote",
			workplace_type: "REMOTE",
		});

		expect(foreign.status).toBe("HARD_REJECT");
		expect(foreign.rejection_codes).toContain("GATE_LOCATION_RESTRICTED");
		expect(unqualified.status).toBe("PASS");
	});

	it("rejects dotted foreign territory in a remote location label", () => {
		const result = runGate({
			title: "Applied Scientist",
			description: `${technicalResponsibilities} Location: 100% Remote (U.S.)`,
			location: "Remote",
			workplace_type: "REMOTE",
		});

		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("GATE_LOCATION_RESTRICTED");
	});

	it("recognizes country and city forms in explicit work-location evidence", () => {
		const remoteRomania = runGate({
			title: "Applied Scientist",
			description: `${technicalResponsibilities} Remote from Romania.`,
			location: "Remote from Romania",
			workplace_type: "REMOTE",
		});
		const london = runGate({
			title: "Applied Scientist",
			description: technicalResponsibilities,
			location: "London",
			workplace_type: "HYBRID",
		});

		expect(remoteRomania.status).toBe("HARD_REJECT");
		expect(remoteRomania.rejection_codes).toContain("GATE_LOCATION_RESTRICTED");
		expect(london.status).toBe("HARD_REJECT");
		expect(london.rejection_codes).toContain("GATE_LOCATION_RESTRICTED");
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

	it("allows contract roles when the resolved user policy permits contracts", () => {
		const policy: WorkabilityPolicy = {
			...loadWorkabilityPolicy(),
			contractAllowed: true,
		};
		const result = applyGlobalGates({
			id: "test-job",
			source: "unit-test",
			source_id: "unit-test-id",
			company_name: "Test Company",
			title: "Senior Data Engineer",
			raw_description: technicalResponsibilities,
			location: "Remote",
			workplace_type: "REMOTE",
			employment_type: "CONTRACT",
		} as any, policy);

		expect(result.status).toBe("PASS");
		expect(result.rejection_codes).not.toContain("GATE_CONTRACT_ROLE");
		expect(result.workability_facts.employment_type).toBe("CONTRACT");
	});

	it("enforces configured building, interaction, and travel ratios", () => {
		const buildingResult = runGate({
			title: "Technical Program Director",
			description: "Only 40% building and research; the remainder is stakeholder coordination for an AI data platform."
		});
		expect(buildingResult.rejection_codes).toContain("GATE_BUILDING_RESEARCH_RATIO");

		const interactionResult = runGate({
			title: "Data Platform Lead",
			description: "Build production data platforms with 60% client-facing interaction and 40% implementation."
		});
		expect(interactionResult.rejection_codes).toContain("GATE_HIGH_INTERACTION");

		const travelResult = runGate({
			title: "Machine Learning Engineer",
			description: "Build production ML systems with up to 25% travel."
		});
		expect(travelResult.rejection_codes).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
	});

	it("applies hard-reject precedence after an unknown workplace signal", () => {
		const result = runGate({
			title: "Forward Deployed AI Engineer",
			description: "Forward deployed engineering for customer sites; workplace arrangement to be evaluated.",
			workplace_type: "",
		});
		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("GATE_OUT_OF_SCOPE_DOMAIN");
	});

	it("rejects four office days from the configured workability policy", () => {
		const result = runGate({
			title: "Data Platform Engineer",
			description: "Build production data systems with 4 days per week in the office.",
			workplace_type: "HYBRID",
		});
		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("GATE_HIGH_OFFICE_DAYS");
	});

	it("enforces persisted structured workability requirements from the active policy", () => {
		const result = applyPersistedRequirementGates(
			{ title: "Machine Learning Engineer", company_name: "Example" },
			[
				{
					requirement_key: "travel",
					requirement_type: "TRAVEL",
					requirement_text: "Travel up to 11 percent",
					quote_text: null,
					structured_value: { max_travel_pct: 11 },
				},
			]
		);

		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("GATE_LIFESTYLE_INCOMPATIBLE");
	});

	it("uses configured authorized regions for work authorization requirements", () => {
		const foreign = applyPersistedRequirementGates(
			{ title: "Machine Learning Engineer", company_name: "Example" },
			[
				{
					requirement_key: "auth",
					requirement_type: "WORK_AUTH",
					requirement_text: "Must be authorized to work in the United States.",
					quote_text: null,
					structured_value: { jurisdiction: "United States" },
				},
			]
		);
		const unspecified = applyPersistedRequirementGates(
			{ title: "Machine Learning Engineer", company_name: "Example" },
			[
				{
					requirement_key: "auth",
					requirement_type: "WORK_AUTH",
					requirement_text: "Must be legally eligible to work.",
					quote_text: null,
					structured_value: null,
				},
			]
		);

		expect(foreign.status).toBe("HARD_REJECT");
		expect(foreign.rejection_codes).toContain("GATE_LOCATION_RESTRICTED");
		expect(unspecified.status).toBe("PASS");
	});

	it("applies injected user policy to persisted requirements", () => {
		const policy: WorkabilityPolicy = {
			...loadWorkabilityPolicy(),
			maxTravelPct: 25,
			contractAllowed: true,
		};

		const result = applyPersistedRequirementGates(
			{ title: "Machine Learning Engineer", company_name: "Example", employment_type: "CONTRACT" },
			[
				{
					requirement_key: "employment",
					requirement_type: "EMPLOYMENT_TYPE",
					requirement_text: "This is a 12 month contract role.",
					quote_text: null,
					structured_value: { employment_type: "CONTRACT" },
				},
				{
					requirement_key: "travel",
					requirement_type: "TRAVEL",
					requirement_text: "Travel up to 20 percent",
					quote_text: null,
					structured_value: { max_travel_pct: 20 },
				},
			],
			policy
		);

		expect(result.status).toBe("PASS");
		expect(result.rejection_codes).not.toContain("GATE_CONTRACT_ROLE");
		expect(result.rejection_codes).not.toContain("GATE_LIFESTYLE_INCOMPATIBLE");
	});

	it("does not hide a structured interaction conflict behind office verification", () => {
		const result = applyPersistedRequirementGates(
			{ title: "Technical Program Manager", company_name: "Example" },
			[
				{
					requirement_key: "office",
					requirement_type: "OFFICE_DAYS",
					requirement_text: "Hybrid workplace arrangement",
					quote_text: null,
					structured_value: null,
				},
				{
					requirement_key: "interaction",
					requirement_type: "CUSTOM",
					requirement_text: "Client interaction requirement",
					quote_text: null,
					structured_value: { interaction_pct: 60 },
				},
			]
		);

		expect(result.status).toBe("HARD_REJECT");
		expect(result.rejection_codes).toContain("GATE_HIGH_INTERACTION");
	});

	it("uses the job description when persisted requirements do not contain function evidence", () => {
		const result = applyPersistedRequirementGates(
			{
				title: "Project Manager",
				company_name: "Example",
				description: "Lead software development and data platform delivery across the transformation roadmap.",
			},
			[]
		);

		expect(result.status).toBe("PASS");
	});
});
