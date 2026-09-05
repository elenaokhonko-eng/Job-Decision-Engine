import { z } from 'zod';

export const DecisionFieldRefSchema = z.enum([
  'gate_decision',
  'eligibility',
  'requirement_score',
  'coverage_score',
  'evidence_completeness',
]);

export type DecisionFieldRef = z.infer<typeof DecisionFieldRefSchema>;

export type DecisionContextValue = string | number | boolean | null;

export type DecisionEvalContext = {
  gate_decision: string | null;
  eligibility: string | null;
  requirement_score: number | null;
  coverage_score: number | null;
  evidence_completeness: number | null;
};

export const RuleLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type RuleLiteral = z.infer<typeof RuleLiteralSchema>;

type CompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export type RuleExpr =
  | { op: 'and'; args: RuleExpr[] }
  | { op: 'or'; args: RuleExpr[] }
  | { op: 'not'; arg: RuleExpr }
  | { op: CompareOp; field: DecisionFieldRef; value: RuleLiteral }
  | { op: 'in'; field: DecisionFieldRef; values: RuleLiteral[] }
  | { op: 'exists'; field: DecisionFieldRef }
  | { op: 'is_null'; field: DecisionFieldRef };

export const RuleExprSchema: z.ZodType<RuleExpr> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('and'), args: z.array(RuleExprSchema).min(1) }),
    z.object({ op: z.literal('or'), args: z.array(RuleExprSchema).min(1) }),
    z.object({ op: z.literal('not'), arg: RuleExprSchema }),
    z.object({
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']),
      field: DecisionFieldRefSchema,
      value: RuleLiteralSchema,
    }),
    z.object({
      op: z.literal('in'),
      field: DecisionFieldRefSchema,
      values: z.array(RuleLiteralSchema).min(1),
    }),
    z.object({ op: z.literal('exists'), field: DecisionFieldRefSchema }),
    z.object({ op: z.literal('is_null'), field: DecisionFieldRefSchema }),
  ])
);

export function getDecisionFieldValue(
  field: DecisionFieldRef,
  ctx: DecisionEvalContext
): DecisionContextValue {
  switch (field) {
    case 'gate_decision':
      return ctx.gate_decision;
    case 'eligibility':
      return ctx.eligibility;
    case 'requirement_score':
      return ctx.requirement_score;
    case 'coverage_score':
      return ctx.coverage_score;
    case 'evidence_completeness':
      return ctx.evidence_completeness;
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function compare(op: CompareOp, left: DecisionContextValue, right: RuleLiteral): boolean {
  if (op === 'eq') return left === right;
  if (op === 'neq') return left !== right;

  if (typeof left !== 'number' || typeof right !== 'number') {
    return false;
  }

  if (op === 'gt') return left > right;
  if (op === 'gte') return left >= right;
  if (op === 'lt') return left < right;
  if (op === 'lte') return left <= right;

  return false;
}

export function evaluateRuleExpr(expr: RuleExpr, ctx: DecisionEvalContext): boolean {
  if (expr.op === 'and') {
    for (const e of expr.args) {
      if (!evaluateRuleExpr(e, ctx)) return false;
    }
    return true;
  }

  if (expr.op === 'or') {
    for (const e of expr.args) {
      if (evaluateRuleExpr(e, ctx)) return true;
    }
    return false;
  }

  if (expr.op === 'not') {
    return !evaluateRuleExpr(expr.arg, ctx);
  }

  if (expr.op === 'exists') {
    const value = getDecisionFieldValue(expr.field, ctx);
    return value !== null && value !== undefined;
  }

  if (expr.op === 'is_null') {
    const value = getDecisionFieldValue(expr.field, ctx);
    return value === null || value === undefined;
  }

  if (expr.op === 'in') {
    const value = getDecisionFieldValue(expr.field, ctx);
    return expr.values.some((v) => value === v);
  }

  return compare(expr.op, getDecisionFieldValue(expr.field, ctx), expr.value);
}

