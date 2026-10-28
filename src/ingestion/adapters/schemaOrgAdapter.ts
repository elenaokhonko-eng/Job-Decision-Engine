import { createHash } from "node:crypto";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";
import { stripHtmlToText } from "../../security/sanitize.js";
import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult } from "./baseAdapter.js";

const MAX_HTML_TAGS = 250_000;
const MAX_JSON_LD_BLOCKS = 100;
const ALLOWED_HOSTS = new Set(["careerasia.smbc.co.jp"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

interface HtmlElement {
  readonly tag: string;
  readonly attributes: Record<string, string>;
  readonly startTagEnd: number;
  readonly parent: HtmlElement | null;
  closeStart: number;
  closeEnd: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function parseAttributes(tagSource: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const body = tagSource.replace(/^<\/?[a-zA-Z][^\s/>]*/u, "").replace(/\/?\s*>$/u, "");
  const pattern = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of body.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function htmlElements(html: string): HtmlElement[] {
  const elements: HtmlElement[] = [];
  const stack: HtmlElement[] = [];
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>/gu;
  for (const match of html.matchAll(tokenPattern)) {
    const tagSource = match[0];
    if (tagSource.startsWith("<!")) continue;
    const closing = /^<\//u.test(tagSource);
    const tag = tagSource.match(/^<\/?([a-zA-Z][\w:-]*)/u)?.[1]?.toLowerCase();
    if (!tag) continue;
    const start = match.index ?? 0;
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag !== tag) continue;
        for (let closingIndex = stack.length - 1; closingIndex >= index; closingIndex -= 1) {
          stack[closingIndex].closeStart = start;
          stack[closingIndex].closeEnd = start + tagSource.length;
        }
        stack.length = index;
        break;
      }
      continue;
    }
    if (elements.length >= MAX_HTML_TAGS) throw new RangeError(`Schema.org page exceeds ${MAX_HTML_TAGS} HTML tags.`);
    const attributes = parseAttributes(tagSource);
    const element: HtmlElement = {
      tag,
      attributes,
      startTagEnd: start + tagSource.length,
      parent: stack.at(-1) ?? null,
      closeStart: start + tagSource.length,
      closeEnd: start + tagSource.length,
    };
    elements.push(element);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/u.test(tagSource)) stack.push(element);
  }
  return elements;
}

function innerHtml(html: string, element: HtmlElement): string {
  return html.slice(element.startTagEnd, element.closeStart);
}

function microdataValue(html: string, element: HtmlElement): string {
  for (const key of ["content", "datetime", "href", "src", "value"] as const) {
    const value = text(element.attributes[key]);
    if (value) return value;
  }
  return stripHtmlToText(innerHtml(html, element));
}

function isJobPostingType(itemtype: string): boolean {
  return itemtype.split(/\s+/u).some((type) => /(?:^|\/)JobPosting$/iu.test(type));
}

function firstJsonLdJobPosting(html: string): Record<string, unknown> | null {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)];
  if (scripts.length > MAX_JSON_LD_BLOCKS) throw new RangeError(`Schema.org page contains more than ${MAX_JSON_LD_BLOCKS} JSON-LD blocks.`);
  const candidates: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 20) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const current = record(value);
    if (!current) return;
    const types = Array.isArray(current["@type"]) ? current["@type"] : [current["@type"]];
    if (types.some((type) => typeof type === "string" && /(?:^|\/)JobPosting$/iu.test(type))) candidates.push(current);
    for (const [key, nested] of Object.entries(current)) {
      if (key === "@context" || key === "description") continue;
      visit(nested, depth + 1);
    }
  };
  for (const match of scripts) {
    const attrs = parseAttributes(`<script ${match[1]}>`);
    if ((attrs.type ?? "").split(";")[0].trim().toLowerCase() !== "application/ld+json") continue;
    try {
      visit(JSON.parse(match[2].trim()) as unknown);
    } catch {
      // Invalid JSON-LD does not hide valid microdata on the same official page.
    }
  }
  if (candidates.length > 1) throw new Error("The page contains multiple schema.org JobPosting records.");
  return candidates[0] ?? null;
}

