# Migration numbering

Migration files are applied in lexical filename order. Use a unique three-digit numeric prefix and choose a number greater than the highest numeric prefix already recorded in the target database's `schema_migrations` table. Do not backfill gaps or reuse an existing prefix; CI checks pending migration numbers against the target-branch baseline ledger.

Version `077` is reserved and must remain unused. The missing number is intentional; later migration numbers are not renumbered to fill gaps.

Versions `115`, `116` and `117` were reserved for work that shipped under later numbers (`118` to `120`). They are intentionally unused and must not be backfilled. `109` is also absent on `main`. A pending migration must use a number above the highest one in the target database's ledger.
