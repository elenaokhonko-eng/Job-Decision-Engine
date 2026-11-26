/**
 * Which links a manual availability check must never request: LinkedIn, the job aggregators of
 * aggregatorHosts.ts, and the job-board feeds of the source manifests (kind json_api or rss).
 * A wrapper or redirect link that carries such a URL counts as that URL.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { loadStructuredFile } from "../config/structuredLoader.js";
import { SourcePluginSchema } from "../contracts/index.js";
import { aggregatorHostOf } from "./aggregatorHosts.js";
import { unwrapForClassification } from "./emailAlertExtractor.js";
import { postingRequestUrl } from "./jobContentFetcher.js";

export type BlockedLinkReason = "LINKEDIN_LINK" | "AGGREGATOR_LINK" | "JOB_BOARD_LINK";

/** LinkedIn's own domains: the site (also in AGGREGATOR_HOSTS), its short links and its media CDN. */
const LINKEDIN_DOMAINS = ["linkedin.com", "lnkd.in", "licdn.com"];
const JOB_BOARD_KINDS = new Set(["json_api", "rss"]);

const bareHost = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** Hosts of the job-board feed sources. A manifest that cannot be read fails the whole check. */
export async function loadJobBoardHosts(directory = path.resolve(process.cwd(), "config", "source-plugins")): Promise<string[]> {
  const hosts = new Set<string>();
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".yml"));
  if (files.length === 0) throw new Error("No source plugin manifests were found.");
  for (const file of files) {
    const plugin = (await loadStructuredFile(path.join(directory, file), SourcePluginSchema)).data;
    if (!JOB_BOARD_KINDS.has(plugin.kind)) continue;
    hosts.add(bareHost(new URL(plugin.request.endpoint).hostname));
    for (const host of plugin.availability?.full_posting_hosts ?? []) hosts.add(bareHost(host));
  }
  return [...hosts].sort();
}

function hostReason(hostname: string, jobBoardHosts: readonly string[]): BlockedLinkReason | null {
  const host = bareHost(hostname);
  if (LINKEDIN_DOMAINS.some((domain) => onDomain(host, domain))) return "LINKEDIN_LINK";
  if (aggregatorHostOf(host) !== null) return "AGGREGATOR_LINK";
  return jobBoardHosts.some((board) => onDomain(host, board)) ? "JOB_BOARD_LINK" : null;
}

function percentDecoded(value: string): string {
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
}

/** URLs carried inside a link: a full URL, or "host/path" written as a path segment or parameter value. */
const CARRIED_URL = /(?:https?:\/\/|[=/?&#])((?:[a-z0-9-]+\.)+[a-z]{2,})\.?(?::\d+)?\//gi;

export function blockedLinkReason(link: string, jobBoardHosts: readonly string[]): BlockedLinkReason | null {
  const candidates = [link, unwrapForClassification(link)];
  try {
    candidates.push(postingRequestUrl(link).toString());
  } catch {
    // Not a readable http(s) link; the host checks below still apply to what can be parsed.
  }
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const direct = hostReason(url.hostname, jobBoardHosts);
    if (direct !== null) return direct;
    const carried = percentDecoded(`${url.pathname}${url.search}${url.hash}`);
    for (const match of carried.matchAll(CARRIED_URL)) {
      const reason = hostReason(match[1]!, jobBoardHosts);
      if (reason !== null) return reason;
    }
  }
  return null;
}
