# Data Contracts

Runtime contracts are defined in `src/contracts/index.ts`. JSON Schema artifacts in `src/contracts/json/` are generated with:

```bash
npm run contracts:export
```

CI runs `npm run contracts:check`, which regenerates schemas and fails when committed artifacts drift.

## Boundaries

- `IngestionEnvelope`: source identity, run identity, raw payload, and hash.
- `ExtractedJob`: normalized adapter/extractor output with raw payload and attribution metadata.
- `JobObservation`: persisted staging record.
- `CanonicalJobVersion`: canonical identity plus immutable description version.
- `GateDecision`: deterministic outcome and evidence.
- `LaneDecision`: semantic lane scores and evidence.
- `EvaluationQueueItem`: version-pinned lease/retry state.
- `EvaluationResult`: validated model output and provider audit metadata.
- `ShortlistRow`: version-pinned database read model consumed by Streamlit.
- `ApplicationReadiness`: strict runtime validation on persistence and on current-readiness consumption; `READY` cannot include unresolved mandatory checks.
- `DocumentOutputManifest`: versioned DOCX/PDF paths and SHA-256 hashes; document provenance rejects unversioned or malformed output manifests.
- Profile contact facts use versioned `CONTACT` rows with a supported key/value pair, `PRIVATE_INTERNAL` confidentiality, and `VERIFIED` or `SELF_ATTESTED` status. They are available to document rendering only and must be excluded from matching, embeddings, model evaluation context, and capability-profile artifacts.
- Compensation readiness treats undisclosed base salary as a preferred verification item; disclosed below-floor compensation remains a blocking check.

Canonical source names use uppercase values from `SourceNameSchema`. Schema tests require every exported boundary schema to contain object properties and required fields.
