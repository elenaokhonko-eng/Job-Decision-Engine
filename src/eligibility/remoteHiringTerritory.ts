import type { DiscoveryLocationScope } from "../ingestion/discoveryLocationScope.js";
import { extractTerritories, isTerritoryAuthorized, normalizeTerritories } from "../pipeline/workabilityPolicy.js";

/**
 * Hiring territory of remote postings.
 *
 * The general gate treats a remote posting's location as the employer's office, which is right
 * for an employer ATS but wrong for remote-job boards: Jobicy's `jobGeo`, Remotive's
 * `candidate_required_location` and We Work Remotely's region name where the candidate must
 * live. Remote postings also often state their territory only in the description ("Remote -
 * Canada", a pay range "within any geographic market in Canada"). This module reads both.
 *
 * A clear foreign territory is a deterministic workability conflict (hard reject with the quoted
 * evidence). A weak or contradicted signal is NEEDS_VERIFICATION, never a guessed rejection.
 */

export const REMOTE_TERRITORY_GATE_VERSION = "remote_hiring_territory_v1";
export const REMOTE_TERRITORY_REJECT_CODE = "GATE_REMOTE_TERRITORY_RESTRICTED";
export const REMOTE_TERRITORY_VERIFY_CODE = "NEEDS_VERIFICATION_HIRING_TERRITORY";

/** Sources whose location field is the candidate's required region, not an office. */
export const CANDIDATE_REGION_SOURCES: ReadonlySet<string> = new Set(["JOBICY", "HIMALAYAS", "REMOTIVE", "WE_WORK_REMOTELY"]);

/** Regions and countries the shared territory table does not list. */
const EXTRA_FOREIGN_TERMS: ReadonlyArray<[string, string]> = [
  ["emea", "EMEA"], ["europe", "EUROPE"], ["eu", "EUROPE"], ["latam", "LATIN_AMERICA"], ["latin america", "LATIN_AMERICA"],
  ["south america", "LATIN_AMERICA"], ["central america", "LATIN_AMERICA"], ["north america", "NORTH_AMERICA"],
  ["northern america", "NORTH_AMERICA"], ["americas", "AMERICAS"], ["africa", "AFRICA"], ["middle east", "MIDDLE_EAST"],
  ["mena", "MIDDLE_EAST"], ["nordics", "EUROPE"], ["dach", "EUROPE"], ["benelux", "EUROPE"], ["cee", "EUROPE"],
  ["eastern europe", "EUROPE"], ["western europe", "EUROPE"], ["bulgaria", "BULGARIA"], ["hungary", "HUNGARY"],
  ["turkiye", "TURKIYE"], ["turkey", "TURKIYE"], ["ukraine", "UKRAINE"], ["costa rica", "COSTA_RICA"], ["serbia", "SERBIA"],
  ["cyprus", "CYPRUS"], ["slovakia", "SLOVAKIA"], ["estonia", "ESTONIA"], ["latvia", "LATVIA"], ["lithuania", "LITHUANIA"],
  ["croatia", "CROATIA"], ["slovenia", "SLOVENIA"], ["iceland", "ICELAND"], ["peru", "PERU"], ["uruguay", "URUGUAY"],
  ["nigeria", "NIGERIA"], ["kenya", "KENYA"], ["egypt", "EGYPT"], ["pakistan", "PAKISTAN"], ["usa only", "UNITED_STATES"],
];

/** Two-letter codes, accepted only directly after "Remote -" / "Remote (" where they cannot be words. */
const COUNTRY_CODES: Readonly<Record<string, string>> = {
  us: "UNITED_STATES", usa: "UNITED_STATES", ca: "CANADA", mx: "MEXICO", uk: "UNITED_KINGDOM", gb: "UNITED_KINGDOM",
  de: "GERMANY", fr: "FRANCE", es: "SPAIN", it: "ITALY", nl: "NETHERLANDS", pl: "POLAND", pt: "PORTUGAL",
  br: "BRAZIL", ar: "ARGENTINA", co: "COLOMBIA", cl: "CHILE", in: "INDIA", ph: "PHILIPPINES", au: "AUSTRALIA",
  nz: "NEW_ZEALAND", ie: "IRELAND", jp: "JAPAN", cn: "CHINA", hk: "HONG_KONG", sg: "SINGAPORE",
};

