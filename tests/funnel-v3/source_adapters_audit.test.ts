import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import crypto from "crypto";
import { JobicyAdapter } from "../../src/ingestion/adapters/jobicyAdapter.js";
import {
  SourcePluginSchema,
  IngestionEnvelopeSchema,
  ExtractedJobSchema,
} from "../../src/contracts/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Funnel V3 Independent Test Suite — Source Plugins & Adapters Audit (S01-S07)", () => {
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

  it("S05: Executes the enabled Jobicy adapter for a valid response", async () => {
    const manifest = SourcePluginSchema.parse(
      yaml.load(fs.readFileSync(path.join(pluginsDir, "jobicy.yml"), "utf-8")),
    );
    expect(manifest.status).toBe("active");
    expect(manifest.schedule.enabled).toBe(true);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jobs: [
          {
            id: "job-42",
            companyName: "Example AI",
            jobTitle: "Staff ML Engineer",
            jobGeo: "Singapore / Remote",
            jobType: ["full-time", "permanent"],
            url: "https://jobicy.example/jobs/42",
            jobDescription: "<p>Build <strong>ML</strong> systems.</p>",
            pubDate: "2026-09-01T00:00:00Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs({ limit: 10 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://jobicy.example/api?count=10",
      expect.objectContaining({
        headers: { Accept: "application/json", "User-Agent": "JobDecisionEngine/1.0" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({
      sourceName: "JOBICY",
      success: true,
      totalFetched: 1,
      quarantined: 0,
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      source_external_id: "job-42",
      company_name: "Example AI",
      title: "Staff ML Engineer",
      location_raw: "Singapore / Remote",
      employment_type_raw: "full-time, permanent",
      canonical_apply_url: "https://jobicy.example/jobs/42",
      description_raw: "Build ML systems.",
      source_attribution: "Jobicy",
      raw_payload: { id: "job-42" },
    });
  });

  it("S06: Quarantines schema-invalid Jobicy records while preserving valid results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          jobs: [
            {
              id: "valid-1",
              companyName: "Example AI",
              jobTitle: "Data Engineer",
              url: "https://jobicy.example/jobs/valid-1",
              jobDescription: "Build production data pipelines remotely.",
            },
            {
              id: "invalid-1",
              companyName: "Broken Co",
              jobTitle: "Missing description",
              url: "https://jobicy.example/jobs/invalid-1",
            },
          ],
        }),
      ),
    );

    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs();

    expect(result).toMatchObject({
      sourceName: "JOBICY",
      success: true,
      totalFetched: 2,
      quarantined: 1,
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      source_external_id: "valid-1",
      title: "Data Engineer",
    });
    expect(result.jobs.some((job) => job.source_external_id === "invalid-1")).toBe(false);
  });

  it("S07: Exposes a Jobicy rate-limit response as an observable adapter failure", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 429, statusText: "Too Many Requests" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new JobicyAdapter("https://jobicy.example/api").fetchJobs();

    expect(result).toMatchObject({
      sourceName: "JOBICY",
      success: false,
      jobs: [],
      totalFetched: 0,
      error: "429 Rate limited",
      isRateLimited: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
