import dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as path from 'path';
import { importProfileFromFiles } from '../src/profile/importer.js';
import { EvidenceSourceInputSchema } from '../src/profile/evidenceValidator.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const PROFILE_DIR = process.env.PROFILE_DIR || 'private/profile';
const EVIDENCE_FILE = process.env.EVIDENCE_SOURCES_FILE || path.join(PROFILE_DIR, 'evidence_sources.json');

async function loadEvidenceSources() {
  const raw = await fs.readFile(EVIDENCE_FILE, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected evidence sources array in ${EVIDENCE_FILE}`);
  }

  return parsed.map((item, idx) => {
    try {
      return EvidenceSourceInputSchema.parse(item);
    } catch (error) {
      throw new Error(`Invalid evidence source at index ${idx}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function main() {
  const evidenceSources = await loadEvidenceSources();
  const summary = await importProfileFromFiles(evidenceSources);

  console.log('Profile import completed.');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error('Profile import failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
