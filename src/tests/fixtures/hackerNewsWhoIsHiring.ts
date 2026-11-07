/**
 * Synthetic Hacker News "Who is hiring?" fixtures. Every company, comment,
 * user name and URL here is invented; no real HN comment text is used.
 */
export const HN_FIXTURE_BASE = "https://hn-api.example.test/v0";
export const HN_FIXTURE_THREAD_ID = 4_800_001;
/** 2026-11-01T15:00:00Z, when the synthetic thread and its comments were "posted". */
export const HN_FIXTURE_POSTED_AT = 1_793_545_200;
/** A clock well past the edit window of every fixture comment. */
export const HN_FIXTURE_NOW = new Date("2026-11-08T00:00:00.000Z");

export type HnFixtureItem = Record<string, unknown> | null;

const LONG_BODY = [
  "<p>We build a synthetic data and machine learning platform for regulated industries. You will design data engineering pipelines, own MLOps tooling, and work with researchers on LLM evaluation.",
  "<p>Requirements: several years building distributed systems in Python or Go, production experience with cloud data platforms, and clear written communication.",
].join("");

export function hnComment(id: number, text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    by: `fixture_user_${id}`,
    id,
    parent: HN_FIXTURE_THREAD_ID,
    text,
    time: HN_FIXTURE_POSTED_AT + (id % 1000),
    type: "comment",
    kids: [id + 100_000],
    ...overrides,
  };
}

export const HN_FIXTURE_COMMENTS: Record<number, HnFixtureItem> = {
  // Pipes, two roles in one segment, Singapore-or-remote, salary, URL segment.
  4_800_101: hnComment(4_800_101,
    "Quillfeather Labs | Senior ML Engineer, Data Platform Engineer | Singapore or REMOTE | Full-time | $150k-$190k + equity | <a href=\"https:&#x2F;&#x2F;quillfeather.example&#x2F;careers\" rel=\"nofollow\">https:&#x2F;&#x2F;quillfeather.example&#x2F;careers</a>"
      + LONG_BODY),
  // Missing salary; remote with a non-exclusive region; link only in the body.
  4_800_102: hnComment(4_800_102,
    "Northwind Genomics | Bioinformatics Data Engineer | Remote (APAC)"
      + "<p>We run genomics and computational biology pipelines for drug discovery partners."
      + "<p>Apply: <a href=\"https:&#x2F;&#x2F;jobs.northwind-genomics.example&#x2F;apply&#x2F;7\" rel=\"nofollow\">https:&#x2F;&#x2F;jobs.northwind-genomics.example&#x2F;apply&#x2F;...</a>"),
  // Several role segments.
  4_800_103: hnComment(4_800_103,
    "Lumen Ledger | Backend Engineer | Platform Architect | REMOTE<p>Market data and trading systems for a fintech platform."),
  // Hybrid Singapore; apply URL only inside the text.
  4_800_104: hnComment(4_800_104,
    "Tidewater Compliance | Solutions Architect | Hybrid, Singapore<p>RegTech and compliance automation for banks. Apply at <a href=\"https:&#x2F;&#x2F;tidewater.example&#x2F;jobs&#x2F;42\" rel=\"nofollow\">https:&#x2F;&#x2F;tidewater.example&#x2F;jobs&#x2F;42</a>"),
  // Non-conforming prose.
  4_800_105: hnComment(4_800_105, "We are a small friendly team building tools for gardeners. Ping me if curious!"),
  // Deleted and dead comments.
  4_800_106: { id: 4_800_106, deleted: true, parent: HN_FIXTURE_THREAD_ID, time: HN_FIXTURE_POSTED_AT + 106, type: "comment" },
  4_800_107: hnComment(4_800_107, "Spamco | Crypto Engineer | Anywhere", { dead: true }),
  // On-site only, never mentions remote or hybrid.
  4_800_108: hnComment(4_800_108, "Brickyard Robotics | Firmware Engineer | Boston, MA | ONSITE<p>Build motor controllers in our lab."),
  // Remote restricted to a foreign territory.
  4_800_109: hnComment(4_800_109, "Cobalt Analytics | Data Engineer | REMOTE (US only) | $140k-$160k<p>Analytics engineering for retailers."),
  // No pipes but a clear "X is hiring a Y" sentence.
  4_800_110: hnComment(4_800_110, "Fernleaf Health is hiring a Clinical Data Engineer<p>Healthcare data platform work, remote friendly."),
  // A funding amount is not a salary; unknown work mode stays unknown.
  4_800_111: hnComment(4_800_111, "Glimmer AI | AI Engineer | London | Series B, $30M raised<p>LLM tooling for analysts."),
};

