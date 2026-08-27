export interface WorkabilityFacts {
  locationEligibility: "PASS" | "FAIL" | "UNKNOWN";
  officeDays: number | "UNKNOWN";
  travelPercentage: number | "UNKNOWN";
  isContract: boolean | "UNKNOWN";
}

export interface EvaluationRequest {
  canonicalJobId: string;
  jobVersionId: string;
  
  gateDecisionId: string;
  gateVersion: string;

  candidateLanes: Array<{
    lane: string;
    semanticScore: number;
    evidence: string[];
  }>;

  workabilityFacts: WorkabilityFacts;
  unknownFields: string[];

  profileVersion: string;
  evaluationSchemaVersion: string;
}
