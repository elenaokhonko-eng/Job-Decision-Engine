import { inferClauseImportance } from './clauseAnalysis.js';
import { POSTING_ITEM_EXTRACTION } from './requirementKinds.js';
import type { PostingItem, PostingSection } from './postingStructure.js';

export type PostingItemClass = 'SKILL' | 'TOOL' | 'RESPONSIBILITY' | 'YEARS' | 'DEGREE' | 'CERTIFICATE';

export interface ItemAlternatives {
  /** "or equivalent experience" style escape hatch. */
  equivalent_experience: boolean;
  /** "or related field" style escape hatch. */
  related_field: boolean;
  /** "X, Y or Z" options, each short. */
  options: string[];
}

const TOOL_PATTERN =
  /\b(?:python|sql|java(?:script)?|typescript|scala|rust|golang|c#|\.net|aws|azure|gcp|google cloud|kubernetes|k8s|docker|terraform|snowflake|databricks|spark|kafka|airflow|dbt|tableau|power ?bi|looker|react|node(?:\.js)?|postgres(?:ql)?|mysql|mongodb|redis|git(?:hub|lab)?|jira|excel|sap|salesforce|langchain|pytorch|tensorflow|hadoop|bigquery|redshift|ansible|jenkins|splunk|oracle|bash|linux)\b/i;
const YEARS_PATTERN = /\b(?:\d{1,2}(?:\.\d+)?\s*(?:\+|-\s*\d{1,2})?\s*(?:years?|yrs?)|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+years?)\b/i;
const DEGREE_PATTERN = /\b(?:bachelor(?:'s|s)?|master(?:'s|s)?|phd|doctorate|doctoral|degree|diploma|mba|msc|bsc|b\.?sc|m\.?sc)\b/i;
const CERTIFICATE_PATTERN = /\b(?:certifi(?:ed|cate|cation|cations)|licen[cs]e[ds]?|chartered|accredited|CFA|CPA|CISSP|PMP|PRINCE2)\b/i;
const RESPONSIBILITY_VERB =
  /^(?:lead|leading|build|building|design|designing|develop|developing|manage|managing|own|owning|drive|driving|deliver|delivering|partner|partnering|work|working|collaborate|collaborating|define|defining|implement|implementing|create|creating|maintain|maintaining|support|supporting|ensure|ensuring|provide|providing|establish|establishing|oversee|overseeing|coordinate|coordinating|analy[sz]e|analy[sz]ing|architect|architecting|contribute|contributing|translate|translating|identify|identifying|monitor|monitoring|mentor|mentoring|run|running|shape|shaping|develop|report|reporting|prepare|preparing|conduct|conducting|champion|champion)\b/i;

/** Items the hard gates already own, or that are not capability requirements. */
const NOT_A_CAPABILITY =
  /\b(?:on[- ]?call|shift work|night shift|work authori[sz]ation|right to work|visa|sponsorship|salary|compensation|benefits?|equal opportunity|employer|discriminat\w*|accommodat\w*|diversity|inclusive|protected (?:class|characteristic)\w*|wellbeing|belong(?:ing)?|be yourself|our (?:culture|mission|values|purpose)|we help the world|we offer|health insurance|annual leave|paid leave|dress code|office days?|days? (?:a|per) week|hybrid|work from home|apply (?:now|today)|click|submit your)\b/i;
const NEGATIVE_START = /^(?:no|not|none|without)\b/i;

const EQUIVALENT_EXPERIENCE =
  /\bor\s+(?:equivalent|comparable)(?:\s+(?:practical|professional|work|industry|relevant))?(?:\s+experience)?\b|\bor\s+(?:relevant|similar)\s+(?:work |industry |practical )?experience\b|\bequivalent\s+(?:practical |work |professional )?experience\b/i;
const RELATED_FIELD =
  /\bor\s+(?:a\s+|an\s+)?(?:related|relevant|similar|equivalent)\s+(?:field|discipline|subject|area|degree|qualification)s?\b|\bor\s+related\b/i;

export function classifyPostingItem(text: string, section: PostingSection): PostingItemClass {
  if (CERTIFICATE_PATTERN.test(text) && !DEGREE_PATTERN.test(text)) return 'CERTIFICATE';
  if (DEGREE_PATTERN.test(text)) return 'DEGREE';
  if (YEARS_PATTERN.test(text) && /\bexperience\b/i.test(text)) return 'YEARS';
  const startsWithVerb = RESPONSIBILITY_VERB.test(text.trim());
  // "You will lead ...", "In addition, you will ..." and "... responsible for ..." describe duties.
  const describesDuty = /^(?:in addition,?\s+|also,?\s+)?you(?:'ll|\u2019ll| will)\b|\bresponsible for\b/i.test(text.trim());
  if (section === 'RESPONSIBILITIES' || ((startsWithVerb || describesDuty) && section !== 'REQUIREMENTS')) return 'RESPONSIBILITY';
  if (TOOL_PATTERN.test(text) && text.length <= 90 && !startsWithVerb) return 'TOOL';
  return 'SKILL';
}

export function detectAlternatives(text: string): ItemAlternatives {
  const equivalent = EQUIVALENT_EXPERIENCE.test(text);
  const related = RELATED_FIELD.test(text);
  let options: string[] = [];
  if (/\s(?:or|\/)\s/i.test(text) || /,\s*or\s/i.test(text)) {
    const tail = text.match(/\b(?:experience|knowledge|proficiency|familiarity|expertise|understanding)\s+(?:with|in|of)\s+(.+)$/i)?.[1] ?? text;
    const parts = tail
      .replace(/[.;]+$/, '')
      .split(/\s*,\s*(?:or\s+)?|\s+or\s+|\s*\/\s*/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part.length <= 40 && part.split(/\s+/).length <= 4);
    if (parts.length >= 2 && parts.length <= 6) options = parts;
  }
  return { equivalent_experience: equivalent, related_field: related, options };
}

export interface PostingItemRequirementDraft {
  text: string;
  start: number;
  end: number;
  item_class: PostingItemClass;
  section: PostingSection;
  importance: 'MUST' | 'PREFERRED' | 'NICE_TO_HAVE';
  alternatives: ItemAlternatives;
  structured_value: Record<string, unknown>;
}

/** Turns parsed posting items into requirement drafts. Items outside the capability scope are dropped. */
export function draftPostingItemRequirements(
  description: string,
  items: readonly PostingItem[],
): PostingItemRequirementDraft[] {
  const drafts: PostingItemRequirementDraft[] = [];
  for (const item of items) {
    const text = item.text;
    if (NEGATIVE_START.test(text) || NOT_A_CAPABILITY.test(text)) continue;
    const itemClass = classifyPostingItem(text, item.section);
    const inferred = inferClauseImportance(description, item.start, item.end);
    const preferenceWording = /\b(?:is|are|would be|will be)\s+(?:highly\s+)?(?:valued|welcome|an advantage|a plus|beneficial|desirable|helpful)\b|\b(?:advantageous|desirable|ideally|preferably|nice to have)\b/i.test(text);
    const importance =
      item.section === 'NICE_TO_HAVE' ? 'NICE_TO_HAVE' : inferred === 'MUST' && preferenceWording ? 'PREFERRED' : inferred;
    const alternatives = detectAlternatives(text);
    drafts.push({
      text,
      start: item.start,
      end: item.end,
      item_class: itemClass,
      section: item.section,
      importance,
      alternatives,
      structured_value: {
        extraction: POSTING_ITEM_EXTRACTION,
        item_class: itemClass,
        section: item.section,
        alternatives,
      },
    });
  }
  return drafts;
}
