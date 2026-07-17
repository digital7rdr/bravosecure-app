/**
 * IncomingGroupCallScreen — full-screen ring UI for inbound group calls.
 *
 * Mounted by the navigation root when the runtime receives a
 * `sfu.ring.incoming` frame. Plays the device default ringtone +
 * vibrates, shows the caller (group) name and an Accept / Decline pair.
 *
 *   Accept  → navigate to GroupCallScreen with direction='incoming' so
 *             useGroupCall joins the room without firing another ring.
 *   Decline → fire `sfu.ring.decline` so the host's UI can show the
 *             decline + close this screen.
 *
 * Subscribes to the same multi-listener ring dispatcher so it can
 * self-dismiss when the host cancels (`sfu.ring.cancelled`).
 */
import React, {useCallback, useEffect, useRef} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar, Platform, Vibration,
  BackHandler,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {MessengerScreenProps} from '@navigation/types';
import {setGroupCallRingHandler} from '@/modules/messenger/webrtc/groupCallRingDispatcher';
import {appendMissedGroupCallBubble} from '@/modules/messenger/webrtc/useGroupCall';
import {getLiveTransport} from '@/modules/messenger/runtime/transportRegistry';
import {useAuthStore} from '@store/authStore';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';

type Props = MessengerScreenProps<'IncomingGroupCallScreen'>;

const C = {
  bg:    '#07090D',
  surf1: '#13182A',
  bd:    'rgba(255,255,255,0.14)',
  bd2:   'rgba(255,255,255,0.08)',
  tx1:   '#FFFFFF',
  tx2:   '#B8C7E0',
  tx3:   '#7E8AA6',
  ok:    '#00C853',
  err:   '#D5212B',
  glow:  '#5B8DEF',
};

const MONO = Platform.select({ios: 'Menlo', default: 'monospace'});

