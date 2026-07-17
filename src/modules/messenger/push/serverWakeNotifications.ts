/**
 * Shared server-driven wake → notification dispatch.
 *
 * CRIT-5 — the killed-app headless handler (fcmHeadless) previously handled
 * ONLY voip-wake / msg-wake and dropped every other server wake with
 * "unknown kind, no action" — so SOS / mission-dispatched / booking-approved /
 * agent-* / payout-settled and opaque {eventId} wakes surfaced NOTHING when the
 * app was fully killed. The warm handler (fcmBootstrap.setBackgroundMessageHandler)
 * DID handle them, so the two paths had drifted. This module is the single
 * source of truth both handlers call, so they can never drift again.
 *
 * SAFE FOR HEADLESS JS: draws via notifee and hydrates via fetch only. It never
 * boots the messenger runtime / libsignal / SQLCipher / WS (the 2nd-VM
 * contention the headless task avoids). All native deps are lazy-`require()`d
 * (Hermes headless can't reliably dynamic-`import()`), which also keeps this
 * module importable in the node test env.
 *
 * PRIVACY: opaque server wakes carry ONLY {eventId, eventClass} on the FCM
 * channel (P0-N8). The real detail (bookingId/missionId/kind) is fetched from
 * the JWT-gated, recipient-bound `GET /events/by-id/:eventId` — never put on the
 * cleartext push payload.
 */

type WakeData = Record<string, unknown>;

// P3 (background-reliability audit 2026-07-10): the v1 'sos-alerts' channel
// claimed DND-bypass but was created without `bypassDnd` (or any distinct
// sound), so a panic alert was DND-suppressed like a routine booking notif.
// Android channel config is immutable after creation, so the fix ships as a
// NEW channel id + a delete of the stale v1 — the same migration pattern as
// bravo-incoming-call-v2 (callNotification.ts). No dedicated SOS sound asset
// exists in res/raw (only call ring/ringback), so v2 keeps the default sound;
// bypassDnd is the safety-relevant part. Note: Android honors a channel's
// bypassDnd only once the user grants the app DND access (or toggles
// "Override Do Not Disturb" on the channel) — verify on-device.
const SOS_CHANNEL_ID = 'sos-alerts-v2';
const LEGACY_SOS_CHANNEL_ID = 'sos-alerts';
let legacySosChannelRetired = false;

// B-66 — small-icon tint (obsidian cobalt). Local constant, NOT imported from
// callNotification: this module runs in the headless-wake path and must keep
// its module graph minimal.
const NOTIF_ACCENT = '#5B8DEF';

/**
 * Hydrate an opaque server push wake. Returns the parsed detail
 * (e.g. {kind:'sos-cpo-alert', missionId, bookingId}) or null on any miss —
 * a null just means the wake stays generic, never an error.
 */
export async function hydratePushEvent(eventId: string): Promise<Record<string, unknown> | null> {
  const {refreshAccessTokenShared} = require('@services/api') as typeof import('@services/api');
  const {API_BASE_URL} = require('@utils/constants') as typeof import('@utils/constants');
  const AsyncStorage = (require('@react-native-async-storage/async-storage') as {default: {getItem(k: string): Promise<string | null>}}).default;
  async function attempt(retried: boolean): Promise<Record<string, unknown> | null> {
    let access = await AsyncStorage.getItem('auth:access_token');
    if (!access) {
      if (retried) {return null;}
      try { await refreshAccessTokenShared(); } catch { return null; }
      access = await AsyncStorage.getItem('auth:access_token');
      if (!access) {return null;}
    }
    const res = await fetch(`${API_BASE_URL}/events/by-id/${encodeURIComponent(eventId)}`, {
      method:  'GET',
      headers: {Authorization: `Bearer ${access}`, 'X-Signal-Device-Id': '1'},
    });
    if (res.status === 401 && !retried) {
      try { await refreshAccessTokenShared(); } catch { return null; }
      return attempt(true);
    }
    if (!res.ok) {return null;}
    try { return (await res.json()) as Record<string, unknown>; } catch { return null; }
  }
  return attempt(false);
}

