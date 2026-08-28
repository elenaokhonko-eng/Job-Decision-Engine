import { ExtractedJob } from "../../contracts/index.js";

export interface AdapterResult {
  sourceName: string;
  success: boolean;
  jobs: ExtractedJob[];
  totalFetched: number;
  error?: string;
  isRateLimited?: boolean;
}

export abstract class BaseSourceAdapter {
  abstract sourceName: string;
  abstract fetchJobs(options?: { limit?: number; page?: number }): Promise<AdapterResult>;
}
