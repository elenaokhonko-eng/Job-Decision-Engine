# 0001. Modular monolith with enforced boundaries

- Status: Accepted (merging the pull request that adds this record is the owner's acceptance).
- Date: 2026-11-19

## Context

The engine works as a pipeline, but its parts are not separated. The figures below are from the review of 19 November 2026 ([architecture-review-2026-11-19.md](../architecture-review-2026-11-19.md)).

- `src/services/agent.ts` (3,365 lines when reviewed) mixes model configuration, provider calls, cost accounting, prompts, parsing, embeddings and a legacy evaluator that writes model output to rows of the legacy `jobs` table.
- `src/tasks/stageTaskWorker.ts` (4,012 lines when reviewed) holds the task queue and the logic that links every pipeline stage.
- Eleven pairs of code areas import each other, and two files form an import cycle.
- A job's outcome column is updated from 6 files and its processing state from 14. A rejected job could keep an older recommendation because no single place owned the value.
- 88 scripts and 6 API files open their own database connection and carry their own SQL.
- `docs/architecture.md` named four lanes when the code had eight, and its state diagram left out matching and decision.

Nothing in the build stopped any of this. Review alone did not hold the structure, because several coding agents work on the repository in parallel and each sees only its own change.

## Decision

Keep one TypeScript program and one PostgreSQL database, and divide the code into three layers with rules a test enforces.

1. **Layers.** Interfaces call domain modules, modules call the platform, and everything may use contracts. Imports point downward only.
2. **Ten domain modules in a fixed order:** sourcing, catalog, requirements, profile, policy, matching, decision, evaluation, documents, applications. A module imports only earlier modules, and only through their public file.
3. **Seven platform parts:** config, observability, security, persistence, llm, prompts, orchestration. They hold no job rules and never import a module.
4. **One owner per table,** recorded in `src/architecture/table-ownership.json`. Only the owner's repository writes a table.
5. **Pure rules.** Code in a module's `domain/` folder reads no database, clock or environment.
6. **A model gateway that cannot reach the database.** Model output is stored as advice and never changes a decision.
7. **Enforcement by test.** `src/tests/architecture/boundaries.test.ts` applies rules B1 to B8 to the new layout with no exceptions, and rules F1 to F11 to the existing code against a recorded baseline that may only shrink.
8. **Migration in place.** Code moves to the new layout in small pull requests merged to `main`. There is no rewrite and no long-lived branch.

The rules, the layout and the migration order are in [`docs/architecture.md`](../architecture.md).

## Consequences

Easier:

- A change to one stage touches one module, and its rules can be tested without a database.
- A fact has one writer, so a wrong value has one place to look.
- A new violation is caught by CI on the pull request that adds it, whoever wrote it.
- The architecture document cannot drift from the code without failing a test.

Harder:

- A new command can no longer open a database connection. It needs a module function, which is more work for a one-off script.
- A pull request that fixes a recorded violation must also prune the baseline.
- A migration that creates a table must name its owner.
- Moving a file into the new layout means meeting every rule at once, so code moves together with its SQL.

Cost: the restructuring is a long series of small pull requests across eight phases. It competes with feature work, so it follows the work that gets jobs flowing and starts with the changes that do not touch files in open pull requests.

## Alternatives considered

- **Leave the structure and rely on review.** This is what produced the present state.
- **Separate services** for ingestion, evaluation and documents. A single-owner tool gains nothing from independent deployment, and it would lose transactions that today are atomic.
- **A rewrite.** The gates, the task queue, the evidence trail and 113 migrations of data are sound and in use. A rewrite would put them at risk for no gain a move does not give.
- **A lint tool such as dependency-cruiser or ESLint boundaries.** A dependency-cruiser check ran in CI for a few days with five import rules. It checks imports well, but not table ownership, status-column writers or the Streamlit files, and it kept a second baseline. Its rules are kept here as F1 and F9 to F11, and the tool was removed so that there is one check and one baseline. A lint tool can be added later for editor feedback.
- **A separate graph database** for requirements, concepts and profile facts. At this size PostgreSQL handles the joins, and a second database would split transactions and double the operations work.