function microdataJobPosting(html: string): Record<string, unknown> | null {
  const withoutExecutableBlocks = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, " ");
  const elements = htmlElements(withoutExecutableBlocks);
  const scopes = elements.filter((element) =>
    element.attributes.itemscope !== undefined && isJobPostingType(element.attributes.itemtype ?? ""),
  );
  if (scopes.length > 1) throw new Error("The page contains multiple schema.org JobPosting records.");
  const scope = scopes[0];
  if (!scope) return null;
  const end = scope.closeEnd;
  const values = new Map<string, string[]>();
  for (const element of elements) {
    if (element === scope || element.attributes.itemprop === undefined || element.closeStart > end) continue;
    let ancestor = element.parent;
    let inside = false;
    while (ancestor) {
      if (ancestor === scope) { inside = true; break; }
      if (ancestor.attributes.itemscope !== undefined && isJobPostingType(ancestor.attributes.itemtype ?? "")) break;
      ancestor = ancestor.parent;
    }
    if (!inside) continue;
    const propNames = element.attributes.itemprop.trim().split(/\s+/u).filter(Boolean);
    const value = microdataValue(withoutExecutableBlocks, element);
    for (const propName of propNames) {
      const list = values.get(propName) ?? [];
      if (value.trim()) list.push(value.trim());
      values.set(propName, list);
    }
  }
  const first = (...names: string[]): string | null => {
    for (const name of names) {
      const value = values.get(name)?.find((candidate) => candidate.trim());
      if (value) return value;
    }
    return null;
  };
  const description = first("description");
  const title = first("title");
  const employer = first("hiringOrganization") ?? first("name");
  const locationParts = [first("streetAddress"), first("addressLocality"), first("addressRegion"), first("addressCountry")]
    .filter((part): part is string => part !== null);
  const id = first("identifier");
  const location = locationParts.join(", ") || first("jobLocation");
  if (!title || !description) return null;
  return {
    "@type": "JobPosting",
    identifier: id,
    title: title,
    description,
    datePosted: first("datePosted"),
    hiringOrganization: employer ? { name: employer } : null,
    jobLocation: location ? { address: { addressLocality: location } } : null,
    employmentType: first("employmentType"),
  };
}

function asText(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  const item = record(value);
  if (!item) return null;
  return text(item.name) ?? text(item.value) ?? text(item.addressLocality);
}

function organizationName(value: unknown): string | null {
  const direct = text(value);
  if (direct) return direct;
  const item = record(value);
  if (item) return text(item.name);
  if (Array.isArray(value)) return value.map(organizationName).find((name): name is string => Boolean(name)) ?? null;
  return null;
}

function addressText(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(addressText).find((address): address is string => Boolean(address)) ?? null;
  const place = record(value);
  if (!place) return text(value);
  const address = record(place.address) ?? place;
  const components = [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode, address.addressCountry]
    .flatMap((component) => {
      if (typeof component === "string") return [component];
      const nested = record(component);
      return nested?.name && typeof nested.name === "string" ? [nested.name] : [];
    })
    .map((component) => component.trim())
    .filter(Boolean);
  return components.length ? [...new Set(components)].join(", ") : text(place.name);
}

