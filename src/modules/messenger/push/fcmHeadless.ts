/**
 * Headless JS handler for FCM data-only pushes that arrive while the
 * app is fully killed or frozen by Doze.
 *
 * Why this file exists separately from fcmBootstrap.setBackgroundMessageHandler:
 * the bg-message handler RNFirebase auto-fires only works when JS is
 * already alive. When Android freezes the process (you'll see
 * `ActivityManager: freezing <pid> com.bravosecure.app` in logcat) the
 * JS context is gone — RNFirebase then routes the push through a
 * registered headless task instead. Without a headless entry, logcat
 * warns:
 *   "No task registered for key ReactNativeFirebaseMessagingHeadlessTask"
 * and the data push silently drops. That's the bug behind "Sirajul
 * sent a message but I never got it" — the FCM wake fired, but our
 * handler wasn't reachable in headless mode, so we never pulled the
 * queued envelope from the relay.
 *
 * Payload kinds handled:
 *   - voip-wake: incoming call. Show notifee call notif so the user
 *     sees a heads-up + can tap accept.
 *   - msg-wake: queued chat message. Draw a generic banner (the server
 *     wake is data-only). Best-effort — Doze gives a tight time budget.
 *   - server-driven wakes (SOS / mission-* / booking-* / agent-* /
 *     payout-settled) and opaque {eventId} wakes: delegated to the
 *     shared showServerWakeNotification() so the killed-app path renders
 *     the SAME notifications the warm handler does (CRIT-5 — these were
 *     previously dropped as "unknown kind, no action" when killed, so an
 *     SOS fired to a swiped-away app surfaced nothing).
 */
import type {FirebaseMessagingTypes} from '@react-native-firebase/messaging';

type RemoteMessage = FirebaseMessagingTypes.RemoteMessage;

