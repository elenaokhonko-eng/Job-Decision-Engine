export type CultureEvidenceSignal =
  | "AUTONOMY"
  | "POLITICS_RISK"
  | "SENSORY_WORKLOAD_RISK"
  | "FOCUS_PROTECTION";

export const CULTURE_SCORE_DERIVATION_VERSION = "quote_phrase_rules_v1";

const CULTURE_EVIDENCE_INDICATORS: Readonly<
  Record<CultureEvidenceSignal, { positive: readonly string[]; negative: readonly string[] }>
> = {
  AUTONOMY: {
    positive: [
      "work independently",
      "independent work",
      "minimal supervision",
      "self-directed",
      "end-to-end ownership",
    ],
    negative: [
      "close supervision",
      "micromanaged",
      "micromanagement",
      "approval required for each",
    ],
  },
  POLITICS_RISK: {
    positive: [
      "navigate competing priorities",
      "influence without authority",
      "competing stakeholder priorities",
      "matrixed environment",
      "stakeholder alignment",
      "political environment",
    ],
    negative: [
      "clear decision-making",
      "well-defined decision-making",
      "single decision-maker",
      "low-politics",
    ],
  },
  SENSORY_WORKLOAD_RISK: {
    positive: [
      "fast-paced environment",
      "high-volume environment",
      "frequent interruptions",
      "rapidly changing priorities",
      "multiple competing demands",
      "high-pressure environment",
      "on-call rotation",
      "24/7",
    ],
    negative: [
      "quiet work environment",
      "limited interruptions",
      "predictable schedule",
      "low-stimulation",
      "low stimulation",
    ],
  },
  FOCUS_PROTECTION: {
    positive: [
      "uninterrupted focus time",
      "protected focus time",
      "dedicated focus time",
      "deep work",
      "no-meeting days",
      "focus blocks",
    ],
    negative: [
      "frequent meetings",
      "constant context switching",
      "frequent interruptions",
      "meetings throughout the day",
      "high meeting load",
    ],
  },
};

function hasUnnegatedIndicator(text: string, phrase: string): boolean {
  let index = text.indexOf(phrase);
  while (index !== -1) {
    const currentClause = text.slice(0, index).split(/[.!?;:]/).at(-1) ?? "";
    const precedingText = currentClause.slice(-64);
    const negated = /(?:\bnot|\bno|\bnever|\bwithout|\bavoid(?:s|ing)?|\bisn't|\baren't|\bdoesn't|\bdon't)\b(?:\s+\w+){0,3}\s*$/i.test(precedingText);
    if (!negated) return true;
    index = text.indexOf(phrase, index + phrase.length);
  }
  return false;
}

export function scoreCultureEvidenceFromQuote(
  signal: CultureEvidenceSignal,
  quote: string,
): number | null {
  const normalizedQuote = quote.toLowerCase();
  const indicators = CULTURE_EVIDENCE_INDICATORS[signal];
  const positiveCount = indicators.positive.filter((phrase) => hasUnnegatedIndicator(normalizedQuote, phrase)).length;
  const negativeCount = indicators.negative.filter((phrase) => hasUnnegatedIndicator(normalizedQuote, phrase)).length;

  if (positiveCount > 0 && negativeCount > 0) return null;
  if (positiveCount > 0) return Math.min(90, 60 + positiveCount * 10);
  if (negativeCount > 0) return Math.max(10, 40 - negativeCount * 10);
  return null;
}