function stableId(posting: Record<string, unknown>, endpoint: URL): string {
  const identifier = posting.identifier;
  if (typeof identifier === "string" || typeof identifier === "number") return String(identifier);
  const identifierRecord = record(identifier);
  if (identifierRecord) {
    const value = identifierRecord.value ?? identifierRecord.name;
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  const pathId = endpoint.pathname.split("/").filter(Boolean).at(-1);
  return pathId || endpoint.toString();
}

function validDate(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function sanitizedPostingPayload(posting: Record<string, unknown>, endpoint: URL): Record<string, unknown> {
  return {
    "@type": "JobPosting",
    identifier: posting.identifier ?? stableId(posting, endpoint),
    title: posting.title ?? null,
    description: posting.description ?? null,
    datePosted: posting.datePosted ?? null,
    hiringOrganization: posting.hiringOrganization ?? null,
    jobLocation: posting.jobLocation ?? null,
    employmentType: posting.employmentType ?? null,
    source_url: endpoint.toString(),
  };
}

export class SchemaOrgAdapter extends BaseSourceAdapter {
  readonly sourceName = "MANUAL_IMPORT" as const;
  private readonly endpoint: URL;

  constructor(endpoint: string) {
    super();
    this.endpoint = new URL(endpoint);
    if (this.endpoint.protocol !== "https:" || !ALLOWED_HOSTS.has(this.endpoint.hostname.toLowerCase())) {
      throw new Error("The schema.org adapter only accepts verified HTTPS SMBC Careers posting URLs.");
    }
    this.timeoutMs = 15_000;
  }

  private async fetchOfficialPage(): Promise<Response> {
    let target = new URL(this.endpoint);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (target.protocol !== "https:" || target.hostname.toLowerCase() !== this.endpoint.hostname.toLowerCase()) {
        throw new Error("The SMBC Careers page redirected outside its verified HTTPS host.");
      }
      const response = await this.fetchWithTimeout(target.toString(), {
        redirect: "manual",
        headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "JobDecisionEngine/1.0" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel();
      target = new URL(location, target);
    }
    throw new Error("The SMBC Careers page exceeded the redirect limit.");
  }

  async fetchJobs(_options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    try {
      const response = await this.fetchOfficialPage();
      if (response.status === 429) return this.errorResult("429 Rate limited", { isRateLimited: true });
      if (!response.ok) return this.errorResult(`HTTP ${response.status}: ${response.statusText}`);
      const html = await this.readResponseText(response);
      const posting = firstJsonLdJobPosting(html) ?? microdataJobPosting(html);
      if (!posting) {
        const rawPayload = {
          source_url: this.endpoint.toString(),
          response_sha256: createHash("sha256").update(html).digest("hex"),
          response_bytes: Buffer.byteLength(html, "utf8"),
          response_preview: html.slice(0, 2048),
        };
        return {
          sourceName: this.sourceName,
          success: false,
          jobs: [],
          totalFetched: 1,
          quarantined: 1,
          quarantinedCandidates: [{ identity: this.endpoint.toString(), rawPayload, error: "No schema.org JobPosting record could be extracted from the official page." }],
          error: "No schema.org JobPosting record could be extracted from the official page.",
        };
      }
      const descriptionHtml = text(posting.description);
      const title = this.sanitizeHtml(posting.title);
      const description = this.sanitizeHtml(descriptionHtml);
      const company = organizationName(posting.hiringOrganization);
      const location = addressText(posting.jobLocation) ?? "Unknown";
      if (!title || !description || !company) {
        const rawPayload = sanitizedPostingPayload(posting, this.endpoint);
        const identity = stableId(posting, this.endpoint);
        const reason = `Required JobPosting fields are missing: ${[
          !title ? "title" : null,
          !description ? "description" : null,
          !company ? "hiringOrganization.name" : null,
        ].filter(Boolean).join(", ")}.`;
        this.validateJob({ schema_version: SCHEMA_VERSION, title, description_raw: description, raw_payload: rawPayload }, identity);
        const quarantined = this.getQuarantinedCandidates();
        return {
          sourceName: this.sourceName,
          success: false,
          jobs: [],
          totalFetched: 1,
          quarantined: 1,
          quarantinedCandidates: quarantined.length > 0 ? quarantined : [{ identity, rawPayload, error: reason }],
          error: reason,
        };
      }
      const rawPayload = sanitizedPostingPayload(posting, this.endpoint);
      const workMode = normalizeWorkMode(posting.jobLocationType ?? posting.workplaceType);
      const candidate = {
        schema_version: SCHEMA_VERSION,
        source_external_id: stableId(posting, this.endpoint),
        company_name: company,
        title,
        location_raw: location,
        workplace_type_raw: workMode,
        employment_type_raw: asText(posting.employmentType) ?? "UNKNOWN",
        compensation_raw: "UNKNOWN",
        employer_posting_url: this.endpoint.toString(),
        application_url: this.endpoint.toString(),
        canonical_apply_url: this.endpoint.toString(),
        description_raw: description,
        ...(validDate(posting.datePosted) ? { published_at: validDate(posting.datePosted) } : {}),
        source_attribution: "SMBC Careers schema.org JobPosting",
        raw_payload: rawPayload,
      };
      const job = this.validateJob(candidate, stableId(posting, this.endpoint));
      return {
        sourceName: this.sourceName,
        success: job !== null,
        jobs: job ? [job] : [],
        totalFetched: 1,
        snapshotTotal: 1,
        quarantined: job ? 0 : 1,
        quarantinedCandidates: this.getQuarantinedCandidates(),
        nextCursor: null,
        hasMore: false,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.errorResult(detail);
    }
  }
}
