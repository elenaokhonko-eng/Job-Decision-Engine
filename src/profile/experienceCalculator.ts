/**
 * Profile experience calculator
 * @description Calculate professional years from engagements with founder equivalence and interval merging
 * @version 2.0
 */

import { ProfileEngagementSchema, ExperienceClassSchema, EngagementTypeSchema } from './contracts.js';
import { z } from 'zod';

export interface DateInterval {
  startDate: Date;
  endDate: Date;
}

export interface ExperienceDuration {
  totalMonths: number;
  totalYears: number;
  intervals: DateInterval[];
}

/**
 * Experience multiplier by engagement type
 * All types count equally under the professional experience policy
 */
const ENGAGEMENT_TYPE_WEIGHT: Record<string, number> = {
  EMPLOYEE: 1.0,
  FOUNDER_OPERATOR: 1.0,
  CONTRACTOR: 1.0,
  RESEARCHER: 1.0,
};

/**
 * Experience multiplier by evidence tier
 * Only PROFESSIONAL_PRODUCTION counts toward professional years
 */
const EVIDENCE_TIER_WEIGHT: Record<string, number> = {
  PROFESSIONAL_PRODUCTION: 1.0,
  DEPLOYED_OPEN_SOURCE: 0.0, // Capability evidence, not professional years
  APPLIED_PROJECT: 0.0,
  COURSE_PROJECT: 0.0,
  KNOWLEDGE_ONLY: 0.0,
};

/**
 * Parse ISO 8601 date string to Date object
 */
export function parseDate(dateStr: string | Date | null | undefined): Date | null {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Calculate months between two dates
 */
export function calculateMonths(start: Date, end: Date): number {
  const months =
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth());
  return Math.max(0, months);
}

/**
 * Check if two intervals overlap or are adjacent
 */
function intervalsOverlap(a: DateInterval, b: DateInterval): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/**
 * Merge two overlapping or adjacent intervals
 */
function mergeIntervals(a: DateInterval, b: DateInterval): DateInterval {
  return {
    startDate: new Date(Math.min(a.startDate.getTime(), b.startDate.getTime())),
    endDate: new Date(Math.max(a.endDate.getTime(), b.endDate.getTime())),
  };
}

/**
 * Merge a list of date intervals by combining overlapping periods
 */
export function mergeOverlappingIntervals(intervals: DateInterval[]): DateInterval[] {
  if (intervals.length === 0) return [];
  if (intervals.length === 1) return intervals;

  // Sort by start date
  const sorted = [...intervals].sort(
    (a, b) => a.startDate.getTime() - b.startDate.getTime()
  );

  const merged: DateInterval[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (intervalsOverlap(last, sorted[i])) {
      merged[merged.length - 1] = mergeIntervals(last, sorted[i]);
    } else {
      merged.push(sorted[i]);
    }
  }

  return merged;
}

/**
 * Calculate professional experience from an engagement
 * Applies founder equivalence (FOUNDER_OPERATOR counts equally to EMPLOYEE)
 * Only PROFESSIONAL_PRODUCTION experiences count toward professional years
 */
export async function calculateEngagementExperience(
  engagement: z.infer<typeof ProfileEngagementSchema>,
  referenceDate: Date = new Date()
): Promise<ExperienceDuration> {
  const typeWeight = ENGAGEMENT_TYPE_WEIGHT[engagement.engagement_type] || 0;
  const tierWeight = EVIDENCE_TIER_WEIGHT[engagement.experience_class] || 0;

  // If this experience doesn't count professionally, return zero
  if (typeWeight === 0 || tierWeight === 0) {
    return {
      totalMonths: 0,
      totalYears: 0,
      intervals: [],
    };
  }

  const startDate = parseDate(engagement.start_date);
  if (!startDate) {
    throw new Error(`Invalid start_date for engagement ${engagement.engagement_key}`);
  }

  // Use end_date if provided, otherwise use reference date (or today if current)
  let endDate = engagement.end_date ? parseDate(engagement.end_date) : null;
  if (!endDate) {
    endDate = engagement.is_current ? referenceDate : referenceDate;
  }

  if (endDate < startDate) {
    throw new Error(
      `Invalid date range for engagement ${engagement.engagement_key}: end before start`
    );
  }

  const months = calculateMonths(startDate, endDate);

  return {
    totalMonths: months,
    totalYears: months / 12,
    intervals: [{ startDate, endDate }],
  };
}

/**
 * Calculate total professional experience for a normalized concept
 * across multiple engagements/facts
 * Merges overlapping periods and sums non-overlapping periods
 */
export async function calculateConceptExperience(
  engagements: z.infer<typeof ProfileEngagementSchema>[],
  referenceDate: Date = new Date()
): Promise<ExperienceDuration> {
  const allIntervals: DateInterval[] = [];

  for (const engagement of engagements) {
    const duration = await calculateEngagementExperience(engagement, referenceDate);
    allIntervals.push(...duration.intervals);
  }

  if (allIntervals.length === 0) {
    return {
      totalMonths: 0,
      totalYears: 0,
      intervals: [],
    };
  }

  const mergedIntervals = mergeOverlappingIntervals(allIntervals);

  // Sum the months across all merged intervals
  let totalMonths = 0;
  for (const interval of mergedIntervals) {
    totalMonths += calculateMonths(interval.startDate, interval.endDate);
  }

  return {
    totalMonths,
    totalYears: totalMonths / 12,
    intervals: mergedIntervals,
  };
}

/**
 * Validate that founder experience is properly classified
 * GuideBuoy: FOUNDER_OPERATOR, PROFESSIONAL_PRODUCTION
 */
export async function validateFounderExperience(
  engagement: z.infer<typeof ProfileEngagementSchema>
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];

  if (engagement.engagement_type === 'FOUNDER_OPERATOR') {
    if (engagement.experience_class !== 'PROFESSIONAL_PRODUCTION') {
      issues.push(
        `Founder engagement "${engagement.engagement_key}" should use experience_class=PROFESSIONAL_PRODUCTION`
      );
    }

    if (!engagement.production_start_date) {
      issues.push(
        `Founder engagement "${engagement.engagement_key}" should specify production_start_date`
      );
    }

    if (engagement.is_current && !engagement.first_external_user_date) {
      issues.push(
        `Current founder engagement "${engagement.engagement_key}" should specify first_external_user_date if operating for external users`
      );
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Validate experience duration is realistic
 */
export async function validateExperienceDuration(
  engagement: z.infer<typeof ProfileEngagementSchema>
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];

  const startDate = parseDate(engagement.start_date);
  if (!startDate) {
    issues.push(`Invalid start_date for engagement "${engagement.engagement_key}"`);
    return { valid: false, issues };
  }

  const endDate = engagement.end_date ? parseDate(engagement.end_date) : new Date();
  if (!endDate) {
    issues.push(`Invalid end_date for engagement "${engagement.engagement_key}"`);
    return { valid: false, issues };
  }

  if (endDate < startDate) {
    issues.push(
      `End date before start date for engagement "${engagement.engagement_key}"`
    );
  }

  // Warn if engagement is longer than 50 years (unrealistic)
  const years = calculateMonths(startDate, endDate) / 12;
  if (years > 50) {
    issues.push(
      `Engagement "${engagement.engagement_key}" duration ${years.toFixed(1)} years is unusually long`
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
