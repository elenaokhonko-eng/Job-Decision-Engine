const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface GmailApiCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

export interface GmailRawMessage {
  id: string;
  raw: string;
  subject: string;
  internalDate: string | null;
}

interface GmailApiOptions {
  fetchImpl?: typeof fetch;
  apiRoot?: string;
  tokenEndpoint?: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
}

interface GmailMessageResponse {
  id: string;
  raw?: string;
  internalDate?: string;
}

interface GmailTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GmailLabelsResponse {
  labels?: GmailLabel[];
}

type RetryAwareError = Error & { retryable?: boolean };

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function extractEmailSubject(rawMessage: string): string {
  const headerEnd = rawMessage.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd >= 0 ? rawMessage.slice(0, headerEnd) : rawMessage;
  const unfoldedHeaders = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const subjectLine = unfoldedHeaders
    .split(/\r?\n/)
    .find((line) => /^subject:/i.test(line));

  return subjectLine?.replace(/^subject:\s*/i, "").trim() || "No Subject";
}

export function loadGmailApiCredentials(env: NodeJS.ProcessEnv = process.env): GmailApiCredentials {
  const credentials = {
    clientId: env.GMAIL_OAUTH_CLIENT_ID?.trim() || "",
    clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET?.trim() || "",
    refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN?.trim() || "",
  };
  const environmentNames: Record<keyof GmailApiCredentials, string> = {
    clientId: "GMAIL_OAUTH_CLIENT_ID",
    clientSecret: "GMAIL_OAUTH_CLIENT_SECRET",
    refreshToken: "GMAIL_OAUTH_REFRESH_TOKEN",
  };
  const missing = Object.entries(credentials)
    .filter(([, value]) => !value)
    .map(([key]) => environmentNames[key as keyof GmailApiCredentials]);

  if (missing.length > 0) {
    throw new Error(
      `Missing Gmail OAuth configuration: ${missing.join(", ")}. ` +
        "Create an OAuth 2.0 refresh token for the Gmail API; IMAP app passwords are not used."
    );
  }

  return credentials;
}

export class GmailApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiRoot: string;
  private readonly tokenEndpoint: string;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private readonly labelCache = new Map<string, GmailLabel>();

  constructor(
    private readonly credentials: GmailApiCredentials,
    options: GmailApiOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.apiRoot = (options.apiRoot || GMAIL_API_ROOT).replace(/\/$/, "");
    this.tokenEndpoint = options.tokenEndpoint || GOOGLE_OAUTH_TOKEN_ENDPOINT;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 1000);
  }

  async listLabels(): Promise<GmailLabel[]> {
    const response = await this.requestJson<GmailLabelsResponse>("/labels", {
      method: "GET",
    });
    return response.labels || [];
  }

  async resolveLabel(labelName: string): Promise<GmailLabel> {
    const cached = this.labelCache.get(labelName);
    if (cached) return cached;

    const label = (await this.listLabels()).find((candidate) => candidate.name === labelName);
    if (!label) {
      throw new Error(`Gmail label not found: ${labelName}`);
    }

    this.labelCache.set(labelName, label);
    return label;
  }

  async ensureLabel(labelName: string): Promise<GmailLabel> {
    const existing = (await this.listLabels()).find((candidate) => candidate.name === labelName);
    if (existing) {
      this.labelCache.set(labelName, existing);
      return existing;
    }

    const created = await this.requestJson<GmailLabel>("/labels", {
      method: "POST",
      body: JSON.stringify({
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    });
    this.labelCache.set(labelName, created);
    return created;
  }

  async listMessageIdsByLabel(labelId: string): Promise<string[]> {
    const messageIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const query = new URLSearchParams({
        labelIds: labelId,
        maxResults: "500",
      });
      if (pageToken) query.set("pageToken", pageToken);

      const response = await this.requestJson<GmailMessageListResponse>(`/messages?${query.toString()}`, {
        method: "GET",
      });
      for (const message of response.messages || []) {
        if (message.id) messageIds.push(message.id);
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

    return messageIds;
  }

  async getRawMessage(messageId: string): Promise<GmailRawMessage> {
    const response = await this.requestJson<GmailMessageResponse>(
      `/messages/${encodeURIComponent(messageId)}?format=raw`,
      { method: "GET" }
    );
    if (!response.raw) {
      throw new Error(`Gmail message ${messageId} did not include a raw payload`);
    }

    const raw = decodeBase64Url(response.raw);
    return {
      id: response.id || messageId,
      raw,
      subject: extractEmailSubject(raw),
      internalDate: response.internalDate || null,
    };
  }

  async readMessagesByLabel(labelName: string): Promise<{ label: GmailLabel; messages: GmailRawMessage[] }> {
    const label = await this.resolveLabel(labelName);
    const messageIds = await this.listMessageIdsByLabel(label.id);
    const messages: GmailRawMessage[] = [];

    for (const messageId of messageIds) {
      messages.push(await this.getRawMessage(messageId));
    }

    return { label, messages };
  }

  async markProcessed(messageId: string, sourceLabelId: string, processedLabelName: string): Promise<void> {
    const processedLabel = await this.ensureLabel(processedLabelName);
    await this.requestJson(`/messages/${encodeURIComponent(messageId)}/modify`, {
      method: "POST",
      body: JSON.stringify({
        addLabelIds: [processedLabel.id],
        removeLabelIds: [sourceLabelId],
      }),
    });
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.requestJson(`/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessTokenExpiresAt > Date.now() + 60_000) {
      return this.accessToken;
    }

    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const bodyText = await response.text();
    let body: GmailTokenResponse = {};
    try {
      body = bodyText ? (JSON.parse(bodyText) as GmailTokenResponse) : {};
    } catch {
      body = {};
    }

    if (!response.ok || !body.access_token) {
      const detail = body.error_description || body.error || `HTTP ${response.status}`;
      throw new Error(`Gmail OAuth token refresh failed: ${detail}`);
    }

    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + (body.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const accessToken = await this.getAccessToken();
        const response = await this.fetchImpl(`${this.apiRoot}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(init.headers || {}),
          },
        });

        if (response.status === 401) {
          this.accessToken = null;
          this.accessTokenExpiresAt = 0;
        }

        const bodyText = await response.text();
        if (response.ok) {
          return (bodyText ? JSON.parse(bodyText) : {}) as T;
        }

        const detail = bodyText || `HTTP ${response.status}`;
        const retryable = response.status === 401 || response.status === 429 || response.status >= 500;
        const requestError = Object.assign(
          new Error(`Gmail API request failed (${response.status}): ${detail}`),
          { retryable }
        );
        lastError = requestError;
        if (!retryable || attempt === this.maxAttempts) throw lastError;

        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
        const delayMs = Number.isFinite(retryAfter)
          ? Math.max(0, retryAfter * 1000)
          : this.retryBaseDelayMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if ((lastError as RetryAwareError).retryable === false) throw lastError;
        if (attempt === this.maxAttempts) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, this.retryBaseDelayMs * 2 ** (attempt - 1)));
      }
    }

    throw lastError || new Error("Gmail API request failed without an error");
  }
}
