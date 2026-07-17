import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * activityStore (BUILD_RUNBOOK Step 18 / B2) — the durable, locally-persisted notifications
 * inbox that turns opaque FCM wakes into glanceable, actionable history. The push payload
 * stays content-free ({userId, eventClass, eventId}, P0-N8); on each wake the app fetches
 * detail from the existing JWT-gated endpoints and `append()`s a row here — exactly as chat
 * hydrates on a wake. Rows carry ONLY non-sensitive metadata (never a message body or key).
 *
 * Identity-scoped like the messenger store: `setOwner(key)` wipes the feed when a DIFFERENT
 * identity signs in on the same device, so one user never sees another's activity. Dedupe is
 * by `eventId` so a re-delivered wake doesn't double-row.
 */
export type ActivityClass = 'booking' | 'dispatch' | 'mission' | 'payout' | 'sos' | 'agent' | 'incident';

export interface ActivityRowData {
  /** eventId — the dedupe key (opaque id from the push wake). */
  id: string;
  eventClass: ActivityClass;
  /** Specific kind, e.g. 'dispatch-offer' | 'provider-accepted' | 'no-provider'. */
  kind: string;
  title: string;
  subtitle?: string;
  /** ISO timestamp the row was recorded. */
  ts: string;
  read: boolean;
  /** Deep-link targets (resolved by the Bell/row tap). */
  bookingId?: string;
  missionId?: string;
  /** For an actionable offer row — drives the CountdownPill. */
  expiresAt?: string;
}

const MAX_ROWS = 200; // cap the local feed so it can't grow unbounded

interface ActivityState {
  ownerKey: string | null;
  rows: ActivityRowData[];
  setOwner: (key: string | null) => void;
  append: (row: Omit<ActivityRowData, 'ts' | 'read'> & {ts?: string; read?: boolean}) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useActivityStore = create<ActivityState>()(
  persist(
    (set, get) => ({
      ownerKey: null,
      rows: [],

      setOwner: key => {
        const prev = get().ownerKey;
        if (prev && key && prev !== key) {
          // Different identity on this device — wipe the previous user's feed.
          set({ownerKey: key, rows: []});
        } else {
          set({ownerKey: key ?? prev});
        }
      },

      append: row => {
        const ts = row.ts ?? new Date().toISOString();
        set(state => {
          // Dedupe by eventId — a re-delivered wake updates the existing row in place
          // (keeps its read state) rather than adding a duplicate.
          if (state.rows.some(r => r.id === row.id)) {
            return {rows: state.rows.map(r => (r.id === row.id ? {...r, ...row, ts: r.ts, read: r.read} : r))};
          }
          const next: ActivityRowData = {read: false, ...row, ts};
          return {rows: [next, ...state.rows].slice(0, MAX_ROWS)};
        });
      },

      markRead: id => set(state => ({rows: state.rows.map(r => (r.id === id ? {...r, read: true} : r))})),
      markAllRead: () => set(state => ({rows: state.rows.map(r => (r.read ? r : {...r, read: true}))})),
      remove: id => set(state => ({rows: state.rows.filter(r => r.id !== id)})),
      clear: () => set({rows: []}),
    }),
    {
      name: 'bravo:activity',
      storage: createJSONStorage(() => AsyncStorage),
      // Persist the feed + owner, not transient selectors.
      partialize: state => ({ownerKey: state.ownerKey, rows: state.rows}),
    },
  ),
);

/** Selector: unread count (kept out of state so it never goes stale). */
export function selectUnreadCount(state: {rows: ActivityRowData[]}): number {
  return state.rows.reduce((n, r) => n + (r.read ? 0 : 1), 0);
}

/** Imperative entry point for the push-wake path (and in-app events) to drop a row in
 *  without subscribing to the store. The wake handler fetches detail from the existing
 *  endpoints, then calls this — keeping the FCM payload itself opaque. */
export function recordActivity(row: Omit<ActivityRowData, 'ts' | 'read'> & {ts?: string}): void {
  useActivityStore.getState().append(row);
}
