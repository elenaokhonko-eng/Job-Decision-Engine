import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { JobDecisionClient, type PipelineTaskRow, type SourceHealthRow } from "./sdk/index.js";
import type { ApplicationRecord, ShortlistRow } from "./contracts/index.js";
import {
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  loadDesktopSettingsSecure,
  normalizeDesktopSettings,
  redactSecret,
  saveDesktopSettingsSecure,
  type DesktopSettings,
} from "./desktop/settings.js";
import {
  getNativeRuntimeBridge,
  getNativeApiBridge,
  getNativeSecretStore,
  nativeDefaultApiBaseUrl,
  type DesktopRuntimeStatus,
} from "./desktop/nativeBridge.js";
import {
  formatRelativeTime,
  jobOutcomeLabel,
  safeExternalHref,
  summarizeDesktopCounts,
} from "./desktop/viewModel.js";
import { SetupWizard } from "./desktop/SetupWizard.js";

type ViewKey = "overview" | "jobs" | "applications" | "sources" | "tasks" | "settings";

interface ToastState {
  kind: "ok" | "error";
  message: string;
}

interface HealthState {
  ok: boolean;
  timestamp?: string;
  workspace_key?: string;
  user_key?: string;
}

const navItems: Array<{ key: ViewKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "jobs", label: "Shortlist" },
  { key: "applications", label: "Applications" },
  { key: "sources", label: "Sources" },
  { key: "tasks", label: "Tasks" },
  { key: "settings", label: "Settings" },
];

const blankManualObservation = {
  title: "",
  company: "",
  description: "",
  location: "",
  careers_portal_url: "",
};

function getBrowserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function getInitialDesktopSettings(): DesktopSettings {
  const storage = getBrowserStorage();
  const loaded = loadDesktopSettings(storage);
  const nativeSecretStore = getNativeSecretStore();
  const nativeApiBaseUrl = nativeDefaultApiBaseUrl();
  return normalizeDesktopSettings(
    nativeSecretStore
      ? {
          ...loaded,
          apiToken: "",
          ...(nativeApiBaseUrl && loaded.apiBaseUrl === DEFAULT_DESKTOP_SETTINGS.apiBaseUrl
            ? { apiBaseUrl: nativeApiBaseUrl }
            : {}),
        }
      : nativeApiBaseUrl && loaded.apiBaseUrl === DEFAULT_DESKTOP_SETTINGS.apiBaseUrl
        ? { ...loaded, apiBaseUrl: nativeApiBaseUrl }
      : loaded
  );
}

function compactDate(value: string | null | undefined): string {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function scorePercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  return `${Math.round(value * 100)}%`;
}

function statusTone(value: string | null | undefined): string {
  const status = (value || "").toUpperCase();
  if (["ACTIVE", "COMPLETED", "SUBMITTED", "PRIORITY", "PASS", "ELIGIBLE"].includes(status)) return "good";
  if (["PENDING", "RUNNING", "RETRY_WAIT", "BLOCKED_DEPENDENCY", "MATCH_STALE", "DECISION_STALE", "EVALUATION_MISSING", "EVALUATION_STALE", "READY_TO_APPLY", "FOLLOW_UP", "VERIFY", "NEEDS_VERIFICATION"].includes(status)) return "warn";
  if (["FAILED", "DEAD_LETTER", "HARD_REJECT", "REJECTED", "WITHDRAWN"].includes(status)) return "bad";
  return "muted";
}

function uniqueApplicationJobIds(applications: ApplicationRecord[]): Set<string> {
  return new Set(applications.map((application) => application.canonical_job_id));
}

