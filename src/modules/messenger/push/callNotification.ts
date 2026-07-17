/**
 * Production-grade incoming-call notifications backed by notifee.
 *
 * Why this exists:
 *   When the app is backgrounded or the device is locked, the existing
 *   in-app incoming-call screens (IncomingGroupCallScreen for SFU
 *   group calls, CallScreen with isIncoming for 1:1) can't pop up on
 *   their own — JS isn't running, or running but can't navigate. The
 *   user just sees nothing and the call goes unanswered.
 *
 *   This module fixes that with a notifee call-style notification:
 *
 *     - High-importance channel (IMPORTANCE_HIGH = sound + vibration +
 *       heads-up display)
 *     - Category 'call' so Android treats it as a real call (lock-screen
 *       priority, bypass DND if user allows)
 *     - fullScreenAction: 'default' — when device is LOCKED, Android
 *       launches the app full-screen the moment the notification
 *       arrives (this is what makes "phone rings on lock screen" work)
 *     - Accept / Decline actions inline so the user can answer without
 *       unlocking
 *     - Persistent (`autoCancel: false`, `ongoing: true`) — the
 *       notification stays until we explicitly dismiss it on
 *       answer/decline/hangup
 *     - Custom default ringtone (the OS-default for incoming calls)
 *
 *   The full-screen launch brings MainActivity to foreground; the
 *   existing ring dispatchers (callDispatcher / groupCallRingDispatcher)
 *   then navigate to the right ring screen. So the visible "real UI"
 *   the user sees is the existing IncomingGroupCallScreen /
 *   CallScreen — notifee is JUST the wake-up bridge.
 *
 *   Tap actions ('accept-...' / 'decline-...') are handled in
 *   fcmBootstrap.ts via notifee.onForegroundEvent +
 *   notifee.onBackgroundEvent so we can dismiss + route correctly even
 *   when the user taps from the notification shade.
 */
import notifee, {
  AndroidImportance, AndroidCategory, AndroidVisibility, AndroidStyle,
  EventType, type Event,
} from '@notifee/react-native';
import {Platform} from 'react-native';
import {RING_CHANNEL_VIBRATION, RING_NOTIF_VIBRATION} from './callVibration';

// v2 (call-UI parity plan §4): SILENT channel — the ring sound is now the
// device-default RINGTONE played by BravoRingtoneModule, not a channel sound.
// Android channels are immutable after creation, so dropping the old
// channel's `sound: 'default'` (the short notification CHIME, wrongly
// looped as a "ringtone") requires a new channel id; the old channel is
// deleted at ensure time so stale installs converge.
const CHANNEL_ID        = 'bravo-incoming-call-v2';
const LEGACY_CHANNEL_ID = 'bravo-incoming-call';
const CHANNEL_NAME      = 'Incoming calls';

// B-66 — obsidian design-system cobalt; tints the monochrome ic_stat_bravo
// small icon (matches @color/notificationAccent + the FCM manifest default).
export const NOTIF_ACCENT = '#5B8DEF';

export type CallNotifKind = 'voice' | 'video' | 'group-voice' | 'group-video';

export interface IncomingCallNotifPayload {
  /** Unique per-call id; we use it as the notification tag so dismiss matches. */
  callId:           string;
  kind:             CallNotifKind;
  /** Display name shown in the title row. */
  callerName:       string;
  /** For 1:1: the offer SDP we already received via WS, or null if pending. */
  remoteUserId?:    string;
  remoteDeviceId?:  number;
  incomingSdp?:     string;
  /** For group calls: the SFU room id we should join on accept. */
  roomId?:          string;
  /** P1-BR-1 — per-recipient SFU room token; the group accept path echoes it to `sfu.join`. */
  roomToken?:       string;
  /** Conversation that owns this call — needed for navigation + history. */
  conversationId?:  string;
  /** Caller userId (for groups, this is the userId that pressed call). */
  fromUserId?:      string;
}

let channelEnsured = false;

