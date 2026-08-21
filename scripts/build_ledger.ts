import fs from "fs";
import { generateContent } from "../src/services/agent.js";
import path from "path";

const PROFILE_PATH = path.resolve("my_profile.md");
const OUT_PATH = path.resolve("master_profile.json");

const PROMPT = `You are a strict data extraction engine. I am providing my professional resume in Markdown.
Your job is to convert it into a "master_profile.json" which acts as an evidence ledger.

The JSON MUST follow this exact structure:
{
  "contact": {
    "full_name": "string",
    "email": "string",
    "phone": "string",
    "linkedin": "string",
    "location": "string"
  },
  "summary": "string",
  "roles": [
    {
      "role_id": "string (e.g. aiaim_2023_2025)",
      "employer": "string",
      "title": "string",
      "date_display": "string",
      "location": "string"
    }
  ],
  "facts": [
    {
      "id": "string (unique identifier for this specific fact, e.g. aiaim_derivatives_01)",
      "role_id": "string (must match a role_id in roles, or 'education' / 'general')",
      "fact_type": "achievement | responsibility | skill",
      "claim": "string (The original wording from the resume bullet point)",
      "metrics": [
        { "value": "number or string", "unit": "string", "meaning": "string" }
      ],
      "skills": ["string"],
      "domains": ["string"],
      "evidence_status": "candidate_verified",
      "public_use": true,
      "source_reference": "string (e.g. my_profile.md#aia-investment-management)"
    }
  ],
  "education": [
    {
      "id": "string",
      "institution": "string",
      "degree": "string",
      "date_display": "string",
      "details": "string"
    }
  ],
  "certifications": [
    "string"
  ],
  "keywords": [
    "string"
  ]
}

Ensure every single bullet point under "WORK EXPERIENCE" becomes a distinct item in the "facts" array.
Be absolutely exhaustive. Do not summarize or skip any achievements.
Extract ALL metrics precisely.

Here is the markdown:
`;

async function main() {
  console.log("Reading my_profile.md...");
  const mdContent = fs.readFileSync(PROFILE_PATH, "utf-8");

  console.log("Calling LLM to build evidence ledger...");
  let rawText = await generateContent({
    model: "gemini-3.6-flash",
    contents: PROMPT + mdContent,
    responseMimeType: "application/json",
    systemInstruction: "You are an expert data architect converting markdown resumes into highly structured, addressable JSON fact ledgers.",
  });

  if (rawText.startsWith("```json")) {
    rawText = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (rawText.startsWith("```")) {
    rawText = rawText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  // Verify it parses
  const parsed = JSON.parse(rawText);
  fs.writeFileSync(OUT_PATH, JSON.stringify(parsed, null, 2));
  console.log(`✅ Successfully generated master_profile.json with ${parsed.facts?.length || 0} facts!`);
}

main().catch(console.error);