const AGENT_WAKE_META: Record<string, {title: string; body: string; sos: boolean; channel?: string}> = {
  'agent-approved':    {title: 'Application approved', body: 'You can now apply for jobs.', sos: false},
  'agent-rejected':    {title: 'Application not approved', body: 'Tap for details.', sos: false},
  'mission-dispatched':{title: 'Mission dispatched', body: 'Ops has assigned you. Tap to open.', sos: false},
  'mission-aborted':   {title: 'Mission aborted', body: 'Ops cancelled the mission. Stand down.', sos: false},
  'payout-settled':    {title: 'Payout settled', body: 'Your earnings have been credited.', sos: false},
  'sos-cpo-alert':     {title: 'SOS · crew alert', body: 'A team member raised SOS. Tap to respond.', sos: true},
  // LM-N1 — the incoming job offer wake (30s TTL): its own channel so an agency
  // manager can max its priority independently of routine agent updates.
  'dispatch-offer':    {title: 'Incoming job offer', body: 'A mission offer is waiting — 30 seconds to respond.', sos: false, channel: 'dispatch-offers'},
  // LM-C7 — a crew member asked the agency to close a mission (lead unreachable).
  'mission-complete-requested': {title: 'Completion requested', body: 'A crew member asked to close a mission. Confirm on the missions board.', sos: false},
  // LM-N4 — client lifecycle wakes that were previously silent (or card-only).
  'provider-accepted':    {title: 'Agency accepted', body: 'An agency accepted your request. Tap to view your detail.', sos: false, channel: 'booking-updates'},
  'no-provider':          {title: 'No agency available', body: 'We could not find an available agency. Tap for options.', sos: false, channel: 'booking-updates'},
  'agency-no-show':       {title: 'Agency did not crew', body: 'Your booking was cancelled and fully refunded.', sos: false, channel: 'booking-updates'},
  'booking-redispatching':{title: 'Reassigning your detail', body: 'Your crew was reassigned — finding a replacement now.', sos: false, channel: 'booking-updates'},
  'payment-failed':       {title: 'Payment failed', body: 'Your booking could not be charged. Top up and try again.', sos: false, channel: 'booking-updates'},
  'booking-rejected':     {title: 'Booking not approved', body: 'Ops could not approve your booking. Tap for details.', sos: false, channel: 'booking-updates'},
  'booking-completed':    {title: 'Mission complete', body: 'Your detail has completed. Tap to rate and view your receipt.', sos: false, channel: 'booking-updates'},
  'refund-issued':        {title: 'Refund issued', body: 'Credits were returned to your wallet.', sos: false, channel: 'booking-updates'},
  'crew-assigned':        {title: 'Crew assigned', body: 'Your protection team is being prepared. Tap to track.', sos: false, channel: 'booking-updates'},
  // LM-N4 — mission-progress steps (previously silent to the client).
  'detail-enroute':       {title: 'Your detail is en route', body: 'Your protection officer is on the way. Tap to track.', sos: false, channel: 'booking-updates'},
  'detail-live':          {title: 'Protection active', body: 'Your protection detail is now live. Tap to track.', sos: false, channel: 'booking-updates'},
  'dispute-opened':       {title: 'Dispute opened', body: 'A dispute was opened on your booking. Ops will review it.', sos: false, channel: 'booking-updates'},
  'dispute-resolved':     {title: 'Dispute resolved', body: 'Ops resolved the dispute on your booking. Tap for the outcome.', sos: false, channel: 'booking-updates'},
  // N-21 — the 'incident' push class (Dept Chat v2) was published by the server
  // but had NO client meta entry, so incident wakes fell through to
  // "unknown kind, no action" and surfaced nothing. Own channel so managers can
  // prioritise incident alerts independently of routine booking updates.
  'incident-submitted':   {title: 'Incident reported', body: 'A CPO filed an incident. Tap to review.', sos: false, channel: 'incident-updates'},
  'incident-status':      {title: 'Incident update', body: 'An incident status changed. Tap for details.', sos: false, channel: 'incident-updates'},
};

