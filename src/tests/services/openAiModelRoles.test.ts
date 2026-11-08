import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The OpenAI model of every call site resolves through its role chain at call time:
 * evaluation = EVALUATION_FALLBACK_MODEL -> OPENAI_MODEL -> default,
 * documents  = DOCUMENT_FALLBACK_MODEL   -> OPENAI_MODEL -> default.
 * A role variable always wins over the shared OPENAI_MODEL. fetch and the OpenAI SDK are faked.
 */

const openAiSdkMock = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('openai', () => ({
  OpenAI: vi.fn(function OpenAIMock(this: any) {
    this.chat = { completions: { create: openAiSdkMock.create } };
  }),
}));

const ENV_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'EVALUATION_FALLBACK_MODEL', 'DOCUMENT_FALLBACK_MODEL', 'GEMINI_API_KEY',
  'GEMINI_FLASH_API_KEY', 'GEMINI_BACKEND', 'GOOGLE_CLOUD_PROJECT', 'EVALUATION_PRIMARY_PROVIDER',
  'DOCUMENT_PRIMARY_PROVIDER', 'DOCUMENT_PRIMARY_MODEL', 'FORCE_OPENAI', 'MODEL_REQUEST_MAX_RETRIES',
  'OLLAMA_API_BASE', 'OLLAMA_MODEL', 'EMBEDDING_PRIMARY_PROVIDER', 'EMBEDDING_FALLBACK_PROVIDER',
  'REQUIREMENTS_PRIMARY_PROVIDER', 'REQUIREMENTS_ENABLE_QUOTED',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const job = {
  canonicalJobId: '11111111-1111-4111-8111-111111111111',
  jobVersionId: '22222222-2222-4222-8222-222222222222',
  normalizedTitle: 'Synthetic Data Engineer',
  companyName: 'Example Co',
  canonicalUrl: 'https://jobs.example.test/2',
  descriptionText: 'Build data pipelines.',
  candidateLane: 'CORE_AI_DATA',
  candidateProfileContext: JSON.stringify({ profile_version_id: 'synthetic-profile', facts: [] }),
};

const evaluationJson = JSON.stringify({
  evaluation_summary: 'Synthetic summary.',
  evaluated_jobs: [{
    canonical_job_id: job.canonicalJobId,
    job_version_id: job.jobVersionId,
    primary_lane: 'CORE_AI_DATA', secondary_lanes: [], lane_confidence: 'High', lane_evidence: 'Build data pipelines',
    nd_score: 60, nd_friendly_score: 60, politics_stress_score: 20, sensory_overload_index: 20,
    building_research_ratio: 70, interaction_load: 30, rejection_codes: [], strategic_value: 'Synthetic.',
    recommended_cv_version: 'CORE_AI_DATA', next_action: 'PRIORITY_APPLY',
  }],
});

