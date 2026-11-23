/**
 * Architecture boundary checks (see docs/architecture.md, "Boundary rules").
 *
 * The rules are plain data and pure functions so they can be tested with virtual files.
 * `src/tests/architecture/boundaries.test.ts` runs them against the repository and compares
 * the result with `boundary-baseline.json`: violations recorded there are known debt, anything
 * else fails the build. The baseline may only shrink (`ARCH_BASELINE=prune`); adding an entry
 * is a hand edit that a reviewer can see.
 *
 * Table ownership comes from `table-ownership.json`. SQL is recognised by upper-case keywords
 * followed by a registered table name, which is how every statement in this repository is
 * written. A statement that builds its table name at run time is not seen.
 */
import fs from "node:fs";
import path from "node:path";

/** Domain modules in dependency order: a module may import only modules listed before it. */
export const MODULE_ORDER = [
  "sourcing",
  "catalog",
  "requirements",
  "profile",
  "policy",
  "matching",
  "decision",
  "evaluation",
  "documents",
  "applications",
] as const;

/** Shared platform parts. They hold no job rules and never import a domain module. */
export const PLATFORM_PARTS = [
  "config",
  "observability",
  "security",
  "persistence",
  "llm",
  "prompts",
  "orchestration",
] as const;

/**
 * One line per rule. docs/architecture.md explains each one, and a test keeps the two in step.
 * B rules govern the target layout (`src/modules`, `src/platform`, `src/interfaces`, `src/app`).
 * F rules freeze the legacy layout: what exists is recorded, nothing new is allowed.
 */
export const BOUNDARY_RULES: Readonly<Record<string, string>> = {
  B1: "Imports point downward: interfaces, modules, platform, contracts.",
  B2: "Another module or platform part is reached only through its index.ts.",
  B3: "A module imports only modules that come before it in MODULE_ORDER.",
  B4: "Code in a module's domain folder is pure: no infrastructure, no environment, no clock.",
  B5: "The model gateway never reaches the database.",
  B6: "Only persistence imports the database driver.",
  B7: "A repository is used only by its owner and by the composition root.",
  B8: "SQL lives in persistence; a repository writes only its owner's tables and reads only downward.",
  F1: "No new import cycle between files.",
  F2: "No new pair of legacy areas that import each other.",
  F3: "No new database access from scripts or API routers.",
  F4: "No new importer of src/services/agent.ts or src/db/db.ts.",
  F5: "No new file in src/services.",
  F6: "No new writer of a job status column.",
  F7: "No new legacy area writes a table.",
  F8: "The Streamlit interface reads no new table and writes none.",
  F9: "No new upward import: src/db imports no area above it; src/pipeline imports no queue, API, read model or desktop code.",
  F10: "The model-call resilience layer imports no database, workspace, pipeline, queue, read-model or API code.",
  F11: "Code under src/ never imports a script.",
};

/** Legacy areas that moved code may still import while the migration is in progress. */
const SHARED_LEGACY_AREAS = ["src/security/", "src/config/", "src/workspace/"];

/** Packages and builtins that pure domain code must not import. */
const IMPURE_PACKAGES = new Set([
  "pg",
  "openai",
  "@google/genai",
  "dotenv",
  "express",
  "imapflow",
  "mailparser",
  "playwright",
  "puppeteer",
  "fs",
  "child_process",
  "net",
  "http",
  "https",
]);

/** Status-like columns on canonical_jobs. Each must end with exactly one writing module. */
export const JOB_STATUS_COLUMNS = [
  "processing_state",
  "processing_status",
  "gate_decision",
  "primary_lane",
  "routing_disposition",
  "profile_match_status",
  "recommendation_outcome",
  "recommendation_eligibility",
] as const;

/** Areas above `src/db`. The database layer imports none of them. */
const AREAS_ABOVE_DB = new Set(
  [
    "pipeline", "tasks", "services", "api", "readModels", "desktop", "ingestion", "documents", "reporting", "mcp",
    "sdk", "matching", "decision", "eligibility", "evidence", "lanes", "policy", "profile", "requirements", "embeddings",
  ].map((area) => `src/${area}`),
);

