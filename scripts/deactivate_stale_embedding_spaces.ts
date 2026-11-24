/**
 * Deactivates a stale embedding space (src/embeddings/staleSpaces.ts owns the query). Replay branch only.
 * Dry run by default. The function itself enforces only confirm: true; this path adds the branch and
 * environment guards. --apply needs EMBEDDING_SPACE_DEACTIVATE_ALLOWED=true and --confirm-workspace=<id>.
 */
import dotenv from "dotenv";

import { runStaleSpaceDeactivation } from "../src/embeddings/deactivationRun.js";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
const argv = process.argv.slice(2);
await runStaleSpaceDeactivation({ apply: argv.includes("--apply"), argv, env: process.env });
