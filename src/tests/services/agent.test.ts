import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateSingleCanonicalJob,
  generateContentAudited,
  generateEmbeddingWithProviderAndModel,
  preflightModelRoutes,
  runAgent,
  type SingleEvaluationJobInput,
} from '../../services/agent.js';

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_FLASH_API_KEY: process.env.GEMINI_FLASH_API_KEY,
  EVALUATION_PRIMARY_PROVIDER: process.env.EVALUATION_PRIMARY_PROVIDER,
  DOCUMENT_PRIMARY_PROVIDER: process.env.DOCUMENT_PRIMARY_PROVIDER,
  REQUIREMENTS_PRIMARY_PROVIDER: process.env.REQUIREMENTS_PRIMARY_PROVIDER,
  REQUIREMENTS_OPENAI_MODEL: process.env.REQUIREMENTS_OPENAI_MODEL,
  REQUIREMENTS_GEMINI_MODEL: process.env.REQUIREMENTS_GEMINI_MODEL,
  EXTRACTION_PRIMARY_PROVIDER: process.env.EXTRACTION_PRIMARY_PROVIDER,
  EXTRACTION_OPENAI_MODEL: process.env.EXTRACTION_OPENAI_MODEL,
  EXTRACTION_GEMINI_MODEL: process.env.EXTRACTION_GEMINI_MODEL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  MODEL_REQUEST_MAX_RETRIES: process.env.MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_TIMEOUT_MS: process.env.MODEL_REQUEST_TIMEOUT_MS,
  EMBEDDING_REQUEST_TIMEOUT_MS: process.env.EMBEDDING_REQUEST_TIMEOUT_MS,
  EMBEDDING_PRIMARY_PROVIDER: process.env.EMBEDDING_PRIMARY_PROVIDER,
  EMBEDDING_FALLBACK_DIMENSIONS: process.env.EMBEDDING_FALLBACK_DIMENSIONS,
  MODEL_PRICING_JSON: process.env.MODEL_PRICING_JSON,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('generateContentAudited retry policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  it('refuses the legacy evaluator without database-backed candidate context', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    await expect(runAgent('Evaluate this job', { candidateProfileContext: '' })).rejects.toThrow(/database-backed candidateProfileContext/);
  });

  it('does not retry non-retryable OpenAI 400 schema errors', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.MODEL_REQUEST_MAX_RETRIES = '3';
    process.env.MODEL_REQUEST_TIMEOUT_MS = '12000';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Invalid schema for response_format 'extraction'",
            type: 'invalid_request_error',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateContentAudited({
        purpose: 'EXTRACTION',
        routeKey: 'extraction',
        model: 'gpt-4o-mini',
        contents: 'Return JSON.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'string' } },
        },
      })
    ).rejects.toThrow(/status 400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(12000);
  });

  it('routes extraction through the requirements OpenAI model instead of the global evaluation model', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.REQUIREMENTS_PRIMARY_PROVIDER = 'openai';
    process.env.OPENAI_MODEL = 'gpt-5.6-sol';
    process.env.REQUIREMENTS_OPENAI_MODEL = 'gpt-5.6-luna';
    process.env.MODEL_REQUEST_MAX_RETRIES = '3';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":"yes"}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateContentAudited({
      purpose: 'EXTRACTION',
      routeKey: 'requirements_extraction',
      model: '',
      contents: 'Return JSON.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'string' } },
      },
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(requestBody.model).toBe('gpt-5.6-luna');
    expect(requestBody.model).not.toBe('gpt-5.6-sol');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.6-luna');
    expect(result.attempts).toBe(1);
  });

  it('uses the embedding-specific timeout for OpenAI embedding requests', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EMBEDDING_REQUEST_TIMEOUT_MS = '7000';
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = '4';

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const vector = await generateEmbeddingWithProviderAndModel(
      'embedding input',
      'openai',
      'text-embedding-3-small'
    );

    expect(vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(timeoutSpy).toHaveBeenCalledWith(7000);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(requestBody.dimensions).toBe(4);
  });

  it('treats audited response validation failures as model-call failures', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.MODEL_REQUEST_MAX_RETRIES = '1';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"wrong":true}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateContentAudited({
        purpose: 'EXTRACTION',
        routeKey: 'requirements_extraction',
        model: 'gpt-4o-mini',
        contents: 'Return JSON.',
        responseMimeType: 'application/json',
        validateResponseText: (text) => {
          const parsed = JSON.parse(text) as { ok?: string };
          if (parsed.ok !== 'yes') {
            throw new Error('validated payload missing ok=yes');
          }
          return parsed;
        },
      })
    ).rejects.toThrow(/validated payload missing ok=yes/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records token usage, optional cost, and provider attempt telemetry', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    process.env.MODEL_REQUEST_MAX_RETRIES = '1';
    process.env.MODEL_PRICING_JSON = JSON.stringify({
      'openai:gpt-4o-mini': { input_per_1m: 0.1, output_per_1m: 0.2 },
    });
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":"yes"}' } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    let invocationParams: any[] | null = null;
    const query = vi.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('FROM model_routes mr')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO model_route_invocations')) {
        invocationParams = params || [];
        return { rows: [{ id: 'invocation-1' }] };
      }
      return { rows: [] };
    });
    const context = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER' as const,
    };

    const result = await generateContentAudited({
      purpose: 'EXTRACTION',
      routeKey: 'requirements_extraction',
      model: 'gpt-4o-mini',
      contents: 'Return JSON.',
      responseMimeType: 'application/json',
      validateResponseText: (text) => JSON.parse(text),
      clientOrPool: { query } as any,
      context,
    });

    expect(result.invocationId).toBe('invocation-1');
    const recordedParams = invocationParams as any[] | null;
    expect(recordedParams).not.toBeNull();
    if (!recordedParams) throw new Error('Expected model route invocation params to be recorded.');
    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO model_route_invocations'));
    expect(insertCall?.[0].match(/\$\d+/g)).toHaveLength(recordedParams.length);
    expect(recordedParams[12]).toBe(0.0002);
    expect(recordedParams[13]).toBe(1000);
    expect(recordedParams[14]).toBe(500);
    expect(recordedParams[15]).toBe(1500);
    expect(recordedParams[10].internal_http_attempts).toBe(1);
    expect(recordedParams[10].provider_attempts[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'COMPLETED',
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    });
  });

  it('returns detailed preflight checks and degraded fallback notes', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.DOCUMENT_PRIMARY_PROVIDER = 'openai';
    process.env.REQUIREMENTS_PRIMARY_PROVIDER = 'openai';
    process.env.EMBEDDING_PRIMARY_PROVIDER = 'openai';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    process.env.REQUIREMENTS_OPENAI_MODEL = 'gpt-4o-mini';
    process.env.EMBEDDING_FALLBACK_DIMENSIONS = '4';
    process.env.MODEL_REQUEST_MAX_RETRIES = '1';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/embeddings')) {
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      const body = JSON.parse(String(init?.body || '{}'));
      const content = body.response_format?.type === 'json_schema' ? '{"ok":"OK"}' : 'OK';
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await preflightModelRoutes();

    expect(result.evaluation).toBe(true);
    expect(result.document).toBe(true);
    expect(result.extraction).toBe(true);
    expect(result.embedding).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks.some((check) => check.route === 'extraction' && check.ok)).toBe(true);
    expect(result.degradedRoutes.some((route) => route.includes('fallback gemini unavailable'))).toBe(true);
  });
});

