/** Public file of the decision module: the only file other code may import. */
export { classifyJob, classifySector, roleKindOfTitle, statedTravelPercent, type CompanyIndustryTags, type JobClassification } from "./domain/jobClassifier.js";
export {
  FUNCTION_TAGS,
  parseRankingDesign,
  requireApprovedDesign,
  type RankingDesign,
  type RoleKind,
} from "./domain/rankingDesign.js";
export { buildReviewLists, collapsePool, sheetJobs, type PoolJob, type ReviewLists } from "./domain/reviewLists.js";
export {
  buildReviewKey,
  idsFromKeyText,
  renderReviewSheet,
  scoreReviewSheet,
  type ReviewKey,
  type ReviewScore,
} from "./domain/reviewSheet.js";
export {
  buildReviewListsFromStore,
  type ReviewListInput,
  type ReviewListResult,
  type ReviewListRules,
} from "./handlers/reviewLists.js";