export type RemoteTerritoryStatus = "NOT_APPLICABLE" | "UNRESTRICTED" | "RESTRICTED_FOREIGN" | "UNCLEAR";

export interface TerritorySignal {
  readonly source: "BOARD_REGION" | "DESCRIPTION";
  readonly strength: "STRONG" | "WEAK";
  readonly territories: readonly string[];
  readonly evidence: string;
}

export interface RemoteTerritoryAssessment {
  readonly status: RemoteTerritoryStatus;
  readonly territories: readonly string[];
  readonly signals: readonly TerritorySignal[];
  readonly counterEvidence: readonly string[];
  readonly rationale: string;
}

export interface RemoteTerritoryInput {
  readonly sourceName: string | null;
  readonly location: string | null;
  readonly workplaceType: string | null;
  readonly description: string | null;
}

export type RemoteTerritoryScope = Pick<
  DiscoveryLocationScope,
  "authorizedRegions" | "inScopeTerms" | "globalTerms" | "remoteTerms" | "remoteFillerTerms" | "unknownLocationTerms"
>;

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

function plainText(value: string | null): string {
  return String(value ?? "")
    .replace(/<\s*(?:br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/[ \t]+/g, " ");
}

/** Territories named in a phrase, using the shared table plus the extra regions above. */
export function territoriesIn(phrase: string, allowCodes = false): string[] {
  const found = new Set(normalizeTerritories(extractTerritories(phrase)));
  const text = normalize(phrase);
  for (const [term, territory] of EXTRA_FOREIGN_TERMS) {
    if (containsTerm(text, term)) found.add(territory);
  }
  if (allowCodes) {
    for (const token of text.split(" ")) {
      const code = COUNTRY_CODES[token];
      if (code) found.add(code);
    }
  }
  return [...found];
}

function isRemotePosting(input: RemoteTerritoryInput): boolean {
  const location = String(input.location ?? "");
  return String(input.workplaceType ?? "").toUpperCase() === "REMOTE"
    || /\b(?:remote|anywhere|worldwide|global)\b/i.test(location)
    || CANDIDATE_REGION_SOURCES.has(String(input.sourceName ?? "").toUpperCase());
}

function inScopeTermIn(text: string, scope: RemoteTerritoryScope): string | null {
  const normalized = normalize(text);
  return scope.inScopeTerms.find((term) => containsTerm(normalized, term)) ?? null;
}

function isForeign(territory: string, scope: RemoteTerritoryScope): boolean {
  return !isTerritoryAuthorized(territory, scope.authorizedRegions);
}

/** Classify a board's candidate-region field. Returns null when it names no territory. */
function boardRegionSignal(location: string, scope: RemoteTerritoryScope): TerritorySignal | "UNRESTRICTED" | null {
  const normalized = normalize(location);
  if (!normalized || scope.unknownLocationTerms.includes(normalized)) return null;
  if (inScopeTermIn(location, scope)) return "UNRESTRICTED";
  if (scope.globalTerms.some((term) => containsTerm(normalized, term))) return "UNRESTRICTED";
  const withoutRemoteWords = normalized
    .split(" ")
    .filter((word) => !scope.remoteTerms.includes(word) && !scope.remoteFillerTerms.includes(word))
    .join(" ");
  if (!withoutRemoteWords) return "UNRESTRICTED";
  const territories = territoriesIn(location);
  if (territories.length === 0) return null;
  return {
    source: "BOARD_REGION",
    strength: "STRONG",
    territories,
    evidence: `Source lists the candidate region as "${location.replace(/\s+/g, " ").trim()}".`,
  };
}

const STRONG_REMOTE_LABEL = /\bremote\s*(?:\(|[-–—:,])\s*([a-z][a-z .]{1,40}?)\s*(?:\)|$|[.,;|\n]|\s{2})/gim;
const STRONG_REMOTE_WITHIN = /\b(?:remote|work remotely|working remotely)\s+(?:only\s+)?(?:within|in|from|across)\s+(?:the\s+)?([a-z][a-z .]{1,40}?)(?=[.,;:)\n]|\s+(?:only|and|or|with|for|who|while|time)\b|$)/gim;
const PAY_ALL_MARKETS = /\b(?:pay|salary|compensation)\b[^.\n]{0,220}?\b(?:any|all|every)\s+(?:geographic\s+)?(?:markets?|locations?|regions?|provinces?|states?)\s+(?:in|within|across)\s+(?:the\s+)?([a-z][a-z .]{1,30}?)(?=[.,;:)\n]|\s+(?:is|are|and|for|may|will)\b|$)/gim;
const HEADQUARTERS_LABEL = /\b(?:headquarters|hq)\s*:\s*([^\n.]{2,60})/gim;
const COUNTRY_BENEFITS = /\b([a-z][a-z ]{1,25}?)\s+benefits\s*:/gim;
const COUNTER_GLOBAL = /\b(?:anywhere in the world|work from anywhere|worldwide|any country|hire (?:anywhere|globally|worldwide)|hiring (?:anywhere|globally|worldwide))\b/gi;
/** A global phrase counts against a territory signal only in a sentence about where people work or are hired. */
const HIRING_CONTEXT = /\b(?:remote|remotely|hire|hiring|hired|work from|location|located|based|candidates?|applicants?|employees?|team members?|live|reside)\b/i;
/** "Remote (US hours)" or "Remote in EMEA time zones" sets working hours, not where the candidate may live. */
const WORKING_HOURS = /\b(?:hours?|time ?zones?|tz|shifts?|overlap)\b/i;

