import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Resolves the directory that holds the YAML policy/lane/source configuration.
 *
 * Historically each loader guessed independently: `laneConfigLoader` used
 * `path.resolve(__dirname, "../../config/...")` while `workabilityPolicy` and
 * `employerBoardLookup` used `path.resolve(process.cwd(), "config/...")`.
 * Both guesses are correct when running from the repository and both are wrong
 * in the packaged desktop app, where the backend is bundled into
 * `desktop/electron/dist-backend` (so `__dirname` is not `src/pipeline`) and
 * the working directory is wherever the user launched the executable from.
 *
 * The resolution order is deliberate:
 *
 *   1. `JDEC_CONFIG_DIR` — an explicit override, so a user can keep their own
 *      edited lanes and policies outside the install directory.
 *   2. `<resources>/config` — where `extraResources` places the shipped config
 *      in a packaged app, outside the asar so it stays readable and editable.
 *   3. Walking up from this module's location, then from the working
 *      directory, for a parent that contains `config/lanes/registry.yml`.
 *      This covers running from source (`src/config` -> repo root) and running
 *      a bundle placed anywhere inside the project.
 */

const CONFIG_DIR_ENV = "JDEC_CONFIG_DIR";

/** A directory is only a config root if it actually carries the lane registry. */
const PROBE = path.join("lanes", "registry.yml");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function looksLikeConfigRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, PROBE));
  } catch {
    return false;
  }
}

function walkUpForConfigRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, "config");
    if (looksLikeConfigRoot(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

let cachedRoot: string | null = null;

/**
 * Absolute path to the configuration root.
 *
 * @throws if no configuration directory can be found, because every caller
 *         that needs it would otherwise fail later with a confusing
 *         downstream error.
 */
export function resolveConfigRoot(): string {
  if (cachedRoot) return cachedRoot;

  // An explicit override is authoritative: if the user pointed us at a
  // directory that is not a config root, fail instead of quietly loading some
  // other configuration. Silently ignoring it would mean edits to their own
  // lanes appear to have no effect.
  const override = (process.env[CONFIG_DIR_ENV] || "").trim();
  if (override) {
    const resolved = path.resolve(override);
    if (!looksLikeConfigRoot(resolved)) {
      throw new Error(
        `${CONFIG_DIR_ENV} is set to "${override}" but ${path.join(resolved, PROBE)} was not found.`
      );
    }
    cachedRoot = resolved;
    return cachedRoot;
  }

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  // Ordered like `resolveMigrationsDir`: packaged locations first, then running
  // from source. The probe check means a stray directory named `config` is never
  // mistaken for the real one.
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "config") : null,
    resourcesPath ? path.join(resourcesPath, "app.asar", "config") : null,
    path.resolve(__dirname, "../../config"),
    path.resolve(__dirname, "../config"),
    walkUpForConfigRoot(__dirname),
    path.resolve(process.cwd(), "config"),
    walkUpForConfigRoot(process.cwd()),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    if (looksLikeConfigRoot(candidate)) {
      cachedRoot = candidate;
      return cachedRoot;
    }
  }

  throw new Error(`Configuration directory not found in candidates: ${candidates.join(", ")}`);
}

/** Absolute path to a file inside the configuration root, e.g. `configPath("lanes", "registry.yml")`. */
export function configPath(...segments: string[]): string {
  return path.join(resolveConfigRoot(), ...segments);
}

/** Test hook: forget the memoised root after changing `JDEC_CONFIG_DIR` or the working directory. */
export function resetConfigRootCache(): void {
  cachedRoot = null;
}
