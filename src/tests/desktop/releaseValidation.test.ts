import { describe, expect, it } from "vitest";
import { validateDesktopRelease } from "../../../scripts/validate_desktop_release.js";

describe("desktop release validation", () => {
  it("passes non-strict dry-run validation without release secrets", () => {
    const result = validateDesktopRelease({ channel: "stable", publish: "never" }, process.cwd(), {});

    expect(result.failures).toEqual([]);
    expect(result.checks).toContain("desktop release policy schema is v1");
    expect(result.checks).toContain("Windows icon is configured");
  });

  it("fails strict publish validation when signing credentials are absent", () => {
    const result = validateDesktopRelease({ channel: "stable", strict: true, publish: "always" }, process.cwd(), {
      GH_TOKEN: "token",
      JDEC_DESKTOP_ENABLE_UPDATES: "true",
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Windows code signing certificate and password are configured");
  });

  it("passes strict publish validation with token and signing credentials", () => {
    const result = validateDesktopRelease({ channel: "stable", strict: true, publish: "always" }, process.cwd(), {
      GH_TOKEN: "token",
      WINDOWS_CERTIFICATE_BASE64: "base64",
      WINDOWS_CERTIFICATE_PASSWORD: "password",
      JDEC_DESKTOP_ENABLE_UPDATES: "true",
    });

    expect(result.failures).toEqual([]);
  });
});
