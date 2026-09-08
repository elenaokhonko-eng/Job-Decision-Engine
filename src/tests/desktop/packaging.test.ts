import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePackageOptions, resolveDesktopOutputDir } from "../../../scripts/package_desktop.js";
import { verifyDesktopPackaging } from "../../../scripts/verify_desktop_packaging.js";

describe("desktop packaging verifier", () => {
  it("passes for the repository native shell configuration", () => {
    const result = verifyDesktopPackaging(process.cwd());

    expect(result.failures).toEqual([]);
    expect(result.checks).toContain("main process uses Electron safeStorage");
    expect(result.checks).toContain("preload exposes isolated bridges");
    expect(result.checks).toContain("desktop:pack uses resilient package script");
    expect(result.checks).toContain("electron-builder Windows icon is configured");
    expect(result.checks).toContain("package script controls publish mode");
  });

  it("honors an explicit desktop output directory", () => {
    const output = resolveDesktopOutputDir("dir", {
      JDEC_DESKTOP_OUTPUT_DIR: "tmp/jdec-pack",
    } as NodeJS.ProcessEnv);

    expect(output).toBe(path.resolve("tmp/jdec-pack"));
  });

  it("uses a generated subdirectory when only an output root is provided", () => {
    const output = resolveDesktopOutputDir("installer", {
      JDEC_DESKTOP_OUTPUT_ROOT: "tmp/jdec-root",
    } as NodeJS.ProcessEnv);

    expect(output).toMatch(new RegExp(`^${path.resolve("tmp/jdec-root").replace(/\\/g, "\\\\")}[/\\\\]installer-\\d+$`));
  });

  it("parses desktop publish and channel options", () => {
    expect(parsePackageOptions(["--installer", "--channel=beta", "--publish=always"])).toEqual({
      mode: "installer",
      channel: "beta",
      publish: "always",
    });
  });
});
