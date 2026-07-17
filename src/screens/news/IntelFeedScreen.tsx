import React, {useState, useRef, useEffect, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Animated,
  Modal,
  Pressable,
  StatusBar,
  ActivityIndicator,
  Linking,
  type DimensionValue,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import WebView, {type WebViewMessageEvent} from 'react-native-webview';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {useIntelFeed, type WireFilter as FeedFilter, type IntelItem} from '@/modules/news/useIntelFeed';
import {clusterMarkers, type MapMarker} from '@/modules/news/mapbox';
import {BRAVO_MAP_HTML} from '@/modules/news/bravoMapHtml';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {scaleTextStyles} from '@utils/scaling';

// ── Types ──────────────────────────────────────────────────────────────────
type IntelTab = 'map' | 'wire' | 'signals';
type WireFilter = FeedFilter;
type WireItem = IntelItem;

interface Signal {
  name: string;
  region: string;
  value: number;
  color: string;
  sectionBg: string;
  sectionBorder: string;
}


// Why: hoisted so the WebView `source` prop stays referentially stable across renders.
const MAP_SOURCE = {html: BRAVO_MAP_HTML};

// ── Signals data ────────────────────────────────────────────────────────────
const SIGNALS_CRITICAL: Signal[] = [
  {name:'Red Sea Corridor', region:'MARITIME · MILITARY', value:92, color:'#FF3B30', sectionBg:'rgba(255,59,48,0.04)', sectionBorder:'rgba(255,59,48,0.3)'},
  {name:'Sudan-Chad Border', region:'GROUND · ARMED', value:88, color:'#FF3B30', sectionBg:'rgba(255,59,48,0.04)', sectionBorder:'rgba(255,59,48,0.3)'},
  {name:'UAE Cyber Grid', region:'CYBER · INFRASTRUCTURE', value:79, color:'#FF3B30', sectionBg:'rgba(255,59,48,0.03)', sectionBorder:'rgba(255,59,48,0.25)'},
];
const SIGNALS_HIGH: Signal[] = [
  {name:'Riyadh Protest Zone', region:'CIVIL · POLITICAL', value:64, color:'#FFB800', sectionBg:'transparent', sectionBorder:'rgba(255,184,0,0.25)'},
  {name:'Arabian Sea Ops', region:'NAVAL · EXERCISES', value:58, color:'#FFB800', sectionBg:'transparent', sectionBorder:'rgba(255,184,0,0.2)'},
];
const SIGNALS_MEDIUM: Signal[] = [
  {name:'Moscow Tensions', region:'DIPLOMATIC · POLITICAL', value:45, color:'#60A5FA', sectionBg:'transparent', sectionBorder:'#1E2D45'},
  {name:'London Finance', region:'ECONOMIC · TRADE', value:32, color:'#60A5FA', sectionBg:'transparent', sectionBorder:'#1E2D45'},
  {name:'Singapore Maritime', region:'TRADE · SHIPPING', value:24, color:'#2563EB', sectionBg:'transparent', sectionBorder:'#1E2D45'},
];

// ── Ticker fallback — used only when no live items have loaded yet ─────────
const TICKER_FALLBACK = [
  {color: '#1E88FF', text: 'CONNECTING · Live intel stream initialising'},
];

function tickerTextFor(item: IntelItem): string {
  const prefix = item.priority === 'CRITICAL' ? 'CRIT'
               : item.priority === 'HIGH'     ? 'HIGH'
               : item.priority === 'MEDIUM'   ? 'MED'  : 'LOW';
  // Trim so the ticker row stays on one line on small phones.
  const short = item.headline.length > 90 ? `${item.headline.slice(0, 90)}…` : item.headline;
  return `${prefix} · ${short}`;
}

// ── Component ───────────────────────────────────────────────────────────────
export default function IntelFeedScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<IntelTab>('map');
  const [wireFilter, setWireFilter] = useState<WireFilter>('ALL');
  const [drawerItem, setDrawerItem] = useState<WireItem | null>(null);
  // Why: once the map tab has been visited we keep the WebView mounted (hidden)
  // so tab switches don't re-boot Leaflet + refetch the CDN basemap.
  const [mapVisited, setMapVisited] = useState(false);
  useEffect(() => {
    if (activeTab === 'map' && !mapVisited) {setMapVisited(true);}
  }, [activeTab, mapVisited]);
  const [time, setTime] = useState(() => {
    const n = new Date();
    return `${n.getUTCHours().toString().padStart(2,'0')}:${n.getUTCMinutes().toString().padStart(2,'0')}:${n.getUTCSeconds().toString().padStart(2,'0')}`;
  });

  // Live Guardian feed (refetches on filter change). `items` already
  // carries pre-computed priorityColor/bg + geotag lat/lng so the
  // renderers below stay pure.
  const {items, loading, error, refresh} = useIntelFeed(wireFilter);

  // Leaflet WebView bridge — we own the native RN chrome (nav/tabs/
  // stats/ticker) and the WebView owns just the map canvas. Markers
  // are pushed in whenever the intel feed refreshes via
  // `window.updateThreats([...])`.
  const mapWebViewRef = useRef<WebView>(null);
  const mapReady      = useRef(false);
  // B-89 MG-10 — watchdog + remount recovery (same machinery as the GL maps).
  const mapHealth     = useMapReload();

  const mapMarkers = useMemo<MapMarker[]>(
    () => items
      .filter(i => typeof i.lat === 'number' && typeof i.lng === 'number')
      .map(i => ({lng: i.lng!, lat: i.lat!, severity: i.priority, label: i.loc.replace('📍 ', '')})),
    [items],
  );
  const clusters = useMemo(() => clusterMarkers(mapMarkers), [mapMarkers]);

  // Serialise the current clusters as the JS the WebView should run.
  // Using a ref + an effect keeps the bridge idempotent — if the WebView
  // signals `ready` after our first render we flush whatever we have.
  const threatsJs = useMemo(() => {
    const data = clusters.map(c => ({
      lat:      c.lat,
      lng:      c.lng,
      severity: c.severity,
      count:    c.count,
      label:    c.label,
    }));
    return `window.updateThreats && window.updateThreats(${JSON.stringify(data)}); true;`;
  }, [clusters]);

  useEffect(() => {
    if (mapReady.current) {mapWebViewRef.current?.injectJavaScript(threatsJs);}
  }, [threatsJs]);

  const handleMapMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {type: string; payload?: {lat?: number; lng?: number; label?: string}};
      if (msg.type === 'ready') {
        mapReady.current = true;
        mapHealth.onReady();
        mapWebViewRef.current?.injectJavaScript(threatsJs);
        return;
      }
      if (msg.type === 'markerPress' && msg.payload?.lat !== undefined && msg.payload?.lng !== undefined) {
        const cluster = clusters.find(c => c.lat === msg.payload!.lat && c.lng === msg.payload!.lng);
        if (cluster) {openRegion(cluster);}
      }
    } catch {
      /* ignore malformed payloads */
    }
  };

  // Group the ITEMS (not clusters) per bucket key so tapping a bubble
  // can reveal every headline from that region.
  const regionHits = useMemo(() => {
    const m = new Map<string, IntelItem[]>();
    for (const it of items) {
      if (typeof it.lat !== 'number' || typeof it.lng !== 'number') {continue;}
      const key = `${Math.round(it.lat)}_${Math.round(it.lng)}`;
      const arr = m.get(key) ?? [];
      arr.push(it);
      m.set(key, arr);
    }
    return m;
  }, [items]);

  // On any bubble tap we synthesise a region drawer item whose summary
  // is the list of headlines — matches the preview's multi-article pane.
  const openRegion = (c: ReturnType<typeof clusterMarkers>[number]) => {
    const key = `${Math.round(c.lat)}_${Math.round(c.lng)}`;
    const hits = regionHits.get(key) ?? [];
    if (hits.length === 0) {return;}
    const headline = hits[0].headline;
    const aggregate: WireItem = {
      ...hits[0],
      id:       `REGION-${key}`,
      headline,
      loc:      `📍 ${c.label}`,
      src:      `SOURCE: GUARDIAN · ${hits.length} HEADLINE${hits.length === 1 ? '' : 'S'}`,
      // Carry the rest of the stack via trailText so the drawer can list them.
      trailText: hits.slice(0, 8).map((h, i) => `${i + 1}. ${h.headline}`).join('\n'),
      webUrl:   hits[0].webUrl,
    };
    openDrawer(aggregate);
  };

  const tickerAnim = useRef(new Animated.Value(0)).current;
  const drawerAnim = useRef(new Animated.Value(300)).current;

  // Clock
  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date();
      setTime(`${n.getUTCHours().toString().padStart(2,'0')}:${n.getUTCMinutes().toString().padStart(2,'0')}:${n.getUTCSeconds().toString().padStart(2,'0')}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Ticker scroll
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(tickerAnim, {toValue: -1200, duration: 60000, useNativeDriver: true}),
    );
    loop.start();
    return () => loop.stop();
  }, [tickerAnim]);

  const openDrawer = (item: WireItem) => {
    setDrawerItem(item);
    drawerAnim.setValue(400);
    Animated.spring(drawerAnim, {toValue: 0, useNativeDriver: true, tension: 60, friction: 10}).start();
  };

  const closeDrawer = () => {
    Animated.timing(drawerAnim, {toValue: 400, duration: 220, useNativeDriver: true}).start(() => setDrawerItem(null));
  };

  // The Guardian query is already filtered server-side (section / q) so
  // `items` is the right set for the Wire tab; we just surface the
  // in-flight + error state alongside it.
  const filteredWire = items;

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor="#0A0F1E" />

      {/* Top Bar */}
      <View style={styles.topbar}>
        <View style={styles.topLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={18} color="#64748B" />
          </TouchableOpacity>
          <View>
            <Text style={styles.logoText}>▌BRAVO INTEL</Text>
            <Text style={styles.logoSub}>GLOBAL INTELLIGENCE FEED</Text>
          </View>
        </View>
        <View style={styles.topRight}>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>LIVE FEED</Text>
          </View>
          <Text style={styles.clock}>{time} UTC</Text>
          <Text style={styles.coords}>25°2'N · 55°22'E</Text>
        </View>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabbar}>
        {([
          {id:'map', label:'BRAVO MAP'},
          {id:'wire', label:'BRAVO INTEL', count: items.length ? String(items.length) : undefined, countColor: Colors.primary},
          {id:'signals', label:'SIGNALS', count: String(items.filter(i => i.priority === 'CRITICAL').length || ''), countColor:'#FF3B30'},
        ] as {id:IntelTab; label:string; count?:string; countColor?:string}[]).map(tab => (
          <TouchableOpacity key={tab.id}
            style={[styles.tab, activeTab === tab.id && styles.tabActive]}
            onPress={() => setActiveTab(tab.id)} activeOpacity={0.7}>
            <View style={{flexDirection:'row', alignItems:'center', gap:4}}>
              <Text style={[styles.tabText, activeTab === tab.id && styles.tabTextActive]}>{tab.label}</Text>
              {tab.count && (
                <View style={[styles.tabCount, {backgroundColor: tab.countColor + '26'}]}>
                  <Text style={[styles.tabCountText, {color: tab.countColor}]}>{tab.count}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      <View style={styles.content}>

        {/* ── BRAVO MAP ── Leaflet inside a WebView, countries filled
            in Bravo primary via a GeoJSON overlay. Pan/zoom is Leaflet
            native — inertia, momentum, pinch, easing all for free.
            Marker presses cross the bridge as postMessage so the
            region drawer opens on tap. */}
        {(activeTab === 'map' || mapVisited) && (
          <View
            style={activeTab === 'map' ? styles.mapContainer : styles.mapHidden}
            pointerEvents={activeTab === 'map' ? 'auto' : 'none'}>
            {/* B-89 MG-10 — this was the ONE map surface the B-77 recovery
                skipped: no renderer-crash handler, no watchdog, no RETRY —
                a CDN-blocked Leaflet fetch or a WebView renderer kill left
                a permanent blank. Same useMapReload pattern as the GL maps
                (the HTML posts 'ready' on load). */}
            <WebView
              key={`intel-map-${mapHealth.reloadKey}`}
              ref={mapWebViewRef}
              originWhitelist={['*']}
              source={MAP_SOURCE}
              style={styles.mapWebView}
              containerStyle={styles.mapWebView}
              onMessage={handleMapMessage}
              javaScriptEnabled
              domStorageEnabled
              mixedContentMode="compatibility"
              setSupportMultipleWindows={false}
              scrollEnabled={false}
              bounces={false}
              overScrollMode="never"
              androidLayerType="hardware"
              textZoom={100}
              allowsInlineMediaPlayback
              thirdPartyCookiesEnabled={false}
              onRenderProcessGone={mapHealth.retry}
              onContentProcessDidTerminate={mapHealth.retry}
              startInLoadingState
              renderLoading={() => (
                <View style={styles.mapLoadingOverlay}>
                  <ActivityIndicator color={Colors.primary} />
                  <Text style={styles.mapLoadingText}>BOOTING BRAVO MAP…</Text>
                </View>
              )}
            />
            {mapHealth.status === 'failed' && <MapFailedOverlay onRetry={mapHealth.retry} />}

            {loading && items.length === 0 && (
              <View style={styles.mapLoadingOverlay} pointerEvents="none">
                <ActivityIndicator color={Colors.primary} />
                <Text style={styles.mapLoadingText}>FETCHING INTEL…</Text>
              </View>
            )}

            {/* Map bottom info */}
            <View style={styles.mapInfo}>
              <View style={styles.mapStatRow}>
                {[
                  {label: 'CRITICAL', value: String(items.filter(i => i.priority === 'CRITICAL').length), color: '#FF3B30'},
                  {label: 'HIGH',     value: String(items.filter(i => i.priority === 'HIGH').length),     color: '#FFB800'},
                  {label: 'TRACKED',  value: String(items.length),                                        color: Colors.primary},
                  {label: 'LOCATED',  value: String(clusters.length),                                     color: '#94A3B8'},
                ].map(s => (
                  <View key={s.label} style={styles.mapStat}>
                    <Text style={styles.mapStatLabel}>{s.label}</Text>
                    <Text style={[styles.mapStatValue, {color: s.color}]}>{s.value}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.mapCoords}>SOURCE: GUARDIAN · RSS · REDDIT · HN · BRAVO MAP</Text>
            </View>
          </View>
        )}

        {/* ── WIRE TAB ── */}
        {activeTab === 'wire' && (
          <View style={styles.wireContainer}>
            <View style={styles.wireHeader}>
              <Text style={styles.wireHeaderLabel}>INTEL STREAM</Text>
              <View style={styles.wireHeaderRight}>
                <View style={styles.liveDotSmall} />
                <Text style={styles.wireCount}>{filteredWire.length} ITEMS</Text>
              </View>
            </View>
            {/* Filter chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              style={styles.filterChipsWrap} contentContainerStyle={styles.filterChipsContent}>
              {(['ALL','CRITICAL','SECURITY','POLITICAL','FINANCE','MILITARY'] as WireFilter[]).map(f => (
                <TouchableOpacity key={f}
                  style={[styles.fchip, wireFilter === f && styles.fchipActive]}
                  onPress={() => setWireFilter(f)} activeOpacity={0.7}>
                  <Text style={[styles.fchipText, wireFilter === f && styles.fchipTextActive]}>{f}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {/* Wire items */}
            <ScrollView showsVerticalScrollIndicator={false} style={styles.wireList}
              contentContainerStyle={{paddingBottom: insets.bottom + 60}}>
              {loading && filteredWire.length === 0 && (
                <View style={styles.wireLoadingWrap}>
                  <ActivityIndicator color="#60A5FA" />
                  <Text style={styles.wireLoadingText}>Fetching Guardian wire…</Text>
                </View>
              )}
              {!loading && error && filteredWire.length === 0 && (
                <View style={styles.wireErrorWrap}>
                  <Icon name="wifi-off" size={28} color="#FF3B30" />
                  <Text style={styles.wireErrorTitle}>Feed unreachable</Text>
                  <Text style={styles.wireErrorHint}>{error}</Text>
                  <TouchableOpacity style={styles.wireRetryBtn} onPress={() => { void refresh(); }} activeOpacity={0.8}>
                    <Text style={styles.wireRetryText}>RETRY</Text>
                  </TouchableOpacity>
                </View>
              )}
              {filteredWire.map(item => (
                <TouchableOpacity key={item.id} style={[styles.wireItem, {borderLeftColor: item.priorityColor}]}
                  onPress={() => openDrawer(item)} activeOpacity={0.8}>
                  <View style={styles.itemMeta}>
                    <Text style={styles.itemCode}>{item.id}</Text>
                    <View style={[styles.itemBadge, {backgroundColor: item.priorityBg, borderColor: item.priorityColor + '44'}]}>
                      <Text style={[styles.itemBadgeText, {color: item.priorityColor}]}>{item.priority}</Text>
                    </View>
                    <View style={[styles.itemBadge, {backgroundColor: 'rgba(37,99,235,0.04)', borderColor: '#1E2D45'}]}>
                      <Text style={[styles.itemBadgeText, {color: '#64748B'}]}>{item.tag}</Text>
                    </View>
                    <Text style={styles.itemTs}>{item.ts}</Text>
                  </View>
                  <Text style={styles.itemHeadline}>{item.headline}</Text>
                  <View style={styles.itemFooter}>
                    <Text style={styles.itemLoc}>{item.loc}</Text>
                    <Text style={styles.itemSrc}>{item.src}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* ── SIGNALS TAB ── */}
        {activeTab === 'signals' && (
          <ScrollView style={styles.signalsScroll} showsVerticalScrollIndicator={false}
            contentContainerStyle={[styles.signalsContent, {paddingBottom: insets.bottom + 60}]}>
            <Text style={styles.sigMatrixLabel}>THREAT MATRIX — LIVE</Text>

            <Text style={styles.sigSectionLabel}>◆ CRITICAL SIGNALS</Text>
            {SIGNALS_CRITICAL.map(s => <SignalRow key={s.name} signal={s} />)}

            <Text style={styles.sigSectionLabel}>◆ HIGH SIGNALS</Text>
            {SIGNALS_HIGH.map(s => <SignalRow key={s.name} signal={s} />)}

            <Text style={styles.sigSectionLabel}>◆ MEDIUM / MONITOR</Text>
            {SIGNALS_MEDIUM.map(s => <SignalRow key={s.name} signal={s} />)}
          </ScrollView>
        )}
      </View>

      {/* Bottom Ticker — fed by the live Guardian wire, duplicated once
          for a seamless loop. Falls back to a "connecting" chip while
          the first fetch is in flight. The safe-area padding sits on an
          outer wrapper so the 28px marquee row isn't clipped on phones
          with a large home-indicator inset. */}
      <View style={[styles.tickerOuter, {paddingBottom: Math.max(insets.bottom, 4)}]}>
        <View style={styles.tickerWrap}>
          <View style={styles.tickerTag}>
            <Text style={styles.tickerTagText}>▶ WIRE</Text>
          </View>
          <View style={styles.tickerScroll}>
            <Animated.View style={[styles.tickerInner, {transform: [{translateX: tickerAnim}]}]}>
              {(() => {
                const feed = items.length > 0
                  ? items.slice(0, 10).map(i => ({color: i.priorityColor, text: tickerTextFor(i)}))
                  : TICKER_FALLBACK;
                return [...feed, ...feed].map((t, idx) => (
                  <View key={idx} style={styles.tickerItem}>
                    <View style={[styles.tickerDot, {backgroundColor: t.color}]} />
                    <Text style={styles.tickerItemText} numberOfLines={1}>{t.text}</Text>
                    <Text style={styles.tickerSep}>·</Text>
                  </View>
                ));
              })()}
            </Animated.View>
          </View>
        </View>
      </View>

      {/* Incident Drawer */}
      {drawerItem && (
        <Modal transparent animationType="none" onRequestClose={closeDrawer}>
          <Pressable style={styles.drawerBackdrop} onPress={closeDrawer} />
          <Animated.View style={[styles.drawerSheet, {transform:[{translateY: drawerAnim}]}]}>
            <View style={styles.drawerHandle} />
            <View style={styles.drawerHeader}>
              <View>
                <Text style={styles.drawerCode}>{drawerItem.id}</Text>
                <View style={styles.drawerBadgeRow}>
                  <View style={[styles.drawerBadge, {backgroundColor: drawerItem.priorityBg, borderColor: drawerItem.priorityColor + '55'}]}>
                    <Text style={[styles.drawerBadgeText, {color: drawerItem.priorityColor}]}>{drawerItem.priority}</Text>
                  </View>
                  <View style={[styles.drawerBadge, {backgroundColor:'rgba(37,99,235,0.06)', borderColor:'#1E2D45'}]}>
                    <Text style={[styles.drawerBadgeText, {color:'#64748B'}]}>{drawerItem.tag}</Text>
                  </View>
                </View>
              </View>
              <TouchableOpacity style={styles.drawerCloseBtn} onPress={closeDrawer} activeOpacity={0.7}>
                <Text style={styles.drawerCloseText}>✕ CLOSE</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.drawerBody}>
              <Text style={styles.drawerHeadline}>{drawerItem.headline}</Text>
              <Text style={styles.drawerSummary}>via {drawerItem.src.replace('SOURCE: ','')}</Text>
              <View style={styles.drawerMetaRow}>
                <View style={styles.drawerMeta}><Text style={styles.drawerMetaText}>{drawerItem.loc}</Text></View>
                <View style={styles.drawerMeta}><Text style={styles.drawerMetaText}>{drawerItem.ts}</Text></View>
                <View style={styles.drawerMeta}><Text style={styles.drawerMetaText}>{drawerItem.src}</Text></View>
              </View>
              <View style={styles.drawerActions}>
                <TouchableOpacity
                  style={[styles.drawerBtn, styles.drawerBtnPrimary]}
                  onPress={() => {
                    if (drawerItem?.webUrl) {Linking.openURL(drawerItem.webUrl).catch(() => {});}
                    closeDrawer();
                  }}
                  activeOpacity={0.8}>
                  <Text style={styles.drawerBtnPrimaryText}>OPEN ARTICLE →</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.drawerBtn, styles.drawerBtnSec]} onPress={closeDrawer} activeOpacity={0.8}>
                  <Text style={styles.drawerBtnSecText}>DISMISS</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        </Modal>
      )}

      {/* Scanline overlay — operational-console effect from the HTML
          preview (every 4px row tinted 8% black). Rendered last so it
          paints on top of the map/wire content, and pointerEvents=none
          keeps taps passing through to the real UI underneath. */}
      <View pointerEvents="none" style={styles.scanlineOverlay}>
        {Array.from({length: 220}).map((_, i) => (
          <View key={i} style={styles.scanline} />
        ))}
      </View>
    </View>
  );
}

function SignalRow({signal}: {signal: Signal}) {
  return (
    <View style={[styles.sigRow, {backgroundColor: signal.sectionBg, borderColor: signal.sectionBorder}]}>
      <View style={styles.sigLeft}>
        <Text style={styles.sigName}>{signal.name}</Text>
        <Text style={styles.sigRegion}>{signal.region}</Text>
      </View>
      <View style={styles.sigBarWrap}>
        <View style={[styles.sigBar, {width: `${signal.value}%` as DimensionValue, backgroundColor: signal.color}]} />
      </View>
      <Text style={[styles.sigLevel, {color: signal.color}]}>{signal.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:'#0A0F1E'},

  topbar: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:12, paddingBottom:8, borderBottomWidth:1, borderBottomColor:'#1E2D45', backgroundColor:'#0A0F1E', position:'relative'},
  topLeft: {flexDirection:'row', alignItems:'center', gap:10},
  backBtn: {width:32, height:32, borderRadius:16, borderWidth:1, borderColor:'#1E2D45', backgroundColor:'rgba(37,99,235,0.05)', alignItems:'center', justifyContent:'center'},
  logoText: {fontSize:13, fontWeight:'700', letterSpacing:3, color: Colors.primary},
  logoSub: {fontSize:8, fontWeight:'500', letterSpacing:2, color:'#64748B'},
  topRight: {alignItems:'flex-end', gap:2},
  liveBadge: {flexDirection:'row', alignItems:'center', gap:5},
  liveDot: {width:6, height:6, borderRadius:3, backgroundColor: Colors.primary},
  liveBadgeText: {fontSize:9, fontWeight:'600', letterSpacing:1.5, color: Colors.primary},
  clock: {fontSize:9, color:'#64748B', letterSpacing:1},
  coords: {fontSize:8, color:'#64748B', letterSpacing:0.5},

  tabbar: {flexDirection:'row', borderBottomWidth:1, borderBottomColor:'#1E2D45', backgroundColor:'#0A0F1E'},
  tab: {flex:1, paddingVertical:8, alignItems:'center', borderBottomWidth:2, borderBottomColor:'transparent'},
  tabActive: {borderBottomColor: Colors.primary},
  tabText: {fontSize:9, fontWeight:'700', letterSpacing:2, color:'#64748B'},
  tabTextActive: {color: Colors.primary},
  tabCount: {paddingHorizontal:4, paddingVertical:1, borderRadius:99, minWidth:14, alignItems:'center'},
  tabCountText: {fontSize:7, fontWeight:'700'},

  content: {flex:1},

  // Map
  mapContainer: {flex:1, position:'relative'},
  // Why: full-size (not 1x1) so Leaflet's viewport never resizes while hidden;
  // opacity 0 + pointerEvents none keeps it invisible and untouchable behind
  // the active tab, which renders after it and paints on top.
  mapHidden: {position:'absolute', top:0, left:0, right:0, bottom:0, opacity:0},
  mapWebView:   {flex:1, backgroundColor: '#06080C'},

  mapLoadingOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(10,15,30,0.45)'},
  mapLoadingText: {color: '#60A5FA', fontSize: 9, letterSpacing: 2, fontWeight: '700'},
  wireLoadingWrap: {alignItems: 'center', paddingVertical: 40, gap: 10},
  wireLoadingText: {color: '#64748B', fontSize: 11, letterSpacing: 1},
  wireErrorWrap: {alignItems: 'center', paddingVertical: 40, paddingHorizontal: 32, gap: 8},
  wireErrorTitle: {color: '#F1F5F9', fontSize: 13, fontWeight: '700'},
  wireErrorHint: {color: '#64748B', fontSize: 10, textAlign: 'center'},
  wireRetryBtn: {marginTop: 10, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 4, backgroundColor: 'rgba(37,99,235,0.1)', borderWidth: 1, borderColor: '#3B82F6'},
  wireRetryText: {color: Colors.primary, fontSize: 9, fontWeight: '800', letterSpacing: 2},
  mapInfo: {position:'absolute', bottom:0, left:0, right:0, paddingTop:32, paddingBottom:8, paddingHorizontal:12, backgroundColor:'rgba(10,15,30,0)'},
  mapStatRow: {flexDirection:'row', flexWrap:'wrap', gap:8},
  mapStat: {flexDirection:'row', alignItems:'center', gap:5, fontSize:8, paddingHorizontal:8, paddingVertical:4, borderRadius:4, borderWidth:1, borderColor:'#1E2D45', backgroundColor:'rgba(10,15,30,0.85)'},
  mapStatLabel: {fontSize:8, letterSpacing:1, color:'#64748B'},
  mapStatValue: {fontSize:8, fontWeight:'700'},
  mapCoords: {marginTop:6, fontSize:8, color:'#64748B', letterSpacing:1},

  // Wire
  wireContainer: {flex:1},
  wireHeader: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:12, paddingVertical:8, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  wireHeaderLabel: {fontSize:9, letterSpacing:2, color:'#64748B'},
  wireHeaderRight: {flexDirection:'row', alignItems:'center', gap:4},
  liveDotSmall: {width:5, height:5, borderRadius:3, backgroundColor: Colors.primary},
  wireCount: {fontSize:8, color:'#64748B'},
  filterChipsWrap: {flexGrow:0, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  filterChipsContent: {gap:6, paddingHorizontal:12, paddingVertical:8},
  fchip: {paddingHorizontal:10, paddingVertical:3, borderRadius:4, borderWidth:1, borderColor:'#1E2D45'},
  fchipActive: {borderColor:'#3B82F6', backgroundColor:'rgba(37,99,235,0.07)'},
  fchipText: {fontSize:8, fontWeight:'700', letterSpacing:1.5, color:'#64748B'},
  fchipTextActive: {color: Colors.primary},
  wireList: {flex:1},
  wireItem: {paddingVertical:10, paddingHorizontal:12, borderBottomWidth:1, borderBottomColor:'#1E2D45', borderLeftWidth:2},
  itemMeta: {flexDirection:'row', alignItems:'center', gap:6, marginBottom:4, flexWrap:'wrap'},
  itemCode: {fontSize:8, fontWeight:'700', letterSpacing:1.5, color:'#64748B'},
  itemBadge: {paddingHorizontal:5, paddingVertical:1, borderRadius:2, borderWidth:1},
  itemBadgeText: {fontSize:7, fontWeight:'800', letterSpacing:1},
  itemTs: {fontSize:8, color:'#334155', marginLeft:'auto'},
  itemHeadline: {fontSize:12, fontWeight:'600', lineHeight:17, color:'#F1F5F9', marginBottom:4},
  itemFooter: {flexDirection:'row', alignItems:'center'},
  itemLoc: {fontSize:8, letterSpacing:1, color:'#64748B'},
  itemSrc: {fontSize:8, color:'#334155', marginLeft:'auto'},

  // Signals
  signalsScroll: {flex:1},
  signalsContent: {padding:12, gap:4},
  sigMatrixLabel: {fontSize:8, letterSpacing:2, color:'#64748B', paddingBottom:4},
  sigSectionLabel: {fontSize:8, letterSpacing:2, color:'#64748B', marginTop:12, marginBottom:6},
  sigRow: {flexDirection:'row', alignItems:'center', paddingHorizontal:10, paddingVertical:8, borderRadius:4, borderWidth:1, marginBottom:4},
  sigLeft: {width:120},
  sigName: {fontSize:10, fontWeight:'600', color:'#F1F5F9'},
  sigRegion: {fontSize:8, color:'#64748B', letterSpacing:0.5, marginTop:1},
  sigBarWrap: {flex:1, marginHorizontal:10, height:3, borderRadius:2, backgroundColor:'#1E2D45', overflow:'hidden'},
  sigBar: {height:'100%', borderRadius:2},
  sigLevel: {fontSize:9, fontWeight:'700', letterSpacing:1, minWidth:28, textAlign:'right'},

  // Ticker
  tickerOuter: {backgroundColor:'#0D1929', borderTopWidth:1, borderTopColor:'#1E2D45'},
  tickerWrap: {height:28, flexDirection:'row', alignItems:'center', overflow:'hidden'},
  tickerTag: {paddingHorizontal:8, height:'100%', justifyContent:'center', backgroundColor: Colors.primary, borderRightWidth:1, borderRightColor:'#1E2D45'},
  tickerTagText: {fontSize:8, fontWeight:'800', letterSpacing:2, color:'#0A0F1E'},
  tickerScroll: {flex:1, overflow:'hidden'},
  tickerInner: {flexDirection:'row', alignItems:'center', gap:0},
  tickerItem: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:16},
  tickerDot: {width:4, height:4, borderRadius:2, flexShrink:0},
  tickerItemText: {fontSize:9, color:'#64748B', letterSpacing:0.5},
  tickerSep: {color:'#334155', fontSize:12},

  // Scanline overlay — fixed-position, top of the stack, transparent taps.
  scanlineOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, overflow: 'hidden'},
  scanline: {height: 2, marginBottom: 2, backgroundColor: 'rgba(0,0,0,0.08)'},

  // Drawer
  drawerBackdrop: {position:'absolute', top:0, bottom:0, left:0, right:0, backgroundColor:'rgba(0,0,0,0.5)'},
  drawerSheet: {position:'absolute', bottom:0, left:0, right:0, backgroundColor:'#0D1929', borderTopWidth:1, borderTopColor:'#3B82F6', borderRadius:14, paddingBottom:24, maxHeight:'82%', overflow:'hidden'},
  drawerHandle: {width:48, height:5, borderRadius:3, backgroundColor:'#3B82F6', marginTop:12, marginBottom:4, alignSelf:'center'},
  drawerHeader: {flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between', paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  drawerBadgeRow: {flexDirection:'row', gap:5, marginTop:4},
  drawerBadge: {paddingHorizontal:6, paddingVertical:2, borderRadius:2, borderWidth:1},
  drawerBadgeText: {fontSize:7, fontWeight:'800', letterSpacing:1},
  drawerCode: {fontSize:8, fontWeight:'700', letterSpacing:2, color:'#64748B'},
  drawerCloseBtn: {paddingHorizontal:8, paddingVertical:4, borderWidth:1, borderColor:'#1E2D45', borderRadius:3},
  drawerCloseText: {fontSize:9, fontWeight:'700', letterSpacing:1, color:'#64748B'},
  drawerBody: {padding:16},
  drawerHeadline: {fontSize:13, fontWeight:'700', color:'#F1F5F9', lineHeight:19, marginVertical:8},
  drawerSummary: {fontSize:11, color:'#64748B', lineHeight:17, marginBottom:10},
  drawerMetaRow: {flexDirection:'row', flexWrap:'wrap', gap:8, marginBottom:12},
  drawerMeta: {paddingHorizontal:8, paddingVertical:3, borderWidth:1, borderColor:'#1E2D45', borderRadius:3},
  drawerMetaText: {fontSize:8, letterSpacing:1, color:'#64748B'},
  drawerActions: {flexDirection:'row', gap:8},
  drawerBtn: {flex:1, paddingVertical:10, borderRadius:6, alignItems:'center'},
  drawerBtnPrimary: {backgroundColor:'rgba(37,99,235,0.1)', borderWidth:1, borderColor:'#3B82F6'},
  drawerBtnPrimaryText: {fontSize:9, fontWeight:'800', letterSpacing:2, color: Colors.primary},
  drawerBtnSec: {backgroundColor:'transparent', borderWidth:1, borderColor:'#1E2D45'},
  drawerBtnSecText: {fontSize:9, fontWeight:'800', letterSpacing:2, color:'#64748B'},
}));
