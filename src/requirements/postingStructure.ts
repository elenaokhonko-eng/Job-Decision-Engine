/**
 * Splits a job posting into sections (responsibilities, requirements,
 * nice-to-have) and the individual items inside them.
 *
 * Pure and deterministic. Every item keeps its exact text and its offsets in
 * the original description, so a quote can always be checked against the
 * posting.
 */

export type PostingSection = 'RESPONSIBILITIES' | 'REQUIREMENTS' | 'NICE_TO_HAVE' | 'UNSECTIONED';

export interface PostingItem {
  /** Exact posting text with the bullet marker removed. */
  text: string;
  start: number;
  end: number;
  section: PostingSection;
  bulleted: boolean;
}

export interface PostingStructure {
  items: PostingItem[];
  hasRequirementsSection: boolean;
  hasResponsibilitiesSection: boolean;
}

/** OTHER: company, benefits, legal (skipped). INTRO: role overview (prose skipped, bullets are duties). */
type HeadingKind = Exclude<PostingSection, 'UNSECTIONED'> | 'OTHER' | 'INTRO';

const APOS = "['’]";

const HEADINGS: Array<[HeadingKind, RegExp]> = [
  [
    'NICE_TO_HAVE',
    new RegExp(
      `^(?:nice[- ]to[- ]haves?|good to have|bonus(?: points| skills)?|preferred(?: (?:qualifications|skills|experience|requirements))?|desirable(?: (?:skills|experience|qualifications))?|desired(?: (?:skills|qualifications|experience))?|pluses|it${APOS}s a plus|ideally(?: you)?|extra credit|additional (?:skills|qualifications))$`,
      'i',
    ),
  ],
  [
    'REQUIREMENTS',
    new RegExp(
      `^(?:(?:minimum |basic |key |essential |required |mandatory |job |role )?(?:qualifications?|requirements?)(?: (?:and|&) (?:experience|skills|qualifications))?|(?:required |key |essential |technical |core )?skills(?: (?:and|&) (?:experience|qualifications|requirements))?|(?:most|other) relevant skills|what you${APOS}ll bring|what you bring|what we${APOS}re looking for|what we are looking for|who you are|about you|your profile|you have|must[- ]haves?|essential(?: criteria)?|experience(?: required)?|what you need|what you${APOS}ll need|you should have|to be successful(?: in this role)?|the ideal candidate|candidate profile|ideal candidate)$`,
      'i',
    ),
  ],
  [
    'INTRO',
    new RegExp(
      `^(?:the role|your role|role (?:overview|description|summary)|job (?:description|summary)|about the role|about the job|overview|summary|description|the opportunity|position (?:summary|overview))$`,
      'i',
    ),
  ],
  [
    'RESPONSIBILITIES',
    new RegExp(
      `^(?:(?:key |main |core |primary )?responsibilit(?:y|ies)|(?:key |main )?duties|(?:what )?you${APOS}ll (?:do|be doing)|what you will (?:do|be doing)|what you do|job responsibilities|day[- ]to[- ]day|in this role|how you${APOS}ll make an impact|what the job involves|scope of (?:the )?role|you will)$`,
      'i',
    ),
  ],
  [
    'OTHER',
    new RegExp(
      `^(?:about (?:us|the (?:company|team|business|firm))|who we are|interview process|(?:our )?(?:benefits?|perks)(?: (?:and|&) perks)?|what we offer(?: you)?|what${APOS}s in it for you|why join(?: us)?|why you${APOS}ll love|equal opportunity.*|how to apply|compensation.*|salary.*|our (?:culture|values|mission|story)|company (?:overview|description)|the company|the team|diversity.*|disclaimer.*|about .{0,40})$`,
      'i',
    ),
  ],
];

const BULLET_MARKER = /^(\s*)(?:[-*•·–—▪●◦►➢✓✔❖]|\d{1,2}[.)])\s+/;
const HEADING_MAX_CHARS = 70;
const MIN_BULLET_CHARS = 5;
const MIN_PROSE_CHARS = 20;
const MAX_ITEM_CHARS = 400;
export const MAX_POSTING_ITEMS = 40;

