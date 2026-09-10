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
  const assetScriptPath = path.join(rootDir, "scripts", "prepare_desktop_assets.ts");
  const releaseValidationPath = path.join(rootDir, "scripts", "validate_desktop_release.ts");
  const releaseEvidencePath = path.join(rootDir, "scripts", "desktop_release_evidence.ts");
  const releasePolicyPath = path.join(rootDir, "desktop", "release", "release-policy.json");
  const releaseWorkflowPath = path.join(rootDir, ".github", "workflows", "desktop-release.yml");
  const viteConfigPath = path.join(rootDir, "vite.config.ts");
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
  requireCheck(fs.existsSync(assetScriptPath), "Desktop asset preparation script exists");
  requireCheck(fs.existsSync(releaseValidationPath), "Desktop release validation script exists");
  requireCheck(fs.existsSync(releaseEvidencePath), "Desktop release evidence script exists");
  requireCheck(fs.existsSync(releasePolicyPath), "Desktop release policy exists");
  requireCheck(fs.existsSync(releaseWorkflowPath), "Desktop release workflow exists");
  requireCheck(fs.existsSync(viteConfigPath), "Vite renderer configuration exists");
  requireCheck(hasScript(pkg, "desktop:dev"), "desktop:dev script exists");
  requireCheck(hasScript(pkg, "desktop:pack"), "desktop:pack script exists");
  requireCheck(hasScript(pkg, "desktop:dist"), "desktop:dist script exists");
  requireCheck(hasScript(pkg, "desktop:assets"), "desktop:assets script exists");
  requireCheck(hasScript(pkg, "desktop:release:validate"), "desktop:release:validate script exists");
  requireCheck(hasScript(pkg, "desktop:release:evidence"), "desktop:release:evidence script exists");
  requireCheck(hasScript(pkg, "desktop:verify"), "desktop:verify script exists");
  requireCheck(pkg.scripts?.["desktop:pack"]?.includes("scripts/package_desktop.ts"), "desktop:pack uses resilient package script");
  requireCheck(pkg.scripts?.["desktop:dist"]?.includes("scripts/package_desktop.ts"), "desktop:dist uses resilient package script");
  requireCheck(!!pkg.dependencies?.["electron-updater"], "electron-updater is a runtime dependency");
  requireCheck(!!pkg.devDependencies?.electron, "electron is a dev dependency");
  requireCheck(!!pkg.devDependencies?.["electron-builder"], "electron-builder is a dev dependency");
  requireCheck(pkg.build?.appId === "com.jobdecisionengine.desktop", "electron-builder appId is configured");
  requireCheck(pkg.build?.productName === "Job Decision Engine", "electron-builder productName is configured");
  requireCheck(pkg.build?.artifactName === "Job-Decision-Engine-Setup-${version}.${ext}", "electron-builder artifactName is update-feed safe");
  requireCheck(pkg.build?.directories?.output === "release", "electron-builder output directory is release");
  requireCheck(pkg.build?.icon === "build/desktop/icon.png", "electron-builder generic icon is configured");
  requireCheck(pkg.build?.win?.icon === "build/desktop/icon.ico", "electron-builder Windows icon is configured");
  requireCheck(pkg.build?.generateUpdatesFilesForAllChannels === true, "electron-builder update metadata is configured");
  requireCheck(Array.isArray(pkg.build?.win?.target), "Windows installer target is configured");
  requireCheck(pkg.build?.nsis?.oneClick === false, "NSIS assisted installer is configured");
  requireCheck(Array.isArray(pkg.build?.publish), "update publish provider is configured");
  requireCheck(fileContains(mainPath, "safeStorage"), "main process uses Electron safeStorage");
  requireCheck(fileContains(mainPath, "jdec:api:request"), "main process owns the authenticated remote API bridge");
  requireCheck(!fileContains(mainPath, 'ipcMain.handle("jdec:secret:get"'), "main process does not expose bearer-token reads over IPC");
  requireCheck(fileContains(mainPath, "apiTokenConfigured"), "main process reports token configuration without exposing the token");
  requireCheck(fileContains(mainPath, "Packaged desktop clients require an HTTPS managed remote API"), "packaged desktop API transport is HTTPS enforced");
  requireCheck(fileContains(mainPath, "if (app.isPackaged) return \"\""), "packaged desktop has no implicit loopback API default");
  requireCheck(fileContains(mainPath, "JDEC_DESKTOP_START_API"), "main process has local API runtime guard");
  requireCheck(fileContains(mainPath, "JDEC_DESKTOP_RELEASE_CHANNEL"), "main process reads release channel");
  requireCheck(fileContains(mainPath, "autoUpdater.channel"), "main process configures updater channel");
  requireCheck(fileContains(preloadPath, "contextBridge.exposeInMainWorld"), "preload exposes isolated bridges");
  requireCheck(fileContains(preloadPath, "jdecApi"), "preload exposes the remote API bridge");
  requireCheck(!fileContains(preloadPath, "getSecret"), "preload does not expose bearer-token reads to the renderer");
  requireCheck(fileContains(viteConfigPath, "base: './'"), "Vite uses relative packaged asset URLs");
  requireCheck(fileContains(packageScriptPath, "JDEC_DESKTOP_OUTPUT_DIR"), "package script supports explicit output directory");
  requireCheck(fileContains(packageScriptPath, "LOCALAPPDATA"), "package script defaults outside synced workspace on Windows");
  requireCheck(fileContains(packageScriptPath, "prepareDesktopAssets"), "package script prepares desktop assets");
  requireCheck(fileContains(packageScriptPath, "--publish"), "package script controls publish mode");
  requireCheck(fileContains(releaseValidationPath, "publish builds run from a git tag"), "release validation requires tags for publish");
  requireCheck(fileContains(releaseValidationPath, "stable desktop releases use a non-prerelease version"), "release validation guards stable version format");
  requireCheck(fileContains(releaseEvidencePath, "Desktop Release Evidence"), "release evidence renders markdown");
  requireCheck(fileContains(releaseWorkflowPath, "desktop:release:evidence"), "release workflow captures evidence");

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
