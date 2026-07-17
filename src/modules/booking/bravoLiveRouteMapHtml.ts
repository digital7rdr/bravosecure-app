/**
 * Inline Mapbox GL JS HTML for the Live-Operations route map.
 *
 * Renders a dark mapbox canvas with an origin → vehicle → dest polyline,
 * a pulsing vehicle marker, and an ETA pill. RN pushes updates via:
 *   window.setRoute({origin, vehicle, dest, etaLabel})
 *
 * A DARK | LIGHT | SAT segment (top-right) swaps the base style in place;
 * the route source/layers + last payloads are re-applied after each swap.
 * High-zoom 3D building extrusions give the vector styles street detail.
 *
 * Camera policy: fitBounds runs once per origin/dest pair (framed once),
 * then the camera is user-owned; a RECENTER pill re-frames on demand.
 * Markers are created once and moved via setLngLat — the vehicle dot
 * glides between fixes with a rAF lerp instead of teleporting.
 */

export function buildLiveRouteHtml(mapboxToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover"/>
<link href="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.css" rel="stylesheet"/>
<style>
  html, body { margin: 0; padding: 0; background: #05070B; overflow: hidden; height: 100%;
    font-family: "Manrope", -apple-system, "Segoe UI", Roboto, sans-serif; color: #FFF; }
  *, *::before, *::after { box-sizing: border-box; }

  #map { position: absolute; inset: 0; background: #05070B; }
  .grid { position: absolute; inset: 0; pointer-events: none; z-index: 2;
    background-image:
      linear-gradient(rgba(76,194,255,0.08) 1px, transparent 1px),
      linear-gradient(90deg, rgba(76,194,255,0.08) 1px, transparent 1px);
    background-size: 20px 20px; mix-blend-mode: screen; }
  body.light .grid, body.sat .grid { display: none; }
  body.light #map { background: #F4F5F7; }

  .styleseg { position: absolute; right: 10px; top: 10px; z-index: 20; display: flex;
    background: rgba(6,20,43,0.92); border: 1px solid #1C3B66; border-radius: 6px;
    overflow: hidden; -webkit-tap-highlight-color: transparent; user-select: none; }
  .styleseg .seg { padding: 5px 9px; font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 9px; font-weight: 700; letter-spacing: 1px; color: #6E85A8; cursor: pointer; }
  .styleseg .seg.on { background: #1E88FF; color: #fff; }

  .origin-dot, .dest-dot, .vehicle-dot { position: relative; width: 0; height: 0; }
  .origin-dot .pin {
    position: absolute; left: -8px; top: -8px; width: 16px; height: 16px;
    border-radius: 50%; background: #FFC107;
    box-shadow: 0 0 0 3px rgba(255,193,7,0.25), 0 0 14px #FFC107;
  }
  .dest-dot .pin {
    position: absolute; left: -8px; top: -8px; width: 16px; height: 16px;
    border-radius: 50%; background: #00C853;
    box-shadow: 0 0 0 3px rgba(0,200,83,0.25), 0 0 14px #00C853;
  }
  .vehicle-dot .pin {
    position: absolute; left: -7px; top: -7px; width: 14px; height: 14px;
    border-radius: 50%; background: #1E88FF;
    box-shadow: 0 0 0 3px rgba(30,136,255,0.25), 0 0 18px #1E88FF;
  }
  .vehicle-dot .ring {
    position: absolute; left: -16px; top: -16px; width: 32px; height: 32px;
    border-radius: 50%; border: 1.5px solid #1E88FF;
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0%   { transform: scale(0.7); opacity: 0.8; }
    100% { transform: scale(1.8); opacity: 0; }
  }

  .tag {
    position: absolute; transform: translate(-50%, calc(-100% - 14px));
    padding: 3px 7px; border-radius: 4px;
    background: rgba(6,20,43,0.92); border: 1px solid #1C3B66;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 9px; font-weight: 600; color: #FFFFFF;
    letter-spacing: 0.3px; white-space: nowrap;
  }

  .etc {
    position: absolute; left: 10px; bottom: 10px; z-index: 20;
    padding: 5px 10px; border-radius: 6px;
    background: rgba(6,20,43,0.92); border: 1px solid #00C853;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 10px; font-weight: 700; color: #00C853;
    letter-spacing: 1px; text-transform: uppercase;
    display: flex; align-items: center; gap: 6px;
  }
  .etc .d { width: 8px; height: 8px; border-radius: 50%; background: #00C853; }

  .recenter {
    position: absolute; right: 10px; bottom: 44px; z-index: 20;
    padding: 5px 10px; border-radius: 6px; cursor: pointer;
    background: rgba(6,20,43,0.92); border: 1px solid #4CC2FF;
    font-family: "JetBrains Mono", "SF Mono", monospace;
    font-size: 10px; font-weight: 700; color: #4CC2FF;
    letter-spacing: 1px; text-transform: uppercase;
    display: none; align-items: center; gap: 6px;
    -webkit-tap-highlight-color: transparent; user-select: none;
  }
</style>
</head>
<body>
<div id="map"></div>
<div class="grid"></div>
<div class="styleseg" id="styleseg">
  <div class="seg on" data-style="dark">DARK</div>
  <div class="seg" data-style="light">LIGHT</div>
  <div class="seg" data-style="sat">SAT</div>
</div>
<div class="etc" id="etc"><div class="d"></div><span id="etaText">ETA —</span></div>
<div class="etc" id="prog" style="left:auto; right:10px; border-color:#1E88FF; color:#1E88FF;"><span id="progText"></span></div>
<div class="recenter" id="recenter">⌖ Recenter</div>

<script src="https://api.mapbox.com/mapbox-gl-js/v3.9.0/mapbox-gl.js"></script>
<script>
  mapboxgl.accessToken = ${JSON.stringify(mapboxToken)};

  function post(type, payload) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type: type}, payload || {})));
      }
    } catch (_) {}
  }

  const STYLES = {
    dark:  'mapbox://styles/mapbox/dark-v11',
    light: 'mapbox://styles/mapbox/light-v11',
    sat:   'mapbox://styles/mapbox/satellite-streets-v12',
  };
  let currentStyle = 'dark';

  // B-89 MG-12 — coordinate sanity for anything that moves a marker or a
  // line: non-finite / out-of-range / (0,0) "null island" payloads must
  // never teleport the map.
  function validLL(lng, lat) {
    return isFinite(lng) && isFinite(lat)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      && !(lng === 0 && lat === 0);
  }

  // B-89 P3 — a WebGL context-creation failure used to throw here BEFORE
  // any postMessage existed, leaving only the slow 15 s watchdog. Fail
  // fast and loud instead.
  let map;
  try {
    map = new mapboxgl.Map({
      container: 'map',
      style: STYLES.dark,
      center: [55.2708, 25.2048],
      zoom: 11.5,
      minZoom: 6, maxZoom: 18,
      attributionControl: false,
      interactive: true,
      antialias: true,
    });
  } catch (e) {
    post('err', {where: 'init', msg: String(e)});
    throw e;
  }
  map.addControl(new mapboxgl.AttributionControl({compact: true}), 'bottom-right');

  // High-zoom detail: extruded 3D buildings under the first label layer
  // (vector styles only). Idempotent — retried from styledata while a
  // freshly-swapped style streams in.
  function addDetailLayers() {
    try {
      if (currentStyle === 'sat') return;
      if (map.getLayer('bravo-3d-buildings')) return;
      var layers = (map.getStyle().layers) || [];
      var labelId;
      for (var i = 0; i < layers.length; i++) {
        var l = layers[i];
        if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelId = l.id; break; }
      }
      map.addLayer({
        id: 'bravo-3d-buildings', source: 'composite', 'source-layer': 'building',
        filter: ['==', ['get', 'extrude'], 'true'], type: 'fill-extrusion', minzoom: 14.5,
        paint: {
          'fill-extrusion-color': currentStyle === 'light' ? '#D9DDE4' : '#1E2634',
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'height']],
          'fill-extrusion-base':   ['interpolate', ['linear'], ['zoom'], 14.5, 0, 16, ['get', 'min_height']],
          'fill-extrusion-opacity': 0.6,
        },
      }, labelId);
    } catch (_) {}
  }
  // 'style.load' fires when a style becomes fully usable — on the INITIAL
  // style and after every setStyle swap. Mounting layers here (never on the
  // early 'styledata' ticks) is what keeps the style state healthy: adding
  // while a style is still streaming corrupts the load (verified in a browser
  // smoke — the map never reached isStyleLoaded and addLayer went to a void).
  map.on('style.load', function() {
    try {
      ensureRouteLayer();
      addDetailLayers();
      if (navActive && lastNavPayload) { window.setNavRoute(lastNavPayload); }
      else if (lastRoutePayload) { window.setRoute(lastRoutePayload); }
      if (lastAccPayload) { window.setVehicleAccuracy(lastAccPayload[0], lastAccPayload[1], lastAccPayload[2]); }
    } catch(_) {}
  });

  map.on('error', function(e) {
    post('err', {where: 'map', msg: (e && e.error && e.error.message) || 'map-error'});
  });

  let originMk = null, destMk = null, vehMk = null;
  let originTag = null, destTag = null, vehTag = null;
  let framedOnce = false;
  let boundsKey = '';
  let lastBounds = null;
  let navActive = false;
  let vehAnim = null;
  let vehPos = null;
  // Last payloads, re-applied after a style swap (setStyle drops sources).
  let lastRoutePayload = null;
  let lastNavPayload = null;
  let lastAccPayload = null;

  const recenterEl = document.getElementById('recenter');
  function showRecenter(v) { recenterEl.style.display = v ? 'flex' : 'none'; }
  recenterEl.addEventListener('click', function() {
    if (lastBounds) map.fitBounds(lastBounds, {padding: 56, duration: 600, maxZoom: 13});
    showRecenter(false);
  });
  // Why: once the user pans/zooms, the camera is theirs — never auto-reframe again.
  map.on('dragstart', function() { showRecenter(true); });
  map.on('zoomstart', function(e) { if (e.originalEvent) showRecenter(true); });

  function ensureRouteLayer() {
    if (!map.getSource('route')) {
      map.addSource('route', {type: 'geojson', data: {type:'FeatureCollection', features:[]}});
    }
    if (!map.getLayer('route-line')) {
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        paint: {
          // match = pairs + ONE default. The previous form had an extra arg
          // (even count) — an invalid expression GL rejects ASYNCHRONOUSLY
          // (map 'error' event), so the whole layer silently never mounted
          // and the route line never rendered. Found by browser smoke.
          'line-color': ['match', ['get', 'kind'], 'done', '#FFC107', '#00C853'],
          'line-width': 2.5, 'line-opacity': 0.9,
        },
      });
    }
  }

  map.on('load', () => {
    post('ready');
  });

  function makeMarker(className, lngLat) {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = className === 'vehicle-dot'
      ? '<div class="ring"></div><div class="pin"></div>'
      : '<div class="pin"></div>';
    return new mapboxgl.Marker({element: el}).setLngLat(lngLat).addTo(map);
  }

  function addTag(lngLat, text) {
    const el = document.createElement('div');
    el.className = 'tag';
    el.textContent = text;
    return new mapboxgl.Marker({element: el, anchor: 'bottom'}).setLngLat(lngLat).addTo(map);
  }

  function setTag(tag, lngLat, text) {
    tag.setLngLat(lngLat);
    tag.getElement().textContent = text;
    return tag;
  }

  // Glide the vehicle dot between fixes; snap on implausible jumps (~>5 km).
  function animateVehicle(target) {
    if (!vehMk) return;
    const from = vehPos || target;
    const dLng = target[0] - from[0], dLat = target[1] - from[1];
    if (Math.abs(dLng) > 0.05 || Math.abs(dLat) > 0.05) {
      if (vehAnim) cancelAnimationFrame(vehAnim);
      vehPos = target;
      vehMk.setLngLat(target);
      if (vehTag) vehTag.setLngLat(target);
      return;
    }
    if (vehAnim) cancelAnimationFrame(vehAnim);
    const start = performance.now(), dur = 900;
    function step(now) {
      const t = Math.min(1, (now - start) / dur);
      const k = t * (2 - t);
      const cur = [from[0] + dLng * k, from[1] + dLat * k];
      vehPos = cur;
      vehMk.setLngLat(cur);
      if (vehTag) vehTag.setLngLat(cur);
      if (t < 1) vehAnim = requestAnimationFrame(step);
    }
    vehAnim = requestAnimationFrame(step);
  }

  window.setRoute = function(payload) {
    try {
      const {origin, vehicle, dest, etaLabel} = payload;
      // MG-12 — refuse invalid payloads OUTRIGHT (keep the last good frame).
      // 'warn', not 'err': an err post pre-ready would remount a healthy map.
      if (!validLL(origin.lng, origin.lat) || !validLL(dest.lng, dest.lat) || !validLL(vehicle.lng, vehicle.lat)) {
        post('warn', {where: 'setRoute', msg: 'invalid-coords'});
        return;
      }
      lastRoutePayload = payload;
      const oLL = [origin.lng, origin.lat];
      const dLL = [dest.lng, dest.lat];
      const vLL = [vehicle.lng, vehicle.lat];

      if (!originMk) originMk = makeMarker('origin-dot', oLL); else originMk.setLngLat(oLL);
      if (!destMk)   destMk   = makeMarker('dest-dot',   dLL); else destMk.setLngLat(dLL);
      if (!vehMk) {
        vehMk = makeMarker('vehicle-dot', vLL);
        vehPos = vLL;
      } else {
        animateVehicle(vLL);
      }

      if (!originTag) originTag = addTag(oLL, origin.label || 'Origin');
      else setTag(originTag, oLL, origin.label || 'Origin');
      if (!destTag) destTag = addTag(dLL, dest.label || 'Destination');
      else setTag(destTag, dLL, dest.label || 'Destination');
      if (!vehTag) vehTag = addTag(vLL, vehicle.label || 'Vehicle');
      else vehTag.getElement().textContent = vehicle.label || 'Vehicle';

      ensureRouteLayer();
      // Why: once the Directions split owns the route source, the straight-line
      // fallback must not clobber it (two-writer flicker).
      if (!navActive) {
        const src = map.getSource('route');
        if (src && src.setData) {
          src.setData({
            type: 'FeatureCollection',
            features: [
              {type:'Feature', properties:{kind:'done'}, geometry:{type:'LineString', coordinates:[oLL, vLL]}},
              {type:'Feature', properties:{kind:'future'}, geometry:{type:'LineString', coordinates:[vLL, dLL]}},
            ],
          });
        }
      }

      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend(oLL);
      bounds.extend(dLL);
      bounds.extend(vLL);
      lastBounds = bounds;
      const key = oLL.map(function(n){return n.toFixed(4);}).join(',') + '|' + dLL.map(function(n){return n.toFixed(4);}).join(',');
      if (!framedOnce || key !== boundsKey) {
        boundsKey = key;
        framedOnce = true;
        map.fitBounds(bounds, {padding: 56, duration: 600, maxZoom: 13});
      }

      const txt = document.getElementById('etaText');
      if (txt) txt.textContent = etaLabel || 'ETA —';
    } catch(e) { post('err', {where: 'setRoute', msg: String(e)}); }
  };

  // MONITOR-MAP (#10) — road-following two-tone progress. RN computes the real
  // shortest route (Mapbox Directions) and splits it at the vehicle: traveled
  // (done colour) + ahead (future colour) are arrays of [lng,lat]. Reuses the
  // existing route-line kind colouring; setRoute's straight lines remain the
  // fallback when no route/token is available.
  window.setNavRoute = function(payload) {
    try {
      lastNavPayload = payload;
      var traveled = (payload && payload.traveled) || [];
      var ahead = (payload && payload.ahead) || [];
      ensureRouteLayer();
      var src = map.getSource('route');
      if (!src || !src.setData) return;
      var features = [];
      if (traveled.length >= 2) {
        features.push({type:'Feature', properties:{kind:'done'}, geometry:{type:'LineString', coordinates: traveled}});
      }
      if (ahead.length >= 2) {
        features.push({type:'Feature', properties:{kind:'future'}, geometry:{type:'LineString', coordinates: ahead}});
      }
      navActive = features.length > 0;
      src.setData({type:'FeatureCollection', features: features});
    } catch(e) { post('err', {where: 'setNavRoute', msg: String(e)}); }
  };

  window.setProgress = function(pct) {
    try {
      var el = document.getElementById('progText');
      if (el) el.textContent = (pct == null ? '' : (pct + '% TO B'));
    } catch(_) {}
  };

  // B-89 MG-14 — GPS confidence circle under the vehicle dot (radius =
  // the fix's reported accuracy in meters, as a 48-point polygon so the
  // radius is true meters at any zoom). Sits below the route line.
  function circleFeature(lng, lat, radiusM) {
    var latR = radiusM / 111320;
    var lngR = radiusM / (111320 * Math.cos(lat * Math.PI / 180) || 1);
    var pts = [];
    for (var i = 0; i <= 48; i++) {
      var a = (i / 48) * 2 * Math.PI;
      pts.push([lng + lngR * Math.cos(a), lat + latR * Math.sin(a)]);
    }
    return {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [pts]}};
  }
  function ensureAccuracyLayer() {
    if (!map.getSource('veh-accuracy')) {
      map.addSource('veh-accuracy', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    }
    if (!map.getLayer('veh-accuracy-fill')) {
      map.addLayer({
        id: 'veh-accuracy-fill', type: 'fill', source: 'veh-accuracy',
        paint: {'fill-color': '#5B8DEF', 'fill-opacity': 0.14},
      }, map.getLayer('route-line') ? 'route-line' : undefined);
    }
  }
  window.setVehicleAccuracy = function(lng, lat, radiusM) {
    try {
      if (!validLL(lng, lat) || !(radiusM > 0)) return;
      lastAccPayload = [lng, lat, radiusM];
      ensureAccuracyLayer();
      var src = map.getSource('veh-accuracy');
      if (src && src.setData) {
        src.setData({type: 'FeatureCollection', features: [circleFeature(lng, lat, radiusM)]});
      }
    } catch(_) {}
  };
  // Review m-4 — when the WS accuracy stream stops (poll-only fixes carry
  // no accuracy), RN clears the circle so it can't sit frozen at a stale
  // position while the dot moves on.
  window.clearVehicleAccuracy = function() {
    try {
      lastAccPayload = null;
      var src = map.getSource('veh-accuracy');
      if (src && src.setData) {
        src.setData({type: 'FeatureCollection', features: []});
      }
    } catch(_) {}
  };

  // Style swap: setStyle drops user sources/layers — once the new style has
  // fully loaded, re-attach the route layer and re-apply the last payloads.
  // DOM markers (origin/dest/vehicle + tags) survive untouched.
  window.setStyle = function(name) {
    try {
      if (!STYLES[name] || name === currentStyle) return;
      currentStyle = name;
      document.body.classList.remove('dark', 'light', 'sat');
      document.body.classList.add(name);
      var segs = document.querySelectorAll('#styleseg .seg');
      for (var i = 0; i < segs.length; i++) {
        segs[i].classList.toggle('on', segs[i].getAttribute('data-style') === name);
      }
      // Layer + payload re-attach happens in the persistent 'style.load'
      // handler above once the new style is fully usable.
      map.setStyle(STYLES[name]);
    } catch(e) { post('err', {where: 'setStyle', msg: String(e)}); }
  };
  (function() {
    var segs = document.querySelectorAll('#styleseg .seg');
    for (var i = 0; i < segs.length; i++) {
      segs[i].addEventListener('click', function() { window.setStyle(this.getAttribute('data-style')); });
    }
  })();
</script>
</body>
</html>`;
}
