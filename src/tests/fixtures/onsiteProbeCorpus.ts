/**
 * Synthetic work-mode probe lines for the on-site statement rules (PR #177
 * review rounds 1-3). Each entry is one line appended to a short technical
 * description; `location` is the job location the probe runs with. Used by
 * `workplacePerkPhrases.test.ts` and by the differential sweep against main.
 */

export interface OnsiteProbe {
  readonly line: string;
  readonly location: string;
}

const sg = (line: string): OnsiteProbe => ({ line, location: "Singapore" });

/** R1: a perk after a separator or a label (neutral). */
export const SEPARATOR_OR_LABEL_PERKS: readonly string[] = [
  "Location: On-site Parking available",
  "Workplace type: Onsite Perks: free lunch",
  "Full-time · On-site Free parking",
  "Position: On-site Parking available",
  "Benefits:\n· On-site gym",
  "What we offer\n· Onsite gym\n· Free snacks",
  "Perks · On-site gym · Free snacks",
  "Free lunch · On-site gym",
  "Benefits | Onsite gym",
  "· On-site childcare",
  "Location: On-site gym available",
  "• On-site cafeteria",
];

/** R2-R6 and the main-branch false rejects the reviewer listed (never on-site). */
export const ROUND_3_NOT_ONSITE: readonly OnsiteProbe[] = [
  // R2: negated, hedged or temporary 4+ day mentions
  sg("You don't need to be on-site every day."),
  sg("There is no need to be on-site every day."),
  sg("You won't have to be on-site 5 days a week."),
  sg("You need not be on-site 5 days a week."),
  sg("You will not be on-site daily."),
  sg("We don't require you to be on-site daily."),
  sg("Employees may need to be on-site daily during onboarding."),
  sg("You might be asked to be on-site every day during the first week."),
  sg("During your first week you will be on-site daily for onboarding."),
  { line: "Fully remote. You may occasionally need to be on-site for workshops, but there is no need to be on-site every day.", location: "Remote" },
  { line: "This is a remote-first role; no need to be on-site every day.", location: "Remote" },
  // R3: negated or hedged must/required to be on-site
  sg("You are not required to be on-site."),
  sg("Not required to be onsite."),
  sg("You may be required to be on-site occasionally."),
  sg("You may be required to be on-site for client meetings from time to time."),
  // R4: label answers of No / not required
  sg("On-site: No"),
  sg("On-site required: No"),
  sg("Onsite presence: not required"),
  // R5: lists of work-mode options
  sg("We support remote, on-site, and hybrid working."),
  sg("We offer hybrid, on-site, or remote arrangements."),
  sg("Choose remote, on-site, or hybrid."),
  sg("Work arrangements: on-site, hybrid or remote depending on the team."),
  sg("Work mode: On-site / Hybrid"),
  sg("Hybrid | On-site"),
  // R6: 1-3 days in words or ranges
  sg("On-site, three days per week"),
  sg("You must be on-site three days a week."),
  sg("Location: On-site, two days a week"),
  sg("Work on-site at our Singapore office two days a week."),
  sg("On-site one to three days a week."),
  sg("On-site 1-3 days a week."),
  // Main-branch false rejects (negated or hedged verb forms)
  sg("Work on-site is not required."),
  sg("You do not have to work on-site."),
  sg("Occasionally work on-site at client premises."),
  sg("Some travel and the ability to work on-site when needed."),
];