function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(text.lastIndexOf("\n", index), text.lastIndexOf(". ", index)) + 1;
  const stops = [text.indexOf("\n", index + length), text.indexOf(". ", index + length)].filter((value) => value >= 0);
  const end = stops.length > 0 ? Math.min(...stops) : Math.min(text.length, index + length + 160);
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * "Remote - US, Canada, UK, Southeast Asia, and broader APAC" is one list. The label
 * pattern stops at the first comma, so read the rest of the line and treat an
 * in-scope region anywhere in that list as an authorized hiring territory.
 */
function remoteLabelListIncludesScope(text: string, match: RegExpExecArray, scope: RemoteTerritoryScope | null): boolean {
  if (!scope) return false;
  const stops = [text.indexOf("\n", match.index), text.indexOf(". ", match.index), text.indexOf(";", match.index)]
    .filter((value) => value >= 0);
  const line = text.slice(match.index, stops.length > 0 ? Math.min(...stops) : text.length);
  const list = line.replace(/^\s*remote\s*(?:\(|[-–—:,])/i, "");
  return inScopeTermIn(list, scope) !== null;
}

function descriptionSignals(description: string, scope: RemoteTerritoryScope | null = null): { signals: TerritorySignal[]; counter: string[] } {
  const text = plainText(description);
  const signals: TerritorySignal[] = [];
  const counter: string[] = [];
  const add = (strength: TerritorySignal["strength"], phrase: string, match: RegExpExecArray, allowCodes: boolean) => {
    const territories = territoriesIn(phrase, allowCodes);
    if (territories.length === 0) return;
    const following = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const effective = strength === "STRONG" && (WORKING_HOURS.test(phrase) || WORKING_HOURS.test(following.split(/[.,;\n]/)[0] ?? ""))
      ? "WEAK"
      : strength;
    signals.push({ source: "DESCRIPTION", strength: effective, territories, evidence: sentenceAround(text, match.index, match[0].length) });
  };

  // Job boards such as We Work Remotely put the job's location on the "Headquarters:" line, so a
  // value that says "Remote" there is a location label; a plain city or country is the employer's office.
  for (const match of text.matchAll(HEADQUARTERS_LABEL)) {
    add(/\bremote\b/i.test(match[1] ?? "") ? "STRONG" : "WEAK", match[1] ?? "", match as RegExpExecArray, true);
  }
  const headquarterSpans = [...text.matchAll(HEADQUARTERS_LABEL)].map((match) => [match.index, match.index + match[0].length] as const);
  const insideHeadquarters = (index: number) => headquarterSpans.some(([start, end]) => index >= start && index < end);

  for (const match of text.matchAll(STRONG_REMOTE_LABEL)) {
    if (insideHeadquarters(match.index)) continue;
    if (scope && remoteLabelListIncludesScope(text, match as RegExpExecArray, scope)) {
      signals.push({
        source: "DESCRIPTION",
        strength: "STRONG",
        territories: [...scope.authorizedRegions],
        evidence: sentenceAround(text, match.index, match[0].length),
      });
      continue;
    }
    add("STRONG", match[1] ?? "", match as RegExpExecArray, true);
  }
  for (const match of text.matchAll(STRONG_REMOTE_WITHIN)) {
    if (insideHeadquarters(match.index)) continue;
    add("STRONG", match[1] ?? "", match as RegExpExecArray, false);
  }
  for (const match of text.matchAll(PAY_ALL_MARKETS)) add("STRONG", match[1] ?? "", match as RegExpExecArray, false);
  for (const match of text.matchAll(COUNTRY_BENEFITS)) add("WEAK", match[1] ?? "", match as RegExpExecArray, false);

  for (const match of text.matchAll(COUNTER_GLOBAL)) {
    const sentence = sentenceAround(text, match.index, match[0].length);
    // "Work from anywhere in the Americas" names its own territory and is not counter-evidence.
    if (HIRING_CONTEXT.test(sentence) && territoriesIn(sentence).length === 0) {
      counter.push(sentence);
      break;
    }
  }
  return { signals, counter };
}

export function assessRemoteHiringTerritory(input: RemoteTerritoryInput, scope: RemoteTerritoryScope): RemoteTerritoryAssessment {
  const notApplicable = (rationale: string): RemoteTerritoryAssessment => ({
    status: "NOT_APPLICABLE", territories: [], signals: [], counterEvidence: [], rationale,
  });
  if (!isRemotePosting(input)) return notApplicable("Not a remote posting; the location gates apply.");

  const sourceName = String(input.sourceName ?? "").toUpperCase();
  const signals: TerritorySignal[] = [];
  const counterEvidence: string[] = [];

  if (CANDIDATE_REGION_SOURCES.has(sourceName) && input.location) {
    const board = boardRegionSignal(input.location, scope);
    if (board === "UNRESTRICTED") {
      // "Anywhere in the World" is this board's default label, not employer evidence; only an
      // in-scope region (Singapore, APAC) in the board field counts against description signals.
      if (inScopeTermIn(input.location, scope)) {
        return { status: "UNRESTRICTED", territories: [], signals: [], counterEvidence: [input.location], rationale: `Source region "${input.location}" includes an authorized region.` };
      }
    } else if (board) {
      signals.push(board);
    }
  }

  const fromDescription = descriptionSignals(input.description ?? "", scope);
  signals.push(...fromDescription.signals);
  counterEvidence.push(...fromDescription.counter);

  const relevant = signals.filter((signal) => signal.territories.length > 0);
  if (relevant.length === 0) {
    return { status: "UNRESTRICTED", territories: [], signals: [], counterEvidence, rationale: "No hiring-territory restriction is stated." };
  }
  // Any signal naming an authorized region means the posting may hire there.
  const authorizedSignal = relevant.find((signal) => signal.territories.some((territory) => !isForeign(territory, scope)));
  if (authorizedSignal) {
    return { status: "UNRESTRICTED", territories: [], signals: relevant, counterEvidence: [...counterEvidence, authorizedSignal.evidence], rationale: "A stated hiring territory includes an authorized region." };
  }

  const territories = [...new Set(relevant.flatMap((signal) => signal.territories))];
  const strong = relevant.filter((signal) => signal.strength === "STRONG");
  if (strong.length > 0 && counterEvidence.length === 0) {
    return {
      status: "RESTRICTED_FOREIGN",
      territories,
      signals: relevant,
      counterEvidence,
      rationale: `Remote hiring is limited to ${territories.join(", ")}, outside ${scope.authorizedRegions.join(", ")}.`,
    };
  }
  return {
    status: "UNCLEAR",
    territories,
    signals: relevant,
    counterEvidence,
    rationale: strong.length > 0
      ? `The posting names ${territories.join(", ")} but also says it hires more widely; confirm whether Singapore is eligible.`
      : `The posting suggests ${territories.join(", ")} without stating a hiring restriction; confirm whether Singapore is eligible.`,
  };
}
