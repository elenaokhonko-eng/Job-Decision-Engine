import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import type { EvidenceStrengthPolicy } from '../evidence/evidenceStrengthPolicy.js';
import { computeEvidenceStrength } from '../evidence/evidenceStrengthPolicy.js';

export type IsoDate = `${number}-${number}-${number}`;

export interface DayInterval {
  startDay: number;
  endDay: number;
}

export interface WeightedDayInterval extends DayInterval {
  weight: number | null;
  sourceKey: string;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDateToDayIndex(dateStr: string): number {
  const match = ISO_DATE_RE.exec(dateStr);
  if (!match) {
    throw new Error(`Invalid ISO date: ${dateStr}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const utc = Date.UTC(year, month - 1, day);
  return Math.floor(utc / 86400000);
}

export function toInclusiveDayInterval(startDate: string, endDate: string): DayInterval {
  const startDay = parseIsoDateToDayIndex(startDate);
  const endDay = parseIsoDateToDayIndex(endDate);
  if (endDay < startDay) {
    throw new Error(`Invalid date range: ${startDate}..${endDate}`);
  }
  return { startDay, endDay };
}

export function mergeDayIntervals(intervals: DayInterval[]): DayInterval[] {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort((a, b) =>
    a.startDay === b.startDay ? a.endDay - b.endDay : a.startDay - b.startDay
  );

  const merged: DayInterval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const next = sorted[i];
    if (next.startDay <= prev.endDay + 1) {
      prev.endDay = Math.max(prev.endDay, next.endDay);
      continue;
    }
    merged.push({ ...next });
  }
  return merged;
}

export function sumMergedIntervalDays(merged: DayInterval[]): number {
  return merged.reduce((acc, interval) => acc + (interval.endDay - interval.startDay + 1), 0);
}

export interface AllocationWeightedDaysTrace {
  missingWeightSources: string[];
  segments: Array<{
    startDay: number;
    endDay: number;
    rawWeight: number;
    cappedWeight: number;
    days: number;
  }>;
}

export function computeAllocationWeightedDays(
  intervals: WeightedDayInterval[]
): { value: number | null; trace: AllocationWeightedDaysTrace } {
  const missing = intervals.filter((i) => i.weight == null).map((i) => i.sourceKey);
  if (missing.length > 0) {
    return {
      value: null,
      trace: {
        missingWeightSources: [...missing].sort(),
        segments: [],
      },
    };
  }

  const events = new Map<number, number>();
  for (const interval of intervals) {
    const w = interval.weight as number;
    events.set(interval.startDay, (events.get(interval.startDay) || 0) + w);
    events.set(interval.endDay + 1, (events.get(interval.endDay + 1) || 0) - w);
  }

  const days = Array.from(events.keys()).sort((a, b) => a - b);
  const segments: AllocationWeightedDaysTrace['segments'] = [];

  let currentWeight = 0;
  let currentDay = days[0];
  let weightedDays = 0;

  for (const day of days) {
    if (day > currentDay) {
      const length = day - currentDay;
      const capped = Math.min(1, Math.max(0, currentWeight));
      weightedDays += capped * length;
      segments.push({
        startDay: currentDay,
        endDay: day - 1,
        rawWeight: Number(currentWeight.toFixed(6)),
        cappedWeight: Number(capped.toFixed(6)),
        days: length,
      });
      currentDay = day;
    }

    currentWeight += events.get(day) || 0;
  }

  return {
    value: Number(weightedDays.toFixed(6)),
    trace: { missingWeightSources: [], segments },
  };
}

export interface ConceptCapabilityMetrics {
  calendar_days: number;
  allocation_weighted_days: number | null;
  recency_days: number | null;
  engagement_count: number;
  fact_count: number;
  project_count: number;
  evidence_strength_max: number | null;
}

export interface ConceptCapabilityMetricsTrace {
  as_of_date: string;
  concept_key: string;
  concept_type: string;
  engagement_ids: string[];
  fact_ids: string[];
  merged_intervals: DayInterval[];
  allocation_weighted: AllocationWeightedDaysTrace;
  evidence_strength_by_fact: Array<{
    fact_id: string;
    evidence_tier: string;
    verification_status: string;
    strength: number;
  }>;
  assumptions: string[];
}

export interface ConceptFactInput {
  fact_id: string;
  fact_type: string;
  engagement_id: string | null;
  evidence_tier: string;
  verification_status: string;
}

export interface ConceptEngagementInput {
  engagement_id: string;
  start_date: string;
  end_date: string | null;
  is_current: boolean;
  hours_per_week_band: string | null;
}

export interface ComputeConceptCapabilityMetricsInput {
  asOfDate: string;
  conceptKey: string;
  conceptType: string;
  engagements: ReadonlyArray<ConceptEngagementInput>;
  facts: ReadonlyArray<ConceptFactInput>;
  evidenceStrengthPolicy: EvidenceStrengthPolicy;
  hoursBandWeights: Record<string, number>;
}

export function computeConceptCapabilityMetrics(
  input: ComputeConceptCapabilityMetricsInput
): { metrics: ConceptCapabilityMetrics; trace: ConceptCapabilityMetricsTrace; metricsHash: string } {
  const asOfDay = parseIsoDateToDayIndex(input.asOfDate);

  const engagementById = new Map(input.engagements.map((e) => [e.engagement_id, e]));
  const engagementIds = Array.from(
    new Set(input.facts.map((f) => f.engagement_id).filter((id): id is string => !!id))
  ).sort();

  const intervals: DayInterval[] = [];
  const weightedIntervals: WeightedDayInterval[] = [];
  const assumptions: string[] = [];

  let mostRecentEndDay: number | null = null;

  for (const engagementId of engagementIds) {
    const engagement = engagementById.get(engagementId);
    if (!engagement) {
      assumptions.push(`missing_engagement_row:${engagementId}`);
      continue;
    }

    const startDay = parseIsoDateToDayIndex(engagement.start_date);

    let endDay: number | null = null;
    if (engagement.end_date) {
      endDay = parseIsoDateToDayIndex(engagement.end_date);
    } else if (engagement.is_current) {
      endDay = asOfDay;
    } else {
      assumptions.push(`missing_end_date:${engagementId}`);
      endDay = null;
    }

    if (endDay == null) {
      continue;
    }
    if (endDay < startDay) {
      assumptions.push(`invalid_date_range:${engagementId}`);
      continue;
    }

    intervals.push({ startDay, endDay });

    const weight =
      engagement.hours_per_week_band != null
        ? input.hoursBandWeights[engagement.hours_per_week_band] ?? null
        : null;
    weightedIntervals.push({
      startDay,
      endDay,
      weight,
      sourceKey: `engagement:${engagementId}`,
    });

    if (mostRecentEndDay == null || endDay > mostRecentEndDay) {
      mostRecentEndDay = endDay;
    }
  }

  const merged = mergeDayIntervals(intervals);
  const calendarDays = sumMergedIntervalDays(merged);

  const allocation = computeAllocationWeightedDays(weightedIntervals);

  const recencyDays =
    mostRecentEndDay == null ? null : Math.max(0, asOfDay - mostRecentEndDay);

  const evidenceByFact = input.facts
    .map((fact) => {
      const strength = computeEvidenceStrength(
        fact.evidence_tier as any,
        fact.verification_status as any,
        input.evidenceStrengthPolicy
      );
      return {
        fact_id: fact.fact_id,
        evidence_tier: fact.evidence_tier,
        verification_status: fact.verification_status,
        strength,
      };
    })
    .sort((a, b) => a.fact_id.localeCompare(b.fact_id));

  const maxStrength =
    evidenceByFact.length === 0 ? null : Math.max(...evidenceByFact.map((r) => r.strength));

  const metrics: ConceptCapabilityMetrics = {
    calendar_days: calendarDays,
    allocation_weighted_days: allocation.value,
    recency_days: recencyDays,
    engagement_count: engagementIds.length,
    fact_count: input.facts.length,
    project_count: input.facts.filter((f) => f.fact_type === 'PROJECT').length,
    evidence_strength_max: maxStrength == null ? null : Number(maxStrength.toFixed(6)),
  };

  const trace: ConceptCapabilityMetricsTrace = {
    as_of_date: input.asOfDate,
    concept_key: input.conceptKey,
    concept_type: input.conceptType,
    engagement_ids: engagementIds,
    fact_ids: input.facts.map((f) => f.fact_id).sort(),
    merged_intervals: merged,
    allocation_weighted: allocation.trace,
    evidence_strength_by_fact: evidenceByFact,
    assumptions: assumptions.sort(),
  };

  const metricsHash = sha256Hex(stableStringify({ metrics, trace }));

  return { metrics, trace, metricsHash };
}