describe('evaluateSingleCanonicalJob output validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  const job: SingleEvaluationJobInput = {
    canonicalJobId: '11111111-1111-4111-8111-111111111111',
    jobVersionId: '22222222-2222-4222-8222-222222222222',
    normalizedTitle: 'AI Platform Engineer',
    companyName: 'Example Co',
    canonicalUrl: 'https://example.test/jobs/1',
    descriptionText: 'Build machine learning platform systems. Work rights required.',
    candidateLane: 'CORE_AI_DATA',
    candidateProfileContext: JSON.stringify({
      profile_version_id: 'profile-version-test',
      facts: [{ statement: 'Built production machine learning systems.', verification_status: 'VERIFIED' }],
      workability_preferences: { hard_constraints: { max_office_days_per_week: 3 } },
    }),
  };

  function stubOpenAiEvaluationResponse(payload: unknown) {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function configureOpenAiOnlyEvaluation() {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    process.env.MODEL_REQUEST_MAX_RETRIES = '1';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;
  }

  function validEvaluationPayload(overrides: Record<string, unknown> = {}) {
    return {
      evaluation_summary: 'Strong fit for a hands-on AI platform role.',
      evaluated_jobs: [
        {
          canonical_job_id: job.canonicalJobId,
          job_version_id: job.jobVersionId,
          primary_lane: 'CORE_AI_DATA',
          secondary_lanes: [],
          lane_confidence: 'High',
          lane_evidence: 'Build machine learning platform systems',
          nd_score: 78,
          nd_friendly_score: 80,
          politics_stress_score: 20,
          sensory_overload_index: 25,
          building_research_ratio: 90,
          interaction_load: 30,
          rejection_codes: [],
          strategic_value: 'Hands-on AI platform work with concrete evidence.',
          recommended_cv_version: 'CORE_AI_DATA',
          next_action: 'PRIORITY_APPLY',
          ...overrides,
        },
      ],
    };
  }

  it('rejects empty evaluation objects instead of defaulting synthetic scores', async () => {
    configureOpenAiOnlyEvaluation();
    stubOpenAiEvaluationResponse({});

    await expect(evaluateSingleCanonicalJob(job)).rejects.toThrow(/canonical_job_id/);
  });

  it('rejects evaluation output for the wrong job version', async () => {
    configureOpenAiOnlyEvaluation();
    stubOpenAiEvaluationResponse(validEvaluationPayload({ job_version_id: 'wrong-version' }));

    await expect(evaluateSingleCanonicalJob(job)).rejects.toThrow(/job_version_id wrong-version/);
  });

  it('rejects evaluation output that fails the persisted evaluation contract', async () => {
    configureOpenAiOnlyEvaluation();
    stubOpenAiEvaluationResponse(validEvaluationPayload({ next_action: 'MAYBE_APPLY' }));

    await expect(evaluateSingleCanonicalJob(job)).rejects.toThrow(/MAYBE_APPLY/);
  });

  it('preserves explicit zero scores when the model returns valid output', async () => {
    configureOpenAiOnlyEvaluation();
    const fetchMock = stubOpenAiEvaluationResponse(
      validEvaluationPayload({
        nd_score: 0,
        nd_friendly_score: 0,
        politics_stress_score: 0,
        sensory_overload_index: 0,
        building_research_ratio: 0,
        interaction_load: 0,
        primary_lane: null,
        lane_confidence: 'Low',
        next_action: 'REJECTED',
        recommended_cv_version: 'None',
      })
    );

    const result = await evaluateSingleCanonicalJob(job, '33333333-3333-4333-8333-333333333333');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.evaluatedJob.nd_score).toBe(0);
    expect(result.evaluatedJob.nd_friendly_score).toBe(0);
    expect(result.evaluatedJob.primary_lane).toBeNull();
    expect(result.provider).toBe('openai');
  });
});
