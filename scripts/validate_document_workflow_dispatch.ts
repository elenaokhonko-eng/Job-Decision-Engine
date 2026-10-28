import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDocumentWorkflowDispatchFailure } from "../src/services/documentWorkflowDispatchPolicy.js";

function main(): void {
  const failure = getDocumentWorkflowDispatchFailure({
    repositoryPrivate: process.env.REPOSITORY_PRIVATE === "true",
    requestedRef: process.env.REQUESTED_REF ?? "",
    canonicalJobId: process.env.INPUT_CANONICAL_JOB_ID ?? "",
    jobVersionId: process.env.INPUT_JOB_VERSION_ID ?? "",
    applicationRecordId: process.env.INPUT_APPLICATION_RECORD_ID ?? "",
  });
  if (failure) {
    console.error(failure);
    process.exitCode = 1;
    return;
  }
  console.log("Document workflow dispatch is scoped to a private repository and reviewed main.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
