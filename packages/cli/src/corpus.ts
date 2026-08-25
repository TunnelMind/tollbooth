// SPDX-License-Identifier: MIT
// D-5: the maze corpus generator. Pure and deterministic from a seed -
// integer-only PRNG so the same seed yields the same bytes on every
// platform. Pages are templated pseudo-articles from a wordlist grammar:
// plausible but valueless, no real content, no real names (Constitution
// VI.19), internal links only, each page within page_bytes_max. Generation
// happens at build/CLI time, never at request time (VI.17).

export interface CorpusOptions {
  seed: string;
  pages?: number;
  pageBytesMax?: number;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(state: number): () => number {
  let a = state;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ASCII-only wordlists: string length == byte length everywhere below.
const ADJECTIVES = [
  "adaptive",
  "ambient",
  "angular",
  "baseline",
  "buffered",
  "calibrated",
  "cascading",
  "composite",
  "damped",
  "diagonal",
  "discrete",
  "elastic",
  "fluted",
  "granular",
  "inverted",
  "laminar",
  "lateral",
  "modular",
  "nominal",
  "oblique",
  "periodic",
  "recessed",
  "resonant",
  "tempered",
];
const NOUNS = [
  "aperture",
  "armature",
  "bearing",
  "bracket",
  "carriage",
  "conduit",
  "coupling",
  "damper",
  "flange",
  "gasket",
  "gimbal",
  "housing",
  "impeller",
  "manifold",
  "membrane",
  "pivot",
  "plenum",
  "regulator",
  "reservoir",
  "servo",
  "spindle",
  "stanchion",
  "tolerance",
  "winding",
];
const VERBS = [
  "absorbs",
  "aligns",
  "balances",
  "converges on",
  "dampens",
  "displaces",
  "envelops",
  "equalizes",
  "intersects",
  "modulates",
  "offsets",
  "recenters",
  "redistributes",
  "retains",
  "stabilizes",
  "tensions",
];
const TAILS = [
  "across the interval",
  "against the datum plane",
  "at reduced amplitude",
  "before the second pass",
  "under sustained load",
  "with negligible drift",
  "within stated tolerance",
  "without lateral play",
];

const cap = (word: string): string =>
  `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** filename -> html; iteration order is generation order (page-0000 first). */
export function generateCorpus(opts: CorpusOptions): Map<string, string> {
  const pages = opts.pages ?? 2000;
  const pageBytesMax = opts.pageBytesMax ?? 4096;
  const rand = mulberry32(fnv1a(opts.seed));
  const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)] as T;
  const pageName = (i: number): string =>
    `page-${String(i).padStart(4, "0")}.html`;

  const sentence = () =>
    `The ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(VERBS)} the ${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(TAILS)}.`;
  const paragraph = () => {
    const count = 3 + Math.floor(rand() * 4);
    return `<p>${Array.from({ length: count }, sentence).join(" ")}</p>`;
  };

  const corpus = new Map<string, string>();
  for (let i = 0; i < pages; i++) {
    const title = `${cap(pick(ADJECTIVES))} ${cap(pick(NOUNS))} ${cap(pick(NOUNS))}`;
    const linkCount = 4 + Math.floor(rand() * 3);
    const links = Array.from({ length: linkCount }, () => {
      let target = Math.floor(rand() * pages);
      if (target === i) target = (target + 1) % pages;
      return `<li><a href="${pageName(target)}">${pick(ADJECTIVES)} ${pick(NOUNS)}</a></li>`;
    });

    const head = `<!doctype html>\n<title>${title}</title>\n<h1>${title}</h1>\n`;
    const tail = `<ul>\n${links.join("\n")}\n</ul>\n`;
    let body = "";
    // Fill with paragraphs while comfortably under the cap; the margin
    // covers the largest possible next paragraph.
    while (head.length + body.length + tail.length < pageBytesMax - 700) {
      body += `${paragraph()}\n`;
    }
    const html = head + body + tail;
    if (html.length > pageBytesMax)
      throw new Error(`page ${i} exceeds ${pageBytesMax} bytes`);
    corpus.set(pageName(i), html);
  }
  return corpus;
}

/** SHA-256 over the sorted (name, content) pairs - the corpus identity. */
export async function corpusHash(corpus: Map<string, string>): Promise<string> {
  const serialized = [...corpus.keys()]
    .sort()
    .map((name) => `${name}\n${corpus.get(name)}\n`)
    .join("");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
