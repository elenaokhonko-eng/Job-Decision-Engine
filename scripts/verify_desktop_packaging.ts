import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopPackagingVerification {
  ok: boolean;
  checks: string[];
  failures: string[];
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasScript(pkg: any, name: string): boolean {
  return typeof pkg.scripts?.[name] === "string" && pkg.scripts[name].trim().length > 0;
}

function fileContains(filePath: string, needle: string): boolean {
  return fs.readFileSync(filePath, "utf8").includes(needle);
}

export function verifyDesktopPackaging(rootDir = process.cwd()): DesktopPackagingVerification {
  const failures: string[] = [];
  const checks: string[] = [];
  const pkgPath = path.join(rootDir, "package.json");
  const mainPath = path.join(rootDir, "desktop", "electron", "main.cjs");
  const preloadPath = path.join(rootDir, "desktop", "electron", "preload.cjs");
  const packageScriptPath = path.join(rootDir, "scripts", "package_desktop.ts");
  const distIndex = path.join(rootDir, "dist", "index.html");
  const pkg = readJson(pkgPath);

  const requireCheck = (condition: boolean, label: string) => {
    checks.push(label);
    if (!condition) failures.push(label);
  };

  requireCheck(pkg.main === "desktop/electron/main.cjs", "package.json main points at Electron shell");
  requireCheck(fs.existsSync(mainPath), "Electron main process exists");
  requireCheck(fs.existsSync(preloadPath), "Electron preload bridge exists");
  requireCheck(fs.existsSync(packageScriptPath), "Desktop package script exists");
  requireCheck(hasScript(pkg, "desktop:dev"), "desktop:dev script exists");
  requireCheck(hasScript(pkg, "desktop:pack"), "desktop:pack script exists");
  requireCheck(hasScript(pkg, "desktop:dist"), "desktop:dist script exists");
  requireCheck(hasScript(pkg, "desktop:verify"), "desktop:verify script exists");
  requireCheck(pkg.scripts?.["desktop:pack"]?.includes("scripts/package_desktop.ts"), "desktop:pack uses resilient package script");
  requireCheck(pkg.scripts?.["desktop:dist"]?.includes("scripts/package_desktop.ts"), "desktop:dist uses resilient package script");
  requireCheck(!!pkg.dependencies?.["electron-updater"], "electron-updater is a runtime dependency");
  requireCheck(!!pkg.devDependencies?.electron, "electron is a dev dependency");
  requireCheck(!!pkg.devDependencies?.["electron-builder"], "electron-builder is a dev dependency");
  requireCheck(pkg.build?.appId === "com.jobdecisionengine.desktop", "electron-builder appId is configured");
  requireCheck(pkg.build?.productName === "Job Decision Engine", "electron-builder productName is configured");
  requireCheck(pkg.build?.directories?.output === "release", "electron-builder output directory is release");
  requireCheck(Array.isArray(pkg.build?.win?.target), "Windows installer target is configured");
  requireCheck(pkg.build?.nsis?.oneClick === false, "NSIS assisted installer is configured");
  requireCheck(Array.isArray(pkg.build?.publish), "update publish provider is configured");
  requireCheck(fileContains(mainPath, "safeStorage"), "main process uses Electron safeStorage");
  requireCheck(fileContains(mainPath, "JDEC_DESKTOP_START_API"), "main process has local API runtime guard");
  requireCheck(fileContains(preloadPath, "contextBridge.exposeInMainWorld"), "preload exposes isolated bridges");
  requireCheck(fileContains(packageScriptPath, "JDEC_DESKTOP_OUTPUT_DIR"), "package script supports explicit output directory");
  requireCheck(fileContains(packageScriptPath, "LOCALAPPDATA"), "package script defaults outside synced workspace on Windows");

  if (fs.existsSync(path.join(rootDir, "dist"))) {
    requireCheck(fs.existsSync(distIndex), "Vite dist has index.html");
  }

  return {
    ok: failures.length === 0,
    checks,
    failures,
  };
}

async function main(): Promise<void> {
  const result = verifyDesktopPackaging();
  if (!result.ok) {
    console.error("Desktop packaging verification failed:");
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
  console.log(`Desktop packaging verification passed (${result.checks.length} checks).`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  void main();
}
