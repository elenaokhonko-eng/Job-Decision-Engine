/** Read-only replay report: every must-be-zero check (counts, sample ids) plus a diagnosis of the violators. Replay branch only. */
import dotenv from "dotenv";

import { withReplaySession } from "../src/reporting/replaySession.js";
import { runZeroChecks } from "../src/tasks/integrityZeroChecks.js";
import { diagnoseViolations } from "../src/tasks/zeroCheckRepair.js";

dotenv.config({ path: [".env.local", ".env"], quiet: true });
await withReplaySession({ readOnly: true }, async ({ client, branchId, workspaceId }) => {
  const checks = await runZeroChecks(client, workspaceId, { phase: "pre" });
  console.log(`branch=${branchId}`);
  for (const check of checks) console.log(JSON.stringify({ name: check.name, total: check.total, detail: check.detail }));
  const diagnoses = await diagnoseViolations(client, workspaceId, checks, ["rejected_job_with_recommendation", "routable_verification_job_stranded"]);
  for (const diagnosis of diagnoses) console.log(JSON.stringify(diagnosis));
});
