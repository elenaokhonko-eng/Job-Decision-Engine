import { sha256Hex, stableStringify } from "../config/structuredLoader.js";
import { JobSourceEvidenceSchema, type JobEvidenceSpan, type JobSourceEvidence } from "../contracts/jobSourceEvidence.js";
import { stripHtmlToText } from "../security/sanitize.js";
import { classifyDescriptionQuality } from "../pipeline/descriptionQuality.js";
import { extractFreshnessEvidence } from "./freshnessEvidence.js";

export interface BuildJobSourceEvidenceInput {
  readonly sourceName: string;
  readonly sourcePluginKey: string | null;
  readonly sourcePluginRevisionId: string | null;
  readonly sourceExternalId: string | null;
  readonly sourceUrl: string | null;
  readonly canonicalApplyUrl: string | null;
  readonly retrievedAt: string;
  readonly rawPayloadHash: string;
  readonly rawPayload: unknown;
  readonly companyName: string;
  readonly title: string;
  readonly locationRaw: string | null;
  readonly workplaceTypeRaw: string | null;
  readonly employmentTypeRaw: string | null;
  readonly compensationRaw: string | null;
  readonly descriptionText: string;
}

interface DescriptionPart {
  readonly kind: "HEADING" | "PARAGRAPH" | "LIST_ITEM" | "OTHER";
  readonly text: string;
  readonly headingLevel: number | null;
}

interface DescriptionEvidenceSegment {
  readonly kind: DescriptionPart["kind"];
  readonly text: string;
  readonly heading_level: number | null;
  readonly normalized_start_offset: number;
  readonly normalized_end_offset: number;
  readonly raw_start_offset: null;
  readonly raw_end_offset: null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Raw provider JSON is narrowed here before reading its documented fields.
  return value as Record<string, unknown>;
}

function payloadRecords(value: unknown): Record<string, unknown>[] {
  const root = asRecord(value);
  if (!root) return [];
  const records = [root];
  for (const key of ["job", "posting", "data", "result"]) {
    const nested = asRecord(root[key]);
    if (nested) records.push(nested);
  }
  return records;
}

function firstValue(records: readonly Record<string, unknown>[], keys: readonly string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return null;
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function evidenceSpan(
  input: BuildJobSourceEvidenceInput,
  evidenceKey: string,
  quoteText: string,
  confidence: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM",
): JobEvidenceSpan {
  return {
    evidence_key: evidenceKey,
    source_name: input.sourceName,
    source_plugin_key: input.sourcePluginKey,
    source_external_id: input.sourceExternalId,
    source_url: safeUrl(input.sourceUrl ?? input.canonicalApplyUrl),
    raw_payload_hash: input.rawPayloadHash,
    quote_text: quoteText,
    normalized_start_offset: null,
    normalized_end_offset: null,
    raw_start_offset: null,
    raw_end_offset: null,
    observed_at: input.retrievedAt,
    confidence,
  };
}

function normalizeDescription(input: BuildJobSourceEvidenceInput): {
  normalizedText: string;
  segments: DescriptionEvidenceSegment[];
} {
  const marked = input.descriptionText
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, "\n\u001fH$1\u001f$2\n")
    .replace(/<li\b[^>]*>/gi, "\n\u001fL\u001f")
    .replace(/<\/(?:li|p|div|section|article|br)\s*>/gi, "\n")
    .replace(/<(?:p|div|section|article|br)\b[^>]*>/gi, "\n");
  const plain = stripHtmlToText(marked).replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n");
  const parts: DescriptionPart[] = [];
  for (const rawLine of plain.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^\u001fH([1-6])\u001f([\s\S]*)$/);
    if (heading) {
      const text = heading[2].trim();
      if (text) parts.push({ kind: "HEADING", text, headingLevel: Number(heading[1]) });
      continue;
    }
    if (line.startsWith("\u001fL\u001f")) {
      const text = line.slice("\u001fL\u001f".length).trim();
      if (text) parts.push({ kind: "LIST_ITEM", text, headingLevel: null });
      continue;
    }
    parts.push({ kind: "PARAGRAPH", text: line, headingLevel: null });
  }

  const normalizedText = parts.map((part) => part.text).join("\n");
  let offset = 0;
  const segments = parts.map((part) => {
    const start = offset;
    const end = start + part.text.length;
    offset = end + 1;
    return {
      kind: part.kind,
      text: part.text,
      heading_level: part.headingLevel,
      normalized_start_offset: start,
      normalized_end_offset: end,
      raw_start_offset: null,
      raw_end_offset: null,
    };
  });
  return { normalizedText, segments };
}