/**
 * N-18 — map a server-wake kind to the in-app activity feed's coarse class so a
 * wake also lands a durable row in the notification centre (bell), not just an
 * OS banner that vanishes when swiped.
 */
type ActivityClassLike = 'booking' | 'dispatch' | 'mission' | 'payout' | 'sos' | 'agent' | 'incident';
function kindToActivityClass(kind: string): ActivityClassLike | null {
  if (kind === 'dispatch-offer') {return 'dispatch';}
  if (kind === 'payout-settled') {return 'payout';}
  if (kind.startsWith('mission-')) {return 'mission';}
  if (kind.startsWith('agent-')) {return 'agent';}
  if (kind.startsWith('sos')) {return 'sos';}
  if (kind.startsWith('incident')) {return 'incident';}
  if (kind === 'booking-approved') {return 'booking';}
  const BOOKING = new Set([
    'provider-accepted', 'no-provider', 'agency-no-show', 'booking-redispatching',
    'payment-failed', 'booking-rejected', 'booking-completed', 'refund-issued',
    'crew-assigned', 'detail-enroute', 'detail-live', 'dispute-opened',
    'dispute-resolved', 'mission-complete-requested',
  ]);
  if (BOOKING.has(kind)) {return 'booking';}
  return null;
}

/**
 * N-18 — drop a durable row in the in-app notification centre for a hydrated
 * wake. Only invoked from WARM handlers (where the persisted activity store has
 * rehydrated); the fully-killed headless path skips it to avoid clobbering the
 * store before zustand-persist rehydrates — the server inbox (N-20) backfills
 * it on next foreground.
 */
function recordActivityForWake(kind: string, title: string, body: string, data: Record<string, unknown>): void {
  const eventClass = kindToActivityClass(kind);
  if (!eventClass) {return;}
  try {
    const {recordActivity} = require('@store/activityStore') as typeof import('@store/activityStore');
    const id = typeof data.eventId === 'string' ? data.eventId
      : typeof data.missionId === 'string' ? `${kind}-${data.missionId}`
      : typeof data.bookingId === 'string' ? `${kind}-${data.bookingId}`
      : `${kind}-${Date.now()}`;
    recordActivity({
      id,
      eventClass,
      kind,
      title,
      subtitle: body,
      bookingId: typeof data.bookingId === 'string' ? data.bookingId : undefined,
      missionId: typeof data.missionId === 'string' ? data.missionId : undefined,
      expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined,
    });
  } catch (e) {
    console.warn('[fcm] recordActivity failed:', (e as Error).message);
  }
}

/**
 * Draw the local notification for a server-driven wake. Hydrates an opaque
 * {eventId} wake first. Returns true if a notification was drawn (kind handled),
 * false if the kind is not a server-event kind (caller logs "no action").
 *
 * Does NOT handle voip-wake / msg-wake — those have app-state-specific ringing
 * / envelope-pull behavior and stay in the per-handler code.
 */
