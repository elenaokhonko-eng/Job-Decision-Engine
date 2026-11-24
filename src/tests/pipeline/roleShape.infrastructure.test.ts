import { describe, expect, it } from "vitest";

import { assessRoleShape } from "../../pipeline/roleShape.js";

// Synthetic titles and sentences only.
describe("role shape: infrastructure by description", () => {
  it("flags four different infrastructure cues in the description", () => {
    const description = "You will run Kubernetes clusters, write Terraform, join the on-call rotation and own CI/CD for the platform.";
    const result = assessRoleShape({ title: "Platform Engineer", description });
    expect(result.signals.map((s) => s.code)).toEqual(["INFRASTRUCTURE_BY_DESCRIPTION"]);
    expect(result.signals[0]!.source).toBe("DESCRIPTION");
  });

  it("does not flag one or three cues", () => {
    expect(assessRoleShape({ title: "ML Engineer", description: "You will deploy models on Kubernetes." }).signals).toEqual([]);
    expect(assessRoleShape({ title: "ML Engineer", description: "Kubernetes, Terraform and CI/CD are used by the team." }).signals).toEqual([]);
  });

  it("is a downrank: the combined penalty never exceeds the cap", () => {
    const description = "Kubernetes Terraform Ansible on-call CI/CD DevOps observability. Customer-facing client implementations and post-sales.";
    const result = assessRoleShape({ title: "Forward Deployed Engineer", description });
    expect(result.signals.length).toBeGreaterThan(1);
    expect(result.total_penalty).toBeLessThanOrEqual(0.15);
  });
});
