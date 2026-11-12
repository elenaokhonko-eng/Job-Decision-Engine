/**
 * Pre-sales, post-sales and customer-engagement duties of THIS role (gate-2026-11.4).
 *
 * Owner policy: a presales or high-interaction role is a hard reject for any title,
 * including "Solutions Architect" and "Product Specialist". A posting is such a role when
 * it places the role in a pre-sales, post-sales, customer success or customer engagement
 * organisation ("sits within our post-sales organization", "part of the pre-sales team",
 * "joins the Customer Success team"), or names customer-journey, proof-of-value or
 * company-representative duties as the role's own duties ("responsible for the entire
 * customer journey", "set proof-of-value timelines", "serve as the face of <Company> in
 * <market>", "regular customer engagements to unblock adoption", "partner with Account
 * Executives to drive expansion and renewal").
 *
 * Scoping, as in src/pipeline/onsiteStatements.ts: each clause (sentence, bullet or line) is
 * read on its own; the clause must be about this role or the applicant (a bullet or an
 * imperative with no subject, "you", "this role/position", "the <title>"); a governing
 * negation ("this is not a pre-sales role") cancels it; company boilerplate (equal
 * opportunity, benefits, about-us, mission or history sentences) is never read. "Customer"
 * alone, "customer data", "our customers" and "work with stakeholders" match nothing:
 * every pattern names a sales/success organisation or a sales-cycle duty.
 *
 * Input is lowercase. Dependency-free and deterministic.
 */

// Organisations whose members are pre-sales, post-sales or customer-engagement staff. Solutions or field
// engineering and go-to-market are left out: internal "solution engineering" groups and GTM operations
// roles are not customer-facing by name alone.
const ORG = String.raw`(?:pre[- ]?sales?|post[- ]?sales?|customer[- ]success|customer[- ]engagement|client[- ]success|sales[- ]engineering)`;
const ORG_UNIT = String.raw`(?:organi[sz]ations?|orgs?|teams?|functions?|departments?|groups?|units?|practices?)`;

const PATTERNS: readonly RegExp[] = [
  // Placement: "sits within <co>'s post-sales organization", "part of the pre-sales team", "joins the customer success team"
  new RegExp(String.raw`\b(?:sits?|sitting|seated|is|are|be|being)?[ \t]*(?:within|in|inside)[ \t]+(?:our|the|[\w&.-]+['’]s)[ \t]+(?:[\w&-]+[ \t]+){0,3}?${ORG}[ \t]+${ORG_UNIT}\b`, "g"),
  new RegExp(String.raw`\b(?:part[ \t]+of|member[ \t]+of|join(?:s|ing)?|report(?:s|ing)?[ \t]+(?:in)?to)[ \t]+(?:our|the|a|[\w&.-]+['’]s)[ \t]+(?:[\w&-]+[ \t]+){0,3}?${ORG}(?:[ \t]+${ORG_UNIT})?\b`, "g"),
  // Customer journey / lifecycle ownership
  /\b(?:responsible[ \t]+for|own(?:s|ing)?|manag(?:e|es|ing)|lead(?:s|ing)?|driv(?:e|es|ing)|orchestrat(?:e|es|ing))[ \t]+(?:the[ \t]+)?(?:(?:entire|end[- ]to[- ]end|full|whole|overall)[ \t]+(?:customer|client)[ \t]+(?:journey|lifecycle|life[ \t]+cycle)|(?:customer|client)[ \t]+journey|(?:customer|client)[ \t]+(?:lifecycle|life[ \t]+cycle)[ \t]+end[- ]to[- ]end)\b/g,
  // Proof of value / concept as the role's own sales-cycle duty
  /\b(?:set(?:s|ting)?|defin(?:e|es|ing)|run(?:s|ning)?|lead(?:s|ing)?|deliver(?:s|ing)?|scop(?:e|es|ing)|own(?:s|ing)?|driv(?:e|es|ing)|manag(?:e|es|ing)|establish(?:es|ing)?|execut(?:e|es|ing)|conduct(?:s|ing)?)[ \t]+(?:[\w,&/-]+[ \t]+){0,4}?(?:proofs?[- ]of[- ](?:value|concept)|povs?|pocs?)\b/g,
  // Company representative: "serve as the face of <co> in korea", "represent <co> to customers". "Voice of the customer"
  // and "representative for <initiative>" are internal advocacy, not representing the company.
  /\b(?:serv(?:e|es|ing)|act(?:s|ing)?|be|being)[ \t]+as[ \t]+(?:the[ \t]+|a[ \t]+|our[ \t]+)?(?:[\w-]+[ \t]+)?face[ \t]+of\b/g,
  /\brepresent(?:s|ing)?[ \t]+(?:[\w&.-]+[ \t]+){1,3}?(?:to|with|in[ \t]+front[ \t]+of|before)[ \t]+(?:our[ \t]+|the[ \t]+)?(?:customers|clients|prospects|buyers)\b/g,
  // Regular customer engagements
  /\b(?:regular|frequent|ongoing|recurring|weekly|daily|monthly|direct)[ \t]+(?:customer|client|prospect)[- ](?:engagements?|meetings?|calls?|visits?|workshops?|sessions?|check-?ins?)\b/g,
  // Partnering with sales roles on revenue/adoption outcomes
  /\bpartner(?:s|ing)?[ \t]+(?:closely[ \t]+)?with[ \t]+(?:our[ \t]+|the[ \t]+)?(?:account[ \t]+executives?|aes|account[ \t]+managers?|customer[ \t]+success[ \t]+managers?|csms?)\b[^.;\n]{0,120}?\b(?:expansion|renewals?|upsell|cross-sell|adoption)\b/g,
  // Revenue duties
  /\b(?:driv(?:e|es|ing)|own(?:s|ing)?|grow(?:s|ing)?|secur(?:e|es|ing))[ \t]+(?:account[ \t]+|customer[ \t]+|client[ \t]+)?(?:expansion[ \t]+and[ \t]+renewals?|renewals?(?:[ \t]+and[ \t]+expansion)?|upsell(?:ing)?|cross-sell(?:ing)?)\b(?![ \t]+(?:rates?|reporting|forecasts?|analysis|data|metrics|dashboards?))/g,
  // Demos and RFPs for prospects
  /\b(?:deliver(?:s|ing)?|run(?:s|ning)?|lead(?:s|ing)?|conduct(?:s|ing)?|give|giv(?:es|ing))[ \t]+(?:[\w-]+[ \t]+){0,2}?demos?[ \t]+(?:to|for)[ \t]+(?:[\w-]+[ \t]+)?(?:prospects?|customers?|clients?|buyers)\b/g,
  /\b(?:respond(?:s|ing)?[ \t]+to|own(?:s|ing)?|lead(?:s|ing)?)[ \t]+(?:customer[ \t]+)?(?:rfps?|rfis?|rfqs?)\b/g,
];

