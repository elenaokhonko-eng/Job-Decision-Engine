---
description: "Required TypeScript conventions for CrewPilot engine and extension source"
applyTo: '**/*.ts, **/*.tsx'
---

# TypeScript

CrewPilot ships strict TypeScript across `crewpilot-engine/src/**` and `extensions/crewpilot-vsix/src/**`. These rules align with the project's `tsconfig.json` and ESLint config.

## Strictness

* `tsconfig` runs with `strict: true`. Do not relax compiler flags per file.
* Never use `any`. When a type is genuinely unknown, use `unknown` and narrow before use.
* Avoid `as` casts except at boundaries (JSON parse, external SDK responses). Document each cast with a one-line comment stating why.
* Do not suppress errors with `@ts-ignore`. Use `@ts-expect-error` with a reason when truly necessary.

## Modules and imports

* ESM only. Use `import` / `export`. No `require`.
* Use the `.js` extension on relative imports inside the engine package (the project compiles to ESM and Node requires explicit extensions).
* Group imports in three blocks separated by a blank line: Node built-ins, third-party packages, local relative imports.
* Prefer named exports. Reserve default exports for entry points (`cli.ts`, `index.ts`).

## Types and interfaces

* Use `interface` for object shapes that may be extended; `type` for unions, intersections, and aliases.
* Public APIs declare return types explicitly. Inferred return types are acceptable only for trivial private helpers.
* Use `readonly` for arrays and properties that should not mutate after construction.
* Prefer discriminated unions (`type Result = { ok: true; value: T } | { ok: false; error: E }`) over throwing for expected failure paths.

## Error handling

* Throw `Error` subclasses with a descriptive message. Do not throw strings or plain objects.
* Catch the narrowest type possible. Use `instanceof` to narrow before reading properties.
* For tool handlers in `crewpilot-engine/src/tools/**`, return structured `{ success: false, error }` objects rather than throwing across the MCP boundary.
* Never swallow errors silently. Log via the `logger` service or rethrow.

## Async and promises

* Always `await` promises or explicitly chain `.then`. Never leave a floating promise.
* Wrap fire-and-forget background work with `void` and a top-level `.catch` that logs.
* Prefer `Promise.all` for independent parallel work. Use `Promise.allSettled` when partial failure is acceptable.

## Naming

* `camelCase` for variables, functions, and methods.
* `PascalCase` for types, interfaces, classes, and enums.
* `SCREAMING_SNAKE_CASE` for module-level constants that are truly invariant.
* MCP tool names use `crewpilot_<module>_<action>` snake_case (this is a public-API convention, not a TypeScript rule).

## Patterns to avoid

* `any`, including `Record<string, any>`. Use `unknown` or a named interface.
* Mutating function arguments. Treat parameters as immutable.
* `enum` with string values. Use literal union types (`type Mode = 'sync' | 'async'`).
* `null` for absent values. Prefer `undefined`. Reserve `null` for JSON interop or external APIs that require it.
* Classes with only static members. Use a module with named exports.
* Deeply nested ternaries. Extract to a function or use early returns.

## Testing

* Tests live in `crewpilot-engine/tests/` and use the project's existing test harness.
* One `describe` block per unit under test.
* Test names read as a sentence: `it('returns null when board id is missing')`.
* Mock external services via the same interfaces the production code consumes.

> Brought to you by CrewPilot.