/**
 * Idempotent channel + permission ensure. Safe to call repeatedly. The
 * channel must exist before any notification displays — Android groups
 * notifications by channel and uses its IMPORTANCE to decide whether
 * to show heads-up / play sound / etc.
 */
export async function ensureIncomingCallChannel(): Promise<void> {
  if (channelEnsured) {return;}
  if (Platform.OS !== 'android') { channelEnsured = true; return; }
  try {
    await notifee.createChannel({
      id:           CHANNEL_ID,
      name:         CHANNEL_NAME,
      importance:   AndroidImportance.HIGH,
      // NO `sound` — deliberately silent. `sound: 'default'` resolved to the
      // default NOTIFICATION chime (not the user's ringtone); the real
      // device-default ringtone is played/looped/stopped by
      // BravoRingtoneModule (see incomingRingtone.ts). Vibration stays on
      // the channel so silent/vibrate ringer modes still buzz.
      vibration:    true,
      vibrationPattern: RING_CHANNEL_VIBRATION,
      // BYPASS_DND would require a special Android permission; default
      // to off so we don't require user grants beyond POST_NOTIFICATIONS.
    });
    // Retire the v1 channel (chime-sound) so old installs don't keep a dead
    // "Incoming calls" entry in system settings alongside the v2 one.
    try { await notifee.deleteChannel(LEGACY_CHANNEL_ID); } catch { /* never created on fresh installs */ }
    channelEnsured = true;
  } catch (e) {
    console.warn('[callNotification] channel create failed:', (e as Error).message);
  }
}

// ── Message notification (killed/backgrounded chat wakes) ────────────────────
// The slim killed-app FCM handler (fcmHeadless) draws this so a backgrounded/killed app
// shows a heads-up for a new message WITHOUT booting the messenger runtime / SQLCipher / WS
// (that 2nd-VM contention is why the old headless task was removed). The body stays GENERIC
// ("New secure message") — content is E2EE and is only decrypted once the app foregrounds
// and the WS reconnects. notifee-only; safe to call from a headless JS context.
const MSG_CHANNEL_ID = 'bravo-messages';
let msgChannelEnsured = false;

// P3 (onlyAlertOnce over-suppression) — `onlyAlertOnce:true` on every re-post of
// the same banner id means a NEW message never re-alerts while an old banner
// still sits in the shade. Track the last time each id actually alerted and
// re-alert once the burst window has passed, while still collapsing the
// generic-FCM→named-store upgrade and rapid bursts (the original N-29 intent).
const ALERT_BURST_MS = 10_000;
const lastAlertAtById = new Map<string, number>();
function shouldAlert(id: string | undefined): boolean {
  if (!id) {return true;}
  if (lastAlertAtById.size > 500) {lastAlertAtById.clear();} // bound
  const now = Date.now();
  const prev = lastAlertAtById.get(id);
  if (prev === undefined || now - prev >= ALERT_BURST_MS) {
    lastAlertAtById.set(id, now);
    return true; // first post, or the burst window elapsed → let it alert
  }
  return false; // within burst → silent update
}
export async function ensureMessagesChannel(): Promise<void> {
  if (msgChannelEnsured) {return;}
  if (Platform.OS !== 'android') { msgChannelEnsured = true; return; }
  try {
    await notifee.createChannel({
      id: MSG_CHANNEL_ID, name: 'Messages',
      importance: AndroidImportance.HIGH, sound: 'default', vibration: true,
    });
    msgChannelEnsured = true;
  } catch (e) {
    console.warn('[messageNotif] channel create failed:', (e as Error).message);
  }
}

