import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('streamlit read-model integrity', () => {
  it('uses API v2 shortlist/rejected endpoints as the primary boundary', () => {
    const appPath = path.resolve(process.cwd(), 'streamlit_app.py');
    const content = fs.readFileSync(appPath, 'utf8');

    expect(content).toContain('/api/v2/shortlist');
    expect(content).toContain('/api/v2/rejected');
    expect(content).toContain('/api/v2/preference-modes/preview');
  });

  it('uses only canonical read-model views for the hosted read-only fallback', () => {
    const appPath = path.resolve(process.cwd(), 'streamlit_app.py');
    const content = fs.readFileSync(appPath, 'utf8');

    expect(content).toContain('FROM v_canonical_shortlist_actions_scoped');
    expect(content).toContain('FROM v_rejected_jobs_audit_scoped');
    expect(content).toContain('set_session(readonly=True, autocommit=True)');
    expect(content).toContain('read_only_database_ssl_options(');
    expect(content).toContain('allow_local_postgres=allow_local_postgres');
    const databasePath = path.resolve(process.cwd(), 'streamlit_database.py');
    const databaseContent = fs.readFileSync(databasePath, 'utf8');
    expect(databaseContent).toContain('"sslmode": "verify-full"');
    expect(databaseContent).toContain('"sslmode": "disable"');
    expect(databaseContent).toContain('hostname in _LOCAL_DATABASE_HOSTS');
    expect(content).toContain('DATABASE_URL');
    expect(content).not.toContain('INSERT INTO canonical_jobs');
    expect(content).not.toContain('UPDATE canonical_jobs');
    expect(content).not.toContain('DELETE FROM canonical_jobs');
    expect(content).not.toContain('JOIN canonical_jobs');
    expect(content).toContain('JDEC_API_BASE_URL');
    expect(content).toContain('current_artifact_status');
    expect(content).toContain('requires_user_action');
    expect(content).toContain('pipeline_display_category');
    expect(content).toContain('application_api_path');
    expect(content).toMatch(/st\.checkbox\(\s*"Include TRACK jobs",\s*value=False,/);
    expect(content).toContain('if is_document_generation_eligible(job, include_track=include_track_jobs)');
    expect(content).toContain('from streamlit_formatters import as_number, format_percent, format_score, format_signal');
    expect(content).toContain('is_document_generation_eligible');
    expect(content).toContain('FROM v_application_workspace_summary_scoped');
    expect(content).toContain('FROM v_top_ten_ready_jobs_stage3_scoped');
    expect(content).toContain('FROM v_apply_now_jobs_stage3_scoped');
    expect(content).toContain('final_application_priority_score');
    expect(content).toContain('stage3_preference_context_id');
    expect(content).toContain('employment_verifiability_score');
    expect(content).toContain('FROM v_track_jobs_scoped');
    expect(content).toContain('FROM v_job_profile_evidence_scoped');
    expect(content).toContain('FROM v_profile_coverage_scoped');
    expect(content).toContain('FROM v_company_culture_analytics_scoped');
    expect(content).toContain('st.markdown("## Top 10 — apply first")');
    expect(content).toContain('"Top 10 Ready": application_workspace_summary["top_ten_ready_count"]');
    expect(content).toContain('"Apply Now": application_workspace_summary["apply_now_count"]');
    expect(content).toContain('"Track": application_workspace_summary["track_count"]');
    expect(content).toContain('"Processing": application_workspace_summary["processing_count"]');
    expect(content).toContain('"Rejected / Unmatched": application_workspace_summary["rejected_unmatched_count"]');
    expect(content).toContain('"Applied": application_workspace_summary["applied_count"]');
    expect(content).toContain('"Technical Errors": application_workspace_summary["technical_errors"]');
    expect(content).toContain('for metric_label, metric_value in metric_values.items():');
    expect(content).not.toContain('st.sidebar.metric("Recommended"');
    expect(content).not.toContain('st.sidebar.metric("Total Vault Jobs"');
    expect(content).not.toContain('verify_count');
    expect(content).not.toContain('http://localhost:3000');
  });

  it('api v2 reads from canonical PostgreSQL views', () => {
    const routerPath = path.resolve(process.cwd(), 'src', 'api', 'v2', 'router.ts');
    const content = fs.readFileSync(routerPath, 'utf8');

    expect(content).toContain('FROM v_canonical_shortlist_actions_scoped');
    expect(content).toContain('FROM v_rejected_jobs_audit_scoped');
  });
});
