import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

type PackageMode = "dir" | "installer";

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

function parseMode(argv: string[]): PackageMode {
  const wantsDir = argv.includes("--dir");
  const wantsInstaller = argv.includes("--installer") || argv.includes("--dist");
  if (wantsDir && wantsInstaller) {
    throw new Error("Choose either --dir or --installer, not both.");
  }
  return wantsInstaller ? "installer" : "dir";
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
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
  const mode = parseMode(argv);
  const outputDir = resolveDesktopOutputDir(mode);
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });

  console.log(`Desktop packaging output: ${outputDir}`);
  // Use Node entrypoints instead of npm/.cmd shims so Windows paths with spaces stay argument-safe.
  await run(process.execPath, [path.join(rootDir, "node_modules", "vite", "bin", "vite.js"), "build"]);

  const builderArgs = mode === "dir" ? ["--dir"] : [];
  builderArgs.push(`--config.directories.output=${outputDir}`);
  await run(process.execPath, [path.join(rootDir, "node_modules", "electron-builder", "cli.js"), ...builderArgs]);

  console.log(`Desktop packaging complete: ${outputDir}`);
  return outputDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageDesktop().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
