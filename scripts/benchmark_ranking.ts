/**
 * Ranking benchmark over a synthetic fixture. Information only: it prints a
 * Markdown table and exits 0 whether the ranking is better or worse than the
 * baseline. It exits 1 only when the fixture or baseline file is unusable,
 * because then the tool itself is broken.
 *
 *   npm run benchmark:ranking                      # Markdown to stdout
 *   npm run benchmark:ranking -- --json            # JSON to stdout
 *   npm run benchmark:ranking -- --write-baseline  # record the current figures as the baseline
 *
 * No database, network or secrets are used.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  compareToBaseline,
  formatBenchmarkMarkdown,
  runRankingBenchmark,
  type RankingBenchmarkReport,
} from "../src/reporting/rankingBenchmark.js";

const FIXTURE_PATH = path.resolve("fixtures", "ranking_benchmark.json");
const BASELINE_PATH = path.resolve("fixtures", "ranking_benchmark_baseline.json");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readBaseline(): RankingBenchmarkReport | null {
  try {
    return readJson(BASELINE_PATH) as RankingBenchmarkReport;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function main(): void {
  const report = runRankingBenchmark(readJson(FIXTURE_PATH));
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.error("Baseline written.");
    return;
  }
  const comparison = compareToBaseline(report, readBaseline());
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify({ report, comparison }, null, 2)
      : formatBenchmarkMarkdown(report, comparison),
  );
}

try {
  main();
} catch (error) {
  console.error(`Ranking benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
