import { extractTerritories } from "./workabilityPolicy.js";

/**
 * The job location stated in a posting's own header line ("Job Location: Singapore, SGP",
 * "Location: Guangzhou, CHN"), read only when the structured location is unknown.
 *
 * Employer templates often put several labels on one line once HTML is stripped
 * ("Requisition Number: 123 Job Location: Singapore, SGP Global Grade: D Work Type: ..."),
 * so a value ends at a newline, a separator (| · • ;), a sentence end, 80 characters
 * or the next "Label:". The label
 * words before that colon (title-case words such as "Global Grade") are not part of the
 * value; an upper-case country code ("SGP", "CHN") is. A trailing ISO 3166 alpha-3 code
 * is spelled out so the shared territory table can read it. A value counts only when it
 * names a known territory, so "Location: Remote" or "Location: Flexible" changes nothing.
 * Deterministic and case-sensitive; callers pass the description before lower-casing.
 */

/** Alpha-3 codes seen in employer location templates, spelled as the territory table spells them. */
const ALPHA3_COUNTRIES: Readonly<Record<string, string>> = {
  SGP: "Singapore", CHN: "China", HKG: "Hong Kong", TWN: "Taiwan", IND: "India", MYS: "Malaysia",
  IDN: "Indonesia", PHL: "Philippines", THA: "Thailand", VNM: "Vietnam", JPN: "Japan", KOR: "South Korea",
  AUS: "Australia", NZL: "New Zealand", ARE: "United Arab Emirates", SAU: "Saudi Arabia", QAT: "Qatar",
  ISR: "Israel", ZAF: "South Africa", GBR: "United Kingdom", IRL: "Ireland", DEU: "Germany", FRA: "France",
  ESP: "Spain", ITA: "Italy", NLD: "Netherlands", BEL: "Belgium", CHE: "Switzerland", AUT: "Austria",
  PRT: "Portugal", POL: "Poland", CZE: "Czechia", GRC: "Greece", DNK: "Denmark", SWE: "Sweden",
  NOR: "Norway", FIN: "Finland", ROU: "Romania", USA: "United States", CAN: "Canada", MEX: "Mexico",
  BRA: "Brazil", ARG: "Argentina", CHL: "Chile", COL: "Colombia",
};

/**
 * Only the job's own location labels: "Location:", "Job Location:", "Job Location(s):" and
 * "Work Location:". They count at the start of a line or segment (after a newline, |, ·, •, ;).
 * A compound label ("Headquarters Location:", "Interview location:", "Client Location:",
 * "Office location:") and a "location:" inside a sentence never count.
 */
const LINE_LABEL = /(?:^|[\n|·•;])[ \t]*((?:job|work)[ \t]+locations?|job[ \t]+location\(s\)|locations?)[ \t]*:[ \t]*/gi;
/**
 * In a one-line employer template ("Requisition Number: 123 Job Location: Singapore, SGP
 * Global Grade: D"), the title-case "Job Location:" / "Work Location:" label also counts after
 * an earlier "Label: value" on the same line.
 */
const INLINE_LABEL = /[ \t]((?:Job|Work)[ \t]+Locations?|Job[ \t]+Location\(s\))[ \t]*:[ \t]*/g;
const EARLIER_LABEL = /(?:^|[ \t])[A-Z][A-Za-z]*(?:[ \t]+[A-Z][A-Za-z]*){0,3}[ \t]*:[ \t]*\S/;

interface LabelMatch {
  readonly index: number;
  readonly label: string;
  readonly valueStart: number;
}

function locationLabels(text: string): LabelMatch[] {
  const labels: LabelMatch[] = [];
  for (const match of text.matchAll(LINE_LABEL)) {
    const index = match.index ?? 0;
    labels.push({ index, label: match[1] ?? "Location", valueStart: index + match[0].length });
  }
  for (const match of text.matchAll(INLINE_LABEL)) {
    const index = match.index ?? 0;
    const valueStart = index + match[0].length;
    const lineStart = text.lastIndexOf("\n", index) + 1;
    if (!EARLIER_LABEL.test(text.slice(lineStart, index))) continue;
    if (labels.some((label) => label.valueStart === valueStart)) continue;
    labels.push({ index, label: match[1] ?? "Job Location", valueStart });
  }
  return labels.sort((left, right) => left.index - right.index);
}
/** End of a header value: newline, separator or a sentence end. */
const VALUE_STOP = /[\n|·•;]|\.(?:\s|$)/;
/** Title-case label words right before the next colon ("Global Grade", "Work Type"). */
const TRAILING_LABEL = /(?:[ \t]+[A-Z][a-z]+){1,3}[ \t]*$/;

export interface PostingLocationLine {
  /** The location value as the posting writes it, with any alpha-3 code spelled out. */
  readonly location: string;
  /** The posting's own words, for the gate evidence. */
  readonly quote: string;
}

/** True when a structured location carries no location ("Unknown", "", "N/A", "Not specified"). */
export function isUnknownJobLocation(location: string | null | undefined): boolean {
  return /^(?:unknown|n\/?a|none|not\s+(?:specified|stated|available)|tbd|-+)?$/i.test(String(location ?? "").trim());
}

function readValue(text: string, start: number): string {
  const rest = text.slice(start, start + 80);
  const stop = VALUE_STOP.exec(rest);
  let value = stop ? rest.slice(0, stop.index) : rest;
  const nextColon = value.indexOf(":");
  if (nextColon >= 0) value = value.slice(0, nextColon).replace(TRAILING_LABEL, "");
  return value.replace(/[\s,.\-–—]+$/, "").trim();
}

/** "Guangzhou, CHN" -> "Guangzhou, China"; "Singapore, SGP" -> "Singapore" (the name is already there). */
function spellAlpha3(value: string): string {
  return value
    .replace(/(,?[ \t]*)\b([A-Z]{3})\b/g, (match, separator: string, code: string) => {
      const name = ALPHA3_COUNTRIES[code];
      if (!name) return match;
      return value.toLowerCase().includes(name.toLowerCase()) ? "" : `${separator}${name}`;
    })
    .trim();
}

/**
 * Every "Job Location:" / "Location:" header value in `description` that names a known
 * territory, deduplicated and joined with " / " (alternatives, as a multi-location label
 * reads). Null when there is none.
 */
export function findPostingLocationLine(description: string | null | undefined): PostingLocationLine | null {
  const text = String(description ?? "");
  const values: string[] = [];
  const quotes: string[] = [];
  for (const match of locationLabels(text)) {
    const valueStart = match.valueStart;
    const raw = readValue(text, valueStart);
    if (!raw) continue;
    const location = spellAlpha3(raw);
    if (extractTerritories(location).length === 0) continue;
    if (values.some((existing) => existing.toLowerCase() === location.toLowerCase())) continue;
    values.push(location);
    quotes.push(`${match.label}: ${raw}`.replace(/\s+/g, " ").trim());
    if (values.length >= 3) break;
  }
  if (values.length === 0) return null;
  return { location: values.join(" / "), quote: quotes.join("; ") };
}
