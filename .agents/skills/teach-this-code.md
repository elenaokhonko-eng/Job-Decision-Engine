# Skill: Teach This Codebase

This skill outlines the educational pillars of the Job Decision Engine to explain its structure and mental model to users or junior engineers.

### Core Architectural Concepts:
1. **The Core Agent loop (How Tool Calling Works)**:
   - Traditional AI Prompts operate in a single "Prompt -> Output" pass. The LLM has no capability to retrieve external context or lookup facts on the fly.
   - An AI Agent uses **Tool Calling**:
     1. The LLM receives the user's question and a set of **function definitions** (tools).
     2. The LLM evaluates the prompt and returns a request to *run a tool* (e.g., lookup jobs matching 'Bioinformatics' in the database).
     3. Our server captures this request, executes the code in `/src/db/db.ts`, and feeds the real data back to the LLM.
     4. The LLM evaluates the new context and either asks for more tools or outputs the final structured results.
2. **Multi-Stage Decision Engine**:
   - Rather than asking the LLM "is this a good job?", we enforce a strict 3-stage evaluation hierarchy:
     - **Stage 1 (Absolute Disqualifiers)**: Instant hard reject on high travel, pure non-coding roles, and attendance requirements. This saves processing budget.
     - **Stage 2 (Dual-Track Routing)**: Categorizes opportunities into FinTech Capital (Track A) or Pharma Research (Track B).
     - **Stage 3 (Weighted Points)**: Generates detailed numerical scores across 5 core dimensions, feeding back logical rationales.
3. **Clean Separation of Concerns**:
   - `/src/db/db.ts`: Simulates the persistent Postgres storage.
   - `/src/services/agent.ts`: Encapsulates the agent decision loop and tool definitions.
   - `/server.ts`: Powers the full-stack Express router and manages developer Vite bundles.
   - `/src/App.tsx`: Builds the elegant, high-contrast reactive dashboard displaying live analysis.
