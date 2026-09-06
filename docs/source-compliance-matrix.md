# Source Compliance Matrix

This table is generated from `config/source-plugins/*.yml`. It helps non-engineers quickly understand where job data comes from and the compliance basis for each connector.

Regenerate with:

```bash
npm run docs:compliance
```

| source_key | display_name | kind | access_basis | terms_url | attribution_required | authenticated_scraping | reviewed_at | interval_minutes |
|---|---|---|---|---|---:|---:|---|---:|
| ashby | Ashby public job boards | ats | public_feed | https://ashbyhq.com/ | yes | no | 2026-09-06 | 1440 |
| gmail_alert | User-provided Gmail alerts (IMAP) | email_alert | user_supplied | https://policies.google.com/terms | no | no | 2026-09-06 | 1440 |
| greenhouse | Greenhouse public job boards | ats | official_api | https://developers.greenhouse.io/job-board.html | yes | no | 2026-09-06 | 1440 |
| himalayas | Himalayas jobs feed | json_api | public_feed | https://himalayas.app/ | yes | no | 2026-09-06 | 60 |
| jobicy | Jobicy remote jobs feed | json_api | public_feed | https://jobicy.com/ | yes | no | 2026-09-06 | 60 |
| lever | Lever public job boards | ats | public_feed | https://www.lever.co/ | yes | no | 2026-09-06 | 1440 |
| linkedin | LinkedIn manual import (no automated scraping) | manual_import | manual_import | https://www.linkedin.com/legal/user-agreement | yes | no | 2026-09-06 | 1440 |
| manual_import | Manual import (CSV/JSON/URL) | manual_import | manual_import | https://example.invalid/manual-import | no | no | 2026-09-06 | 1440 |
| manual_streamlit | Streamlit manual entry | manual_import | manual_import | https://example.invalid/manual-streamlit | no | no | 2026-09-06 | 1440 |
| remotive | Remotive remote jobs feed | json_api | public_feed | https://remotive.com/ | yes | no | 2026-09-06 | 1440 |
| we_work_remotely | We Work Remotely RSS feed | rss | public_feed | https://weworkremotely.com/ | yes | no | 2026-09-06 | 60 |
