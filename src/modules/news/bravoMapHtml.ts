/**
 * Inline Leaflet HTML for the Bravo Map WebView.
 *
 * This is the exact page from the design handoff (`Bravo Intel.html`),
 * trimmed down to the map area only — the React Native side renders
 * the nav/tabs/ticker/stats natively so the WebView only handles the
 * Leaflet canvas. Threat markers are pushed in from JS via
 * `window.updateThreats([...])` (the bridge wrapper posts that from
 * the RN side whenever the intel feed changes).
 */

export const BRAVO_MAP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover"/>
<title>Bravo Map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
<style>
  html, body { margin: 0; padding: 0; background: #06080C; color: #F2F4F8;
    font-family: ui-monospace, Menlo, Consolas, "Roboto Mono", monospace;
    -webkit-font-smoothing: antialiased; overflow: hidden; height: 100%; }
  *, *::before, *::after { box-sizing: border-box; }

  .map-wrap { position: absolute; inset: 0; overflow: hidden; background: #0A1020; }
  #map { width: 100%; height: 100%; background: #0A1020; }
  .map-wrap::before { content:''; position:absolute; top:0; left:0; right:0; height:40px; z-index:5;
    background: linear-gradient(to bottom, rgba(7,9,13,0.9), transparent); pointer-events:none; }
  .map-wrap::after  { content:''; position:absolute; bottom:0; left:0; right:0; height:60px; z-index:5;
    background: linear-gradient(to top, rgba(7,9,13,1), transparent); pointer-events:none; }

  .leaflet-container { background: #0A1020 !important; outline:none; }
  .leaflet-control-attribution, .leaflet-control-zoom { display:none !important; }
  .leaflet-tile { filter: none; }
  .leaflet-fade-anim .leaflet-tile { will-change: opacity, transform; }

  /* crosshair grid overlay */
  .crosshair { position:absolute; inset:0; pointer-events:none; z-index:4;
    background-image:
      linear-gradient(rgba(91,141,239,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(91,141,239,0.04) 1px, transparent 1px);
    background-size: 40px 40px; mix-blend-mode: screen; }

  /* HUD corner */
  .hud-corner { position:absolute; top:10px; left:10px; z-index:30;
    font-size:8px; letter-spacing:1px; color:rgba(180,188,204,0.5);
    text-transform:uppercase; padding:6px 8px; border-radius:6px;
    background: rgba(15,20,30,0.6); border:1px solid rgba(255,255,255,0.06);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
  .hud-corner .h { color:#7FA8FF; font-weight:700; letter-spacing:1.2px; }

  /* Zoom panel */
  .zoom-panel { position:absolute; top:10px; right:10px; z-index:30;
    display:flex; flex-direction:column; gap:8px; }
  .zoom-btn { width:40px; height:40px; border-radius:12px; cursor:pointer;
    background: rgba(15,20,30,0.85); border:1px solid rgba(255,255,255,0.09);
    display:flex; align-items:center; justify-content:center; color:#F2F4F8;
    backdrop-filter: blur(18px) saturate(200%);
    -webkit-backdrop-filter: blur(18px) saturate(200%);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.06);
    transition: transform 0.15s ease, background 0.15s ease; user-select:none;
    -webkit-tap-highlight-color: transparent; }
  .zoom-btn:active { transform: scale(0.93); background: rgba(91,141,239,0.15); }
  .zoom-btn svg { width:16px; height:16px; }

  /* Threat marker — radar pulse + dot + badge + label + sub */
  .threat { position:relative; width:0; height:0; }
  .threat .dot   { position:absolute; left:-6px; top:-6px; width:12px; height:12px; border-radius:50%;
                   background: var(--c); box-shadow: 0 0 12px var(--c); }
  .threat .ring  { position:absolute; left:-19px; top:-19px; width:38px; height:38px; border-radius:50%;
                   border:1.5px solid var(--c); opacity:0.7; }
  .threat .ring2 { position:absolute; left:-28px; top:-28px; width:56px; height:56px; border-radius:50%;
                   border:1px solid var(--c); opacity:0.3;
                   animation: radar 2.4s ease-out infinite; }
  .threat .badge { position:absolute; left:-12px; top:-12px; width:24px; height:24px; border-radius:50%;
                   background: rgba(10,16,32,0.85); border:1.5px solid var(--c);
                   display:flex; align-items:center; justify-content:center;
                   font-size:10px; font-weight:800; color:#fff;
                   backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .threat .label { position:absolute; left:18px; top:-8px; white-space:nowrap;
                   font-size:9px; font-weight:700; letter-spacing:1.2px;
                   color:#E4EAF7; text-transform:uppercase;
                   text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
  .threat .sub   { position:absolute; left:18px; top:4px; white-space:nowrap;
                   font-size:8px; color: var(--c); letter-spacing:0.8px;
                   text-transform:uppercase; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
  @keyframes radar {
    0%   { transform: scale(0.5); opacity:0.7; }
    100% { transform: scale(1.6); opacity:0; }
  }
</style>
</head>
<body>
  <div class="map-wrap">
    <div id="map"></div>
    <div class="crosshair"></div>
    <div class="hud-corner">
      <div class="h">GRID 25°N</div>
      <div>MERCATOR · WGS84</div>
    </div>
    <div class="zoom-panel">
      <div class="zoom-btn" id="zoomIn" aria-label="Zoom in">
        <svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </div>
      <div class="zoom-btn" id="zoomOut" aria-label="Zoom out">
        <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </div>
      <div class="zoom-btn" id="zoomGlobe" aria-label="Reset view">
        <svg viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M10 2.5v15M2.5 10h15M10 2.5c-2.5 2-4 4.5-4 7.5s1.5 5.5 4 7.5c2.5-2 4-4.5 4-7.5s-1.5-5.5-4-7.5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
        </svg>
      </div>
    </div>
  </div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
(function () {
  var post = function (type, payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({type: type, payload: payload}));
      }
    } catch (e) {}
  };

  var map = L.map('map', {
    center: [22, 18],
    zoom: 2.2,
    minZoom: 2,
    maxZoom: 7,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 80,
    zoomAnimation: true,
    fadeAnimation: true,
    markerZoomAnimation: true,
    inertia: true,
    inertiaDeceleration: 2200,
    inertiaMaxSpeed: 1600,
    easeLinearity: 0.22,
    bounceAtZoomLimits: false,
    worldCopyJump: true,
    zoomControl: false,
    attributionControl: false,
    tap: true,
    tapTolerance: 15,
    touchZoom: true,
    doubleClickZoom: true,
    dragging: true,
    keyboard: false,
  });

  // Vector basemap — countries filled in Bravo primary, water stays
  // dark. Uses world-atlas simplified TopoJSON pulled from the same
  // CDN the design mockup used; topojson-client turns it into GeoJSON
  // at load time. No raster tiles = no API key, smaller memory
  // footprint, and an exact primary-colour fill per the brand.
  var BRAVO_PRIMARY = '#1E88FF';
  var LAND_STROKE  = '#3BA2FF';
  var MAP_BG       = '#0A1020';

  map.getContainer().style.background = MAP_BG;

  var topojsonScript = document.createElement('script');
  topojsonScript.src = 'https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js';
  topojsonScript.onload = function () {
    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json')
      .then(function (r) { return r.json(); })
      .then(function (topo) {
        var geo = window.topojson.feature(topo, topo.objects.countries);
        L.geoJSON(geo, {
          style: {
            fillColor:   BRAVO_PRIMARY,
            fillOpacity: 0.42,
            color:       LAND_STROKE,
            weight:      0.6,
            opacity:     0.55,
          },
          interactive: false,
        }).addTo(map);
      })
      .catch(function (err) { post('error', {msg: 'basemap-fetch-failed: ' + err}); });
  };
  document.head.appendChild(topojsonScript);

  // ── Threat markers, replaced whenever the RN side posts new data ──
  var markerLayer = L.layerGroup().addTo(map);

  // Why: label/count come from external news-feed data — escape before innerHTML.
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function severityColor(sev) {
    return sev === 'CRITICAL' ? '#FF5D5D'
         : sev === 'HIGH'     ? '#F5B544'
         : sev === 'MEDIUM'   ? '#7FA8FF'
         :                      '#5B8DEF';
  }

  function subLabel(sev, count) {
    if (sev === 'CRITICAL' || sev === 'HIGH') return sev;
    return count + (count === 1 ? ' SIGNAL' : ' SIGNALS');
  }

  function renderThreats(list) {
    markerLayer.clearLayers();
    (list || []).forEach(function (t) {
      var color = severityColor(t.severity);
      var label = esc((t.label || '').toString().toUpperCase());
      var sub   = esc(subLabel(t.severity, Number(t.count) || 1));
      var html  =
        '<div class="threat" style="--c:' + color + '">' +
          '<div class="ring2"></div>' +
          '<div class="ring"></div>' +
          '<div class="dot"></div>' +
          '<div class="badge">' + esc(Number(t.count) || 1) + '</div>' +
          (label ? '<div class="label">' + label + '</div>' : '') +
          '<div class="sub">' + sub + '</div>' +
        '</div>';
      var icon = L.divIcon({ className: '', html: html, iconSize: [0,0], iconAnchor: [0,0] });
      var marker = L.marker([t.lat, t.lng], { icon: icon, keyboard: false, interactive: true });
      marker.on('click', function () {
        post('markerPress', { lat: t.lat, lng: t.lng, label: t.label });
      });
      marker.addTo(markerLayer);
    });
  }

  // Expose a setter the RN side calls via injectJavaScript
  window.updateThreats = renderThreats;

  // Zoom controls
  document.getElementById('zoomIn').onclick   = function () { map.zoomIn(0.8,  {animate: true, duration: 0.45, easeLinearity: 0.22}); };
  document.getElementById('zoomOut').onclick  = function () { map.zoomOut(0.8, {animate: true, duration: 0.45, easeLinearity: 0.22}); };
  document.getElementById('zoomGlobe').onclick = function () { map.flyTo([22, 18], 2.2, {duration: 0.9, easeLinearity: 0.2}); };

  // Prevent the native-style pinch page zoom from fighting Leaflet's pinch
  document.addEventListener('gesturestart', function (e) {
    if (e.target.closest('#map')) e.preventDefault();
  }, { passive: false });

  post('ready', {});
})();
</script>
</body>
</html>`;
