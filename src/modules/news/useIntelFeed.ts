import {useCallback, useEffect, useRef, useState} from 'react';
import {type GuardianResult} from './guardianClient';
import {DEMO_INTEL} from './demoIntel';
import {geotag, severityFor, sectionToTag} from './geotag';
import {fetchIntel} from './intelAggregator';
import {parseDateMs} from './safeDate';

/**
 * Normalised Intel row rendered on the IntelFeed screen. The shape
 * intentionally matches the legacy hardcoded `WireItem` so we can drop
 * this feed in without touching the render layer.
 */
export interface IntelItem {
  id:            string;
  priority:      'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  priorityColor: string;
  priorityBg:    string;
  tag:           string;      // visual chip: POLITICAL / FINANCE / SECURITY ...
  headline:      string;
  loc:           string;      // "📍 UK" or "📍 GLOBAL"
  src:           string;      // "SOURCE: GUARDIAN"
  ts:            string;      // "23M AGO"
  accentColor:   string;
  lat?:          number;
  lng?:          number;
  webUrl:        string;      // deep link back to the article
  trailText?:    string;
  thumbnail?:    string;
}

const PRIORITY_PALETTE: Record<IntelItem['priority'], {color: string; bg: string; accent: string}> = {
  CRITICAL: {color: '#FF3B30', bg: 'rgba(255,59,48,0.12)',  accent: '#FF3B30'},
  HIGH:     {color: '#FFB800', bg: 'rgba(255,184,0,0.12)',  accent: '#FFB800'},
  MEDIUM:   {color: '#1E88FF', bg: 'rgba(30,136,255,0.12)', accent: '#1E88FF'},
  LOW:      {color: '#7E8AA6', bg: 'rgba(126,138,166,0.12)', accent: '#7E8AA6'},
};

function fmtAge(iso: string): string {
  const ms = parseDateMs(iso);
  if (ms === null) {return '—';} // invalid/missing date — avoid "NaND AGO"
  const delta = Date.now() - ms;
  const m = Math.floor(delta / 60000);
  if (m < 1)  {return 'NOW';}
  if (m < 60) {return `${m}M AGO`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}H AGO`;}
  const d = Math.floor(h / 24);
  return `${d}D AGO`;
}

export function toIntelItem(g: GuardianResult): IntelItem {
  const priority = severityFor(g.webTitle, g.sectionId);
  const palette  = PRIORITY_PALETTE[priority];
  const pin      = geotag(`${g.webTitle} ${g.fields?.trailText ?? ''}`);
  return {
    id:            g.id,
    priority,
    priorityColor: palette.color,
    priorityBg:    palette.bg,
    tag:           sectionToTag(g.sectionId),
    headline:      g.webTitle,
    loc:           pin ? `📍 ${pin.label}` : '📍 GLOBAL',
    src:           'SOURCE: GUARDIAN',
    ts:            fmtAge(g.webPublicationDate),
    accentColor:   palette.accent,
    lat:           pin?.lat,
    lng:           pin?.lng,
    webUrl:        g.webUrl,
    trailText:     g.fields?.trailText,
    thumbnail:     g.fields?.thumbnail,
  };
}

export type WireFilter = 'ALL' | 'CRITICAL' | 'SECURITY' | 'POLITICAL' | 'FINANCE' | 'MILITARY';

export interface UseIntelFeedState {
  items:    IntelItem[];
  loading:  boolean;
  error:    string | null;
  /** Count of upstream feeds that returned at least one item. */
  sources:  number;
  refresh:  () => Promise<void>;
}

/**
 * Fetches intel across every free source we have (Guardian + RSS +
 * Reddit + HackerNews), merges + dedupes, maps to IntelItem, and
 * returns hook-stable state. Refetches cancel in-flight requests so
 * rapid filter-flipping doesn't race.
 */
export function useIntelFeed(filter: WireFilter = 'ALL'): UseIntelFeedState {
  const [items,   setItems]   = useState<IntelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [sources, setSources] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const {results, sources: srcCount, failed, limited} = await fetchIntel(filter, ctrl.signal);
      if (ctrl.signal.aborted) {return;}
      if (results.length > 0) {
        setItems(results.map(toIntelItem));
        setSources(srcCount);
        setError(limited ? 'Guardian rate-limited — blending other sources' : null);
      } else if (failed) {
        // Every source failed — fall back to the bundled dataset so
        // the screen never shows a dead end.
        setItems(DEMO_INTEL.map(toIntelItem));
        setSources(0);
        setError('All feeds unreachable — showing demo intel');
      } else {
        setItems([]);
        setSources(srcCount);
        setError('No results for this filter');
      }
    } catch (e) {
      if ((e as {name?: string} | null)?.name === 'AbortError') {return;}
      setItems(DEMO_INTEL.map(toIntelItem));
      setSources(0);
      setError(e instanceof Error ? `${e.message} — showing demo intel` : 'Failed to load feed');
    } finally {
      if (!ctrl.signal.aborted) {setLoading(false);}
    }
  }, [filter]);

  useEffect(() => {
    void fetchNow();
    return () => { abortRef.current?.abort(); };
  }, [fetchNow]);

  return {items, loading, error, sources, refresh: fetchNow};
}
