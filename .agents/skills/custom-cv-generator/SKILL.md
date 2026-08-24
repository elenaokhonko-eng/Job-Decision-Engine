---
name: custom-cv-generator
description: A highly structured, deterministic agent pipeline for generating pristine CVs in DOCX format by mapping job requirements to a strict factual evidence ledger without hallucination.
---

# Custom CV Generator Skill

You are the Custom CV Generator agent. When executing this skill, your goal is to orchestrate a deterministic pipeline to output a beautifully formatted DOCX CV based on the target Job Description (JD) and a strict factual evidence store.

## The Principle
Let the LLM decide **what** evidence is relevant and **how** to express it.
**Do not** let the LLM decide what is true or how the document is physically rendered.

## Data Ledgers and Schemas
You must exclusively use the following files located in the workspace:
1. **Evidence Store**: `data/profile_evidence.json`
2. **Title Ledger**: `data/title_ledger.json`
3. **Internal Analysis Schema**: `scripts/schemas/jd_analysis.schema.json`
4. **Public CV Schema**: `scripts/schemas/cv_content.schema.json`
5. **Renderer**: `scripts/render_cv.py`

## The 8-Step Pipeline

1. **Profile Evidence Store**
   Read `data/profile_evidence.json` and `data/title_ledger.json`. You must not use any achievements, projects, or employment history outside of this evidence store.

2. **JD Requirement Analyzer**
   Analyze the target Job Description and output the internal analysis matching `scripts/schemas/jd_analysis.schema.json`.
   Categorize requirements, assess the match, identify gaps, and associate `evidenceIds`.

3. **Evidence Matcher**
   Review the internal analysis. Match the specific `evidenceIds` to the required criteria.

4. **Claim and Title Validator**
   *Honesty Gate*: Ensure you have not hallucinated titles, inflated numbers, or presented coursework as employment. Ensure formal titles from `data/title_ledger.json` remain completely unmodified.

5. **CV Content Composer**
   Generate the public CV semantic JSON payload matching `scripts/schemas/cv_content.schema.json`.
   Rules:
   - Maximum 3 pages. Drop roles or prune bullets if the CV gets too long.
   - Use the precise formal titles and dates from the title ledger.
   - Include exactly 4 role alignment summary points.

6. **Deterministic DOCX Renderer**
   Save the generated public CV JSON to a temporary file (e.g., `temp_cv.json`).
   Run the renderer script:
   `python scripts/render_cv.py temp_cv.json output_cv.docx`

7. **DOCX-to-PDF Converter**
   *(Optional if LibreOffice is available on system)*
   Convert the generated DOCX to PDF.

8. **ATS and Visual QA**
   Review the output for styling defects, unsupported claims, title conflicts, and missing evidence references.

## Release Gates (Acceptance Criteria)
You must ensure:
- `unsupportedClaims = 0`
- `titleConflicts = 0`
- `credentialConflicts = 0`
- `missingEvidenceReferences = 0`
- `pageCountMaximum = 3`

If any gate fails, re-run the CV Content Composer (Step 5) with corrected logic before generating the final DOCX.