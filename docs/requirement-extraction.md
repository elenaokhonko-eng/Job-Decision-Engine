# Requirement extraction (`deterministic_v4`)

Before `deterministic_v4` the extractor wrote at most one `DOMAIN` and one `FUNCTION`
requirement per job. Their text was a fixed template sentence ("Role includes a target
technical domain requirement."), so every job looked alike to the matcher and the embedding
model, and the only job-specific text was a two-word quote such as "AI".

`deterministic_v4` stores what the posting actually says.

## What is extracted

1. **Structure.** `src/requirements/postingStructure.ts` splits a posting into sections
   (responsibilities, requirements, nice-to-have, with intro and company/benefits text
   skipped) and items. Stored postings are usually flattened into one paragraph, so it also
   reads inline headings ("Requirements:", "What We Are Looking For"), headings glued to the
   next sentence, and bullet glyphs, always with offsets into the original text.
2. **Items.** `src/requirements/postingItemRequirements.ts` turns each item into a `CUSTOM`
   requirement. `requirement_text` and `quote_text` are the posting's exact words. Each item
   is classed as `SKILL`, `TOOL`, `RESPONSIBILITY`, `YEARS`, `DEGREE` or `CERTIFICATE`
   (`structured_value.item_class`), carries its section, and records alternatives ("A, B or C"
   options, "or equivalent experience", "or related field"). Nice-to-have items are
   `NICE_TO_HAVE`; "is valued"-style wording is `PREFERRED`.
   **`deterministic_v5`: duties and unheaded skills are not mandatory.** `MUST` was the fallback
   when nothing said otherwise, which made about 40% of all `MUST` requirements job duties
   ("You will lead ..."). A `RESPONSIBILITY` item, and any skill in a posting with no
   headings, is now `PREFERRED` unless the item itself says required, mandatory, must,
   essential or minimum (`settleItemImportance`). They stay in the requirement set and are
   still scored; they just do not count as mandatory. Skills under a requirements heading stay
   `MUST`.
3. **Rules keep the structured facts.** Years, degrees and credentials are still extracted by
   the existing rules and are not repeated as items. Workability lines (on-call, visa,
   hybrid, benefits) and negated lines never become capability items.
4. **Thin postings.** Fewer than 3 confirmed capability requirements is recorded as
   `needs_description` in the extraction run payload. The matcher reports the job's profile
   match as `UNKNOWN`, never `NO_PROFILE_MATCH` (unless a mandatory qualification failed).
5. **AI only when rules fall short.** The quoted extractor is asked only when the rules found
   fewer than 5 items. Quotes must be found in the posting (loose on spacing and quote marks
   only); verified quotes are kept and the rest dropped. The AI never sets a score. A job that
   skipped the AI step gets a completed `LLM_QUOTED` audit row (`RULES` / `AI_NOT_NEEDED`) so
   it is not re-queued.
6. **Matching text.** A posting item is embedded and matched as its own sentence: no type
   label, quote prefix or JSON. Older requirements keep their previous text.

## Rolling out

The extractor version is a single constant, `DETERMINISTIC_EXTRACTOR_VERSION`. Changing it
makes task keys and requirement-set identities new, so existing jobs are re-extracted by the
normal queue; nothing is deleted. Re-extract and re-match in a replay database first and judge
the result with `npm run measure:ranking`.

## Preview on real postings (read-only)

`npm run preview:requirements` runs the extractor in memory over the stored descriptions of
the saved and non-fit jobs and prints counts only: no writes, no AI calls, no posting text.

## Job score policy (`SCORING_POLICY`)

The ranking score is chosen by the `SCORING_POLICY` environment variable and is off by default.

| Policy | Job score |
| --- | --- |
| `legacy_weighted_v1` (default) | Weighted share of all requirements credited by evidence. |
| `topk_capability_semantic_v1` | Mean semantic similarity of the 7 best capability requirements (0-100). |

Why: on the replay branch, with 5-fold cross-validation, word overlap alone separates saved from
non-fit jobs no better than chance (0.51), and years, degree and certificate rows match almost
every job, so they add nothing to the ranking. The share of all requirements punishes a long
posting for bullets nobody matches. The top-K mean is stable for K = 3 to 12 (0.77 to 0.84); K is
fixed at 7, the middle of that plateau, and is not tuned further. A penalty for unmatched
must-haves lowered separation at every weight tried, so it is not in the score.

- Years, degrees and credentials leave the ranking score only. They are still compared with the
  profile, still produce mandatory-qualification failures, and still feed the career-track cap
  (`src/pipeline/careerTrack.ts` reads the requirement rows, not the score).
- Unmatched must-haves are reported beside each job (`unmatchedMustHaves` in
  `src/pipeline/scoringPolicy.ts`), not scored.
- The policy has its own matcher version (`deterministic_v3+topk_capability_semantic_v1`), so
  turning it on makes older matches superseded and the queue re-matches them. Existing cut-offs
  (`recommendation_*` thresholds) are on the legacy scale and must be re-fitted before the flag is
  turned on in production; the cut-offs are not fitted here.
- Role fit (lane, track, title family) is deliberately not in the score yet: most jobs have no lane
  until the production replay.