/** Areas above `src/pipeline`. Stage logic imports none of them. */
const AREAS_ABOVE_PIPELINE = new Set(["src/tasks", "src/api", "src/readModels", "src/desktop"]);

/** The file that holds retry, timeout and fallback logic for model calls, and what it must not import. */
const MODEL_CALL_RESILIENCE = "src/services/modelCallResilience.ts";
const AREAS_FORBIDDEN_TO_MODEL_CALLS = new Set(["src/db", "src/workspace", "src/pipeline", "src/tasks", "src/readModels", "src/api"]);

/** Legacy files that must gain no new importers. */
const FROZEN_IMPORT_TARGETS = ["src/services/agent.ts", "src/db/db.ts"];

export interface SourceFile {
  /** Repository-relative path with forward slashes. */
  path: string;
  text: string;
}

export interface ImportEdge {
  from: string;
  /** Resolved repository-relative path of an internal import. */
  to: string;
}

export interface ImportGraph {
  files: SourceFile[];
  edges: ImportEdge[];
  /** Package names (and node builtins without the `node:` prefix) imported by each file. */
  packages: Map<string, Set<string>>;
}

export interface Baseline {
  note: string;
  /** Maximum line count for files that may not grow. */
  limits: Record<string, number>;
  /** Known violation keys. */
  violations: string[];
}

/** `table-ownership.json`: each owner (module, platform part or "legacy") and the tables it owns. */
export interface TableRegistry {
  note: string;
  owners: Record<string, string[]>;
}

/** Owner of tables that are scheduled for retirement. Nothing new reads or writes them. */
export const LEGACY_OWNER = "legacy";

const CREATE_TABLE_PATTERN = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
const WRITE_PATTERN = /\b(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM)\s+(?:public\.)?([a-z_][a-z0-9_]*)\b/g;
const READ_PATTERN = /(?<!\bDELETE\s+)\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\b/g;
/** A read of a read-model view. Views are named `v_*`. */
const VIEW_READ_PATTERN = /\b(?:FROM|JOIN)\s+(?:public\.)?v_[a-z0-9_]+\b/;

/** Table names created by the given migration texts. Comment lines are ignored. */
export function tablesCreatedBy(sqlTexts: string[]): string[] {
  const names = new Set<string>();
  for (const text of sqlTexts) {
    const statements = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    for (const match of statements.matchAll(CREATE_TABLE_PATTERN)) names.add(match[1]!.toLowerCase());
  }
  return [...names].sort();
}

export function ownerByTable(registry: TableRegistry): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [owner, tables] of Object.entries(registry.owners)) {
    for (const table of tables) owners.set(table, owner);
  }
  return owners;
}

function isKnownOwner(name: string): boolean {
  return (
    name === LEGACY_OWNER ||
    (MODULE_ORDER as readonly string[]).includes(name) ||
    ((PLATFORM_PARTS as readonly string[]).includes(name) && name !== "persistence")
  );
}

/** Problems in the ownership registry. Every table needs exactly one known owner. */
export function checkTableRegistry(tables: string[], registry: TableRegistry): string[] {
  const problems: string[] = [];
  const existing = new Set(tables);
  const seen = new Map<string, string>();
  for (const [owner, owned] of Object.entries(registry.owners)) {
    if (!isKnownOwner(owner)) problems.push(`owner "${owner}" is not a module, a platform part or "${LEGACY_OWNER}"`);
    for (const table of owned) {
      const first = seen.get(table);
      if (first !== undefined) problems.push(`table ${table} has two owners: ${first} and ${owner}`);
      seen.set(table, owner);
      if (!existing.has(table)) problems.push(`table ${table} (owner ${owner}) is not created by any migration`);
    }
  }
  for (const table of tables) {
    if (!seen.has(table)) problems.push(`table ${table} has no owner in src/architecture/table-ownership.json`);
  }
  return problems.sort();
}

function tablesMatching(pattern: RegExp, text: string, tables: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    if (tables.has(match[1]!)) found.add(match[1]!);
  }
  return [...found].sort();
}

/** Registered tables that the text inserts into, updates or deletes from. */
export function tablesWritten(text: string, tables: ReadonlySet<string>): string[] {
  return tablesMatching(WRITE_PATTERN, text, tables);
}

