/**
 * Default Gemini model for evaluation. One place to change when Google retires a model: every code
 * default (registry, preflight, scripts) reads it. Deployments override it without a code change
 * through the EVALUATION_PRIMARY_MODEL (or GEMINI_MODEL) environment variable or repo variable.
 *
 * gemini-3.6-flash and gemini-3.7-flash retire on 2027-01-28 (Gemini Enterprise / Vertex notice).
 */
export const DEFAULT_GEMINI_EVALUATION_MODEL = "gemini-4-hydrogen";
