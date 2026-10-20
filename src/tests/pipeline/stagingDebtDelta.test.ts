import { describe, expect, it } from "vitest";

import { newlyIntroducedStagingDebt } from "../../pipeline/stagingDebtDelta.js";

describe("newlyIntroducedStagingDebt", () => {
  it("does not classify unchanged inherited workspace debt as a release regression", () => {
    const baseline = {
      technicalErrors: 8,
      strandedNonterminalJobs: 17,
      pipelineRetryWait: 0,
      pipelineDeadLetter: 8,
    };

    expect(newlyIntroducedStagingDebt(baseline, baseline)).toEqual({
      technicalErrors: 0,
      strandedNonterminalJobs: 0,
      pipelineRetryWait: 0,
      pipelineDeadLetter: 0,
    });
  });

  it("reports only increases over the staging baseline as new debt", () => {
    expect(
      newlyIntroducedStagingDebt(
        {
          technicalErrors: 1,
          strandedNonterminalJobs: 17,
          pipelineRetryWait: 5,
          pipelineDeadLetter: 1,
        },
        {
          technicalErrors: 2,
          strandedNonterminalJobs: 16,
          pipelineRetryWait: 5,
          pipelineDeadLetter: 3,
        },
      ),
    ).toEqual({
      technicalErrors: 1,
      strandedNonterminalJobs: 0,
      pipelineRetryWait: 0,
      pipelineDeadLetter: 2,
    });
  });
});
