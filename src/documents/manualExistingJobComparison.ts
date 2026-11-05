/**
 * Entry point for the pipeline: prepare a manual comparison for a job it already holds, then hand the
 * returned comparisonId to the existing review, approve and generate screens. The logic lives with the
 * manual route so both paths build the same comparison, pairing, corrections model and fingerprint.
 */
export {
  prepareComparisonForExistingJobVersion,
  ManualFlowError,
  type ExistingJobComparison,
  type ExistingJobComparisonRequest,
  type StagedManualComparison,
} from "../api/v2/manualApplicationRouter.js";