/** Earlier-round inputs and the reviewer's false accepts (non-blocking), for the differential sweep. */
export const OTHER_REVIEW_PROBES: readonly OnsiteProbe[] = [
  ...[
    "On-site training provided.", "• On-site training provided", "On-site client support as required.",
    "· On-site training provided", "| On-site training", "Location: On-site training provided",
    "· On-site coaching provided", "| On-site mentoring", "Work model: On-site learning budget",
    "• On-site surveys of client sites", "Work model: On-site, 2 days a week", "Workplace: On-site, 2 days a week",
    "Workplace type: Onsite, 3 days per week", "You'll be on-site with clients 4 days a week",
    "On-site 2-3 days a week", "On-site 2 to 3 days a week", "On-site at least 3 days a week",
    "Location: On-site 2x per week", "This role is on-site, 3 days a week",
    "You will work on-site with clients 2 days a week", "This role is on-site, 5 days a week",
    "This role is on site in Singapore.", "Location: On site", "Full-time · On site", "On site, Singapore",
    "You must be on site every day.", "In-office 5 days a week.", "In office five days a week.",
    "Work from office 5 days a week.", "WFO 5 days a week.", "This is a 100% in-office role.", "Fully in-office role.",
    "On-site five days a week.", "You'll be on-site with clients four days a week.", "On-site Monday to Friday.",
    "The role will be office-based in Singapore.", "Office-based, Singapore.", "Location: Office-based",
    "Location: On-site, 4 days a week with 1 day remote", "Experience with remote sensing.\nThis is an on-site role.",
    "Not a remote role. On-site in our Singapore office.",
    "5 days on-site meals provided", "Work 5 days in office free lunch daily", "5 days per week onsite canteen access",
    "This role is on-site facilities based", "Work on-site facilities daily", "Perks: onsite gym",
    "Perks: on-site cafe, onsite parking and an on-site wellness room.", "This position is fully onsite. Perks include an onsite gym.",
    "Hybrid working, 2 days per week in the office.\nBenefits:\n• Onsite gym\n• Free lunch",
    "This role is on-site.", "On-site, facilities based.", "Work on-site at our facilities daily.", "This is an on-site role.",
    "You will be based on-site at our Jurong campus.", "You must be on-site.", "This is an office-based role.",
    "5 days in office.", "Fully on-site.", "Location: On-site", "Engineering | Onsite | Full-time",
    "You must be on-site 2 days a week.", "Hybrid role. This is an on-site role during onboarding.",
    "Workplace and information technology positions may require onsite attendance 5 days per week as will be indicated in the job posting.",
    "You may be on-site 5 days a week during launches.",
  ].map(sg),
  ...["This is an on-site role.", "You'll be on-site with clients 4 days a week.", "Location: On-site", "Work on-site is not required."]
    .map((line) => ({ line, location: "London, United Kingdom" })),
];

/** On-site forms for the property sweep: each takes the text that follows the token. */
export const SWEEP_FORMS: ReadonlyArray<(rest: string) => string> = [
  (x) => `Full-time · On-site${x}`,
  (x) => `Engineering | On-site${x}`,
  (x) => `Location: On-site${x}`,
  (x) => `Work model: On-site${x}`,
  (x) => `• On-site${x}`,
  (x) => `On-site${x}`,
  (x) => `This role is on-site${x}`,
  (x) => `You must be on-site${x}`,
  (x) => `This is an on-site role${x}`,
  (x) => `This is an office-based role${x}`,
];
export const SWEEP_NOUN_FORMS = SWEEP_FORMS.slice(0, 8);
export const SWEEP_NOUNS: readonly string[] = [
  "training", "support", "client support", "visits", "meetings", "events", "interviews",
  "orientation", "induction", "onboarding", "services", "assistance", "installations",
  "inspections", "audits", "assessments", "deployments", "maintenance", "troubleshooting",
  "demos", "workshops", "sessions", "activities",
];
/**
 * Workplace perks are neutral after a separator, a label or a bullet (the six
 * value forms). After "role is" / "must be" the statement stands and the perk
 * is ignored ("This role is on-site facilities based" rejects).
 */
export const SWEEP_VALUE_FORMS = SWEEP_FORMS.slice(0, 6);
export const SWEEP_PERKS: readonly string[] = ["gym", "cafeteria", "parking", "childcare", "free parking", "canteen"];
export const SWEEP_PARTIAL_DAYS: readonly string[] = ["1 day a week", "2 days", "3 days a week", "1-3 days per week", "two days a week", "three days", "one to three days a week"];
export const SWEEP_FULL_DAYS: readonly string[] = ["4 days a week", "5 days a week", "daily"];
export const SWEEP_NEGATIONS: ReadonlyArray<(statement: string) => string> = [
  (s) => `${s}: No`,
  (s) => `${s} is not required`,
  (s) => `It is optional: ${s}`,
  (s) => `During onboarding only. ${s} during the first week`,
  (s) => `You may occasionally see "${s}" for some events`,
];

/** Every sweep line, for the differential sweep. */
export function sweepProbes(): OnsiteProbe[] {
  const lines: string[] = [];
  for (const formAt of SWEEP_NOUN_FORMS) {
    for (const noun of SWEEP_NOUNS) {
      for (const days of ["", ", 2 days", ", 5 days a week"]) lines.push(formAt(` ${noun} provided${days}`));
    }
  }
  for (const formAt of SWEEP_VALUE_FORMS) {
    for (const perk of SWEEP_PERKS) {
      for (const days of ["", ", 2 days", ", 5 days a week"]) lines.push(formAt(` ${perk} available${days}`));
    }
  }
  for (const formAt of SWEEP_FORMS) {
    for (const days of SWEEP_PARTIAL_DAYS) lines.push(formAt(`, ${days}`));
    for (const days of ["", ...SWEEP_FULL_DAYS.map((d) => `, ${d}`)]) lines.push(formAt(days));
    for (const negate of SWEEP_NEGATIONS) lines.push(negate(formAt("")));
  }
  return lines.map(sg);
}

