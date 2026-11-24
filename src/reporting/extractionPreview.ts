import { extractDeterministicRequirementsFromPosting } from '../requirements/cleanedInputExtraction.js';
import { parsePosting } from '../requirements/postingStructure.js';

/**
 * Aggregate view of what the requirement extractor produces for a set of postings.
 * Counts only: it never carries posting text, so it is safe to print or paste.
 */

export interface PreviewJob {
  jobId: string;
  descriptionText: string;
}

export interface ExtractionPreview {
  jobs: number;
  withRequirementsSection: number;
  withResponsibilitiesSection: number;
  needsDescription: number;
  /** Confirmed capability requirements per job, as a histogram keyed by count (0..9, "10+"). */
  confirmedHistogram: Record<string, number>;
  medianConfirmed: number | null;
  itemClassCounts: Record<string, number>;
  /** Postings where parsing found items but no recognised requirements heading. */
  itemsWithoutRequirementsHeading: number;
}

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function previewExtraction(jobs: readonly PreviewJob[]): ExtractionPreview {
  const histogram: Record<string, number> = {};
  const classCounts: Record<string, number> = {};
  const confirmedCounts: number[] = [];
  let withRequirementsSection = 0;
  let withResponsibilitiesSection = 0;
  let needsDescription = 0;
  let itemsWithoutRequirementsHeading = 0;

  for (const job of jobs) {
    const result = extractDeterministicRequirementsFromPosting({
      canonical_job_id: ZERO_UUID,
      job_version_id: ZERO_UUID,
      description_text: job.descriptionText,
    });
    const posting = parsePosting(job.descriptionText);
    if (result.hasRequirementsSection) withRequirementsSection += 1;
    if (posting.hasResponsibilitiesSection) withResponsibilitiesSection += 1;
    if (result.needsDescription) needsDescription += 1;
    if (posting.items.length > 0 && !posting.hasRequirementsSection) itemsWithoutRequirementsHeading += 1;

    confirmedCounts.push(result.confirmedRequirementCount);
    const bucket = result.confirmedRequirementCount >= 10 ? '10+' : String(result.confirmedRequirementCount);
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    for (const requirement of result.requirements) {
      const itemClass = (requirement.structured_value as { item_class?: string } | null | undefined)?.item_class;
      if (itemClass) classCounts[itemClass] = (classCounts[itemClass] ?? 0) + 1;
    }
  }

  return {
    jobs: jobs.length,
    withRequirementsSection,
    withResponsibilitiesSection,
    needsDescription,
    confirmedHistogram: histogram,
    medianConfirmed: median(confirmedCounts),
    itemClassCounts: classCounts,
    itemsWithoutRequirementsHeading,
  };
}

/**
 * Short lines that look like headings but are not recognised, with how many postings
 * carry them. Headings are generic words ("Key Skills"), not job content, so counts are
 * safe to show; lines seen in fewer than `minPostings` postings are dropped.
 */
export function unrecognisedHeadingCandidates(
  jobs: readonly PreviewJob[],
  minPostings = 4,
): Array<{ line: string; postings: number }> {
  const seen = new Map<string, Set<string>>();
  for (const job of jobs) {
    for (const rawLine of job.descriptionText.split('\n')) {
      const line = rawLine.trim();
      if (line.length < 4 || line.length > 45) continue;
      if (!/[:]$/.test(line) && !/^[A-Z][A-Za-z &/']+$/.test(line)) continue;
      if (/[.!?,]$/.test(line)) continue;
      const key = line.replace(/[:\s]+$/, '').toLowerCase();
      const ids = seen.get(key) ?? new Set<string>();
      ids.add(job.jobId);
      seen.set(key, ids);
    }
  }
  const recognised = (line: string): boolean => {
    const probe = parsePosting(`${line}\n- placeholder item for heading probe`);
    return probe.items.some((item) => item.section !== 'UNSECTIONED') || probe.hasRequirementsSection;
  };
  return [...seen.entries()]
    .filter(([, ids]) => ids.size >= minPostings)
    .filter(([line]) => !recognised(line))
    .map(([line, ids]) => ({ line, postings: ids.size }))
    .sort((a, b) => b.postings - a.postings)
    .slice(0, 25);
}
