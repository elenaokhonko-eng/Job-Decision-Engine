# Skill: Code Quality Review

This skill defines the technical standard and quality indicators of the Job Decision Engine project.

### Structural Requirements:
1. **Module System**: The project is a Node.js ES Module project (`"type": "module"` in `/package.json`).
2. **Type Imports**: All imports must reside at the top of the files. Named imports must be used.
3. **No Unrequested SDKs**: All external calls to Gemini are routed strictly through `/src/services/agent.ts` using `@google/genai` (version `^2.4.0` in `/package.json`). Client-side code is forbidden from calling Gemini directly.
4. **Vite + Express Integration**:
   - Dev mode relies on `tsx server.ts` to spin up both the API endpoints and Vite dev middleware (on port 3000).
   - Production bundles the static frontend assets via `vite build`, and packages the backend server into `/dist/server.cjs` using `esbuild` to guarantee seamless Node runtime compatibility.
5. **Robust Database Hygiene**:
   - `/src/db/db.ts` mimics a standard Postgres client.
   - It performs atomic synchronous and asynchronous file-based checks to guard against concurrent writing corruption.
   - Interactions and evaluation histories are fully logged with timestamped trace coordinates.
