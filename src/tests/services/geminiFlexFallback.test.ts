import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Vertex Flex PayGo: request timeout, fallback order (Flex -> standard PayGo -> OpenAI), served-path
 * recording and the per-run provider mix. The Gemini SDK, the route registry and fetch are faked;
 * nothing here touches the network.
 */

const geminiMock = vi.hoisted(() => ({
  generateContent: vi.fn(),
  embedContent: vi.fn(),
}));

const routeRegistryMock = vi.hoisted(() => ({
  ensureModelRouteActiveRevision: vi.fn(),
  getActiveModelRouteRevision: vi.fn(async () => null),
  recordModelRouteInvocation: vi.fn(async () => 'invocation-1'),
}));

const dispatcherMock = vi.hoisted(() => ({
  ensureFetchDispatcherTimeouts: vi.fn(async () => 'REPLACED' as const),
}));

vi.mock('@google/genai', async () => {
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ApiError: actual.ApiError,
    GoogleGenAI: vi.fn(function GoogleGenAIMock(this: any) {
      this.models = { generateContent: geminiMock.generateContent, embedContent: geminiMock.embedContent };
    }),
    Type: {},
    FunctionDeclaration: vi.fn(),
  };
});

vi.mock('../../modelRoutes/registry.js', () => routeRegistryMock);
vi.mock('../../services/fetchDispatcherTimeouts.js', () => dispatcherMock);

import { ApiError } from '@google/genai';

let resilience: typeof import('../../services/modelCallResilience.js');

const ENV_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'GEMINI_API_KEY', 'GEMINI_FLASH_API_KEY', 'DOCUMENT_GEMINI_API_KEY', 'GEMINI_BACKEND',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_ALLOW_REGIONAL_LOCATION', 'GEMINI_PIPELINE_FLEX',
  'GEMINI_FLEX_REQUEST_TIMEOUT_MS', 'GEMINI_FLEX_CALL_DEADLINE_MS', 'EVALUATION_PRIMARY_PROVIDER',
  'EVALUATION_PRIMARY_MODEL', 'EVALUATION_FALLBACK_MODEL', 'GEMINI_MODEL', 'DOCUMENT_PRIMARY_PROVIDER',
  'FORCE_OPENAI', 'MODEL_REQUEST_MAX_RETRIES', 'MODEL_REQUEST_TIMEOUT_MS', 'EMBEDDING_REQUEST_TIMEOUT_MS',
  'GEMINI_RATE_LIMIT_MAX_ATTEMPTS', 'MODEL_INTERACTIVE_CALL_DEADLINE_MS', 'MODEL_PIPELINE_CALL_DEADLINE_MS',
  'GEMINI_MAX_REQUESTS_PER_MINUTE', 'GEMINI_MAX_CONCURRENCY', 'GEMINI_MODEL_LIMITS_JSON', 'MODEL_PRICING_JSON',
  'EMBEDDING_GEMINI_BATCH_SIZE', 'EMBEDDING_PRIMARY_DIMENSIONS', 'REQUIREMENTS_PRIMARY_PROVIDER',
  'EXTRACTION_PRIMARY_PROVIDER', 'REQUIREMENTS_GEMINI_MODEL', 'EXTRACTION_GEMINI_MODEL',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Vertex with Flex enabled, Gemini primary for evaluations, OpenAI configured as the fallback. */
function vertexFlexEvaluationRoute(): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GEMINI_BACKEND = 'vertex';
  process.env.GOOGLE_CLOUD_PROJECT = 'example-project';
  process.env.GEMINI_PIPELINE_FLEX = 'true';
  process.env.EVALUATION_PRIMARY_PROVIDER = 'gemini';
  process.env.EVALUATION_PRIMARY_MODEL = 'gemini-3.6-flash';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_MODEL = 'gpt-test-fallback';
}

const flexTimeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const gemini429 = () => new ApiError({
  status: 429,
  message: JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted.', status: 'RESOURCE_EXHAUSTED' } }),
});
const gemini503 = () => new ApiError({ status: 503, message: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }) });
const gemini400 = () => new ApiError({ status: 400, message: JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } }) });
/** What Node's fetch throws when undici gives up waiting for response headers. */
const undiciHeadersTimeout = () =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });

const job = {
  canonicalJobId: '11111111-1111-4111-8111-111111111111',
  jobVersionId: '22222222-2222-4222-8222-222222222222',
  normalizedTitle: 'Synthetic ML Platform Engineer',
  companyName: 'Example Co',
  canonicalUrl: 'https://jobs.example.test/1',
  descriptionText: 'Build machine learning platform systems.',
  candidateLane: 'CORE_AI_DATA',
  candidateProfileContext: JSON.stringify({ profile_version_id: 'synthetic-profile', facts: [] }),
};

function evaluationPayload(): string {
  return JSON.stringify({
    evaluation_summary: 'Synthetic fit summary.',
    evaluated_jobs: [{
      canonical_job_id: job.canonicalJobId,
      job_version_id: job.jobVersionId,
      primary_lane: 'CORE_AI_DATA',
      secondary_lanes: [],
      lane_confidence: 'High',
      lane_evidence: 'Build machine learning platform systems',
      nd_score: 70,
      nd_friendly_score: 70,
      politics_stress_score: 20,
      sensory_overload_index: 20,
      building_research_ratio: 80,
      interaction_load: 30,
      rejection_codes: [],
      strategic_value: 'Synthetic strategic value.',
      recommended_cv_version: 'CORE_AI_DATA',
      next_action: 'PRIORITY_APPLY',
    }],
  });
}

