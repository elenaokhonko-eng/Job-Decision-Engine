/**
 * An invented data-science posting with the shapes the parser must handle: question headings, narrative
 * paragraphs about the team, nine qualification bullets and an office-attendance line.
 */
export const INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS = [
  "A degree that taught you to reason from messy field observations",
  "At least 3 years spent shipping machine learning systems that people rely on",
  "Comfort writing R or Julia that another person can rerun a year later",
  "A habit of recording where each dataset came from and who may use it",
  "Some practice with satellite imagery or acoustic recordings",
  "Able to tell a warden what a forecast does and does not show",
  "Curiosity about how birds, weather and land use affect one another",
  "Care in designing surveys so that a small sample is still honest",
  "Willing to be corrected by people who walk the marshes every week",
];

export const INVESTMENT_DATA_SCIENTIST_NARRATIVE = [
  "You will be part of a five-person field science unit that counts migrating shorebirds.",
  "As the charity's evidence desk, the unit checks every count before it is published.",
];

export const INVESTMENT_DATA_SCIENTIST_DESCRIPTION = [
  "Who are we?",
  "Example Fund pays for wetland restoration along a long coastline.",
  INVESTMENT_DATA_SCIENTIST_NARRATIVE[1],
  "",
  "What will you do?",
  INVESTMENT_DATA_SCIENTIST_NARRATIVE[0],
  "- Forecast roosting numbers ahead of each tide season",
  "- Replace the wardens' spreadsheets with one checked dataset",
  "- Publish a plain note whenever a model changes",
  "",
  "What qualifications would a good applicant bring to this survey work?",
  ...INVESTMENT_DATA_SCIENTIST_QUALIFICATIONS.map((line) => `- ${line}`),
  "",
  "What can we offer?",
  "- Binoculars, boots and a training budget",
  "- Be in the office two days a week; the rest is yours to arrange",
].join("\n");