function dateValue(value: unknown): { iso: string | null; raw: string | number | null; unit: "ISO_STRING" | "RFC2822_STRING" | "UNIX_SECONDS" | "UNIX_MILLISECONDS" | "UNKNOWN" } {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const numeric = typeof value === "number" ? value : Number(value);
    const digits = String(Math.trunc(Math.abs(numeric))).length;
    const unit = digits === 10 ? "UNIX_SECONDS" : digits === 13 ? "UNIX_MILLISECONDS" : "UNKNOWN";
    if (unit === "UNKNOWN") return { iso: null, raw: value, unit };
    const date = new Date(numeric * (unit === "UNIX_SECONDS" ? 1000 : 1));
    return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), raw: numeric, unit } : { iso: null, raw: value, unit: "UNKNOWN" };
  }
  if (typeof value !== "string" || !value.trim()) return { iso: null, raw: null, unit: "UNKNOWN" };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { iso: null, raw: value, unit: "UNKNOWN" };
  const rfc = /\b(?:GMT|UTC)\b/i.test(value) || /,\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/.test(value);
  return { iso: date.toISOString(), raw: value, unit: rfc ? "RFC2822_STRING" : "ISO_STRING" };
}

function dateEvidence(
  input: BuildJobSourceEvidenceInput,
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  basis: "PUBLISHED_AT" | "GENUINE_REPOST_AT" | "SOURCE_UPDATED_AT" | "EXPIRES_AT",
  normalizedValue: string | null,
) {
  const raw = firstValue(records, keys);
  const parsed = dateValue(raw);
  const value = normalizedValue ?? parsed.iso;
  return {
    status: value ? "SUPPORTED" as const : "UNKNOWN" as const,
    value,
    basis: value ? basis : "UNKNOWN" as const,
    raw_value: parsed.raw,
    timestamp_unit: parsed.unit,
    evidence: value ? [evidenceSpan(input, `DATE_${basis}`, `${keys.find((key) => firstValue(records, [key]) !== null) ?? basis}: ${String(raw)}`)] : [],
  };
}

function normalizedWorkMode(value: string | null): "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN" {
  const normalized = (value ?? "").trim().toUpperCase();
  if (normalized === "REMOTE" || normalized.includes("REMOTE")) return "REMOTE";
  if (normalized === "HYBRID" || normalized === "ASSUMED_HYBRID") return "HYBRID";
  if (normalized === "ONSITE" || normalized === "ON_SITE" || normalized === "ON-SITE") return "ONSITE";
  return "UNKNOWN";
}

