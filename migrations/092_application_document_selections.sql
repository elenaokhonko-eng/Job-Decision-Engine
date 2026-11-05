-- Migration 092: link manually prepared documents to the application tracker, on the user's
-- explicit choice only.
--
-- Each row pins one approved CV and cover letter pair (both document runs and the SHA-256 of all
-- four stored files), so the tracker always opens exactly the version the user chose, even after
-- the job, profile or requirements change. Rows are append-only: choosing other documents adds a
-- row, and the latest row per application is the current choice. Linking never records a
-- submission; the application's status is left to the user.

CREATE TABLE IF NOT EXISTS application_document_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  application_record_id UUID NOT NULL REFERENCES application_records(id) ON DELETE RESTRICT,
  canonical_job_id UUID NOT NULL,
  job_version_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  cv_document_run_id UUID NOT NULL,
  cover_letter_document_run_id UUID NOT NULL,
  cv_docx_sha256 TEXT NOT NULL CHECK (cv_docx_sha256 ~ '^[0-9a-f]{64}$'),
  cv_pdf_sha256 TEXT NOT NULL CHECK (cv_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  cover_letter_docx_sha256 TEXT NOT NULL CHECK (cover_letter_docx_sha256 ~ '^[0-9a-f]{64}$'),
  cover_letter_pdf_sha256 TEXT NOT NULL CHECK (cover_letter_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  -- APPLY_NOW_READY when the job version was a current READY Apply Now decision at selection time;
  -- USER_SELECTED when the user linked it anyway (Verify, then apply, or a pasted posting).
  pipeline_readiness TEXT NOT NULL CHECK (pipeline_readiness IN ('APPLY_NOW_READY', 'USER_SELECTED')),
  selected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT application_document_selections_approval_fk
    FOREIGN KEY (approval_id, workspace_id, user_id)
    REFERENCES manual_application_preparation_approvals (id, workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT application_document_selections_cv_run_fk
    FOREIGN KEY (cv_document_run_id, workspace_id)
    REFERENCES manual_application_document_runs (id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT application_document_selections_cover_letter_run_fk
    FOREIGN KEY (cover_letter_document_run_id, workspace_id)
    REFERENCES manual_application_document_runs (id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_application_document_selections_application
  ON application_document_selections (workspace_id, application_record_id, selected_at DESC, id DESC);

-- The pinned runs and hashes must be exactly the stored outputs of the chosen approval, for the
-- application's own job version.
CREATE OR REPLACE FUNCTION application_document_selections_validate()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM application_records application
    WHERE application.id = NEW.application_record_id
      AND application.workspace_id = NEW.workspace_id
      AND application.user_id = NEW.user_id
      AND application.canonical_job_id = NEW.canonical_job_id
      AND application.job_version_id = NEW.job_version_id
  ) THEN
    RAISE EXCEPTION 'Document selection does not match its application record.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM manual_application_document_runs cv
    JOIN manual_application_document_runs letter
      ON letter.id = NEW.cover_letter_document_run_id AND letter.workspace_id = cv.workspace_id
    WHERE cv.id = NEW.cv_document_run_id
      AND cv.workspace_id = NEW.workspace_id AND cv.user_id = NEW.user_id
      AND cv.approval_id = NEW.approval_id AND cv.document_type = 'CV'
      AND letter.user_id = NEW.user_id AND letter.approval_id = NEW.approval_id
      AND letter.document_type = 'COVER_LETTER'
      AND cv.canonical_job_id = NEW.canonical_job_id AND cv.job_version_id = NEW.job_version_id
  ) THEN
    RAISE EXCEPTION 'Document selection runs are not the CV and cover letter of the chosen approval for this job version.';
  END IF;
  IF (
    SELECT count(*) FROM manual_application_document_artifacts artifact
    WHERE artifact.workspace_id = NEW.workspace_id AND artifact.approval_id = NEW.approval_id
      AND (artifact.document_type, artifact.format, artifact.document_run_id, artifact.sha256) IN (
        ('CV', 'DOCX', NEW.cv_document_run_id, NEW.cv_docx_sha256),
        ('CV', 'PDF', NEW.cv_document_run_id, NEW.cv_pdf_sha256),
        ('COVER_LETTER', 'DOCX', NEW.cover_letter_document_run_id, NEW.cover_letter_docx_sha256),
        ('COVER_LETTER', 'PDF', NEW.cover_letter_document_run_id, NEW.cover_letter_pdf_sha256))
  ) <> 4 THEN
    RAISE EXCEPTION 'Document selection hashes do not match the stored files of the chosen approval.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION application_document_selections_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'application_document_selections is append-only; choose other documents by adding a row.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS application_document_selections_validate ON application_document_selections;
CREATE TRIGGER application_document_selections_validate
  BEFORE INSERT ON application_document_selections
  FOR EACH ROW EXECUTE FUNCTION application_document_selections_validate();

DROP TRIGGER IF EXISTS application_document_selections_append_only ON application_document_selections;
CREATE TRIGGER application_document_selections_append_only
  BEFORE UPDATE OR DELETE ON application_document_selections
  FOR EACH ROW EXECUTE FUNCTION application_document_selections_append_only();

-- The current choice per application, for the tracker.
CREATE OR REPLACE VIEW v_application_document_selection_current AS
SELECT DISTINCT ON (selection.workspace_id, selection.application_record_id)
  selection.id AS selection_id,
  selection.workspace_id,
  selection.user_id,
  selection.application_record_id,
  selection.canonical_job_id,
  selection.job_version_id,
  selection.approval_id,
  selection.cv_document_run_id,
  selection.cover_letter_document_run_id,
  selection.cv_docx_sha256,
  selection.cv_pdf_sha256,
  selection.cover_letter_docx_sha256,
  selection.cover_letter_pdf_sha256,
  selection.pipeline_readiness,
  selection.selected_at
FROM application_document_selections selection
ORDER BY selection.workspace_id, selection.application_record_id, selection.selected_at DESC, selection.id DESC;

COMMENT ON TABLE application_document_selections IS
  'Append-only, user-chosen CV and cover letter pairs for an application, pinned by document run and file hash. Never records a submission.';
COMMENT ON VIEW v_application_document_selection_current IS
  'The latest user-chosen document pair per application record.';
