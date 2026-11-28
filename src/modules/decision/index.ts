/** Public file of the decision module: the only file other code may import. */
export { classifyJob, classifySector, roleKindOfTitle, statedTravelPercent, type CompanyIndustryTags, type JobClassification } from "./domain/jobClassifier.js";
export {
  FUNCTION_TAGS,
  parseRankingDesign,
  requireApprovedDesign,
  type RankingDesign,
  type RoleKind,
} from "./domain/rankingDesign.js";
export { buildReviewLists, collapsePool, jobIdOrder, sheetJobs, type PoolJob, type ReviewLists } from "./domain/reviewLists.js";
export { sheetCompany, sheetLocation, sheetPostingText } from "./domain/postingText.js";
export {
  EMPTY_DRAFT,
  listedPositions,
  openDraft,
  sealDraft,
  updateDraft,
  type DraftState,
  type DroppedJob,
} from "./domain/reviewDraft.js";
export {
  buildReviewKey,
  changedAfterShown,
  openShownAnswers,
  sealShownAnswers,
  type ShownAnswers,
  idsFromKeyText,
  openReviewKey,
  parseFilledSheet,
  renderCheckByHand,
  renderReveal,
  renderReviewSheet,
  scoreReviewSheet,
  type ReviewDetail,
  type ReviewKey,
  type ReviewScore,
} from "./domain/reviewSheet.js";
export {
  buildReviewListsFromStore,
  type ReviewListInput,
  type ReviewListResult,
  type ReviewListRules,
} from "./handlers/reviewLists.js";
export { CHECK_TIME_ZONE, countUncheckedJobs, type CheckLinkRules } from "./handlers/uncheckedJobs.js";
