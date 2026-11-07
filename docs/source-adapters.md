# Source Adapters

All adapters extend `BaseSourceAdapter`, validate mapped records with `ExtractedJobSchema`, and feed `SourceBroker`. Adapters never write canonical tables.

## Source Plugins (P12)

Source compliance/attribution metadata is defined in `config/source-plugins/*.yml` and can be synced into Postgres (versioned, immutable revisions) with:

```bash
npm run sources:sync
```

## Configured Sources

`config/source-plugins/*.yml` is the runtime source manifest. Sync it with `npm run sources:sync`; the active revision in PostgreSQL is what the source runner uses. `config/sources.yml` is retained only as a legacy config-registry import and is not read by the live adapter runner.

- Greenhouse, Ashby, Lever: employer ATS boards.
- Himalayas: public remote job API.
- Jobicy: public remote job API; attribution retained.
- Remotive: public remote job API; link-back attribution and 24-hour feed delay recorded.
- We Work Remotely: attributed RSS feed.
- Hacker News (`hacker_news`, source `HACKER_NEWS`): the monthly "Ask HN: Who is hiring?" thread through the official HN Firebase API (free, no key). See below.
- Gmail: alerts from sources without supported public APIs.

## Hacker News "Who is hiring?"

`src/ingestion/adapters/hackerNewsWhoIsHiringAdapter.ts` reads `user/whoishiring.json`, inspects the newest submissions (at most 6) and takes the newest story titled `Ask HN: Who is hiring?`; "Who wants to be hired?" and "Freelancer?" threads are skipped. No hiring thread is a source failure.