/** Sentences about the company, its benefits or its hiring policy, never this role's duties. */
const BOILERPLATE = /equal[ \t]+opportunit|regardless[ \t]+of|all[ \t]+qualified[ \t]+applicants|\bbenefits?\b|\bperks?\b|\bwe[ \t]+offer\b|about[ \t]+us|our[ \t]+mission|\bfounded\b|headquartered|privacy[ \t]+(?:policy|notice)|reasonable[ \t]+accommodation|\bwe[ \t]+are[ \t]+(?:a|an|the)[ \t]+(?:leading|global|fast)/;
const NEGATION_BEFORE = /\b(?:not|never|without|no|neither|nor)\b|n['’]t\b/;
/** The clause is about this role or the applicant. */
const ROLE_OR_APPLICANT = /\byou(?:['’](?:ll|re|d|ve))?\b|\byour\b|\b(?:this|the)[ \t]+(?:[\w-]+[ \t]+){0,6}?(?:role|position|job|opportunity|candidate|incumbent|hire|post|architect|engineer|specialist|consultant|lead|analyst|scientist|manager|developer|advisor|adviser)\b|\b(?:successful|ideal|selected)[ \t]+(?:candidate|applicant)\b|\bwe[ \t]+are[ \t]+(?:looking|seeking|hiring)\b|\bin[ \t]+this[ \t]+(?:role|position)\b/;
const HEDGE = /\b(?:sometimes|occasionally|from[ \t]+time[ \t]+to[ \t]+time|may|might|could)\b/;
/** A bullet or an imperative has no subject. */
const IMPERATIVE_START = /^(?:(?:and|also|then|will|must|should|to|be|expect[ \t]+to|be[ \t]+expected[ \t]+to|hold|holding)[ \t]+)*(?:[\w-]+ly[ \t]+)?$/;

function clauses(text: string): string[] {
  return text.split(/[.!?;\n•·|]+|(?:^|\n)[ \t]*[-*][ \t]+/).map((clause) => clause.trim()).filter(Boolean);
}

function subjectIsThisRole(before: string): boolean {
  // Drop a heading or label before a colon ("Responsibilities: Own the customer journey").
  const subject = before.slice(before.lastIndexOf(":") + 1).trim();
  if (subject === "" || IMPERATIVE_START.test(`${subject} `)) return true;
  return ROLE_OR_APPLICANT.test(subject);
}

/**
 * The first clause that makes this role a pre-sales, post-sales or customer-engagement role,
 * quoted (lowercase, up to 240 characters); null when there is none.
 */
export function findCustomerFacingRoleDuty(text: string): string | null {
  for (const clause of clauses(String(text ?? "").toLowerCase())) {
    if (BOILERPLATE.test(clause)) continue;
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const start = match.index ?? 0;
        const before = clause.slice(0, start);
        if (NEGATION_BEFORE.test(before.slice(-40))) continue;
        if (!subjectIsThisRole(before)) continue;
        // A hedged duty ("sometimes directly with partner customers") is not the role's own duty.
        if (HEDGE.test(clause)) continue;
        // A proof of concept is a sales duty only for a customer or prospect; an internal PoC is not.
        if (/proofs?[- ]of[- ]concept|\bpocs?\b/.test(match[0]) && !/\b(?:customers?|clients?|prospects?|buyers?)\b/.test(clause)) continue;
        return clause.length > 240 ? `${clause.slice(Math.max(0, start - 80), start + 160).trim()}` : clause;
      }
    }
  }
  return null;
}
