import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {View, StyleSheet, type ViewStyle} from 'react-native';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import type {VbgKeyPoint} from '@/services/api';
import {buildVbgKeyPointsMapHtml} from './vbgKeyPointsMapHtml';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';

/**
 * Real interactive Mapbox-GL map (in a WebView) for the Key Points screen.
 * Centers on the principal and pins every key point at its true coordinate.
 * Tapping a pin calls `onTapPoint` so the screen can open it in maps.
 */
export function VbgKeyPointsMap({
  centre,
  points,
  radiusKm,
  onTapPoint,
  style,
}: {
  centre: {lat: number; lng: number} | null;
  points: VbgKeyPoint[];
  /** When set, draws a radius circle (km) centered on `centre`. */
  radiusKm?: number;
  onTapPoint?: (p: VbgKeyPoint) => void;
  style?: ViewStyle;
}) {
  const webRef = useRef<WebView>(null);
  const map = useMapReload();
  const html = useMemo(() => buildVbgKeyPointsMapHtml(MAPBOX_TOKEN), []);
  const webSource = useMemo(() => ({html}), [html]);

  const push = useCallback(() => {
    if (!centre) {return;}
    const payload = JSON.stringify({centre, points, radiusKm: radiusKm ?? 0});
    webRef.current?.injectJavaScript(
      `try { var d=${payload}; window.updateKeyPoints(d.centre, d.points, d.radiusKm); } catch(e){} true;`,
    );
  }, [centre, points, radiusKm]);

  // Why: the WebView is NOT remounted between analysis runs, so load/ready
  // alone left the first run's data on screen forever — re-push on any change.
  useEffect(() => { push(); }, [push]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {type?: string; point?: VbgKeyPoint; reason?: string};
      if (msg.type === 'ready') {map.onReady(); push();}
      if (msg.type === 'error') {
        // MG-11 — fast-fail ONLY on definitely-fatal boot errors (WebGL
        // init, token 401/403, gl-unsupported); recoverable pre-load tile
        // blips must not burn the auto-retry (review m-2).
        console.warn('[VbgKeyPointsMap] map error:', msg.reason);
        if (/401|403|unauthorized|forbidden|access token|gl-unsupported|WebGL/i.test(String(msg.reason ?? ''))) {
          map.onError();
        }
      }
      if (msg.type === 'gl-unsupported') {map.onError();}
      if (msg.type === 'tap' && msg.point && onTapPoint) {onTapPoint(msg.point);}
    } catch {
      /* ignore */
    }
  };

  // On load, force a resize (the map mounts in a scroll card whose height can
  // be 0 at first paint → blank tiles) then push the data.
  const onLoad = () => {
    webRef.current?.injectJavaScript('try{window.dispatchEvent(new Event("resize"));}catch(e){} true;');
    push();
  };

  // MG-04 — a build without a baked token can never load GL; mounting the
  // WebView would just loop the watchdog. Say so instead.
  if (MAPBOX_TOKEN_MISSING) {
    return (
      <View style={[styles.wrap, style]}>
        <MapFailedOverlay onRetry={() => {}} variant="misconfigured" />
      </View>
    );
  }

  return (
    <View style={[styles.wrap, style]}>
      <WebView
        key={`vbg-map-${map.reloadKey}`}
        ref={webRef}
        source={webSource}
        onMessage={onMessage}
        onLoadEnd={onLoad}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="compatibility"
        originWhitelist={['*']}
        androidLayerType="hardware"
        scrollEnabled={false}
        bounces={false}
        onRenderProcessGone={map.retry}
        onContentProcessDidTerminate={map.retry}
      />
      {/* MG-11 rider — visible load state instead of a dark void. */}
      {map.status === 'loading' && <MapFailedOverlay onRetry={map.retry} variant="loading" />}
      {map.status === 'failed' && <MapFailedOverlay onRetry={map.retry} />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {overflow: 'hidden', borderRadius: 18, backgroundColor: '#07090D', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  web: {flex: 1, backgroundColor: '#07090D'},
});
