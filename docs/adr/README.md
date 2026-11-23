# Decision records

A decision record explains one structural decision: what was decided, why, and what it costs. It is short and it is never rewritten. A later decision that changes an earlier one gets its own record and marks the old one as superseded.

## When one is needed

Write a record before a pull request that does any of these:

- adds, removes, renames or reorders a module or a platform part;
- changes a boundary rule in `src/architecture/boundaries.ts`;
- moves a table to another owner in `src/architecture/table-ownership.json`;
- adds a database, a service, a queue or a model provider;
- lets a model output change stored state.

A record is not needed for moving code into the layout that [`docs/architecture.md`](../architecture.md) already describes. An exception added to `src/architecture/boundary-baseline.json` does not need a record either; it needs its reason at the top of the pull request description.

## How to write one

1. Copy the template below to `docs/adr/NNNN-short-title.md`, using the next free number.
2. Set the status to `Proposed`.
3. Open a pull request. The owner accepts a record by merging it; the status becomes `Accepted` in the same pull request.
4. Update `docs/architecture.md` in the pull request that carries out the decision.

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

What problem forces a decision. Facts and measurements, with file paths.

## Decision

What will be done, in one or two paragraphs.

## Consequences

What becomes easier, what becomes harder, what it costs.

## Alternatives considered

Each alternative and why it was not chosen.
```

## Records

| No. | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-with-enforced-boundaries.md) | Modular monolith with enforced boundaries | Accepted |
