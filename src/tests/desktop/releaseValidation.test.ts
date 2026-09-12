import { describe, expect, it } from "vitest";
import { parseDesktopVersion, validateDesktopRelease } from "../../../scripts/validate_desktop_release.js";

describe("desktop release validation", () => {
  it("parses stable and prerelease desktop versions", () => {
    expect(parseDesktopVersion("1.2.3")).toMatchObject({ prerelease: [] });
    expect(parseDesktopVersion("1.2.3-beta.4")).toMatchObject({ prerelease: ["beta", "4"] });
    expect(parseDesktopVersion("version-one")).toBeNull();
  });

  it("passes non-strict dry-run validation without release secrets", () => {
    const result = validateDesktopRelease({ channel: "stable", publish: "never" }, process.cwd(), {});

    expect(result.failures).toEqual([]);
    expect(result.checks).toContain("desktop release policy schema is v1");
    expect(result.checks).toContain("Windows icon is configured");
  });

  it("rejects a beta channel when package version is not beta prerelease", () => {
    const result = validateDesktopRelease({ channel: "beta", publish: "never" }, process.cwd(), {});

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("beta desktop releases use a beta prerelease version");
  });

  it("fails strict publish validation when signing credentials are absent", () => {
    const result = validateDesktopRelease({ channel: "stable", strict: true, publish: "always" }, process.cwd(), {
      GH_TOKEN: "token",
      JDEC_DESKTOP_ENABLE_UPDATES: "true",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v1.0.0",
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Windows code signing is configured (either SIGNPATH_API_TOKEN or Windows certificate PFX)");
  });

  it("passes strict publish validation with token and signing credentials", () => {
    const result = validateDesktopRelease({ channel: "stable", strict: true, publish: "always" }, process.cwd(), {
      GH_TOKEN: "token",
      WIN_CSC_LINK: "certificate.pfx",
      WIN_CSC_KEY_PASSWORD: "password",
      JDEC_DESKTOP_ENABLE_UPDATES: "true",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v1.0.0",
    });

    expect(result.failures).toEqual([]);
  });

  it("passes strict publish validation with SIGNPATH_API_TOKEN", () => {
    const result = validateDesktopRelease({ channel: "stable", strict: true, publish: "always" }, process.cwd(), {
      GH_TOKEN: "token",
      SIGNPATH_API_TOKEN: "sp_token_secret_12345",
      JDEC_DESKTOP_ENABLE_UPDATES: "true",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v1.0.0",
    });

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects publish validation from a non-matching tag", () => {
    const result = validateDesktopRelease({ channel: "stable", strict: true, publish: "always" }, process.cwd(), {
      GH_TOKEN: "token",
      WINDOWS_CERTIFICATE_BASE64: "base64",
      WINDOWS_CERTIFICATE_PASSWORD: "password",
      JDEC_DESKTOP_ENABLE_UPDATES: "true",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v9.9.9",
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("publish tag matches package version: v1.0.0");
  });
});
