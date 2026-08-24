// @tollbooth/maze: corpus loader interface and the serving handler.
// Content is pre-generated (VI.17); serving cost is one corpus read plus a
// timer (AC-4.3) - never generation, never a busy-wait. Every response
// carries X-Robots-Tag and no-store: the maze must never leak into search
// indexes or CDN caches (VI.18 - poisoning the operator's SEO is a
// release-blocking bug).
import type { TollboothConfig } from "@tollbooth/core";

export interface MazeCorpus {
  pageCount: number;
  get(name: string): Promise<string | undefined>;
}

/** In-memory corpus (Workers, tests). */
export function corpusFromMap(pages: Map<string, string>): MazeCorpus {
  return {
    pageCount: pages.size,
    get: async (name) => pages.get(name),
  };
}

export interface MazeResponse {
  status: 200 | 404;
  body: string;
  headers: Record<string, string>;
}

export const PAGE_NAME_RE = /^page-\d{4}\.html$/;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const pageName = (i: number): string =>
  `page-${String(i).padStart(4, "0")}.html`;

/** The robots.txt lines the operator appends: keep every crawler out (VI.18). */
export function robotsFragment(prefix: string): string {
  return `# tollbooth maze - decoy pages, worthless to index\nUser-agent: *\nDisallow: ${prefix}/\n`;
}

export function makeMazeHandler(deps: {
  corpus: MazeCorpus;
  cfg: TollboothConfig;
  /** Injectable throttle timer; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}): (path: string) => Promise<MazeResponse> {
  const { corpus, cfg } = deps;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const prefix = cfg.maze.prefix;

  return async (path) => {
    if (path !== prefix && !path.startsWith(`${prefix}/`))
      return { status: 404, body: "", headers: {} };

    await sleep(cfg.maze.maze_delay_ms);

    const rest =
      path === prefix || path === `${prefix}/`
        ? "page-0000.html"
        : path.slice(prefix.length + 1);
    let body = PAGE_NAME_RE.test(rest) ? await corpus.get(rest) : undefined;
    if (body === undefined) {
      // Unknown paths under the prefix map deterministically onto the corpus:
      // the maze has no visible edges, and the same URL always shows the
      // same page (still static, still pre-generated).
      body = (await corpus.get(pageName(fnv1a(path) % corpus.pageCount))) ?? "";
    }
    return {
      status: 200,
      body: body.slice(0, cfg.maze.page_bytes_max),
      headers: {
        "x-robots-tag": "noindex, nofollow",
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    };
  };
}
