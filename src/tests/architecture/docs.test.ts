import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BOUNDARY_RULES,
  JOB_STATUS_COLUMNS,
  MODULE_ORDER,
  PLATFORM_PARTS,
  type TableRegistry,
} from "../../architecture/boundaries.js";

/**
 * Keeps docs/architecture.md in step with the code. The document once named four lanes when
 * the code had eight; these tests fail instead of letting that happen again.
 */
const ROOT = path.resolve(__dirname, "../../..");
const ARCHITECTURE = "docs/architecture.md";
const ADR_DIR = "docs/adr";
/** Documents whose links and repository paths must resolve. */
const CHECKED_DOCUMENTS = [ARCHITECTURE, "docs/delivery-plan.md", "AGENTS.md", "README.md", "CONTRIBUTING.md", `${ADR_DIR}/README.md`];
/** Folders of the target layout. Paths under them are plans until code moves there. */
const TARGET_LAYOUT = ["src/modules/", "src/platform/", "src/interfaces/", "src/app/"];
const PATH_ROOTS = ["src", "scripts", "config", "migrations", "docs", "desktop", "tests", ".agents", ".github"];

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/** Upper-case names in the quoted list that follows `marker` and ends at the next `]`. */
function namesAfter(file: string, marker: string): string[] {
  const text = read(file);
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`"${marker}" was not found in ${file}. Update this test to the new location of the list.`);
  const end = text.indexOf("]", start + marker.length);
  return [...text.slice(start + marker.length, end).matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)].map((match) => match[1]!);
}

/** The text of one `## ` section, chosen by the words in its heading. */
function section(text: string, heading: string): string {
  const parts = text.split(/\n(?=## )/);
  const found = parts.find((part) => part.split("\n")[0]!.includes(heading));
  if (!found) throw new Error(`Section "${heading}" was not found in ${ARCHITECTURE}.`);
  return found;
}

function missingFrom(text: string, names: readonly string[]): string[] {
  return names.filter((name) => !text.includes(`\`${name}\``));
}

function adrFiles(): string[] {
  return fs
    .readdirSync(path.join(ROOT, ADR_DIR))
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort();
}

describe("docs/architecture.md matches the code", () => {
  const document = read(ARCHITECTURE);

  it("lists exactly the lanes in config/lanes/registry.yml", () => {
    const lanes = [...read("config/lanes/registry.yml").matchAll(/lane_key:\s*([A-Z][A-Z0-9_]+)/g)].map((match) => match[1]!);
    expect(lanes.length).toBeGreaterThan(0);
    const documented = [...section(document, "Lanes").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1]!);
    expect(documented.sort()).toEqual([...lanes].sort());
  });

  it("names every pipeline task type", () => {
    const taskTypes = namesAfter("src/tasks/stageTaskWorker.ts", "PIPELINE_STAGE_TASK_TYPES = [");
    expect(taskTypes.length).toBeGreaterThan(0);
    expect(missingFrom(section(document, "Pipeline stages"), taskTypes)).toEqual([]);
  });

  it("names every job state, status bucket and job status column", () => {
    const states = namesAfter("src/contracts/index.ts", "processing_state: z.enum([");
    const buckets = namesAfter("src/contracts/jobStatus.ts", "JobStatusBucketSchema = z.enum([");
    expect(states.length).toBeGreaterThan(0);
    expect(buckets.length).toBeGreaterThan(0);
    const statusSection = section(document, "Job states, decisions and status");
    expect(missingFrom(statusSection, states)).toEqual([]);
    expect(missingFrom(statusSection, buckets)).toEqual([]);
    expect(missingFrom(section(document, "Data ownership"), JOB_STATUS_COLUMNS)).toEqual([]);
  });

  it("names every module, platform part, table owner and boundary rule", () => {
    const registry = JSON.parse(read("src/architecture/table-ownership.json")) as TableRegistry;
    expect(missingFrom(section(document, "Domain modules"), MODULE_ORDER)).toEqual([]);
    expect(missingFrom(section(document, "Platform parts"), PLATFORM_PARTS)).toEqual([]);
    expect(missingFrom(document, Object.keys(registry.owners))).toEqual([]);
    const rules = section(document, "Boundary rules");
    expect(Object.keys(BOUNDARY_RULES).filter((rule) => !new RegExp(`\\| ${rule} \\|`).test(rules))).toEqual([]);
  });

  it("lists the modules in dependency order", () => {
    const rows = [...section(document, "Domain modules").matchAll(/^\| \d+ \| `([a-z]+)` \|/gm)].map((match) => match[1]!);
    expect(rows).toEqual([...MODULE_ORDER]);
  });
});

describe("documentation links and paths resolve", () => {
  const documents = [...CHECKED_DOCUMENTS, ...adrFiles().map((name) => `${ADR_DIR}/${name}`)];

  it.each(documents)("%s links only to files that exist", (file) => {
    const text = read(file);
    const broken: string[] = [];
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!.split("#")[0]!;
      if (target === "" || /^[a-z]+:/i.test(target)) continue;
      const resolved = path.join(ROOT, path.dirname(file), target);
      if (!fs.existsSync(resolved)) broken.push(match[1]!);
    }
    expect(broken).toEqual([]);
  });

  it.each(documents)("%s names only repository paths that exist", (file) => {
    const text = read(file);
    const missing = new Set<string>();
    for (const match of text.matchAll(/`([^`\s]+)`/g)) {
      const token = match[1]!;
      if (!PATH_ROOTS.some((root) => token.startsWith(`${root}/`))) continue;
      if (/[<>*{}$]|NNNN/.test(token)) continue;
      if (TARGET_LAYOUT.some((prefix) => token.startsWith(prefix))) continue;
      if (!fs.existsSync(path.join(ROOT, token))) missing.add(token);
    }
    expect([...missing].sort()).toEqual([]);
  });

  it("indexes every decision record", () => {
    const index = read(`${ADR_DIR}/README.md`);
    expect(adrFiles().filter((name) => !index.includes(`(${name})`))).toEqual([]);
  });
});
