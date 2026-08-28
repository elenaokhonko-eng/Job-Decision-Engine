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
  ShortlistRowSchema,
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
  ShortlistRow: ShortlistRowSchema,
};

console.log("Exporting runtime Zod contracts to JSON Schemas for Python and Streamlit...");

for (const [name, schema] of Object.entries(schemas)) {
  const jsonSchema = zodToJsonSchema(schema as any, name);
  const filePath = path.join(targetDir, `${name}.schema.json`);
  fs.writeFileSync(filePath, JSON.stringify(jsonSchema, null, 2), "utf-8");
  console.log(`- Exported: ${filePath}`);
}

console.log("✅ JSON Schema export complete.");
