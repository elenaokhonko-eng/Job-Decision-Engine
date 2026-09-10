import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("pipeline reconciliation safety", () => {
  it("is explicitly read-only and reports current artifact predicates", () => {
    const script = readFileSync(resolve("scripts/reconcile_pipeline.ts"), "utf8");

    expect(script).toContain('mode: "read_only"');
    expect(script).toContain("mr.profile_version_id = $2");
    expect(script).toContain("mr.requirement_set_id = lv.active_requirement_set_id");
    expect(script).toContain("mr.job_content_hash = lv.content_hash");
    expect(script).toContain("mr.canonical_job_id = c.id");
    expect(script).toContain("dd.canonical_job_id = c.id");
    expect(script).toContain("evaluation_queue_states");
    expect(script).toContain("current_evaluation_queue");
    expect(script).toContain("stale_evaluation_queue");
    expect(script).toContain("context_fingerprint IS NOT NULL");
    expect(script).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});