export async function showServerWakeNotification(
  dataIn: WakeData,
  opts?: {recordActivity?: boolean},
): Promise<boolean> {
  const data: Record<string, unknown> = {...dataIn};

  // Opaque server wake ({eventId, eventClass}, no inline kind) → hydrate the
  // real kind/detail so the routing below can surface the right notification.
  if (typeof data.eventId === 'string' && !data.kind) {
    try {
      const detail = await hydratePushEvent(data.eventId);
      if (detail) {
        for (const [k, v] of Object.entries(detail)) {
          if (typeof v === 'string') {data[k] = v;}
        }
      }
    } catch (e) {
      console.warn('[fcm] event hydrate failed:', (e as Error).message);
    }
  }

  const kind = typeof data.kind === 'string' ? data.kind : '';

  if (kind === 'booking-approved' && typeof data.bookingId === 'string') {
    const bookingId = data.bookingId as string;
    // Validate UUID-ish shape before threading through notifee / tap-route.
    if (!/^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(bookingId)) {
      console.warn('[fcm] booking-approved bookingId rejected (bad shape):', bookingId.slice(0, 16));
      return true; // kind recognised, just not actioned
    }
    try {
      const {default: notifee, AndroidImportance} = require('@notifee/react-native') as typeof import('@notifee/react-native');
      const channelId = await notifee.createChannel({
        id: 'booking-updates',
        name: 'Booking updates',
        importance: AndroidImportance.HIGH,
      });
      await notifee.displayNotification({
        id: `booking-approved-${bookingId}`,
        title: 'Booking approved',
        body: 'Ops approved your booking. Tap to continue.',
        data: {kind: 'booking-approved', bookingId},
        android: {
          channelId,
          smallIcon: 'ic_stat_bravo',
          color: NOTIF_ACCENT, // B-66
          importance: AndroidImportance.HIGH,
          onlyAlertOnce: true,
          pressAction: {id: 'default', launchActivity: 'default'},
        },
      });
      console.log('[fcm] booking-approved notif shown for', bookingId);
    } catch (e) {
      console.warn('[fcm] booking-approved notif failed:', (e as Error).message);
    }
    if (opts?.recordActivity) {recordActivityForWake('booking-approved', 'Booking approved', 'Ops approved your booking. Tap to continue.', data);}
    return true;
  }

  const meta = AGENT_WAKE_META[kind];
  if (meta) {
    try {
      const {default: notifee, AndroidImportance} = require('@notifee/react-native') as typeof import('@notifee/react-native');
      // SOS gets a separate higher-priority channel so a DND-suppressed
      // booking notif can't mask a panic alert; offers + client booking updates
      // get their own channels (LM-N1/LM-N4).
      const channelKey = meta.sos ? SOS_CHANNEL_ID : (meta.channel ?? 'agent-updates');
      const CHANNEL_NAMES: Record<string, string> = {
        [SOS_CHANNEL_ID]: 'SOS alerts', 'agent-updates': 'Agent updates',
        'dispatch-offers': 'Job offers', 'booking-updates': 'Booking updates',
        'incident-updates': 'Incident updates',
      };
      const channelId = await notifee.createChannel({
        id: channelKey,
        name: CHANNEL_NAMES[channelKey] ?? 'Updates',
        importance: AndroidImportance.HIGH,
        // See the SOS_CHANNEL_ID migration note at the top of this file.
        ...(meta.sos ? {bypassDnd: true, sound: 'default', vibration: true} : {}),
      });
      if (meta.sos && !legacySosChannelRetired) {
        legacySosChannelRetired = true;
        // Retire the v1 channel so stale installs don't keep a dead
        // "SOS alerts" entry in system settings alongside the v2 one.
        try { await notifee.deleteChannel(LEGACY_SOS_CHANNEL_ID); } catch { /* never created on fresh installs */ }
      }
      const stableId = typeof data.missionId === 'string'
        ? `${kind}-${data.missionId}`
        : typeof data.bookingId === 'string'
        ? `${kind}-${data.bookingId}`
        : `${kind}-${typeof data.eventId === 'string' ? data.eventId : 'evt'}`;
      await notifee.displayNotification({
        id: stableId,
        title: meta.title,
        body: meta.body,
        data: data as Record<string, string>,
        android: {
          channelId,
          smallIcon: 'ic_stat_bravo',
          color: NOTIF_ACCENT, // B-66
          importance: AndroidImportance.HIGH,
          onlyAlertOnce: true,
          pressAction: {id: 'default', launchActivity: 'default'},
        },
      });
      console.log(`[fcm] ${kind} notif shown`);
    } catch (e) {
      console.warn(`[fcm] ${kind} notif failed:`, (e as Error).message);
    }
    if (opts?.recordActivity) {recordActivityForWake(kind, meta.title, meta.body, data);}
    return true;
  }

  return false;
}
