import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";
import { db, Job } from "../db/db.ts";
import { fetchGmailAlerts } from "./gmail.js";
import { extractWithFallback } from "./llmFallback.js";
import {
  CANDIDATE_PROFILE,
  MULTI_LANE_SCORECARDS,
  ND_FRIENDLY_DIMENSIONS,
  POLITICS_STRESS_RISK_DIMENSIONS
} from "./criteria.ts";

// Helper function to lazily initialize the Gemini SDK and throw "loud-fail" error if API key is missing
let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
      throw new Error(
        "CRITICAL API KEY CONFLICT: GEMINI_API_KEY is not configured for Gemini 2.0 Flash."
      );
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
        timeout: 45000,
      },
    });
  }
  return aiClient;
}

// Defining our tools as FunctionDeclarations
const queryDatabaseForJobsTool: FunctionDeclaration = {
  name: "queryDatabaseForJobs",
  description: "Search or fetch job advertisements from the local Postgres simulation database.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      searchTerm: {
        type: Type.STRING,
        description: "Optional search query to filter jobs by title, company, or description keywords.",
      },
    },
  },
};
// Tool implementations
async function executeQueryDatabaseForJobs(args: { searchTerm?: string }): Promise<Job[]> {
  return await db.queryJobs(args.searchTerm);
}



export interface AgentResult {
  evaluation_summary?: string;
  evaluated_jobs: Array<{
    job_id?: string;
    job_title: string;
    company: string;
    careers_portal_url: string;
    primary_lane: "CORE_AI_DATA" | "LEGAL_REGTECH" | "HEALTH_BIO_PHARMA" | "INVESTMENT_MARKETS_FINTECH" | null;
    secondary_lanes: string[];
    lane_confidence: "High" | "Medium" | "Low";
    lane_evidence: string;
    nd_gate_status: string;
    nd_score: number;
    nd_evidence: string;
    nd_risk_flags: string[];
    work_mode_status: string;
    office_days: number;
    interaction_load: number;
    building_research_ratio: number;
    rejection_codes: string[];
    nd_friendly_score: number;
    politics_stress_score: number;
    sensory_overload_index: number;
    biological_and_stress_risk_assessment: string;
    strategic_value: string;
    recommended_cv_version: string;
    next_action: string;
  }>;
}

async function tryGemini(geminiKey: string, options: any): Promise<string> {
  const ai = getGeminiClient();
  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: options.model || process.env.GEMINI_MODEL || "gemini-1.5-flash",
        contents: options.contents,
        config: {
          responseMimeType: options.responseMimeType as any,
          responseSchema: options.responseSchema,
          systemInstruction: options.systemInstruction
        }
      });
      return response.text || "";
    } catch (gErr: any) {
      const isDailyQuota = gErr.message?.includes("GenerateRequestsPerDay") || gErr.message?.includes("free_tier_requests") || gErr.message?.includes("quota");
      const isRateLimit = gErr.message?.includes("RESOURCE_EXHAUSTED") || gErr.status === 429;
      const isTimeout = gErr.name === "AbortError" || gErr.message?.includes("timeout") || gErr.message?.includes("aborted");
      
      // If we hit any rate limit (429) or quota limit, immediately throw to trigger OpenAI fallback
      // since Gemini free tier quotas are easily exhausted.
      if (isDailyQuota || isRateLimit) {
        throw gErr;
      }
      
      if (isTimeout && attempt < maxRetries) {
        console.warn(`⏳ Gemini request failed (Timeout). Attempt ${attempt}/${maxRetries}. Retrying in 5s...`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } else {
        throw gErr;
      }
    }
  }
  return "";
}

