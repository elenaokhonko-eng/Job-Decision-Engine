import type {
  CompensationComponent,
  CompensationEvidence,
} from "../contracts/jobSourceEvidence.js";
import {
  hasConflictingBaseSalaryDisclosures,
  isBaseSalaryExplicitlyUndisclosed,
  parseCompensationEvidence,
  type JobCompensationInput,
  type SalaryBasis,
} from "../policy/stage3PolicyEngine.js";

export type CompensationEvidenceResolution =
  | { readonly kind: "UNDISCLOSED"; readonly input: null; readonly reason: string }
  | { readonly kind: "SUPPORTED"; readonly input: JobCompensationInput; readonly reason: string }
  | { readonly kind: "UNRESOLVED"; readonly input: null; readonly reason: string };

function isExplicitlyUndisclosed(value: string | null | undefined): boolean {
  return !value?.trim() || /^(unknown|undisclosed|competitive|not disclosed|n\/?a)$/i.test(value.trim());
}

function unresolved(reason: string): CompensationEvidenceResolution {
  return { kind: "UNRESOLVED", input: null, reason };
}

function baseInput(component: CompensationComponent): JobCompensationInput | null {
  const period = component.period === "ANNUAL" || component.period === "MONTHLY" || component.period === "HOURLY"
    ? component.period
    : "UNKNOWN";
  const quote = component.evidence.map((span) => span.quote_text).join(" ");
  return parseCompensationEvidence(quote, {
    salary_min: component.amount_min,
    salary_max: component.amount_max,
    salary_currency: component.currency,
    salary_period: period,
    salary_basis: component.pay_basis,
    component_type: component.component_type,
    guaranteed_hours_per_week: component.guaranteed_hours_per_week,
    paid_weeks_per_year: component.paid_weeks_per_year,
  });
}

interface AnnualizedBaseComponent {
  readonly minimum: number;
  readonly maximum: number;
  readonly currency: string;
  readonly basis: Exclude<SalaryBasis, "UNKNOWN">;
}

function annualizeBaseComponent(component: CompensationComponent): AnnualizedBaseComponent | null {
  if (component.period !== "ANNUAL" && component.period !== "MONTHLY") return null;
  if (component.amount_min === null || component.amount_max === null || !component.currency) return null;
  if (component.pay_basis === "UNKNOWN") return null;
  const factor = component.period === "MONTHLY" ? 12 : 1;
  return {
    minimum: Math.round(component.amount_min * factor),
    maximum: Math.round(component.amount_max * factor),
    currency: component.currency,
    basis: component.pay_basis,
  };
}

function resolveMultipleBaseComponents(
  components: readonly CompensationComponent[],
): CompensationEvidenceResolution {
  const normalized = components.map(annualizeBaseComponent);
  if (normalized.some((component) => component === null)) {
    return unresolved("Multiple base-salary disclosures cannot be compared without matching currency, basis, and pay period.");
  }
  const supported = normalized.filter((component): component is AnnualizedBaseComponent => component !== null);
  const reference = supported[0];
  if (!reference || supported.some((component) =>
    component.currency !== reference.currency ||
    component.basis !== reference.basis ||
    Math.abs(component.minimum - reference.minimum) > 1 ||
    Math.abs(component.maximum - reference.maximum) > 1
  )) {
    return unresolved("Monthly and annual base-salary disclosures conflict; compensation requires verification.");
  }
  return {
    kind: "SUPPORTED",
    input: {
      salary_min: reference.minimum,
      salary_max: reference.maximum,
      salary_currency: reference.currency,
      salary_period: "ANNUAL",
      salary_basis: reference.basis,
      component_type: "BASE_CASH",
    },
    reason: "Consistent base-salary disclosures were normalized to one annual amount.",
  };
}

export function resolveCompensationEvidence(
  raw: string | null | undefined,
  evidence: CompensationEvidence | null,
): CompensationEvidenceResolution {
  if (evidence?.status === "CONFLICTING" || evidence?.status === "INVALID") {
    return unresolved("Compensation source evidence is conflicting or invalid; verify the advertised base salary.");
  }
  if (hasConflictingBaseSalaryDisclosures(raw)) {
    return unresolved("Multiple raw base-salary disclosures conflict; verify the advertised base salary.");
  }

  const baseComponents = evidence?.components.filter((component) => component.component_type === "BASE_CASH") ?? [];
  if (baseComponents.length > 0 && evidence?.status !== "SUPPORTED") {
    return unresolved("Base-salary components exist without supported source evidence.");
  }
  if (baseComponents.length > 1) return resolveMultipleBaseComponents(baseComponents);
  if (baseComponents.length === 1) {
    const input = baseInput(baseComponents[0]!);
    return input
      ? { kind: "SUPPORTED", input, reason: "Supported guaranteed base-salary evidence is available." }
      : unresolved("Supported base-salary evidence could not be parsed.");
  }

  const parsed = parseCompensationEvidence(raw);
  if (parsed?.component_type === "BASE_CASH") {
    return { kind: "SUPPORTED", input: parsed, reason: "Advertised base-salary text is available." };
  }
  if (parsed) {
    return {
      kind: "UNDISCLOSED",
      input: null,
      reason: "Salary undisclosed—confirm with recruiter. Variable pay and equity are not guaranteed base salary.",
    };
  }
  if (isBaseSalaryExplicitlyUndisclosed(raw) || isExplicitlyUndisclosed(raw)) {
    return { kind: "UNDISCLOSED", input: null, reason: "Salary undisclosed—confirm with recruiter." };
  }
  return unresolved("Compensation text is present but could not be parsed as guaranteed base salary.");
}
