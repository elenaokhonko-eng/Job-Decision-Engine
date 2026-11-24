import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the directory that holds the YAML policy, lane and source configuration.
 *
 * Each loader used to guess on its own: the lane loader used `__dirname/../../config` and the
 * policy loaders used `process.cwd()/config`. Both are right inside the repository and both are
 * wrong in the packaged desktop app, where the backend is bundled into
 * `desktop/electron/dist-backend` and the working directory is wherever the user launched the
 * program.
 *
 * Resolution order (first match wins):
 *   1. `JDEC_CONFIG_DIR`, authoritative. If it is set and is not a config root, resolution fails;
 *      it is never ignored, because then edits to a user's own lanes would silently have no effect.
 *   2. `<resourcesPath>/config`, where `extraResources` puts the shipped config in an installed app.
 *   3. `<resourcesPath>/app.asar/config`.
 *   4. Fixed parents of this module (`../../config`, `../config`), which cover running from source
 *      and a bundle placed in `desktop/electron/dist-backend`.
 *   5. `<cwd>/config`.
 * A directory only counts as a config root when it contains `lanes/registry.yml`. There is no
 * search up the directory tree: that could pick up another project's `config` folder.
 */

export const CONFIG_DIR_ENV = "JDEC_CONFIG_DIR";

/** A directory is a config root only if it carries the lane registry. */
const PROBE = path.join("lanes", "registry.yml");

export interface ConfigRootInputs {
  /** Value of JDEC_CONFIG_DIR (undefined or blank means "not set"). */
  override?: string;
  /** Electron's `process.resourcesPath` in an installed app, otherwise undefined. */
  resourcesPath?: string;
  /** Directory of this module (or of the bundle that contains it). */
  moduleDir: string;
  /** The process working directory. */
  cwd: string;
}

function looksLikeConfigRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, PROBE));
  } catch {
    return false;
  }
}

/** Resolution without globals: reads only the file system, never the environment or the clock. */
export function resolveConfigRootFrom(inputs: ConfigRootInputs): string {
  const override = (inputs.override ?? "").trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!looksLikeConfigRoot(resolved)) {
      throw new Error(`${CONFIG_DIR_ENV} is set to "${override}" but ${path.join(resolved, PROBE)} was not found.`);
    }
    return resolved;
  }

  const candidates = [
    inputs.resourcesPath ? path.join(inputs.resourcesPath, "config") : null,
    inputs.resourcesPath ? path.join(inputs.resourcesPath, "app.asar", "config") : null,
    path.resolve(inputs.moduleDir, "../../config"),
    path.resolve(inputs.moduleDir, "../config"),
    path.resolve(inputs.cwd, "config"),
  ].filter((candidate): candidate is string => candidate !== null);

  for (const candidate of candidates) {
    if (looksLikeConfigRoot(candidate)) return candidate;
  }
  throw new Error(`Configuration directory not found. Looked in: ${candidates.join(", ")}`);
}

let cachedRoot: string | null = null;

/** Absolute path to the configuration root. Throws when none can be found. */
export function resolveConfigRoot(): string {
  if (cachedRoot) return cachedRoot;
  cachedRoot = resolveConfigRootFrom({
    override: process.env[CONFIG_DIR_ENV],
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    moduleDir: path.dirname(fileURLToPath(import.meta.url)),
    cwd: process.cwd(),
  });
  return cachedRoot;
}

/** Absolute path to a file inside the configuration root, e.g. `configPath("lanes", "registry.yml")`. */
export function configPath(...segments: string[]): string {
  return path.join(resolveConfigRoot(), ...segments);
}

/** Test hook: forget the memoised root after changing `JDEC_CONFIG_DIR` or the working directory. */
export function resetConfigRootCache(): void {
  cachedRoot = null;
}
