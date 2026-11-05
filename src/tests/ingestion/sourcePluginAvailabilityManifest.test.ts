import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { SourcePluginSchema } from "../../contracts/sourcePlugin.js";

const expectedHosts = {
  himalayas: ["himalayas.app", "www.himalayas.app"],
  jobicy: ["jobicy.com", "www.jobicy.com"],
  we_work_remotely: ["weworkremotely.com", "www.weworkremotely.com"],
} as const;

describe("source availability manifest host policy", () => {
  it.each(Object.entries(expectedHosts))("loads exact full-posting hosts for %s", (sourceKey, hosts) => {
    const filePath = path.resolve(process.cwd(), "config", "source-plugins", `${sourceKey}.yml`);
    const sourcePlugin = SourcePluginSchema.parse(load(readFileSync(filePath, "utf8")));

    expect(sourcePlugin.availability?.full_posting_hosts).toEqual(hosts);
  });

  it("rejects wildcard hosts so manifest rules stay exact", () => {
    const filePath = path.resolve(process.cwd(), "config", "source-plugins", "himalayas.yml");
    const sourcePlugin = load(readFileSync(filePath, "utf8")) as Record<string, any>;
    sourcePlugin.availability.full_posting_hosts = ["*.himalayas.app"];

    expect(SourcePluginSchema.safeParse(sourcePlugin).success).toBe(false);
  });
});
