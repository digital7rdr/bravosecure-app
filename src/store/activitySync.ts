/**
 * N-20 — hydrate the in-app notification centre (activityStore) from the durable
 * server inbox (GET /me/notifications). This is what makes the bell "sync":
 * a wake missed while the device was killed/Dozed/token-less is backfilled here
 * on next foreground + WS reconnect, and a since-watermark keeps it incremental.
 *
 * The server stores metadata only (class/kind/booking/mission ids); the display
 * title/subtitle is mapped here, mirroring the FCM path's AGENT_WAKE_META so a
 * backfilled row reads identically to a live wake.
 */
import {AppState, type AppStateStatus} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {API_BASE_URL} from '@utils/constants';
import {useActivityStore, type ActivityClass} from './activityStore';

const WATERMARK_KEY = 'bravo:activity-sync-watermark';

const KIND_META: Record<string, {title: string; subtitle: string}> = {
  'agent-approved':    {title: 'Application approved', subtitle: 'You can now apply for jobs.'},
  'agent-rejected':    {title: 'Application not approved', subtitle: 'Tap for details.'},
  'mission-dispatched':{title: 'Mission dispatched', subtitle: 'Ops has assigned you. Tap to open.'},
  'mission-aborted':   {title: 'Mission aborted', subtitle: 'Ops cancelled the mission. Stand down.'},
  'mission-complete-requested': {title: 'Completion requested', subtitle: 'A crew member asked to close a mission.'},
  'payout-settled':    {title: 'Payout settled', subtitle: 'Your earnings have been credited.'},
  'sos-cpo-alert':     {title: 'SOS · crew alert', subtitle: 'A team member raised SOS. Tap to respond.'},
  'dispatch-offer':    {title: 'Incoming job offer', subtitle: 'A mission offer is waiting — respond quickly.'},
  'provider-accepted': {title: 'Agency accepted', subtitle: 'An agency accepted your request.'},
  'no-provider':       {title: 'No agency available', subtitle: 'We could not find an available agency.'},
  'agency-no-show':    {title: 'Agency did not crew', subtitle: 'Your booking was cancelled and fully refunded.'},
  'booking-redispatching': {title: 'Reassigning your detail', subtitle: 'Finding a replacement now.'},
  'payment-failed':    {title: 'Payment failed', subtitle: 'Your booking could not be charged.'},
  'booking-rejected':  {title: 'Booking not approved', subtitle: 'Tap for details.'},
  'booking-completed': {title: 'Mission complete', subtitle: 'Tap to rate and view your receipt.'},
  'booking-approved':  {title: 'Booking approved', subtitle: 'Ops approved your booking. Tap to continue.'},
  'refund-issued':     {title: 'Refund issued', subtitle: 'Credits were returned to your wallet.'},
  'crew-assigned':     {title: 'Crew assigned', subtitle: 'Your protection team is being prepared.'},
  'dispute-opened':    {title: 'Dispute opened', subtitle: 'Ops will review it.'},
  'dispute-resolved':  {title: 'Dispute resolved', subtitle: 'Tap for the outcome.'},
  'incident-submitted':{title: 'Incident reported', subtitle: 'A CPO filed an incident. Tap to review.'},
  'incident-status':   {title: 'Incident update', subtitle: 'An incident status changed.'},
};

function activityClassOf(kind: string, eventClass: string): ActivityClass | null {
  if (eventClass === 'dispatch') {return 'dispatch';}
  if (eventClass === 'payout') {return 'payout';}
  if (eventClass === 'mission') {return 'mission';}
  if (eventClass === 'agent') {return 'agent';}
  if (eventClass === 'sos') {return 'sos';}
  if (eventClass === 'incident') {return 'incident';}
  if (eventClass === 'booking') {return 'booking';}
  // Fall back to kind prefix for any older row.
  if (kind.startsWith('mission-')) {return 'mission';}
  if (kind.startsWith('agent-')) {return 'agent';}
  if (kind.startsWith('incident')) {return 'incident';}
  return 'booking';
}

interface ServerNotification {
  id: string; eventClass: string; kind: string;
  bookingId?: string; missionId?: string; createdAt: string; read: boolean;
}

/** Fetch new server notifications and merge them into the local activity feed. */
export async function syncActivityFromServer(): Promise<void> {
  try {
    const access = await AsyncStorage.getItem('auth:access_token');
    if (!access) {return;}
    const since = await AsyncStorage.getItem(WATERMARK_KEY);
    const url = `${API_BASE_URL}/me/notifications?limit=100`
      + (since ? `&since=${encodeURIComponent(since)}` : '');
    const res = await fetch(url, {
      headers: {Authorization: `Bearer ${access}`, 'X-Signal-Device-Id': '1'},
    });
    if (!res.ok) {return;}
    const body = await res.json() as {notifications?: ServerNotification[]};
    const rows = body?.notifications ?? [];
    if (rows.length === 0) {return;}
    const append = useActivityStore.getState().append;
    let newest = since ?? '';
    for (const n of rows) {
      const eventClass = activityClassOf(n.kind, n.eventClass);
      if (!eventClass) {continue;}
      const meta = KIND_META[n.kind] ?? {title: n.kind, subtitle: ''};
      append({
        id: n.id,
        eventClass,
        kind: n.kind,
        title: meta.title,
        subtitle: meta.subtitle || undefined,
        bookingId: n.bookingId,
        missionId: n.missionId,
        ts: n.createdAt,
        read: n.read,
      });
      if (n.createdAt > newest) {newest = n.createdAt;}
    }
    if (newest && newest !== since) {
      await AsyncStorage.setItem(WATERMARK_KEY, newest);
    }
  } catch { /* best-effort — the local store still shows what it has */ }
}

/** Local mark-all-read + best-effort server persist so other devices converge. */
export async function markAllActivityReadSynced(): Promise<void> {
  useActivityStore.getState().markAllRead();
  try {
    const access = await AsyncStorage.getItem('auth:access_token');
    if (!access) {return;}
    await fetch(`${API_BASE_URL}/me/notifications/read`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${access}`, 'X-Signal-Device-Id': '1'},
      body: JSON.stringify({all: true}),
    });
  } catch { /* local read already applied */ }
}

let appStateSub: {remove: () => void} | null = null;
let started = false;

/** Start syncing: an initial fetch + a re-fetch whenever the app foregrounds. */
export function startActivitySync(): void {
  if (started) {return;}
  started = true;
  syncActivityFromServer().catch(() => { /* best-effort */ });
  appStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') {syncActivityFromServer().catch(() => { /* best-effort */ });}
  });
}

export function stopActivitySync(): void {
  started = false;
  appStateSub?.remove();
  appStateSub = null;
}

/** Reset the sync watermark on sign-out so a new identity re-syncs from scratch. */
export async function resetActivitySyncWatermark(): Promise<void> {
  try { await AsyncStorage.removeItem(WATERMARK_KEY); } catch { /* best-effort */ }
}