async function tryOpenAICompatible(apiKey: string, baseUrl: string, model: string, options: any, isKimi: boolean = false): Promise<string> {
  const messages: any[] = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }
  messages.push({ role: "user", content: options.contents });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "User-Agent": "Claude-Code"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 1,
          response_format: options.responseSchema && !isKimi
            ? { type: "json_schema", json_schema: { name: "extraction", strict: true, schema: options.responseSchema } }
            : (options.responseMimeType === "application/json" ? { type: "json_object" } : undefined)
        }),
        signal: AbortSignal.timeout(300000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed with status ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    } catch (err: any) {
      if (attempt === 2) throw err;
      console.warn(`⏳ API request failed (${baseUrl}). Retrying in 5s...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  return "";
}

async function tryOpenAI(openaiKey: string, options: any): Promise<string> {
  const baseUrl = "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  return tryOpenAICompatible(openaiKey, baseUrl, model, options, false);
}


export type Provider = "local" | "gemini" | "openai";

/**
 * Unified LLM call helper that selects provider based on workflow stage.
 */
export async function callLLM(
  stage: "extract" | "evaluate" | "cv",
  prompt: string,
  extra?: any
): Promise<string> {
  // Resolve provider for the given stage
  let provider: Provider;
  if (stage === "extract") {
    provider = "local"; // Ollama LLaMA
  } else if (stage === "evaluate") {
    provider = "gemini"; // Primary, fallback handled internally
  } else {
    provider = "openai"; // CV customization
  }

  switch (provider) {
    case "local": {
      const baseUrl = process.env.OLLAMA_API_BASE?.replace(/\/+$/, "");
      const model = process.env.OLLAMA_MODEL;
      if (!baseUrl || !model) {
        throw new Error("Ollama configuration missing in .env.local (OLLAMA_API_BASE or OLLAMA_MODEL)");
      }
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 1,
          ...(extra?.schema ? { format: extra.schema } : {}),
          ...(extra?.options ?? {})
        })
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Ollama request failed: ${response.status} ${err}`);
      }
      const data = await response.json();
      return data.choices?.[0]?.message?.content ?? "";
    }
    case "gemini": {
      const result = await runAgent(prompt);
      // Return the result object as a JSON string for consistency
      return JSON.stringify(result.result);
    }
    case "openai": {
      const openaiKey = process.env.OPENAI_API_KEY || "";
      return await tryOpenAI(openaiKey, {
        contents: prompt,
        model: process.env.OPENAI_MODEL,
        responseMimeType: "application/json"
      });
    }
    default:
      throw new Error("Invalid provider");
  }
}


export async function generateContent(options: {
  model: string;
  contents: any;
  responseMimeType?: string;
  responseSchema?: any;
  systemInstruction?: string;
}): Promise<string> {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const forceOpenAI = process.env.FORCE_OPENAI === "true";
  const order = forceOpenAI 
    ? ["openai", "gemini"] 
    : ["gemini", "openai"];

  const tried = new Set<string>();

  for (const provider of order) {
    if (provider === "gemini" && geminiKey && !tried.has("gemini")) {
      tried.add("gemini");
      try {
        const text = await tryGemini(geminiKey, options);
        if (text) return text;
      } catch (err: any) {
        console.warn(`⚠️ Gemini request failed (${err.message || err}).`);
      }
    }

    if (provider === "openai" && openaiKey && !tried.has("openai")) {
      tried.add("openai");
      try {
        const text = await tryOpenAI(openaiKey, options);
        if (text) return text;
      } catch (err: any) {
        console.warn(`⚠️ OpenAI request failed (${err.message || err}).`);
      }
    }
  }

  throw new Error("All model API calls failed or no API keys were configured.");
}


// Core execution loop
function parseResultJson(rawText: string, trace: string[]): AgentResult {
  try {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    const startIdx = cleaned.indexOf("{");
    const endIdx = cleaned.lastIndexOf("}");
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Failed to parse agent JSON output, returning fallback", err);
    trace.push(`Step ${trace.length + 1}: Formatting parsing failed. Initiated rule-based recovery fallback.`);
    return {
      evaluation_summary: "Parsing failed, raw output returned. Rationale analysis is stored.",
      evaluated_jobs: []
    };
  }
}

