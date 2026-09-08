import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('process backlog workflow', () => {
  it('drains saved backlog without running source ingestion', () => {
    const workflow = readFileSync(resolve('.github/workflows/process_backlog.yml'), 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('- Job Discovery Ingestion');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('npx tsx scripts/process_pipeline.ts');
    expect(workflow).not.toContain('scripts/ingest_gmail.ts');
    expect(workflow).not.toContain('scripts/run_adapters.ts');
    expect(workflow).not.toContain('scripts/parse_emails.ts');
  });

  it('runs hard gates before quoted requirements and embedding work', () => {
    const script = readFileSync(resolve('scripts/process_pipeline.ts'), 'utf8');

    const normalization = script.indexOf('[1/8] Normalization');
    const hardGates = script.indexOf('[2/8] Hard Gates');
    const requirements = script.indexOf('[3/8] Requirements Extraction');
    const embeddings = script.indexOf('[4/8] Embedding Publication');

    expect(normalization).toBeGreaterThanOrEqual(0);
    expect(hardGates).toBeGreaterThan(normalization);
    expect(requirements).toBeGreaterThan(hardGates);
    expect(embeddings).toBeGreaterThan(requirements);
  });
});
