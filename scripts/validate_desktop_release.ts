import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(scriptDir, "..");

export interface DesktopReleaseValidationOptions {
  channel?: string;
  strict?: boolean;
  publish?: string;
}

export interface DesktopReleaseValidationResult {
  ok: boolean;
  checks: string[];
  warnings: string[];
  failures: string[];
}

export interface ParsedDesktopVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function envHas(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}

export function parseDesktopVersion(version: string): ParsedDesktopVersion | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function expectedTag(version: string): string {
  return `v${version}`;
}

function parseArgs(argv: string[]): DesktopReleaseValidationOptions {
  const value = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const withEquals = argv.find((arg) => arg.startsWith(prefix));
    if (withEquals) return withEquals.slice(prefix.length);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    channel: value("channel"),
    publish: value("publish"),
    strict: argv.includes("--strict"),
  };
}

export function validateDesktopRelease(
  options: DesktopReleaseValidationOptions = {},
  rootDir = defaultRootDir,
  env: NodeJS.ProcessEnv = process.env
): DesktopReleaseValidationResult {
  const checks: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const pkg = readJson(path.join(rootDir, "package.json"));
  const policy = readJson(path.join(rootDir, "desktop", "release", "release-policy.json"));
  const channel = String(options.channel || env.JDEC_DESKTOP_RELEASE_CHANNEL || policy.default_channel || "stable").trim();
  const publish = String(options.publish || "never").trim();
  const strict = options.strict === true;
  const channels = Object.keys(policy.channels || {});
  const parsedVersion = parseDesktopVersion(String(pkg.version));

  const requireCheck = (condition: boolean, label: string) => {
    checks.push(label);
    if (!condition) failures.push(label);
  };

  const warnCheck = (condition: boolean, label: string) => {
    checks.push(label);
    if (!condition) warnings.push(label);
  };

  requireCheck(policy.schema_version === "desktop-release-policy/v1", "desktop release policy schema is v1");
  requireCheck(channels.includes(channel), `desktop release channel is allowed: ${channel}`);
  requireCheck(["always", "never", "onTag", "onTagOrDraft"].includes(publish), `desktop publish mode is supported: ${publish}`);
  requireCheck(parsedVersion !== null, "package version is valid semver");
  if (parsedVersion) {
    if (channel === "stable") {
      requireCheck(parsedVersion.prerelease.length === 0, "stable desktop releases use a non-prerelease version");
    } else {
      requireCheck(parsedVersion.prerelease[0] === channel, `${channel} desktop releases use a ${channel} prerelease version`);
    }
  }
  requireCheck(pkg.build?.artifactName === "Job-Decision-Engine-Setup-${version}.${ext}", "desktop artifact name is update-feed safe");
  requireCheck(pkg.build?.win?.icon === "build/desktop/icon.ico", "Windows icon is configured");
  requireCheck(pkg.build?.icon === "build/desktop/icon.png", "generic app icon is configured");
  requireCheck(pkg.build?.generateUpdatesFilesForAllChannels === true, "update metadata is generated for all channels");
  requireCheck(pkg.build?.publish?.[0]?.provider === "github", "GitHub publish provider is configured");
  requireCheck(pkg.build?.publish?.[0]?.owner === policy.github?.owner, "GitHub publish owner matches release policy");
  requireCheck(pkg.build?.publish?.[0]?.repo === policy.github?.repo, "GitHub publish repo matches release policy");
  requireCheck(fs.existsSync(path.join(rootDir, "desktop", "assets", "app-icon.svg")), "source app icon asset exists");
  requireCheck(fs.existsSync(path.join(rootDir, "scripts", "prepare_desktop_assets.ts")), "desktop asset preparation script exists");
  requireCheck(fs.existsSync(path.join(rootDir, ".github", "workflows", "desktop-release.yml")), "desktop release workflow exists");
  requireCheck(fs.existsSync(path.join(rootDir, "CODE_SIGNING_POLICY.md")), "code signing policy exists");
  requireCheck(fs.existsSync(path.join(rootDir, "PRIVACY.md")), "privacy policy exists");
  requireCheck(fs.existsSync(path.join(rootDir, "SECURITY.md")), "security policy exists");
  requireCheck(fs.existsSync(path.join(rootDir, "THIRD_PARTY_NOTICES.md")), "third-party notices exist");

  const readmeContent = fs.existsSync(path.join(rootDir, "README.md")) ? fs.readFileSync(path.join(rootDir, "README.md"), "utf8") : "";
  requireCheck(readmeContent.includes("SignPath Foundation"), "README includes SignPath Foundation code-signing attribution");

  const mainPath = path.join(rootDir, "desktop", "electron", "main.cjs");
  const mainSource = fs.existsSync(mainPath) ? fs.readFileSync(mainPath, "utf8") : "";
  requireCheck(mainSource.includes("releaseChannel"), "Electron runtime reports release channel");
  requireCheck(mainSource.includes("autoUpdater.channel"), "Electron updater channel is configured");
  requireCheck(mainSource.includes("JDEC_DESKTOP_ENABLE_UPDATES"), "Electron updates require explicit enable flag");

  if (channel !== "stable" && parsedVersion?.prerelease[0] === channel) {
    warnCheck(parsedVersion.prerelease.length >= 2, "non-stable release versions should include an incrementing prerelease number");
  }

  if (strict || publish === "always") {
    requireCheck(envHas(env, "GH_TOKEN") || envHas(env, "GITHUB_TOKEN"), "GitHub release token is configured");
    const hasSignpath = envHas(env, "SIGNPATH_API_TOKEN");
    const hasPfx =
      (envHas(env, "CSC_LINK") && envHas(env, "CSC_KEY_PASSWORD")) ||
      (envHas(env, "WIN_CSC_LINK") && envHas(env, "WIN_CSC_KEY_PASSWORD")) ||
      (envHas(env, "WINDOWS_CERTIFICATE_BASE64") && envHas(env, "WINDOWS_CERTIFICATE_PASSWORD"));
    requireCheck(
      hasSignpath || hasPfx,
      "Windows code signing is configured (either SIGNPATH_API_TOKEN or Windows certificate PFX)"
    );
    requireCheck(env.JDEC_DESKTOP_ENABLE_UPDATES === "true", "desktop auto-updates are explicitly enabled for publish");
    requireCheck(env.GITHUB_REF_TYPE === "tag", "publish builds run from a git tag");
    requireCheck(env.GITHUB_REF_NAME === expectedTag(String(pkg.version)), `publish tag matches package version: ${expectedTag(String(pkg.version))}`);
  }

  return {
    ok: failures.length === 0,
    checks,
    warnings,
    failures,
  };
}

async function main(): Promise<void> {
  const result = validateDesktopRelease(parseArgs(process.argv.slice(2)));
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  if (!result.ok) {
    console.error("Desktop release validation failed:");
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
  console.log(`Desktop release validation passed (${result.checks.length} checks, ${result.warnings.length} warnings).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
