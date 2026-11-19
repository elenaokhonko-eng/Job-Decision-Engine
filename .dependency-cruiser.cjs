/**
 * Import-boundary rules (Phase 0 of the architecture plan).
 *
 * Today's violations are recorded in .dependency-cruiser-known-violations.json; CI fails on any NEW
 * violation (`npm run lint:boundaries`). Fix a violation, then regenerate the baseline with
 * `npm run lint:boundaries:baseline` so it can only shrink. Never add a violation to the baseline to
 * get a build green.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "A module cycle (for example services/agent.ts <-> services/llmFallback.ts) makes the parts impossible to test or move alone.",
      from: {},
      to: { circular: true },
    },
    {
      // R1: imports point downward. Contracts (zod schemas) and the database layer are the bottom of
      // the stack; they must not import the stages, services, tasks, API or UI that sit above them.
      name: "bottom-layers-import-nothing-above",
      severity: "error",
      comment: "src/contracts and src/db are depended on by everything; they must not import upward.",
      from: { path: "^src/(contracts|db)/", pathNot: "^src/tests/" },
      to: { path: "^src/(pipeline|tasks|services|api|readModels|desktop|ingestion|documents|reporting|mcp|sdk|matching|decision|eligibility|evidence|lanes|policy|profile|requirements|embeddings)/" },
    },
    {
      // R1: the pipeline stages must not reach up into the task queue, the API or the desktop shell.
      name: "pipeline-not-above",
      severity: "error",
      comment: "src/pipeline must not import the task worker, the HTTP API, read models or the desktop shell.",
      from: { path: "^src/pipeline/", pathNot: "^src/tests/" },
      to: { path: "^src/(tasks|api|readModels|desktop)/" },
    },
    {
      // R5: the model-call layer knows nothing about jobs or the database.
      name: "model-call-layer-knows-no-jobs",
      severity: "error",
      comment: "modelCallResilience.ts must stay free of Postgres, workspace and pipeline code so it can be reused and tested alone.",
      from: { path: "^src/services/modelCallResilience\.ts$" },
      to: { path: "^src/(db|workspace|pipeline|tasks|readModels|api)/|^pg$|^node_modules/pg/" },
    },
    {
      name: "src-does-not-import-scripts",
      severity: "error",
      comment: "Application code must not depend on one-off scripts. (Tests may.)",
      from: { path: "^src/", pathNot: "^src/tests/" },
      to: { path: "^scripts/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    exclude: { path: "(^|/)(dist|dist-backend|node_modules)(/|$)|\.d\.ts$" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
    skipAnalysisNotInRules: true,
  },
};
