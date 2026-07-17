/**
 * Intel aggregator.
 *
 * Fans out to every free news source we have (Guardian, RSS, Reddit,
 * HackerNews), merges the results, dedupes by URL + headline prefix,
 * and returns a single time-sorted list. Each source is allowed to
 * fail independently — one rate-limited endpoint won't wipe the feed.
 *
 * The per-filter query mapping lives here too so the UI only needs to
 * call `fetchIntel(filter)`.
 */

import {guardianClient, GuardianRateLimitError, type GuardianResult} from './guardianClient';
import {rssClient, RSS_SOURCES, type RssSource} from './rssClient';
import {redditClient, REDDIT_SOURCES, type RedditSource} from './redditClient';
import {hackerNewsClient} from './hackerNewsClient';
import {parseDateMs} from './safeDate';
import type {WireFilter} from './useIntelFeed';

export interface FetchIntelResult {
  results:  GuardianResult[];
  /** Number of source endpoints that returned data. */
  sources:  number;
  /** True when every network call failed — caller should show an error. */
  failed:   boolean;
  /** True when at least one source was rate-limited. */
  limited:  boolean;
}

interface GuardianQuery {
  section?: string;
  q?:       string;
}

function guardianQueryFor(filter: WireFilter): GuardianQuery {
  switch (filter) {
    case 'SECURITY':  return {q: 'security OR intelligence OR terror'};
    case 'POLITICAL': return {section: 'politics'};
    case 'FINANCE':   return {section: 'business'};
    case 'MILITARY':  return {q: 'military OR defence OR army OR navy'};
    case 'CRITICAL':  return {q: 'crisis OR attack OR emergency'};
    case 'ALL':
    default:          return {section: 'world'};
  }
}

/**
 * Decide which extra sources to hit for a given filter. Keyword-based
 * filters (SECURITY/MILITARY/CRITICAL) fan out wider because Guardian
 * has low volume on those topics; section-based filters stay focused.
 */
function auxSourcesFor(filter: WireFilter): {rss: RssSource[]; reddit: RedditSource[]; useHn: boolean} {
  switch (filter) {
    case 'SECURITY':
      return {
        rss:    RSS_SOURCES.filter(s => ['DEFENSE ONE', 'REUTERS', 'BBC'].includes(s.name)),
        reddit: REDDIT_SOURCES.filter(s => ['cybersecurity', 'worldnews'].includes(s.sub)),
        useHn:  true,
      };
    case 'MILITARY':
      return {
        rss:    RSS_SOURCES.filter(s => ['DEFENSE ONE', 'AL JAZEERA', 'REUTERS'].includes(s.name)),
        reddit: REDDIT_SOURCES.filter(s => ['geopolitics', 'worldnews'].includes(s.sub)),
        useHn:  false,
      };
    case 'POLITICAL':
      return {
        rss:    RSS_SOURCES.filter(s => ['NYT WORLD', 'BBC', 'DW', 'AP'].includes(s.name)),
        reddit: REDDIT_SOURCES.filter(s => ['geopolitics', 'worldnews'].includes(s.sub)),
        useHn:  false,
      };
    case 'FINANCE':
      return {rss: [], reddit: [], useHn: false};
    case 'CRITICAL':
      return {rss: RSS_SOURCES, reddit: REDDIT_SOURCES, useHn: true};
    case 'ALL':
    default:
      return {rss: RSS_SOURCES, reddit: REDDIT_SOURCES, useHn: true};
  }
}

/**
 * Heuristic keyword filter so the aggregated pool reflects the chip
 * the user picked. Guardian is already filtered server-side; we apply
 * this client-side to RSS / Reddit / HN only.
 */
