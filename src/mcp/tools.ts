import {
  JobDecisionClient,
  type CreateApplicationInput,
  type ManualObservationInput,
  type UpdateApplicationInput,
} from "../sdk/index.js";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const applicationStatusEnum = [
  "INTENT",
  "READY_TO_APPLY",
  "SUBMITTED",
  "FOLLOW_UP",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "WITHDRAWN",
  "CLOSED",
];

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function stringArg(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (!required) return undefined;
  throw new Error(`${key} is required.`);
}

export function createJobDecisionMcpTools(client: JobDecisionClient): McpToolDescriptor[] {
  return [
    {
      name: "job_decision.list_shortlist",
      description: "List current canonical shortlist rows for the active workspace.",
      inputSchema: objectSchema({
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string" },
      }),
      handler: async (args) => client.listShortlist({
        limit: typeof args.limit === "number" ? args.limit : undefined,
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      }),
    },
    {
      name: "job_decision.create_manual_observation",
      description: "Stage a manually supplied job observation for downstream pipeline processing.",
      inputSchema: objectSchema({
        title: { type: "string", minLength: 1 },
        company: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
        source: { type: "string" },
        salaryRange: { type: "string" },
        location: { type: "string" },
        careers_portal_url: { type: "string" },
      }, ["title", "company", "description"]),
      handler: async (args) => client.createManualObservation({
        title: stringArg(args, "title")!,
        company: stringArg(args, "company")!,
        description: stringArg(args, "description")!,
        source: stringArg(args, "source", false),
        salaryRange: stringArg(args, "salaryRange", false),
        location: stringArg(args, "location", false),
        careers_portal_url: stringArg(args, "careers_portal_url", false),
      } satisfies ManualObservationInput),
    },
    {
      name: "job_decision.create_application_handoff",
      description: "Create or update a human-owned application handoff record for a canonical job.",
      inputSchema: objectSchema({
        canonical_job_id: { type: "string", format: "uuid" },
        job_version_id: { type: "string", format: "uuid" },
        status: { type: "string", enum: applicationStatusEnum },
        submission_url: { type: "string" },
        cv_document_run_id: { type: "string", format: "uuid" },
        cover_letter_document_run_id: { type: "string", format: "uuid" },
        notes: { type: "string" },
        handoff_payload: { type: "object" },
        target_submit_at: { type: "string", format: "date-time" },
        follow_up_at: { type: "string", format: "date-time" },
      }, ["canonical_job_id"]),
      handler: async (args) => client.createApplication({
        canonical_job_id: stringArg(args, "canonical_job_id")!,
        job_version_id: stringArg(args, "job_version_id", false),
        status: stringArg(args, "status", false) as CreateApplicationInput["status"],
        submission_url: stringArg(args, "submission_url", false) ?? null,
        cv_document_run_id: stringArg(args, "cv_document_run_id", false) ?? null,
        cover_letter_document_run_id: stringArg(args, "cover_letter_document_run_id", false) ?? null,
        notes: stringArg(args, "notes", false) ?? null,
        handoff_payload: args.handoff_payload && typeof args.handoff_payload === "object" && !Array.isArray(args.handoff_payload)
          ? args.handoff_payload as Record<string, unknown>
          : undefined,
        target_submit_at: stringArg(args, "target_submit_at", false) ?? null,
        follow_up_at: stringArg(args, "follow_up_at", false) ?? null,
      }),
    },
    {
      name: "job_decision.update_application_status",
      description: "Update a human-owned application tracker record and append an event.",
      inputSchema: objectSchema({
        application_record_id: { type: "string", format: "uuid" },
        status: { type: "string", enum: applicationStatusEnum },
        notes: { type: "string" },
        follow_up_at: { type: "string", format: "date-time" },
        event_payload: { type: "object" },
      }, ["application_record_id"]),
      handler: async (args) => client.updateApplication(
        stringArg(args, "application_record_id")!,
        {
          status: stringArg(args, "status", false) as UpdateApplicationInput["status"],
          notes: stringArg(args, "notes", false) ?? null,
          follow_up_at: stringArg(args, "follow_up_at", false) ?? null,
          event_payload: args.event_payload && typeof args.event_payload === "object" && !Array.isArray(args.event_payload)
            ? args.event_payload as Record<string, unknown>
            : undefined,
        }
      ),
    },
    {
      name: "job_decision.list_application_events",
      description: "List the event history for a human-owned application tracker record.",
      inputSchema: objectSchema({
        application_record_id: { type: "string", format: "uuid" },
        limit: { type: "integer", minimum: 1, maximum: 250 },
      }, ["application_record_id"]),
      handler: async (args) => client.listApplicationEvents(
        stringArg(args, "application_record_id")!,
        { limit: typeof args.limit === "number" ? args.limit : undefined }
      ),
    },
  ];
}