export async function showMessageNotif(p: {
  conversationId?: string;
  senderUserId?:   string;
  /** Display title. LOCALLY-derived only (store conversation name) — never wire data. */
  title?:          string;
  /**
   * N-10 — message preview text. LOCALLY-derived only (decrypted store tail on
   * the WARM path). NEVER pass killed-path/wire content here: the killed
   * headless VM cannot decrypt, so it never has plaintext to leak. When
   * present we render a Telegram-style MessagingStyle card; when absent the
   * banner stays generic ("Open Bravo Secure to read it").
   */
  body?:           string;
  /** Sender's local display name for the MessagingStyle Person (groups). */
  senderName?:     string;
  /** N-17 — total unread across conversations, for the launcher badge. */
  badgeCount?:     number;
  /** N-10 — enable inline Reply + Mark-as-read actions (warm path, runtime alive). */
  actions?:        boolean;
}): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  await ensureMessagesChannel();
  const data: Record<string, string> = {kind: 'msg-wake'};
  if (p.conversationId) {data.conversationId = p.conversationId;}
  if (p.senderUserId) {data.senderUserId = p.senderUserId;}
  // M-03 — collapse per conversation when the thread is locally resolvable;
  // otherwise per sender (bounded stacking for likely-group wakes, whose
  // conversation is unknowable under sealed sender).
  const id = p.conversationId
    ? `bravo-msg-${p.conversationId}`
    : (p.senderUserId ? `bravo-msg-sender:${p.senderUserId}` : undefined);
  // P3 — alert once per burst window (not "never after the first post").
  const alertNow = shouldAlert(id);
  // N-10 — inline actions (only meaningful when the runtime can act, i.e. warm).
  const actions = (p.actions && p.conversationId)
    ? [
        {
          title: 'Mark as read',
          pressAction: {id: `read-${p.conversationId}`},
        },
        {
          title: 'Reply',
          pressAction: {id: `reply-${p.conversationId}`},
          input: {
            allowFreeFormInput: true,
            placeholder: 'Reply…',
            editableInputEnabled: true,
          },
        },
      ]
    : undefined;
  // N-10 — Telegram-style MessagingStyle when a local preview is available.
  const style = p.body
    ? {
        type: AndroidStyle.MESSAGING as const,
        person: {name: p.senderName || p.title || 'Message'},
        messages: [{text: p.body, timestamp: Date.now()}],
        ...(p.title ? {title: p.title, group: true} : {}),
      }
    : undefined;
  try {
    await notifee.displayNotification({
      id,
      title: p.title || 'New secure message',
      body: p.body || 'Open Bravo Secure to read it',
      data,
      android: {
        channelId:  MSG_CHANNEL_ID,
        importance: AndroidImportance.HIGH,
        category:   AndroidCategory.MESSAGE,
        visibility: AndroidVisibility.PRIVATE,
        smallIcon:  'ic_stat_bravo',
        color:      NOTIF_ACCENT, // B-66 — tint the monochrome mark (else OS-default grey)
        // N-29 — collapse the generic-FCM→named-store upgrade and rapid bursts
        // (onlyAlertOnce=true → silent update) but re-alert a genuinely new
        // message once the burst window has passed (onlyAlertOnce=false).
        onlyAlertOnce: !alertNow,
        // N-17 — launcher badge tracks total unread (launcher-dependent: dot
        // or number). Omitted when unknown so we never clobber a real count.
        ...(typeof p.badgeCount === 'number' ? {badgeCount: Math.max(0, p.badgeCount)} : {}),
        ...(style ? {style} : {}),
        ...(actions ? {actions} : {}),
        pressAction: {id: 'default', launchActivity: 'default'},
      },
    });
  } catch (e) {
    console.warn('[messageNotif] display failed:', (e as Error).message);
  }
}

/**
 * Dismiss-on-read — cancel a conversation's message banner(s) when the user
 * opens/reads the thread. Every path (warm FCM, killed FCM, store-driven
 * backgroundMessageNotifier) now funnels through showMessageNotif's
 * `bravo-msg-<id>`; the `msg-wake:<id>` cancel covers banners drawn by
 * pre-M-03 builds that survive an app update in the shade.
 */
