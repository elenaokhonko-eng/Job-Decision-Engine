import json
import os
import sys

# Add current dir to path to import streamlit_app functions if possible, or just copy the function
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from streamlit_app import python_generate_content

def main():
    # Load required data
    with open("data/title_ledger.json", "r", encoding="utf-8-sig") as f:
        title_ledger = f.read()
    with open("my_profile.md", "r", encoding="utf-8") as f:
        profile_evidence = f.read()
    with open("scripts/schemas/cv_content.schema.json", "r", encoding="utf-8-sig") as f:
        cv_content_schema = f.read()
        
    # Dummy target job
    selected_job = {
        "title": "Software Engineer, Content Safety Team",
        "company": "Google DeepMind",
        "location": "Singapore"
    }
    
    # Dummy analysis JSON to feed into the prompt
    json_text = json.dumps({
        "requirements": [],
        "matches": []
    })

    cv_content_prompt = f"""You are the Custom CV Generator Agent.
Your task is to take the Stage 1 Analysis and the immutable Data Ledgers, and generate the final Tailored CV content.

### TARGET JOB SPECIFICATION:
- **Title**: {selected_job.get('title', '')}
- **Company**: {selected_job.get('company', '')}
- **Location**: {selected_job.get('location', 'Singapore')}

### THE PRINCIPLE:
Let the LLM decide WHAT evidence is relevant and HOW to express it. Do NOT decide WHAT is true.

### STRICT RULES:
1. **NO TRUNCATION (CRITICAL)**: You MUST process and include EVERY single role listed in the Title Ledger. Do NOT stop early. Do NOT drop any roles to save space. You will not be penalized for length.
2. **HONESTY GATE (CRITICAL)**: You MUST NOT invent achievements, projects, or employment history outside of the Profile Evidence Store.
3. **TITLE LEDGER (CRITICAL)**: You MUST use the exact `formalTitle` and `company` names from the Title Ledger. Do not hallucinate or adjust titles.
4. **ROLE ALIGNMENT**: Provide exactly 4 role alignment summary points tailored specifically to the TARGET JOB.
5. **SKILLS MATCH**: Select exactly 6 to 8 Technical & Domain Skills relevant to the TARGET JOB.
6. **EDUCATION & CERTS**: Extract 2 to 4 Education items and up to 4 relevant Certifications.
7. **EXPERIENCE DEPTH & BULLET DENSITY (CRITICAL)**: You MUST include at least 10 years of chronological work experience. 
- For all recent primary roles (from Present down through 'AIA Singapore / AIA Investment Management'), you MUST provide up to 3 key achievements per role by extracting them from the profile evidence. If a role has fewer than 3 achievements in the evidence, output exactly what is there; DO NOT hallucinate extra achievements to reach 3. Do NOT compress multiple distinct achievements into 1 sentence.
- For all remaining older jobs (prior to AIAIM), provide exactly 1 key relevant achievement that highlights transferable skills for the target role.

### TITLE LEDGER:
{title_ledger}

### PROFILE EVIDENCE:
{profile_evidence}

### STAGE 1 ANALYSIS:
{json_text}
"""
    
    print("Sending request to LLM...")
    json_text_2 = python_generate_content(
        cv_content_prompt,
        system_instruction="You generate customized CV content strictly conforming to the requested JSON schema. Do not hallucinate titles or evidence.",
        response_mime_type="application/json",
        response_schema=json.loads(cv_content_schema)
    )
    
    print("Received response. Length:", len(json_text_2))
    with open("scratch/temp_test_cv.json", "w", encoding="utf-8") as f:
        f.write(json_text_2)
    print("Saved to scratch/temp_test_cv.json")

if __name__ == "__main__":
    main()
