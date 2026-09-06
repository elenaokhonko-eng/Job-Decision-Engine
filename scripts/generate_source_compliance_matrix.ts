import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { loadStructuredFile } from "../src/config/structuredLoader.js";
import { SourcePluginSchema } from "../src/contracts/index.js";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

async function main(): Promise<void> {
  const pluginsDir = path.resolve(process.cwd(), "config", "source-plugins");
  const outPath = path.resolve(process.cwd(), "docs", "source-compliance-matrix.md");

  if (!fs.existsSync(pluginsDir)) {
    throw new Error(`Missing directory: ${pluginsDir}`);
  }

  const files = fs
    .readdirSync(pluginsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => path.join(pluginsDir, f));

  const plugins = [];
  for (const filePath of files) {
    const loaded = await loadStructuredFile(filePath, SourcePluginSchema);
    plugins.push(loaded.data);
  }

  const lines: string[] = [];
  lines.push("# Source Compliance Matrix");
  lines.push("");
  lines.push(
    "This table is generated from `config/source-plugins/*.yml`. It helps non-engineers quickly understand where job data comes from and the compliance basis for each connector."
  );
  lines.push("");
  lines.push("Regenerate with:");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run docs:compliance");
  lines.push("```");
  lines.push("");
  lines.push(
    "| source_key | display_name | kind | access_basis | terms_url | attribution_required | authenticated_scraping | reviewed_at | interval_minutes |"
  );
  lines.push("|---|---|---|---|---|---:|---:|---|---:|");

  for (const p of plugins) {
    lines.push(
      `| ${escapePipes(p.source_key)} | ${escapePipes(p.display_name)} | ${p.kind} | ${p.compliance.access_basis} | ${escapePipes(
        p.compliance.terms_url
      )} | ${p.compliance.attribution_required ? "yes" : "no"} | ${p.compliance.authenticated_scraping ? "yes" : "no"} | ${
        (p.compliance as any).reviewed_at || ""
      } | ${p.schedule.interval_minutes} |`
    );
  }

  fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");
  console.log(`Wrote ${outPath} (${plugins.length} sources).`);
}

if (process.argv[1] && process.argv[1].includes("generate_source_compliance_matrix")) {
  main().catch((err) => {
    console.error("generate_source_compliance_matrix failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

