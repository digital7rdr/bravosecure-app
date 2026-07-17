/**
 * Agent Live Tracker Screen
 *
 * Map-first companion to MissionLeadConsoleScreen. The agent is
 * moving — chrome is minimal, the map and incoming comms are the
 * entire surface.
 *
 *   • Mapbox WebView (bravoAgentTrackerMapHtml) renders pickup,
 *     dropoff, route polyline, the agent's CPO marker (with heading
 *     cone + ripple ring) and the principal marker.
 *   • On-map speech bubbles render every new mission-group message
 *     directly above the sender's marker — fade in 200ms, hold 6s,
 *     fade out 180ms. Stack max 2; older bubbles collapse into a +N
 *     chip. System events render as square info-blue bubbles
 *     anchored to waypoints (not markers).
 *   • Mini-status strip auto-updates as waypoints fire / ETA changes
 *     so the agent always sees the latest event without scanning chat.
 *   • Tap the message dock or any bubble → existing mission-group
 *     Chat screen takes over (the group conversation already exists,
 *     wired via mission.comms_channel_id).
 *   • Right-edge slide handle opens the legacy MissionLeadConsole
 *     (with manual mark buttons) as a horizontal slide-in panel —
 *     swipe right or tap the close button to dismiss.
 *   • Mission complete → MissionSummary screen handles the post-mortem.
 *
 * Backend feed: polls agentApi.getMissionDeployment every 4s. The
 * waypoint list, coordinates, and short-code are the source of truth.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, StatusBar, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, Animated, PanResponder, Modal, AppState,
} from 'react-native';
import {Alert} from '@utils/alert';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi, orgApi} from '@services/api';
import MissionLeadConsoleScreen from './MissionLeadConsoleScreen';
import {useMessengerStore} from '@modules/messenger/store/messengerStore';
import {useAuthStore} from '@store/authStore';
import NetworkLatencyChip from '@components/NetworkLatencyChip';
import MissionStepper from '@components/mission/MissionStepper';
import {launchCall} from '@modules/messenger/webrtc/launchCall';
import {useKeyboardHeight} from '@hooks/useKeyboardHeight';
import {scaleTextStyles} from '@utils/scaling';
import {
  fetchDirections, splitRouteAtProgress, nextManeuver, formatDistance, offRouteDistanceM,
  remainingRouteM, type DirectionsRoute, type LngLat,
} from '@utils/mapboxDirections';

import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// The same map-first tracker serves the assigned agent ('agent'), the managed
// CPO ('cpo', mounted in CpoNavigator), and the org manager desk monitor
// ('monitor', Step 32 — reads the org-scoped live endpoint, SOS hidden). The
// mode steers the data source, terminal navigation, and comms hand-off.
type TrackerMode = 'agent' | 'cpo' | 'monitor';
type TrackerParams = {missionId: string; mode?: TrackerMode};

// Tokens — Brand Kit v4 (mirrors the design HTML exactly)
const C = {
  chrome:   '#07090D',
  depth:    '#05070B',
  surf1:    '#1B3A66',
  surf2:    '#162F54',
  surf3:    '#122747',
  bd1:      '#244C82',
  bd2:      '#1C3B66',
  act:      '#1E88FF',
  acc:      '#00A3FF',
  glow:     '#7ED6FF',
  tx1:      '#FFFFFF',
  tx2:      '#B8C7E0',
  tx3:      '#7E8AA6',
  ok:       '#00C853',
  warn:     '#FFC107',
  err:      '#FF3B3B',
  info:     '#4CC2FF',
};

type StyleId = 'dark' | 'light' | 'sat' | '3d';

interface Waypoint {
  seq: number; tag: string; event: string; state: string;
  settled_at: string | null; marked_via: string | null;
}

type IconName = React.ComponentProps<typeof Icon>['name'];

// MaterialCommunityIcons glyph for the next-maneuver banner.
function maneuverIcon(modifier: string | null, type: string): IconName {
  if (type === 'arrive') {return 'map-marker-check';}
  const m = (modifier ?? '').toLowerCase();
  if (m.includes('uturn')) {return 'arrow-u-left-top';}
  if (m.includes('left')) {return 'arrow-top-left';}
  if (m.includes('right')) {return 'arrow-top-right';}
  return 'arrow-up';
}

export default function AgentLiveTrackerScreen() {
  const route = useRoute();
  const {missionId, mode = 'agent'} = (route.params ?? {}) as TrackerParams;
  const navigation = useNavigation<Nav>();
  // Cross-navigator hops (e.g. the CPO Comms tab) that aren't on AgentStackParamList.
  const navX = navigation as unknown as {navigate: (n: string, p?: Record<string, unknown>) => void};
  const insets = useSafeAreaInsets();
  // B-84 / KB-04 — Android keyboard covered the bottom message dock (KAV
  // has no Android behavior; adjustResize is dead under edge-to-edge).
  // kbHeight replaces insets.bottom while the IME is up: the keyboard
  // spans the gesture-nav area, so stacking both would double-pad.
  const kbHeight = useKeyboardHeight();

  const webRef = useRef<WebView>(null);
  // B-77 — WebView map recovery: watchdog + auto-remount + RETRY overlay. On an
  // OS-initiated WebView process kill the page must reset (audit M-6) — map.retry
  // handles that. `webReady` derives from the health status so the existing
  // marker/route/bubble push effects keep working unchanged.
  const map = useMapReload();
  const webReady = map.status === 'ready';
  const [styleId, setStyleId] = useState<StyleId>('dark');

  // ── Mission state (polled) ──────────────────────────────
  const [shortCode, setShortCode] = useState('');
  const [missionStatus, setMissionStatus] = useState('LIVE');
  // Audit C4 — connection confidence. The poll previously swallowed every
  // error, so a network blip across an ops ABORT left the CPO staring at a
  // confident "LIVE" indefinitely, still able to fire SOS on a dead
  // mission. We now count consecutive poll failures and, past a threshold,
  // surface an explicit "status unconfirmed" state so the CPO stops
  // trusting the stale LIVE and the SOS button reflects the uncertainty.
  const consecutiveFailures = useRef(0);
  const [statusStale, setStatusStale] = useState(false);
  const STALE_AFTER_FAILURES = 3; // ~12s at the 4s poll cadence
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [pickupCoord, setPickupCoord] = useState<{lat: number; lng: number} | null>(null);
  const [dropoffCoord, setDropoffCoord] = useState<{lat: number; lng: number} | null>(null);
  const [polyline, setPolyline] = useState<string | null>(null);
  const [currentLat, setCurrentLat] = useState<number | null>(null);
  const [currentLng, setCurrentLng] = useState<number | null>(null);
  const [currentHeading, setCurrentHeading] = useState<number | null>(null);
  // Step 30 — the principal's (client's) own live position, pushed by their
  // app via telemetryApi.clientPing and surfaced on the crew-gated deployment
  // read (Step 29). Drives the second "Principal" marker so the map shows BOTH
  // the CPO leader and the user being protected.
  const [principalLat, setPrincipalLat] = useState<number | null>(null);
  const [principalLng, setPrincipalLng] = useState<number | null>(null);
  const [callSign, setCallSign] = useState<string>('CPO · YOU');
  const [commsChannelId, setCommsChannelId] = useState<string | null>(null);
  const [hasFix, setHasFix] = useState(false);

  // Mini-status content (auto-rewrites from waypoint events).
  const [statusLabel, setStatusLabel] = useState('Standby · GPS Acquiring');
  const [statusEvent, setStatusEvent] = useState('Awaiting first fix from device');
  const [etaText, setEtaText] = useState<string>('—:—');

  // ── Turn-by-turn navigation (Step 31) ───────────────────
  // Live driving route from the guard's fix to the active target (pickup while
  // heading to the principal, dropoff once LIVE), rendered Google-Maps style.
  // The route is held in refs so re-splitting on every fix doesn't churn
  // renders; only the rendered maneuver banner is component state.
  const navRouteRef = useRef<DirectionsRoute | null>(null);
  const navRouteTargetRef = useRef(''); // which target the cached route is for (P:/D:)
  const desiredTargetKeyRef = useRef(''); // the target wanted right now (staleness guard)
  const navFetchAtRef = useRef(0);
  const navInFlightRef = useRef(false);
  const wasOffRouteRef = useRef(false); // rising-edge gate for the "Re-routing" bubble
  const [navBanner, setNavBanner] = useState<
    {primary: string; secondary: string | null; distanceLabel: string; icon: IconName} | null
  >(null);
  const [navUnavailable, setNavUnavailable] = useState(false);

  // Track which waypoints have already been broadcast as system bubbles
  // so the polling loop doesn't spam them.
  const seenWaypoints = useRef<Set<string>>(new Set());

  // CPO panic. Confirmation prompt before the destructive action so a
  // pocket-tap doesn't fire SOS. Server-side IdempotencyInterceptor +
  // 60s bucketed key collapses frantic multi-taps.
  const [sosInFlight, setSosInFlight] = useState(false);
  const onSosPress = useCallback(() => {
    if (sosInFlight) {return;}
    // Audit C4 — don't fire SOS on a mission we KNOW is terminal (ops
    // aborted/completed it). The server rejects it anyway with a confusing
    // 4xx; catch it client-side with a clear message instead. When status
    // is merely unconfirmed (statusStale), we still allow SOS — in a real
    // emergency the CPO must be able to escalate even mid-blackout, and the
    // server is the final arbiter.
    if (missionStatus === 'COMPLETED' || missionStatus === 'ABORTED' || missionStatus === 'CANCELLED') {
      Alert.alert('Mission closed', 'This mission is no longer active. Contact Ops directly if you need help.');
      return;
    }
    Alert.alert(
      'Raise SOS?',
      'Ops will be paged immediately and the principal will be alerted. Use only if you are in or near a real threat.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'RAISE SOS',
          style: 'destructive',
          onPress: () => {
            setSosInFlight(true);
            void agentApi
              .raiseSos(missionId, {
                reason: 'CPO triggered from live tracker',
                lat: currentLat ?? undefined,
                lng: currentLng ?? undefined,
              })
              .then(() => {
                Alert.alert('SOS raised', 'Ops have been notified. Stay on-scene if safe.');
              })
              .catch(e => {
                const msg = (e as {response?: {data?: {message?: string}}; message?: string})?.response?.data?.message
                  ?? (e as {message?: string})?.message
                  ?? 'Unknown error';
                Alert.alert('SOS failed', String(msg));
              })
              .finally(() => setSosInFlight(false));
          },
        },
      ],
    );
  }, [sosInFlight, missionId, currentLat, currentLng, missionStatus]);

  const refresh = useCallback(async () => {
    try {
      // 'monitor' (org manager, off-scene) reads the org-scoped live endpoint;
      // crew (agent/cpo) read the crew-gated deployment. Same response shape.
      const {data} = mode === 'monitor'
        ? await orgApi.getMissionLive(missionId)
        : await agentApi.getMissionDeployment(missionId);
      // Audit C4 — a successful poll clears the stale-status state.
      consecutiveFailures.current = 0;
      if (statusStale) {setStatusStale(false);}
      setShortCode(data.mission?.short_code ?? '');
      const status = (data.mission?.status ?? 'LIVE').toString().toUpperCase();
      setMissionStatus(status);

      // Terminal-state nav. Without this, ops aborting or completing a
      // mission while the CPO is on this screen leaves them watching
      // stale "LIVE" data with no exit — same regression we just fixed
      // on the principal's LiveTrackingScreen.
      if (status === 'COMPLETED') {
        // 'agent' lives in AgentNavigator (MissionSummary exists there); the CPO
        // tracker is pushed over the CpoNavigator tabs, so it just pops back to
        // the Mission tab which renders the final state.
        if (mode === 'agent') {navigation.replace('MissionSummary', {bookingId: data.mission?.booking_id ?? ''});}
        else {navigation.goBack();}
        return;
      }
      if (status === 'ABORTED' || status === 'CANCELLED') {
        if (mode === 'agent') {navigation.replace('AgentDashboard');}
        else {navigation.goBack();}
        return;
      }

      setCurrentLat(data.mission?.current_lat ?? null);
      setCurrentLng(data.mission?.current_lng ?? null);
      setCurrentHeading(data.mission?.current_heading_deg ?? null);
      setPrincipalLat(data.mission?.client_lat ?? null);
      setPrincipalLng(data.mission?.client_lng ?? null);
      setPolyline(data.mission?.route_polyline ?? null);
      setCommsChannelId(data.mission?.comms_channel_id ?? null);
      setCallSign(data.crew_role?.call_sign ?? 'CPO · YOU');
      setHasFix(
        data.mission?.current_lat !== null && data.mission?.current_lat !== undefined &&
        data.mission?.current_lng !== null && data.mission?.current_lng !== undefined,
      );
      if (data.booking?.pickup_lat && data.booking?.pickup_lng) {
        setPickupCoord({lat: Number(data.booking.pickup_lat), lng: Number(data.booking.pickup_lng)});
      }
      if (data.booking?.dropoff_lat && data.booking?.dropoff_lng) {
        setDropoffCoord({lat: Number(data.booking.dropoff_lat), lng: Number(data.booking.dropoff_lng)});
      }

      const wps = data.waypoints as Waypoint[];
      setWaypoints(wps);

      // Find the latest settled waypoint so the mini-status reads it.
      const latest = [...wps].reverse().find(w => w.state === 'done' && !!w.settled_at);
      const upcoming = wps.find(w => w.state === 'pending' || w.state === 'current');
      if (latest) {
        setStatusLabel(`${latest.tag} cleared`);
        setStatusEvent(latest.event || `${latest.tag} settled`);
      } else {
        setStatusLabel('En Route');
        setStatusEvent('Holding for first checkpoint');
      }

      // Recompute a coarse ETA from the booking pickup time + any
      // pacing the lead pushed in (route_duration_s on the mission).
      // We don't have a precise live-ETA endpoint yet, so we render
      // dispatch_at + route_duration as a reasonable upper bound.
      if (data.mission?.route_duration_s !== null && data.mission?.route_duration_s !== undefined && data.booking?.pickup_lat) {
        // Approximate: now + remaining seconds (decays as real fixes come in).
        const remainingS = Math.max(0, Math.floor(data.mission.route_duration_s));
        const eta = new Date(Date.now() + remainingS * 1000);
        setEtaText(eta.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
      }

      // Push system bubbles for any newly-settled waypoints we
      // haven't broadcast yet.
      if (webReady) {
        const point = upcoming
          ? null
          : (latest && data.booking?.pickup_lat ? {
              lat: Number(data.booking.pickup_lat),
              lng: Number(data.booking.pickup_lng),
            } : null);
        wps.forEach(w => {
          if (w.state === 'done' && !seenWaypoints.current.has(w.tag)) {
            // Anchor the system bubble on the agent's current fix when
            // we have one, falling back to the pickup so it lands
            // somewhere visible on the route.
            const lng = data.mission?.current_lng ?? data.booking?.pickup_lng;
            const lat = data.mission?.current_lat ?? data.booking?.pickup_lat;
            if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) {
              // Why: mark seen only once actually bubbled — marking before the
              // coord check permanently dropped waypoints that arrived before
              // the first fix.
              seenWaypoints.current.add(w.tag);
              webRef.current?.injectJavaScript(
                `window.pushSystem(${JSON.stringify({
                  id: `wp-${w.tag}-${w.settled_at ?? ''}`,
                  label: 'Waypoint',
                  preview: `${w.tag} · ${w.event ?? 'cleared'}`,
                  lat: Number(lat), lng: Number(lng),
                  ttl: 8000,
                })}); true;`,
              );
            }
          }
        });
        // suppress unused-var lint when point isn't used in current branch
        void point;
      }
    } catch {
      // Audit C4 — do NOT silently keep showing a confident "LIVE". A
      // single blip is transient (keep last good state), but sustained
      // failure means we can't confirm the mission is still active — ops
      // may have aborted it while we were blind. Surface that explicitly.
      consecutiveFailures.current += 1;
      if (consecutiveFailures.current >= STALE_AFTER_FAILURES && !statusStale) {
        setStatusStale(true);
      }
    }
  }, [missionId, mode, webReady, navigation, statusStale]);

  useEffect(() => {
    void refresh();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) {id = setInterval(() => { void refresh(); }, 4000);} };
    const stop  = () => { if (id) { clearInterval(id); id = null; } };
    if (AppState.currentState === 'active') {start();}
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') { void refresh(); start(); } else {stop();}
    });
    return () => { stop(); sub.remove(); };
  }, [refresh]);

  // ── Map injection helpers ───────────────────────────────
  const inject = useCallback((js: string) => {
    webRef.current?.injectJavaScript(js + ' true;');
  }, []);

  // ── Live message subscription (sub-second bubble delivery) ──
  //
  // The 4-second poll above only covers waypoint events. Real chat
  // messages flow through the messenger gateway: the WebSocket runtime
  // decrypts envelopes and appends them to messengerStore.messages.
  // Subscribing to that slice gives bubble delivery within a frame of
  // the inbound `envelope.deliver` event — no polling, no jitter.
  const ownUserId   = useAuthStore(s => s.user?.id);
  const groupMsgs   = useMessengerStore(s => commsChannelId ? s.messages[commsChannelId] : undefined);
  const memberNames = useMessengerStore(s => commsChannelId ? s.groupMemberNames[commsChannelId] : undefined);
  const seenMsgIds  = useRef<Set<string>>(new Set());

  // Prime the dedupe set with whatever's already in the store when the
  // conversation rotates. Historical messages aren't bubble-worthy —
  // only sub-second future deliveries from the gateway are.
  useEffect(() => {
    seenMsgIds.current = new Set();
    const snapshot = commsChannelId
      ? useMessengerStore.getState().messages[commsChannelId]
      : undefined;
    if (snapshot) {for (const m of snapshot) {seenMsgIds.current.add(m.id);}}
  }, [commsChannelId]);

  useEffect(() => {
    if (!webReady || !groupMsgs || groupMsgs.length === 0) {return;}
    // Walk forward through the array — newest is last.
    for (const m of groupMsgs) {
      if (seenMsgIds.current.has(m.id)) {continue;}
      seenMsgIds.current.add(m.id);

      // Don't echo our own messages back as bubbles.
      const isSelf = m.sender_id === 'self' || (ownUserId !== undefined && m.sender_id === ownUserId);
      if (isSelf) {continue;}

      const text = (m.content ?? '').trim();
      if (!text) {continue;}

      // System broadcasts ride the existing `system` MessageType.
      // Anchor them at the agent's current fix (or pickup as fallback)
      // so they land on the visible portion of the route.
      if (m.type === 'system') {
        const lat = currentLat ?? pickupCoord?.lat;
        const lng = currentLng ?? pickupCoord?.lng;
        if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) {
          inject(`window.pushSystem(${JSON.stringify({
            id: `msg-sys-${m.id}`,
            label: 'Ops',
            preview: text,
            lat, lng, ttl: 8000,
          })});`);
        }
        continue;
      }

      // SOS — body prefix or explicit kind. Keeps the red bubble usable
      // before the messenger adds a first-class SOS message type.
      const isSos = /^\[SOS\]/i.test(text) || text.toLowerCase().startsWith('sos:');
      const sender = memberNames?.[m.sender_id]
        ?? (m.sender_id ? `U-${m.sender_id.slice(0, 4).toUpperCase()}` : 'CREW');

      inject(`window.pushBubble(${JSON.stringify({
        id: `msg-${m.id}`,
        kind: isSos ? 'sos' : 'msg',
        sender,
        preview: isSos ? text.replace(/^\[SOS\]\s*/i, '').replace(/^sos:\s*/i, '') : text,
        anchor: 'cpo', // sender mapping (client→principal) lands when we
                       // attach role metadata to messages — for now,
                       // every chat message anchors to the agent.
        ttl: isSos ? null : 6000,
      })});`);
    }
  }, [webReady, groupMsgs, ownUserId, memberNames, currentLat, currentLng, pickupCoord, inject]);

  // Push pickup/dropoff/route once we have them + the WebView is ready.
  // Also detects ops re-routes (polyline change) and surfaces a system
  // bubble so the agent has a visible signal — not just a silent redraw.
  const lastPolyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!webReady || !pickupCoord || !dropoffCoord) {return;}
    inject(`window.setRoute(${JSON.stringify({
      pickup: pickupCoord, dropoff: dropoffCoord, polyline,
    })});`);
    const prev = lastPolyRef.current;
    if (prev !== null && polyline !== null && prev !== polyline) {
      // Anchor the bubble on the agent's own marker (or pickup as
      // fallback) so it lands on the visible portion of the map.
      const lat = currentLat ?? pickupCoord.lat;
      const lng = currentLng ?? pickupCoord.lng;
      inject(`window.pushSystem(${JSON.stringify({
        id: `reroute-${Date.now()}`,
        label: 'Route Updated',
        preview: 'Ops re-routed — follow the new polyline',
        lat, lng, ttl: 8000,
      })});`);
      // Also reflect in the mini-status so it's not lost on bubble unmount.
      setStatusLabel('Route Updated');
      setStatusEvent('Ops re-routed — new polyline active');
    }
    lastPolyRef.current = polyline;
  }, [webReady, pickupCoord, dropoffCoord, polyline, currentLat, currentLng, inject]);

  // Push CPO marker as fixes arrive. heading_deg flows through when the
  // deployment read provides it (rotates the HTML heading cone).
  useEffect(() => {
    if (!webReady || currentLat === null || currentLng === null) {return;}
    inject(`window.setCpo(${JSON.stringify({
      lat: currentLat, lng: currentLng,
      callsign: callSign,
      ...(currentHeading !== null ? {heading_deg: currentHeading} : {}),
    })});`);
  }, [webReady, currentLat, currentLng, currentHeading, callSign, inject]);

  // Push the principal (user) marker as their fixes arrive — clearing it when
  // the client stops pinging so a stale dot doesn't linger. This is the visible
  // half of "show both" (Step 30): the CPO leader + the protected person.
  useEffect(() => {
    if (!webReady) {return;}
    if (principalLat === null || principalLng === null) {
      inject('window.setPrincipal(null);');
      return;
    }
    inject(`window.setPrincipal(${JSON.stringify({
      lat: principalLat, lng: principalLng,
    })});`);
  }, [webReady, principalLat, principalLng, inject]);

  // ── Turn-by-turn driving (Step 31) ──────────────────────
  // Active target: the pickup while heading to the principal; the dropoff once
  // protection is LIVE (mirrors the mission FSM).
  const activeTarget = useMemo<LngLat | null>(() => {
    const c = missionStatus === 'LIVE' ? dropoffCoord : pickupCoord;
    return c ? {lng: c.lng, lat: c.lat} : null;
  }, [missionStatus, dropoffCoord, pickupCoord]);

  useEffect(() => {
    if (!webReady || currentLat === null || currentLng === null || !activeTarget) {return;}
    const cpo: LngLat = {lng: currentLng, lat: currentLat};
    const targetKey = `${missionStatus === 'LIVE' ? 'D' : 'P'}:${activeTarget.lng.toFixed(4)},${activeTarget.lat.toFixed(4)}`;

    // Re-split the line at the guard's fix + refresh the maneuver banner + ETA.
    const apply = (rt: DirectionsRoute) => {
      const {traveled, remaining} = splitRouteAtProgress(rt.coordinates, cpo);
      inject(`window.setNavRoute(${JSON.stringify({
        traveled: traveled.map(c => [c.lng, c.lat]),
        ahead: remaining.map(c => [c.lng, c.lat]),
      })});`);
      const nm = nextManeuver(rt, cpo);
      if (nm) {
        setNavBanner({
          primary: nm.step.bannerPrimary || nm.step.instruction || 'Continue',
          secondary: nm.step.bannerSecondary,
          distanceLabel: formatDistance(nm.distanceM),
          icon: maneuverIcon(nm.step.modifier, nm.step.maneuverType),
        });
      } else {
        setNavBanner(null);
      }
      // Live ETA that counts DOWN: scale the route duration by the fraction of
      // the route still AHEAD of the guard — not the full original trip time
      // (which would slide forward and never converge to arrival).
      const remainM = remainingRouteM(rt.coordinates, cpo);
      const frac = rt.distanceM > 0 ? Math.min(1, remainM / rt.distanceM) : 1;
      const remainS = Math.max(0, Math.floor(rt.durationS * frac));
      const eta = new Date(Date.now() + remainS * 1000);
      setEtaText(eta.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
    };

    desiredTargetKeyRef.current = targetKey;
    // Only reuse the cached route if it's for the CURRENT target; a pickup→dropoff
    // (LIVE) flip must refetch and never render the stale leg.
    const existing = navRouteRef.current && navRouteTargetRef.current === targetKey
      ? navRouteRef.current
      : null;
    const offRoute = existing ? offRouteDistanceM(existing.coordinates, cpo) > 60 : true;
    const now = Date.now();
    const throttleOk = now - navFetchAtRef.current > 6000;
    const needFetch = !existing || (offRoute && throttleOk);

    if (needFetch && !navInFlightRef.current) {
      navInFlightRef.current = true;
      navFetchAtRef.current = now;
      const fetchKey = targetKey;
      // Fire the "Re-routing" bubble only on the rising edge of a deviation
      // (entering off-route), never repeatedly while we keep refetching.
      const deviated = !!existing && offRoute && !wasOffRouteRef.current;
      void fetchDirections(cpo, activeTarget)
        .then(rt => {
          navInFlightRef.current = false;
          if (rt) {
            navRouteRef.current = rt;
            navRouteTargetRef.current = fetchKey;
            // Drop a late result whose target is no longer wanted (mission went
            // LIVE mid-flight) so we never paint the stale pickup leg.
            if (fetchKey !== desiredTargetKeyRef.current) {return;}
            setNavUnavailable(false);
            if (deviated) {
              inject(`window.pushSystem(${JSON.stringify({
                id: `reroute-${now}`, label: 'Re-routing', preview: 'New route — follow the line',
                lat: currentLat, lng: currentLng, ttl: 6000,
              })});`);
            }
            apply(rt);
          } else if (!existing) {
            setNavUnavailable(true);
            // MG-08 — Directions unavailable for a NEW leg: push an EMPTY
            // nav frame so the HTML un-latches navActive and redraws the
            // base route line, instead of leaving the previous leg's
            // turn-by-turn on screen under the "Navigation unavailable"
            // banner (review m-3: the un-latch was unreachable without this).
            if (fetchKey === desiredTargetKeyRef.current) {
              inject('window.setNavRoute({traveled: [], ahead: []});');
            }
          }
        })
        .catch(() => { navInFlightRef.current = false; });
    } else if (existing) {
      apply(existing);
    }
    wasOffRouteRef.current = offRoute;
  }, [webReady, currentLat, currentLng, activeTarget, missionStatus, inject]);

  // Push style swaps.
  useEffect(() => {
    if (!webReady) {return;}
    inject(`window.setStyle(${JSON.stringify(styleId)});`);
  }, [webReady, styleId, inject]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {type?: string; id?: string; where?: string; msg?: string};
      if (msg.type === 'ready') {map.onReady();}
      // MG-11 — fast-fail ONLY on definitely-fatal boot errors (WebGL
      // init, token 401/403); recoverable pre-load tile blips must not
      // burn the auto-retry (review m-2).
      const fatal = msg.type === 'gl-unsupported'
        || (msg.type === 'err' && (msg.where === 'init'
            || /401|403|unauthorized|forbidden|access token/i.test(String(msg.msg ?? ''))));
      if (fatal) {map.onError();}
      if (msg.type === 'bubble.tap' || msg.type === 'chip.tap') {openChat();}
    } catch { /* ignore */ }
  };

  const html = useMemo(() => {
    // Lazy-require so the heavy template literal only loads when this
    // screen mounts.

    const {buildAgentTrackerHtml} = require('@modules/booking/bravoAgentTrackerMapHtml') as {
      buildAgentTrackerHtml: (t: string) => string;
    };
    return buildAgentTrackerHtml(MAPBOX_TOKEN);
  }, []);
  // Why: a stable source identity avoids leaning on the WebView's internal
  // html string diff to prevent a full map reload on unrelated re-renders.
  const webSource = useMemo(() => ({html}), [html]);

  // ── Message dock + keyboard ─────────────────────────────
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);

  const openChat = useCallback((prefilled?: string) => {
    // The CPO build's chat/call screens live in the Comms tab, not on the root
    // stack that hosts this tracker — hop to that tab rather than navigate to a
    // route that isn't registered here (which would no-op).
    if (mode === 'cpo') {
      navX.navigate('CpoTabs', {screen: 'CpoComms'});
      return;
    }
    if (!commsChannelId) {
      Alert.alert('Mission group not ready', 'Ops will provision the group chat shortly.');
      return;
    }
    navigation.navigate('Chat', {
      conversationId: commsChannelId,
      name: shortCode || 'Mission',
      isGroup: true,
      draft: prefilled,
    });
  }, [mode, commsChannelId, shortCode, navigation, navX]);

  const onCall = useCallback((callType: 'voice' | 'video') => {
    if (mode === 'cpo') {
      navX.navigate('CpoTabs', {screen: 'CpoComms'});
      return;
    }
    if (!commsChannelId) {
      Alert.alert('Mission group not ready', 'Ops will provision the channel shortly.');
      return;
    }
    // navX is `navigation` cast to launchCall's NavLike shape (same object at runtime).
    // LIVE-MONITOR-CHAT (area 8 #4) — the mission Ops Room is always a group; pass
    // the explicit hint so the call routes to the group/SFU path even on a cold
    // open where messengerStore hasn't materialized the conversation yet (without
    // it, isGroupConversation() returns false → broken 1:1 route → "call failed").
    launchCall(navX, {conversationId: commsChannelId, callType, isGroup: true});
  }, [mode, commsChannelId, navX]);

  const sendDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) {return;}
    // Hand off to the existing Chat screen for the actual send so we
    // stay aligned with the messenger's encryption + receipts model.
    // Pass the typed text as `draft` so ChatScreen seeds its composer
    // with it (previously the text silently disappeared on hand-off).
    openChat(trimmed);
    setDraft('');
  };

  // ── Slide-in overlay (the lead-console panel) ───────────
  const SLIDE_W = 360;
  const slideX = useRef(new Animated.Value(SLIDE_W)).current;
  const [overlayOpen, setOverlayOpen] = useState(false);

  const openOverlay = () => {
    setOverlayOpen(true);
    Animated.timing(slideX, {toValue: 0, duration: 260, useNativeDriver: true}).start();
  };
  const closeOverlay = useCallback(() => {
    Animated.timing(slideX, {toValue: SLIDE_W, duration: 220, useNativeDriver: true})
      .start(() => setOverlayOpen(false));
  }, [slideX]);

  // Swipe-right on the panel dismisses it.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dy) < 24,
      onPanResponderMove: (_, g) => { if (g.dx >= 0) {slideX.setValue(g.dx);} },
      onPanResponderRelease: (_, g) => {
        if (g.dx > SLIDE_W * 0.35 || g.vx > 0.4) {closeOverlay();}
        else {Animated.spring(slideX, {toValue: 0, useNativeDriver: true, bounciness: 0}).start();}
      },
    }),
  ).current;

  // Hide chrome that conflicts with the keyboard while the input is focused.
  const showAwaiting = !hasFix && !focused;
  // Turn-by-turn banner pushes the style toggle + slide handle down so nothing
  // overlaps the next-maneuver card.
  const navShown = hasFix && (!!navBanner || navUnavailable);
  const navOffset = navShown ? 76 : 0;
  // Audit H5 — terminal mission → SOS unavailable (button greyed + guarded).
  const isMissionTerminal =
    missionStatus === 'COMPLETED' || missionStatus === 'ABORTED' || missionStatus === 'CANCELLED';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.depth} />

      {/* ── Map ─────────────────────────────────────── */}
      <View style={s.mapWrap}>
        {MAPBOX_TOKEN_MISSING ? (
          // MG-04 — tokenless build: honest state instead of a watchdog loop.
          <MapFailedOverlay onRetry={() => {}} variant="misconfigured" />
        ) : (
          <>
            <WebView
              key={`agent-map-${map.reloadKey}`}
              ref={webRef}
              originWhitelist={['*']}
              source={webSource}
              style={s.web}
              onMessage={onMessage}
              javaScriptEnabled
              domStorageEnabled
              allowsInlineMediaPlayback
              androidLayerType="hardware"
              onRenderProcessGone={map.retry}
              onContentProcessDidTerminate={map.retry}
            />
            {map.status === 'loading' && <MapFailedOverlay onRetry={map.retry} variant="loading" />}
            {map.status === 'failed' && <MapFailedOverlay onRetry={map.retry} />}
          </>
        )}
      </View>

      {/* ── Top bar ─────────────────────────────────── */}
      <View style={[s.topBar, {top: insets.top + 4}]}>
        <TouchableOpacity style={s.iconBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={C.tx1} />
        </TouchableOpacity>
        <View style={s.codePill}>
          <View style={s.liveChip}>
            <View style={s.liveDot} />
            {/* Audit C4 — when polls have been failing, stop asserting LIVE;
                show that the status is unconfirmed so the CPO doesn't trust
                a stale state that ops may have aborted. */}
            <Text style={s.liveTxt}>{statusStale ? 'RECONNECTING…' : (missionStatus || 'LIVE')}</Text>
          </View>
          <Text style={s.codeTxt} numberOfLines={1}>{shortCode || `MSN-${missionId.slice(0, 8).toUpperCase()}`}</Text>
        </View>
        <NetworkLatencyChip compact />
        <TouchableOpacity style={s.iconBtn} activeOpacity={0.7} onPress={openOverlay}>
          <Icon name="dots-vertical" size={20} color={C.tx1} />
        </TouchableOpacity>
      </View>

      {/* ── Turn-by-turn maneuver banner (Step 31) ──── */}
      {navShown && (
        navBanner ? (
          <View style={[s.navBanner, {top: insets.top + 50}]}>
            <View style={s.navIcon}><Icon name={navBanner.icon} size={26} color={C.glow} /></View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.navDist} numberOfLines={1}>{navBanner.distanceLabel}</Text>
              <Text style={s.navPrimary} numberOfLines={1}>{navBanner.primary}</Text>
              {!!navBanner.secondary && <Text style={s.navSecondary} numberOfLines={1}>{navBanner.secondary}</Text>}
            </View>
          </View>
        ) : (
          <View style={[s.navBanner, {top: insets.top + 50}]}>
            <View style={s.navIcon}><Icon name="map-marker-off" size={22} color={C.tx3} /></View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.navPrimary}>Navigation unavailable</Text>
              <Text style={s.navSecondary} numberOfLines={1}>Showing the last known route</Text>
            </View>
          </View>
        )
      )}

      {/* ── Style toggle ────────────────────────────── */}
      <View style={[s.styleToggle, {top: insets.top + 64 + navOffset}]}>
        {(['dark', 'light', 'sat', '3d'] as StyleId[]).map(k => (
          <TouchableOpacity key={k} onPress={() => setStyleId(k)} activeOpacity={0.7}
            style={[s.styleSeg, styleId === k && s.styleSegOn]}>
            <Text style={[s.styleSegTxt, styleId === k && s.styleSegTxtOn]}>{k.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Slide handle (right edge — opens lead console) ── */}
      <TouchableOpacity
        style={[s.slideHandle, {top: insets.top + 200 + navOffset}]}
        onPress={openOverlay}
        activeOpacity={0.85}>
        <View style={s.slideBar} />
        <View style={s.slideBar} />
        <View style={s.slideBar} />
      </TouchableOpacity>

      {/* ── Awaiting telemetry pill ─────────────────── */}
      {showAwaiting && (
        <View style={[s.awaiting, {bottom: 220 + insets.bottom}]}>
          <View style={s.spinner} />
          <Text style={s.awaitingTxt}>Awaiting Telemetry</Text>
        </View>
      )}

      {/* ── Bottom dock + mini-status (keyboard-aware) ── */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[s.kbWrap, {paddingBottom: Platform.OS === 'android' && kbHeight > 0 ? kbHeight : insets.bottom}]}>
        {/* Message dock */}
        <View style={s.msgDock}>
          <View style={s.callBtns}>
            <TouchableOpacity style={s.callBtn} activeOpacity={0.7} onPress={() => onCall('voice')}>
              <Icon name="phone" size={15} color={C.glow} />
            </TouchableOpacity>
            <TouchableOpacity style={[s.callBtn, s.callBtnVideo]} activeOpacity={0.7} onPress={() => onCall('video')}>
              <Icon name="video" size={15} color={C.glow} />
            </TouchableOpacity>
          </View>
          <View style={s.callBtnsDivider} />
          <TextInput
            style={s.field}
            placeholder="Message ops or crew…"
            placeholderTextColor={C.tx3}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            returnKeyType="send"
            onSubmitEditing={sendDraft}
          />
          {draft.trim().length > 0 ? (
            <TouchableOpacity style={s.send} onPress={sendDraft} activeOpacity={0.85}>
              <Icon name="send" size={16} color="#fff" />
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity style={s.icBtn} onPress={() => openChat()} activeOpacity={0.7}>
                <Icon name="emoticon-outline" size={18} color={C.tx2} />
              </TouchableOpacity>
              {/* Audit H5 — grey out + disable SOS on a known-terminal
                  mission so the CPO can't tap into a confusing server 4xx.
                  onSosPress also guards this; the disabled state makes the
                  unavailability visible. SOS is hidden in 'monitor' mode — the
                  off-scene manager isn't crew and raiseSos is crew-gated. */}
              {mode !== 'monitor' && (
                <TouchableOpacity
                  style={[s.ptt, (sosInFlight || isMissionTerminal) && {opacity: 0.4}]}
                  activeOpacity={0.7}
                  disabled={sosInFlight || isMissionTerminal}
                  onPress={onSosPress}>
                  <Icon name="alert-octagon" size={15} color={C.err ?? '#ef4444'} />
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        {/* Step 20 — shared mission stepper (same 6-step bar the client + CPO see). */}
        <View style={{paddingHorizontal: 12, paddingVertical: 8}}>
          <MissionStepper booking={{status: 'CONFIRMED'}} mission={{status: missionStatus}} />
        </View>

        {/* Mini-status — auto-rewrites from waypoint events */}
        <View style={s.miniStatus}>
          <View style={s.wpIc}>
            <Icon name={hasFix ? 'check-bold' : 'clock-outline'} size={14} color={C.ok} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.miniLbl} numberOfLines={1}>{statusLabel}</Text>
            <Text style={s.miniEv}  numberOfLines={1}>{statusEvent}</Text>
          </View>
          <View style={s.eta}>
            <Text style={s.etaK}>ETA</Text>
            <Text style={s.etaV}>{etaText}</Text>
          </View>
        </View>

        {/* Attribution — render only when not focused so the keyboard
            push doesn't double-stack the line. */}
        {!focused && (
          <Text style={s.attrib}>© Mapbox · OSM · Bravo · {missionStatus}</Text>
        )}
      </KeyboardAvoidingView>

      {/* ── Slide-in overlay: legacy MissionLeadConsole ── */}
      <Modal visible={overlayOpen} transparent animationType="fade" onRequestClose={closeOverlay}>
        <View style={s.overlayBackdrop}>
          <Animated.View
            style={[s.overlayPanel, {width: SLIDE_W, transform: [{translateX: slideX}]}]}
            {...pan.panHandlers}>
            <View style={s.overlayHandleArea} pointerEvents="box-none">
              <TouchableOpacity style={s.overlayClose} onPress={closeOverlay} activeOpacity={0.85}>
                <Icon name="chevron-right" size={22} color={C.tx1} />
              </TouchableOpacity>
            </View>
            <View style={{flex: 1}}>
              <MissionLeadConsoleScreen />
            </View>
          </Animated.View>
          <TouchableOpacity style={s.overlayDismiss} onPress={closeOverlay} activeOpacity={1} />
        </View>
      </Modal>

      {/* Waypoints debug count helps verify polling — invisible padding. */}
      <View style={{height: 0, opacity: 0}} pointerEvents="none">
        <Text>{waypoints.length}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: C.depth},
  mapWrap: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
  web: {flex: 1, backgroundColor: C.depth},

  // Top bar
  topBar: {
    position: 'absolute', left: 14, right: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    zIndex: 15,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2,
    alignItems: 'center', justifyContent: 'center',
  },
  codePill: {
    flex: 1, height: 38, borderRadius: 10,
    paddingHorizontal: 12, gap: 8,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2,
  },
  liveChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 3, paddingHorizontal: 7, borderRadius: 5,
    backgroundColor: 'rgba(0,200,83,0.12)',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.3)',
  },
  liveDot: {width: 5, height: 5, borderRadius: 2.5, backgroundColor: C.ok},
  liveTxt: {color: C.ok, fontSize: 9.5, fontWeight: '800', letterSpacing: 1.4, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  codeTxt: {flex: 1, color: C.tx1, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.6, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},

  // Turn-by-turn maneuver banner
  navBanner: {
    position: 'absolute', left: 14, right: 14,
    minHeight: 64, borderRadius: 14,
    backgroundColor: 'rgba(10,31,63,0.94)',
    borderWidth: 1, borderColor: C.bd2,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 10, zIndex: 14,
  },
  navIcon: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: 'rgba(30,136,255,0.15)',
    borderWidth: 1, borderColor: 'rgba(30,136,255,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  navDist: {color: C.glow, fontSize: 16, fontWeight: '800', letterSpacing: 0.3, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  navPrimary: {color: C.tx1, fontSize: 14, fontWeight: '700', marginTop: 1},
  navSecondary: {color: C.tx2, fontSize: 11.5, fontWeight: '500', marginTop: 1},

  // Style toggle
  styleToggle: {
    position: 'absolute', right: 14,
    width: 38, borderRadius: 10, overflow: 'hidden',
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2, zIndex: 12,
  },
  styleSeg: {height: 38, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: C.bd2},
  styleSegOn: {backgroundColor: 'rgba(30,136,255,0.18)'},
  styleSegTxt: {fontSize: 9, fontWeight: '800', color: C.tx3, letterSpacing: 1, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  styleSegTxtOn: {color: C.glow},

  // Right-edge slide handle
  slideHandle: {
    position: 'absolute', right: 0, width: 22, height: 64, borderRadius: 8,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderTopLeftRadius: 14, borderBottomLeftRadius: 14,
    borderWidth: 1, borderRightWidth: 0, borderColor: C.bd2,
    alignItems: 'center', justifyContent: 'center', gap: 4, zIndex: 12,
  },
  slideBar: {width: 2, height: 14, borderRadius: 1, backgroundColor: C.glow, opacity: 0.7},

  // Awaiting pill
  awaiting: {
    position: 'absolute', alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20,
    backgroundColor: 'rgba(255,193,7,0.12)',
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.45)', zIndex: 12,
    left: '50%', transform: [{translateX: -90}],
  },
  spinner: {
    width: 12, height: 12, borderRadius: 6,
    borderWidth: 2, borderColor: 'rgba(255,193,7,0.3)', borderTopColor: C.warn,
  },
  awaitingTxt: {color: C.warn, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.6, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},

  // Bottom dock keyboard wrap
  kbWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 14, paddingTop: 8, gap: 8,
  },

  // Message dock
  msgDock: {
    height: 50, borderRadius: 25,
    backgroundColor: 'rgba(10,31,63,0.94)',
    borderWidth: 1, borderColor: C.bd2,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingLeft: 8, paddingRight: 6,
  },
  callBtns: {flexDirection: 'row', gap: 4, alignItems: 'center'},
  callBtnsDivider: {width: 1, height: 22, backgroundColor: C.bd2, marginHorizontal: 4},
  callBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(30,136,255,0.12)',
    borderWidth: 1, borderColor: 'rgba(30,136,255,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  callBtnVideo: {
    backgroundColor: 'rgba(126,214,255,0.10)',
    borderColor: 'rgba(126,214,255,0.28)',
  },
  field: {flex: 1, color: C.tx1, fontSize: 12.5, fontWeight: '500', minWidth: 0, paddingVertical: 4},
  icBtn: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  send: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: C.act,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.act, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.6, shadowRadius: 12, elevation: 6,
  },
  ptt: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(0,200,83,0.15)',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Mini-status strip
  miniStatus: {
    height: 54, borderRadius: 14,
    backgroundColor: 'rgba(22,47,84,0.92)',
    borderWidth: 1, borderColor: C.bd2,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
  },
  wpIc: {
    width: 30, height: 30, borderRadius: 8,
    backgroundColor: 'rgba(0,200,83,0.15)',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  miniLbl: {color: C.ok, fontSize: 9, fontWeight: '800', letterSpacing: 1.5, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  miniEv:  {color: C.tx1, fontSize: 13, fontWeight: '600', marginTop: 1},
  eta: {alignItems: 'flex-end', paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: C.bd2},
  etaK: {color: C.tx3, fontSize: 9, fontWeight: '700', letterSpacing: 1.4, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},
  etaV: {color: C.tx1, fontSize: 14.5, fontWeight: '800', letterSpacing: 0.5, fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'})},

  attrib: {
    color: C.tx3, fontSize: 9, alignSelf: 'flex-start',
    marginTop: 2, paddingLeft: 4,
    fontFamily: Platform.select({ios: 'Menlo', default: 'monospace'}),
  },

  // Slide-in overlay
  overlayBackdrop: {flex: 1, backgroundColor: 'rgba(4,16,31,0.55)', flexDirection: 'row'},
  overlayDismiss: {flex: 1},
  overlayPanel: {
    backgroundColor: C.depth,
    borderLeftWidth: 1, borderLeftColor: C.bd1,
    shadowColor: '#000', shadowOffset: {width: -8, height: 0}, shadowOpacity: 0.5, shadowRadius: 18, elevation: 18,
  },
  overlayHandleArea: {
    position: 'absolute', top: 12, left: 8, zIndex: 30,
  },
  overlayClose: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: C.bd2,
    alignItems: 'center', justifyContent: 'center',
  },
}));
