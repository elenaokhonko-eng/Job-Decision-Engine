import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BOUNDARY_RULES,
  buildImportGraph,
  checkTableRegistry,
  compareWithBaseline,
  findGrownFiles,
  findStreamlitViolations,
  findViolations,
  listSourceFiles,
  listStreamlitFiles,
  pruneBaseline,
  statusColumnsWritten,
  tablesCreatedBy,
  tablesRead,
  tablesWritten,
  type Baseline,
  type SourceFile,
  type TableRegistry,
} from "../../architecture/boundaries.js";

const ROOT = path.resolve(__dirname, "../../..");
const BASELINE_PATH = path.join(ROOT, "src/architecture/boundary-baseline.json");
const REGISTRY_PATH = path.join(ROOT, "src/architecture/table-ownership.json");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");

/** A small registry for rule tests: two modules, one platform part and a legacy table. */
const SAMPLE_REGISTRY: TableRegistry = {
  note: "test",
  owners: {
    catalog: ["canonical_jobs"],
    decision: ["deterministic_decisions"],
    orchestration: ["pipeline_tasks"],
    legacy: ["raw_jobs"],
  },
};

function file(filePath: string, text = ""): SourceFile {
  return { path: filePath, text };
}

function violationsOf(files: SourceFile[], registry?: TableRegistry): string[] {
  return findViolations(buildImportGraph(files), registry);
}

