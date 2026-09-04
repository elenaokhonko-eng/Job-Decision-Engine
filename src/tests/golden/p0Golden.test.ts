import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { applyGlobalGates } from "../../services/criteria.js";
import { extractDeterministicRequirements } from "../../requirements/deterministicExtractors.js";

function loadYaml<T>(relativePath: string): T {
  const fullPath = path.resolve(process.cwd(), relativePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return yaml.load(raw) as T;
}

describe("P0 golden fixtures", () => {
  it("workability fixtures match gate outcomes", () => {
    const fixture = loadYaml<{
      schema_version: string;
      cases: Array<{
        case_id: string;
        job: {
          title: string;
          description: string;
          location: string;
          workplace_type: string;
          employment_type: string;
        };
        expected: {
          gate_status: "PASS" | "NEEDS_VERIFICATION" | "HARD_REJECT";
          rejection_codes_include?: string[];
        };
      }>;
    }>("src/tests/golden/workability.yml");

    expect(fixture.schema_version).toBe("2.2.0");

    for (const testCase of fixture.cases) {
      const result = applyGlobalGates({
        id: testCase.case_id,
        source: "golden",
        source_id: testCase.case_id,
        company_name: "Golden Fixture Co",
        title: testCase.job.title,
        raw_description: testCase.job.description,
        location: testCase.job.location,
        workplace_type: testCase.job.workplace_type,
        employment_type: testCase.job.employment_type,
      } as any);

      expect(result.status, testCase.case_id).toBe(testCase.expected.gate_status);
      for (const code of testCase.expected.rejection_codes_include || []) {
        expect(result.rejection_codes, `${testCase.case_id} missing ${code}`).toContain(code);
      }
    }
  });

  it("employment context fixtures avoid contract false positives", () => {
    const fixture = loadYaml<{
      schema_version: string;
      cases: Array<{
        case_id: string;
        description_text: string;
        expected: { extracted_employment_type: "FULL_TIME" | "PART_TIME" | "CONTRACT" | "UNKNOWN" };
      }>;
    }>("src/tests/golden/employment-context.yml");

    expect(fixture.schema_version).toBe("2.2.0");

    for (const testCase of fixture.cases) {
      const result = extractDeterministicRequirements({
        canonical_job_id: "11111111-1111-4111-8111-111111111111",
        job_version_id: "22222222-2222-4222-8222-222222222222",
        description_text: testCase.description_text,
      });

      const employmentReq = result.requirements.find((r) => r.requirement_type === "EMPLOYMENT_TYPE");
      expect(employmentReq, `${testCase.case_id} missing EMPLOYMENT_TYPE requirement`).toBeTruthy();
      expect((employmentReq as any)?.structured_value?.employment_type, testCase.case_id).toBe(
        testCase.expected.extracted_employment_type
      );
    }
  });
});

