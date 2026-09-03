/**
 * Profile loader
 * @description Load and validate profile JSON files from private directory
 * @version 2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import {
  ProfileJsonSchema,
  EngagementJsonSchema,
  FactJsonSchema,
  CredentialJsonSchema,
  WorkPreferencesJsonSchema,
  LanePreferencesJsonSchema,
} from './contracts.js';

const PROFILE_DIR = process.env.PROFILE_DIR || 'private/profile';

export interface LoadedProfile {
  profile: z.infer<typeof ProfileJsonSchema>;
  engagements: z.infer<typeof EngagementJsonSchema>;
  facts: z.infer<typeof FactJsonSchema>;
  credentials: z.infer<typeof CredentialJsonSchema>;
  workPreferences?: z.infer<typeof WorkPreferencesJsonSchema>;
  lanePreferences?: z.infer<typeof LanePreferencesJsonSchema>;
}

/**
 * Load and validate a single profile JSON file
 */
async function loadProfileFile<S extends z.ZodTypeAny>(
  fileName: string,
  schema: S
): Promise<z.output<S>> {
  const filePath = path.join(PROFILE_DIR, fileName);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return schema.parse(data);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${fileName}: ${error.message}`);
    }
    if (error instanceof z.ZodError) {
      throw new Error(
        `Validation failed for ${fileName}:\n${error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n')}`
      );
    }
    if (error instanceof Error && error.message.includes('ENOENT')) {
      throw new Error(`Profile file not found: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Load all profile data files and validate them
 */
export async function loadProfile(): Promise<LoadedProfile> {
  const profile = await loadProfileFile('profile.json', ProfileJsonSchema);
  const engagements = await loadProfileFile('engagements.json', EngagementJsonSchema);
  const facts = await loadProfileFile('facts.json', FactJsonSchema);
  const credentials = await loadProfileFile(
    'credentials.json',
    CredentialJsonSchema
  );

  // Work preferences and lane preferences are optional
  let workPreferences: z.infer<typeof WorkPreferencesJsonSchema> | undefined;
  let lanePreferences: z.infer<typeof LanePreferencesJsonSchema> | undefined;

  try {
    workPreferences = await loadProfileFile(
      'work_preferences.json',
      WorkPreferencesJsonSchema
    );
  } catch (error) {
    // Optional file, warn but continue
    console.warn(`Could not load work_preferences.json: ${error instanceof Error ? error.message : error}`);
  }

  try {
    lanePreferences = await loadProfileFile(
      'lane_preferences.json',
      LanePreferencesJsonSchema
    );
  } catch (error) {
    // Optional file, warn but continue
    console.warn(`Could not load lane_preferences.json: ${error instanceof Error ? error.message : error}`);
  }

  // Validate cross-file consistency
  const profileData = profile as any;
  const engagementsData = engagements as any;
  const factsData = facts as any;
  const credentialsData = credentials as any;

  const profileKey = profileData.profile_key;
  if (engagementsData.profile_key !== profileKey) {
    throw new Error('profile_key mismatch between profile.json and engagements.json');
  }
  if (factsData.profile_key !== profileKey) {
    throw new Error('profile_key mismatch between profile.json and facts.json');
  }
  if (credentialsData.profile_key !== profileKey) {
    throw new Error('profile_key mismatch between profile.json and credentials.json');
  }
  if (workPreferences && (workPreferences as any).profile_key !== profileKey) {
    throw new Error('profile_key mismatch between profile.json and work_preferences.json');
  }
  if (lanePreferences && (lanePreferences as any).profile_key !== profileKey) {
    throw new Error('profile_key mismatch between profile.json and lane_preferences.json');
  }

  return {
    profile,
    engagements,
    facts,
    credentials,
    workPreferences,
    lanePreferences,
  };
}

/**
 * Validate that profile data is coherent
 * - Engagement keys referenced in facts exist
 * - Fact types match their engagement context
 * - Dates are in logical order
 */
export async function validateProfileCoherence(
  loaded: LoadedProfile
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];

  const engagementData = loaded.engagements as any;
  const factData = loaded.facts as any;
  const credentialData = loaded.credentials as any;

  const engagementKeySet = new Set(
    (Array.isArray(engagementData.engagements) ? engagementData.engagements : []).map((e: any) => e.engagement_key)
  );

  for (const fact of (Array.isArray(factData.facts) ? factData.facts : [])) {
    if (fact.engagement_key && !engagementKeySet.has(fact.engagement_key)) {
      issues.push(
        `Fact "${fact.fact_key}" references unknown engagement "${fact.engagement_key}"`
      );
    }

    // Fact date range should be within engagement date range if tied to an engagement
    if (fact.engagement_key && fact.start_date && fact.end_date) {
      const engagement = (Array.isArray(engagementData.engagements) ? engagementData.engagements : []).find(
        (e: any) => e.engagement_key === fact.engagement_key
      );
      if (engagement) {
        if (fact.start_date < engagement.start_date) {
          issues.push(
            `Fact "${fact.fact_key}" starts before its engagement "${fact.engagement_key}"`
          );
        }
        if (
          fact.end_date &&
          engagement.end_date &&
          fact.end_date > engagement.end_date
        ) {
          issues.push(
            `Fact "${fact.fact_key}" ends after its engagement "${fact.engagement_key}"`
          );
        }
      }
    }
  }

  for (const credential of (Array.isArray(credentialData.credentials) ? credentialData.credentials : [])) {
    if (credential.issued_on && credential.expires_on) {
      if (credential.expires_on < credential.issued_on) {
        issues.push(
          `Credential "${credential.credential_key}" expires before issuance`
        );
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Get profile directory for debugging
 */
export function getProfileDirectory(): string {
  return path.resolve(PROFILE_DIR);
}