export default function IncomingGroupCallScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {roomId, conversationId, callType, callerName, fromUserId, roomToken, autoAccept} = route.params;
  const ownDisplayName = useAuthStore(s => s.user?.full_name ?? s.user?.email ?? 'Me');
  // P1-BR-1 — a ring with no roomId is non-actionable: joining would POST
  // /sfu/rooms and mint a NEW empty room instead of the host's. Treat it as
  // an error (dismiss) and never let Accept navigate into the create path.
  const roomMissing = !roomId || roomId.trim() === '';

  // Tracks "we already accepted/declined" so dispatcher cancel callbacks
  // don't double-pop the navigator after we've already moved.
  const settledRef = useRef(false);
  // BS-RING-RACE — set when a cancel for THIS room arrives. If Accept loses a
  // same-tick race to the cancel, we route to the "Missed call" UX instead of
  // joining a room the host already destroyed.
  const cancelledRef = useRef(false);
  // Why: navigators can reuse this mounted screen for a NEW ring (new
  // route.params, same instance) — without the reset, the latched true
  // from the previous ring would silently swallow Accept/Decline.
  useEffect(() => { settledRef.current = false; }, [roomId]);

  // Ringtone + vibration. Same path as 1:1 incoming — Bravo-shipped
  // WAV asset via expo-av; InCallManager's '_DEFAULT_' path is broken
  // on Android 14+ Pixels (see runtime/bravoTones.ts).
  // Fix #39: defer the vibrate kick by 50 ms via setTimeout so a
  // user who taps Accept the moment the screen appears (a real
  // pattern when the screen comes up while the phone is in their
  // hand) can have their accept-handler's Vibration.cancel() pre-empt
  // the start. Without the defer, Vibration.vibrate(...) lands inside
  // the same JS tick as the ring screen mount and the OS queues the
  // pattern before the cancel can race in. Result: the phone keeps
  // buzzing for the full 800ms after the user already saw the
  // GroupCallScreen mount.
  useEffect(() => {
    // P1-BR-2 (group) — answered from the notification: skip the ring
    // (no sound / vibration); the auto-join effect below routes straight
    // into the call. Also skip entirely when the ring is non-actionable.
    if (autoAccept || roomMissing) {return;}

    const tones = require('@/modules/messenger/runtime/bravoTones') as typeof import('@/modules/messenger/runtime/bravoTones');
    void tones.startRingtone();
    const vibTimer = setTimeout(() => {
      Vibration.vibrate([0, 800, 1200, 800], true);
    }, 50);
    // Fallback ring timeout — the screen normally self-dismisses on the
    // host's `sfu.ring.cancel`. If that frame is ever lost (host crash,
    // dropped socket, or simply never answered), the ringtone + vibration
    // would loop forever. After ~45s (the server ring window is ~30s)
    // settle, drop a "Missed group call" entry, and dismiss — mirroring the
    // onCancel path so a lost cancel can't trap the user on a ringing screen.
    const ringTimeout = setTimeout(() => {
      if (settledRef.current) {return;}
      settledRef.current = true;
      try { appendMissedGroupCallBubble({conversationId, callType}); } catch { /* best-effort */ }
      try { navigation.goBack(); } catch { /* already gone */ }
    }, 45000);
    return () => {
      clearTimeout(vibTimer);
      clearTimeout(ringTimeout);
      void tones.stopRingtone();
      Vibration.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount effect: the 45s ring timeout must not re-arm when these values change
  }, []);

  // Listen for cancel/decline frames from the dispatcher. If the caller
  // cancels (room destroyed) or all participants leave, self-dismiss.
  useEffect(() => {
    const unsub = setGroupCallRingHandler({
      onIncoming: () => { /* root navigator handles this */ },
      onCancel:   (data) => {
        if (data.roomId !== roomId) {return;}
        cancelledRef.current = true;
        if (settledRef.current) {return;}
        settledRef.current = true;
        // B-12 — the host cancelled the ring before we accepted (abandoned
        // the call). Drop a "Missed group call" entry into the chat so the
        // ring doesn't just silently vanish with no record (WhatsApp UX).
        try {
          appendMissedGroupCallBubble({conversationId, callType});
        } catch { /* best-effort — never block dismissal */ }
        navigation.goBack();
      },
      onDecline:  () => { /* not relevant on the recipient side */ },
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handler is (re)bound per roomId; conversationId/callType are read only inside the one-shot cancel branch
  }, [roomId, navigation]);

  // Recipient member-id list for the join — re-derived from the local
  // conversation so the joiner can also rebroadcast its presence
  // envelope to others on join. Falls back to just the caller if we
  // somehow don't have the conversation locally yet.
  // Fix #38: use Zustand selectors so the list re-renders if the
  // conversation hydrates AFTER this screen mounts (cold-boot ringing
  // race: the push wakes the app, the screen mounts before the
  // conversations slice has finished restoring from disk → the
  // previous getState() snapshot returned `[fromUserId]` only and
  // the joiner's presence envelope under-counted the room).
  const ownId        = useAuthStore(s => s.user?.id);
  const convoForRoom = useMessengerStore(s => s.conversations[conversationId]);
  const recipientUserIds = (convoForRoom?.participants ?? [fromUserId])
    .filter(p => p && p !== 'self' && p !== ownId);

  const accept = (): void => {
    if (settledRef.current) {return;}
    // P1-BR-1 — never navigate into GroupCallScreen without a roomId: that
    // path would create a brand-new empty room. A ring this broken is an
    // error — dismiss (a "Missed group call" record is written by the
    // roomMissing effect on mount) rather than joining nothing.
    if (roomMissing) {
      settledRef.current = true;
      try { navigation.goBack(); } catch { /* already gone */ }
      return;
    }
    settledRef.current = true;
    // BS-RING-RACE — a cancel for this room already arrived in the same tick
    // (host cancelled the instant we tapped Accept). Don't join a destroyed
    // room; route to the missed-call UX the cancel path would have produced.
    if (cancelledRef.current) {
      try { appendMissedGroupCallBubble({conversationId, callType}); } catch { /* best-effort */ }
      try { navigation.goBack(); } catch { /* already gone */ }
      return;
    }
    // Pop the ring screen and replace with the group call. Using
    // `replace` (via goBack + navigate) avoids leaving the ring screen
    // in the back-stack so swiping back doesn't re-mount it after the
    // call ends.
    navigation.replace('GroupCallScreen', {
      conversationId,
      callType,
      direction:        'incoming',
      roomId,
      recipientUserIds,
      callerName,
      // BS-CALL-ADHOC — the ringer is the call host/owner. The joiner
      // looks up the ad-hoc call master key under `direct:<host>` (where
      // the host filed it), so thread the host id through.
      hostUserId:       fromUserId,
      // Audit row #5 — server requires this token in sfu.join when
      // SFU_ROOM_TOKEN_SECRET is set. Carried from the ring frame.
      roomToken,
    });
  };

  // P1-BR-1 — a ring that arrived with no roomId can't be joined. Record a
  // "Missed group call" (so it isn't a silent void) and dismiss rather than
  // presenting an Accept that would spin up a wrong room.
  useEffect(() => {
    if (!roomMissing) {return;}
    if (settledRef.current) {return;}
    settledRef.current = true;
    console.warn('[bravo.groupring] incoming group ring missing roomId — dismissing (P1-BR-1)');
    try { appendMissedGroupCallBubble({conversationId, callType}); } catch { /* best-effort */ }
    try { navigation.goBack(); } catch { /* already gone */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomMissing]);

  // P1-BR-2 (group) — the user answered the ring from the notification.
  // Join the room directly instead of waiting on the on-screen Accept.
  // Guarded by settledRef (shared with manual accept/decline) so it fires
  // at most once, and skipped when the ring is non-actionable.
  useEffect(() => {
    if (!autoAccept || roomMissing) {return;}
    if (settledRef.current) {return;}
    console.log('[bravo.groupring] autoAccept — joining group call from notification');
    accept();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAccept, roomMissing]);

  const decline = useCallback((): void => {
    if (settledRef.current) {return;}
    settledRef.current = true;
    // Best-effort decline frame so the host's UI updates. We use
    // emitWithAck because it accepts arbitrary event names — the typed
    // ClientFrame union doesn't include sfu.* frames (they're sent
    // ad-hoc through the same socket). Failure is not fatal — the
    // host's room continues without us either way.
    try {
      const ws = getLiveTransport();
      if (ws) {
        // Audit row #5 (C2) — echo the per-recipient roomToken so the
        // gateway can verify we were actually ringed. Without it any
        // authed user could fake-decline rings they never received,
        // leaking who-is-in-which-call inferences via response timing.
        void ws.emitWithAck('sfu.ring.decline', {roomId, conversationId, roomToken})
          .catch(() => { /* socket not open or server not reachable */ });
      }
    } catch { /* ignore */ }
    navigation.goBack();
  }, [roomId, conversationId, roomToken, navigation]);

  // Round 7 / back-button audit fix #6 — hardware back must fire the
  // same `sfu.ring.decline` frame as the on-screen Decline button.
  // Without this, hitting back silently dismisses the ring screen but
  // never tells the host — the caller's UI keeps "ringing" until the
  // 30s server-side timeout fires.
  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        decline();
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, [decline]),
  );

  const initials = (callerName || 'Group').slice(0, 2).toUpperCase();

  return (
    <View style={[s.root, {paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      {/* Header */}
      <View style={s.headerWrap}>
        <Text style={s.kicker}>{callType === 'video' ? 'INCOMING VIDEO CALL' : 'INCOMING VOICE CALL'}</Text>
        <Text style={s.subkicker}>Group · {recipientUserIds.length + 1} members</Text>
      </View>

      {/* Avatar + name */}
      <View style={s.heroWrap}>
        <View style={s.avatarOuter}>
          <View style={s.avatarInner}>
            <Text style={s.avatarTxt}>{initials}</Text>
          </View>
        </View>
        <Text style={s.callerName}>{callerName}</Text>
        <Text style={s.callerSub}>{`From ${shortId(fromUserId)}`}</Text>
        <Text style={s.youAre}>{`You are signed in as ${ownDisplayName}`}</Text>
      </View>

      {/* Action row */}
      <View style={s.actions}>
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.fab, s.fabDecline]} onPress={decline} activeOpacity={0.85}>
            <Icon name="phone-hangup" size={28} color="#FFF" />
          </TouchableOpacity>
          <Text style={s.actionLbl}>DECLINE</Text>
        </View>
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.fab, s.fabAccept]} onPress={accept} activeOpacity={0.85}>
            <Icon name={callType === 'video' ? 'video' : 'phone'} size={28} color="#FFF" />
          </TouchableOpacity>
          <Text style={s.actionLbl}>ACCEPT</Text>
        </View>
      </View>
    </View>
  );
}

