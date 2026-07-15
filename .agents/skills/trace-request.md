# Skill: Trace Request Flow

This skill covers the end-to-end request lifecycle within the Job Decision Engine. Use this guide to trace how user inputs turn into weighted multi-stage decision analyses.

### Request Flow Path:
1. **Frontend Trigger**: User enters a query, pastes a job description, or clicks a preloaded job in `/src/App.tsx`.
2. **Express API Ingestion**: The request hits `/server.ts` at `POST /api/ask` with a JSON payload: `{ question: "..." }`.
3. **Loud Fail & API Checks**: `server.ts` verifies if `process.env.GEMINI_API_KEY` is available. If missing, it immediately throws a loud error back to the client.
4. **Agent Invocation**: The request is passed to `runAgent(question)` in `/src/services/agent.ts`.
5. **Multi-Stage Evaluation Loop**:
   - `runAgent` sets up the `@google/genai` client using `getGeminiClient()`.
   - The system instructions define **Stage 1 (Absolute Disqualifiers)**, **Stage 2 (Dual-Track Routing)**, and **Stage 3 (Scoring Axes)**.
   - If the model decides it needs database info or market benchmarking, it triggers `queryDatabaseForJobs` or `fetchExternalMarketRates`.
   - The engine runs those functions, appends their outputs to the chat history, and loops.
6. **Result Formatting & Persistence**:
   - Enforces a typed JSON response matching the `AgentResult` schema.
   - Logs the question, tools used, results, and exact tool-calling steps in `/src/db/db.ts` under the persistent JSON mock Postgres storage.
   - Returns the result, trace, and tool history to `server.ts` and back to the React UI for visualization.
