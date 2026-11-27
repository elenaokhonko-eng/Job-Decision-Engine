// Invented posting for a made-up library consortium. It exercises the pasted-from-a-job-site layout:
// line breaks lost in the opening paragraphs (runs of spaces instead), the first section heading run
// into its first sub-heading, sub-headings between bullets, blank separator lines that hold a space,
// "Label. Sentence" requirement bullets, and a closing section that is not a requirement.
export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_RESPONSIBILITIES = [
  "Shadow desk staff for a fortnight and map how a reservation travels between branches.",
  "Publish a quarterly list of what will change, with the reason for each item.",
  "Write acceptance examples that a volunteer tester could follow unaided.",
  "Agree with the courier firm which parcels the new scanner must recognise.",
  "Retire reports that nobody has opened since last spring.",
  "Keep a visible queue of branch complaints and answer each within ten days.",
  "Rehearse the overnight catalogue sync before every school holiday.",
  "Negotiate shared opening rules among councils that disagree about fines.",
  "Show trustees what the money bought, using branch figures they can check.",
  "Pair a new analyst with a librarian during their first month.",
  "Test screen designs with readers who use large print.",
  "Decide when a supplier's patch is safe to switch on.",
  "Record why an idea was turned down so it is not argued twice.",
  "Walk the sorting room whenever returns start to pile up.",
  "Plan the move off the ageing kiosk software one branch at a time.",
  "Thank the people who report faults and tell them what happened next.",
];

export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_REQUIREMENTS = [
  "Background. Seven or more years shaping software that front-desk staff depend on.",
  "Stewardship. You have answered for a service that could not simply be switched off",
  "Sector knowledge. Time in libraries, archives or postal sorting is a strong plus; any lending service counts.",
  "Data sense. Able to query loan records yourself and spot a figure that cannot be right.",
  "Assistive tools. You already use AI assistants to draft notes and check them with care.",
  "Judgement. You can say no kindly and show the evidence behind it.",
  "Writing. Councillors and shelving volunteers alike understand your updates.",
  "Patience. Content to improve a process in small, steady steps.",
  "Committees. Having worked with elected members is a plus.",
];

const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15, r16] = EXCHANGE_DERIVATIVES_PRODUCT_OWNER_RESPONSIBILITIES;
const bullets = (lines: string[]) => lines.flatMap((line) => [line, " "]);

export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_DESCRIPTION = [
  "WE LEND BOOKS. Nine councils, one catalogue and a van that visits every branch.   The opportunity The kiosks are old and readers wait too long for reservations. We want one person to own what gets fixed first.   This is a shared post between the library service and the digital office.   What you will do Requests and Returns  ",
  ...bullets([r1, r2, r3]),
  "  Branch Services  ",
  ...bullets([r4, r5, r6]),
  "  Councils and Suppliers  ",
  ...bullets([r7, r8, r9]),
  "  People  ",
  ...bullets([r10, r11, r12]),
  "  Housekeeping  ",
  ...bullets([r13, r14, r15, r16]),
  "    About you  ",
  ...bullets(EXCHANGE_DERIVATIVES_PRODUCT_OWNER_REQUIREMENTS),
  "    Why it counts  ",
  "Quiet reading rooms still run on these systems, and a failed sync is noticed by opening time.",
  " ",
  "The post is more than logging faults: you will choose which ones are worth solving.",
].join("\n");
