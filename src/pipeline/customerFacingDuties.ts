/**
 * Pre-sales, post-sales and customer-engagement duties of THIS role (gate-2026-11.4).
 *
 * Owner policy: a presales or high-interaction role is a hard reject for any title,
 * including "Solutions Architect" and "Product Specialist". A posting is such a role when
 * it places this role in a pre-sales, post-sales, customer success, customer engagement or
 * sales engineering organisation ("This role sits within our post-sales organization",
 * "You will join the Customer Success team", "reporting to the VP of Customer Success"), or
 * names sales-cycle or account-relationship duties as the role's own duties ("responsible for
 * the entire customer journey", "set proof-of-value timelines with prospective customers",
 * "serve as the face of <Company> in <market>", "regular customer engagements", "partner with
 * Account Executives to drive expansion and renewal", "respond to RFPs", "demos to prospects").
 *
 * Scoping, as in src/pipeline/onsiteStatements.ts: each clause (sentence, bullet or line) is
 * read on its own, and the text before the match must be exactly a subject that is this role
 * or the applicant ("you will", "this role", "the <title>", "as a <title>, you will", "we are
 * seeking a <title> to") or no subject (a bullet, an imperative, a heading before a colon). So
 * "you will partner with leaders in our Customer Success organization", "you'll build
 * dashboards used by managers in the customer success team" and "the engineer collaborates
 * with colleagues in the sales engineering team" are not placements. A governing negation or
 * a hedge cancels a match; company boilerplate (equal opportunity, benefits, about-us) is never
 * read. Analytics on customers ("customer journey analytics", "upsell propensity models"),
 * internal proofs of concept or value, internal customers, buyer-side RFPs and "the face of
 * the data team" are not customer-facing duties.
 *
 * Input is lowercase. Dependency-free and deterministic.
 */

