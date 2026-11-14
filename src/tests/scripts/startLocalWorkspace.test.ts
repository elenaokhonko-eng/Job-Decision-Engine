import { describe, expect, it, vi } from "vitest";

import {
  API_HOST,
  buildWorkspaceLaunchPlan,
  describeLaunchPlan,
  waitForApiHealth,
  type FetchLike,
} from "../../../scripts/start_local_workspace.js";

const SECRET = "s3cr3t-token-value-should-never-be-printed";

describe("local workspace launch plan", () => {
  it("passes one token to both children and points Streamlit at the loopback API", () => {
    const plan = buildWorkspaceLaunchPlan({
      env: { PATH: "/bin", JDEC_API_BASE_URL: "https://elsewhere.example", NODE_ENV: "production" },
      envFile: { JDEC_API_TOKEN: SECRET },
      platform: "linux",
      generateToken: () => "unused",
    });
    expect(plan.tokenSource).toBe("ENV_FILE");
    expect(plan.apiEnv.JDEC_API_TOKEN).toBe(SECRET);
    expect(plan.apiEnv.API_TOKEN).toBe(SECRET);
    expect(plan.streamlitEnv.JDEC_API_TOKEN).toBe(SECRET);
    expect(plan.apiEnv.API_HOST).toBe("127.0.0.1");
    expect(plan.apiEnv.PORT).toBe("3000");
    // production would make the API bind 0.0.0.0 by default; the launcher never does.
    expect(plan.apiEnv.NODE_ENV).toBe("development");
    expect(plan.apiBaseUrl).toBe("http://127.0.0.1:3000");
    expect(plan.streamlitEnv.JDEC_API_BASE_URL).toBe("http://127.0.0.1:3000");
    expect(plan.streamlitEnv.JDEC_RUNTIME_MODE).toBe("local");
    expect(plan.pythonCommand).toBe("python3");
    expect(plan.streamlitArgs).toEqual([
      "-m", "streamlit", "run", "streamlit_app.py",
      "--server.address", API_HOST, "--server.port", "8501",
    ]);
  });

  it("prefers the process environment, then .env.local, then an ephemeral token", () => {
    const fromEnv = buildWorkspaceLaunchPlan({
      env: { JDEC_API_TOKEN: " env-token " }, envFile: { JDEC_API_TOKEN: "file-token" }, platform: "win32",
    });
    expect(fromEnv.tokenSource).toBe("ENVIRONMENT");
    expect(fromEnv.streamlitEnv.JDEC_API_TOKEN).toBe("env-token");
    expect(fromEnv.pythonCommand).toBe("python");

    const generateToken = vi.fn(() => "ephemeral-token");
    const ephemeral = buildWorkspaceLaunchPlan({ env: {}, envFile: {}, platform: "linux", generateToken });
    expect(generateToken).toHaveBeenCalledOnce();
    expect(ephemeral.tokenSource).toBe("EPHEMERAL");
    expect(ephemeral.apiEnv.JDEC_API_TOKEN).toBe("ephemeral-token");
    expect(ephemeral.streamlitEnv.JDEC_API_TOKEN).toBe("ephemeral-token");

    const random = buildWorkspaceLaunchPlan({ env: {}, envFile: {}, platform: "linux" });
    expect(random.apiEnv.JDEC_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honours port and python overrides and rejects invalid ports", () => {
    const plan = buildWorkspaceLaunchPlan({
      env: { JDEC_WORKSPACE_API_PORT: "3100", JDEC_WORKSPACE_STREAMLIT_PORT: "8600", JDEC_PYTHON: "C:/Python312/python.exe" },
      envFile: {}, platform: "win32", generateToken: () => "t",
    });
    expect(plan.apiBaseUrl).toBe("http://127.0.0.1:3100");
    expect(plan.streamlitArgs.at(-1)).toBe("8600");
    expect(plan.pythonCommand).toBe("C:/Python312/python.exe");
    expect(() => buildWorkspaceLaunchPlan({ env: { JDEC_WORKSPACE_API_PORT: "abc" }, envFile: {}, platform: "linux" }))
      .toThrow(/port number/);
    expect(() => buildWorkspaceLaunchPlan({ env: { JDEC_WORKSPACE_API_PORT: "70000" }, envFile: {}, platform: "linux" }))
      .toThrow(/between 1 and 65535/);
    expect(() => buildWorkspaceLaunchPlan({
      env: { JDEC_WORKSPACE_API_PORT: "8501" }, envFile: {}, platform: "linux",
    })).toThrow(/different ports/);
  });

  it("never prints the token", () => {
    const sources: Array<{ env: NodeJS.ProcessEnv; envFile: Record<string, string>; generateToken?: () => string }> = [
      { env: { JDEC_API_TOKEN: SECRET }, envFile: {} },
      { env: {}, envFile: { JDEC_API_TOKEN: SECRET } },
      { env: {}, envFile: {}, generateToken: () => SECRET },
    ];
    for (const tokenSource of sources) {
      const plan = buildWorkspaceLaunchPlan({ ...tokenSource, platform: "linux" });
      const printed = describeLaunchPlan(plan).join("\n");
      expect(printed).not.toContain(SECRET);
      expect(printed).toContain("not shown");
    }
  });
});

describe("waiting for the API", () => {
  function response(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it("polls the authenticated health route until it answers ok", async () => {
    const replies = [
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => Promise.resolve(response(503, { message: "Database is not configured yet." })),
      () => Promise.resolve(response(200, { ok: true })),
    ];
    const fetchImpl = vi.fn<FetchLike>(() => replies.shift()!());
    await waitForApiHealth({
      baseUrl: "http://127.0.0.1:3000", token: SECRET, fetchImpl, sleep: async () => undefined,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3000/api/v2/health", {
      headers: { Authorization: `Bearer ${SECRET}`, Accept: "application/json" },
    });
  });

  it("fails fast when another server rejects the token or the API process exits", async () => {
    await expect(waitForApiHealth({
      baseUrl: "http://127.0.0.1:3000", token: SECRET,
      fetchImpl: async () => response(401, { ok: false }), sleep: async () => undefined,
    })).rejects.toThrow(/rejected this session's API token/);

    await expect(waitForApiHealth({
      baseUrl: "http://127.0.0.1:3000", token: SECRET, isAlive: () => false,
      fetchImpl: async () => response(200, { ok: true }), sleep: async () => undefined,
    })).rejects.toThrow(/exited before it became healthy/);
  });

  it("times out with the last problem and without the token", async () => {
    let clock = 0;
    const error = await waitForApiHealth({
      baseUrl: "http://127.0.0.1:3000", token: SECRET, timeoutMs: 1000, intervalMs: 400,
      fetchImpl: async () => response(503, { message: "Database is not configured yet." }),
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("HTTP 503: Database is not configured yet.");
    expect((error as Error).message).not.toContain(SECRET);
  });
});
