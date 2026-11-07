# Source Compliance Matrix

This table is generated from `config/source-plugins/*.yml`. It helps non-engineers quickly understand where job data comes from and the compliance basis for each connector.

Regenerate with:

```bash
npm run docs:compliance
```

| source_key | display_name | kind | access_basis | terms_url | attribution_required | authenticated_scraping | reviewed_at | interval_minutes |
|---|---|---|---|---|---:|---:|---|---:|
| ashby | Ashby public job boards | ats | public_feed | https://ashbyhq.com/ | yes | no | 2026-09-06 | 1440 |
| gmail_alert | User-provided Gmail alerts (Gmail API) | email_alert | user_supplied | https://policies.google.com/terms | no | no | 2026-09-06 | 1440 |
| greenhouse | Greenhouse public job boards | ats | official_api | https://developers.greenhouse.io/job-board.html | yes | no | 2026-09-06 | 1440 |
| himalayas | Himalayas jobs feed | json_api | public_feed | https://himalayas.app/ | yes | no | 2026-09-06 | 60 |
| jobicy | Jobicy remote jobs feed | json_api | public_feed | https://jobicy.com/ | yes | no | 2026-09-06 | 60 |
| lever | Lever public job boards | ats | public_feed | https://www.lever.co/ | yes | no | 2026-09-06 | 1440 |
| linkedin | LinkedIn manual import (no automated scraping) | manual_import | manual_import | https://www.linkedin.com/legal/user-agreement | yes | no | 2026-09-06 | 1440 |
| linkedin_saved | LinkedIn saved jobs (user browser export, manual) | manual_import | user_supplied | https://www.linkedin.com/legal/user-agreement | yes | no | 2026-11-07 | 1440 |
| manual_import | Manual import (CSV/JSON/URL) | manual_import | manual_import | https://example.invalid/manual-import | no | no | 2026-09-06 | 1440 |
| manual_streamlit | Streamlit manual entry | manual_import | manual_import | https://example.invalid/manual-streamlit | no | no | 2026-09-06 | 1440 |
| remotive | Remotive remote jobs feed | json_api | public_feed | https://remotive.com/ | yes | no | 2026-09-06 | 1440 |
| searchapi_linkedin | LinkedIn jobs via SearchAPI (search + full job details) | json_api | official_api | https://www.searchapi.io/legal/terms | yes | no | 2026-11-07 | 1440 |
| smartrecruiters | SmartRecruiters public job boards (Posting API) | ats | official_api | https://developers.smartrecruiters.com/docs/posting-api | yes | no | 2026-11-08 | 1440 |
| we_work_remotely | We Work Remotely RSS feed | rss | public_feed | https://weworkremotely.com/ | yes | no | 2026-09-06 | 60 |
| workable | Workable public job boards | ats | public_feed | https://www.workable.com/terms | yes | no | 2026-11-08 | 1440 |

## Compliance notes

- `ashby`: Source job URL links to the employer's Ashby board.
- `greenhouse`: Source job URL links to the employer's Greenhouse board.
- `himalayas`: Use canonical Himalayas URL attribution for each posting.
- `jobicy`: Source postings are attributed to Jobicy; include canonical apply URL attribution where feasible.
- `lever`: Source job URL links to the employer's Lever board.
- `linkedin`: User-supplied LinkedIn job URL is stored for attribution; no automated scraping.
- `linkedin_saved`: The user's own saved-job selections, exported manually and at human pace in their own signed-in browser tab with scripts/linkedin/export_saved_jobs.console.js (it reads the rendered Saved-jobs list and opens each saved job page sequentially about 2 seconds apart, stopping on a rate limit or checkpoint), then imported with npm run import:linkedin-saved. The repository never signs in to LinkedIn, stores or reads no LinkedIn cookie, runs no headless browser or scheduled LinkedIn access, and never unsaves jobs. The LinkedIn job URL is kept for attribution; imported content does not establish that a job is still open.
- `remotive`: Remotive feed is delayed and may require link-back attribution; use canonical job URL for attribution.
- `searchapi_linkedin`: LinkedIn postings retrieved through the SearchAPI LinkedIn Jobs and Job Details APIs; the LinkedIn job URL is stored for attribution. No LinkedIn session cookie is used.
- `smartrecruiters`: SmartRecruiters' documented public Posting API (no API key). One list page plus one detail request per listed posting, sequential with a 1-second pause, bounded by items_per_run. Source job URL links to the employer's SmartRecruiters posting.
- `we_work_remotely`: Use the canonical posting URL from We Work Remotely; link back where possible.
- `workable`: Unauthenticated public careers-widget endpoint that backs the employer's own Workable careers page (apply.workable.com/{account}); one request per board per run. Source job URL links to the employer's Workable posting.