function parseCompensation(input: BuildJobSourceEvidenceInput, records: readonly Record<string, unknown>[]) {
  const rawText = input.compensationRaw?.trim() ?? "";
  const unknownText = /^(unknown|undisclosed|competitive|not disclosed|n\/?a)$/i.test(rawText);
  const parseAmount = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    if (normalized.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*[kK]?$/.test(normalized)) return null;
    const match = normalized.replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([kK])?$/);
    if (!match) return null;
    const parsed = Number(match[1]) * (match[2] ? 1000 : 1);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const currencyFromToken = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const token = value.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(token)) return token;
    if (token === "S$") return "SGD";
    if (token === "US$") return "USD";
    return null;
  };
  const textCurrencyPattern = /\b(?:SGD|USD|EUR|GBP|AUD|CAD|HKD|MYR|JPY)\b|US\$|S\$/gi;
  const textCurrencyCodes = [...rawText.matchAll(textCurrencyPattern)]
    .map((match) => currencyFromToken(match[0]))
    .filter((value): value is string => value !== null);
  const structuredCurrency = currencyFromToken(firstValue(records, ["salaryCurrency", "salary_currency", "currency", "baseCurrency"]));
  const uniqueTextCurrencies = [...new Set(textCurrencyCodes)];
  const fallbackTextCurrency = uniqueTextCurrencies.length === 1 ? uniqueTextCurrencies[0] : null;
  const currencyConflict = structuredCurrency !== null
    && uniqueTextCurrencies.some((currency) => currency !== structuredCurrency);
  const globalCurrency = structuredCurrency ?? fallbackTextCurrency;
  const normalizePeriod = (value: unknown): "HOURLY" | "MONTHLY" | "ANNUAL" | "ONE_TIME" | "UNKNOWN" => {
    if (typeof value !== "string") return "UNKNOWN";
    const normalized = value.trim().toUpperCase();
    if (/ONE_TIME|SIGNING|SIGN_ON/.test(normalized)) return "ONE_TIME";
    if (/HOURLY|HOUR|PER_HOUR/.test(normalized)) return "HOURLY";
    if (/MONTH/.test(normalized)) return "MONTHLY";
    if (/ANNUAL|YEAR|PER_ANNUM/.test(normalized)) return "ANNUAL";
    return "UNKNOWN";
  };
  const periodFromText = (value: string): "HOURLY" | "MONTHLY" | "ANNUAL" | "ONE_TIME" | "UNKNOWN" => {
    if (/\b(one[- ]time|sign[- ]on|signing bonus)\b/i.test(value)) return "ONE_TIME";
    if (/\b(hourly|per\s+hour|\/\s*hour|per\s+hr)\b/i.test(value)) return "HOURLY";
    if (/\b(monthly|per\s+month|a\s+month|\/\s*month)\b/i.test(value)) return "MONTHLY";
    if (/\b(annual|annually|yearly|per\s+year|per\s+annum|\/\s*year)\b/i.test(value)) return "ANNUAL";
    return "UNKNOWN";
  };
  const structuredAnnualMin = firstValue(records, ["annualSalaryMin", "annual_salary_min"]);
  const structuredAnnualMax = firstValue(records, ["annualSalaryMax", "annual_salary_max"]);
  const structuredMinimumRaw = structuredAnnualMin ?? firstValue(records, ["baseSalaryMin", "base_salary_min", "salaryMin", "salary_min", "minimumSalary"]);
  const structuredMaximumRaw = structuredAnnualMax ?? firstValue(records, ["baseSalaryMax", "base_salary_max", "salaryMax", "salary_max", "maximumSalary"]);
  const structuredMinimum = parseAmount(structuredMinimumRaw);
  const structuredMaximum = parseAmount(structuredMaximumRaw) ?? structuredMinimum;
  const structuredPeriod = structuredAnnualMin !== null || structuredAnnualMax !== null
    ? "ANNUAL"
    : normalizePeriod(firstValue(records, ["salaryPeriod", "salary_period", "payPeriod"]));
  const globalPeriod = structuredPeriod !== "UNKNOWN" ? structuredPeriod : periodFromText(rawText);
  const basisFromValue = (value: unknown): "GROSS" | "NET" | "UNKNOWN" => {
    if (typeof value === "string" && ["GROSS", "NET"].includes(value.trim().toUpperCase())) return value.trim().toUpperCase() as "GROSS" | "NET";
    return "UNKNOWN";
  };
  const structuredBasis = basisFromValue(firstValue(records, ["salaryBasis", "salary_basis", "payBasis", "pay_basis"]));
  const globalBasis = structuredBasis !== "UNKNOWN"
    ? structuredBasis
    : /\bnet\b/i.test(rawText) ? "NET" : /\bgross\b/i.test(rawText) ? "GROSS" : "UNKNOWN";
  const structuredTypeRaw = firstValue(records, ["salaryComponentType", "salary_component_type", "compensationType", "compensation_type"]);
  const normalizeComponentType = (value: unknown): "BASE_CASH" | "VARIABLE_CASH" | "EQUITY" | "OTHER" | null => {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toUpperCase().replace(/[ -]+/g, "_");
    if (["BASE", "BASE_CASH", "CASH", "GUARANTEED_CASH"].includes(normalized)) return "BASE_CASH";
    if (["OTE", "VARIABLE", "VARIABLE_CASH", "BONUS", "COMMISSION"].includes(normalized)) return "VARIABLE_CASH";
    if (["EQUITY", "STOCK", "RSU", "OPTIONS"].includes(normalized)) return "EQUITY";
    if (normalized === "OTHER") return "OTHER";
    return null;
  };
  const structuredType = normalizeComponentType(structuredTypeRaw)
    ?? (/\b(base salary|base cash|guaranteed salary)\b/i.test(rawText)
      ? "BASE_CASH"
      : /\b(equity|stock|rsu|options?)\b/i.test(rawText) && !/\b(base salary|base cash)\b/i.test(rawText)
        ? "EQUITY"
        : /\b(ote|on[- ]target|commission|bonus|variable)\b/i.test(rawText) && !/\b(base salary|base cash)\b/i.test(rawText)
          ? "VARIABLE_CASH"
          : "BASE_CASH");
  const structuredHours = parseAmount(firstValue(records, ["guaranteedHoursPerWeek", "guaranteed_hours_per_week", "hoursPerWeek"]));
  const structuredPaidWeeks = parseAmount(firstValue(records, ["paidWeeksPerYear", "paid_weeks_per_year", "weeksPerYear"]));
  const hoursFromText = (value: string): number | null => {
    const match = value.match(/(\d+(?:\.\d+)?)\s*(?:guaranteed\s+)?hours?\s*(?:per|a|\/)\s*week/i);
    return match ? parseAmount(match[1]) : null;
  };
  const weeksFromText = (value: string): number | null => {
    const match = value.match(/(\d{1,2})\s*(?:paid\s+)?weeks?\s*(?:per|a|\/)\s*year/i);
    const weeks = match ? Number(match[1]) : null;
    return weeks !== null && weeks >= 1 && weeks <= 53 ? weeks : null;
  };
  const componentTypeForText = (value: string): "BASE_CASH" | "VARIABLE_CASH" | "EQUITY" | "OTHER" => {
    if (/\b(equity|stock|rsu|options?)\b/i.test(value)) return "EQUITY";
    if (/\b(ote|on[- ]target|commission|bonus|variable)\b/i.test(value)) return "VARIABLE_CASH";
    if (/\b(base|salary|cash compensation|guaranteed compensation)\b/i.test(value)) return "BASE_CASH";
    return "BASE_CASH";
  };
  const amountToken = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*[kK]?)`;
  const currencyToken = String.raw`(?:SGD|USD|EUR|GBP|AUD|CAD|HKD|MYR|JPY|US\$|S\$|\$)`;
  const rangePattern = new RegExp(String.raw`(?:(${currencyToken})\s*)?(${amountToken})\s*(?:-|–|to)\s*(?:(${currencyToken})\s*)?(${amountToken})`, "i");
  const singlePattern = new RegExp(String.raw`(?:(${currencyToken})\s*)?(${amountToken})`, "i");
  const segments = rawText.split(/(?:\r?\n|;|\||\bplus\b|\bincluding\b|\bwith\b|\s+\+\s+|\band(?=\s*(?:base|ote|on[- ]target|commission|bonus|equity|stock|rsu|options?|variable)\b)|,(?=\s*(?:base|ote|on[- ]target|commission|bonus|equity|stock|rsu|options?|variable)\b))/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const components: Array<{
    component_type: "BASE_CASH" | "VARIABLE_CASH" | "EQUITY" | "OTHER";
    amount_min: number | null;
    amount_max: number | null;
    currency: string | null;
    period: "HOURLY" | "MONTHLY" | "ANNUAL" | "UNKNOWN" | "ONE_TIME";
    guaranteed_hours_per_week: number | null;
    paid_weeks_per_year: number | null;
    pay_basis: "GROSS" | "NET" | "UNKNOWN";
    evidence: JobEvidenceSpan[];
  }> = [];

  if (structuredMinimum !== null || structuredMaximum !== null) {
    const quote = rawText && !unknownText
      ? rawText
      : `structured salary fields: minimum=${String(structuredMinimumRaw ?? "unknown")}; maximum=${String(structuredMaximumRaw ?? "unknown")}`;
    components.push({
      component_type: structuredType,
      amount_min: structuredMinimum,
      amount_max: structuredMaximum,
      currency: globalCurrency,
      period: globalPeriod,
      guaranteed_hours_per_week: structuredHours ?? hoursFromText(rawText),
      paid_weeks_per_year: structuredPaidWeeks ?? weeksFromText(rawText),
      pay_basis: globalBasis,
      evidence: [evidenceSpan(input, "COMPENSATION", quote, structuredMinimum !== null ? "HIGH" : "MEDIUM")],
    });
  }

  for (const segment of segments) {
    const componentType = componentTypeForText(segment);
    if ((structuredMinimum !== null || structuredMaximum !== null) && componentType === structuredType) continue;
    const range = segment.match(rangePattern);
    const single = range ? null : segment.match(singlePattern);
    if (!range && !single) continue;
    const amountMin = range ? parseAmount(range[2]) : parseAmount(single?.[2]);
    const amountMax = range ? parseAmount(range[4]) : amountMin;
    if (amountMin === null && amountMax === null) continue;
    const segmentCurrency = currencyFromToken(range?.[1] ?? range?.[3] ?? single?.[1])
      ?? (() => {
        const token = segment.match(/\b(?:SGD|USD|EUR|GBP|AUD|CAD|HKD|MYR|JPY)\b|US\$|S\$/i)?.[0];
        return currencyFromToken(token) ?? globalCurrency;
      })();
    const segmentPeriod = periodFromText(segment);
    const segmentBasis = /\bnet\b/i.test(segment) ? "NET" : /\bgross\b/i.test(segment) ? "GROSS" : globalBasis;
    const singlePeriod = /\b(one[- ]time|sign[- ]on|signing bonus)\b/i.test(segment) ? "ONE_TIME" : segmentPeriod !== "UNKNOWN" ? segmentPeriod : globalPeriod;
    components.push({
      component_type: componentType,
      amount_min: amountMin,
      amount_max: amountMax,
      currency: segmentCurrency,
      period: singlePeriod,
      guaranteed_hours_per_week: hoursFromText(segment) ?? structuredHours ?? hoursFromText(rawText),
      paid_weeks_per_year: weeksFromText(segment) ?? structuredPaidWeeks ?? weeksFromText(rawText),
      pay_basis: segmentBasis,
      evidence: [evidenceSpan(input, "COMPENSATION", segment)],
    });
  }

  const baseComponentCount = components.filter((component) => component.component_type === "BASE_CASH").length;
  const evidence = components.flatMap((component) => component.evidence);
  const supported = components.length > 0
    && !currencyConflict
    && components.every((component) => component.currency !== null && component.period !== "UNKNOWN" && component.pay_basis !== "UNKNOWN");
  return {
    status: currencyConflict || baseComponentCount > 1
      ? "CONFLICTING" as const
      : supported ? "SUPPORTED" as const : "UNKNOWN" as const,
    components,
    evidence,
  };
}

function roleShape(input: BuildJobSourceEvidenceInput): Record<string, unknown> {
  const text = `${input.title} ${input.descriptionText}`;
  const technical = /\b(software|engineering|engineer|architect|data|machine learning|artificial intelligence|technical|platform|research software|scientific computing)\b/i.test(text);
  const codingRequired = /\b(coding|programming|write code|software development|hands[- ]on development|implement software)\b/i.test(text);
  const architectureRequired = /\b(architect|architecture|solution design|systems design)\b/i.test(input.title);
  const deliveryScope = /\b(technical project|technical programme|technical program|technical delivery|delivery lead)\b/i.test(input.title)
    ? /\b(program(?:me)?|portfolio)\b/i.test(input.title) ? "TECHNICAL_PROGRAMME" : "TECHNICAL_PROJECT"
    : /\b(technical product|product manager)\b/i.test(input.title) ? "TECHNICAL_PRODUCT" : "UNKNOWN";
  const quotaOwned = /\b(own|carry|meet|close|drive)\b[^.;]{0,50}\b(quota|revenue target|sales target|new business|prospecting)\b/i.test(text)
    || /\b(quota|revenue target|sales target)\s+ownership\b/i.test(text);
  const salesSupport = /\b(support|partner|collaborate)\b[^.;]{0,50}\b(sales|presales|pre-sales)\b/i.test(text);
  const managementRequired = /\b(manage|lead|build)\b[^.;]{0,50}\b(team|direct reports|people)\b/i.test(text);
  const interactionHigh = /\b(client-facing|customer-facing|frequent stakeholder meetings|daily stakeholder meetings)\b/i.test(text);
  const span = (quote: string) => evidenceSpan(input, "ROLE_SHAPE", quote);
  return {
    status: technical ? "SUPPORTED" : "UNKNOWN",
    role_families: [
      ...(technical ? ["TECHNICAL"] : []),
      ...(deliveryScope === "TECHNICAL_PROJECT" || deliveryScope === "TECHNICAL_PROGRAMME" ? ["TECHNICAL_DELIVERY"] : []),
      ...(deliveryScope === "TECHNICAL_PRODUCT" ? ["TECHNICAL_PRODUCT"] : []),
    ],
    domain_families: [],
    technical_ownership: /\b(own|design|architect|build|implement|technical roadmap)\b/i.test(text) ? "MEANINGFUL" : "UNKNOWN",
    hands_on_coding: codingRequired ? "REQUIRED" : "UNKNOWN",
    architecture_scope: architectureRequired ? "REQUIRED" : "UNKNOWN",
    delivery_scope: deliveryScope,
    sales_ownership: quotaOwned ? "QUOTA_OR_CLOSING" : salesSupport ? "TECHNICAL_SUPPORT_ONLY" : "NO_EVIDENCE",
    people_management: managementRequired ? "REQUIRED" : "UNKNOWN",
    interaction_burden: interactionHigh ? "HIGH" : "UNKNOWN",
    evidence: [
      ...(codingRequired ? [span("Hands-on coding or implementation explicitly required") ] : []),
      ...(architectureRequired ? [span(input.title)] : []),
      ...(quotaOwned || salesSupport ? [span(text.slice(0, 240))] : []),
    ],
  };
}

function stableEvidenceProjection(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => stableEvidenceProjection(item, parentKey));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => {
      if (["retrieved_at", "observed_at", "raw_payload_hash"].includes(key)) return false;
      return !(parentKey === "availability" && ["verified_at", "expires_at"].includes(key));
    })
    .map(([key, child]) => [key, stableEvidenceProjection(child, key)]));
}

export function buildEvidenceRevisionHash(evidence: JobSourceEvidence): string {
  return sha256Hex(stableStringify(stableEvidenceProjection(evidence)));
}

export function buildJobSourceEvidence(input: BuildJobSourceEvidenceInput): JobSourceEvidence {
  const records = payloadRecords(input.rawPayload);
  const normalizedDescription = normalizeDescription(input);
  const descriptionHash = sha256Hex(normalizedDescription.normalizedText);
  const quality = classifyDescriptionQuality(normalizedDescription.normalizedText);
  const freshness = extractFreshnessEvidence({
    rawPayload: input.rawPayload,
    sourceName: input.sourceName,
    sourceExternalId: input.sourceExternalId,
    canonicalUrl: input.sourceUrl ?? input.canonicalApplyUrl,
    contentHash: descriptionHash,
  });
  const at = new Date(input.retrievedAt);
  const retrievedAt = Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString();
  const explicitStatus = String(firstValue(records, ["status", "jobStatus", "applicationStatus"]) ?? "").toLowerCase();
  const directAts = ["GREENHOUSE", "LEVER", "ASHBY"].includes(input.sourceName.toUpperCase());
  const isClosed = /^(closed|expired|filled|inactive|not accepting applications)$/.test(explicitStatus)
    || firstValue(records, ["isClosed", "closed"]) === true;
  const isExplicitOpen = /^(open|active|published|live)$/.test(explicitStatus)
    || firstValue(records, ["isOpen", "active"]) === true;
  const availabilityStatus = isClosed ? "CLOSED" : directAts || isExplicitOpen ? "OPEN" : "UNKNOWN";
  const availabilityVerifiedAt = availabilityStatus === "UNKNOWN" ? null : retrievedAt;
  const availabilityExpiresAt = availabilityVerifiedAt
    ? new Date(new Date(availabilityVerifiedAt).getTime() + 24 * 60 * 60 * 1000).toISOString()
    : null;
  const availabilityEvidence = availabilityStatus === "UNKNOWN"
    ? []
    : [evidenceSpan(input, "AVAILABILITY", isClosed ? `Source status: ${explicitStatus || "closed"}` : `Active public listing observed from ${input.sourceName}`)];
  const modeValue = normalizedWorkMode(input.workplaceTypeRaw);
  const assumedMode = (input.workplaceTypeRaw ?? "").toUpperCase() === "ASSUMED_HYBRID";
  const officeDaysMatch = input.descriptionText.match(/\b([1-5])\s*days?\s*(?:per\s*week|a\s*week|\/week)?\s*(?:in|at)?\s*(?:the\s*)?office\b/i);
  const travelMatch = input.descriptionText.match(/\b(?:up\s+to\s+)?(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?%\s+travel\b/i);
  const territories = /\b(must reside|must be based|must be authorized|only residents|remote only in|eligible to work in|must work from)\b/i.test(input.descriptionText)
    ? input.descriptionText.match(/\b(?:Singapore|Australia|United States|United Kingdom|Canada|Germany|France|India|Japan|New Zealand)\b/gi) ?? []
    : [];
  const territorySpan = territories.length > 0
    ? [evidenceSpan(input, "HIRING_TERRITORY", territories.join(" / "))]
    : [];
  const employmentRouteValues = [
    ...( /\b(employer of record|\bEOR\b)\b/i.test(input.descriptionText) ? ["EOR_EMPLOYEE"] : []),
    ...( /\b(independent contractor|individual contractor|contractor engagement)\b/i.test(input.descriptionText) ? ["INDIVIDUAL_CONTRACTOR"] : []),
    ...( /\b(Singapore entity|local employing entity|Singapore payroll)\b/i.test(input.descriptionText) ? ["SG_EMPLOYEE"] : []),
  ];
  const categoryText = String(firstValue(records, ["organizationType", "organization_type", "companyType", "company_type"]) ?? "").toLowerCase();
  const employerIdentity = input.companyName.toLowerCase();
  const category = /\b(university|academic institution|research institute)\b/i.test(categoryText)
    || /\b(university|institute of technology)\b/i.test(employerIdentity)
      ? "UNIVERSITY_RESEARCH"
      : /\b(multilateral|intergovernmental|ngo|nonprofit|non-profit|united nations)\b/i.test(categoryText)
        || /\b(world bank|united nations|unicef|undp|international finance corporation)\b/i.test(employerIdentity)
        ? "MISSION_MULTILATERAL"
        : null;
  const categoryQuote = category ? `${input.companyName} (${categoryText || "recognized employer identity"})` : "";
  const sourceIdentity = freshness.postingIdentityHash;

  return JobSourceEvidenceSchema.parse({
    schema_version: "job_source_evidence_v1",
    normalizer_version: "job_source_evidence_builder_v1",
    source_name: input.sourceName,
    source_plugin_key: input.sourcePluginKey,
    source_plugin_revision_id: input.sourcePluginRevisionId,
    source_external_id: input.sourceExternalId,
    source_identity_hash: sourceIdentity,
    employer_posting_url: safeUrl(input.sourceUrl),
    application_url: safeUrl(input.canonicalApplyUrl),
    raw_payload_hash: input.rawPayloadHash,
    retrieved_at: retrievedAt,
    description: {
      normalized_text: normalizedDescription.normalizedText,
      normalized_text_hash: descriptionHash,
      completeness_status: quality.status,
      completeness_reasons: quality.reason ? [quality.reason] : [],
      segments: normalizedDescription.segments,
    },
    dates: {
      published_at: dateEvidence(input, records, ["posted_at", "date_posted", "datePosted", "published_at", "publishedAt", "publication_date", "pubDate", "date_created", "dateCreated"], "PUBLISHED_AT", freshness.sourcePublishedAt),
      reposted_at: dateEvidence(input, records, ["reposted_at", "date_reposted", "repost_date", "repostedAt"], "GENUINE_REPOST_AT", freshness.repostedAt),
      source_updated_at: dateEvidence(input, records, ["source_updated_at", "last_modified_at", "lastModified", "updated_at", "updatedAt"], "SOURCE_UPDATED_AT", freshness.sourceUpdatedAt),
      expires_at: dateEvidence(input, records, ["source_expires_at", "expires_at", "expiresAt", "validThrough", "valid_through", "applicationDeadline", "application_deadline", "closingDate", "close_date"], "EXPIRES_AT", freshness.sourceExpiresAt),
    },
    availability: {
      status: availabilityStatus,
      verified_at: availabilityVerifiedAt,
      expires_at: availabilityExpiresAt,
      verification_method: availabilityStatus === "UNKNOWN" ? "NONE" : directAts ? "EMPLOYER_ATS_LISTING" : "EXPLICIT_SOURCE_STATUS",
      reason_code: availabilityStatus === "OPEN" ? "CURRENT_LISTING_EVIDENCE" : availabilityStatus === "CLOSED" ? "SOURCE_EXPLICITLY_CLOSED" : "AVAILABILITY_NOT_VERIFIED",
      evidence: availabilityEvidence,
    },
    workability: {
      hiring_territories: {
        status: territories.length > 0 ? "SUPPORTED" : "UNKNOWN",
        operator: territories.length === 0 ? "UNKNOWN" : /\bor\b/i.test(input.descriptionText) ? "ANY" : "ALL",
        countries: [...new Set(territories)],
        evidence: territorySpan,
      },
      work_mode: {
        status: assumedMode || modeValue === "UNKNOWN" ? "UNKNOWN" : "SUPPORTED",
        value: modeValue,
        office_days_min: officeDaysMatch ? Number(officeDaysMatch[1]) : null,
        office_days_max: officeDaysMatch ? Number(officeDaysMatch[1]) : null,
        evidence: modeValue === "UNKNOWN" ? [] : [evidenceSpan(input, "WORK_MODE", assumedMode ? "Work mode inferred as hybrid; employer confirmation required" : input.workplaceTypeRaw ?? modeValue)],
      },
      employment_routes: {
        status: employmentRouteValues.length > 0 ? "SUPPORTED" : "UNKNOWN",
        values: employmentRouteValues.length > 0 ? employmentRouteValues : ["UNKNOWN"],
        evidence: employmentRouteValues.length > 0 ? [evidenceSpan(input, "EMPLOYMENT_ROUTE", input.descriptionText.slice(0, 300))] : [],
      },
      timezone_overlap: { status: "UNKNOWN", value: null, evidence: [] },
      travel_pct: {
        status: travelMatch ? "SUPPORTED" : "UNKNOWN",
        minimum: travelMatch ? Number(travelMatch[1]) : null,
        maximum: travelMatch ? Number(travelMatch[2] ?? travelMatch[1]) : null,
        evidence: travelMatch ? [evidenceSpan(input, "TRAVEL", travelMatch[0])] : [],
      },
      on_call: {
        status: /\b(no on[- ]call|no on-call|not on-call)\b/i.test(input.descriptionText) ? "SUPPORTED" : /\b(on[- ]call|on call)\b/i.test(input.descriptionText) ? "SUPPORTED" : "UNKNOWN",
        required: /\b(no on[- ]call|no on-call|not on-call)\b/i.test(input.descriptionText) ? false : /\b(on[- ]call|on call)\b/i.test(input.descriptionText) ? true : null,
        evidence: /\b(on[- ]call|on call)\b/i.test(input.descriptionText) ? [evidenceSpan(input, "ON_CALL", input.descriptionText.match(/[^.\n]*\b(?:on[- ]call|on call)\b[^.\n]*/i)?.[0] ?? "on-call requirement mentioned")] : [],
      },
    },
    compensation: parseCompensation(input, records),
    role_shape: roleShape(input),
    opportunity_category: {
      status: category ? "SUPPORTED" : "UNKNOWN",
      value: category,
      evidence: category ? [evidenceSpan(input, "OPPORTUNITY_CATEGORY", categoryQuote)] : [],
    },
  });
}
