import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDesktopReleaseEvidence,
  renderDesktopReleaseEvidence,
} from "../../../scripts/desktop_release_evidence.js";

describe("desktop release evidence", () => {
  it("collects artifacts and verifies latest.yml points at the installer", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "jdec-release-evidence-"));
    fs.writeFileSync(path.join(outputDir, "Job-Decision-Engine-Setup-1.0.0.exe"), "installer");
    fs.writeFileSync(path.join(outputDir, "Job-Decision-Engine-Setup-1.0.0.exe.blockmap"), "blockmap");
    fs.writeFileSync(path.join(outputDir, "latest.yml"), [
      "version: 1.0.0",
      "path: Job-Decision-Engine-Setup-1.0.0.exe",
      "files:",
      "  - url: Job-Decision-Engine-Setup-1.0.0.exe",
      "    sha512: fake",
      "    size: 9",
      "",
    ].join("\n"));

    const evidence = collectDesktopReleaseEvidence({
      channel: "stable",
      publish: "never",
      outputDir,
    }, process.cwd(), {});

    expect(evidence.artifacts.map((artifact) => artifact.name)).toEqual([
      "Job-Decision-Engine-Setup-1.0.0.exe",
      "Job-Decision-Engine-Setup-1.0.0.exe.blockmap",
      "latest.yml",
    ]);
    expect(evidence.updateMetadataMatchesArtifact).toBe(true);
    expect(renderDesktopReleaseEvidence(evidence)).toContain("# Desktop Release Evidence");
  });
});
