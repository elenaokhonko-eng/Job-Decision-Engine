export interface DocumentWorkflowDispatch {
  readonly repositoryPrivate: boolean;
  readonly requestedRef: string;
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly applicationRecordId: string;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export function getDocumentWorkflowDispatchFailure(
  dispatch: DocumentWorkflowDispatch,
): string | null {
  if (!dispatch.repositoryPrivate) {
    return "Document workflows are disabled for public repositories because generated application documents are sensitive.";
  }
  if (dispatch.requestedRef !== "refs/heads/main") {
    return "Document workflows may only use reviewed code from main.";
  }
  if (
    !UUID_PATTERN.test(dispatch.canonicalJobId)
    || !UUID_PATTERN.test(dispatch.jobVersionId)
    || !UUID_PATTERN.test(dispatch.applicationRecordId)
  ) {
    return "canonical_job_id, job_version_id, and application_record_id must all be valid UUIDs.";
  }
  return null;
}
