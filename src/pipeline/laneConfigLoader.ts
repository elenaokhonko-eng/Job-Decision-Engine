import fs from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { SCHEMA_VERSION } from "../contracts/version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface LaneDefinition {
  title: string;
  description: string;
  threshold: number;
  semantic_threshold?: number;
  ai_evaluation_limit?: number;
  enabled_sources?: string[];
  title_families?: string[];
  keywords: string[];
  positive_concepts?: string[];
  negative_concepts?: string[];
  prototype_query: string;
}

export interface GlobalLanesConfig {
  version?: string;
  description?: string;
  lanes: Record<string, LaneDefinition>;
  unclassified_policy: {
    label: string;
    fallback_behavior: string;
    min_similarity_floor: number;
  };
}

interface LaneRegistryEntry {
  lane_key: string;
  config_file: string;
  enabled_by_default?: boolean;
}

interface LaneRegistryFile {
  schema_version?: string;
  config_version?: string;
  lanes: LaneRegistryEntry[];
}

interface LaneFileConfig {
  schema_version?: string;
  lane_key: string;
  display_name: string;
  description: string;
  scope?: {
    required_function_concepts?: { any?: string[] };
    included_domain_concepts?: { any?: string[] };
    excluded_domain_concepts?: { any?: string[] };
  };
  prototypes?: Array<{
    prototype_key: string;
    text: string;
    weight?: number;
  }>;
  routing?: {
    minimum_semantic_score?: number;
    secondary_lane_threshold?: number;
  };
  sourcing?: {
    enabled_sources?: string[];
  };
  budget?: {
    maximum_ai_interpretations_per_run?: number;
  };
  positive_concepts?: string[];
  negative_concepts?: string[];
  ai_evaluation_limit?: number;
  semantic_threshold?: number;
}

function parseYamlFile<T>(filePath: string): T {
  const loadFn = (yaml as any).load || (yaml as any).default?.load || yaml;
  return loadFn(fs.readFileSync(filePath, "utf-8")) as T;
}

function normalizeConcept(concept: string): string {
  return concept.toLowerCase().replace(/_/g, " ").trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

export function loadGlobalLanesConfig(): GlobalLanesConfig {
  const registryPath = path.resolve(__dirname, "../../config/lanes/registry.yml");
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Lane registry not found at ${registryPath}`);
  }

  const registry = parseYamlFile<LaneRegistryFile>(registryPath);
  if (!registry.lanes || registry.lanes.length === 0) {
    throw new Error("Lane registry contains no lanes.");
  }

  const lanes: Record<string, LaneDefinition> = {};

  for (const entry of registry.lanes) {
    if (entry.enabled_by_default === false) {
      continue;
    }

    const lanePath = path.resolve(__dirname, `../../config/lanes/${entry.config_file}`);
    if (!fs.existsSync(lanePath)) {
      throw new Error(`Lane config file not found for ${entry.lane_key}: ${lanePath}`);
    }

    const laneConfig = parseYamlFile<LaneFileConfig>(lanePath);
    const concepts = laneConfig.scope?.included_domain_concepts?.any || [];
    const requiredFunctions = laneConfig.scope?.required_function_concepts?.any || [];
    const excludedConcepts = laneConfig.scope?.excluded_domain_concepts?.any || [];

    const prototypeTexts = (laneConfig.prototypes || [])
      .map((p) => p.text.trim())
      .filter((p) => p.length > 0);

    const positiveConcepts = dedupe(
      (laneConfig.positive_concepts || concepts.map(normalizeConcept))
        .map((c) => c.trim())
    );
    const negativeConcepts = dedupe(
      (laneConfig.negative_concepts || excludedConcepts.map(normalizeConcept))
        .map((c) => c.trim())
    );

    lanes[entry.lane_key] = {
      title: laneConfig.display_name,
      description: laneConfig.description,
      threshold: laneConfig.routing?.minimum_semantic_score ?? laneConfig.semantic_threshold ?? 0.35,
      semantic_threshold: laneConfig.routing?.minimum_semantic_score ?? laneConfig.semantic_threshold ?? 0.35,
      ai_evaluation_limit: laneConfig.budget?.maximum_ai_interpretations_per_run ?? laneConfig.ai_evaluation_limit ?? 3,
      enabled_sources: (laneConfig.sourcing?.enabled_sources || []).map((s) => s.toLowerCase()),
      title_families: dedupe(requiredFunctions.map(normalizeConcept)),
      keywords: dedupe(concepts.map(normalizeConcept)),
      positive_concepts: positiveConcepts,
      negative_concepts: negativeConcepts,
      prototype_query: prototypeTexts.join(" ") || laneConfig.description,
    };
  }

  return {
    version: registry.config_version || registry.schema_version || SCHEMA_VERSION,
    description: "Authoritative multi-lane definition and semantic threshold registry",
    lanes,
    unclassified_policy: {
      label: "UNCLASSIFIED",
      fallback_behavior: "DEFER_ROUTING",
      min_similarity_floor: 0.25,
    },
  };
}

export const loadLanesConfig = loadGlobalLanesConfig;
