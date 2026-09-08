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

export class JobDecisionClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly workspaceKey?: string;
  private readonly userKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JobDecisionClientOptions) {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("JobDecisionClient requires baseUrl.");
    }
    this.baseUrl = baseUrl;
    this.token = options.token;
    this.workspaceKey = options.workspaceKey;
    this.userKey = options.userKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("accept", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (this.workspaceKey) headers.set("x-workspace-key", this.workspaceKey);
    if (this.userKey) headers.set("x-user-key", this.userKey);
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      const message = typeof payload?.error === "string"
        ? payload.error
        : `Job Decision API request failed with status ${response.status}`;
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

  listTasks(options: { limit?: number; cursor?: string } = {}): Promise<ApiListResponse<unknown>> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request(`/tasks${params.size ? `?${params.toString()}` : ""}`);
  }
}
