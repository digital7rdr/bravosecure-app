/**
 * Lightweight OpenGraph scraper for chat link previews.
 *
 * Runs entirely client-side — no CORS in React Native — so we can
 * hit the page directly, pull the `<meta property="og:*">` tags, and
 * render a card below the message. The scraper is deliberately
 * defensive:
 *   - 5s timeout so a slow host doesn't stall the UI
 *   - reject non-http(s) and non-200 responses
 *   - cap body read at 128KB so pathological pages can't blow memory
 *   - results cached in-memory for the app lifetime (good enough for
 *     a chat scroll; AsyncStorage persistence can come later)
 */

export interface LinkPreview {
  url:         string;
  title?:      string;
  description?: string;
  image?:      string;
  siteName?:   string;
}

const URL_RE = /\b(?:https?:\/\/)[^\s<>()]+[^\s<>().,!?;:'"]/i;
const cache  = new Map<string, Promise<LinkPreview | null>>();

export function firstUrlIn(text: string | null | undefined): string | null {
  if (!text) {return null;}
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}

/** Every http(s) URL in the text, in order. Used by the Links browser. */
export function allUrlsIn(text: string | null | undefined): string[] {
  if (!text) {return [];}
  return text.match(new RegExp(URL_RE.source, 'gi')) ?? [];
}

/**
 * Split a message body into plain/url segments so bubbles can render
 * tappable link spans without a second regex drifting from URL_RE.
 */
export function splitByUrls(text: string): Array<{text: string; url?: string}> {
  const re = new RegExp(URL_RE.source, 'gi');
  const out: Array<{text: string; url?: string}> = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) {out.push({text: text.slice(last, m.index)});}
    out.push({text: m[0], url: m[0]});
    last = m.index + m[0].length;
  }
  if (last < text.length) {out.push({text: text.slice(last)});}
  return out;
}

export function getLinkPreview(url: string): Promise<LinkPreview | null> {
  const normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) {return Promise.resolve(null);}
  const cached = cache.get(normalized);
  if (cached) {return cached;}
  const p = fetchPreview(normalized).catch(() => null);
  cache.set(normalized, p);
  return p;
}

async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const ctrl = new AbortController();
  const to   = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method:  'GET',
      signal:  ctrl.signal,
      headers: {'User-Agent': 'BravoSecure/1.0 LinkPreview'},
    });
    if (!res.ok) {return null;}
    const reader = res.body?.getReader?.();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder('utf-8');
      let total = 0;
      while (total < 131_072) {
        const {value, done} = await reader.read();
        if (done) {break;}
        html  += decoder.decode(value, {stream: true});
        total += value.byteLength;
      }
      try { void reader.cancel(); } catch { /* ignore */ }
    } else {
      // Fallback for RN's fetch where .body streams may be unavailable.
      html = await res.text();
      if (html.length > 131_072) {html = html.slice(0, 131_072);}
    }
    return parseMeta(url, html);
  } finally {
    clearTimeout(to);
  }
}

function parseMeta(url: string, html: string): LinkPreview {
  const pick = (prop: string): string | undefined => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      'i',
    );
    const m = html.match(re);
    return m?.[1];
  };
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const image = pick('og:image') ?? pick('twitter:image');
  const siteName = pick('og:site_name');
  const host = safeHost(url);
  return {
    url,
    title:       decodeEntities(pick('og:title') ?? pick('twitter:title') ?? titleTag ?? host ?? url),
    description: decodeEntities(pick('og:description') ?? pick('twitter:description') ?? pick('description') ?? ''),
    image:       image ? resolveUrl(url, image) : undefined,
    siteName:    decodeEntities(siteName ?? host ?? ''),
  };
}

function decodeEntities(s: string | undefined): string | undefined {
  if (!s) {return s;}
  // Just the handful the OG tag regex doesn't pre-filter — keeps this
  // dependency-free while covering the 95% case for page metadata.
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function resolveUrl(base: string, maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) {return maybeRelative;}
  try {
    const b = new URL(base);
    if (maybeRelative.startsWith('//')) {return `${b.protocol}${maybeRelative}`;}
    if (maybeRelative.startsWith('/'))  {return `${b.protocol}//${b.host}${maybeRelative}`;}
    return `${b.protocol}//${b.host}/${maybeRelative}`;
  } catch {
    return maybeRelative;
  }
}

function safeHost(url: string): string | undefined {
  try { return new URL(url).host; } catch { return undefined; }
}
