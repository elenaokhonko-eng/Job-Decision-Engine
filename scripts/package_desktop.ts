import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDesktopAssets } from "./prepare_desktop_assets.js";
import { validateDesktopRelease } from "./validate_desktop_release.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

export type PackageMode = "dir" | "installer";
export type DesktopPublishMode = "always" | "never" | "onTag" | "onTagOrDraft";

export interface DesktopPackageOptions {
  mode: PackageMode;
  channel: string;
  publish: DesktopPublishMode;
}

function localBuildRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configuredRoot = env.JDEC_DESKTOP_OUTPUT_ROOT?.trim();
  if (configuredRoot) return path.resolve(configuredRoot);

  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    return path.join(localAppData, "JobDecisionEngine", "desktop-builds");
  }

  return path.join(os.tmpdir(), "jdec-desktop-builds");
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 17);
}

export function resolveDesktopOutputDir(mode: PackageMode, env = process.env): string {
  const configuredOutput = env.JDEC_DESKTOP_OUTPUT_DIR?.trim();
  if (configuredOutput) return path.resolve(configuredOutput);

  const root = env.JDEC_DESKTOP_OUTPUT_ROOT?.trim()
    ? path.resolve(env.JDEC_DESKTOP_OUTPUT_ROOT)
    : localBuildRoot(env);
  return path.join(root, `${mode}-${timestamp()}`);
}

function argValue(argv: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const withEquals = argv.find((arg) => arg.startsWith(prefix));
  if (withEquals) return withEquals.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

export function parsePackageOptions(argv: string[]): DesktopPackageOptions {
  const wantsDir = argv.includes("--dir");
  const wantsInstaller = argv.includes("--installer") || argv.includes("--dist");
  if (wantsDir && wantsInstaller) {
    throw new Error("Choose either --dir or --installer, not both.");
  }
  const publish = (argValue(argv, "publish") ?? "never") as DesktopPublishMode;
  const allowedPublishModes = new Set<DesktopPublishMode>(["always", "never", "onTag", "onTagOrDraft"]);
  if (!allowedPublishModes.has(publish)) {
    throw new Error(`Unsupported desktop publish mode: ${publish}`);
  }
  return {
    mode: wantsInstaller ? "installer" : "dir",
    channel: argValue(argv, "channel") ?? process.env.JDEC_DESKTOP_RELEASE_CHANNEL ?? "stable",
    publish,
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

export async function packageDesktop(argv = process.argv.slice(2)): Promise<string> {
  const options = parsePackageOptions(argv);
  const validation = validateDesktopRelease({
    channel: options.channel,
    strict: options.publish === "always",
    publish: options.publish,
  }, rootDir, process.env);
  if (!validation.ok) {
    throw new Error(`Desktop release validation failed:\n- ${validation.failures.join("\n- ")}`);
  }

  prepareDesktopAssets(rootDir);

  const mode = options.mode;
  const outputDir = resolveDesktopOutputDir(mode);
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });

  console.log(`Desktop packaging output: ${outputDir}`);
  // Use Node entrypoints instead of npm/.cmd shims so Windows paths with spaces stay argument-safe.
  const childEnv = {
    ...process.env,
    JDEC_DESKTOP_RELEASE_CHANNEL: options.channel,
    JDEC_DESKTOP_ENABLE_UPDATES: options.publish === "always"
      ? process.env.JDEC_DESKTOP_ENABLE_UPDATES || "true"
      : process.env.JDEC_DESKTOP_ENABLE_UPDATES || "false",
  };
  await run(process.execPath, [path.join(rootDir, "node_modules", "vite", "bin", "vite.js"), "build"], childEnv);

  const builderArgs = mode === "dir" ? ["--dir"] : [];
  builderArgs.push("--publish", options.publish);
  builderArgs.push(`--config.directories.output=${outputDir}`);
  builderArgs.push(`--config.extraMetadata.jdecReleaseChannel=${options.channel}`);
  await run(process.execPath, [path.join(rootDir, "node_modules", "electron-builder", "cli.js"), ...builderArgs], childEnv);

  console.log(`Desktop packaging complete: ${outputDir}`);
  return outputDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageDesktop().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