function stubOpenAi(content: string) {
  const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const geminiRequests = () => geminiMock.generateContent.mock.calls.map(([request]) => request.config.httpOptions);

beforeEach(async () => {
  vi.resetModules();
  resilience = await import('../../services/modelCallResilience.js');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  geminiMock.generateContent.mockReset();
  geminiMock.embedContent.mockReset();
  routeRegistryMock.recordModelRouteInvocation.mockClear();
  dispatcherMock.ensureFetchDispatcherTimeouts.mockClear();
  restoreEnv();
});

describe('Flex request timeouts', () => {
  it('gives a Flex call the 600 s request timeout and Flex headers, and keeps 60 s without them otherwise', async () => {
    vertexFlexEvaluationRoute();
    stubOpenAi('{}');
    // A frozen clock: the interactive request timeout is otherwise clipped by its own 60 s deadline.
    vi.useFakeTimers({ toFake: ['Date'] });
    geminiMock.generateContent.mockResolvedValue({ text: '{"ok":true}' });
    const { generateContentAudited } = await import('../../services/agent.js');

    await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'Flex.', flex: true });
    await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'Standard.' });
    await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'Interactive.', flex: true, interactive: true });

    const [flex, standard, interactive] = geminiRequests();
    expect(flex).toEqual({
      timeout: 600_000,
      headers: { 'X-Vertex-AI-LLM-Request-Type': 'shared', 'X-Vertex-AI-LLM-Shared-Request-Type': 'flex' },
    });
    // The SDK derives X-Server-Timeout (seconds) from httpOptions.timeout; no copy is added by hand.
    expect(Object.keys(flex.headers)).not.toContain('X-Server-Timeout');
    expect(standard).toEqual({ timeout: 60_000 });
    expect(interactive).toEqual({ timeout: 60_000 });
    // Only the Flex request lifts Node's 300 s fetch headers/body ceiling (600 s + 30 s headroom).
    expect(dispatcherMock.ensureFetchDispatcherTimeouts.mock.calls).toEqual([[630_000]]);
  });

  it('gives a Flex call a 900 s deadline and leaves non-Flex (300 s) and interactive (60 s) deadlines alone', async () => {
    vertexFlexEvaluationRoute();
    geminiMock.generateContent.mockResolvedValue({ text: '{"ok":true}' });
    const { generateContentAudited, defaultModelCallDeadlineMs } = await import('../../services/agent.js');
    const context = { workspaceId: 'w', userId: 'u' } as any;
    const pool = {} as any;

    await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'Flex.', flex: true, clientOrPool: pool, context });
    await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'Standard.', clientOrPool: pool, context });
    await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'Interactive.', flex: true, interactive: true, clientOrPool: pool, context });

    const metadata = routeRegistryMock.recordModelRouteInvocation.mock.calls.map(([input]: any[]) => input.requestMetadata);
    expect(metadata.map((entry) => entry.call_deadline_ms)).toEqual([900_000, 300_000, 60_000]);
    expect(metadata[0]).toMatchObject({ gemini_flex: true, gemini_flex_request_timeout_ms: 600_000 });
    expect(metadata[1]).toMatchObject({ gemini_flex: false, model_request_timeout_ms: 60_000 });
    expect(defaultModelCallDeadlineMs({ flex: true })).toBe(900_000);
    expect(defaultModelCallDeadlineMs({})).toBe(300_000);
    expect(defaultModelCallDeadlineMs({ flex: true, interactive: true })).toBe(60_000);
  });

  it('validates the Flex settings: configurable, capped at 1800 s, and malformed values fail before any request', async () => {
    const { geminiFlexRequestTimeoutMs, geminiFlexCallDeadlineMs, FlexTimeoutConfigError } = resilience;
    expect(geminiFlexRequestTimeoutMs({})).toBe(600_000);
    expect(geminiFlexRequestTimeoutMs({ GEMINI_FLEX_REQUEST_TIMEOUT_MS: '900000' })).toBe(900_000);
    expect(geminiFlexRequestTimeoutMs({ GEMINI_FLEX_REQUEST_TIMEOUT_MS: '5400000' })).toBe(1_800_000);
    expect(() => geminiFlexRequestTimeoutMs({ GEMINI_FLEX_REQUEST_TIMEOUT_MS: '10m' })).toThrow(FlexTimeoutConfigError);
    expect(() => geminiFlexRequestTimeoutMs({ GEMINI_FLEX_REQUEST_TIMEOUT_MS: '1000' })).toThrow('at least 60000');
    expect(geminiFlexCallDeadlineMs({})).toBe(900_000);
    expect(geminiFlexCallDeadlineMs({ GEMINI_FLEX_CALL_DEADLINE_MS: '1200000' })).toBe(1_200_000);

    vertexFlexEvaluationRoute();
    process.env.GEMINI_FLEX_REQUEST_TIMEOUT_MS = 'ten minutes';
    const { generateContentAudited } = await import('../../services/agent.js');
    await expect(generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'x', flex: true }))
      .rejects.toThrow('GEMINI_FLEX_REQUEST_TIMEOUT_MS');
    expect(geminiMock.generateContent).not.toHaveBeenCalled();
  });

  it('leaves the embedding request timeout unchanged when Flex is on', async () => {
    vertexFlexEvaluationRoute();
    process.env.GEMINI_FLEX_REQUEST_TIMEOUT_MS = '900000';
    geminiMock.embedContent.mockResolvedValue({ embeddings: [{ values: [0.1, 0.2] }] });
    const { generateEmbeddingsWithProviderAndModel } = await import('../../services/agent.js');

    await generateEmbeddingsWithProviderAndModel(['a'], 'gemini', 'gemini-embedding-001');
    process.env.MODEL_REQUEST_TIMEOUT_MS = '60000';
    await generateEmbeddingsWithProviderAndModel(['b'], 'gemini', 'gemini-embedding-001');
    process.env.EMBEDDING_REQUEST_TIMEOUT_MS = '45000';
    await generateEmbeddingsWithProviderAndModel(['c'], 'gemini', 'gemini-embedding-001');

    const embeddingOptions = geminiMock.embedContent.mock.calls.map(([request]) => request.config.httpOptions);
    expect(embeddingOptions).toEqual([{ timeout: 30_000 }, { timeout: 60_000 }, { timeout: 45_000 }]);
    expect(dispatcherMock.ensureFetchDispatcherTimeouts).not.toHaveBeenCalled();
  });
});

