import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

const SourceKeySchema = z.string().regex(/^[a-z][a-z0-9_]{2,63}$/);

const SourcePluginKindSchema = z.enum([
  "ats",
  "json_api",
  "rss",
  "atom",
  "schema_org",
  "email_alert",
  "manual_import",
]);

const SourcePluginStatusSchema = z.enum(["active", "experimental", "disabled", "deprecated"]);

const SourcePluginCapabilitiesSchema = z.object({
  discovery: z.boolean(),
  pagination: z.boolean(),
  incremental: z.boolean(),
  location_filter: z.boolean(),
  work_mode_evidence: z.boolean(),
});

const SourcePluginComplianceSchema = z.object({
  access_basis: z.enum([
    "official_api",
    "public_feed",
    "user_supplied",
    "manual_import",
    "documented_permission",
  ]),
  terms_url: z.string().url(),
  license: z.string().nullable().optional(),
  attribution_required: z.boolean(),
  attribution_text: z.string().nullable().optional(),
  authenticated_scraping: z.literal(false),
  reviewed_at: z.string().optional(),
});

const SourcePluginScheduleSchema = z.object({
  enabled: z.boolean(),
  interval_minutes: z.number().int().min(15).max(10080),
  jitter_seconds: z.number().int().min(0).max(3600).default(0),
});

const SourcePluginRetrySchema = z.object({
  max_attempts: z.number().int().min(0).max(10),
  base_delay_ms: z.number().int().min(100),
  max_delay_ms: z.number().int().min(100),
});

const SourcePluginRateLimitSchema = z.object({
  requests_per_minute: z.number().int().min(1),
  items_per_run: z.number().int().min(1).nullable(),
});

const SourcePluginPaginationSchema = z.object({
  strategy: z.enum(["none", "page", "cursor", "link_header", "updated_since"]),
  page_parameter: z.string().nullable().optional(),
  cursor_json_path: z.string().nullable().optional(),
  next_link_json_path: z.string().nullable().optional(),
  checkpoint_field: z.string().nullable().optional(),
});

const SourcePluginQuerySchema = z
  .object({
    keywords: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
    work_modes: z.array(z.enum(["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"])).optional(),
    lane_keys: z.array(z.string()).optional(),
  })
  .optional();

const SourcePluginRequestSchema = z.object({
  endpoint: z.string().url(),
  timeout_ms: z.number().int().min(1000).max(120000),
  headers_from_secret_keys: z.array(z.string()).default([]).optional(),
  retry: SourcePluginRetrySchema,
  rate_limit: SourcePluginRateLimitSchema,
  pagination: SourcePluginPaginationSchema,
  query: SourcePluginQuerySchema,
});

const SourcePluginMappingSchema = z.object({
  external_id: z.string(),
  title: z.string(),
  company: z.string(),
  description: z.string(),
  url: z.string(),
  location: z.string(),
  work_mode: z.string(),
  employment_type: z.string(),
  posted_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

export const SourcePluginSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  source_key: SourceKeySchema,
  display_name: z.string().min(1).max(100),
  kind: SourcePluginKindSchema,
  status: SourcePluginStatusSchema,
  capabilities: SourcePluginCapabilitiesSchema,
  compliance: SourcePluginComplianceSchema,
  schedule: SourcePluginScheduleSchema,
  request: SourcePluginRequestSchema,
  mapping: SourcePluginMappingSchema,
});

export type SourcePlugin = z.infer<typeof SourcePluginSchema>;