/** Registered tables that the text selects from or joins. */
export function tablesRead(text: string, tables: ReadonlySet<string>): string[] {
  return tablesMatching(READ_PATTERN, text, tables);
}

const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

export function isTestFile(file: string): boolean {
  return file.includes(".test.") || file.includes("/tests/") || file.startsWith("tests/");
}

/** Every TypeScript source file under `src/` and `scripts/`, plus `server.ts`, without tests. */
export function listSourceFiles(root: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (relativeDir: string): void => {
    const absoluteDir = path.join(root, relativeDir);
    if (!fs.existsSync(absoluteDir)) return;
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(relative);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !isTestFile(relative)) {
        found.push({ path: relative, text: fs.readFileSync(path.join(root, relative), "utf8") });
      }
    }
  };
  walk("src");
  walk("scripts");
  if (fs.existsSync(path.join(root, "server.ts"))) {
    found.push({ path: "server.ts", text: fs.readFileSync(path.join(root, "server.ts"), "utf8") });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** The Streamlit user interface: `streamlit_*.py` in the repository root. */
export function listStreamlitFiles(root: string): SourceFile[] {
  return fs
    .readdirSync(root)
    .filter((name) => /^streamlit_.*\.py$/.test(name))
    .sort()
    .map((name) => ({ path: name, text: fs.readFileSync(path.join(root, name), "utf8") }));
}

function packageName(specifier: string): string {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const parts = bare.split("/");
  return bare.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? bare;
}

function resolveInternal(from: string, specifier: string, known: Set<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const withoutJs = base.replace(/\.js$/, "");
  const candidates = [base, `${withoutJs}.ts`, `${withoutJs}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

export function buildImportGraph(files: SourceFile[]): ImportGraph {
  const known = new Set(files.map((file) => file.path));
  const edges: ImportEdge[] = [];
  const packages = new Map<string, Set<string>>();
  for (const file of files) {
    const filePackages = new Set<string>();
    const seen = new Set<string>();
    for (const match of file.text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (specifier.startsWith(".")) {
        const target = resolveInternal(file.path, specifier, known);
        if (target && target !== file.path && !seen.has(target)) {
          seen.add(target);
          edges.push({ from: file.path, to: target });
        }
      } else {
        filePackages.add(packageName(specifier));
      }
    }
    packages.set(file.path, filePackages);
  }
  return { files, edges, packages };
}

type Layer = "contracts" | "platform" | "module" | "interface" | "legacy";

interface Placement {
  layer: Layer;
  /** Module or platform part name, or the legacy area (`src/<dir>`). */
  unit: string;
}

export function placementOf(file: string): Placement {
  const parts = file.split("/");
  if (parts[0] === "scripts" || file === "server.ts") return { layer: "interface", unit: "scripts" };
  if (parts[0] !== "src") return { layer: "legacy", unit: parts[0] ?? file };
  const area = parts[1] ?? "";
  if (area === "contracts") return { layer: "contracts", unit: "contracts" };
  if (area === "platform") return { layer: "platform", unit: parts[2] ?? "" };
  if (area === "modules") return { layer: "module", unit: parts[2] ?? "" };
  if (area === "interfaces" || area === "app" || area === "api") return { layer: "interface", unit: area };
  return { layer: "legacy", unit: parts.length > 2 ? `src/${area}` : "src/(root)" };
}

/** The pre-migration area (`src/<dir>`) of a file, or null for scripts and the target layout. */
export function legacyAreaOf(file: string): string | null {
  const parts = file.split("/");
  if (parts[0] !== "src" || parts.length < 3) return null;
  const area = parts[1] ?? "";
  if (["contracts", "platform", "modules", "interfaces", "app"].includes(area)) return null;
  return `src/${area}`;
}

function isSharedLegacy(file: string): boolean {
  return SHARED_LEGACY_AREAS.some((prefix) => file.startsWith(prefix));
}

function moduleRank(name: string): number {
  return (MODULE_ORDER as readonly string[]).indexOf(name);
}

function stronglyConnectedGroups(graph: ImportGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let counter = 0;
  // Iterative Tarjan so a deep import chain cannot overflow the call stack.
  for (const start of graph.files.map((file) => file.path)) {
    if (indexOf.has(start)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    indexOf.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = adjacency.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next]!;
        frame.next += 1;
        if (!indexOf.has(target)) {
          indexOf.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, indexOf.get(target)!));
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        if (low.get(frame.node) === indexOf.get(frame.node)) {
          const group: string[] = [];
          let member: string;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            group.push(member);
          } while (member !== frame.node);
          if (group.length > 1) groups.push(group.sort());
        }
      }
    }
  }
  return groups;
}

const UPDATE_CANONICAL_JOBS = /UPDATE\s+(?:ONLY\s+)?(?:public\.)?canonical_jobs\b([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|`|;)/gi;

/** Status columns of canonical_jobs that a file assigns in an UPDATE statement. */
export function statusColumnsWritten(text: string): string[] {
  const written = new Set<string>();
  for (const match of text.matchAll(UPDATE_CANONICAL_JOBS)) {
    const assignments = match[1] ?? "";
    for (const column of JOB_STATUS_COLUMNS) {
      if (new RegExp(`\\b${column}\\s*=`).test(assignments)) written.add(column);
    }
  }
  return [...written].sort();
}

function isTargetLayout(file: string): boolean {
  return /^src\/(modules|platform|interfaces|app)\//.test(file);
}

/** The owner folder of a repository file (`src/platform/persistence/<owner>/...`), or null. */
function repositoryOwnerOf(file: string): string | null {
  return /^src\/platform\/persistence\/([^/]+)\//.exec(file)?.[1] ?? null;
}

/** May a repository owned by `reader` select from a table owned by `owner`? */
function mayRead(reader: string | null, owner: string): boolean {
  if (reader === null || owner === LEGACY_OWNER) return false;
  if (reader === owner) return true;
  if ((PLATFORM_PARTS as readonly string[]).includes(owner)) return true;
  const readerRank = moduleRank(reader);
  return readerRank >= 0 && moduleRank(owner) < readerRank;
}

/** The code area a legacy writer belongs to: `scripts`, `src/<dir>`, or the file itself. */
function writerAreaOf(file: string): string {
  if (file.startsWith("scripts/")) return "scripts";
  return legacyAreaOf(file) ?? file;
}

/**
 * Every boundary violation in the graph, as stable keys of the form `RULE|subject|detail`.
 * Rules B1 to B8 govern the target layout; F1 to F11 freeze the legacy layout (F8 is reported
 * by `findStreamlitViolations`).
 * B8 and F7 need the table registry and are skipped without it.
 */
export function findViolations(graph: ImportGraph, registry?: TableRegistry): string[] {
  const violations = new Set<string>();
  const add = (rule: string, subject: string, detail = ""): void => {
    violations.add(detail ? `${rule}|${subject}|${detail}` : `${rule}|${subject}`);
  };
  const tableOwners = registry ? ownerByTable(registry) : new Map<string, string>();
  const tableNames: ReadonlySet<string> = new Set(tableOwners.keys());

  for (const { from, to } of graph.edges) {
    const source = placementOf(from);
    const target = placementOf(to);

    // B1: imports point downward. contracts < platform < modules < interfaces.
    if (source.layer === "contracts" && target.layer !== "contracts") add("B1", from, to);
    if (source.layer === "platform" && target.layer !== "platform" && target.layer !== "contracts" && !isSharedLegacy(to)) {
      add("B1", from, to);
    }
    if (source.layer === "module" && (target.layer === "interface" || (target.layer === "legacy" && !isSharedLegacy(to)))) {
      add("B1", from, to);
    }

    // B2: another unit is reached only through its index.ts. A repository's index.ts is the
    // public file of that repository.
    const repository = repositoryOwnerOf(to);
    if ((target.layer === "module" || target.layer === "platform") && !(source.layer === target.layer && source.unit === target.unit)) {
      const publicFiles = [`src/${target.layer === "module" ? "modules" : "platform"}/${target.unit}/index.ts`];
      if (repository) publicFiles.push(`src/platform/persistence/${repository}/index.ts`);
      if (!publicFiles.includes(to)) add("B2", from, to);
    }

    // B7: a repository is used only by its owner and by the composition root.
    if (repository && repositoryOwnerOf(from) !== repository) {
      const ownerUnit = (source.layer === "module" || source.layer === "platform") && source.unit === repository;
      if (!ownerUnit && !from.startsWith("src/app/")) add("B7", from, to);
    }

    // B3: a module imports only modules that come before it in MODULE_ORDER.
    if (source.layer === "module" && target.layer === "module" && source.unit !== target.unit) {
      const sourceRank = moduleRank(source.unit);
      const targetRank = moduleRank(target.unit);
      if (sourceRank < 0 || targetRank < 0 || targetRank >= sourceRank) add("B3", from, to);
    }

    // B4 (imports): pure domain code reaches no infrastructure.
    if (/^src\/modules\/[^/]+\/domain\//.test(from) && /^src\/platform\/(persistence|llm|orchestration)\//.test(to)) {
      add("B4", from, to);
    }

    // B5: the model gateway never reaches the database layer.
    if (from.startsWith("src/platform/llm/") && to.startsWith("src/platform/persistence/")) add("B5", from, to);

    // F4: frozen legacy files gain no new importers.
    if (FROZEN_IMPORT_TARGETS.includes(to)) add("F4", from, to);

    // F9: no new upward import in the legacy layout.
    const fromArea = legacyAreaOf(from);
    const toArea = legacyAreaOf(to);
    if (toArea !== null) {
      if (fromArea === "src/db" && AREAS_ABOVE_DB.has(toArea)) add("F9", from, to);
      if (fromArea === "src/pipeline" && AREAS_ABOVE_PIPELINE.has(toArea)) add("F9", from, to);
      // F10: the model-call resilience layer knows nothing about jobs or the database.
      if (from === MODEL_CALL_RESILIENCE && AREAS_FORBIDDEN_TO_MODEL_CALLS.has(toArea)) add("F10", from, to);
    }

    // F11: application code never imports a script.
    if (from.startsWith("src/") && to.startsWith("scripts/")) add("F11", from, to);
  }

  for (const file of graph.files) {
    const placement = placementOf(file.path);
    const packages = graph.packages.get(file.path) ?? new Set<string>();

    if (placement.layer === "module" && moduleRank(placement.unit) < 0) add("B3", file.path, "unknown module");
    if (placement.layer === "platform" && !(PLATFORM_PARTS as readonly string[]).includes(placement.unit)) {
      add("B2", file.path, "unknown platform part");
    }

    // B4 (content): pure domain code imports no infrastructure and reads no environment or clock.
    if (/^src\/modules\/[^/]+\/domain\//.test(file.path)) {
      for (const name of packages) if (IMPURE_PACKAGES.has(name)) add("B4", file.path, `imports ${name}`);
      if (/\bprocess\.env\b/.test(file.text)) add("B4", file.path, "reads process.env");
      if (/\bDate\.now\(\)|\bnew Date\(\s*\)/.test(file.text)) add("B4", file.path, "reads the clock");
    }

    if (packages.has("pg")) {
      // B5: the model gateway never imports the database driver.
      if (file.path.startsWith("src/platform/llm/")) add("B5", file.path, "imports pg");
      // B6: in the target layout only persistence imports the database driver.
      if (isTargetLayout(file.path) && !file.path.startsWith("src/platform/persistence/")) add("B6", file.path, "imports pg");
      // F3: no new database access from scripts or API routers.
      if (file.path.startsWith("scripts/") || file.path.startsWith("src/api/")) add("F3", file.path, "imports pg");
      // F10: the model-call resilience layer never imports the database driver.
      if (file.path === MODEL_CALL_RESILIENCE) add("F10", file.path, "imports pg");
    }

    // F5: src/services takes no new files.
    if (file.path.startsWith("src/services/")) add("F5", file.path);

    // F6: no new writer of a job status column.
    for (const column of statusColumnsWritten(file.text)) add("F6", column, file.path);

    // B7 (placement): a repository folder is named after its owner.
    const repositoryOwner = repositoryOwnerOf(file.path);
    if (repositoryOwner !== null && (!isKnownOwner(repositoryOwner) || repositoryOwner === LEGACY_OWNER)) {
      add("B7", file.path, "unknown repository owner");
    }

    if (registry) {
      const written = tablesWritten(file.text, tableNames);
      if (!isTargetLayout(file.path)) {
        // F7: no new legacy area writes a table.
        for (const table of written) add("F7", table, writerAreaOf(file.path));
      } else if (!file.path.startsWith("src/platform/persistence/")) {
        // B8: in the target layout SQL lives in persistence. That includes reads of views.
        const reads = tablesRead(file.text, tableNames).length > 0 || VIEW_READ_PATTERN.test(file.text);
        if (written.length > 0 || reads) add("B8", file.path, "SQL outside persistence");
      } else {
        // B8: a repository writes only its owner's tables and reads only downward.
        for (const table of written) {
          const owner = tableOwners.get(table)!;
          if (owner !== repositoryOwner || owner === LEGACY_OWNER) add("B8", file.path, `writes ${table} owned by ${owner}`);
        }
        for (const table of tablesRead(file.text, tableNames)) {
          const owner = tableOwners.get(table)!;
          if (!mayRead(repositoryOwner, owner)) add("B8", file.path, `reads ${table} owned by ${owner}`);
        }
      }
    }
  }

  // F1: no new import cycles between files.
  for (const group of stronglyConnectedGroups(graph)) add("F1", group.join(" <-> "));

  // F2: no new pair of legacy areas that import each other.
  const areaEdges = new Set<string>();
  for (const { from, to } of graph.edges) {
    const source = legacyAreaOf(from);
    const target = legacyAreaOf(to);
    if (source && target && source !== target) areaEdges.add(`${source}>${target}`);
  }
  for (const edge of areaEdges) {
    const [a, b] = edge.split(">") as [string, string];
    if (a < b && areaEdges.has(`${b}>${a}`)) add("F2", `${a} <-> ${b}`);
  }

  return [...violations].sort();
}

/**
 * F8: the Streamlit user interface reads views, not tables, and writes nothing.
 * Every table a Streamlit file selects from, joins or writes is reported.
 */
export function findStreamlitViolations(files: SourceFile[], registry: TableRegistry): string[] {
  const tableNames: ReadonlySet<string> = new Set(ownerByTable(registry).keys());
  const violations: string[] = [];
  for (const file of files) {
    for (const table of tablesRead(file.text, tableNames)) violations.push(`F8|${file.path}|reads ${table}`);
    for (const table of tablesWritten(file.text, tableNames)) violations.push(`F8|${file.path}|writes ${table}`);
  }
  return violations.sort();
}

/** Line count as `wc -l` reports it for a file that ends with a newline. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Files named in `limits` that have grown beyond their recorded line count. */
export function findGrownFiles(files: SourceFile[], limits: Record<string, number>): string[] {
  const grown: string[] = [];
  for (const file of files) {
    const limit = limits[file.path];
    if (limit === undefined) continue;
    const lines = lineCount(file.text);
    if (lines > limit) grown.push(`${file.path} has ${lines} lines; its limit is ${limit}`);
  }
  return grown;
}

export interface BaselineComparison {
  /** Violations that are not recorded: these fail the build. */
  added: string[];
  /** Recorded violations that no longer occur: prune them. */
  resolved: string[];
}

export function compareWithBaseline(current: string[], baseline: Baseline): BaselineComparison {
  const recorded = new Set(baseline.violations);
  const present = new Set(current);
  return {
    added: current.filter((key) => !recorded.has(key)),
    resolved: baseline.violations.filter((key) => !present.has(key)),
  };
}

/** A baseline that keeps only violations still present and lowers limits to current sizes. */
export function pruneBaseline(baseline: Baseline, current: string[], files: SourceFile[]): Baseline {
  const present = new Set(current);
  const limits: Record<string, number> = {};
  for (const [file, limit] of Object.entries(baseline.limits)) {
    const source = files.find((candidate) => candidate.path === file);
    if (!source) continue;
    limits[file] = Math.min(limit, lineCount(source.text));
  }
  return {
    note: baseline.note,
    limits,
    violations: baseline.violations.filter((key) => present.has(key)).sort(),
  };
}
