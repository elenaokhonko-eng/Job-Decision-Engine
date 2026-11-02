import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

import { createManualApplicationRouter, loadManualProfileEvidence } from "../../api/v2/manualApplicationRouter.js";
import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { importLoadedProfile } from "../../profile/importer.js";
import { loadProfile } from "../../profile/loader.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
const routerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../api/v2/manualApplicationRouter.ts");

// loadCurrentInputs is private, so its job query is read from the router source.
function currentInputsJobQuery(): string {
  const query = /const jobResult = await client\.query<JobRow>\(\s*`([\s\S]*?)`/.exec(readFileSync(routerPath, "utf8"))?.[1];
  if (!query) throw new Error("manualApplicationRouter.ts current-inputs job query was not found.");
  return query;
}

let pool: pg.Pool | undefined;
let server: Server | undefined;
let baseUrl = "";
let schemaName = "";
let context: WorkspaceContext | undefined;

describe.skipIf(skipReal)("manual application router (PostgreSQL)", () => {
  beforeAll(async () => {
    schemaName = `manual_router_${crypto.randomUUID().replaceAll("-", "")}`;
    pool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public` });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    const client = await pool.connect();
    try {
      await runMigrations(client);
      context = await resolveWorkspaceContext(client);
    } finally {
      client.release();
    }
    const workspace = context;
    const app = express();
    app.use(createManualApplicationRouter({ pool, resolveContext: () => workspace }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (pool && schemaName) await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
    await pool?.end();
    pool = undefined;
  });

  it("reads readiness columns from a view that exposes them", async () => {
    if (!pool || !context) throw new Error("The manual router test pool is not initialized.");
    const result = await pool.query(currentInputsJobQuery(), [
      context.workspaceId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      "a".repeat(64),
    ]);
    const columns = result.fields.map((field) => field.name);

    expect(columns).toEqual(expect.arrayContaining(["readiness_status", "readiness_reason_codes", "recommendation_outcome"]));
  });

  it("offers past-role facts as evidence, linked to their engagement, with plain dates", async () => {
    if (!pool || !context) throw new Error("The manual router test pool is not initialized.");
    const profileDir = mkdtempSync(path.join(tmpdir(), "manual-evidence-profile-"));
    const write = (name: string, body: object) =>
      writeFileSync(path.join(profileDir, name), JSON.stringify({ schema_version: "2.0", profile_key: "manual_evidence_it", ...body }));
    const engagement = (key: string, role: string, start: string, end: string | null) => ({
      engagement_key: key, organization_legal_name: "Example Org", role_title: role, engagement_type: "EMPLOYEE",
      experience_class: "PROFESSIONAL_PRODUCTION", start_date: start, ...(end ? { end_date: end } : {}), is_current: end === null,
      summary: `${role} engagement summary.`, verification_status: "SELF_ATTESTED",
    });
    const fact = (key: string, engagementKey: string, statement: string, isCurrent: boolean, extra: object = {}) => ({
      fact_key: key, engagement_key: engagementKey, fact_type: "ACHIEVEMENT", statement, evidence_tier: "PROFESSIONAL_PRODUCTION",
      verification_status: "SELF_ATTESTED", is_current: isCurrent, confidentiality: "PUBLIC", ...extra,
    });
    try {
      write("profile.json", { profile_version: 1, display_name: "Evidence Candidate", status: "ACTIVE" });
      write("engagements.json", { engagements: [
        engagement("eng.current", "Current Architect", "2024-01-01", null),
        engagement("eng.past", "Past Program Lead", "2015-03-01", "2019-06-30"),
      ] });
      write("facts.json", { facts: [
        fact("fact.current.platform", "eng.current", "Designs the current agentic platform architecture.", true),
        fact("fact.past.derivatives", "eng.past", "Led the derivatives operating model programme.", false),
        { fact_key: "contact_phone", fact_type: "CONTACT", statement: "Phone number for application documents.",
          structured_value: { kind: "phone", value: "+65 6000 0000" }, evidence_tier: "KNOWLEDGE_ONLY",
          verification_status: "SELF_ATTESTED", is_current: true, confidentiality: "PRIVATE_INTERNAL" },
      ] });
      write("credentials.json", { credentials: [] });
      const summary = await importLoadedProfile(await loadProfile(profileDir), [], pool, { context });

      const evidence = await loadManualProfileEvidence(pool, context.workspaceId, summary.profileVersionId);
      const pastRole = evidence.find((item) => item.evidence_type === "ENGAGEMENT" && item.label === "Past Program Lead at Example Org");
      const pastFact = evidence.find((item) => item.statement === "Led the derivatives operating model programme.");

      expect(pastRole?.statement).toContain("(2015-03-01–2019-06-30)");
      expect(pastFact).toMatchObject({ evidence_type: "FACT", engagement_id: pastRole?.id });
      expect(evidence.some((item) => item.statement === "Designs the current agentic platform architecture.")).toBe(true);
      expect(evidence.some((item) => item.statement.includes("+65 6000 0000"))).toBe(false);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("checks download membership without a read-only transaction error", async () => {
    const response = await fetch(`${baseUrl}/${crypto.randomUUID()}/documents/CV/DOCX`);
    const body = await response.json() as { error?: { code?: string } | string };

    expect(response.status).toBe(404);
    expect(JSON.stringify(body)).toContain("NOT_FOUND");
  });
});