function stubOpenAiFetch(content: string, status = 200) {
  const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(
    status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : JSON.stringify({ error: { message: 'bad request' } }),
    { status, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const requestedModels = (fetchMock: ReturnType<typeof stubOpenAiFetch>) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/chat/completions'))
    .map(([, init]) => JSON.parse(String(init?.body)).model);

/** OpenAI only, with role variables set AFTER the modules are imported: resolution is at call time. */
function setRoleEnv(): void {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_MODEL = 'gpt-shared-default';
  process.env.EVALUATION_FALLBACK_MODEL = 'gpt-evaluation-role';
  process.env.DOCUMENT_FALLBACK_MODEL = 'gpt-document-role';
  process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
  process.env.DOCUMENT_PRIMARY_PROVIDER = 'openai';
  process.env.MODEL_REQUEST_MAX_RETRIES = '1';
}

beforeEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  openAiSdkMock.create.mockReset();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('OpenAI model role chains', () => {
  it('resolves role variable, then OPENAI_MODEL, then the default; empty values fall through', async () => {
    const { evaluationOpenAiModel, documentOpenAiModel } = await import('../../services/openAiModelRoles.js');
    expect(evaluationOpenAiModel({})).toBe('gpt-4o-mini');
    expect(evaluationOpenAiModel({ OPENAI_MODEL: 'shared' })).toBe('shared');
    expect(evaluationOpenAiModel({ OPENAI_MODEL: 'shared', EVALUATION_FALLBACK_MODEL: 'eval' })).toBe('eval');
    // An unset GitHub variable arrives as '' and must not hide OPENAI_MODEL.
    expect(evaluationOpenAiModel({ OPENAI_MODEL: 'shared', EVALUATION_FALLBACK_MODEL: '' })).toBe('shared');
    expect(documentOpenAiModel({ OPENAI_MODEL: 'shared', DOCUMENT_FALLBACK_MODEL: 'doc', EVALUATION_FALLBACK_MODEL: 'eval' })).toBe('doc');
    expect(documentOpenAiModel({ OPENAI_MODEL: 'shared', DOCUMENT_FALLBACK_MODEL: '  ' })).toBe('shared');
  });

  it('keeps the model-id preflight on the same chains', async () => {
    const { configuredModelIds } = await import('../../services/modelIdPreflight.js');
    const { evaluationOpenAiModel, documentOpenAiModel } = await import('../../services/openAiModelRoles.js');
    const env = { OPENAI_MODEL: 'shared', EVALUATION_FALLBACK_MODEL: 'eval', DOCUMENT_FALLBACK_MODEL: 'doc' } as NodeJS.ProcessEnv;
    const openAiIds = configuredModelIds(env).filter((entry) => entry.provider === 'openai');
    expect(openAiIds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: evaluationOpenAiModel(env), sources: ['EVALUATION_FALLBACK_MODEL'] }),
      expect.objectContaining({ id: documentOpenAiModel(env), sources: ['DOCUMENT_FALLBACK_MODEL'] }),
    ]));
    expect(openAiIds.map((entry) => entry.id)).not.toContain('shared');
  });

  it('evaluateSingleCanonicalJob uses EVALUATION_FALLBACK_MODEL over OPENAI_MODEL', async () => {
    const agent = await import('../../services/agent.js');
    setRoleEnv();
    const fetchMock = stubOpenAiFetch(evaluationJson);

    const result = await agent.evaluateSingleCanonicalJob(job);

    expect(requestedModels(fetchMock)).toEqual(['gpt-evaluation-role']);
    expect(result.model).toBe('gpt-evaluation-role');
  });

  it('the evaluation route default (generateContentAudited) uses EVALUATION_FALLBACK_MODEL', async () => {
    const agent = await import('../../services/agent.js');
    setRoleEnv();
    const fetchMock = stubOpenAiFetch('{"ok":true}');

    await agent.generateContentAudited({ purpose: 'EVALUATION', model: 'gemini-anything', contents: 'x' });

    expect(requestedModels(fetchMock)).toEqual(['gpt-evaluation-role']);
  });

  it('the document route default (generateContentAudited) uses DOCUMENT_FALLBACK_MODEL', async () => {
    const agent = await import('../../services/agent.js');
    setRoleEnv();
    process.env.DOCUMENT_PRIMARY_MODEL = 'gemini-document';
    const fetchMock = stubOpenAiFetch('{"ok":true}');

    await agent.generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-document', contents: 'x' });

    expect(requestedModels(fetchMock)).toEqual(['gpt-document-role']);
  });

  it('callLLM("cv") uses DOCUMENT_FALLBACK_MODEL', async () => {
    const agent = await import('../../services/agent.js');
    setRoleEnv();
    const fetchMock = stubOpenAiFetch('{"ok":true}');

    await agent.callLLM('cv', 'Write.');

    expect(requestedModels(fetchMock)).toEqual(['gpt-document-role']);
  });

  it('runAgentWithFallback and runAgent use EVALUATION_FALLBACK_MODEL', async () => {
    const agent = await import('../../services/agent.js');
    setRoleEnv();
    const fetchMock = stubOpenAiFetch('{"evaluation_summary":"s","evaluated_jobs":[]}');

    const withFallback = await agent.runAgentWithFallback('Evaluate.', { type: 'object' });
    expect(withFallback.model).toBe('gpt-evaluation-role');
    await agent.runAgent('Evaluate.', { candidateProfileContext: '{"synthetic":true}' }).catch(() => undefined);

    expect(requestedModels(fetchMock)).toEqual(['gpt-evaluation-role', 'gpt-evaluation-role']);
  });

  it('preflightModelRoutes checks the role models for evaluation and documents', async () => {
    const agent = await import('../../services/agent.js');
    setRoleEnv();
    const fetchMock = stubOpenAiFetch('{"ok":"OK"}');

    await agent.preflightModelRoutes();

    const models = requestedModels(fetchMock);
    expect(models).toContain('gpt-evaluation-role');
    expect(models).toContain('gpt-document-role');
    expect(models).not.toContain('gpt-shared-default');
  });

  it('llmFallback (legacy alert extraction) uses the evaluation chain for its OpenAI step', async () => {
    const { extractWithFallback } = await import('../../services/llmFallback.js');
    setRoleEnv();
    // Ollama is not configured and the audited route fails, so the final OpenAI SDK step runs.
    stubOpenAiFetch('', 400);
    openAiSdkMock.create.mockResolvedValue({ choices: [{ message: { content: '{"jobs":[]}' } }] });

    await expect(extractWithFallback('Extract.', undefined)).resolves.toBe('{"jobs":[]}');

    expect(openAiSdkMock.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-evaluation-role' }));
  });

  it('falls back to OPENAI_MODEL when no role variable is set', async () => {
    const agent = await import('../../services/agent.js');
    setRoleEnv();
    delete process.env.EVALUATION_FALLBACK_MODEL;
    const fetchMock = stubOpenAiFetch(evaluationJson);

    await agent.evaluateSingleCanonicalJob(job);

    expect(requestedModels(fetchMock)).toEqual(['gpt-shared-default']);
  });
});