describe('Flex fallback order', () => {
  it('retries a Flex timeout once on standard PayGo: not degraded, path STANDARD, no OpenAI call', async () => {
    vertexFlexEvaluationRoute();
    const fetchMock = stubOpenAi(evaluationPayload());
    geminiMock.generateContent
      .mockRejectedValueOnce(flexTimeout())
      .mockResolvedValueOnce({ text: evaluationPayload(), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    const { evaluateSingleCanonicalJob } = await import('../../services/agent.js');

    const result = await evaluateSingleCanonicalJob(job, '33333333-3333-4333-8333-333333333333');

    expect(geminiRequests()).toEqual([
      { timeout: 600_000, headers: { 'X-Vertex-AI-LLM-Request-Type': 'shared', 'X-Vertex-AI-LLM-Shared-Request-Type': 'flex' } },
      { timeout: 60_000 },
    ]);
    expect(geminiMock.generateContent.mock.calls.map(([request]) => request.model)).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-3.6-flash', fallbackUsed: false, degraded: false, servedPath: 'STANDARD' });
    expect(result.evaluatedJob).toMatchObject({ is_fallback: false, degraded_state: false, served_path: 'STANDARD' });
  });

  it('retries a Flex 429 on standard PayGo', async () => {
    vertexFlexEvaluationRoute();
    const fetchMock = stubOpenAi(evaluationPayload());
    geminiMock.generateContent.mockRejectedValueOnce(gemini429()).mockResolvedValueOnce({ text: evaluationPayload() });
    const { evaluateSingleCanonicalJob } = await import('../../services/agent.js');

    const result = await evaluateSingleCanonicalJob(job);

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(2);
    expect(geminiRequests()[1]).toEqual({ timeout: 60_000 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.evaluatedJob).toMatchObject({ served_path: 'STANDARD', is_fallback: false, degraded_state: false });
  });

  it('treats Flex unavailability, including a fetch headers timeout, as a reason for the standard retry', async () => {
    vertexFlexEvaluationRoute();
    stubOpenAi('{}');
    geminiMock.generateContent
      .mockRejectedValueOnce(gemini503()).mockResolvedValueOnce({ text: '{"ok":1}' })
      .mockRejectedValueOnce(undiciHeadersTimeout()).mockResolvedValueOnce({ text: '{"ok":2}' });
    const { generateContentAudited } = await import('../../services/agent.js');

    const first = await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'a', flex: true });
    const second = await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'b', flex: true });

    expect([first.servedPath, second.servedPath]).toEqual(['STANDARD', 'STANDARD']);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(4);
  });

  it('falls back to OpenAI only after Flex and standard both fail: degraded, path OPENAI_FALLBACK', async () => {
    vertexFlexEvaluationRoute();
    const fetchMock = stubOpenAi(evaluationPayload());
    geminiMock.generateContent.mockRejectedValueOnce(flexTimeout()).mockRejectedValueOnce(flexTimeout());
    const { evaluateSingleCanonicalJob } = await import('../../services/agent.js');

    const result = await evaluateSingleCanonicalJob(job);

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-test-fallback', fallbackUsed: true, degraded: true, servedPath: 'OPENAI_FALLBACK' });
    expect(result.evaluatedJob).toMatchObject({ is_fallback: true, degraded_state: true, served_path: 'OPENAI_FALLBACK' });
  });

  it('serves a healthy Flex call on Flex with one request', async () => {
    vertexFlexEvaluationRoute();
    const fetchMock = stubOpenAi(evaluationPayload());
    geminiMock.generateContent.mockResolvedValueOnce({ text: evaluationPayload(), usageMetadata: { trafficType: 'ON_DEMAND_FLEX' } });
    const { evaluateSingleCanonicalJob } = await import('../../services/agent.js');

    const result = await evaluateSingleCanonicalJob(job);

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.evaluatedJob).toMatchObject({ served_path: 'FLEX', is_fallback: false, degraded_state: false });
  });

  it('sends a non-capacity Flex failure straight to the fallback provider (no standard retry)', async () => {
    vertexFlexEvaluationRoute();
    stubOpenAi('{"ok":true}');
    geminiMock.generateContent.mockRejectedValueOnce(gemini400());
    const { generateContentAudited } = await import('../../services/agent.js');

    const result = await generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'x', flex: true });

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'openai', servedPath: 'OPENAI_FALLBACK', fallbackUsed: true });
  });

  it('keeps provider failures operational: an all-provider failure throws, it never returns a verdict', async () => {
    vertexFlexEvaluationRoute();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"down"}', { status: 400 })));
    geminiMock.generateContent.mockRejectedValueOnce(flexTimeout()).mockRejectedValueOnce(flexTimeout());
    const { evaluateSingleCanonicalJob, ModelCallFailedError } = await import('../../services/agent.js');

    const failure = await evaluateSingleCanonicalJob(job).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelCallFailedError);
    expect((failure as InstanceType<typeof ModelCallFailedError>).failures.map((entry) => entry.kind))
      .toEqual(['FLEX_CAPACITY', 'OTHER', 'OTHER']);
  });

  it('records the served path on the model route invocation', async () => {
    vertexFlexEvaluationRoute();
    // As in the pipeline workflows: quoted requirement extraction runs Gemini first.
    process.env.REQUIREMENTS_PRIMARY_PROVIDER = 'gemini';
    stubOpenAi('{}');
    geminiMock.generateContent.mockRejectedValueOnce(flexTimeout()).mockResolvedValueOnce({ text: '{"ok":true}' });
    const { generateContentAudited } = await import('../../services/agent.js');

    await generateContentAudited({
      purpose: 'EXTRACTION', routeKey: 'requirements_extraction', model: 'gemini-3.1-flash-lite', contents: 'x', flex: true,
      clientOrPool: {} as any, context: { workspaceId: 'w', userId: 'u' } as any,
    });

    const [input] = routeRegistryMock.recordModelRouteInvocation.mock.calls[0] as any[];
    expect(input).toMatchObject({ status: 'COMPLETED', servedPath: 'STANDARD', fallbackUsed: false });
    expect(input.responseMetadata).toMatchObject({ served_path: 'STANDARD', flex_to_standard_recovery: true });
    expect(input.responseMetadata.provider_attempts.map((attempt: any) => [attempt.path, attempt.status, attempt.errorKind ?? null]))
      .toEqual([['FLEX', 'FAILED', 'TIMEOUT'], ['STANDARD', 'COMPLETED', null]]);
  });

  it('calls only the requested provider when onlyProvider is set (offline comparison)', async () => {
    vertexFlexEvaluationRoute();
    const fetchMock = stubOpenAi(evaluationPayload());
    geminiMock.generateContent.mockResolvedValue({ text: evaluationPayload() });
    const { evaluateSingleCanonicalJob } = await import('../../services/agent.js');

    const openai = await evaluateSingleCanonicalJob(job, undefined, 1, { modelOverride: 'gpt-6-luna', onlyProvider: 'openai' });
    expect(geminiMock.generateContent).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe('gpt-6-luna');
    expect(openai).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', fallbackUsed: false, servedPath: 'OPENAI' });
    expect(openai.usage).toMatchObject({ promptTokens: 100, completionTokens: 50, reasoningTokens: 10, reasoningIncludedInCompletion: true });

    geminiMock.generateContent.mockReset();
    geminiMock.generateContent.mockRejectedValueOnce(flexTimeout()).mockRejectedValueOnce(flexTimeout());
    await expect(evaluateSingleCanonicalJob(job, undefined, 1, { modelOverride: 'gemini-3.6-flash', onlyProvider: 'gemini' }))
      .rejects.toThrow('All model API calls failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('per-run provider mix', () => {
  it('counts FLEX, STANDARD and OPENAI_FALLBACK calls, timeouts and 429s, and keeps Flex recoveries out of the stop rules', async () => {
    vertexFlexEvaluationRoute();
    stubOpenAi('{"ok":true}');
    const { generateContentAudited } = await import('../../services/agent.js');
    const before = resilience.snapshotProviderMix();
    const callsBefore = resilience.snapshotProviderCalls();
    const call = () => generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-3.6-flash', contents: 'x', flex: true });

    // 1-2: served on Flex.
    geminiMock.generateContent.mockResolvedValueOnce({ text: '{"ok":1}' }).mockResolvedValueOnce({ text: '{"ok":2}' });
    await call();
    await call();
    // 3: Flex timeout, standard answers.
    geminiMock.generateContent.mockRejectedValueOnce(flexTimeout()).mockResolvedValueOnce({ text: '{"ok":3}' });
    await call();
    // 4: Flex 429, standard answers.
    geminiMock.generateContent.mockRejectedValueOnce(gemini429()).mockResolvedValueOnce({ text: '{"ok":4}' });
    await call();
    // 5: Flex timeout, standard 429, OpenAI answers (degraded).
    geminiMock.generateContent.mockRejectedValueOnce(flexTimeout()).mockRejectedValueOnce(gemini429());
    await call();

    const mix = resilience.summarizeProviderMix(resilience.diffProviderMix(before, resilience.snapshotProviderMix()));
    expect(mix).toMatchObject({
      ai_calls: 5,
      served: { FLEX: 2, STANDARD: 2, OPENAI: 0, OPENAI_FALLBACK: 1 },
      failed: 0,
      flex_attempted: 5,
      flex_to_standard_recoveries: 2,
      timeouts: 2,
      rate_limited: 2,
      flex_timeouts: 2,
      flex_rate_limited: 1,
      // Only call 5 is a provider error; the two Flex->standard recoveries are not.
      provider_error_calls: 1,
      provider_error_share: 0.2,
      // Only call 5's standard 429 counts; call 4's Flex 429 was absorbed by the standard retry.
      rate_limited_calls: 1,
      rate_limited_share: 0.2,
      stop_rule_triggered: true,
    });
    expect(mix.stop_rule_reasons).toEqual([expect.stringContaining('429s on 1/5 AI calls')]);

    // The per-attempt summary reports Flex attempts on their own row and leaves them out of its 429 share.
    const perModel = resilience.summarizeProviderCalls(resilience.diffProviderCalls(callsBefore, resilience.snapshotProviderCalls()));
    expect(perModel.by_model.map((row) => [row.provider, row.calls, row.rate_limited, row.timeouts]).sort()).toEqual([
      ['gemini', 3, 1, 0],
      ['gemini-flex', 5, 1, 2],
    ]);
    expect(perModel).toMatchObject({ rate_limited: 1, flex_rate_limited: 1 });
  });

  it('applies the 20% provider-error and 5% 429 thresholds to AI calls', () => {
    const { summarizeProviderMix } = resilience;
    const base = Object.fromEntries(Object.keys(resilience.diffProviderMix(resilience.snapshotProviderMix(), resilience.snapshotProviderMix()))
      .map((key) => [key, 0])) as any;
    expect(summarizeProviderMix({ ...base, ai_calls: 10, provider_error_calls: 2 })).toMatchObject({ provider_error_share: 0.2, stop_rule_triggered: false });
    expect(summarizeProviderMix({ ...base, ai_calls: 10, provider_error_calls: 3 }).stop_rule_reasons)
      .toEqual([expect.stringContaining('provider errors on 3/10')]);
    expect(summarizeProviderMix({ ...base, ai_calls: 20, rate_limited_calls: 1 }).stop_rule_triggered).toBe(false);
    expect(summarizeProviderMix({ ...base, ai_calls: 20, rate_limited_calls: 2 }).stop_rule_triggered).toBe(true);
    expect(summarizeProviderMix(base)).toMatchObject({ ai_calls: 0, provider_error_share: 0, stop_rule_triggered: false });
  });
});
