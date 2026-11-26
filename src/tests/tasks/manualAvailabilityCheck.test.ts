import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { blockedLinkReason, loadJobBoardHosts } from "../../ingestion/availabilityCheckLinks.js";
import { fetchJobContent, postingRequestUrl } from "../../ingestion/jobContentFetcher.js";
import {
  AvailabilityCheckRefusal,
  availabilityCheckExitCode,
  checkDate,
  formatPlan,
  parseCheckArguments,
  requireApplyConfirmation,
  runAvailabilityCheckCommand,
  type CheckedJob,
} from "../../tasks/manualAvailabilityCheck.js";

// No network and no database: every link below is synthetic.
const BOARDS = ["himalayas.app", "remotive.com", "weworkremotely.com"];

afterEach(() => { vi.restoreAllMocks(); });

describe("links a manual check never requests", () => {
  it("leaves out LinkedIn, also behind redirect wrappers", () => {
    for (const url of [
      "https://www.linkedin.com/jobs/view/1", "https://sg.linkedin.com/comm/jobs/view/2", "https://lnkd.in/abc",
      "https://www.google.com/url?q=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F1",
      "https://outlook.office.com/?url=https%3A%2F%2Flnkd.in%2Fx",
      "https://abc.r.ap-southeast-1.awstrack.me/L0/https:%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F1/1/sig",
      "https://click.example.test/r?u=https%253A%252F%252Fwww.linkedin.com%252Fjobs%252Fview%252F1",
      "https://click.example.test/r/www.linkedin.com/jobs/view/1",
    ]) {
      expect(blockedLinkReason(url, BOARDS), url).toBe("LINKEDIN_LINK");
    }
  });

  it("leaves out aggregators and job-board feeds, and keeps employer and ATS links", async () => {
    expect(blockedLinkReason("https://www.mycareersfuture.gov.sg/job/it/x-1", BOARDS)).toBe("AGGREGATOR_LINK");
    expect(blockedLinkReason("https://sg.indeed.com/viewjob?jk=1", BOARDS)).toBe("AGGREGATOR_LINK");
    expect(blockedLinkReason("https://himalayas.app/companies/a/jobs/b", BOARDS)).toBe("JOB_BOARD_LINK");
    const hosts = await loadJobBoardHosts();
    for (const host of ["himalayas.app", "jobicy.com", "remotive.com", "weworkremotely.com"]) expect(hosts).toContain(host);
    for (const url of [
      "https://boards.greenhouse.io/acme/jobs/1", "https://jobs.ashbyhq.com/acme/uuid-1", "https://jobs.lever.co/acme/1",
      "https://acme.wd3.myworkdayjobs.com/site/job/x", "https://careers.example.test/jobs/1?utm_source=linkedin.com",
      "https://notlinkedin.com/jobs/1",
    ]) {
      expect(blockedLinkReason(url, hosts), url).toBeNull();
    }
  });

  it("leaves out country domains of listed aggregators and hosts written with trailing dots", () => {
    for (const url of ["https://www.glassdoor.co.uk/job/1", "https://www.glassdoor.sg/job/1", "https://indeed.fr/viewjob", "https://sg.indeed.com./x",
      "https://www.jobstreet.com.sg/job/1", "https://jobstreet.com.my/job/1", "https://www.monster.de/job/1", "https://monster.co.uk/x",
      "https://click.example.test/r/www.glassdoor.co.uk/job/1"]) {
      expect(blockedLinkReason(url, BOARDS), url).toBe("AGGREGATOR_LINK");
    }
    for (const url of ["https://www.linkedin.com./jobs/view/1", "https://linkedin.com../jobs/view/1", "https://lnkd.in./x",
      "https://click.example.test/r?u=https%3A%2F%2Fwww.linkedin.com.%2Fjobs%2Fview%2F1"]) {
      expect(blockedLinkReason(url, BOARDS), url).toBe("LINKEDIN_LINK");
    }
    for (const url of ["https://monsterbeverage.com/jobs/1", "https://indeed.example.test/jobs/1", "https://careers.glassdoorfittings.com/1"]) {
      expect(blockedLinkReason(url, BOARDS), url).toBeNull();
    }
  });

  it("paces every redirect hop and reports every status", async () => {
    const log: string[] = [];
    await fetchJobContent("https://careers.example.test/jobs/1", { title: "Engineer", companyName: "Acme" }, {
      beforeRequest: async (url) => { log.push(`wait ${url.pathname}`); },
      onResponse: (_url, status) => { log.push(`status ${status}`); },
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchOnce: async (url) => {
        log.push(`get ${url.pathname}`);
        const moved = url.pathname === "/jobs/1";
        const headers: Record<string, string> = moved ? { location: "/jobs/2" } : {};
        return { status: moved ? 301 : 429, headers, body: Buffer.alloc(0), url: url.toString() };
      },
    });
    expect(log).toEqual(["wait /jobs/1", "get /jobs/1", "status 301", "wait /jobs/2", "get /jobs/2", "status 429"]);
  });

  it("names the host that is actually requested", () => {
    expect(postingRequestUrl("https://job-boards.greenhouse.io/acme/jobs/12").hostname).toBe("boards-api.greenhouse.io");
    expect(postingRequestUrl("https://jobs.lever.co/acme/abc").hostname).toBe("api.lever.co");
    expect(postingRequestUrl("https://careers.example.test/jobs/1").hostname).toBe("careers.example.test");
  });

  it("never sends the request for a redirect that leads to a refused site", async () => {
    const requested: string[] = [];
    const result = await fetchJobContent("https://careers.example.test/jobs/1", { title: "Engineer", companyName: "Acme" }, {
      refuseRequest: (url) => blockedLinkReason(url.toString(), BOARDS) !== null,
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchOnce: async (url) => {
        requested.push(url.hostname);
        return { status: 302, headers: { location: "https://www.linkedin.com/jobs/view/1" }, body: Buffer.alloc(0), url: url.toString() };
      },
    });
    expect(result).toEqual({ kind: "BLOCKED", reason: "UNSAFE_REDIRECT" });
    expect(requested).toEqual(["careers.example.test"]);
  });
});

