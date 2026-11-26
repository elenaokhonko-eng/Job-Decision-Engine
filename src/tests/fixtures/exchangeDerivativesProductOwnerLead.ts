// Invented stand-in for a technical product owner lead posting pasted from a job site.
// The wording is invented; the layout is the pasted one: line breaks lost in the opening paragraphs
// (runs of spaces instead), the first section heading run into its first sub-heading, sub-headings
// between bullets, blank separator lines that hold a space, "Label. Sentence" requirement bullets,
// and a closing section that is not a requirement.
export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_RESPONSIBILITIES = [
  "Study how the booking engine works from end to end and feed that knowledge into the technology plan.",
  "Pick a headline measure with the operations lead and check that the engineers can actually record it.",
  "Turn open problems into stories and acceptance checks that internal squads and suppliers can build from.",
  "Co-own the release plan with the operations lead and revisit it whenever port rules or neighbouring systems change.",
  "Order incoming work by weighing user pain, revenue, legal deadlines and build effort.",
  "Check that supplier release calendars line up with what the terminal operator intends to ship.",
  "Report direction, figures and progress to colleagues and outside partners in plain language.",
  "Broker agreement when priorities clash and be candid about what is still unknown.",
  "Stand beside the team when a partner conversation turns difficult.",
  "Try ideas with AI assistants before asking engineers to commit time.",
  "Keep learning from users through site visits, mock-up trials and log reviews.",
  "Lay out choices such as buying or building, then push for a decision.",
  "Recruit and coach a small group of product owners and designers.",
  "Help squads move faster by explaining the trade and what the platform can already do.",
  "Describe where the product should be in three years and keep people interested in getting there.",
  "Protect time for reliability work on the systems that the harbour cannot run without.",
];

export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_REQUIREMENTS = [
  "Experience. 10+ years across product, analysis or engineering roles that carried real delivery ownership.",
  "Leadership. You have steered sizeable products and the squads behind them",
  "Domain expertise. Time spent with ports, shipping lines, freight booking or customs systems is a strong plus; other logistics work also counts.",
  "Technical fluency. Comfortable reading source, questioning an interface design and joining architecture debates.",
  "AI-native working. You already draft, mock up and check your thinking with AI assistants.",
  "Product judgement. You frame problems crisply, cut scope when needed and act on evidence despite gaps.",
  "Communication. You can bring operational and engineering people round at any level.",
  "Builder mindset. Happy to work while ways of working are still taking shape.",
  "Comfort with complexity. Working under heavy regulation with many interested parties is a plus.",
];

const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15, r16] = EXCHANGE_DERIVATIVES_PRODUCT_OWNER_RESPONSIBILITIES;
const bullets = (lines: string[]) => lines.flatMap((line) => [line, " "]);

export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_DESCRIPTION = [
  "WE MOVE CARGO. A terminal operator that writes its own booking software.   The opportunity We need someone to head the product owners for berth booking. You will help them turn user pain into measured results, and you will not be shipping code yourself.   The product owner team The group connects operational needs with delivery by engineers, analysts and suppliers.   This is a joint role with operations and engineering.   What you will do Product Analysis and Shaping  ",
  ...bullets([r1, r2, r3]),
  "  Roadmap and Prioritisation  ",
  ...bullets([r4, r5, r6]),
  "  Stakeholder Management  ",
  ...bullets([r7, r8, r9]),
  "  Ways of Working  ",
  ...bullets([r10, r11, r12]),
  "  Leadership  ",
  ...bullets([r13, r14, r15, r16]),
  "    What we are looking for  ",
  ...bullets(EXCHANGE_DERIVATIVES_PRODUCT_OWNER_REQUIREMENTS),
  "    Why this role matters  ",
  "These systems underpin harbour operations that others depend on, so choices made here are felt quickly.",
  " ",
  "The job is wider than a ticket queue: you will influence which problems get picked and how success is judged.",
].join("\n");