export default function App() {
  const [settings, setSettings] = useState<DesktopSettings>(getInitialDesktopSettings);
  const [draftSettings, setDraftSettings] = useState<DesktopSettings>(settings);
  const [nativeStatus, setNativeStatus] = useState<DesktopRuntimeStatus | null>(null);
  const [clearStoredToken, setClearStoredToken] = useState(false);
  const [activeView, setActiveView] = useState<ViewKey>("overview");
  const [health, setHealth] = useState<HealthState | null>(null);
  const [jobs, setJobs] = useState<ShortlistRow[]>([]);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [sources, setSources] = useState<SourceHealthRow[]>([]);
  const [tasks, setTasks] = useState<PipelineTaskRow[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [manualObservation, setManualObservation] = useState(blankManualObservation);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [setupStatus, setSetupStatus] = useState<any>(null);
  const nativeApi = getNativeApiBridge();

  const client = useMemo(
    () =>
      new JobDecisionClient({
        baseUrl: settings.apiBaseUrl,
        token: settings.apiToken || undefined,
        workspaceKey: settings.workspaceKey,
        userKey: settings.userKey,
        nativeApiRequest: nativeApi?.request
          ? (path, init, context) => nativeApi.request({ ...context, path, ...init })
          : undefined,
      }),
    [settings, nativeApi]
  );

  const counts = useMemo(
    () => summarizeDesktopCounts(jobs, applications, tasks, sources),
    [jobs, applications, tasks, sources]
  );
  const applicationJobIds = useMemo(() => uniqueApplicationJobIds(applications), [applications]);
  const selectedJob = jobs.find((job) => job.canonical_job_id === selectedJobId) ?? jobs[0] ?? null;

  const refreshNativeStatus = useCallback(async () => {
    const runtime = getNativeRuntimeBridge();
    if (!runtime) return;
    const status = await runtime.getStatus().catch(() => null);
    if (status) setNativeStatus(status);
  }, []);

  const checkSetupStatus = useCallback(async () => {
    try {
      let data: any = null;
      if (nativeApi) {
        const res = await nativeApi.request({
          apiBaseUrl: settings.apiBaseUrl,
          path: "/setup/status",
          method: "GET",
        });
        if (res.status === 200) data = JSON.parse(res.body);
      } else {
        const res = await fetch(`${settings.apiBaseUrl}/setup/status`);
        if (res.ok) data = await res.json();
      }
      if (data) {
        setSetupStatus(data);
        if (!data.database?.isInitialized || (data.database?.pendingMigrations ?? 0) > 0) {
          setShowSetupWizard(true);
        }
      }
    } catch {
      // setup status check is non-fatal
    }
  }, [nativeApi, settings.apiBaseUrl]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setToast(null);
    try {
      await refreshNativeStatus();
      await checkSetupStatus();
      const healthRes = await client.getHealth();
      setHealth(healthRes);

      const [shortlistRes, applicationRes, sourceRes, taskRes] = await Promise.allSettled([
        client.listShortlist({ limit: 100 }),
        client.listApplications({ limit: 100 }),
        client.listSourceHealth(),
        client.listTasks({ limit: 50 }),
      ]);

      const errors: string[] = [];
      if (shortlistRes.status === "fulfilled") {
        setJobs(shortlistRes.value.jobs);
        if (!selectedJobId && shortlistRes.value.jobs.length > 0) {
          setSelectedJobId(shortlistRes.value.jobs[0].canonical_job_id);
        }
      } else {
        errors.push(shortlistRes.reason instanceof Error ? shortlistRes.reason.message : String(shortlistRes.reason));
      }
      if (applicationRes.status === "fulfilled") {
        setApplications(applicationRes.value.applications);
      } else {
        errors.push(applicationRes.reason instanceof Error ? applicationRes.reason.message : String(applicationRes.reason));
      }
      if (sourceRes.status === "fulfilled") {
        setSources(sourceRes.value.sources);
      } else {
        errors.push(sourceRes.reason instanceof Error ? sourceRes.reason.message : String(sourceRes.reason));
      }
      if (taskRes.status === "fulfilled") {
        setTasks(taskRes.value.tasks);
      } else {
        errors.push(taskRes.reason instanceof Error ? taskRes.reason.message : String(taskRes.reason));
      }

      setToast(errors.length > 0
        ? { kind: "error", message: errors.slice(0, 2).join(" | ") }
        : { kind: "ok", message: "Workspace refreshed." });
    } catch (error) {
      setHealth(null);
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [client, refreshNativeStatus, selectedJobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void loadDesktopSettingsSecure(
      getBrowserStorage(),
      getNativeSecretStore(),
      nativeDefaultApiBaseUrl()
    ).then((loaded) => {
      if (cancelled) return;
      setSettings(loaded);
      setDraftSettings(loaded);
    });
    void refreshNativeStatus();
    return () => {
      cancelled = true;
    };
  }, [refreshNativeStatus]);

  async function createApplicationHandoff(job: ShortlistRow): Promise<void> {
    setLoading(true);
    setToast(null);
    try {
      const response = await client.createApplication({
        canonical_job_id: job.canonical_job_id,
        job_version_id: job.job_version_id,
        status: "READY_TO_APPLY",
        submission_url: safeExternalHref(job.canonical_url),
        cv_document_run_id: job.cv_document_run_id,
        cover_letter_document_run_id: job.cover_letter_document_run_id,
        notes: job.document_ready ? "Documents ready." : "Application handoff staged.",
        handoff_payload: {
          recommendation_outcome: job.recommendation_outcome,
          primary_lane: job.primary_lane,
          document_ready: job.document_ready,
        },
      });
      setApplications((current) => {
        const rest = current.filter((application) => application.application_record_id !== response.application.application_record_id);
        return [response.application, ...rest];
      });
      setActiveView("applications");
      setToast({ kind: "ok", message: "Application handoff created." });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  async function updateApplicationStatus(application: ApplicationRecord, status: ApplicationRecord["application_status"]): Promise<void> {
    setLoading(true);
    setToast(null);
    try {
      const response = await client.updateApplication(application.application_record_id, { status });
      setApplications((current) =>
        current.map((item) =>
          item.application_record_id === response.application.application_record_id ? response.application : item
        )
      );
      setToast({ kind: "ok", message: `Application moved to ${status}.` });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  async function submitManualObservation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setToast(null);
    try {
      await client.createManualObservation({
        title: manualObservation.title,
        company: manualObservation.company,
        description: manualObservation.description,
        source: "DESKTOP_MANUAL",
        location: manualObservation.location || undefined,
        careers_portal_url: safeExternalHref(manualObservation.careers_portal_url) ?? undefined,
      });
      setManualObservation(blankManualObservation);
      setToast({ kind: "ok", message: "Manual observation staged." });
      await refresh();
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  async function submitSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setToast(null);
    try {
      const normalized = await saveDesktopSettingsSecure(
        getBrowserStorage(),
        getNativeSecretStore(),
        normalizeDesktopSettings(draftSettings),
        {
          preserveExistingToken: Boolean(
            nativeApi &&
            !clearStoredToken
          ),
        }
      );
      setSettings(normalized);
      setDraftSettings(normalized);
      setClearStoredToken(false);
      await refreshNativeStatus();
      setToast({ kind: "ok", message: "Settings saved." });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="desktop-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">JD</div>
          <div>
            <h1>Job Decision Engine</h1>
            <p>{health?.workspace_key ?? settings.workspaceKey}</p>
          </div>
        </div>
        <nav className="nav-list" aria-label="Desktop sections">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={activeView === item.key ? "nav-item active" : "nav-item"}
              onClick={() => setActiveView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`status-dot ${health?.ok ? "good" : "bad"}`} />
          <span>{health?.ok ? "API connected" : "API offline"}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeView}</p>
            <h2>{activeView === "overview" ? "Command Center" : navItems.find((item) => item.key === activeView)?.label}</h2>
          </div>
          <div className="topbar-actions">
            {health?.timestamp ? <span className="muted-text">Updated {formatRelativeTime(health.timestamp)}</span> : null}
            <button type="button" className="button secondary" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </button>
          </div>
        </header>

        {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}

        {activeView === "overview" ? (
          <section className="overview-grid">
            <Metric label="Shortlist" value={counts.totalJobs} detail={`${counts.priorityJobs} priority`} />
            <Metric label="Verification" value={counts.needsVerificationJobs} detail="needs review" />
            <Metric label="Applications" value={counts.activeApplications} detail={`${counts.submittedApplications} submitted`} />
            <Metric label="Tasks" value={counts.runningTasks} detail="active or waiting" />
            <div className="panel wide">
              <PanelHeader title="Priority Shortlist" actionLabel="View all" onAction={() => setActiveView("jobs")} />
              <JobList jobs={jobs.slice(0, 6)} selectedJobId={selectedJobId} onSelect={setSelectedJobId} />
            </div>
            <div className="panel">
              <PanelHeader title="Open Applications" actionLabel="View" onAction={() => setActiveView("applications")} />
              <ApplicationList applications={applications.slice(0, 5)} onStatusChange={(application, status) => void updateApplicationStatus(application, status)} />
            </div>
          </section>
        ) : null}

        {activeView === "jobs" ? (
          <section className="split-view">
            <div className="panel">
              <PanelHeader title="Shortlist" actionLabel="Refresh" onAction={() => void refresh()} />
              <JobList jobs={jobs} selectedJobId={selectedJob?.canonical_job_id ?? null} onSelect={setSelectedJobId} />
            </div>
            <div className="panel detail-panel">
              {selectedJob ? (
                <JobDetail
                  job={selectedJob}
                  hasApplication={applicationJobIds.has(selectedJob.canonical_job_id)}
                  onCreateApplication={() => void createApplicationHandoff(selectedJob)}
                />
              ) : (
                <EmptyState title="No shortlist rows" detail="The pipeline has not produced current shortlist data yet." />
              )}
            </div>
          </section>
        ) : null}

        {activeView === "applications" ? (
          <section className="panel">
            <PanelHeader title="Application Tracker" actionLabel="Refresh" onAction={() => void refresh()} />
            <ApplicationList applications={applications} onStatusChange={(application, status) => void updateApplicationStatus(application, status)} />
          </section>
        ) : null}

        {activeView === "sources" ? (
          <section className="panel">
            <PanelHeader title="Source Manager" actionLabel="Refresh" onAction={() => void refresh()} />
            <SourceTable sources={sources} />
            <form className="manual-form" onSubmit={(event) => void submitManualObservation(event)}>
              <h3>Manual Observation</h3>
              <div className="form-grid">
                <label>
                  <span>Title</span>
                  <input value={manualObservation.title} onChange={(event) => setManualObservation({ ...manualObservation, title: event.target.value })} required />
                </label>
                <label>
                  <span>Company</span>
                  <input value={manualObservation.company} onChange={(event) => setManualObservation({ ...manualObservation, company: event.target.value })} required />
                </label>
                <label>
                  <span>Location</span>
                  <input value={manualObservation.location} onChange={(event) => setManualObservation({ ...manualObservation, location: event.target.value })} />
                </label>
                <label>
                  <span>Apply URL</span>
                  <input value={manualObservation.careers_portal_url} onChange={(event) => setManualObservation({ ...manualObservation, careers_portal_url: event.target.value })} />
                </label>
              </div>
              <label>
                <span>Description</span>
                <textarea value={manualObservation.description} onChange={(event) => setManualObservation({ ...manualObservation, description: event.target.value })} required rows={6} />
              </label>
              <button type="submit" className="button primary" disabled={loading}>
                Stage Observation
              </button>
            </form>
          </section>
        ) : null}

        {activeView === "tasks" ? (
          <section className="panel">
            <PanelHeader title="Pipeline Tasks" actionLabel="Refresh" onAction={() => void refresh()} />
            <TaskTable tasks={tasks} />
          </section>
        ) : null}

        {activeView === "settings" ? (
          <section className="panel settings-panel">
            <PanelHeader title="Standalone Desktop Configuration" />
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4 mb-6">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-semibold text-slate-900 text-sm">Neon Database & Local Engine</h4>
                  <p className="text-xs text-slate-500">
                    Runs locally on your machine with direct connection to your private Neon PostgreSQL database.
                  </p>
                </div>
                <button
                  type="button"
                  className="button primary text-xs"
                  onClick={() => setShowSetupWizard(true)}
                >
                  Open Setup Wizard
                </button>
              </div>

              <div className="settings-summary-grid">
                <Info
                  label="Database"
                  value={setupStatus?.database?.connected ? "Connected" : "Not connected"}
                />
                <Info
                  label="Schema Migrations"
                  value={
                    setupStatus?.database?.isInitialized
                      ? `${setupStatus.database.appliedMigrations} applied`
                      : "Uninitialized"
                  }
                />
                <Info
                  label="Gemini AI"
                  value={
                    setupStatus?.ai?.geminiConfigured || nativeStatus?.hasGeminiApiKey
                      ? "Configured"
                      : "Not set"
                  }
                />
                <Info
                  label="OpenAI"
                  value={
                    setupStatus?.ai?.openaiConfigured || nativeStatus?.hasOpenaiApiKey
                      ? "Configured"
                      : "Not set"
                  }
                />
              </div>
            </div>

            <PanelHeader title="Advanced Connection Settings" />
            <form onSubmit={(event) => void submitSettings(event)} className="settings-form">
              <label>
                <span>API base URL (Default: local companion runtime)</span>
                <input value={draftSettings.apiBaseUrl} onChange={(event) => setDraftSettings({ ...draftSettings, apiBaseUrl: event.target.value })} placeholder="http://127.0.0.1:3210/api/v2" />
              </label>
              <label>
                <span>API token (Optional for local companion)</span>
                <input type="password" value={draftSettings.apiToken} onChange={(event) => {
                  setClearStoredToken(false);
                  setDraftSettings({ ...draftSettings, apiToken: event.target.value });
                }} />
              </label>
              {nativeApi && nativeStatus?.apiTokenConfigured ? (
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => {
                    setClearStoredToken(true);
                    setDraftSettings({ ...draftSettings, apiToken: "" });
                  }}
                >
                  Clear stored token
                </button>
              ) : null}
              <div className="form-grid">
                <label>
                  <span>Workspace key</span>
                  <input value={draftSettings.workspaceKey} onChange={(event) => setDraftSettings({ ...draftSettings, workspaceKey: event.target.value })} />
                </label>
                <label>
                  <span>User key</span>
                  <input value={draftSettings.userKey} onChange={(event) => setDraftSettings({ ...draftSettings, userKey: event.target.value })} />
                </label>
              </div>
              <div className="settings-summary-grid">
                <Info label="Native Shell" value={nativeStatus ? (nativeStatus.isPackaged ? "Packaged" : "Development") : "Browser"} />
                <Info label="Channel" value={nativeStatus?.releaseChannel ?? "Local"} />
                <Info label="Secret Storage" value={nativeStatus ? (nativeStatus.safeStorageAvailable ? "OS backed" : "Unavailable") : "Browser storage"} />
                <Info label="API transport" value={nativeApi ? "Authenticated main-process bridge" : "Browser fetch"} />
                <Info label="Updates" value={nativeStatus?.updatesEnabled ? "Enabled" : "Disabled"} />
              </div>
              <button type="submit" className="button primary">Save Advanced Settings</button>
            </form>
          </section>
        ) : null}
      </section>

      {showSetupWizard ? (
        <SetupWizard
          onComplete={() => {
            setShowSetupWizard(false);
            void checkSetupStatus();
            void refresh();
          }}
          onCancel={setupStatus?.database?.isInitialized ? () => setShowSetupWizard(false) : undefined}
        />
      ) : null}
    </main>
  );
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function PanelHeader({ title, actionLabel, onAction }: { title: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="panel-header">
      <h3>{title}</h3>
      {actionLabel && onAction ? (
        <button type="button" className="button ghost" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function JobList({
  jobs,
  selectedJobId,
  onSelect,
}: {
  jobs: ShortlistRow[];
  selectedJobId: string | null;
  onSelect: (id: string) => void;
}) {
  if (jobs.length === 0) return <EmptyState title="No jobs" detail="No current shortlist rows." />;
  return (
    <div className="job-list">
      {jobs.map((job) => (
        <button
          type="button"
          key={job.canonical_job_id}
          className={selectedJobId === job.canonical_job_id ? "job-row selected" : "job-row"}
          onClick={() => onSelect(job.canonical_job_id)}
        >
          <span>
            <strong>{job.title}</strong>
            <small>{job.company}</small>
          </span>
          <span className={`pill ${statusTone(jobOutcomeLabel(job))}`}>{jobOutcomeLabel(job)}</span>
        </button>
      ))}
    </div>
  );
}

function JobDetail({
  job,
  hasApplication,
  onCreateApplication,
}: {
  job: ShortlistRow;
  hasApplication: boolean;
  onCreateApplication: () => void;
}) {
  const href = safeExternalHref(job.canonical_url);
  const artifactIsCurrent = job.current_artifact_status === "CURRENT_OR_NOT_APPLICABLE";
  return (
    <article className="job-detail">
      <div className="detail-title">
        <div>
          <h3>{job.title}</h3>
          <p>{job.company}</p>
        </div>
        <span className={`pill ${statusTone(job.gate_status)}`}>{job.gate_status}</span>
      </div>
      <div className="detail-grid">
        <Info label="Lane" value={job.primary_lane ?? "Unclassified"} />
        <Info label="Match" value={scorePercent(job.recommendation_requirement_score)} />
        <Info label="Coverage" value={scorePercent(job.recommendation_coverage_score)} />
        <Info label="Observed" value={compactDate(job.observed_at)} />
      </div>
      {!artifactIsCurrent ? (
        <div className="notice warning">
          <strong>Verification required:</strong> {job.current_artifact_status}
          {job.current_artifact_reason ? ` — ${job.current_artifact_reason}` : ""}.
          This job is not treated as a current recommendation until the pipeline repairs its artifacts.
        </div>
      ) : null}
      <div className="action-strip">
        <button type="button" className="button primary" onClick={onCreateApplication} disabled={hasApplication || !artifactIsCurrent}>
          {hasApplication ? "Handoff Ready" : artifactIsCurrent ? "Create Handoff" : "Repair Required"}
        </button>
        {href ? (
          <a className="button secondary" href={href} target="_blank" rel="noreferrer">
            Open Posting
          </a>
        ) : null}
      </div>
      <section className="detail-section">
        <h4>Decision</h4>
        <p>{job.evaluation_summary || job.strategic_value || job.next_action || "No evaluation summary recorded."}</p>
      </section>
      <section className="detail-section">
        <h4>Evidence</h4>
        {job.gate_evidence_quotes && job.gate_evidence_quotes.length > 0 ? (
          <ul>
            {job.gate_evidence_quotes.slice(0, 4).map((quote, index) => (
              <li key={`${job.canonical_job_id}-${index}`}>{quote}</li>
            ))}
          </ul>
        ) : (
          <p>No gate evidence quotes recorded.</p>
        )}
      </section>
    </article>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ApplicationList({
  applications,
  onStatusChange,
}: {
  applications: ApplicationRecord[];
  onStatusChange: (application: ApplicationRecord, status: ApplicationRecord["application_status"]) => void;
}) {
  if (applications.length === 0) return <EmptyState title="No applications" detail="No application handoffs yet." />;
  return (
    <div className="application-list">
      {applications.map((application) => (
        <article className="application-row" key={application.application_record_id}>
          <div>
            <strong>{application.title}</strong>
            <small>{application.company} - {compactDate(application.updated_at)}</small>
          </div>
          <div className="row-actions">
            <span className={`pill ${statusTone(application.application_status)}`}>{application.application_status}</span>
            {application.application_status !== "SUBMITTED" ? (
              <button type="button" className="button ghost" onClick={() => onStatusChange(application, "SUBMITTED")}>
                Mark Submitted
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function SourceTable({ sources }: { sources: SourceHealthRow[] }) {
  if (sources.length === 0) return <EmptyState title="No sources" detail="No source plugin health rows." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Kind</th>
            <th>Observations</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.source_key}>
              <td>{source.display_name || source.source_key}</td>
              <td><span className={`pill ${statusTone(source.status)}`}>{source.status}</span></td>
              <td>{source.kind}</td>
              <td>{source.observation_count}</td>
              <td>{compactDate(source.last_observed_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskTable({ tasks }: { tasks: PipelineTaskRow[] }) {
  if (tasks.length === 0) return <EmptyState title="No tasks" detail="No pipeline tasks found." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Updated</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>{task.task_type}</td>
              <td><span className={`pill ${statusTone(task.status)}`}>{task.status}</span></td>
              <td>{task.attempt_count}/{task.max_attempts}</td>
              <td>{compactDate(task.updated_at)}</td>
              <td className="error-cell">
                {task.blocked_reason || task.last_error || task.dead_letter_reason || ""}
                {task.repair_action ? ` (${task.repair_action})` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