export async function dismissMessageNotif(conversationId?: string, memberUserIds?: string[]): Promise<void> {
  if (Platform.OS !== 'android' || !conversationId) {return;}
  try {
    await notifee.cancelNotification(`msg-wake:${conversationId}`);
    await notifee.cancelNotification(`bravo-msg-${conversationId}`);
    // Why: a first-contact banner is drawn sender-keyed (the thread didn't
    // exist yet); opening the shadow-created direct:<peer> thread must clear
    // it too or the banner outlives the read.
    if (conversationId.startsWith('direct:')) {
      await notifee.cancelNotification(`bravo-msg-sender:${conversationId.slice('direct:'.length)}`);
    }
    // P3 — a killed-app GROUP message is banner-keyed by its SENDER (the group
    // couldn't be resolved headless). Opening/reading the thread must clear
    // those sender-keyed banners too; the caller passes the conversation's
    // member/peer user ids from the live store.
    for (const uid of memberUserIds ?? []) {
      if (uid) { await notifee.cancelNotification(`bravo-msg-sender:${uid}`); }
    }
  } catch (e) {
    console.warn('[messageNotif] dismiss failed:', (e as Error).message);
  }
}

// ── Missed-call notification ─────────────────────────────────────────────────
// When a ring ends unanswered (caller hung up while ringing, or the 45s ring
// timed out) we post a persistent, low-priority "Missed call" entry — WhatsApp/
// Signal behavior — so a backgrounded user sees they missed a call after the
// ring notification auto-dismisses. Separate LOW channel: informational, no
// sound/vibration (the ring already rang).
const MISSED_CHANNEL_ID = 'bravo-missed-calls';
let missedChannelEnsured = false;
async function ensureMissedCallChannel(): Promise<void> {
  if (missedChannelEnsured || Platform.OS !== 'android') { missedChannelEnsured = true; return; }
  try {
    await notifee.createChannel({
      id: MISSED_CHANNEL_ID,
      name: 'Missed calls',
      importance: AndroidImportance.DEFAULT,
    });
    missedChannelEnsured = true;
  } catch (e) {
    console.warn('[missedCall] channel create failed:', (e as Error).message);
  }
}

export async function showMissedCallNotif(p: {callId: string; callerName?: string; kind?: CallNotifKind; fromUserId?: string}): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  await ensureMissedCallChannel();
  const isVideo = p.kind === 'video' || p.kind === 'group-video';
  // P1-7 — carry fromUserId so tapping the Missed-call banner can deep-link to
  // the caller's 1:1 thread instead of opening a ghost incoming CallScreen.
  const data: Record<string, string> = {kind: 'missed-call', callId: p.callId};
  if (p.fromUserId) {data.fromUserId = p.fromUserId;}
  try {
    await notifee.displayNotification({
      // Distinct id from the ring notif so posting the miss doesn't collide
      // with (or get cleared by) the ring's own dismissal.
      id: `bravo-missed-${p.callId}`,
      title: 'Missed call',
      body: `${isVideo ? 'Video' : 'Voice'} call from ${p.callerName || 'Bravo contact'}`,
      data,
      android: {
        channelId: MISSED_CHANNEL_ID,
        importance: AndroidImportance.DEFAULT,
        // notifee's AndroidCategory has no MISSED_CALL member; CALL is the
        // closest telephony category and renders appropriately.
        category: AndroidCategory.CALL,
        visibility: AndroidVisibility.PRIVATE,
        smallIcon: 'ic_stat_bravo',
        color: NOTIF_ACCENT, // B-66
        pressAction: {id: 'default', launchActivity: 'default'},
      },
    });
  } catch (e) {
    console.warn('[missedCall] display failed:', (e as Error).message);
  }
}

/**
 * Display the incoming-call notification. On a LOCKED device, the
 * fullScreenAction launches MainActivity immediately, bypassing the
 * lock screen — that's the load-bearing piece for "phone rings on
 * lock screen" behavior. On an unlocked device, the user sees a
 * heads-up notification with Accept / Decline buttons.
 */
