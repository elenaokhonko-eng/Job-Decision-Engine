import { describe, expect, it } from "vitest";
import { SourcePluginSchema } from "../../contracts/index.js";
import { buildSourcePlanVersion, parseSourceKeyArgs, sourceNameForPlugin } from "../../../scripts/run_adapters.js";
import { loadStructuredFile } from "../../config/structuredLoader.js";

describe("SMBC schema.org source registration", () => {
  it("loads an inactive-by-default one-posting plugin with explicit lane scope", async () => {
    const plugin = (await loadStructuredFile("config/source-plugins/smbc_careers.yml", SourcePluginSchema)).data;
    expect(plugin).toMatchObject({
      source_key: "smbc_careers",
      kind: "schema_org",
      status: "active",
      schedule: { enabled: false },
      request: { rate_limit: { items_per_run: 1 }, query: { lane_keys: ["CORE_AI_DATA", "INVESTMENT_MARKETS_FINTECH"] } },
    });
    expect(sourceNameForPlugin(plugin)).toBe("MANUAL_IMPORT");
  });

  it("accepts only an explicit valid source key for a scoped source run", () => {
    expect(parseSourceKeyArgs(["--source-key", "smbc_careers"])).toEqual({ sourceKeys: ["smbc_careers"] });
    expect(parseSourceKeyArgs([])).toEqual({});
    expect(() => parseSourceKeyArgs(["--source-key"])).toThrow(/requires a source key/);
    expect(() => parseSourceKeyArgs(["--source-key", "../all"])).toThrow(/valid source key/);
    expect(() => parseSourceKeyArgs(["--source-key", "smbc_careers", "--source-key", "smbc_careers"]))
      .toThrow(/may only be provided once/);
  });

  it("keeps source plan lineage within the database column limit", () => {
    const version = buildSourcePlanVersion("six_lane_sources_v1", "12345678-1234-1234-1234-123456789abc");
    expect(version).toHaveLength(36);
    expect(version.startsWith("six_lane_sources_v1:")).toBe(true);
    expect(buildSourcePlanVersion("six_lane_sources_v1", "another-plugin-revision")).not.toBe(version);
    expect(() => buildSourcePlanVersion("x".repeat(34), "plugin-revision")).toThrow(/at most 33 characters/);
  });
});