function stripHeadingDecoration(line: string): string {
  return line
    .replace(/^[\s#*_>•\-:]+/, '')
    .replace(/[\s*_:\-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyHeading(rawLine: string): HeadingKind | null {
  const line = rawLine.trim();
  if (line.length === 0 || line.length > HEADING_MAX_CHARS) return null;
  if (BULLET_MARKER.test(rawLine) && !/[:*]$/.test(line)) return null;
  const cleaned = stripHeadingDecoration(line);
  if (cleaned.length < 3) return null;
  // A sentence is not a heading unless it is explicitly marked with a colon or bold.
  const marked = /[:]\s*$/.test(line) || /^\*\*.+\*\*:?$/.test(line) || /^#{1,4}\s/.test(line);
  if (!marked && /[.!?]$/.test(cleaned)) return null;
  for (const [kind, pattern] of HEADINGS) {
    if (pattern.test(cleaned)) return kind;
  }
  return null;
}

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Sentences that read like a requirement even without a heading. */
const REQUIREMENT_CUE =
  /\b(?:you (?:will|have|are|bring|should|must|can|possess)|experience (?:in|with|of|using)|proven|demonstrated|strong|solid|excellent|ability to|able to|knowledge of|proficien\w*|familiar\w*|expertise|background in|understanding of|track record|responsible for|skills? in|hands[- ]on)\b/i;

/** A sentence that opens with a duty verb ("Design low-latency feeds ...") or says what the employer is seeking. */
const DUTY_VERB_START =
  /^(?:lead|design|build|develop|manage|own|drive|deliver|architect|implement|create|define|oversee|run|maintain|support|shape|establish|partner|work with|collaborate|we are (?:seeking|looking for)|you(?:'|\u2019)ll)\b/i;

function pushSentences(
  line: string,
  lineStart: number,
  section: PostingSection,
  push: (item: PostingItem) => void,
  cueOnly = false,
): void {
  const pattern = /[^.!?;]+[.!?;]?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const raw = match[0];
    const lead = raw.match(/^\s*/)?.[0].length ?? 0;
    const text = raw.trim().replace(/[;]+$/, '').trim();
    if (text.length < MIN_PROSE_CHARS || text.length > MAX_ITEM_CHARS) continue;
    if (cueOnly && !REQUIREMENT_CUE.test(text) && !DUTY_VERB_START.test(text)) continue;
    const start = lineStart + match.index + lead;
    push({ text, start, end: start + text.length, section, bulleted: false });
  }
}

/** A run of posting text between two structural markers (line break, bullet glyph or heading). */
interface Unit {
  text: string;
  start: number;
  bulleted: boolean;
  /** Set when this unit is a heading: the section that follows it. */
  heading: HeadingKind | null;
}

const BULLET_GLYPHS = '\u2022\u00b7\u25aa\u25cf\u25e6\u25ba\u27a2\u2713\u2714\u2756';
const INLINE_BULLET = new RegExp(`[${BULLET_GLYPHS}]\\s*`, 'g');
/** A capitalised phrase ending in a colon at the start of a sentence, for example "Requirements:". */
const INLINE_COLON_HEADING = /(?<![A-Za-z0-9])([A-Z][A-Za-z\u2019'&/ ]{2,60}?)\s*:(?=\s|$)/g;
const MAX_HEADING_WORDS = 7;
/** Section headings that appear without a colon at the start of a sentence in flattened text. */
const INLINE_PLAIN_HEADING =
  /(?<=[.!?]\s+)(?:About (?:Us|the (?:Company|Team|Business|Firm))|What We Offer(?: You)?|Our Benefits|Benefits(?: (?:and|&) Perks)?|Why Join Us|Who We Are|Equal Opportunity(?: Employer)?)(?=\s)/g;

/**
 * Headings that flattening glued to the next sentence ("What We Are Looking ForExtensive experience ...",
 * "[What you will be working on]Develop ..."). Only unambiguous multi-word phrases, followed directly by
 * a capital letter.
 */
const GLUED_HEADING_PHRASES = [
  'What You Will Be Working On',
  'What You(?:\u2019|\')ll Be Working On',
  'What You Will Do',
  'What You(?:\u2019|\')ll Do',
  'What We Are Looking For',
  'What We(?:\u2019|\')re Looking For',
  'What You Bring',
  'What You(?:\u2019|\')ll Bring',
  'Key Responsibilities',
  'Main Responsibilities',
  'Job Requirements',
  'Minimum Qualifications',
  'Preferred Qualifications',
  'Nice to Have',
  'Interview Process',
  'What We Offer(?: You)?',
  'About the Role',
  'About the Team',
  'About Us',
  'Who You Are',
  'Who We Are',
];
const INLINE_GLUED_HEADING = new RegExp(
  `(?<![A-Za-z])\\[?(?:${GLUED_HEADING_PHRASES.join('|')})\\]?(?=[A-Z][a-z])`,
  'g',
);

/** Splits one physical line at inline bullet glyphs and inline headings, keeping original offsets. */
function splitLine(line: string, lineStart: number): Unit[] {
  const events: Array<{ at: number; end: number; kind: 'BULLET' | 'HEADING'; heading?: HeadingKind }> = [];

  for (const match of line.matchAll(INLINE_BULLET)) {
    events.push({ at: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: 'BULLET' });
  }
  for (const match of line.matchAll(INLINE_COLON_HEADING)) {
    // The phrase before a colon may carry the end of the previous sentence ("... communication
    // Nice to have:"). Take the longest trailing run of words that is a known heading.
    const words = match[1].split(' ');
    for (let from = 0; from < words.length; from += 1) {
      const phrase = words.slice(from).join(' ');
      if (words.length - from > MAX_HEADING_WORDS) continue;
      const kind = classifyHeading(`${phrase}:`);
      if (!kind) continue;
      const at = (match.index ?? 0) + match[0].lastIndexOf(phrase);
      events.push({ at, end: (match.index ?? 0) + match[0].length, kind: 'HEADING', heading: kind });
      break;
    }
  }
  for (const match of line.matchAll(INLINE_GLUED_HEADING)) {
    const at = match.index ?? 0;
    const kind = classifyHeading(match[0].replace(/[\[\]]/g, ''));
    events.push({ at, end: at + match[0].length, kind: 'HEADING', heading: kind ?? 'OTHER' });
  }
  for (const match of line.matchAll(INLINE_PLAIN_HEADING)) {
    const at = match.index ?? 0;
    events.push({ at, end: at + match[0].length, kind: 'HEADING', heading: 'OTHER' });
  }
  events.sort((a, b) => a.at - b.at || a.end - b.end);

  const units: Unit[] = [];
  let cursor = 0;
  let nextBulleted = false;
  const flush = (to: number) => {
    const text = line.slice(cursor, to);
    if (text.trim().length > 0) units.push({ text, start: lineStart + cursor, bulleted: nextBulleted, heading: null });
  };
  for (const event of events) {
    if (event.at < cursor) continue; // overlapping marker already consumed
    flush(event.at);
    if (event.kind === 'HEADING') {
      units.push({ text: '', start: lineStart + event.at, bulleted: false, heading: event.heading ?? 'OTHER' });
      nextBulleted = false;
    } else {
      nextBulleted = true;
    }
    cursor = event.end;
  }
  flush(line.length);
  return units;
}

export function parsePosting(description: string): PostingStructure {
  const items: PostingItem[] = [];
  const seen = new Set<string>();
  let current: HeadingKind | 'UNSECTIONED' = 'UNSECTIONED';
  let hasRequirementsSection = false;
  let hasResponsibilitiesSection = false;

  const push = (item: PostingItem) => {
    if (items.length >= MAX_POSTING_ITEMS) return;
    const key = normalizeForDedupe(item.text);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  let cursor = 0;
  for (const rawWithCr of description.split('\n')) {
    const lineStart = cursor;
    cursor += rawWithCr.length + 1;
    const raw = rawWithCr.replace(/\r$/, '');
    if (raw.trim().length === 0) continue;

    // A whole line that is a heading ("Requirements", "**What you bring**:").
    const lineHeading = classifyHeading(raw);
    const units: Unit[] = lineHeading
      ? [{ text: '', start: lineStart, bulleted: false, heading: lineHeading }]
      : splitLine(raw, lineStart);

    for (const unit of units) {
      if (unit.heading) {
        current = unit.heading;
        if (unit.heading === 'REQUIREMENTS') hasRequirementsSection = true;
        if (unit.heading === 'RESPONSIBILITIES' || unit.heading === 'INTRO') hasResponsibilitiesSection = true;
        continue;
      }
      if (current === 'OTHER') continue;

      // Bullets under an intro heading are the role's duties; its prose is background.
      const section: PostingSection = current === 'INTRO' ? 'RESPONSIBILITIES' : current;
      const marker = unit.text.match(BULLET_MARKER);
      const markerLength = unit.bulleted ? 0 : marker ? marker[0].length : 0;
      const bulleted = unit.bulleted || Boolean(marker);
      const body = unit.text.slice(markerLength);

      if (bulleted) {
        const text = body.trim();
        if (text.length < MIN_BULLET_CHARS || text.length > MAX_ITEM_CHARS * 2) continue;
        const start = unit.start + markerLength + (body.match(/^\s*/)?.[0].length ?? 0);
        push({ text, start, end: start + text.length, section, bulleted: true });
        continue;
      }

      // Plain text counts inside a recognised section. Before any heading only sentences that
      // read like a requirement count; intro prose is background.
      if (current === 'INTRO') continue;
      if (/:\s*$/.test(unit.text.trim())) continue;
      pushSentences(unit.text, unit.start, section, push, section === 'UNSECTIONED');
    }
  }

  return { items, hasRequirementsSection, hasResponsibilitiesSection };
}