- One observation per top-level comment. Identity is the HN comment id; the posting URL is `https://news.ycombinator.com/item?id=<id>`; the raw payload is the HN item without its `kids` reply list (so new replies do not change the hash; an edit does) plus the thread id and title.
- The first line follows `Company | Role(s) | Location | REMOTE/ONSITE | Salary | URL`. Several roles stay in one title (`; `-joined). When the header only says "Multiple roles", short title lines or a `Roles:` line in the body supply the titles. A post without pipes is accepted only as `<Company> is hiring <role>`. Salary is kept only when written in the header (a funding amount is not salary); the apply URL is the header URL, else the first non-HN link.
- Deleted, dead, non-conforming and pre-filtered comments are returned as `filteredCandidates`; `scripts/run_adapters.ts` records each as a `FILTERED` disposition with its reason code (`HN_COMMENT_DELETED`, `HN_COMMENT_DEAD`, `HN_NON_CONFORMING_POST`, `HN_ITEM_UNAVAILABLE`, `HN_NOT_TOP_LEVEL_COMMENT`, `HN_EMPTY_COMMENT`, `PREFILTER_ONSITE_ONLY`, `PREFILTER_WORK_TERRITORY_INCOMPATIBLE`) and raw payload.
- Volume pre-filter, using the workspace's active workability policy: drop a post only when the header says on-site with no attendance qualifier and the post never mentions remote or hybrid work while the policy disallows on-site-only roles, or when the header carries an explicitly exclusive worker territory ("Remote (US only)", "US citizenship required") that the hard gate's own territory evaluation finds incompatible. Unknown or ambiguous facts pass to the gates. Lane terms and target functions are then applied by the runner's normal lane assessment.
- Bounds: at most 200 comments per run, 4 concurrent requests, 15 s per request, 180 s per run, one retry for 5xx/timeouts/network errors, a thread of more than 3,000 comments is refused. Any HTTP, timeout or JSON failure fails the page: nothing is staged and the cursor stays.
- Cursor `hn:<threadId>:<lastSettledCommentId>`: HN ids are monotonic, so later runs read only newer comments; the cursor never passes a comment younger than 3 hours (HN's edit window is 2 hours), so edits are re-read. A new monthly thread restarts at its first comment.

## Failure Semantics

A source may return a successful empty result. HTTP errors, timeouts, rate limits, and malformed records are distinct outcomes. Invalid records are quarantined by validation; failed sources make the unified run `DEGRADED` when another source succeeds, or `FAILED` when every enabled source fails.

## Adding A Source

1. Add its canonical uppercase ID to `SourceNameSchema`.
2. Implement an adapter extending `BaseSourceAdapter`.
3. Preserve source ID, canonical URL, attribution, and raw payload.
4. Add or update the source plugin manifest under `config/source-plugins/`.
5. Wire it into `scripts/run_adapters.ts`.
6. Add success, malformed, timeout, rate-limit, all-quarantined, and empty-result tests.

## LinkedIn Saved Jobs (manual browser export)

Saved LinkedIn jobs are your own selections. They reach the pipeline only through a file you export yourself; the repository never signs in to LinkedIn, holds a LinkedIn cookie, drives a headless browser, or unsaves jobs. `scripts/sync_linkedin_saved.ts` (headless Puppeteer with a session cookie, unsaves before staging) and `scripts/ingest_linkedin_saved.ts` (writes the legacy `raw_jobs` table, which the pipeline no longer reads, and defaults the location to Singapore) are deprecated and must not be used.

1. Export in your own browser. Open https://www.linkedin.com/my-items/saved-jobs/ (Job Tracker > Saved, page 1), open the developer console, paste `scripts/linkedin/export_saved_jobs.console.js` and press Enter. It walks the list pages, opens each saved job page one at a time about 2 seconds apart, stops on a rate limit or checkpoint (`await jdeLinkedInExport.resume()` continues later), prints expected vs collected counts and downloads `linkedin_saved_jobs.json`. Fields LinkedIn does not show are `null`; nothing is defaulted.
2. Dry run (writes nothing; validates every item and reports matches with existing jobs and blocked Gmail LinkedIn alerts):

   ```bash
   npm run import:linkedin-saved -- path/to/linkedin_saved_jobs.json --dry-run
   ```

3. Import:

   ```bash
   npm run import:linkedin-saved -- path/to/linkedin_saved_jobs.json
   ```

   Optional `--workspace-key KEY` / `--user-key KEY` select the workspace (default: the environment's workspace).
4. Let the pipeline worker run (`npm run pipeline:worker`, or the scheduled pipeline). Imported jobs go NORMALIZE -> requirements -> hard gates -> ... like any other source.

What the import does:

- Each valid item becomes a `LINKEDIN_SAVED` observation through `SourceBroker` (plugin `linkedin_saved`; external id `linkedin-job:<id>`; URL `https://www.linkedin.com/jobs/view/<id>`; raw payload and SHA-256 hash; `PENDING`), and its `NORMALIZE_OBSERVATION` task is seeded by the standard scoped seeder. Re-importing the same file stages nothing new (payload hash and task keys). `exportedAt` is not part of the hashed payload, so re-exporting unchanged jobs also deduplicates.
- Items are validated strictly (`LinkedInSavedJobItemSchema`). Invalid items are reported with their index and reason; the valid ones are still staged and the command exits 1. Missing company or description, `descriptionStatus` `MISSING`/`FETCH_FAILED`/`null`, and the earlier snippet's placeholders (`Unknown Company`, "Full description not available...", "Failed to fetch description automatically.") are invalid. In files from the earlier snippet (no `descriptionStatus`), a location of exactly `Singapore` was its default and is read as unknown.
- When a Gmail LinkedIn alert card for the same job id is waiting on posting content (`FETCH_PENDING`/`FETCH_BLOCKED`/`FETCH_FAILED`) and the title and employer agree, its blocked `FETCH_JOB_CONTENT` task is reactivated (or a `...:linkedin_saved` fetch task is queued when none is active). The worker then uses the stored export instead of a LinkedIn page fetch: it stages a `LINKEDIN_SAVED` posting derived from the card with `content_provenance = LINKEDIN_SAVED_EXPORT`, `imported_at` and `content_hash`, marks the card `FETCH_COMPLETE` and normalizes it. The export carries no HTTP fetch receipt, so it never makes a job's availability `OPEN`.
- Location, salary and work mode are kept only as exported (work mode only from an explicit "(Remote)/(Hybrid)/(On-site)" label); unknown facts stay unknown and surface downstream as `NEEDS_VERIFICATION`.
