# Migration numbering

Migration files are applied in lexical filename order. Use a unique three-digit numeric prefix and choose a number greater than the highest numeric prefix already recorded in the target database's `schema_migrations` table. Do not backfill gaps or reuse an existing prefix; CI checks pending migration numbers against the target-branch baseline ledger.

Version `077` is reserved and must remain unused. The missing number is intentional; later migration numbers are not renumbered to fill gaps.