const everywhere = (line: string): OnsiteProbe[] =>
  ["Singapore", "Remote", "London, United Kingdom"].map((location) => ({ line, location }));

/**
 * Review round 4 (N1-N4): never on-site in any path, including stored REMOTE
 * and a Remote or London location. N1 lines describe things, N4 lines other
 * staff; N2 is partial attendance; N3 a temporary project phase.
 */
export const ROUND_4_NOT_ONSITE: readonly OnsiteProbe[] = [
  // N1
  ...[
    "Parking is located on-site.",
    "Our data centre is located onsite.",
    "The lab equipment is located onsite.",
    "Backups are stored offsite; the primary database is located on-site.",
    "Our solution is deployed and located on-site at customer premises.",
    "Our platform works on-site and in the cloud.",
    "The software works onsite or in the cloud.",
    "Our servers are located on-site and backed up daily.",
  ].flatMap(everywhere),
  // N2
  sg("On-site 60% of the time."),
  sg("On-site 50% of the time."),
  sg("On-site 3 out of 5 days."),
  sg("On-site half the week."),
  // N3
  sg("Be on-site daily during the go-live period."),
  sg("You will be on-site daily for the duration of the audit."),
  sg("Be on-site for go-live support daily during cutover."),
  sg("You will be on-site daily during the implementation phase."),
  sg("Expect to be on-site every day during hypercare."),
  // N4
  sg("Our nurses work on-site every day, while this analytics role is flexible."),
  sg("The data team supports clinicians who work on-site 5 days a week."),
  sg("Members of our operations team work onsite daily."),
  sg("Field engineers work onsite daily at client sites across the region."),
  sg("Experience managing work on-site at manufacturing plants."),
];

/**
 * Review round 4 (negation scope and the posting-wide skip): affirmative
 * on-site statements that main rejects. Expected HARD_REJECT through
 * enrich-then-gate and with stored UNKNOWN / ASSUMED_HYBRID (Singapore).
 */
export const ROUND_4_ONSITE: readonly string[] = [
  "This role is on-site and not eligible for remote work.",
  "No hybrid, no remote: this role is on-site.",
  "You will work on-site 5 days a week, no exceptions.",
  "This role is on-site at our Singapore office, five days a week, with no flexibility.",
  "Location: On-site (no remote option)",
  "Full-time · On-site · No visa sponsorship",
  "This position is onsite in Singapore and is not eligible for visa sponsorship.",
  "This role is on-site in Singapore with no relocation support.",
  "This is an on-site role and you will not be eligible for relocation.",
  "This role is on-site so you can collaborate closely with the team.",
  "This role is on-site and cannot be done remotely.",
  "You must be on-site; WFH is not available.",
  "This is a full-time on-site role in Singapore. We welcome everyone, whether they work on-site, hybrid or remotely.",
  "You must be on-site.\nOur company was founded as a remote-first startup in 2015.",
  "Not a remote role. This is an on-site role.",
  "This is not a remote role. You must be on-site.",
  "Remote work is not offered. This is an on-site role.",
  "This is an on-site role.\nExperience building remote patient monitoring systems.",
  "This is an on-site role; no remote work.",
  "This is an on-site role. No remote work.",
  "On-site only, not hybrid.",
  "No hybrid — fully on-site.",
  "100% on-site.",
  "Fully on-site, no remote.",
  "On-premises only, no remote work.",
];

/** Enrichment of a 4+ day statement with a remote day stores the on-site days. */
export const ROUND_4_OFFICE_DAYS: ReadonlyArray<readonly [string, number]> = [
  ["On-site 4 days a week, 1 day WFH.", 4],
  ["On-site, 4 days a week with 1 day remote.", 4],
];

/**
 * Known false accepts (non-blocking): genuine on-site postings the rules do not
 * reject; they stay PASS or NEEDS_VERIFICATION, never a wrongful reject. A
 * company fact naming remote/hybrid teams still counts as the posting offering
 * those modes, and the remaining forms are not read.
 */
export const KNOWN_FALSE_ACCEPTS: readonly OnsiteProbe[] = [
  sg("This is an on-site role.\nWe are an equal opportunity employer. Our remote and hybrid teams thrive together."),
  sg("This role is on site in Singapore."),
  sg("Location: On site"),
  sg("In-office 5 days a week."),
  sg("WFO 5 days a week."),
  sg("On-site Monday to Friday."),
  sg("The role will be office-based in Singapore."),
];
