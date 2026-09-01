# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-09-01

### Added

1. Canonical migration hardening for legacy upgrade paths.
2. Strict version-pinned shortlist read model and quarantine table flow.
3. Queue retry/backoff and manual-review terminal handling.
4. Provider-aware model routing and preflight checks.

### Changed

1. Gmail ingestion now uses consistent TLS policy and non-destructive processing.
2. Evaluation/document generation paths use explicit model/provider routing.
3. CI migration tests cover legacy schema compatibility.

### Fixed

1. Migration 008 upgrade-path compatibility when historical unique constraints are missing.
2. Legacy migration test assertions aligned with migration 010 quarantine cleanup behavior.
