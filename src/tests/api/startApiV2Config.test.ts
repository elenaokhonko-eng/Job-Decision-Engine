import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("managed API listener configuration", () => {
  it("supports a non-loopback bind host for managed deployments", () => {
    const source = readFileSync(resolve("scripts/start_api_v2.ts"), "utf8");

    expect(source).toContain("process.env.API_HOST");
    expect(source).toContain('(process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1")');
    expect(source).toContain("app.listen(port, host");
  });
});
