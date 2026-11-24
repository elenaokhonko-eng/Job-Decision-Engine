import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, resetConfigRootCache, resolveConfigRoot, resolveConfigRootFrom } from "../../config/configPaths.js";

/**
 * The packaged desktop app used to lose its configuration because every loader
 * guessed the config location independently: the lane loader used
 * `__dirname/../../config` (wrong once the backend is bundled into
 * `desktop/electron/dist-backend`) and the policy loaders used
 * `process.cwd()/config` (wrong once the user launches the installed .exe from
 * anywhere). These tests pin the resolution order.
 */
describe("configPaths", () => {
  const originalConfigDir = process.env.JDEC_CONFIG_DIR;
  const originalCwd = process.cwd();
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdec-config-"));
    delete process.env.JDEC_CONFIG_DIR;
    resetConfigRootCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalConfigDir === undefined) {
      delete process.env.JDEC_CONFIG_DIR;
    } else {
      process.env.JDEC_CONFIG_DIR = originalConfigDir;
    }
    resetConfigRootCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeConfigRoot(parent: string): string {
    const root = path.join(parent, "config");
    fs.mkdirSync(path.join(root, "lanes"), { recursive: true });
    fs.writeFileSync(path.join(root, "lanes", "registry.yml"), "lanes: []\n", "utf8");
    return root;
  }

  it("finds the repository config directory when running from source", () => {
    const resolved = resolveConfigRoot();
    expect(fs.existsSync(path.join(resolved, "lanes", "registry.yml"))).toBe(true);
    expect(fs.existsSync(path.join(resolved, "policies", "workability.yml"))).toBe(true);
  });

  it("builds file paths under the resolved root", () => {
    const resolved = resolveConfigRoot();
    expect(configPath("lanes", "registry.yml")).toBe(path.join(resolved, "lanes", "registry.yml"));
  });

  it("honours JDEC_CONFIG_DIR so a user can keep edited config outside the install", () => {
    const root = makeConfigRoot(tempRoot);
    process.env.JDEC_CONFIG_DIR = root;
    resetConfigRootCache();

    expect(resolveConfigRoot()).toBe(path.resolve(root));
    expect(configPath("lanes", "registry.yml")).toBe(path.join(path.resolve(root), "lanes", "registry.yml"));
  });

  it("fails loudly when JDEC_CONFIG_DIR points at a directory without a lane registry", () => {
    const empty = path.join(tempRoot, "not-a-config-root");
    fs.mkdirSync(empty, { recursive: true });
    process.env.JDEC_CONFIG_DIR = empty;
    resetConfigRootCache();

    expect(() => resolveConfigRoot()).toThrow(/JDEC_CONFIG_DIR/);
  });

  it("still resolves configuration after the working directory changes", () => {
    // The packaged app is launched from an arbitrary directory, so resolution
    // must not depend on the working directory.
    const nested = path.join(tempRoot, "some", "deep", "working", "dir");
    fs.mkdirSync(nested, { recursive: true });
    const before = resolveConfigRoot();

    process.chdir(nested);
    resetConfigRootCache();

    const after = resolveConfigRoot();
    expect(fs.existsSync(path.join(after, "lanes", "registry.yml"))).toBe(true);
    expect(after).toBe(before);
  });
});

describe("resolveConfigRootFrom (installed app and working-directory cases)", () => {
  let tempRoot: string;
  const makeRoot = (parent: string, ...segments: string[]): string => {
    const root = path.join(parent, ...segments);
    fs.mkdirSync(path.join(root, "lanes"), { recursive: true });
    fs.writeFileSync(path.join(root, "lanes", "registry.yml"), "lanes: []\n", "utf8");
    return root;
  };
  const bundleDir = (): string => {
    const dir = path.join(tempRoot, "bundle", "x", "y");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jdec-config-from-"));
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("installed app: uses <resources>/config even when the working directory has its own config", () => {
    const resources = path.join(tempRoot, "resources");
    const shipped = makeRoot(resources, "config");
    const cwd = path.join(tempRoot, "elsewhere");
    makeRoot(cwd, "config");

    expect(resolveConfigRootFrom({ resourcesPath: resources, moduleDir: bundleDir(), cwd })).toBe(shipped);
  });

  it("installed app: falls back to <resources>/app.asar/config", () => {
    const resources = path.join(tempRoot, "resources");
    const inAsar = makeRoot(resources, "app.asar", "config");

    expect(resolveConfigRootFrom({ resourcesPath: resources, moduleDir: bundleDir(), cwd: tempRoot })).toBe(inAsar);
  });

  it("from source: finds config two levels above the module", () => {
    const repo = path.join(tempRoot, "repo");
    const config = makeRoot(repo, "config");
    const moduleDir = path.join(repo, "src", "config");
    fs.mkdirSync(moduleDir, { recursive: true });

    expect(resolveConfigRootFrom({ moduleDir, cwd: path.join(tempRoot, "unrelated") })).toBe(config);
  });

  it("working directory: uses <cwd>/config when nothing else matches", () => {
    const cwd = path.join(tempRoot, "project");
    const config = makeRoot(cwd, "config");

    expect(resolveConfigRootFrom({ moduleDir: bundleDir(), cwd })).toBe(config);
  });

  it("does not search up from the working directory, so another project config is never picked up", () => {
    const parent = path.join(tempRoot, "other-project");
    makeRoot(parent, "config");
    const cwd = path.join(parent, "sub", "dir");
    fs.mkdirSync(cwd, { recursive: true });

    expect(() => resolveConfigRootFrom({ moduleDir: bundleDir(), cwd })).toThrow(/Configuration directory not found/);
  });

  it("ignores a candidate without lanes/registry.yml", () => {
    const resources = path.join(tempRoot, "resources");
    fs.mkdirSync(path.join(resources, "config"), { recursive: true });
    const cwd = path.join(tempRoot, "project");
    const config = makeRoot(cwd, "config");

    expect(resolveConfigRootFrom({ resourcesPath: resources, moduleDir: bundleDir(), cwd })).toBe(config);
  });

  it("override beats every other candidate, and a blank override is treated as unset", () => {
    const resources = path.join(tempRoot, "resources");
    makeRoot(resources, "config");
    const mine = makeRoot(tempRoot, "mine");
    const moduleDir = bundleDir();

    expect(resolveConfigRootFrom({ override: mine, resourcesPath: resources, moduleDir, cwd: tempRoot })).toBe(mine);
    expect(resolveConfigRootFrom({ override: "   ", resourcesPath: resources, moduleDir, cwd: tempRoot }))
      .toBe(path.join(resources, "config"));
  });

  it("a wrong override fails instead of falling back to another config", () => {
    const resources = path.join(tempRoot, "resources");
    makeRoot(resources, "config");

    expect(() => resolveConfigRootFrom({
      override: path.join(tempRoot, "nope"), resourcesPath: resources, moduleDir: bundleDir(), cwd: tempRoot,
    })).toThrow(/JDEC_CONFIG_DIR/);
  });
});