export async function showIncomingCallNotif(p: IncomingCallNotifPayload): Promise<void> {
  if (Platform.OS !== 'android') {return;} // iOS uses PushKit (separate path, not yet wired)
  await ensureIncomingCallChannel();

  const isVideo = p.kind === 'video' || p.kind === 'group-video';
  const isGroup = p.kind === 'group-voice' || p.kind === 'group-video';
  const titleVerb = isGroup ? 'Group call' : (isVideo ? 'Video call' : 'Voice call');
  const title = `${titleVerb} from ${p.callerName || 'Bravo contact'}`;

  // Stable per-call ids so dismiss can target the right notification
  // when answer / decline / hangup fires later.
  const notifId = `bravo-call-${p.callId}`;
  const acceptId  = `accept-${p.callId}`;
  const declineId = `decline-${p.callId}`;

  // Stash the entire payload as JSON in `data` so the tap handler
  // (notifee event handler) can navigate without re-querying state.
  const data: Record<string, string> = {
    callId:         p.callId,
    kind:           p.kind,
    callerName:     p.callerName,
    isGroup:        isGroup ? '1' : '0',
  };
  if (p.remoteUserId)    {data.remoteUserId    = p.remoteUserId;}
  if (p.remoteDeviceId !== null && p.remoteDeviceId !== undefined) {data.remoteDeviceId = String(p.remoteDeviceId);}
  if (p.incomingSdp)     {data.incomingSdp     = p.incomingSdp;}
  if (p.roomId)          {data.roomId          = p.roomId;}
  if (p.roomToken)       {data.roomToken       = p.roomToken;}
  if (p.conversationId)  {data.conversationId  = p.conversationId;}
  if (p.fromUserId)      {data.fromUserId      = p.fromUserId;}

  try {
    await notifee.displayNotification({
      id:    notifId,
      title,
      body:  isVideo ? 'Incoming video call · Tap to answer' : 'Incoming voice call · Tap to answer',
      data,
      android: {
        channelId:    CHANNEL_ID,
        // category: 'call' — Android Auto / Wear / DND treat this
        // notification as a real telephony call. Combined with
        // ongoing=true + fullScreenAction, Android pins this to the
        // very top of the shade and bypasses the lock screen on
        // arrival, which is what makes the WhatsApp/Signal "phone
        // rings on lock screen" UX work.
        category:     AndroidCategory.CALL,
        importance:   AndroidImportance.HIGH,
        visibility:   AndroidVisibility.PUBLIC,
        smallIcon:    'ic_stat_bravo',
        // The launcher icon doubles as the round caller avatar in the
        // notification card. When we have a real avatar URL pipe it
        // through the payload (future).
        largeIcon:    'ic_launcher',
        // colorized=true makes Android paint the entire notification
        // surface with the accent color — visually matches Bravo's
        // call screen and stands out vs ordinary push notifications.
        color:        '#1E88FF',
        colorized:    true,
        ongoing:      true,
        autoCancel:   false,
        // No loopSound — the v2 channel is silent; looping is owned by
        // BravoRingtoneModule (device-default ringtone), started below.
        // Audit PUSH-B5 (2026-07-02): auto-dismiss the ring after 45s. On a
        // KILLED app the caller's hangup arrives only as a WS frame on the
        // next reconnect (which a killed app never processes), and the VoIP
        // FCM ttl bounds delivery, not the DISPLAYED notification — so a
        // missed call used to ring/loop until the user manually swiped it.
        // 45s matches the offer's 45s relay TTL.
        timeoutAfter: 45_000,
        // The full-screen intent is what fires the lock-screen wake-up.
        // 'default' means "use the notification's pressAction" — i.e.
        // launch MainActivity. The Android launchActivity field is
        // implicit when set to 'default' on the main app activity.
        fullScreenAction: {
          id:             'default',
          launchActivity: 'default',
        },
        pressAction: {
          id:             'default',
          launchActivity: 'default',
        },
        actions: [
          {
            // P1-BR-3 — NO launchActivity: notifee delivers ACTION_PRESS to the
            // (headless) bg handler, which sends the decline over HTTP without
            // cold-launching the app the user just rejected.
            title: '❌ Decline',
            pressAction: {id: declineId},
          },
          {
            title: isVideo ? '📹 Answer' : '☎️ Answer',
            pressAction: {id: acceptId, launchActivity: 'default'},
          },
        ],
        style: {
          type: AndroidStyle.BIGTEXT,
          text: isGroup
            ? `Group call from ${p.callerName || 'Bravo contact'}\nTap Answer to join the room`
            : `${isVideo ? 'Video' : 'Voice'} call from ${p.callerName || 'Bravo contact'}\nTap Answer to pick up`,
        },
        // Vibrate aggressively on display + every few seconds the OS
        // re-pings while the heads-up is visible.
        vibrationPattern: RING_NOTIF_VIBRATION,
      },
    });
    // Ring with the DEVICE-DEFAULT ringtone (WhatsApp parity). Started only
    // after the card displays so a failed display can't leave sound with no
    // visible call; natively auto-stops at RING_TIMEOUT_MS (= timeoutAfter
    // above) even if this JS context dies (killed-app headless wake).
    try {
      const {startIncomingRingtone} = require('./incomingRingtone') as typeof import('./incomingRingtone');
      startIncomingRingtone(p.callId);
    } catch (e) {
      console.warn('[bravo.callnotif] ringtone start failed:', (e as Error).message);
    }
  } catch (e) {
    console.warn('[bravo.callnotif] display failed:', (e as Error).message);
  }
}