function shortId(uid: string): string {
  if (!uid) {return '—';}
  return uid.length <= 8 ? uid : uid.slice(0, 8) + '…';
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg, justifyContent: 'space-between'},

  headerWrap: {alignItems: 'center', gap: 6, paddingHorizontal: 24},
  kicker:    {color: C.tx1, fontSize: 12, fontWeight: '800', letterSpacing: 2.5, fontFamily: MONO},
  subkicker: {color: C.tx3, fontSize: 11, fontWeight: '500'},

  heroWrap: {alignItems: 'center', gap: 12, paddingHorizontal: 24},
  avatarOuter: {
    width: 156, height: 156, borderRadius: 78,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.glow,
    backgroundColor: 'rgba(91,141,239,0.12)',
    shadowColor: C.glow, shadowOpacity: 0.55, shadowRadius: 22, shadowOffset: {width: 0, height: 0}, elevation: 10,
  },
  avatarInner: {
    width: 132, height: 132, borderRadius: 66,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surf1, borderWidth: 1, borderColor: C.bd,
  },
  avatarTxt:  {color: C.tx1, fontSize: 38, fontWeight: '800', letterSpacing: 1.6, fontFamily: MONO},
  callerName: {color: C.tx1, fontSize: 22, fontWeight: '800', marginTop: 16},
  callerSub:  {color: C.tx2, fontSize: 12},
  youAre:     {color: C.tx3, fontSize: 11, marginTop: 6, fontStyle: 'italic'},

  actions: {flexDirection: 'row', justifyContent: 'space-evenly', paddingHorizontal: 24, gap: 24},
  actionCol: {alignItems: 'center', gap: 10},
  fab: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center',
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: {width: 0, height: 6},
  },
  fabAccept:  {backgroundColor: C.ok},
  fabDecline: {backgroundColor: C.err},
  actionLbl:  {color: C.tx2, fontSize: 11, fontWeight: '800', letterSpacing: 1.5, fontFamily: MONO},
});
