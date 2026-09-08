import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { validateDesktopRelease } from "./validate_desktop_release.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(scriptDir, "..");

export interface DesktopReleaseEvidenceOptions {
  channel?: string;
  publish?: string;
  outputDir?: string;
  out?: string;
}

export interface DesktopReleaseEvidenceArtifact {
  name: string;
  relativePath: string;
  bytes: number;
}

export interface DesktopReleaseEvidence {
  generatedAt: string;
  gitSha: string;
  gitRefType: string | null;
  gitRefName: string | null;
  packageName: string;
  packageVersion: string;
  channel: string;
  publish: string;
  outputDir: string | null;
  validation: ReturnType<typeof validateDesktopRelease>;
  artifacts: DesktopReleaseEvidenceArtifact[];
  latestYml: Record<string, unknown> | null;
  updateMetadataMatchesArtifact: boolean | null;
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function argValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const withEquals = argv.find((arg) => arg.startsWith(prefix));
  if (withEquals) return withEquals.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseArgs(argv: string[]): DesktopReleaseEvidenceOptions {
  return {
    channel: argValue(argv, "channel"),
    publish: argValue(argv, "publish"),
    outputDir: argValue(argv, "output-dir"),
    out: argValue(argv, "out"),
  };
}

function gitValue(args: string[], rootDir: string): string | null {
  try {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function listArtifacts(outputDir: string | null): DesktopReleaseEvidenceArtifact[] {
  if (!outputDir || !fs.existsSync(outputDir)) return [];
  const found: DesktopReleaseEvidenceArtifact[] = [];
  const stack = [outputDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "win-unpacked") stack.push(fullPath);
        continue;
      }
      if (!/\.(exe|blockmap|ya?ml)$/i.test(entry.name)) continue;
      const stat = fs.statSync(fullPath);
      found.push({
        name: entry.name,
        relativePath: path.relative(outputDir, fullPath),
        bytes: stat.size,
      });
    }
  }
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function loadLatestYml(outputDir: string | null): Record<string, unknown> | null {
  if (!outputDir) return null;
  const filePath = path.join(outputDir, "latest.yml");
  if (!fs.existsSync(filePath)) return null;
  const parsed = loadYaml(fs.readFileSync(filePath, "utf8"));
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
}

function metadataMatchesArtifact(latestYml: Record<string, unknown> | null, artifacts: DesktopReleaseEvidenceArtifact[]): boolean | null {
  if (!latestYml) return null;
  const expectedPath = typeof latestYml.path === "string" ? latestYml.path : null;
  if (!expectedPath) return false;
  return artifacts.some((artifact) => artifact.relativePath.replace(/\\/g, "/") === expectedPath.replace(/\\/g, "/"));
}

export function collectDesktopReleaseEvidence(
  options: DesktopReleaseEvidenceOptions = {},
  rootDir = defaultRootDir,
  env: NodeJS.ProcessEnv = process.env
): DesktopReleaseEvidence {
  const pkg = readJson(path.join(rootDir, "package.json"));
  const channel = options.channel || env.JDEC_DESKTOP_RELEASE_CHANNEL || "stable";
  const publish = options.publish || "never";
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : env.JDEC_DESKTOP_OUTPUT_DIR ? path.resolve(env.JDEC_DESKTOP_OUTPUT_DIR) : null;
  const artifacts = listArtifacts(outputDir);
  const latestYml = loadLatestYml(outputDir);
  return {
    generatedAt: new Date().toISOString(),
    gitSha: env.GITHUB_SHA || gitValue(["rev-parse", "HEAD"], rootDir) || "unknown",
    gitRefType: env.GITHUB_REF_TYPE || null,
    gitRefName: env.GITHUB_REF_NAME || null,
    packageName: String(pkg.name),
    packageVersion: String(pkg.version),
    channel,
    publish,
    outputDir,
    validation: validateDesktopRelease({ channel, publish, strict: publish === "always" }, rootDir, env),
    artifacts,
    latestYml,
    updateMetadataMatchesArtifact: metadataMatchesArtifact(latestYml, artifacts),
  };
}

export function renderDesktopReleaseEvidence(evidence: DesktopReleaseEvidence): string {
  const lines = [
    "# Desktop Release Evidence",
    "",
    `Generated: ${evidence.generatedAt}`,
    `Commit: ${evidence.gitSha}`,
    `Ref: ${evidence.gitRefType ?? "unknown"} ${evidence.gitRefName ?? "unknown"}`,
    `Package: ${evidence.packageName}@${evidence.packageVersion}`,
    `Channel: ${evidence.channel}`,
    `Publish: ${evidence.publish}`,
    `Output: ${evidence.outputDir ?? "not provided"}`,
    "",
    "## Validation",
    "",
    `Status: ${evidence.validation.ok ? "PASS" : "FAIL"}`,
    `Warnings: ${evidence.validation.warnings.length}`,
    `Failures: ${evidence.validation.failures.length}`,
    "",
    "## Artifacts",
    "",
  ];

  if (evidence.artifacts.length === 0) {
    lines.push("No release artifacts found.");
  } else {
    lines.push("| Artifact | Bytes |", "|---|---:|");
    for (const artifact of evidence.artifacts) {
      lines.push(`| ${artifact.relativePath.replace(/\\/g, "/")} | ${artifact.bytes} |`);
    }
  }

  lines.push("", "## Update Metadata", "");
  if (!evidence.latestYml) {
    lines.push("No latest.yml found.");
  } else {
    lines.push(`Path: ${String(evidence.latestYml.path ?? "missing")}`);
    lines.push(`Version: ${String(evidence.latestYml.version ?? "missing")}`);
    lines.push(`Matches artifact: ${evidence.updateMetadataMatchesArtifact === true ? "yes" : "no"}`);
  }

  if (evidence.validation.failures.length > 0) {
    lines.push("", "## Validation Failures", "");
    for (const failure of evidence.validation.failures) {
      lines.push(`- ${failure}`);
    }
  }

  if (evidence.validation.warnings.length > 0) {
    lines.push("", "## Validation Warnings", "");
    for (const warning of evidence.validation.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const evidence = collectDesktopReleaseEvidence(options);
  const rendered = renderDesktopReleaseEvidence(evidence);
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(path.resolve(options.out), rendered);
  }
  process.stdout.write(rendered);
  if (!evidence.validation.ok || evidence.updateMetadataMatchesArtifact === false) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