export const HN_FIXTURE_COMMENT_IDS = Object.keys(HN_FIXTURE_COMMENTS).map(Number);

export function hnFixtureItems(options: {
  readonly comments?: Record<number, HnFixtureItem>;
  readonly threadKids?: readonly number[];
  /** Publish a newer hiring thread with this id (a new month). */
  readonly newerThreadId?: number;
} = {}): Record<string, HnFixtureItem> {
  const comments = options.comments ?? HN_FIXTURE_COMMENTS;
  const threadId = options.newerThreadId ?? HN_FIXTURE_THREAD_ID;
  const submitted = [4_800_002, HN_FIXTURE_THREAD_ID, 4_800_003, 4_700_000];
  if (options.newerThreadId) submitted.unshift(options.newerThreadId);
  const items: Record<string, HnFixtureItem> = {
    "user/whoishiring": { id: "whoishiring", created: 1_300_000_000, submitted },
    "item/4800002": { id: 4_800_002, by: "whoishiring", type: "story", title: "Ask HN: Who wants to be hired? (November 2026)", time: HN_FIXTURE_POSTED_AT, kids: [] },
    "item/4800003": { id: 4_800_003, by: "whoishiring", type: "story", title: "Ask HN: Freelancer? Seeking freelancer? (November 2026)", time: HN_FIXTURE_POSTED_AT, kids: [] },
    "item/4700000": { id: 4_700_000, by: "whoishiring", type: "story", title: "Ask HN: Who is hiring? (October 2026)", time: HN_FIXTURE_POSTED_AT - 2_600_000, kids: [4_700_001] },
    [`item/${HN_FIXTURE_THREAD_ID}`]: {
      id: HN_FIXTURE_THREAD_ID,
      by: "whoishiring",
      type: "story",
      title: "Ask HN: Who is hiring? (November 2026)",
      time: HN_FIXTURE_POSTED_AT,
      // HN orders kids by rank, not by id.
      kids: options.newerThreadId ? Object.keys(HN_FIXTURE_COMMENTS).map(Number).reverse() : options.threadKids ?? Object.keys(comments).map(Number).reverse(),
    },
  };
  if (options.newerThreadId) {
    items[`item/${options.newerThreadId}`] = {
      id: options.newerThreadId,
      by: "whoishiring",
      type: "story",
      title: "Ask HN: Who is hiring? (December 2026)",
      time: HN_FIXTURE_POSTED_AT + 2_600_000,
      kids: options.threadKids ?? Object.keys(comments).map(Number).reverse(),
    };
  }
  for (const [id, item] of Object.entries(comments)) {
    items[`item/${id}`] = item && options.newerThreadId ? { ...item, parent: threadId } : item;
  }
  return items;
}

/** A fetch stub that serves `items` by API path and records every requested path. */
export function hnFetchStub(items: Record<string, HnFixtureItem>, hooks: {
  readonly respond?: (path: string) => Response | Promise<Response> | undefined;
  readonly delayMs?: number;
} = {}) {
  const requested: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(`${HN_FIXTURE_BASE}/`, "").replace(/\.json$/, "");
    requested.push(path);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (hooks.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, hooks.delayMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      const custom = await hooks.respond?.(path);
      if (custom) return custom;
      if (!(path in items)) return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(items[path]), { status: 200, headers: { "Content-Type": "application/json" } });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetchImpl, requested, maxInFlight: () => maxInFlight };
}
