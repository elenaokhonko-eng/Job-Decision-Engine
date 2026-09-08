import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopIconPng, createIcoFromPng, prepareDesktopAssets } from "../../../scripts/prepare_desktop_assets.js";

describe("desktop asset preparation", () => {
  it("creates deterministic PNG and ICO assets", () => {
    const png = createDesktopIconPng();
    const ico = createIcoFromPng(png);

    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt32LE(14)).toBe(png.length);
    expect(ico.length).toBeGreaterThan(png.length);
  });

  it("writes packageable assets under build/desktop", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jdec-desktop-assets-"));
    const assets = prepareDesktopAssets(root);

    expect(assets.pngPath).toBe(path.join(root, "build", "desktop", "icon.png"));
    expect(assets.icoPath).toBe(path.join(root, "build", "desktop", "icon.ico"));
    expect(fs.existsSync(assets.pngPath)).toBe(true);
    expect(fs.existsSync(assets.icoPath)).toBe(true);
    expect(assets.pngBytes).toBeGreaterThan(1000);
    expect(assets.icoBytes).toBeGreaterThan(assets.pngBytes);
  });
});