function keywordMatch(filter: WireFilter, r: GuardianResult): boolean {
  if (filter === 'ALL') {return true;}
  const text = `${r.webTitle} ${r.fields?.trailText ?? ''}`.toLowerCase();
  switch (filter) {
    case 'SECURITY':
      return /(security|intelligence|terror|cyber|breach|hack|espionage|surveillance)/.test(text);
    case 'POLITICAL':
      return /(election|president|minister|parliament|government|sanction|diplomat|policy|vote)/.test(text);
    case 'FINANCE':
      return /(market|stock|economy|bank|inflation|trade|tariff|gdp|fund|finance|oil|currency)/.test(text);
    case 'MILITARY':
      return /(military|army|navy|defen[cs]e|troop|missile|strike|weapon|drone|nato|conflict|war)/.test(text);
    case 'CRITICAL':
      return /(crisis|attack|emergency|breaking|urgent|explosion|killed|evacuat|alert|warning)/.test(text);
    default:
      return true;
  }
}

/** Normalise a URL for dedup: strip query + hash + trailing slash. */
function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return u;
  }
}

function dedupe(results: GuardianResult[]): GuardianResult[] {
  const byUrl = new Map<string, GuardianResult>();
  const byTitle = new Map<string, GuardianResult>();
  for (const r of results) {
    const urlKey = normaliseUrl(r.webUrl);
    const titleKey = r.webTitle.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (byUrl.has(urlKey) || byTitle.has(titleKey)) {continue;}
    byUrl.set(urlKey, r);
    byTitle.set(titleKey, r);
  }
  return Array.from(byUrl.values());
}

export async function fetchIntel(
  filter: WireFilter,
  signal?: AbortSignal,
): Promise<FetchIntelResult> {
  const aux = auxSourcesFor(filter);
  const gq = guardianQueryFor(filter);

  // Fan out every call in parallel — each source handles its own errors
  // and rate limits internally. Guardian goes through the error model so
  // we can surface a "limited" banner; everything else returns [] on
  // failure rather than throwing.
  const guardianP = guardianClient
    .search({...gq, pageSize: 25, signal})
    .then(r => ({ok: true as const, results: r, limited: false}))
    .catch(e => {
      if (e instanceof GuardianRateLimitError) {
        return {ok: true as const, results: e.stale ?? [], limited: true};
      }
      return {ok: false as const, results: [] as GuardianResult[], limited: false};
    });
  const rssP    = aux.rss.length    ? rssClient.fetchAll(aux.rss, signal)       : Promise.resolve([] as GuardianResult[]);
  const redditP = aux.reddit.length ? redditClient.fetchAll(aux.reddit, signal) : Promise.resolve([] as GuardianResult[]);
  const hnP     = aux.useHn         ? hackerNewsClient.search(undefined, signal) : Promise.resolve([] as GuardianResult[]);

  const [guardian, rss, reddit, hn] = await Promise.all([guardianP, rssP, redditP, hnP]);

  // Apply the keyword filter to the aux sources so a user on SECURITY
  // doesn't see generic BBC World headlines leaking through.
  const auxAll = [...rss, ...reddit, ...hn].filter(r => keywordMatch(filter, r));

  const merged = [...guardian.results, ...auxAll];
  const deduped = dedupe(merged);

  // Newest-first; keeps Guardian-first bias because it hits the array
  // first AND most sources publish close to real time anyway. Invalid
  // dates sort to the bottom (treated as epoch 0) so a NaN comparator
  // can't scramble the order.
  deduped.sort((a, b) =>
    (parseDateMs(b.webPublicationDate) ?? 0) - (parseDateMs(a.webPublicationDate) ?? 0),
  );

  const activeSources =
    (guardian.results.length > 0 ? 1 : 0) +
    (rss.length    > 0 ? 1 : 0) +
    (reddit.length > 0 ? 1 : 0) +
    (hn.length     > 0 ? 1 : 0);

  return {
    results: deduped.slice(0, 60),
    sources: activeSources,
    failed:  !guardian.ok && auxAll.length === 0,
    limited: guardian.limited,
  };
}
