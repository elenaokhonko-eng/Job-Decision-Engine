/**
 * An anonymised posting shaped like a sovereign-fund data-science role: question headings, narrative
 * paragraphs about the team, nine qualification bullets and an office-attendance line. The wording
 * is invented; only the structure follows the real posting that the parser misread.
 */
export const INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS = [
  "Degree in statistics, computer science, data science, mathematics or a related quantitative field",
  "At least 3 years of hands-on experience building machine learning models in production",
  "Fluent programming in Python and SQL, with experience of version control and code review",
  "Experience with cloud data platforms and distributed computing frameworks",
  "Understanding of the data used across investment management and experience sourcing and governing such data",
  "Ability to explain model results clearly to portfolio managers and senior stakeholders",
  "Familiarity with natural language processing and large language model applications",
  "Experience designing experiments and evaluating models with sound statistical methods",
  "A collaborative working style and the curiosity to learn new domains quickly",
];

export const INVESTMENT_DATA_SCIENTIST_NARRATIVE = [
  "You will be part of a team of data scientists and engineers who partner with investment groups across the fund.",
  "As the Analytics Centre of Excellence, the team sets standards for how models are built and governed.",
];

export const INVESTMENT_DATA_SCIENTIST_DESCRIPTION = [
  "Who are we?",
  "Example Fund manages a global portfolio across public and private markets.",
  INVESTMENT_DATA_SCIENTIST_NARRATIVE[1],
  "",
  "What will you do?",
  INVESTMENT_DATA_SCIENTIST_NARRATIVE[0],
  "- Build and deploy machine learning models that support investment decisions",
  "- Turn alternative and market data into features that portfolio teams can use",
  "- Work with data engineers to put models into production and monitor them",
  "",
  "What Qualifications or skills should you possess in this role?",
  ...INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS.map((line) => `- ${line}`),
  "",
  "What can we offer?",
  "- Competitive pay and learning budget",
  "- Come into the office four days per week, with flexibility on the fifth",
].join("\n");
