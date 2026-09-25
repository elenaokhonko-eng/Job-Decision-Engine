import type { PoolClient } from "pg";

import type { TestJobFixture } from "./h_work_mode.fixtures.js";

export const ACTIVE_LANE_KEYS = [
  "CORE_AI_DATA",
  "LEGAL_REGTECH",
  "HEALTH_BIO_PHARMA",
  "INVESTMENT_MARKETS_FINTECH",
  "SOCIAL_IMPACT_MULTILATERAL",
  "UNIVERSITY_AI_RESEARCH",
] as const;

export type ActiveLaneKey = (typeof ACTIVE_LANE_KEYS)[number];

const LANE_VECTORS: Readonly<Record<ActiveLaneKey, readonly number[]>> = {
  CORE_AI_DATA: [1, 0, 0, 0, 0, 0],
  LEGAL_REGTECH: [0, 1, 0, 0, 0, 0],
  HEALTH_BIO_PHARMA: [0, 0, 1, 0, 0, 0],
  INVESTMENT_MARKETS_FINTECH: [0, 0, 0, 1, 0, 0],
  SOCIAL_IMPACT_MULTILATERAL: [0, 0, 0, 0, 1, 0],
  UNIVERSITY_AI_RESEARCH: [0, 0, 0, 0, 0, 1],
};

const TEXT_MARKERS: readonly [string, ActiveLaneKey][] = [
  ["mlops", "CORE_AI_DATA"],
  ["regtech", "LEGAL_REGTECH"],
  ["bioinformatics", "HEALTH_BIO_PHARMA"],
  ["quantitative", "INVESTMENT_MARKETS_FINTECH"],
  ["multilateral", "SOCIAL_IMPACT_MULTILATERAL"],
  ["university", "UNIVERSITY_AI_RESEARCH"],
  ["merchant acquiring", "INVESTMENT_MARKETS_FINTECH"],
  ["payment", "INVESTMENT_MARKETS_FINTECH"],
  ["presales", "CORE_AI_DATA"],
  ["solutions consultant", "CORE_AI_DATA"],
  ["reservation", "CORE_AI_DATA"],
  ["hotel", "CORE_AI_DATA"],
];

export function deterministicLaneEmbedding(text: string): number[] {
  const normalized = text.toLowerCase();
  const lane = TEXT_MARKERS.find(([marker]) => normalized.includes(marker))?.[1];
  if (!lane) {
    throw new Error(`No deterministic lane embedding marker found in: ${text}`);
  }
  return [...LANE_VECTORS[lane]];
}

export interface LaneRoutingUpdate {
  jobId: string;
  primaryLane: string;
  semanticScore: number;
  processingState: string;
  laneConfidence: string;
  secondaryLanes: string[];
  laneEvidence: string[];
}

export interface LaneRouterTestHarness {
  client: PoolClient;
  updates: LaneRoutingUpdate[];
}

type QueryRow = Record<string, unknown>;
type QueryResponse = {
  rows: QueryRow[];
  rowCount: number;
};

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${name} to be a string`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected ${name} to be a number`);
  }
  return value;
}

function parseStringArray(value: unknown, name: string): string[] {
  if (typeof value !== "string") {
    throw new Error(`Expected ${name} to be JSON text`);
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
    throw new Error(`Expected ${name} to be a string array`);
  }
  return parsed;
}

export function createLaneRouterTestHarness(
  jobs: readonly TestJobFixture[],
): LaneRouterTestHarness {
  const updates: LaneRoutingUpdate[] = [];
  const jobRows: QueryRow[] = jobs.map((job) => ({
    id: job.id,
    latest_version_id: `${job.id}-version`,
    normalized_title: job.title,
    description_text: job.raw_description,
  }));

  const query = async (
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResponse> => {
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.includes("from lane_identities")) {
      const error = new Error("lane registry tables are intentionally absent in this unit harness");
      Object.assign(error, { code: "42P01" });
      throw error;
    }

    if (normalized.includes("select c.*, jv.description_text")) {
      return { rows: jobRows, rowCount: jobRows.length };
    }

    if (normalized.includes("workspace_lane_preferences")) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.includes("v_matchable_nodes")) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("update canonical_jobs")) {
      const primaryLane = requireString(values[0], "primary lane");
      const semanticScore = requireNumber(values[1], "semantic score");
      const processingState = requireString(values[2], "processing state");
      const laneConfidence = requireString(values[3], "lane confidence");
      const secondaryLanes = parseStringArray(values[4], "secondary lanes");
      const laneEvidence = parseStringArray(values[5], "lane evidence");
      const jobId = requireString(values[7], "job id");

      updates.push({
        jobId,
        primaryLane,
        semanticScore,
        processingState,
        laneConfidence,
        secondaryLanes,
        laneEvidence,
      });
      return { rows: [], rowCount: 1 };
    }

    if (/^(begin|commit|rollback)\b/.test(normalized)) {
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected lane-router test query: ${normalized.slice(0, 160)}`);
  };

  // The production router only needs query for this deterministic test double.
  const client = { query } as unknown as PoolClient;
  return { client, updates };
}
