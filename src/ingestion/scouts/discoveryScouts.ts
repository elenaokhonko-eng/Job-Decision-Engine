/**
 * Outbound Discovery Scouts (Stage 0)
 * Generates verified search queries, domain watchlists, and crawl plans for the 6 career lanes.
 * Invariant: Scouts NEVER fabricate jobs, salaries, or fake postings.
 */

export interface ScoutSearchPlan {
  lane: string;
  targetKeywords: string[];
  targetCompanies: string[];
  targetFeeds: string[];
  searchQueries: string[];
  plannedAt: string;
}

export class DiscoveryScoutPlanner {
  generateSearchPlans(): Record<string, ScoutSearchPlan> {
    const timestamp = new Date().toISOString();

    return {
      CORE_AI_DATA: {
        lane: "CORE_AI_DATA",
        targetKeywords: ["AI Systems Engineer", "LLM Infrastructure", "Distributed Systems Architect", "Databricks", "PyTorch"],
        targetCompanies: ["Databricks", "Anthropic", "Cohere", "OpenAI", "AWS", "Google Cloud", "Snowflake"],
        targetFeeds: ["Greenhouse", "Ashby", "Lever", "Himalayas"],
        searchQueries: [
          "site:boards.greenhouse.io ('AI Systems' OR 'LLM' OR 'Solutions Architect') ('Singapore' OR 'Remote')",
          "site:jobs.lever.co ('AI Engineer' OR 'Machine Learning Infrastructure') ('Singapore' OR 'Remote')",
          "site:api.ashbyhq.com ('AI' OR 'GenAI Architect') ('Singapore' OR 'Remote')"
        ],
        plannedAt: timestamp
      },
      LEGAL_REGTECH: {
        lane: "LEGAL_REGTECH",
        targetKeywords: ["Legal AI", "RegTech", "Regulatory Compliance Solutions", "Contract Analytics"],
        targetCompanies: ["Robin AI", "Harvey", "Ironclad", "Thomson Reuters", "LexisNexis"],
        targetFeeds: ["Greenhouse", "Ashby", "Lever"],
        searchQueries: [
          "site:boards.greenhouse.io ('Legal AI' OR 'RegTech' OR 'Contract Automation') ('Singapore' OR 'Remote')",
          "site:jobs.lever.co ('Compliance Technology' OR 'Legal Engineer') ('Singapore' OR 'Remote')"
        ],
        plannedAt: timestamp
      },
      HEALTH_BIO_PHARMA: {
        lane: "HEALTH_BIO_PHARMA",
        targetKeywords: ["Bioinformatics AI", "Genomics ML", "Drug Discovery", "Computational Biology"],
        targetCompanies: ["Insilico Medicine", "Recursion", "Schrodinger", "Illumina", "AstraZeneca"],
        targetFeeds: ["Greenhouse", "Ashby", "Lever"],
        searchQueries: [
          "site:boards.greenhouse.io ('Computational Biology' OR 'Bioinformatics' OR 'Genomics AI') ('Singapore' OR 'Remote')",
          "site:jobs.lever.co ('Biomedical Data Science' OR 'Pharma ML') ('Singapore' OR 'Remote')"
        ],
        plannedAt: timestamp
      },
      INVESTMENT_MARKETS_FINTECH: {
        lane: "INVESTMENT_MARKETS_FINTECH",
        targetKeywords: ["Quantitative Systems Architect", "Market Data Engineering", "Trading Technology", "Asset Management Fintech"],
        targetCompanies: ["Standard Chartered", "GIC", "Temasek", "Point72", "Two Sigma", "Jump Trading"],
        targetFeeds: ["Greenhouse", "Lever", "Direct ATS"],
        searchQueries: [
          "site:boards.greenhouse.io ('Quantitative Architect' OR 'Market Data' OR 'Trading Systems') ('Singapore' OR 'Remote')",
          "site:jobs.lever.co ('Fintech Platform' OR 'Capital Markets Engineering') ('Singapore' OR 'Remote')"
        ],
        plannedAt: timestamp
      },
      SOCIAL_IMPACT_MULTILATERAL: {
        lane: "SOCIAL_IMPACT_MULTILATERAL",
        targetKeywords: ["Digital Public Infrastructure", "Humanitarian Technology", "Climate Data Platform", "Multilateral AI"],
        targetCompanies: ["World Bank", "UNDP", "UNICEF", "IFC", "Global Green Growth Institute"],
        targetFeeds: ["Greenhouse", "Ashby", "Lever", "Himalayas"],
        searchQueries: [
          "site:boards.greenhouse.io ('digital public infrastructure' OR 'humanitarian technology' OR 'climate data') ('Singapore' OR 'Remote')",
          "site:jobs.lever.co ('multilateral AI' OR 'development data platform' OR 'technical programme') ('Singapore' OR 'Remote')"
        ],
        plannedAt: timestamp
      },
      UNIVERSITY_AI_RESEARCH: {
        lane: "UNIVERSITY_AI_RESEARCH",
        targetKeywords: ["University AI Research", "Research Software Engineer", "Scientific Computing", "Responsible AI"],
        targetCompanies: ["A*STAR", "National University of Singapore", "Nanyang Technological University", "Oxford", "Cambridge"],
        targetFeeds: ["Greenhouse", "Ashby", "Lever", "Himalayas"],
        searchQueries: [
          "site:boards.greenhouse.io ('research software engineer' OR 'university AI' OR 'scientific computing') ('Singapore' OR 'Remote')",
          "site:jobs.lever.co ('machine learning research' OR 'responsible AI' OR 'research engineer') ('Singapore' OR 'Remote')"
        ],
        plannedAt: timestamp
      }
    };
  }
}
