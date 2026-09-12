import { useState, useEffect } from "react";
import { getNativeSecretStore, getNativeApiBridge } from "./nativeBridge.js";

interface SetupStatus {
  ok: boolean;
  database: {
    configured: boolean;
    connected: boolean;
    isInitialized: boolean;
    appliedMigrations: number;
    pendingMigrations: number;
    error?: string;
  };
  ai: {
    geminiConfigured: boolean;
    openaiConfigured: boolean;
  };
  modelRoutes: {
    embedding: string | null;
    evaluation: string | null;
    document: string | null;
    extraction: string | null;
  };
}

interface SetupWizardProps {
  onComplete: () => void;
  onCancel?: () => void;
}

export function SetupWizard({ onComplete, onCancel }: SetupWizardProps) {
  const [step, setStep] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Status from backend
  const [status, setStatus] = useState<SetupStatus | null>(null);

  // Form states
  const [databaseUrl, setDatabaseUrl] = useState<string>("");
  const [databaseUrlDirect, setDatabaseUrlDirect] = useState<string>("");
  const [dbTestResult, setDbTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [geminiApiKey, setGeminiApiKey] = useState<string>("");
  const [openaiApiKey, setOpenaiApiKey] = useState<string>("");
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [preset, setPreset] = useState<"gemini" | "openai">("gemini");
  const [embeddingModel, setEmbeddingModel] = useState<string>("text-embedding-004");
  const [evaluationModel, setEvaluationModel] = useState<string>("gemini-1.5-flash");
  const [documentModel, setDocumentModel] = useState<string>("gemini-1.5-flash");
  const [extractionModel, setExtractionModel] = useState<string>("gemini-1.5-flash");

  const [initProgress, setInitProgress] = useState<string | null>(null);

  const secretStore = getNativeSecretStore();
  const apiBridge = getNativeApiBridge();

  const apiFetch = async (path: string, options: RequestInit = {}) => {
    if (apiBridge) {
      const res = await apiBridge.request({
        apiBaseUrl: "/api/v2",
        path: path.startsWith("/api/v2") ? path.slice(7) : path,
        method: options.method || "GET",
        headers: (options.headers as Record<string, string>) || {},
        body: typeof options.body === "string" ? options.body : undefined,
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => JSON.parse(res.body || "{}"),
      };
    }
    return fetch(path, options);
  };

  const fetchStatus = async () => {
    try {
      const res = await apiFetch("/api/v2/setup/status");
      if (res.ok) {
        const data = (await res.json()) as SetupStatus;
        setStatus(data);
      }
    } catch (err) {
      console.warn("Failed to query setup status:", err);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  // Update models when preset changes
  useEffect(() => {
    if (preset === "gemini") {
      setEmbeddingModel("text-embedding-004");
      setEvaluationModel("gemini-1.5-flash");
      setDocumentModel("gemini-1.5-flash");
      setExtractionModel("gemini-1.5-flash");
    } else {
      setEmbeddingModel("text-embedding-3-small");
      setEvaluationModel("gpt-4o-mini");
      setDocumentModel("gpt-4o-mini");
      setExtractionModel("gpt-4o-mini");
    }
  }, [preset]);

  const handleTestDatabase = async () => {
    setLoading(true);
    setError(null);
    setDbTestResult(null);
    try {
      const res = await apiFetch("/api/v2/setup/database/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ databaseUrl, databaseUrlDirect }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setDbTestResult({
          ok: true,
          message: `Connected successfully (latency: ${data.latencyMs}ms). Direct connection verified.`,
        });
        if (data.suggestedDirectUrl && !databaseUrlDirect) {
          setDatabaseUrlDirect(data.suggestedDirectUrl);
        }
        // Save to native safeStorage if available
        if (secretStore) {
          await secretStore.setSecret("databaseUrl", databaseUrl);
          if (databaseUrlDirect || data.suggestedDirectUrl) {
            await secretStore.setSecret("databaseUrlDirect", databaseUrlDirect || data.suggestedDirectUrl);
          }
        }
      } else {
        setDbTestResult({
          ok: false,
          message: data.error || "Connection test failed.",
        });
      }
    } catch (err) {
      setDbTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleTestAi = async (provider: "gemini" | "openai") => {
    setLoading(true);
    setError(null);
    setAiTestResult(null);
    const key = provider === "gemini" ? geminiApiKey : openaiApiKey;
    if (!key) {
      setError(`Please enter an API key for ${provider}.`);
      setLoading(false);
      return;
    }
    try {
      const res = await apiFetch("/api/v2/setup/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: key }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setAiTestResult({
          ok: true,
          message: `${provider.toUpperCase()} API key verified successfully!`,
        });
        if (secretStore) {
          await secretStore.setSecret(provider === "gemini" ? "geminiApiKey" : "openaiApiKey", key);
        }
      } else {
        setAiTestResult({
          ok: false,
          message: data.error || "Key validation failed.",
        });
      }
    } catch (err) {
      setAiTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRoutes = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/v2/setup/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: preset,
          routes: {
            embedding: { provider: preset, model: embeddingModel },
            routing: { provider: preset, model: evaluationModel },
            evaluation: { provider: preset, model: evaluationModel },
            document: { provider: preset, model: documentModel },
            extraction: { provider: preset, model: extractionModel },
          },
          embeddingModel,
          evaluationModel,
          documentModel,
          extractionModel,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to configure model routes.");
      }
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleInitializeDatabase = async () => {
    setLoading(true);
    setError(null);
    setInitProgress("Applying database migrations and seeding embedding spaces...");
    try {
      const res = await apiFetch("/api/v2/setup/database/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          databaseUrlDirect: databaseUrlDirect || databaseUrl,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setInitProgress(null);
        setSuccessMsg(
          `Database initialized! Applied ${data.appliedMigrations?.length || 0} migrations. Default workspace ready.`
        );
        await fetchStatus();
      } else {
        throw new Error(data.error || "Initialization failed.");
      }
    } catch (err) {
      setInitProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
        {/* Wizard Header */}
        <div className="bg-slate-900 text-white px-6 py-5 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Setup Job Decision Engine</h2>
            <p className="text-xs text-slate-400 mt-1">
              Step {step} of 5 &mdash;{" "}
              {step === 1 && "Welcome & Privacy Guarantee"}
              {step === 2 && "Neon PostgreSQL Database"}
              {step === 3 && "AI Provider Credentials"}
              {step === 4 && "Model Routing"}
              {step === 5 && "Database Initialization"}
            </p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-slate-400 hover:text-white text-sm px-2 py-1 rounded"
            >
              Skip
            </button>
          )}
        </div>

        {/* Wizard Progress Bar */}
        <div className="w-full bg-slate-100 h-1.5">
          <div
            className="bg-indigo-600 h-1.5 transition-all duration-300"
            style={{ width: `${(step / 5) * 100}%` }}
          />
        </div>

        {/* Wizard Content Body */}
        <div className="p-6 flex-1 space-y-5">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-lg">
              {successMsg}
            </div>
          )}

          {/* STEP 1: WELCOME */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-lg text-sm text-indigo-900 space-y-2">
                <p className="font-semibold text-base">Welcome to your Private Job Decision Engine</p>
                <p>
                  Job Decision Engine is a <strong>standalone desktop application</strong> running completely
                  on your local computer. There are no shared multi-tenant accounts, hosted backend servers, or developer APIs.
                </p>
              </div>

              <div className="space-y-3 text-sm text-slate-700">
                <h4 className="font-semibold text-slate-900">What you will need:</h4>
                <ul className="list-disc pl-5 space-y-2">
                  <li>
                    <strong>Neon PostgreSQL:</strong> A free serverless PostgreSQL database where your job observations,
                    evaluations, and decisions are stored under your sole ownership.
                  </li>
                  <li>
                    <strong>AI Provider Key:</strong> Google Gemini API key (recommended) or OpenAI API key.
                    Your credentials are encrypted using your operating system's native secure storage (DPAPI/Keychain)
                    and never sent to third-party services.
                  </li>
                </ul>
              </div>

              <div className="pt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 text-sm"
                >
                  Get Started &rarr;
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: NEON DATABASE */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                Enter your Neon PostgreSQL connection string. You can find this in your Neon console under Connection Details.
              </p>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Neon Connection String (Pooled or Direct)
                  </label>
                  <input
                    type="password"
                    placeholder="postgresql://user:pass@ep-xyz-pooler.region.neon.tech/neondb?sslmode=require"
                    value={databaseUrl}
                    onChange={(e) => setDatabaseUrl(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Direct (Unpooled) Connection String <span className="text-slate-400 font-normal">(Optional, required for schema migrations)</span>
                  </label>
                  <input
                    type="password"
                    placeholder="postgresql://user:pass@ep-xyz.region.neon.tech/neondb?sslmode=require"
                    value={databaseUrlDirect}
                    onChange={(e) => setDatabaseUrlDirect(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    If omitted, the engine will automatically derive the unpooled URL by removing <code>-pooler</code> from your host.
                  </p>
                </div>

                <div className="pt-2">
                  <button
                    type="button"
                    disabled={loading || !databaseUrl.trim()}
                    onClick={handleTestDatabase}
                    className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
                  >
                    {loading ? "Testing Connection..." : "Test Connection & Save"}
                  </button>
                </div>

                {dbTestResult && (
                  <div
                    className={`p-3 text-sm rounded-lg border ${
                      dbTestResult.ok
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : "bg-rose-50 border-rose-200 text-rose-800"
                    }`}
                  >
                    {dbTestResult.message}
                  </div>
                )}
              </div>

              <div className="pt-4 flex justify-between items-center border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
                >
                  &larr; Back
                </button>
                <button
                  type="button"
                  disabled={!dbTestResult?.ok && !status?.database.connected}
                  onClick={() => setStep(3)}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 text-sm disabled:opacity-50"
                >
                  Continue &rarr;
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: AI CREDENTIALS */}
          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                Configure your personal AI provider API key. Gemini 1.5 Flash is recommended for low latency and high quality.
              </p>

              <div className="space-y-4">
                <div className="p-4 border border-slate-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-800 uppercase tracking-wide">
                      Google Gemini API Key (Recommended)
                    </label>
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      Get Gemini Key &rarr;
                    </a>
                  </div>
                  <input
                    type="password"
                    placeholder="AIzaSy..."
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={loading || !geminiApiKey.trim()}
                    onClick={() => handleTestAi("gemini")}
                    className="px-3 py-1.5 bg-slate-800 text-white rounded text-xs font-medium hover:bg-slate-700 disabled:opacity-50"
                  >
                    Test & Save Gemini Key
                  </button>
                </div>

                <div className="p-4 border border-slate-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-800 uppercase tracking-wide">
                      OpenAI API Key (Optional)
                    </label>
                    <a
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      Get OpenAI Key &rarr;
                    </a>
                  </div>
                  <input
                    type="password"
                    placeholder="sk-proj-..."
                    value={openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={loading || !openaiApiKey.trim()}
                    onClick={() => handleTestAi("openai")}
                    className="px-3 py-1.5 bg-slate-800 text-white rounded text-xs font-medium hover:bg-slate-700 disabled:opacity-50"
                  >
                    Test & Save OpenAI Key
                  </button>
                </div>

                {aiTestResult && (
                  <div
                    className={`p-3 text-sm rounded-lg border ${
                      aiTestResult.ok
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : "bg-rose-50 border-rose-200 text-rose-800"
                    }`}
                  >
                    {aiTestResult.message}
                  </div>
                )}
              </div>

              <div className="pt-4 flex justify-between items-center border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
                >
                  &larr; Back
                </button>
                <button
                  type="button"
                  disabled={!aiTestResult?.ok && !status?.ai.geminiConfigured && !status?.ai.openaiConfigured}
                  onClick={() => setStep(4)}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 text-sm disabled:opacity-50"
                >
                  Continue &rarr;
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: MODEL ROUTING */}
          {step === 4 && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                Select your preferred model stack. Invariants ensure that deterministic gates run first before any AI model is invoked.
              </p>

              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setPreset("gemini")}
                  className={`flex-1 p-3 border rounded-lg text-left text-sm font-medium transition ${
                    preset === "gemini"
                      ? "border-indigo-600 bg-indigo-50 text-indigo-900"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <span className="block font-bold">Gemini Preset (Recommended)</span>
                  <span className="text-xs text-slate-500">
                    text-embedding-004 + gemini-1.5-flash
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setPreset("openai")}
                  className={`flex-1 p-3 border rounded-lg text-left text-sm font-medium transition ${
                    preset === "openai"
                      ? "border-indigo-600 bg-indigo-50 text-indigo-900"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <span className="block font-bold">OpenAI Preset</span>
                  <span className="text-xs text-slate-500">
                    text-embedding-3-small + gpt-4o-mini
                  </span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Embedding Model</label>
                  <input
                    type="text"
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Evaluation Model</label>
                  <input
                    type="text"
                    value={evaluationModel}
                    onChange={(e) => setEvaluationModel(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Document Generation Model</label>
                  <input
                    type="text"
                    value={documentModel}
                    onChange={(e) => setDocumentModel(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Extraction Model</label>
                  <input
                    type="text"
                    value={extractionModel}
                    onChange={(e) => setExtractionModel(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded font-mono"
                  />
                </div>
              </div>

              <div className="pt-4 flex justify-between items-center border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
                >
                  &larr; Back
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleSaveRoutes}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 text-sm disabled:opacity-50"
                >
                  Save Routes & Continue &rarr;
                </button>
              </div>
            </div>
          )}

          {/* STEP 5: INITIALIZATION */}
          {step === 5 && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                The final step is to prepare your Neon database schema. This creates the canonical job tables,
                audit ledgers, and registers embedding spaces.
              </p>

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-600">Database Status:</span>
                  <span className="font-semibold text-slate-900">
                    {status?.database.connected ? "Connected" : "Not Connected"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Schema Migrations:</span>
                  <span className="font-semibold text-slate-900">
                    {status?.database.isInitialized
                      ? `${status.database.appliedMigrations} applied, ${status.database.pendingMigrations} pending`
                      : "Uninitialized"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Active AI Provider:</span>
                  <span className="font-semibold text-slate-900">
                    {status?.ai.geminiConfigured ? "Gemini" : status?.ai.openaiConfigured ? "OpenAI" : "None"}
                  </span>
                </div>
              </div>

              {initProgress && (
                <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg flex items-center gap-2">
                  <span className="animate-spin inline-block w-4 h-4 border-2 border-amber-800 border-t-transparent rounded-full" />
                  <span>{initProgress}</span>
                </div>
              )}

              <div className="pt-2">
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleInitializeDatabase}
                  className="w-full py-3 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 text-sm disabled:opacity-50"
                >
                  {loading ? "Running Schema Migrations..." : "Initialize / Migrate Database"}
                </button>
              </div>

              <div className="pt-4 flex justify-between items-center border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
                >
                  &larr; Back
                </button>
                <button
                  type="button"
                  disabled={!status?.database.isInitialized || status.database.pendingMigrations > 0}
                  onClick={onComplete}
                  className="px-6 py-2.5 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 text-sm disabled:opacity-50"
                >
                  Launch Engine &rarr;
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