async function runGeminiAgentInternal(
  userQuestion: string,
  systemInstruction: string,
  trace: string[],
  toolsUsed: string[]
): Promise<AgentResult> {
  trace.push(`Step ${trace.length + 1}: Initiated agent connection to Gemini using customizable weights criteria.`);
  
  const ai = getGeminiClient();
  let response: any;
  try {
    response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      contents: userQuestion,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [queryDatabaseForJobsTool] }],
      },
    });
  } catch (gErr: any) {
    if (gErr.message?.includes("RESOURCE_EXHAUSTED") || gErr.status === 429) {
      console.warn("⏳ Gemini rate limit reached. Waiting 60s before retrying...");
      await new Promise((resolve) => setTimeout(resolve, 60000));
      response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
        contents: userQuestion,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: [queryDatabaseForJobsTool] }],
        },
      });
    } else {
      throw gErr;
    }
  }

  let functionCalls = response.functionCalls;
  let conversationHistory: any[] = [
    { role: "user", parts: [{ text: userQuestion }] },
    { role: "model", parts: response.candidates?.[0]?.content?.parts || [] }
  ];

  let loopCount = 0;
  while (functionCalls && functionCalls.length > 0 && loopCount < 5) {
    loopCount++;
    const functionResponsesParts: any[] = [];

    for (const call of functionCalls) {
      trace.push(`Step ${trace.length + 1}: Agent triggered tool call: "${call.name}" with arguments: ${JSON.stringify(call.args)}`);
      toolsUsed.push(call.name || "");

      let resultData: any;
      if (call.name === "queryDatabaseForJobs") {
        const args = (call.args as any) || {};
        resultData = await executeQueryDatabaseForJobs(args);
        trace.push(`Step ${trace.length + 1}: Query database returned ${resultData.length} records.`);
      } else {
        resultData = { error: "Unknown tool name" };
      }

      functionResponsesParts.push({
        functionResponse: {
          name: call.name,
          response: { result: resultData }
        }
      });
    }

    conversationHistory.push({
      role: "user",
      parts: functionResponsesParts
    });

    trace.push(`Step ${trace.length + 1}: Sending tool results back to Gemini for final assessment and ranking.`);
    
    response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      contents: conversationHistory,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [queryDatabaseForJobsTool] }],
      },
    });

    functionCalls = response.functionCalls;
    if (response.candidates?.[0]?.content?.parts) {
      conversationHistory.push({
        role: "model",
        parts: response.candidates[0].content.parts
      });
    }
  }

  trace.push(`Step ${trace.length + 1}: Enforcing strict JSON formatting with builder culture metrics.`);
  const formattingPrompt = "Now, please compile all findings, evaluate each job description, and output ONLY a valid, parseable JSON object matching the requested schema. Make sure you score the workplace cultural factors (nd_friendly_score, politics_stress_score, sensory_overload_index) and ensure every job has a direct careers_portal_url link. Return nothing other than the JSON block.";
  conversationHistory.push({ role: "user", parts: [{ text: formattingPrompt }] });

  const finalResponse = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
    contents: conversationHistory,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
    }
  });

  const rawText = finalResponse.text || "{}";
  return parseResultJson(rawText, trace);
}

