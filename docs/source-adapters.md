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
