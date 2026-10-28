import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  IngestionEnvelopeSchema,
  ExtractedJobSchema,
  JobObservationSchema,
  CanonicalJobVersionSchema,
  GateDecisionSchema,
  LaneDecisionSchema,
  EvaluationQueueItemSchema,
  EvaluationResultSchema,
  ApplicationRecordSchema,
  ApplicationEventSchema,
  ShortlistRowSchema,
  SourcePluginSchema,
  ApplicationReadinessSchema,
  JobSourceEvidenceSchema,
  ExperienceRequirementScopeSchema,
  ProfileExperienceEvidenceSchema,
  ManualPostingInputSchema,
  ManualStagedPostingIdentitySchema,
  ManualCandidateProfileOptionSchema,
  ManualCandidateProfilesResponseSchema,
  ManualComparisonSourceSchema,
  ManualRequirementSchema,
  ManualEvidenceSchema,
  ManualComparisonRowSchema,
  ManualComparisonSchema,
  ManualCompareResponseSchema,
  ManualPersistedDraftSchema,
  ManualApprovalRequestSchema,
  ManualApprovalResponseSchema,
  ManualApprovalIdentitySchema,
  ManualPersistedApprovalSchema,
  ManualGenerateRequestSchema,
  ManualArtifactSchema,
  ManualDocumentsResponseSchema,
  ManualDownloadResponseSchema,
  ManualApiErrorSchema,
  ManualFetchDescriptionRequestSchema,
  ManualFetchDescriptionResponseSchema,
  ManualFetchDescriptionOutcomeSchema,
  ManualFetchSourceEvidenceSchema,
  ManualPersistedFetchReceiptSchema,
} from "../src/contracts/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetDir = path.resolve(__dirname, "../src/contracts/json");
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const schemas = {
  IngestionEnvelope: IngestionEnvelopeSchema,
  ExtractedJob: ExtractedJobSchema,
  JobObservation: JobObservationSchema,
  CanonicalJobVersion: CanonicalJobVersionSchema,
  GateDecision: GateDecisionSchema,
  LaneDecision: LaneDecisionSchema,
  EvaluationQueueItem: EvaluationQueueItemSchema,
  EvaluationResult: EvaluationResultSchema,
  ApplicationRecord: ApplicationRecordSchema,
  ApplicationEvent: ApplicationEventSchema,
  ShortlistRow: ShortlistRowSchema,
  SourcePlugin: SourcePluginSchema,
  ApplicationReadiness: ApplicationReadinessSchema,
  JobSourceEvidence: JobSourceEvidenceSchema,
  ExperienceRequirementScope: ExperienceRequirementScopeSchema,
  ProfileExperienceEvidence: ProfileExperienceEvidenceSchema,
  ManualPostingInput: ManualPostingInputSchema,
  ManualStagedPostingIdentity: ManualStagedPostingIdentitySchema,
  ManualCandidateProfileOption: ManualCandidateProfileOptionSchema,
  ManualCandidateProfilesResponse: ManualCandidateProfilesResponseSchema,
  ManualComparisonSource: ManualComparisonSourceSchema,
  ManualRequirement: ManualRequirementSchema,
  ManualEvidence: ManualEvidenceSchema,
  ManualComparisonRow: ManualComparisonRowSchema,
  ManualComparison: ManualComparisonSchema,
  ManualCompareResponse: ManualCompareResponseSchema,
  ManualPersistedDraft: ManualPersistedDraftSchema,
  ManualApprovalRequest: ManualApprovalRequestSchema,
  ManualApprovalResponse: ManualApprovalResponseSchema,
  ManualApprovalIdentity: ManualApprovalIdentitySchema,
  ManualPersistedApproval: ManualPersistedApprovalSchema,
  ManualGenerateRequest: ManualGenerateRequestSchema,
  ManualArtifact: ManualArtifactSchema,
  ManualDocumentsResponse: ManualDocumentsResponseSchema,
  ManualDownloadResponse: ManualDownloadResponseSchema,
  ManualApiError: ManualApiErrorSchema,
  ManualFetchDescriptionRequest: ManualFetchDescriptionRequestSchema,
  ManualFetchDescriptionResponse: ManualFetchDescriptionResponseSchema,
  ManualFetchDescriptionOutcome: ManualFetchDescriptionOutcomeSchema,
  ManualFetchSourceEvidence: ManualFetchSourceEvidenceSchema,
  ManualPersistedFetchReceipt: ManualPersistedFetchReceiptSchema,
};

console.log("Exporting runtime Zod contracts to JSON Schemas for Python and Streamlit...");

for (const [name, schema] of Object.entries(schemas)) {
  const jsonSchema = zodToJsonSchema(schema as any, name);
  const filePath = path.join(targetDir, `${name}.schema.json`);
  fs.writeFileSync(filePath, JSON.stringify(jsonSchema, null, 2), "utf-8");
  console.log(`- Exported: ${filePath}`);
}

console.log("✅ JSON Schema export complete.");