// Core execution loop
export async function runAgent(userQuestion: string): Promise<{ result: AgentResult; trace: string[]; toolsUsed: string[] }> {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_FLASH_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!geminiKey && !openaiKey) {
    throw new Error(
      "CRITICAL API KEY CONFLICT: Neither GEMINI_API_KEY nor OPENAI_API_KEY environment variables are configured."
    );
  }

  const trace: string[] = [];
  const toolsUsed: string[] = [];

  const systemInstruction = `You are an expert Executive Career Architect and AI Decision Engine. Your objective is to evaluate job descriptions for a highly specialized executive technologist.

### CANDIDATE CORE PROFILE:
- Name: ${CANDIDATE_PROFILE.name}
- Experience: ${CANDIDATE_PROFILE.experienceYears}+ years
- Workplace Preference: ${CANDIDATE_PROFILE.workplacePreference}
- Target Minimum Base: SGD ${CANDIDATE_PROFILE.minAcceptableBaseSgdMonth}/month

### EVALUATION WORKFLOW (3 STAGES)

#### STAGE 1: MULTI-LANE CLASSIFICATION
You must categorize the job into one PRIMARY lane and zero or more SECONDARY lanes.
Lanes:
- HEALTH_BIO_PHARMA: ${MULTI_LANE_SCORECARDS.HEALTH_BIO_PHARMA.criteria}
- LEGAL_REGTECH: ${MULTI_LANE_SCORECARDS.LEGAL_REGTECH.criteria}
- INVESTMENT_MARKETS_FINTECH: ${MULTI_LANE_SCORECARDS.INVESTMENT_MARKETS_FINTECH.criteria}
- CORE_AI_DATA: ${MULTI_LANE_SCORECARDS.CORE_AI_DATA.criteria}

Assign lane_confidence (High, Medium, Low) based on explicit evidence in the job description. Do NOT rely on exact keyword matching alone; read the semantic context. Output the verbatim quotes as lane_evidence. If no lane matches (e.g., standard SWE without data/ML), set primary_lane to null.

#### STAGE 2: INDEPENDENT RISK METRICS (0-100 each)
- nd_friendly_score (Target >= 70): Evidence of safe focus, async comms. Matches: ${ND_FRIENDLY_DIMENSIONS.highSupportiveFactors.join(", ")}
- politics_stress_score (Target < 50): Evidence of corporate alignment, fast-paced chaos, matrixed stakeholders. Matches: ${POLITICS_STRESS_RISK_DIMENSIONS.highRiskFactors.join(", ")}
- sensory_overload_index (Target < 50): Evidence of open offices, constant video, high travel.

#### STAGE 3: ACTION PLAN
- strategic_value: Summary of the present-day value of the role for the candidate.
- recommended_cv_version: "HEALTH_BIO_PHARMA", "LEGAL_REGTECH", "INVESTMENT_MARKETS_FINTECH", "CORE_AI_DATA" or "None".
- next_action: "PRIORITY_APPLY" (High confidence lane, high ND friendly, low politics), "APPLY_AFTER_VERIFICATION", "LOW_STRATEGIC_VALUE", or "REJECTED" (if primary_lane is null).

### MANDATED TYPED OUTPUT FORMAT:
You MUST return a JSON object matching this schema exactly.
{
  "evaluation_summary": "Overall synthesis",
  "evaluated_jobs": [
    {
      "job_id": "string",
      "job_title": "string",
      "company": "string",
      "careers_portal_url": "string",
      "primary_lane": "CORE_AI_DATA | LEGAL_REGTECH | HEALTH_BIO_PHARMA | INVESTMENT_MARKETS_FINTECH | null",
      "secondary_lanes": ["string"],
      "lane_confidence": "High | Medium | Low",
      "lane_evidence": "string",
      "nd_gate_status": "string",
      "nd_score": integer (0-100),
      "nd_evidence": "string",
      "nd_risk_flags": ["string"],
      "work_mode_status": "string",
      "office_days": integer,
      "interaction_load": integer,
      "building_research_ratio": integer,
      "rejection_codes": ["string"],
      "nd_friendly_score": integer (0-100),
      "politics_stress_score": integer (0-100),
      "sensory_overload_index": integer (0-100),
      "biological_and_stress_risk_assessment": "string",
      "strategic_value": "string",
      "recommended_cv_version": "string",
      "next_action": "string"
    }
  ]
}`;

  const forceOpenAI = process.env.FORCE_OPENAI === "true";
  const order = forceOpenAI 
    ? ["openai", "gemini"] 
    : ["gemini", "openai"];

  const tried = new Set<string>();
  let parsedResult: AgentResult | null = null;

  for (const provider of order) {
    // Kimi block removed
    if (provider === "openai" && openaiKey && !tried.has("openai")) {
      tried.add("openai");
      try {
        trace.push(`Step ${trace.length + 1}: Running evaluation agent with OpenAI API...`);
        const text = await tryOpenAI(openaiKey, {
          contents: userQuestion,
          responseMimeType: "application/json",
          systemInstruction
        });
        parsedResult = parseResultJson(text, trace);
        if (parsedResult) break;
      } catch (err: any) {
        console.warn(`⚠️ OpenAI agent run failed: ${err.message || err}`);
        trace.push(`Step ${trace.length + 1}: OpenAI agent run failed: ${err.message || err}`);
      }
    }
    if (provider === "gemini" && geminiKey && !tried.has("gemini")) {
      tried.add("gemini");
      try {
        trace.push(`Step ${trace.length + 1}: Running evaluation agent with Gemini API...`);
        const result = await runGeminiAgentInternal(userQuestion, systemInstruction, trace, toolsUsed);
        parsedResult = result;
        if (parsedResult) break;
      } catch (geminiErr: any) {
        console.warn(`⚠️ Gemini agent run failed: ${geminiErr.message || geminiErr}.`);
        trace.push(`Step ${trace.length + 1}: Gemini agent run failed: ${geminiErr.message || geminiErr}`);
      }
    }
  }

  if (!parsedResult) {
    throw new Error("All model API calls failed during agent execution.");
  }

  trace.push(`Step ${trace.length + 1}: Multi-stage decision engine completed successfully.`);

  // Write evaluation results BACK to the persistent database
  if (parsedResult.evaluated_jobs && parsedResult.evaluated_jobs.length > 0) {
    const dbJobs = await db.queryJobs();
    for (const job of parsedResult.evaluated_jobs) {
      // Match by job title & company if ID is not set
      let matchedJob = dbJobs.find(
        (j) => j.id === job.job_id || (j.title === job.job_title && j.company_name === job.company)
      );
      
      if (matchedJob) {
        await db.updateJobEvaluation(matchedJob.id, {
          processing_status: "EVALUATED",
          primary_lane: job.primary_lane,
          secondary_lanes: job.secondary_lanes,
          lane_confidence: job.lane_confidence,
          lane_evidence: job.lane_evidence,
          source_lane: "LLM",
          nd_gate_status: job.nd_gate_status || undefined,
          nd_score: job.nd_score || undefined,
          nd_evidence: job.nd_evidence || undefined,
          nd_risk_flags: job.nd_risk_flags || undefined,
          work_mode_status: job.work_mode_status || undefined,
          office_days: job.office_days || undefined,
          interaction_load: job.interaction_load || undefined,
          building_research_ratio: job.building_research_ratio || undefined,
          rejection_codes: job.rejection_codes || undefined,
          nd_friendly_score: job.nd_friendly_score || 50,
          politics_stress_score: job.politics_stress_score || 50,
          sensory_overload_index: job.sensory_overload_index || 50,
          biological_stress_risk: job.biological_and_stress_risk_assessment || undefined,
          strategic_value: job.strategic_value,
          recommended_cv_version: job.recommended_cv_version,
          next_action: job.next_action,
          careers_portal_url: job.careers_portal_url || matchedJob.careers_portal_url
        });
        trace.push(`Step ${trace.length + 1}: Recorded persistent ND culture metrics for ${job.company} in database.`);
      }
    }
  }

  // Log interaction to persistent simulated Postgres DB
  await db.logInteraction(userQuestion, toolsUsed, parsedResult, trace);

  return {
    result: parsedResult,
    trace,
    toolsUsed
  };
}


