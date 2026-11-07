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
- Gmail: alerts from sources without supported public APIs.

## Failure Semantics

A source may return a successful empty result. HTTP errors, timeouts, rate limits, and malformed records are distinct outcomes. Invalid records are quarantined by validation; failed sources make the unified run `DEGRADED` when another source succeeds, or `FAILED` when every enabled source fails.

## Adding A Source

1. Add its canonical uppercase ID to `SourceNameSchema`.
2. Implement an adapter extending `BaseSourceAdapter`.
3. Preserve source ID, canonical URL, attribution, and raw payload.
4. Add or update the source plugin manifest under `config/source-plugins/`.
5. Wire it into `scripts/run_adapters.ts`.
6. Add success, malformed, timeout, rate-limit, all-quarantined, and empty-result tests.

## Saved jobs from Streamlit (LinkedIn and MyCareersFuture)

The Streamlit **Saved jobs** tab runs the same imports as the commands below without a terminal. Each source has the numbered export steps, the current console script (read at runtime from `scripts/linkedin/export_saved_jobs.console.js` / `scripts/mcf/export_saved_jobs.console.js`, so it cannot drift), a file upload, **Validate (dry run)** and **Import**. Import stays disabled until a successful dry run of the same file (keyed on the file's SHA-256). Results show collected/valid/invalid/new/already-imported counts, a checklist, invalid items grouped by reason code with what to do, parked Gmail alerts the import unblocks, and a copyable block of counts and reason codes only. First time, try 3 to 5 saved jobs.

Streamlit calls the authenticated API; it never touches the database:

- `POST /api/v2/imports/linkedin-saved` and `POST /api/v2/imports/mcf-saved` (bearer token, workspace headers, writable role) with body `{ "items": [...the exported JSON array...], "dryRun": true|false }`. They call `importLinkedInSavedJobs` / `importMcfSavedJobs`; a dry run runs in a read-only transaction that is rolled back.
- Response (`schema_version: saved_jobs_import_v1`): `mode`, `complete` (false when the CLI would exit 1), `totals`, `invalid` (`index`, `reason`), `duplicates_in_file`, and per-item `job_id`, `outcome`, `observation_id`, `description_quality` and Gmail matches. No titles, employers or descriptions are returned.
- Limits: 500 items and 8 MB per request (413 `TOO_MANY_ITEMS` / `PAYLOAD_TOO_LARGE`); use the CLI for a larger file. A non-array, empty or malformed body is 400.
- The retired `POST /api/v2/observations/linkedin` (which wrote `LINKEDIN` rows with a default location of Singapore) now returns **410 Gone** and writes nothing.

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

## MyCareersFuture Saved Jobs (manual browser export)

MyCareersFuture (MCF) Gmail alerts are retired. Jobs you save on https://www.mycareersfuture.gov.sg reach the pipeline only through a file you export yourself. The repository never signs in to MCF, holds an MCF session or cookie, drives a headless browser, or accesses MCF on a schedule.

Compliance: MCF's Terms of Use give visitors a personal licence but do not allow storing site content in a retrieval system without written permission from SWDA, which runs MCF. That permission has not been obtained, so this source is recorded as **user-accepted risk, pending SWDA permission** (see `docs/source-compliance-matrix.md`). Use it only for your own saved jobs and personal job search. To ask for permission, use the SWDA feedback portal: https://service-portal.swda.gov.sg/s/feedback.

1. Export in your own browser.
   1. Sign in to https://www.mycareersfuture.gov.sg and open **Saved Jobs** (https://www.mycareersfuture.gov.sg/saved-jobs).
   2. Leave the filter on **All Job Status** and stay on page 1.
   3. Open the developer console (Chrome/Edge: F12 or Ctrl+Shift+J; Firefox: Ctrl+Shift+K), paste the whole of `scripts/mcf/export_saved_jobs.console.js` and press Enter.

   The snippet walks the list pages with the list's own Next button, waiting for the job set to change after each click. For each saved job it then requests the job's public details the way the MCF job page does (`GET https://api.mycareersfuture.gov.sg/v2/jobs/<job id>`, no cookies), one at a time about 2 seconds apart. It stops on HTTP 429, a server error or a non-JSON error page; `await jdeMcfExport.resume()` continues later. It prints expected vs collected counts and downloads `mcf_saved_jobs.json`.

   MCF does not show a saved-jobs total, so "expected" is the range implied by the pagination; a page with fewer cards than page 1 (other than the last) is reported. Only the importer's fields are written. Recruiter contact data such as `metadata.emailRecipient` is dropped in the browser. A hidden employer, salary or address stays `null`.
2. Dry run. This writes nothing; it validates every item and reports matches with existing jobs and with parked Gmail MCF alert cards:

   ```bash
   npm run import:mcf-saved -- path/to/mcf_saved_jobs.json --dry-run
   ```

3. Import:

   ```bash
   npm run import:mcf-saved -- path/to/mcf_saved_jobs.json
   ```

   Optional `--workspace-key KEY` / `--user-key KEY` select the workspace (default: the environment's workspace). The command prints counts and job ids only. It exits 1 if any item is invalid or fails to stage; the valid items are still staged.
4. Let the pipeline worker run (`npm run pipeline:worker`, or the scheduled pipeline).

What the import does:

- Each valid item becomes an `MCF_SAVED` observation through `SourceBroker`:
  - plugin `mcf_saved`, external id `mcf-job:<uuid>`;
  - URL `https://www.mycareersfuture.gov.sg/job/<category>/<slug>-<uuid>` as exported, without its query string;
  - raw payload and SHA-256 hash, status `PENDING`.

  Its `NORMALIZE_OBSERVATION` task is seeded by the standard scoped seeder. Re-importing the same file stages nothing new; `exportedAt` is not hashed, so a later re-export of unchanged jobs also deduplicates.
- Items are validated strictly (`McfSavedJobItemSchema`); unknown fields, including any raw MCF API field, are rejected. These are invalid:
  - a missing or placeholder company (`Company Undisclosed`, `Unknown`);
  - a missing or placeholder description;
  - `descriptionStatus` `MISSING`, `FETCH_FAILED` or `null`;
  - a URL that is not an MCF `/job/...-<32-hex id>` link, or an `mcfJobUuid` that differs from the id in the URL.
- When a Gmail MCF alert card for the same job id is waiting on content, and its title and employer agree, its `FETCH_JOB_CONTENT` task is reactivated. Waiting cards include those parked by `scripts/park_retired_alert_sources.ts`: `BLOCKED_DEPENDENCY` on `JOB_CONTENT`, repair action `IMPORT_SAVED_JOB_EXPORT`, observation `FETCH_BLOCKED`. Links wrapped in SES click tracking (`awstrack.me`) are unwrapped to find the id.
- The worker then uses the stored export instead of fetching the MCF page:
  - it stages an `MCF_SAVED` posting derived from the card, with `content_provenance = MCF_SAVED_EXPORT`, `imported_at` and `content_hash`;
  - it marks the card `FETCH_COMPLETE` and normalizes it.

  The export carries no HTTP fetch receipt, so it never makes a job's availability `OPEN`. The exported expiry date is kept as evidence only. A title or employer mismatch leaves the card parked and is reported.
- Salary becomes `compensation_raw` (for example `SGD 6,500 - 9,000 per month`) only when MCF shows both bounds. Employment type maps to `PERMANENT`/`CONTRACT` only when MCF lists exactly that kind. Work mode stays `UNKNOWN`. Unknown facts surface downstream as `NEEDS_VERIFICATION`.
- LinkedIn alert cards parked with `IMPORT_SAVED_JOB_EXPORT` are revived the same way by `npm run import:linkedin-saved`.
