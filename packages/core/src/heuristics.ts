// D-4(c): conservative heuristics for traffic with no Web Bot Auth signature.
// A match means "anonymous agent" — offer-eligible, never maze-eligible
// (Constitution II.5). No match means human: ambiguity fails open (II.6).
// The lists are data on purpose — extend them here, exercised by
// test/fixtures/user-agents.ts.

/** Substrings that mark a self-announcing agent UA, matched case-insensitively. */
export const AGENT_UA_MARKERS = [
  "bot",
  "crawl",
  "spider",
  "scrape",
  "headless",
];

/** UAs containing these are NOT agents despite containing a marker (phone brands etc.). */
export const AGENT_UA_MARKER_EXCEPTIONS = ["cubot"];

/** Known HTTP-client UA prefixes, matched case-insensitively. */
export const AGENT_UA_PREFIXES = [
  "curl/",
  "wget/",
  "python-requests/",
  "python-urllib",
  "go-http-client/",
  "node-fetch/",
  "undici/",
  "axios/",
  "okhttp/",
  "java/",
  "libwww-perl/",
  "scrapy/",
  "httpie/",
  "aiohttp/",
];

export interface HeuristicSignals {
  userAgent: string;
  accept?: string;
  hasCookies: boolean;
  secFetchSite?: string;
}

export interface HeuristicResult {
  agent: boolean;
  /** Which rules fired — facts for the observe report, never a verdict. */
  matched: string[];
}

export function agentHeuristics(signals: HeuristicSignals): HeuristicResult {
  const matched: string[] = [];
  const ua = signals.userAgent.toLowerCase();

  if (ua && !AGENT_UA_MARKER_EXCEPTIONS.some((e) => ua.includes(e))) {
    const marker = AGENT_UA_MARKERS.find((m) => ua.includes(m));
    if (marker) matched.push(`ua-marker:${marker}`);
  }
  const prefix = AGENT_UA_PREFIXES.find((p) => ua.startsWith(p));
  if (prefix) matched.push(`ua-prefix:${prefix}`);

  // Browsers send text/html on navigations and Sec-Fetch-Site on everything;
  // an API client typically sends neither, and no cookies either.
  const acceptsHtml = (signals.accept ?? "").includes("text/html");
  if (!acceptsHtml && !signals.hasCookies && !signals.secFetchSite)
    matched.push("accept-no-html");

  return { agent: matched.length > 0, matched };
}