describe("command arguments and refusals", () => {
  const WORKSPACE = "11111111-1111-4111-8111-111111111111";
  const never = () => vi.fn(async (): Promise<pg.Client> => { throw new Error("must not connect"); });

  it("reads a chosen list from arguments, lines or a JSON array, and defaults to plan", () => {
    expect(parseCheckArguments(["--job-ids=a, b"])).toEqual({
      jobIds: ["a", "b"], lines: [1, 2], apply: false, confirmWorkspace: null, confirmPlan: null, intervalSeconds: 5,
    });
    expect(parseCheckArguments(["--jobs=f"], () => "# chosen\r\na\r\n\r\nb\r\n")).toMatchObject({ jobIds: ["a", "b"], lines: [2, 4] });
    expect(parseCheckArguments(["--jobs=f"], () => '\uFEFF["a","b"]').jobIds).toEqual(["a", "b"]);
    expect(() => parseCheckArguments([])).toThrow(/exactly one/);
    expect(() => parseCheckArguments(["--jobs=f"], () => " \n")).toThrow(/empty/);
    expect(() => parseCheckArguments(["--job-ids=a", "--target=production"])).toThrow(/Unknown argument/);
    expect(() => parseCheckArguments(["--job-ids=a", "--min-interval-seconds=0"])).toThrow(/at least 2/);
  });

  it("never echoes what a jobs file or argument holds", () => {
    const secret = "SECRET_VALUE=hunter2";
    for (const run of [
      () => parseCheckArguments(["--jobs=f"], () => `["${secret}"`),
      () => parseCheckArguments(["--jobs=f"], () => { throw new Error(secret); }),
      () => parseCheckArguments([`--${secret}`]),
    ]) {
      expect(run).toThrow(AvailabilityCheckRefusal);
      expect(run).not.toThrow(/hunter2/);
    }
  });

  it("an apply needs the environment confirmation, the workspace id and the confirmed plan", () => {
    const env = { AVAILABILITY_CHECK_APPLY_ALLOWED: "true" };
    const base = ["--job-ids=a", "--apply"];
    const full = parseCheckArguments([...base, `--confirm-workspace=${WORKSPACE}`, "--confirm-plan=abc"]);
    expect(() => requireApplyConfirmation(full, {})).toThrow(/AVAILABILITY_CHECK_APPLY_ALLOWED/);
    expect(() => requireApplyConfirmation(parseCheckArguments(base), env)).toThrow(/--confirm-workspace/);
    expect(() => requireApplyConfirmation(parseCheckArguments([...base, `--confirm-workspace=${WORKSPACE}`]), env)).toThrow(/--confirm-plan/);
    expect(() => requireApplyConfirmation(full, env)).not.toThrow();
  });

  it("never connects without REPLAY_DATABASE_URL, whatever DATABASE_URL says", async () => {
    const connect = never();
    await expect(runAvailabilityCheckCommand(["--job-ids=a"], { DATABASE_URL: "postgres://u:p@prod.invalid/db" }, { connect }))
      .rejects.toThrow(/REPLAY_DATABASE_URL/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("refuses a database that is not the approved replay branch, without naming its host or querying it further", async () => {
    const statements: string[] = [];
    const end = vi.fn(async () => undefined);
    const connect = async () => ({
      query: async (text: string) => {
        statements.push(text);
        return { rows: text.includes("neon.branch_id") ? [{ d: "neondb", b: "br-not-approved-000000" }] : [] };
      },
      end,
    }) as unknown as pg.Client;
    const run = runAvailabilityCheckCommand(["--job-ids=a"], {
      REPLAY_DATABASE_URL: "postgres://u:p@secret-host.invalid/neondb", REPLAY_BRANCH_ID: "br-approved-branch-000000",
    }, { connect });
    await expect(run).rejects.toThrow("Refusing to run: REPLAY_DATABASE_URL is not the approved replay branch.");
    await expect(run).rejects.not.toThrow(/secret-host/);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe("BEGIN READ ONLY");
    expect(end).toHaveBeenCalled();
  });

  it("exits non-zero on an error, an invisible verdict or when no read could tell", () => {
    const job = (result: CheckedJob["result"], visible: boolean | null = null): CheckedJob => ({ canonicalJobId: "a", result, detail: "", visible });
    expect(availabilityCheckExitCode([])).toBe(0);
    expect(availabilityCheckExitCode([job("OPEN", true), job("CANNOT_TELL")])).toBe(0);
    expect(availabilityCheckExitCode([job("ERROR")])).toBe(1);
    expect(availabilityCheckExitCode([job("OPEN", false)])).toBe(1);
    expect(availabilityCheckExitCode([job("CANNOT_TELL"), job("CANNOT_TELL")])).toBe(1);
  });

  it("counts the day in Asia/Singapore and prints sites, rate and exclusions", () => {
    expect(checkDate(new Date("2026-01-10T15:59:59Z"))).toBe("2026-01-10");
    expect(checkDate(new Date("2026-01-10T16:00:00Z"))).toBe("2026-01-11");
    const read = { line: 1, linkKey: "k", canonicalJobId: "a", jobVersionId: "v", site: "careers.example.test", intervalMs: 5000 };
    const text = formatPlan({ listed: 3, reads: [read, { ...read, canonicalJobId: "b" }], excluded: [{ line: 3, reason: "LINKEDIN_LINK" }], checkDate: "2026-01-11", planId: "plan-1" });
    expect(text).toContain("api.frankfurter.app");
    expect(text).toContain("plan id: plan-1 (check date 2026-01-11)");
    expect(text).toContain("posting links to read: 2");
    expect(text).toContain("careers.example.test: 2 request(s), at most 1 every 5s");
    expect(text).toContain("pauses add at least 5s");
    expect(text).toContain("LINKEDIN_LINK: 1 (lines 3)");
  });
});