export async function handleHeadlessFcm(message: RemoteMessage | undefined): Promise<void> {
  const data = message?.data ?? {};
  const kind = typeof data.kind === 'string' ? data.kind : '';
  console.log('[fcm-headless] wake kind=', kind);

  // N-02 — a caller who hangs up (or times out) before an offline callee rings
  // now sends a data-only cancel push. Dismiss any ring this device already
  // drew and leave a Missed-call trace, so a Doze-deferred ring can't keep
  // ringing after the call is over ("notification appears only after the call").
  if (kind === 'call-cancel' && typeof data.callId === 'string') {
    try {
      const cn = require('./callNotification') as typeof import('./callNotification');
      await cn.dismissCallNotif(data.callId);
      if (data.missed === '1') {
        let callerName = typeof data.callerName === 'string' ? data.callerName : undefined;
        if (!callerName && typeof data.fromUserId === 'string' && data.fromUserId) {
          try {
            const {resolveDirectPeerName} = require('./mutedLookup') as typeof import('./mutedLookup');
            callerName = (await resolveDirectPeerName(data.fromUserId)) ?? undefined;
          } catch { /* generic label */ }
        }
        await cn.showMissedCallNotif({
          callId: data.callId,
          callerName,
          fromUserId: typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined,
          kind: (typeof data.callKind === 'string' ? data.callKind : 'voice') as import('./callNotification').CallNotifKind,
        });
      }
    } catch (e) {
      console.warn('[fcm-headless] call-cancel handling failed:', (e as Error).message);
    }
    return;
  }

  if (kind === 'voip-wake' && typeof data.callId === 'string') {
    try {
      // Round 5 / Security S3 — verify HMAC sig + nonce in the headless
      // path too. Headless JS still has Keychain access so we can load
      // the wake key. selfUserId may not be available (no Zustand
      // hydrated yet) — verifyVoipWake still computes the sig check
      // regardless of selfUserId; the user id only namespaces the
      // nonce LRU and a missing one just means we can't dedupe across
      // headless wakes (acceptable until the foreground app loads).

      const {verifyVoipWake} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');
      const verdict = await verifyVoipWake({
        selfUserId: '',
        fields: {
          // callKind is NOT part of the signed wake (voipSign covers {kind,callId,nonce,exp}),
          // so it must not be passed to the verifier — the display kind is read from data below.
          kind:     'voip-wake',
          callId:   data.callId as string,
          nonce:    typeof data.nonce === 'string' ? data.nonce : undefined,
          exp:      typeof data.exp === 'string' ? Number(data.exp) : (typeof data.exp === 'number' ? data.exp : undefined),
          sig:      typeof data.sig === 'string' ? data.sig : undefined,
        },
      });
      // N-13 — the wire carries only fromUserId (no caller name, by privacy
      // design). Resolve the caller's LOCAL contact name from the persisted
      // vault so a killed-app ring is labeled with their name, not the generic
      // 'Bravo contact' — the same lookup the warm handler already does.
      const fromUserId = typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined;
      const callKind = (typeof data.callKind === 'string' ? data.callKind : 'voice') as 'voice' | 'video' | 'group-voice' | 'group-video';
      let callerName = typeof data.callerName === 'string' && data.callerName ? data.callerName : undefined;
      if (!callerName && fromUserId) {
        try {
          const {resolveDirectPeerName} = require('./mutedLookup') as typeof import('./mutedLookup');
          callerName = (await resolveDirectPeerName(fromUserId)) ?? undefined;
        } catch { /* generic label */ }
      }

      if (!verdict.ok) {
        console.warn(`[fcm-headless] voip-wake DROPPED reason=${verdict.reason} call=${data.callId}`);
        // N-03 — a wake that fails ONLY the freshness check (device clock skew
        // or Doze deferral past the window) still proves a call was attempted.
        // Degrade to a Missed-call notification instead of total silence, so
        // the user at least learns they missed the call.
        if (verdict.reason === 'stale') {
          try {
            const cn = require('./callNotification') as typeof import('./callNotification');
            await cn.showMissedCallNotif({callId: data.callId, callerName, fromUserId, kind: callKind});
          } catch (e2) {
            console.warn('[fcm-headless] stale→missed-call failed:', (e2 as Error).message);
          }
        }
        return;
      }

      // P1-BR-1 — mirror the warm handler: group rings reuse the roomId AS the
      // callId (gateway contract), so `data.roomId` is absent — derive it from
      // callId. Thread roomToken + conversationId (both unsigned display/routing
      // fields, NOT part of the HMAC) so the group-accept nav can `sfu.join` the
      // host's room instead of creating a new empty one.
      const isGroupKind = callKind === 'group-voice' || callKind === 'group-video';
      const roomId = isGroupKind
        ? (data.callId as string)
        : (typeof data.roomId === 'string' ? data.roomId : undefined);
      const roomToken = typeof data.roomToken === 'string' ? data.roomToken : undefined;
      const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined;
      const {showIncomingCallNotif} = require('./callNotification') as typeof import('./callNotification');
      await showIncomingCallNotif({
        callId:         data.callId,
        kind:           callKind,
        callerName:     callerName ?? 'Bravo contact',
        conversationId,
        fromUserId,
        roomId,
        roomToken,
      });
      console.log('[fcm-headless] voip notif displayed for call=', data.callId);
    } catch (e) {
      console.warn('[fcm-headless] voip notif failed:', (e as Error).message);
    }
    return;
  }

  if (kind === 'msg-wake') {
    // Draw a GENERIC heads-up banner via notifee (the server wake is data-only — there is no
    // system notification block, so without this a killed app shows nothing). We deliberately do
    // NOT boot the messenger runtime / libsignal / SQLCipher / WS here — that 2nd-VM contention is
    // why the headless task was removed. The decrypted content lands when the app foregrounds and
    // the WS reconnects; tapping this banner brings the app forward and the pull picks it up.
    try {
      // Explicit conversationId in the wake = UNAMBIGUOUS conversation.
      const explicitConvId = typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : undefined;
      const senderUserId = typeof data.senderUserId === 'string' && data.senderUserId ? data.senderUserId : undefined;
      const {isConversationMuted, resolveDirectConversation, resolveConversationMeta} = require('./mutedLookup') as typeof import('./mutedLookup');
      // M-03/M-05 — sealed sender names only the sender. A DIRECT thread is
      // resolvable from the persisted vault (conv-keyed banner: collapse,
      // dismiss-on-read, tap deep link). A sender with NO direct thread is
      // likely a group — unresolvable here without booting the runtime, so
      // the killed path keeps a generic sender-keyed banner (group
      // mute/collapse is only honored on the warm path).
      // N-12 — resolve the local display name too, so the banner is titled
      // with the contact's name instead of the generic 'New secure message'.
      let convId = explicitConvId;
      let title: string | undefined;
      if (convId) {
        // B-65 — an explicit conversationId (group wakes included) resolves
        // its display name from the persisted vault, so killed-app GROUP
        // messages banner with the group's name instead of the generic
        // 'New secure message'. Same N-07 resolver the tap handler uses.
        title = (await resolveConversationMeta(convId))?.name ?? undefined;
      }
      if (!convId && senderUserId) {
        const resolved = await resolveDirectConversation(senderUserId);
        convId = resolved?.id ?? undefined; // heuristic DM — for banner keying only, NOT the mute gate
        title = resolved?.name;
      }
      // P2-BR-5 — suppress ONLY when the wake names its conversation
      // unambiguously (explicit conversationId). A DM id merely resolved from
      // senderUserId is ambiguous (the sender may be posting to a GROUP), so
      // muting their 1:1 must NOT silence their group messages — that class of
      // over-suppression made real group messages fully silent on the killed
      // path. Trade-off: a muted DM whose wake lacks a conversationId can still
      // banner, which is the lesser evil vs. dropping a group message.
      if (explicitConvId && await isConversationMuted({conversationId: explicitConvId})) {
        console.log('[fcm-headless] msg-wake suppressed — conversation muted');
        return;
      }
      const {showMessageNotif} = require('./callNotification') as typeof import('./callNotification');
      await showMessageNotif({conversationId: convId, senderUserId, title});
      console.log('[fcm-headless] msg-wake banner displayed');
    } catch (e) {
      console.warn('[fcm-headless] msg notif failed:', (e as Error).message);
    }
    return;
  }

  // CRIT-5 — every other server-driven wake (SOS / mission-* / booking-* /
  // agent-* / payout-settled) AND opaque {eventId} wakes must surface a
  // notification when the app is fully killed, not silently drop. Shared with
  // the warm handler so the two paths can't drift.
  try {
    const {showServerWakeNotification} = require('./serverWakeNotifications') as typeof import('./serverWakeNotifications');
    const handled = await showServerWakeNotification(data as Record<string, unknown>);
    if (!handled) {
      console.log('[fcm-headless] unknown kind, no action');
    }
  } catch (e) {
    console.warn('[fcm-headless] server-wake notif failed:', (e as Error).message);
  }
}
