import dotenv from "dotenv";

import { checkConfiguredModelIds, configuredModelIds } from "../src/services/modelIdPreflight.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

/**
 * npm run models:check — lists each provider's available model ids and compares the configured
 * ones. Exits 1 when a configured id is unknown or a provider with a key could not be checked.
 */
async function main(): Promise<void> {
  const result = await checkConfiguredModelIds();

  for (const entry of result.unknown) console.error(entry.message);
  for (const warning of result.warnings) console.error(`Warning: ${warning}`);
  for (const provider of result.skipped) console.log(`Skipped ${provider}: no API key configured.`);

  if (result.checked.length > 0) {
    const checkedIds = configuredModelIds().filter((entry) => result.checked.includes(entry.provider));
    const unknownCount = result.unknown.length;
    console.log(
      `Checked ${checkedIds.length} configured model id(s) against ${result.checked.join(", ")}: ` +
        (unknownCount === 0 ? "all available." : `${unknownCount} not available.`)
    );
  }

  if (result.unknown.length > 0 || result.warnings.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Model id check failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