/**
 * SLIM notifee background-event handler, registered at BUNDLE ENTRY (index.js) so a KILLED app's
 * notification taps are handled. Without it, notifee logs "no background event handler has been
 * set" and a tapped call notification is NOT dismissed (the rich handler in fcmBootstrap that
 * dismisses + declines-over-WS is only registered AFTER login). This slim version just dismisses
 * the call notif on any tap/action so a looping ring can't linger; the body-tap still launches the
 * app via the notification's launchActivity, and once warm + logged-in fcmBootstrap's richer
 * onBackgroundEvent (full accept/decline-over-WS) takes over. notifee-only; safe headless.
 */
/**
 * P1-9 — after persisting a killed-app inline reply we re-post the SAME banner
 * WITHOUT the RemoteInput action so Android clears the hung reply spinner and
 * the user learns the send is deferred (notifee allows updating a notification
 * from the background handler). Content stays generic — no plaintext.
 */
async function markReplyQueued(conversationId: string): Promise<void> {
  if (Platform.OS !== 'android' || !conversationId) {return;}
  await ensureMessagesChannel();
  try {
    await notifee.displayNotification({
      id:    `bravo-msg-${conversationId}`,
      title: 'Bravo Secure',
      body:  'Reply will send when you open Bravo',
      data:  {kind: 'msg-wake', conversationId},
      android: {
        channelId:     MSG_CHANNEL_ID,
        importance:    AndroidImportance.HIGH,
        category:      AndroidCategory.MESSAGE,
        visibility:    AndroidVisibility.PRIVATE,
        smallIcon:     'ic_stat_bravo',
        color:         NOTIF_ACCENT, // B-66
        onlyAlertOnce: true, // silent update — just clears the RemoteInput spinner
        pressAction:   {id: 'default', launchActivity: 'default'},
      },
    });
  } catch (e) {
    console.warn('[messageNotif] reply-queued update failed:', (e as Error).message);
  }
}