describe("architecture boundary rules", () => {
  it("B1: contracts import nothing outside contracts", () => {
    const found = violationsOf([
      file("src/contracts/job.ts", 'import { x } from "../platform/config/index.js";'),
      file("src/platform/config/index.ts"),
    ]);
    expect(found).toContain("B1|src/contracts/job.ts|src/platform/config/index.ts");
  });

  it("B1: the platform never imports a domain module or an interface", () => {
    const found = violationsOf([
      file("src/platform/orchestration/queue.ts", 'import { decide } from "../../modules/decision/index.js";'),
      file("src/modules/decision/index.ts"),
    ]);
    expect(found).toContain("B1|src/platform/orchestration/queue.ts|src/modules/decision/index.ts");
  });

  it("B1: a module never imports an interface or an unshared legacy area", () => {
    const found = violationsOf([
      file(
        "src/modules/decision/handlers/decide.ts",
        'import { router } from "../../../api/v2/router.js";\nimport { gate } from "../../../pipeline/hardGate.js";\nimport type { Ctx } from "../../../workspace/context.js";',
      ),
      file("src/api/v2/router.ts"),
      file("src/pipeline/hardGate.ts"),
      file("src/workspace/context.ts"),
    ]);
    expect(found).toContain("B1|src/modules/decision/handlers/decide.ts|src/api/v2/router.ts");
    expect(found).toContain("B1|src/modules/decision/handlers/decide.ts|src/pipeline/hardGate.ts");
    expect(found.some((key) => key.includes("src/workspace/context.ts"))).toBe(false);
  });

  it("B2: another module is reached only through its index.ts", () => {
    const found = violationsOf([
      file("src/modules/decision/handlers/decide.ts", 'import { score } from "../../matching/domain/score.js";'),
      file("src/modules/matching/domain/score.ts"),
      file("src/modules/matching/index.ts"),
    ]);
    expect(found).toContain("B2|src/modules/decision/handlers/decide.ts|src/modules/matching/domain/score.ts");
  });

  it("B2: files inside one module may import each other freely", () => {
    const found = violationsOf([
      file("src/modules/matching/handlers/match.ts", 'import { score } from "../domain/score.js";'),
      file("src/modules/matching/domain/score.ts"),
    ]);
    expect(found).toEqual([]);
  });

  it("B3: a module imports only modules that come before it", () => {
    const allowed = violationsOf([
      file("src/modules/decision/handlers/decide.ts", 'import { score } from "../../matching/index.js";'),
      file("src/modules/matching/index.ts"),
    ]);
    expect(allowed).toEqual([]);

    const backward = violationsOf([
      file("src/modules/matching/handlers/match.ts", 'import { decide } from "../../decision/index.js";'),
      file("src/modules/decision/index.ts"),
    ]);
    expect(backward).toContain("B3|src/modules/matching/handlers/match.ts|src/modules/decision/index.ts");
  });

  it("B3: an unlisted module name is refused", () => {
    expect(violationsOf([file("src/modules/misc/index.ts")])).toContain("B3|src/modules/misc/index.ts|unknown module");
  });

  it("B4: pure domain code imports no infrastructure and reads no environment or clock", () => {
    const found = violationsOf([
      file(
        "src/modules/policy/domain/gate.ts",
        'import pg from "pg";\nimport { save } from "../../../platform/persistence/index.js";\nconst limit = process.env.LIMIT;\nconst now = Date.now();',
      ),
      file("src/platform/persistence/index.ts"),
    ]);
    expect(found).toContain("B4|src/modules/policy/domain/gate.ts|imports pg");
    expect(found).toContain("B4|src/modules/policy/domain/gate.ts|src/platform/persistence/index.ts");
    expect(found).toContain("B4|src/modules/policy/domain/gate.ts|reads process.env");
    expect(found).toContain("B4|src/modules/policy/domain/gate.ts|reads the clock");
  });

  it("B5: the model gateway never reaches the database", () => {
    const found = violationsOf([
      file("src/platform/llm/gateway.ts", 'import pg from "pg";\nimport { save } from "../persistence/index.js";'),
      file("src/platform/persistence/index.ts"),
    ]);
    expect(found).toContain("B5|src/platform/llm/gateway.ts|imports pg");
    expect(found).toContain("B5|src/platform/llm/gateway.ts|src/platform/persistence/index.ts");
  });

  it("B6: in the target layout only persistence imports the database driver", () => {
    const found = violationsOf([
      file("src/modules/catalog/handlers/normalize.ts", 'import pg from "pg";'),
      file("src/platform/persistence/pool.ts", 'import pg from "pg";'),
    ]);
    expect(found).toContain("B6|src/modules/catalog/handlers/normalize.ts|imports pg");
    expect(found.some((key) => key.includes("src/platform/persistence/pool.ts"))).toBe(false);
  });

  it("F1 and F2: import cycles and two-way area dependencies are reported", () => {
    const found = violationsOf([
      file("src/pipeline/a.ts", 'import { b } from "../services/b.js";'),
      file("src/services/b.ts", 'import { a } from "../pipeline/a.js";'),
    ]);
    expect(found).toContain("F1|src/pipeline/a.ts <-> src/services/b.ts");
    expect(found).toContain("F2|src/pipeline <-> src/services");
  });

  it("F3 to F5: scripts and API routers take no new database access; frozen files take no new importers", () => {
    const found = violationsOf([
      file("scripts/new_job.ts", 'import pg from "pg";\nimport { runAgent } from "../src/services/agent.js";'),
      file("src/services/agent.ts"),
    ]);
    expect(found).toContain("F3|scripts/new_job.ts|imports pg");
    expect(found).toContain("F4|scripts/new_job.ts|src/services/agent.ts");
    expect(found).toContain("F5|src/services/agent.ts");
  });

  it("F6: a writer of a job status column is reported per column", () => {
    const text = "await client.query(`UPDATE canonical_jobs SET recommendation_outcome = $1, updated_at = NOW() WHERE id = $2`);";
    expect(statusColumnsWritten(text)).toEqual(["recommendation_outcome"]);
    expect(statusColumnsWritten("SELECT 1 FROM canonical_jobs WHERE processing_state = 'MATCHED'")).toEqual([]);
    expect(violationsOf([file("src/pipeline/x.ts", text)])).toContain("F6|recommendation_outcome|src/pipeline/x.ts");
  });

  it("B2 and B7: a repository is reached through its index.ts, and only by its owner or the composition root", () => {
    const found = violationsOf([
      file("src/modules/decision/handlers/decide.ts", 'import { save } from "../../../platform/persistence/decision/index.js";'),
      file("src/platform/orchestration/queue.ts", 'import { claim } from "../persistence/orchestration/index.js";'),
      file("src/app/wiring.ts", 'import { save } from "../platform/persistence/decision/index.js";'),
      file("src/modules/evaluation/handlers/evaluate.ts", 'import { save } from "../../../platform/persistence/decision/index.js";'),
      file("src/modules/decision/handlers/rank.ts", 'import { sql } from "../../../platform/persistence/decision/queries.js";'),
      file("scripts/fix_outcomes.ts", 'import { save } from "../src/platform/persistence/decision/index.js";'),
      file("src/platform/persistence/index.ts", 'export * from "./decision/index.js";'),
      file("src/platform/persistence/decision/index.ts", 'import { sql } from "./queries.js";'),
      file("src/platform/persistence/decision/queries.ts"),
      file("src/platform/persistence/orchestration/index.ts"),
    ]);
    expect(found).toEqual([
      "B2|src/modules/decision/handlers/rank.ts|src/platform/persistence/decision/queries.ts",
      "B7|scripts/fix_outcomes.ts|src/platform/persistence/decision/index.ts",
      "B7|src/modules/evaluation/handlers/evaluate.ts|src/platform/persistence/decision/index.ts",
      "B7|src/platform/persistence/index.ts|src/platform/persistence/decision/index.ts",
    ]);
  });

  it("B7: a repository folder is named after a module or a platform part", () => {
    const found = violationsOf([file("src/platform/persistence/misc/index.ts"), file("src/platform/persistence/legacy/index.ts")]);
    expect(found).toEqual([
      "B7|src/platform/persistence/legacy/index.ts|unknown repository owner",
      "B7|src/platform/persistence/misc/index.ts|unknown repository owner",
    ]);
  });

  it("B8: in the target layout SQL lives in persistence", () => {
    const found = violationsOf(
      [
        file("src/modules/decision/handlers/decide.ts", "const sql = `SELECT id FROM canonical_jobs WHERE id = $1`;"),
        file("src/interfaces/http/jobs.ts", "const sql = `UPDATE canonical_jobs SET title = $1`;"),
        file("src/modules/decision/domain/rules.ts", "// Decisions are read from canonical_jobs by the repository."),
        file("src/modules/applications/handlers/list.ts", "const sql = `SELECT * FROM v_job_status_buckets_scoped`;"),
        file("src/platform/persistence/applications/index.ts", "const sql = `SELECT * FROM v_job_status_buckets_scoped`;"),
      ],
      SAMPLE_REGISTRY,
    );
    expect(found).toEqual([
      "B8|src/interfaces/http/jobs.ts|SQL outside persistence",
      "B8|src/modules/applications/handlers/list.ts|SQL outside persistence",
      "B8|src/modules/decision/handlers/decide.ts|SQL outside persistence",
    ]);
  });

  it("B8: a repository writes only its owner's tables and reads only downward", () => {
    const allowed = violationsOf(
      [
        file(
          "src/platform/persistence/decision/index.ts",
          "const a = `INSERT INTO deterministic_decisions (id) VALUES ($1)`;\n" +
            "const b = `SELECT 1 FROM deterministic_decisions d JOIN canonical_jobs c ON c.id = d.job_id JOIN pipeline_tasks t ON t.job_id = c.id`;\n" +
            "const c = `DELETE FROM deterministic_decisions WHERE id = $1`;",
        ),
      ],
      SAMPLE_REGISTRY,
    );
    expect(allowed).toEqual([]);

    const refused = violationsOf(
      [
        file("src/platform/persistence/decision/index.ts", "const a = `UPDATE canonical_jobs SET title = $1`;\nconst b = `SELECT 1 FROM raw_jobs`;"),
        file("src/platform/persistence/catalog/index.ts", "const a = `SELECT 1 FROM deterministic_decisions`;"),
        file("src/platform/persistence/orchestration/index.ts", "const a = `SELECT 1 FROM canonical_jobs`;"),
        file("src/platform/persistence/pool.ts", "const a = `SELECT 1 FROM pipeline_tasks`;"),
      ],
      SAMPLE_REGISTRY,
    );
    expect(refused).toEqual([
      "B8|src/platform/persistence/catalog/index.ts|reads deterministic_decisions owned by decision",
      "B8|src/platform/persistence/decision/index.ts|reads raw_jobs owned by legacy",
      "B8|src/platform/persistence/decision/index.ts|writes canonical_jobs owned by catalog",
      "B8|src/platform/persistence/orchestration/index.ts|reads canonical_jobs owned by catalog",
      "B8|src/platform/persistence/pool.ts|reads pipeline_tasks owned by orchestration",
    ]);
  });

  it("F9: the database layer and the stage logic import nothing above them", () => {
    const found = violationsOf([
      file("src/db/pool.ts", 'import { gate } from "../pipeline/hardGate.js";\nimport type { Ctx } from "../workspace/context.js";'),
      file("src/pipeline/hardGate.ts", 'import { enqueue } from "../tasks/pipelineTasks.js";\nimport { load } from "../policy/snapshot.js";'),
      file("src/tasks/pipelineTasks.ts"),
      file("src/policy/snapshot.ts"),
      file("src/workspace/context.ts"),
    ]);
    expect(found.filter((key) => key.startsWith("F9|"))).toEqual([
      "F9|src/db/pool.ts|src/pipeline/hardGate.ts",
      "F9|src/pipeline/hardGate.ts|src/tasks/pipelineTasks.ts",
    ]);
  });

  it("F10 and F11: model-call resilience stays free of job and database code; src never imports a script", () => {
    const found = violationsOf([
      file(
        "src/services/modelCallResilience.ts",
        'import pg from "pg";\nimport { ssl } from "../db/pgSsl.js";\nimport { summary } from "../security/publicErrorSummary.js";',
      ),
      file("src/db/pgSsl.ts"),
      file("src/security/publicErrorSummary.ts"),
      file("src/reporting/board.ts", 'import { run } from "../../scripts/report.js";'),
      file("scripts/report.ts"),
    ]);
    expect(found.filter((key) => /^F1[01]\|/.test(key))).toEqual([
      "F10|src/services/modelCallResilience.ts|imports pg",
      "F10|src/services/modelCallResilience.ts|src/db/pgSsl.ts",
      "F11|src/reporting/board.ts|scripts/report.ts",
    ]);
  });

  it("F7: a legacy area that writes a table is reported per table and area", () => {
    const found = violationsOf(
      [
        file("src/pipeline/x.ts", "const a = `INSERT INTO deterministic_decisions (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1`;"),
        file("src/pipeline/y.ts", "const a = `SELECT 1 FROM canonical_jobs FOR UPDATE SKIP LOCKED`;"),
        file("scripts/fix.ts", "const a = `DELETE FROM pipeline_tasks WHERE id = $1`;\n// Update canonical_jobs afterwards."),
        file("server.ts", "const a = `UPDATE ONLY raw_jobs SET title = $1`;"),
      ],
      SAMPLE_REGISTRY,
    );
    expect(found).toEqual(["F7|deterministic_decisions|src/pipeline", "F7|pipeline_tasks|scripts", "F7|raw_jobs|server.ts"]);
  });

  it("F8: the Streamlit interface is reported for every table it reads or writes", () => {
    const found = findStreamlitViolations(
      [
        file("streamlit_app.py", 'rows = run("SELECT * FROM v_job_status_buckets_scoped")\nmore = run("SELECT 1 FROM canonical_jobs")'),
        file("streamlit_archive.py", 'run("DELETE FROM canonical_jobs WHERE id = %s")'),
      ],
      SAMPLE_REGISTRY,
    );
    expect(found).toEqual(["F8|streamlit_app.py|reads canonical_jobs", "F8|streamlit_archive.py|writes canonical_jobs"]);
  });

  it("recognises reads and writes by upper-case SQL keywords and registered table names", () => {
    const tables = new Set(["canonical_jobs", "raw_jobs"]);
    expect(tablesWritten("INSERT INTO public.canonical_jobs (id) VALUES (1); UPDATE other SET a = 1", tables)).toEqual(["canonical_jobs"]);
    expect(tablesRead("SELECT 1 FROM ONLY canonical_jobs c LEFT JOIN raw_jobs r ON true", tables)).toEqual(["canonical_jobs", "raw_jobs"]);
    expect(tablesRead("DELETE FROM raw_jobs", tables)).toEqual([]);
    expect(tablesRead("results from canonical_jobs are cached", tables)).toEqual([]);
  });

  it("every table needs exactly one known owner", () => {
    const tables = tablesCreatedBy([
      "CREATE TABLE IF NOT EXISTS canonical_jobs (id uuid);\n-- CREATE TABLE commented_out (id uuid);\nCREATE TABLE new_table (id uuid);",
    ]);
    expect(tables).toEqual(["canonical_jobs", "new_table"]);
    const problems = checkTableRegistry(tables, {
      note: "test",
      owners: { catalog: ["canonical_jobs"], decision: ["canonical_jobs", "gone_table"], misc: [] },
    });
    expect(problems).toEqual([
      'owner "misc" is not a module, a platform part or "legacy"',
      "table canonical_jobs has two owners: catalog and decision",
      "table gone_table (owner decision) is not created by any migration",
      "table new_table has no owner in src/architecture/table-ownership.json",
    ]);
  });

  it("a baseline can be pruned but never grows", () => {
    const files = [file("src/services/agent.ts", "a\nb")];
    const baseline: Baseline = { note: "n", limits: { "src/services/agent.ts": 10, "gone.ts": 5 }, violations: ["F5|src/services/agent.ts", "F5|gone.ts"] };
    const pruned = pruneBaseline(baseline, ["F5|src/services/agent.ts", "F5|src/services/new.ts"], files);
    expect(pruned.violations).toEqual(["F5|src/services/agent.ts"]);
    expect(pruned.limits).toEqual({ "src/services/agent.ts": 2 });
  });
});

