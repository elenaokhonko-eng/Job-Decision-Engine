import type {
  ApplicationEvent,
  ApplicationRecord,
  ShortlistRow,
} from "../contracts/index.js";

export interface JobDecisionClientOptions {
  baseUrl: string;
  token?: string;
  workspaceKey?: string;
  userKey?: string;
  fetchImpl?: typeof fetch;
  nativeApiRequest?: (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    context: { apiBaseUrl: string; workspaceKey?: string; userKey?: string }
  ) => Promise<{ status: number; body: string }>;
}

export interface ApiListResponse<T> {
  ok: boolean;
  next_cursor?: string | null;
  [key: string]: unknown;
}

export interface CreateApplicationInput {
  canonical_job_id: string;
  job_version_id?: string;
  status?: ApplicationRecord["application_status"];
  submission_url?: string | null;
  cv_document_run_id?: string | null;
  cover_letter_document_run_id?: string | null;
  notes?: string | null;
  handoff_payload?: Record<string, unknown>;
  target_submit_at?: string | null;
  follow_up_at?: string | null;
}

export interface UpdateApplicationInput {
  status?: ApplicationRecord["application_status"];
  notes?: string | null;
  follow_up_at?: string | null;
  event_payload?: Record<string, unknown>;
}

export interface ManualObservationInput {
  title: string;
  company: string;
  description: string;
  source?: string;
  salaryRange?: string;
  location?: string;
  careers_portal_url?: string;
}

export interface SourceHealthRow {
  source_key: string;
  display_name: string;
  kind: string;
  status: string;
  active_revision_number: number | null;
  access_basis: string | null;
  terms_url: string | null;
  attribution_required: string | null;
  observation_count: number;
  last_observed_at: string | null;
}

export interface PipelineTaskRow {
  id: string;
  task_type: string;
  task_key: string;
  context_fingerprint?: string | null;
  status: string;
  available_at: string;
  lease_id: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  claimed_by: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  dead_letter_reason: string | null;
  blocked_on?: string | null;
  blocked_reason?: string | null;
  repair_action?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class JobDecisionClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly workspaceKey?: string;
  private readonly userKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nativeApiRequest?: JobDecisionClientOptions["nativeApiRequest"];

  constructor(options: JobDecisionClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("JobDecisionClient requires baseUrl.");
    }
    this.baseUrl = baseUrl;
    this.token = options.token;
    this.workspaceKey = options.workspaceKey;
    this.userKey = options.userKey;
    this.nativeApiRequest = options.nativeApiRequest;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
      throw new Error("JobDecisionClient requires fetch or fetchImpl.");
    }
    this.fetchImpl = fetchImpl;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("accept", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (this.workspaceKey) headers.set("x-workspace-key", this.workspaceKey);
    if (this.userKey) headers.set("x-user-key", this.userKey);
    return headers;
  }

  private nativeHeaders(extra?: HeadersInit): Record<string, string> {
    const headers = new Headers(extra);
    headers.set("accept", "application/json");
    if (this.workspaceKey) headers.set("x-workspace-key", this.workspaceKey);
    if (this.userKey) headers.set("x-user-key", this.userKey);
    return Object.fromEntries(headers.entries());
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let status: number;
    let rawBody: string;
    if (this.nativeApiRequest) {
      const result = await this.nativeApiRequest(
        path,
        {
          method: init.method,
          headers: this.nativeHeaders(init.headers),
          body: typeof init.body === "string" ? init.body : undefined,
        },
        {
          apiBaseUrl: this.baseUrl,
          workspaceKey: this.workspaceKey,
          userKey: this.userKey,
        }
      );
      status = result.status;
      rawBody = result.body;
    } else {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers),
      });
      status = response.status;
      rawBody = await response.text();
    }

    let payload: any = {};
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch {
      payload = {};
    }
    if (status < 200 || status >= 300 || payload?.ok === false) {
      const message = typeof payload?.error === "string"
        ? payload.error
        : `Job Decision API request failed with status ${status}`;
      throw new Error(message);
    }
    return payload as T;
  }

  getHealth(): Promise<{ ok: boolean; timestamp: string; workspace_key: string; user_key: string }> {
    return this.request("/health");
  }

  async listShortlist(options: { limit?: number; cursor?: string } = {}): Promise<{
    ok: boolean;
    jobs: ShortlistRow[];
    next_cursor: string | null;
  }> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request(`/shortlist${params.size ? `?${params.toString()}` : ""}`);
  }

  createManualObservation(input: ManualObservationInput): Promise<{
    ok: boolean;
    inserted: boolean;
    raw_observation_id: string | null;
  }> {
    return this.request("/observations/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  listApplications(options: { status?: ApplicationRecord["application_status"]; limit?: number } = {}): Promise<{
    ok: boolean;
    applications: ApplicationRecord[];
  }> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", String(options.limit));
    return this.request(`/applications${params.size ? `?${params.toString()}` : ""}`);
  }

  listSourceHealth(): Promise<{ ok: boolean; sources: SourceHealthRow[] }> {
    return this.request("/sources/health");
  }

  createApplication(input: CreateApplicationInput): Promise<{ ok: boolean; application: ApplicationRecord }> {
    return this.request("/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  updateApplication(
    applicationRecordId: string,
    input: UpdateApplicationInput
  ): Promise<{ ok: boolean; application: ApplicationRecord }> {
    return this.request(`/applications/${encodeURIComponent(applicationRecordId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  listApplicationEvents(applicationRecordId: string, options: { limit?: number } = {}): Promise<{
    ok: boolean;
    events: ApplicationEvent[];
  }> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    return this.request(
      `/applications/${encodeURIComponent(applicationRecordId)}/events${params.size ? `?${params.toString()}` : ""}`
    );
  }

  listTasks(options: { limit?: number; cursor?: string } = {}): Promise<{
    ok: boolean;
    tasks: PipelineTaskRow[];
    next_cursor: string | null;
  }> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request(`/tasks${params.size ? `?${params.toString()}` : ""}`);
  }
}
