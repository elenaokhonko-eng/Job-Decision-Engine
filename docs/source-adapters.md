# Source Adapters

All adapters extend `BaseSourceAdapter`, validate mapped records with `ExtractedJobSchema`, and feed `SourceBroker`. Adapters never write canonical tables.

## Configured Sources

`config/sources.yml` controls enablement, endpoints, polling intervals, query/lane filters, attribution, per-run limits, timeout, and retry policy.

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
4. Add the source to `config/sources.yml`.
5. Wire it into `scripts/run_adapters.ts`.
6. Add success, malformed, timeout, rate-limit, and empty-result tests.