describe("repository architecture boundaries", () => {
  const files = listSourceFiles(ROOT);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as TableRegistry;
  const current = [
    ...findViolations(buildImportGraph(files), registry),
    ...findStreamlitViolations(listStreamlitFiles(ROOT), registry),
  ].sort();
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;

  if (process.env.ARCH_BASELINE === "prune") {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(pruneBaseline(baseline, current, files), null, 2)}\n`);
  }
  const effective = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const comparison = compareWithBaseline(current, effective);

  it("adds no boundary violation beyond the recorded baseline", () => {
    expect(
      comparison.added,
      "New architecture boundary violations. Fix the code (see docs/architecture.md, Boundary rules). " +
        "An exception needs a hand edit of src/architecture/boundary-baseline.json and a reason in the pull request.",
    ).toEqual([]);
  });

  it("keeps the baseline exact: resolved violations are pruned", () => {
    expect(
      comparison.resolved,
      "These recorded violations no longer occur. Run: ARCH_BASELINE=prune npx vitest run src/tests/architecture/boundaries.test.ts",
    ).toEqual([]);
  });

  it("reports only rules that are defined", () => {
    const unknown = [...new Set(current.map((key) => key.split("|")[0]!))].filter((rule) => !(rule in BOUNDARY_RULES));
    expect(unknown).toEqual([]);
  });

  it("does not let frozen files grow", () => {
    expect(findGrownFiles(files, effective.limits), "Frozen files may only shrink (see docs/architecture.md).").toEqual([]);
  });

  it("gives every table exactly one owner", () => {
    const migrations = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
    expect(
      checkTableRegistry(tablesCreatedBy(migrations), registry),
      "A migration that creates a table must name its owner in src/architecture/table-ownership.json (see docs/architecture.md, Data ownership).",
    ).toEqual([]);
  });
});