const ORG = String.raw`(?:pre[- ]?sales?|post[- ]?sales?|customer[- ]success|customer[- ]engagement|client[- ]success|sales[- ]engineering)`;
const ORG_UNIT = String.raw`(?:organi[sz]ations?|orgs?|teams?|functions?|departments?|groups?)`;
const OWNER = String.raw`(?:our|the|a|[\w&.-]+['’]s)`;
/** An analytics, data or tooling object: work on customers, not with them. */
const ANALYTICS_OBJECT = /\b(?:analytics|data|models?|modell?ing|attribution|propensity|mapping|dashboards?|pipelines?|insights?|metrics|reporting|research|forecasts?|forecasting|rates?|segmentation|scoring|experiments?|demand)\b/;
/** A direct external customer or prospect object ("with prospective customers", "to a customer", "the customer's"). */
const CUSTOMER_OBJECT = /\b(?:with|for|to)[ \t]+(?:(?:a|an|the|our|your|each|every|prospective|potential|new|existing|key|strategic|enterprise|external|target)[ \t]+){0,3}(?:customers?|clients?|prospects?|buyers?)\b(?!['’]?[ \t]*(?:experience|retention|satisfaction|outcomes?|data|journey|insights?|analytics|success[ \t]+analytics))|\b(?:customer|client|prospect)['’]s?[ \t]+(?:team|teams|environment|environments|site|sites|stack|data|use[ \t]+cases?)\b|\b(?:a|the)[ \t]+(?:customer|client|prospect)\b(?![ \t]+(?:experience|retention|satisfaction|outcomes?|data|journey|insights?|analytics|base|support|service))/;

interface Pattern {
  readonly regex: RegExp;
  /** Extra test on the clause and the text after the match; false skips the match. */
  readonly accept?: (clause: string, start: number, end: number) => boolean;
}

const after = (clause: string, end: number): string => clause.slice(end);

const PATTERNS: readonly Pattern[] = [
  // Placement: "this role sits within <co>'s post-sales organization", "you will be part of the pre-sales team",
  // "you will join the customer success team" (an organisation word is required: "customer engagement platform team" is a product area).
  { regex: new RegExp(String.raw`\b(?:sits?|sitting|is|will[ \t]+sit|will[ \t]+be|be|based)?[ \t]*(?:within|inside|in|part[ \t]+of|a[ \t]+member[ \t]+of)[ \t]+${OWNER}[ \t]+(?:[\w&-]+[ \t]+){0,2}?${ORG}[ \t]+${ORG_UNIT}\b`, "g") },
  { regex: new RegExp(String.raw`\b(?:join|joining|be[ \t]+part[ \t]+of|become[ \t]+part[ \t]+of|be[ \t]+a[ \t]+member[ \t]+of)[ \t]+${OWNER}[ \t]+(?:[\w&-]+[ \t]+){0,2}?${ORG}[ \t]+${ORG_UNIT}\b`, "g") },
  // Reporting line into a customer success / sales leader (not "Customer Success Analytics").
  {
    regex: new RegExp(String.raw`\breport(?:s|ing)?[ \t]+(?:in)?to[ \t]+(?:the|our)[ \t]+(?:(?:senior|global|regional|apac|emea)[ \t]+)?(?:vp|vice[ \t]+president|head|director|manager|lead|chief[ \t]+\w+[ \t]+officer)[ \t]+(?:of|for)[ \t]+${ORG}\b`, "g"),
    accept: (clause, _start, end) => !/^[ \t]*(?:analytics|operations|ops|data|insights|engineering|platform|enablement|strategy|technology)\b/.test(after(clause, end)),
  },
  // Customer journey / lifecycle ownership (not customer-journey analytics or data models).
  {
    regex: /\b(?:responsible[ \t]+for|own(?:s|ing)?|manag(?:e|es|ing)|lead(?:s|ing)?|driv(?:e|es|ing)|orchestrat(?:e|es|ing))[ \t]+(?:the[ \t]+)?(?:(?:entire|end[- ]to[- ]end|full|whole|overall)[ \t]+(?:customer|client)[ \t]+(?:journey|lifecycle|life[ \t]+cycle)|(?:customer|client)[ \t]+journey|(?:customer|client)[ \t]+(?:lifecycle|life[ \t]+cycle)[ \t]+end[- ]to[- ]end)\b/g,
    accept: (clause, _start, end) => !ANALYTICS_OBJECT.test(after(clause, end).slice(0, 25)),
  },
  // Proof of value / concept for an external customer or prospect ("pov" is also "point of view", so it is not read).
  {
    regex: /\b(?:set(?:s|ting)?|defin(?:e|es|ing)|run(?:s|ning)?|lead(?:s|ing)?|deliver(?:s|ing)?|scop(?:e|es|ing)|own(?:s|ing)?|driv(?:e|es|ing)|manag(?:e|es|ing)|establish(?:es|ing)?|execut(?:e|es|ing)|conduct(?:s|ing)?)[ \t]+(?:[\w,&/-]+[ \t]+){0,4}?(?:proofs?[- ]of[- ](?:value|concept)|pocs?)\b/g,
    accept: (clause, start) => CUSTOMER_OBJECT.test(clause.slice(start, start + 220)),
  },
  // Company representative: "serve as the face of <co> in korea", "the face of the company to customers".
  { regex: /\b(?:serv(?:e|es|ing)|act(?:s|ing)?|be|being)[ \t]+as[ \t]+(?:the[ \t]+|a[ \t]+|our[ \t]+)?(?:[\w-]+[ \t]+)?face[ \t]+of[ \t]+(?:the[ \t]+(?:company|firm|business|brand)|us|our[ \t]+(?:company|product|products|brand|platform|firm)|(?!the\b|our\b|a\b)[\w&.-]+)(?=[ \t]+(?:in|to|for|across|with|among|within)\b|[ \t]*[,;]|[ \t]*$)/g },
  {
    regex: /\brepresent(?:s|ing)?[ \t]+(?!the[ \t]+[\w-]+(?:[ \t]+[\w-]+)?[ \t]+team\b)(?:[\w&.-]+[ \t]+){1,3}?(?:to|with|in[ \t]+front[ \t]+of|before)[ \t]+(?:our[ \t]+|the[ \t]+)?(?:customers|clients|prospects|buyers)\b/g,
  },
  // Regular customer engagements
  { regex: /\b(?:regular|frequent|ongoing|recurring|weekly|daily|monthly|direct)[ \t]+(?:customer|client|prospect)[- ](?:engagements?|meetings?|calls?|visits?|workshops?|sessions?|check-?ins?)\b/g },
  // Partnering with account roles on an expansion, renewal, upsell, revenue or deal object
  { regex: /\bpartner(?:s|ing)?[ \t]+(?:closely[ \t]+)?with[ \t]+(?:our[ \t]+|the[ \t]+)?(?:account[ \t]+executives?|aes|account[ \t]+managers?|customer[ \t]+success[ \t]+managers?|csms?)\b[^.;\n]{0,120}?\b(?:expansion|renewals?|upsell|cross-sell|revenue|arr|bookings|deals?)\b/g },
  // Revenue duties (not upsell/renewal analytics or models)
  {
    regex: /\b(?:driv(?:e|es|ing)|own(?:s|ing)?|grow(?:s|ing)?|secur(?:e|es|ing))[ \t]+(?:account[ \t]+|customer[ \t]+|client[ \t]+)?(?:expansion[ \t]+and[ \t]+renewals?|renewals?(?:[ \t]+and[ \t]+expansion)?|upsell(?:ing)?(?:[ \t]+and[ \t]+cross-sell(?:ing)?)?|cross-sell(?:ing)?)\b/g,
    accept: (clause, _start, end) => !ANALYTICS_OBJECT.test(after(clause, end)),
  },
  // Demos to prospects or external customers (not "internal customers")
  { regex: /\b(?:deliver(?:s|ing)?|run(?:s|ning)?|lead(?:s|ing)?|conduct(?:s|ing)?|give|giv(?:es|ing))[ \t]+(?:[\w-]+[ \t]+){0,2}?demos?[ \t]+(?:to|for|with)[ \t]+(?:(?:a|the|our|prospective|potential|new|existing|key|enterprise|external)[ \t]+){0,2}(?:prospects?|customers?|clients?|buyers)\b/g },
  // Responding to RFPs (sell-side); leading or owning RFPs to select vendors is buyer-side
  { regex: /\b(?:respond(?:s|ing)?[ \t]+to|answer(?:s|ing)?)[ \t]+(?:customer[ \t]+|client[ \t]+)?(?:rfps?|rfis?|rfqs?|tenders?)\b|\b(?:prepar(?:e|es|ing)|writ(?:e|es|ing)|draft(?:s|ing)?)[ \t]+(?:customer[ \t]+|client[ \t]+)?(?:rfp|rfi|tender)[ \t]+responses?\b/g },
];

/** Sentences about the company, its benefits or its hiring policy, never this role's duties. */
const BOILERPLATE = /equal[ \t]+opportunit|regardless[ \t]+of|all[ \t]+qualified[ \t]+applicants|\bbenefits?\b|\bperks?\b|\bwe[ \t]+offer\b|about[ \t]+us|our[ \t]+mission|\bfounded\b|headquartered|privacy[ \t]+(?:policy|notice)|reasonable[ \t]+accommodation|\bwe[ \t]+are[ \t]+(?:a|an|the)[ \t]+(?:leading|global|fast)/;
const NEGATION_BEFORE = /\b(?:not|never|without|no|neither|nor)\b|n['’]t\b/;
const HEDGE = /\b(?:sometimes|occasionally|from[ \t]+time[ \t]+to[ \t]+time|may|might|could)\b/;
const ROLE_NOUN = String.raw`(?:role|position|architect|engineer|specialist|consultant|lead|analyst|scientist|manager|developer|advisor|adviser|strategist|director|executive|partner)`;
/**
 * The whole text before the match is a subject that is this role or the applicant, or no subject.
 * Anything else ("you will partner with leaders", "the engineer collaborates with colleagues") is not.
 */
const SUBJECT = new RegExp(String.raw`^(?:(?:and|also|then|will|must|should|to|be|expect[ \t]+to|be[ \t]+expected[ \t]+to)[ \t]+)*(?:[\w-]+ly[ \t]+)?$|^(?:in[ \t]+this[ \t]+role,?[ \t]+)?(?:you|you['’]ll|you['’]re|you[ \t]+are|you[ \t]+will|you[ \t]+would|this[ \t]+role|this[ \t]+position|the[ \t]+role|the[ \t]+position|(?:the|this|our[ \t]+new)[ \t]+(?:[\w&–-]+[ \t]+){0,5}?${ROLE_NOUN}|as[ \t]+(?:an?[ \t]+|the[ \t]+|our[ \t]+)?[^:]{1,80}?,[ \t]*you(?:['’]ll)?|we[ \t]+are[ \t]+(?:seeking|looking[ \t]+for|hiring)[ \t]+(?:an?[ \t]+)?[^:]{1,80}?[ \t]+to)(?:[ \t]+(?:will|would|also|be|is|are|closely|personally|directly|regularly|expected[ \t]+to|responsible[ \t]+for))*[ \t]*$`);

function clauses(text: string): string[] {
  return text.split(/[.!?;\n•·|]+|(?:^|\n)[ \t]*[-*][ \t]+/).map((clause) => clause.trim()).filter(Boolean);
}

function subjectIsThisRole(before: string): boolean {
  // Drop a heading or label before a colon ("Responsibilities: Own the customer journey").
  const subject = before.slice(before.lastIndexOf(":") + 1).replace(/,[ \t]*$/, "").trim();
  return SUBJECT.test(subject === "" ? "" : `${subject} `) || SUBJECT.test(subject);
}

/**
 * The first clause that makes this role a pre-sales, post-sales or customer-engagement role,
 * quoted (lowercase, up to 240 characters); null when there is none.
 */
export function findCustomerFacingRoleDuty(text: string): string | null {
  for (const clause of clauses(String(text ?? "").toLowerCase())) {
    if (BOILERPLATE.test(clause) || HEDGE.test(clause)) continue;
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const match of clause.matchAll(pattern.regex)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        const before = clause.slice(0, start);
        if (NEGATION_BEFORE.test(before.slice(-40))) continue;
        if (!subjectIsThisRole(before)) continue;
        if (pattern.accept && !pattern.accept(clause, start, end)) continue;
        return clause.length > 240 ? clause.slice(Math.max(0, start - 80), start + 160).trim() : clause;
      }
    }
  }
  return null;
}
