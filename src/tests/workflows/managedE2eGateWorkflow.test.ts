import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("managed API/desktop E2E retest workflow", () => {
  it("uses deployment secrets and the fail-closed gate without starting evaluation", () => {
    const workflow = readFileSync(resolve(".github/workflows/managed_e2e_gate.yml"), "utf8");

    expect(workflow).toContain("JDEC_API_BASE_URL: ${{ secrets.JDEC_API_BASE_URL }}");
    expect(workflow).toContain("JDEC_API_TOKEN: ${{ secrets.JDEC_API_TOKEN }}");
    expect(workflow).toContain("WORKSPACE_KEY: ${{ secrets.WORKSPACE_KEY }}");
    expect(workflow).toContain("WORKSPACE_USER_KEY: ${{ secrets.WORKSPACE_USER_KEY }}");
    expect(workflow).toContain("npm run e2e:retest-gate");
    expect(workflow).toContain("npm run desktop:verify");
    expect(workflow).not.toContain("evaluate_queue");
    expect(workflow).not.toContain("eval:run");
  });
});
