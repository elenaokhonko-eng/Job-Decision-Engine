// Anonymised stand-in for a derivatives technical product owner lead posting pasted from a job site.
// The wording is invented; the layout is the pasted one: line breaks lost in the opening paragraphs
// (runs of spaces instead), the first section heading run into its first sub-heading, sub-headings
// between bullets, blank separator lines that hold a space, "Label. Sentence" requirement bullets,
// and a closing section that is not a requirement. The real posting is not copied into the repository.
export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_RESPONSIBILITIES = [
  "Learn the domain's products in depth, including features, user journeys, architecture and data flows, and contribute to the technology roadmap.",
  "Agree the guiding metric and supporting indicators with the business lead and make sure engineering can observe them.",
  "Write the requirements, user stories and acceptance criteria that engineering teams and vendors need to deliver.",
  "Share ownership of the product roadmap with the business lead and keep it aligned with members, regulation and adjacent products.",
  "Rank features by evidence of member impact, business value, regulatory need and technical feasibility.",
  "Work with software vendors so their roadmaps support the exchange's plans.",
  "Explain product direction, metrics and progress to internal and external stakeholders at every level.",
  "Build agreement on priorities and trade-offs and set expectations about uncertainty in product work.",
  "Support the team through demanding stakeholder situations.",
  "Use AI agents to speed up discovery, prototyping and specification before engineering time is committed.",
  "Run continuous discovery through member interviews, prototype tests and usage analysis.",
  "State trade-offs openly, such as build versus buy, and drive the decisions they need.",
  "Hire and lead a team of technical product owners and designers.",
  "Raise the team's productivity through a deep understanding of the market and platform capabilities.",
  "Set the product vision for the domain and keep the team engaged with it.",
  "Keep the team focused on resilience and stability of critical market systems.",
];

export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_REQUIREMENTS = [
  "Experience. 10+ years in product management, product ownership, business analysis or engineering with real product responsibility.",
  "Leadership. A record of leading large, complex products and the teams that build them",
  "Domain expertise. Background in market infrastructure such as exchanges, clearing, derivatives or trading platforms is a strong plus; wider financial services experience also counts.",
  "Technical fluency. Able to read code, reason about interfaces and data flows, and hold a position in architecture discussions.",
  "AI-native working. Hands-on use of AI agents to prototype, specify and validate, beyond summarising documents.",
  "Product judgement. Sharp problem framing, firm on scope, guided by data and comfortable deciding under ambiguity.",
  "Communication. Able to influence business and technology teams across levels of seniority.",
  "Builder mindset. Comfortable where product and delivery practices are still being formed.",
  "Comfort with complexity. Delivery in regulated environments with many stakeholders is a plus.",
];

const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15, r16] = EXCHANGE_DERIVATIVES_PRODUCT_OWNER_RESPONSIBILITIES;
const bullets = (lines: string[]) => lines.flatMap((line) => [line, " "]);

export const EXCHANGE_DERIVATIVES_PRODUCT_OWNER_DESCRIPTION = [
  "WE RUN MARKETS. An exchange group building its trading platforms in-house.   The opportunity We are hiring a lead for the derivatives product owner team. You will guide the team in turning member problems into measurable outcomes, without writing production code.   The product owner team The team links business problems with technical delivery across product, engineering, data and vendors.   This is a partnership role with business and engineering.   What you will do Product Analysis and Shaping  ",
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
  "The platforms sit inside critical market infrastructure, where product decisions have direct consequences for members.",
  " ",
  "The mandate goes beyond a backlog: you will shape how problems are framed and how outcomes are measured.",
].join("\n");
