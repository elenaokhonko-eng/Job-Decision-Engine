import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { LaneFileConfigSchema } from "../../lanes/contracts.js";
import { EvidenceSourceInputSchema } from "../../profile/evidenceValidator.js";

const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("templates/", () => {
  it("the lane template is a valid lane file once copied", () => {
    const parsed = load(fs.readFileSync(path.join(ROOT, "templates/lanes/lane.template.yml"), "utf8"));
    expect(() => LaneFileConfigSchema.parse(parsed)).not.toThrow();
  });

  it("every entry of the profile template is a valid evidence source and holds only placeholders", () => {
    const raw = fs.readFileSync(path.join(ROOT, "templates/profile/evidence_sources.template.json"), "utf8");
    const entries = JSON.parse(raw) as unknown[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(() => EvidenceSourceInputSchema.parse(entry)).not.toThrow();
    // A template is shared in the repository: no URL, no email address, no phone number.
    expect(raw).not.toMatch(/https?:\/\//i);
    expect(raw).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(raw).not.toMatch(/\+\d[\d ()-]{7,}\d/);
  });
});
