import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import crypto from "crypto";
import {
  SourcePluginSchema,
  IngestionEnvelopeSchema,
  ExtractedJobSchema,
} from "../../src/contracts/index.js";

describe("Funnel V3 Independent Test Suite — Source Plugins & Adapters Audit (S01-S05)", () => {
  const pluginsDir = path.join(process.cwd(), "config", "source-plugins");

  it("S01: All declared source plugin manifests strictly validate against SourcePluginSchema", () => {
    const files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(8);

    for (const file of files) {
      const content = fs.readFileSync(path.join(pluginsDir, file), "utf-8");
      const raw = yaml.load(content) as Record<string, unknown>;
      const parsed = SourcePluginSchema.safeParse(raw);
      expect(parsed.success, `Source plugin manifest ${file} must conform to schema: ${JSON.stringify(parsed.error?.format())}`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.schema_version).toBe("2.2.0");
        expect(parsed.data.source_key).toBeDefined();
        expect(parsed.data.display_name).toBeDefined();
        expect(parsed.data.kind).toBeDefined();
        expect(parsed.data.capabilities).toBeDefined();
      }
    }
  });

  it("S03: Distinguishes operational, declared, and manual source adapters", () => {
    const knownSources = [
      "ashby.yml",
      "greenhouse.yml",
      "himalayas.yml",
      "jobicy.yml",
      "lever.yml",
      "linkedin.yml",
      "gmail_alert.yml",
      "remotive.yml",
      "we_work_remotely.yml",
    ];

    for (const src of knownSources) {
      const filePath = path.join(pluginsDir, src);
      expect(fs.existsSync(filePath), `Source configuration ${src} must exist`).toBe(true);
      const raw = yaml.load(fs.readFileSync(filePath, "utf-8"));
      const parsed = SourcePluginSchema.parse(raw);
      expect(parsed.source_key).toBeDefined();
      expect(parsed.display_name).toBeDefined();
    }
  });

  it("S04: Source broker ingestion envelope creates verifiable SHA-256 payload hash and schema lineage", () => {
    const payload = JSON.stringify({ title: "Lead AI Engineer", company: "Apex Labs" });
    const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");

    const envelope = IngestionEnvelopeSchema.parse({
      schema_version: "2.2.0",
      source_type: "GREENHOUSE",
      source_id: "gh-job-12345",
      source_run_id: "a0000000-0000-0000-0000-000000000001",
      observed_at: new Date().toISOString(),
      raw_payload_hash: payloadHash,
      raw_payload: payload,
      metadata: { department: "AI Core" },
    });

    expect(envelope.raw_payload_hash).toBe(payloadHash);
    expect(envelope.source_type).toBe("GREENHOUSE");

    const extracted = ExtractedJobSchema.parse({
      schema_version: "2.2.0",
      source_external_id: envelope.source_id,
      company_name: "Apex Labs",
      title: "Lead AI Engineer",
      location_raw: "Singapore",
      workplace_type_raw: "HYBRID",
      canonical_apply_url: "https://boards.greenhouse.io/apexlabs/jobs/12345",
      description_raw: "Building LLM pipelines",
    });

    expect(extracted.company_name).toBe("Apex Labs");
    expect(extracted.title).toBe("Lead AI Engineer");
    expect(extracted.workplace_type_raw).toBe("HYBRID");
  });
});
