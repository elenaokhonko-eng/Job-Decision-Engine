/**
 * The employer and location of a job as compared when asking "is this the same posting?". Pure. It is for comparison only:
 * nothing stored is derived from it, and the dedupe keys of src/pipeline/normalize.ts are unchanged.
 */

/**
 * Legal forms dropped from the end of an employer name ("Acme Pte. Ltd." is "Acme"). Descriptor words ("Group", "Holdings",
 * "Technologies", a country) are kept, as are short forms that are also ordinary words ("AB", "SA", "Spa"): they tell
 * employers apart.
 */
const LEGAL_FORMS = new Set([
  "bhd", "bv", "co", "corp", "corporation", "gmbh", "inc", "incorporated", "limited", "llc", "llp", "ltd", "nv", "plc",
  "private", "pte", "pty", "pvt", "sas", "sdn", "srl",
]);

const SINGAPORE = new Set(["singapore", "sg", "sgp", "republic of singapore"]);
const NO_LOCATION = new Set(["", "unknown", "unspecified", "not specified", "not stated", "n a"]);

function words(value: string): string[] {
  return value
    .normalize("NFKD")
    // Accents are dropped from Latin letters only; in other scripts a mark can be what tells two names apart.
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/['’]/g, "")
    // "L.L.C." and "B.V." are one word each.
    .replace(/(?<![\p{L}\p{N}])(\p{L})\.(?=\p{L}(?![\p{L}\p{N}]))/gu, "$1")
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

function employerName(company: string): string {
  const tokens = words(company);
  const length = tokens.length;
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens[tokens.length - 1]!)) tokens.pop();
  // "Smith & Co" leaves a trailing "and".
  if (tokens.length < length && tokens.length > 1 && tokens[tokens.length - 1] === "and") tokens.pop();
  return tokens.join(" ");
}

/** Comma-separated parts, with every way of writing Singapore as one, and a repeated part counted once. */
function locationName(location: string): string {
  const parts = location
    .split(",")
    .map((part) => words(part).join(" "))
    .filter(Boolean)
    .map((part) => (SINGAPORE.has(part) ? "singapore" : part));
  const name = [...new Set(parts)].join(" ");
  return NO_LOCATION.has(name) ? "unknown" : name;
}

export interface JobIdentityNames {
  /** Empty when the name has no letter or digit. */
  employer: string;
  /** "unknown" when no location is stated. */
  location: string;
}

export function normalizeJobIdentity(input: { company: string | null; location: string | null }): JobIdentityNames {
  return { employer: employerName(input.company ?? ""), location: locationName(input.location ?? "") };
}