let slimBgHandlerInstalled = false;
export function installSlimNotifeeBgHandler(): void {
  if (slimBgHandlerInstalled || Platform.OS !== 'android') {return;}
  slimBgHandlerInstalled = true;
  try {
    notifee.onBackgroundEvent(async ({type, detail}) => {
      if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) {return;}
      const data    = (detail.notification?.data ?? {}) as Record<string, string | undefined>;
      const pressId = detail.pressAction?.id ?? '';

      // P1-9 — inline Reply / Mark-as-read pressed after the process died. The
      // runtime + WS aren't up in this slim headless context, so PERSIST to the
      // durable queue; fcmBootstrap drains it (outbox send + mark-read) once the
      // runtime is ready. Never boots the runtime here (the 2nd-VM contention we
      // removed) and never decrypts.
      if (data.kind === 'msg-wake') {
        const convId = data.conversationId || '';
        if (pressId.startsWith('reply-') && convId) {
          const input = (detail as unknown as {input?: string}).input;
          if (typeof input === 'string' && input.trim()) {
            try {
              const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
              await enqueuePendingAction({t: 'reply', convId, text: input.trim()});
            } catch (e) { console.warn('[callNotification] reply enqueue failed:', (e as Error).message); }
            await markReplyQueued(convId);
          }
          return;
        }
        if (pressId.startsWith('read-') && convId) {
          try {
            const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
            await enqueuePendingAction({t: 'read', convId});
          } catch (e) { console.warn('[callNotification] read enqueue failed:', (e as Error).message); }
          await dismissMessageNotif(convId);
          return;
        }
        return; // body tap launches the app; the warm handler takes over
      }

      const callId = data.callId;
      if (!callId) {return;}

      // P1-BR-3 — headless Decline: tell the server to stop the caller ringing
      // WITHOUT cold-launching the app. On any failure, enqueue a durable
      // pending-decline flushed on first connect. Cancel the ring either way.
      if (pressId.startsWith('decline-')) {
        const isGroup = data.isGroup === '1' || (data.kind ?? '').startsWith('group-');
        const args = isGroup
          ? {callId, kind: 'group' as const, roomId: data.roomId || callId}
          : {callId, kind: 'direct' as const, peerUserId: data.fromUserId};
        try {
          const {sendCallDecline, enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
          const ok = await sendCallDecline(args);
          if (!ok) { await enqueuePendingAction({t: 'decline', ...args}); }
        } catch (e) {
          console.warn('[callNotification] headless decline failed:', (e as Error).message);
          try {
            const {enqueuePendingAction} = require('./pendingActions') as typeof import('./pendingActions');
            await enqueuePendingAction({t: 'decline', ...args});
          } catch { /* durable enqueue is best-effort */ }
        }
      }
      await dismissCallNotif(callId);
    });
  } catch (e) {
    console.warn('[callNotification] slim bg handler register failed:', (e as Error).message);
  }
}

/**
 * Dismiss the active call notification, e.g. after answer / decline / hangup.
 * Single funnel for every ring-exit path (accept / decline / remote hangup /
 * killed-app slim tap handler) — so the ringtone stop lives HERE and cannot
 * be missed by a new exit path that forgets it.
 */
export async function dismissCallNotif(callId: string): Promise<void> {
  if (Platform.OS !== 'android') {return;}
  try {
    const {stopIncomingRingtone} = require('./incomingRingtone') as typeof import('./incomingRingtone');
    stopIncomingRingtone(callId, 'dismiss');
  } catch { /* ringtone module unavailable — native auto-stop still bounds it */ }
  try {
    await notifee.cancelNotification(`bravo-call-${callId}`);
  } catch (e) {
    console.warn('[callNotification] dismiss failed:', (e as Error).message);
  }
}

/**
 * Parse an action press id back into an outcome + callId. Returns null
 * for the body-tap (id: 'default') which we treat as "open the app and
 * let the existing screens handle it."
 */
export function parseCallAction(pressActionId: string): {
  outcome: 'accept' | 'decline';
  callId:  string;
} | null {
  if (pressActionId.startsWith('accept-')) {
    return {outcome: 'accept',  callId: pressActionId.slice('accept-'.length)};
  }
  if (pressActionId.startsWith('decline-')) {
    return {outcome: 'decline', callId: pressActionId.slice('decline-'.length)};
  }
  return null;
}

/**
 * Re-export notifee's event types so callers don't have to import
 * notifee directly when wiring handlers in fcmBootstrap.
 */
export {EventType, notifee};
export type {Event};
