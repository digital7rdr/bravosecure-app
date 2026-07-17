import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, KeyboardAvoidingView, Platform, StatusBar,
  Modal, Pressable, Image, Dimensions, Animated, Easing,
  Keyboard, AppState, FlatList,
  type ListRenderItemInfo,
} from 'react-native';
import {Alert} from '@utils/alert';
// MX-06 — swipe-to-reply runs on the UI thread: PanGestureHandler +
// Animated.event(useNativeDriver) replaces the old PanResponder, whose
// per-frame setValue crossed the JS bridge and stuttered under load.
import {
  PanGestureHandler,
  State as GestureState,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import EmojiPicker from 'rn-emoji-keyboard';
import * as Clipboard from 'expo-clipboard';
import {launchCamera, launchImageLibrary} from 'react-native-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {readUriBytes, useAttachmentUri, attachmentErrorText} from '@/modules/messenger/media';
import {useUploadProgress} from '@/modules/messenger/media/uploadProgress';
import * as ImageManipulator from 'expo-image-manipulator';
import {FileViewer, type ViewableFile} from '@/modules/messenger/ui/FileViewer';
import {MediaPreviewTray} from '@/modules/messenger/ui/MediaPreviewTray';
import {UploadProgressRing} from '@/modules/messenger/ui/UploadProgressRing';
import {normalizePickedAssets, MAX_PICKED_ASSETS, type PickedAsset} from '@/modules/messenger/ui/pickedAssets';
import {haptics} from '@utils/haptics';
import {VoiceNoteRecorder} from '@/modules/messenger/ui/VoiceNoteRecorder';
import {Colors} from '@theme/index';
import {Bravo, BravoFont} from '@/theme/bravo';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {PremiumBanner} from '@/modules/messenger/ui/PremiumBanner';
import type {MessengerScreenProps} from '@navigation/types';
import {useIsFocused} from '@react-navigation/native';
import {useMessenger} from '@/modules/messenger/hooks';
import {launchCall} from '@/modules/messenger/webrtc/launchCall';
import {useShallow} from 'zustand/react/shallow';
import {useMessengerStore, EMPTY_MESSAGES, selectConversation, directConversationSlots} from '@/modules/messenger/store';
import {conversationApi} from '@services/api';
import type {LocalMessage} from '@/modules/messenger/store';
import {OnlineDot, type OnlineDotState} from '@/modules/messenger/ui/OnlineDot';
import {PeerPresencePill, PeerOfflineBanner} from '@/modules/messenger/ui/PeerPresence';
import {TypingBubble} from '@/modules/messenger/ui/TypingBubble';
import {buildInvertedChatListItems, sameDay, type ChatListItem} from '@/modules/messenger/ui/chatListItems';
import {ConnectionBanner} from '@/modules/messenger/ui/ConnectionBanner';
import {LinkPreviewCard} from '@/modules/messenger/ui/LinkPreviewCard';
import {LinkifiedText} from '@/modules/messenger/ui/LinkifiedText';
import {DEV_CONTACTS} from '@/modules/messenger/dev/devContacts';
import {useAuthStore} from '@store/authStore';
import type {SessionAddress} from '@/modules/messenger/crypto';
import {withScreenErrorBoundary} from '@modules/observability';
import {scaleTextStyles} from '@utils/scaling';
import {sendErrorText} from './sendErrorText';

type Props = MessengerScreenProps<'Chat'>;

/**
 * Threshold under which consecutive same-sender messages are treated as
 * one "run" — they get tighter spacing + sharper corners facing each
 * other, and only the last bubble carries the timestamp. Matches the
 * feel of WhatsApp's 2-minute window.
 */
// Obsidian base from the Bravo Chat Thread design tokens (tokens.jsx
// `bg: #07090D`). Matches Command Home + the Messenger list — the thread
// is part of the same re-skin. Local constant so the app-wide Bravo.bg
// (used by other navy screens) is untouched. VISUAL ONLY — no messaging,
// crypto, or data wiring changes on this screen.
const CHAT_BG = '#07090D';

// ── Bravo DM Attach design tokens (obsidian + cobalt + signal-green) ──
// Imported from the Claude Design "Bravo — DM & Attach" screen (tokens.jsx).
// Kept LOCAL to this screen so the app-wide Command-Navy `Bravo` theme that
// every other surface depends on is untouched. VISUAL ONLY.
const DM = {
  accent:      '#5B8DEF',
  accentDeep:  '#2F5BE0',
  accentGlow:  'rgba(91,141,239,0.35)',
  accentTint:  'rgba(91,141,239,0.12)',
  accentEdge:  'rgba(91,141,239,0.30)',
  quoteBar:    '#7FA8FF',
  onAccent:    '#A9C5FF',
  signal:      '#4ADE80',
  signalTint:  'rgba(74,222,128,0.08)',
  signalEdge:  'rgba(74,222,128,0.26)',
  hair:        'rgba(255,255,255,0.06)',
  hair2:       'rgba(255,255,255,0.09)',
  text:        '#F2F4F8',
  textDim:     'rgba(229,233,242,0.62)',
  textMute:    'rgba(180,188,204,0.45)',
  textFaint:   'rgba(180,188,204,0.28)',
  recvBubble:  '#18202F',        // obsidian receive bubble (design gradient midpoint)
  glassFill:   'rgba(255,255,255,0.04)',
} as const;
// Outgoing bubble + mic gradients (top→bottom). Cobalt hero surfaces.
const SENT_GRADIENT  = ['#4C86F0', DM.accentDeep] as const;
// Obsidian receive-bubble gradient (design: rgba(30,40,58,.9)→rgba(22,29,43,.85)
// composited over the #07090D bg), straddling DM.recvBubble so both sides of
// the thread share the same lit-from-above material.
const RECV_GRADIENT  = ['#1E2A3C', '#151C29'] as const;
const MIC_GRADIENT   = ['#6E9BF5', DM.accent, DM.accentDeep] as const;
const SHEET_GRADIENT = ['#131A28', '#0C111B'] as const;
const AVATAR_GRADIENT = ['#9A7BE6', '#5B43C9'] as const;

/**
 * Rounded-corner set for a chat bubble, honouring the run-grouping
 * "facing corners are sharp" rule. Mirrors the sent/recv + runMid/runTail
 * StyleSheet variants so a gradient underlay can be clipped to the exact
 * same silhouette as the bubble it sits under.
 */
function bubbleRadii(sent: boolean, isFirst: boolean, isLast: boolean): {
  borderTopLeftRadius: number; borderTopRightRadius: number;
  borderBottomLeftRadius: number; borderBottomRightRadius: number;
} {
  const R = 22, S = 6;
  if (sent) {
    return {
      borderTopLeftRadius: R,
      borderTopRightRadius: isFirst && isLast ? R : S,
      borderBottomLeftRadius: R,
      borderBottomRightRadius: S,
    };
  }
  return {
    borderTopLeftRadius: isFirst && isLast ? R : S,
    borderTopRightRadius: R,
    borderBottomLeftRadius: S,
    borderBottomRightRadius: R,
  };
}

const GROUP_THRESHOLD_MS = 2 * 60_000;
/** Minimum right-swipe in dp that triggers a quick-reply when released. */
const SWIPE_REPLY_THRESHOLD = 60;
/** Quick-react emoji palette shown in the action sheet. */
const QUICK_REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '😢'];

function timeDeltaMs(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime());
}

/**
 * Deterministic 4-char hex fingerprint derived from a message id — the
 * `SHA:XXXX` badge shown next to incoming bubbles. Not cryptographically
 * meaningful (the real SHA would be computed off the ciphertext at
 * decrypt time); for display it gives each incoming bubble a stable
 * identifier so the recipient can verify two bubbles are "the same".
 */

const TTL_OPTIONS: {label: string; sec: number | null}[] = [
  {label: 'Off',        sec: null},
  {label: '30 seconds', sec: 30},
  {label: '5 minutes',  sec: 300},
  {label: '1 hour',     sec: 3600},
  {label: '24 hours',   sec: 86400},
];

function ttlLabel(sec: number | null): string {
  if (!sec) {return '';}
  if (sec < 60)   {return `${sec}s`;}
  if (sec < 3600) {return `${Math.round(sec / 60)}m`;}
  if (sec < 86400) {return `${Math.round(sec / 3600)}h`;}
  return `${Math.round(sec / 86400)}d`;
}

/**
 * Module-level keyExtractor so FlatList sees a stable function
 * reference across renders. The list is a mix of messages, day
 * separators and an unread divider — each item carries its own
 * pre-computed key (built in chatListItems.ts).
 */
const listItemKeyExtractor = (item: ChatListItem): string => item.key;

/** Visual-top breathing room (ListFooterComponent of the inverted list). */
const LIST_TOP_SPACER = <View style={{height: 8}} />;

function ChatScreenInner({navigation, route}: Props) {
  const {name, conversationId, isGroup, draft} = route.params;
  const insets = useSafeAreaInsets();
  // Polish #2 — drives the read-receipt foreground gate below.
  const isFocused = useIsFocused();
  // Seed the composer with a draft passed from another screen (e.g. the
  // AgentLiveTracker message dock hands off its typed text on `Send`).
  // Falls back to empty string when no draft is passed.
  const [text, setText] = useState(draft ?? '');
  const inputRef = useRef<TextInput>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  // Composer TTL: when null, falls back to the conversation's default
  // (set in ChatInfoScreen). Explicit 0 / positive value from the timer
  // picker always wins per-message.
  const [ttlSec, setTtlSec] = useState<number | null>(null);
  const [viewerMsg, setViewerMsg] = useState<LocalMessage | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [replyTo, setReplyTo] = useState<{messageId: string; preview: string; fromSelf: boolean} | null>(null);
  const [actionMsg, setActionMsg] = useState<LocalMessage | null>(null);
  const [forwardSource, setForwardSource] = useState<LocalMessage | null>(null);
  // Briefly pulse the targeted message after a reply-strip tap so the
  // user sees where we jumped to. Cleared by a timer in jumpToMessage.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Fix #30: FlatList for virtualization (memoised MessageBubble keeps
  // the diff cheap). MX-05: the list is INVERTED — index 0 = newest
  // message = visual bottom, so opening a chat lands on the latest
  // message instantly with no scroll-to-end pass (the old non-inverted
  // list painted the OLDEST 20 rows first, then hard-snapped to the
  // bottom on 0/80/250/500 ms timers — the visible "open flash").
  // In inverted coordinates offset 0 IS the bottom, older messages page
  // in via onEndReached, and appending an older page never shifts
  // existing offsets — no jump, no anchor gymnastics.
  const scrollRef = useRef<FlatList<ChatListItem>>(null);
  const prevCountRef = useRef(0);

  // Android: track keyboard height manually — KAV with behavior="padding"
  // leaves ghost padding after the keyboard closes. iOS uses KAV natively.
  // Fix #29: only update kbHeight when the delta is > 4 dp. Without
  // this, OEMs that report sub-pixel keyboard-height adjustments (some
  // Samsung skins fire keyboardDidShow several times per up-stroke,
  // each with a 1-2 px height bump as the IME fade-in animates) cause
  // a render storm — every microtweak re-runs the entire ChatScreen
  // tree because `kbHeight` is in the deps of the KAV style. 4 dp is
  // below the threshold of human perception for layout shift but
  // above the OEM noise floor.
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') {return;}
    const show = Keyboard.addListener('keyboardDidShow', e => {
      const next = e.endCoordinates.height;
      setKbHeight(prev => Math.abs(prev - next) > 4 ? next : prev);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKbHeight(prev => prev === 0 ? prev : 0);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  const {runtime, ready, error} = useMessenger();
  // B-18 — a 1:1 (direct) conversation's history can be SPLIT across two
  // store slots: the synthetic `direct:<peer>` key and a server-UUID row.
  // `resolveDirectConversationIdFromState` (used by both sendText and the
  // inbound append) picks the server-UUID slot the moment a UUID row syncs
  // in via /conversations/mine — so a message sent before the sync lands in
  // the synthetic slot while one received after lands in the UUID slot.
  // ChatScreen stays pinned to its route-param id, so one side goes
  // invisible (the QA symptom: "receiver sees only its own sent messages").
  // Merge every direct slot that maps to this peer so both render. Groups
  // keep their single stable id; a direct chat whose history lives in ONE
  // slot returns that slot's array verbatim (stable ref → no extra renders).
  const messages        = useMessengerStore(useShallow(s => {
    const slotIds = directConversationSlots(s, conversationId);
    if (slotIds.length === 1) {return s.messages[slotIds[0]] ?? EMPTY_MESSAGES;}
    const lists: LocalMessage[][] = [];
    for (const id of slotIds) {
      const m = s.messages[id];
      if (m && m.length) {lists.push(m);}
    }
    if (lists.length === 0) {return EMPTY_MESSAGES;}
    if (lists.length === 1) {return lists[0];} // single populated slot — stable store ref
    const byId = new Map<string, LocalMessage>();
    for (const list of lists) {for (const m of list) {byId.set(m.id, m);}}
    return Array.from(byId.values()).sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    );
  }));
  const conversation    = useMessengerStore(selectConversation(conversationId));

  // Derive peer address from conversation OR from the conversationId pattern
  // (direct:<userId>) so sends always have a target even if the conversation
  // object wasn't hydrated with a peer field.
  const resolvedPeer = useMemo(() => {
    if (conversation?.peer?.userId) {return conversation.peer;}
    if (conversationId.startsWith('direct:')) {
      return {userId: conversationId.slice(7), deviceId: 1};
    }
    return undefined;
  }, [conversation?.peer, conversationId]);
  const convTtl         = conversation?.default_ttl_sec ?? null;
  const groupNameMap    = useMessengerStore(s => s.groupMemberNames[conversationId]);
  const setActive       = useMessengerStore(s => s.setActiveConversation);
  const peerUserId      = conversation?.peer?.userId;
  const peerPresence    = useMessengerStore(
    s => (peerUserId ? s.presence[peerUserId] : undefined),
  );
  // Group fan-out targets — every member except self. For 1:1 chats this
  // collapses to `[conversation.peer]`; for mission groups it's all CPOs +
  // ops admin minus self. Drives presence subscribe, typing fan-out, and
  // read-receipt routing so the desktop dock can show "X active /
  // Y typing…" instead of the perpetual "no one active" placeholder.
  const ownUserId = useAuthStore(s => s.user?.id);
  const groupPeers = useMemo<SessionAddress[]>(() => {
    if (!conversation) {return [];}
    if (isGroup) {
      return (conversation.participants ?? [])
        .filter(uid => uid && uid !== 'self' && uid !== ownUserId)
        .map(uid => ({userId: uid, deviceId: 1}));
    }
    if (conversation.peer?.userId) {return [conversation.peer];}
    return [];
  }, [conversation, isGroup, ownUserId]);
  // Stable join key so the effects don't re-run on every render just
  // because the array reference changed.
  const groupPeersKey = groupPeers.map(p => p.userId).join(',');
  const peerTyping      = useMessengerStore(s => !!s.typing[conversationId]);
  const connectionState = useMessengerStore(s => s.connection);
  // Index messages by id once per render so each bubble's reply-target
  // lookup is O(1) instead of O(N). Matters once a chat has >100 msgs
  // — the old .find() was quietly O(N²) on scroll.
  const byIdCache = useMemo(() => {
    const m = new Map<string, LocalMessage>();
    for (const msg of messages) {m.set(msg.id, msg);}
    return m;
  }, [messages]);

  // Snapshot unread BEFORE the setActive effect clears it. Drives the
  // "Unread N messages" divider — once the user has opened the chat
  // and seen the bubbles, we keep the divider anchored where it was on
  // entry, even though `conversation.unread_count` flips to 0
  // immediately. Cleared on conversationId change so re-entering a
  // chat after backing out re-snapshots from the new (likely zero)
  // unread count.
  const initialUnreadRef = useRef<number>(0);
  const snapshotConvIdRef = useRef<string | null>(null);
  if (snapshotConvIdRef.current !== conversationId) {
    snapshotConvIdRef.current = conversationId;
    const liveConv = useMessengerStore.getState().conversations[conversationId];
    initialUnreadRef.current = liveConv?.unread_count ?? 0;
  }

  // Fix #31: guard against the rapid-nav race where the user
  // back-out + drill-into-another-chat happens fast enough that the
  // OUTGOING screen's cleanup runs AFTER the new screen's setActive(B)
  // mount. With unconditional `setActive(null)` cleanup, screen B
  // would briefly show as inactive even though it's the foreground
  // chat. Read the live value at cleanup time and only clear if WE
  // are still the active conversation. We can't easily extend Zustand
  // setters here — using getState() is the surgical fix.
  useEffect(() => {
    setActive(conversationId);
    return () => {
      try {
        const liveActive = useMessengerStore.getState().activeConversationId;
        if (liveActive === conversationId) {setActive(null);}
      } catch { /* defensive — store could be torn down on app exit */ }
    };
  }, [conversationId, setActive]);

  // Force-pull any envelopes the relay is queueing for us when the
  // user opens this chat. Belt-and-braces with the WS reconnect
  // drain — the WS may report 'connected' against a dead socket
  // (Doze can silently kill the fd) so the user opening the chat is
  // a strong signal to flush the queue regardless of WS state. Also
  // re-fires on AppState=active so flipping back from backgrounded
  // catches anything that piled up while we were frozen.
  // Fix #32: single-flight is enforced inside productionRuntime
  // (`coalescedDrain` mutex — see productionRuntime.ts:217). So even
  // if mount + AppState=active fire pullEnvelopes() within the same
  // microtask, only one drain is in-flight at a time and parallel
  // callers await the SAME Promise. We therefore don't need extra
  // dedup at this site; just call and trust the runtime.
  useEffect(() => {
    let cancelled = false;
    // Dismiss-on-read — cancel any lingering "New message" banner for this
    // conversation the moment the user opens it (WhatsApp/Signal behavior).
    void (async () => {
      try {
        const {dismissMessageNotif} = require('@/modules/messenger/push/callNotification') as typeof import('@/modules/messenger/push/callNotification');
        await dismissMessageNotif(conversationId);
      } catch { /* notifee unavailable in some contexts — best-effort */ }
    })();
    const doPull = (): void => {
      void (async () => {
        try {
          const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
          const rt = await getMessengerRuntime('production');
          if (cancelled) {return;}
          await rt.pullEnvelopes();
          // Self-heal — opening a group we belong to but hold no master key
          // for is a strong signal to ask the owner to re-share it (lost on
          // logout/reinstall, or missed the fan-out). Rate-limited inside;
          // no-op for 1:1 chats and for groups whose key is already present.
          if (!cancelled && rt.requestGroupKeyResync) {
            const g = useMessengerStore.getState().groups[conversationId];
            const convo = useMessengerStore.getState().conversations[conversationId];
            const isGroupConvo = convo?.type === 'group' || convo?.type === 'ops_channel';
            if (isGroupConvo && !g?.masterKeyB64) {
              await rt.requestGroupKeyResync(conversationId).catch(() => { /* best-effort */ });
            }
          }
        } catch (e) {
          // Runtime may not be ready right after restore — silent.
          console.log('[chat.pull] skipped:', (e as Error).message);
        }
      })();
    };
    doPull();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {doPull();}
    });
    return () => { cancelled = true; sub.remove(); };
  }, [conversationId]);

  // Group hydration — if this is a group (mission room) opened before the
  // /conversations/mine sync ran (push tap, deep link, live-tracker dock),
  // the store row may lack its membership, so the group fan-out would have
  // no recipients. Pull the authoritative roster on mount so the first send
  // already has the member list. Mirrors MessengerHomeScreen's mapping.
  useEffect(() => {
    if (!isGroup) {return;}
    const have = (conversation?.participants?.length ?? 0) > 0
      && (conversation?.type === 'group' || conversation?.type === 'ops_channel');
    if (have) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await conversationApi.listMine();
        if (cancelled) {return;}
        const ownId = useMessengerStore.getState()._ownUserId;
        const upsert = useMessengerStore.getState().upsertConversation;
        const row = data.conversations.find(c => c.id === conversationId);
        if (!row) {return;}
        const memberIds = row.members.map(m => m.userId);
        const peerUid = memberIds.find(uid => uid !== ownId) ?? memberIds[0] ?? '';
        const existing = useMessengerStore.getState().conversations[conversationId];
        upsert({
          id: conversationId,
          type: row.kind,
          name: existing?.name ?? row.title ?? 'Group',
          participants: memberIds,
          unread_count: existing?.unread_count ?? 0,
          is_muted:     existing?.is_muted     ?? false,
          is_pinned:    existing?.is_pinned    ?? false,
          default_ttl_sec: existing?.default_ttl_sec ?? null,
          created_at:   existing?.created_at   ?? row.createdAt,
          peer: existing?.peer?.userId ? existing.peer : {userId: peerUid, deviceId: 1},
          session_state: existing?.session_state ?? 'fresh',
        });
      } catch (e) {
        console.log('[chat.group-sync] skipped:', (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [isGroup, conversationId, conversation?.participants?.length, conversation?.type]);

  // Read-receipt fan-out — whenever this chat is open and new inbound
  // messages arrive (or the chat is opened with a backlog), tell the
  // peer we've seen them.
  // Fix #25: debounced 200 ms. Without this, a burst of inbound
  // messages (relay backlog drain on chat open, or peer typing-bursts)
  // each triggered a separate markRead native call. Each call writes
  // to SQLCipher AND emits a `read.receipt` envelope through the
  // transport. Coalescing means one DB write + one envelope per
  // burst — same correctness (the runtime de-dupes already-receipted
  // ids server-side) at a tiny fraction of the cost.
  // Polish #2 (2026-07-02): only send read receipts when the chat is ACTUALLY
  // visible — focused screen AND app in the foreground. Previously a message
  // landing while the chat was mounted-but-backgrounded (or behind another
  // screen) marked it read, so the sender saw blue ticks the recipient never
  // saw. Re-runs on focus regain so opening the chat still receipts the backlog.
  // F8 — messages that landed while backgrounded were skipped by the
  // AppState.currentState guard below and nothing re-fired the effect on
  // foreground regain; bump a counter on 'active' so the open focused
  // chat marks/emits reads when the user returns.
  const [appActiveTick, setAppActiveTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') {setAppActiveTick(t => t + 1);}
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!runtime || !isFocused) {return;}
    const t = setTimeout(() => {
      if (AppState.currentState !== 'active') {return;}
      runtime.markRead(conversationId);
    }, 200);
    return () => clearTimeout(t);
  }, [runtime, conversationId, messages.length, isFocused, appActiveTick]);

  // Live presence for every peer in this chat while it's open. For 1:1
  // that's a single user; for mission groups it's every CPO + ops admin
  // (minus self) so each member's chip lights up. setActivity is global
  // per-socket — fire it regardless of peer count so anyone watching us
  // sees green. Without this, group-chat surfaces never reported active
  // (the old guard required a single `peerUserId`, which is null for
  // groups since `conversation.peer` is undefined for them) and the
  // ops dock displayed a permanent "no one active".
  useEffect(() => {
    if (!runtime) {return;}
    runtime.setActivity('active');
    if (groupPeers.length > 0) {
      runtime.subscribePresence(groupPeers.map(p => p.userId));
    }
    return () => {
      if (groupPeers.length > 0) {
        runtime.unsubscribePresence(groupPeers.map(p => p.userId));
      }
      // Round 7 / presence audit fix #8 — only flip to 'away' if the
      // user is actually leaving the app. Navigating from chat back
      // to the home screen / settings is NOT idleness; the previous
      // unconditional 'away' here meant any peer watching us would
      // see amber the moment we left a chat, then we'd stay away for
      // the rest of the session because nothing else fires 'active'
      // (productionRuntime now owns the AppState-driven 'active'
      // signal; this hook should only contribute 'away' on real
      // background).
      if (AppState.currentState !== 'active') {
        runtime.setActivity('away');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, groupPeersKey]);

  // Increment the "new messages since scrolled-up" pill on the FAB.
  // If the user is pinned to the bottom, keep counter at 0 and let the
  // ScrollView auto-follow. If they've scrolled up, accumulate until
  // they tap the FAB (scroll-to-bottom resets it).
  useEffect(() => {
    const delta = messages.length - prevCountRef.current;
    prevCountRef.current = messages.length;
    if (atBottom) {
      setNewCount(0);
      return;
    }
    if (delta > 0) {setNewCount(n => n + delta);}
  }, [messages.length, atBottom]);

  // Fix #30: atBottomRef mirror so onContentSizeChange/onScroll can be
  // stable useCallbacks. Without this, every flip of atBottom would
  // re-allocate both handlers and FlatList would re-bind them on the
  // native side. Reading the freshest value through a ref keeps the
  // callbacks identity-stable across the lifetime of the screen.
  const atBottomRef = useRef(atBottom);
  useEffect(() => { atBottomRef.current = atBottom; }, [atBottom]);

  // MX-05 — no initial-scroll pass needed: the inverted list mounts at
  // offset 0, which IS the newest message. (The old BS-CHAT-INITSCROLL
  // 4-shot scrollToEnd timer hack lived here.)

  // Round 6 / pagination — guard refs for the near-top loadOlder
  // trigger. `loadingOlder` prevents a second fire while a fetch is in
  // flight; `exhausted` latches once the runtime reports "no more
  // older". Both reset when the conversation id changes.
  const loadingOlderRef = useRef(false);
  const exhaustedOlderRef = useRef(false);
  useEffect(() => {
    loadingOlderRef.current = false;
    exhaustedOlderRef.current = false;
  }, [conversationId]);
  // Ref-mirrors so the onScroll useCallback can be lifetime-stable
  // (Fix #30 round-2 invariant) while still reading the freshest
  // runtime + conversationId + messages.length values when a
  // near-top scroll fires. Without these, including the values in
  // useCallback deps would re-allocate onScroll on every send,
  // forcing FlatList to re-bind the handler across the JNI bridge.
  const runtimeRef = useRef(runtime);
  useEffect(() => { runtimeRef.current = runtime; }, [runtime]);
  const conversationIdRef = useRef(conversationId);
  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  const messagesLengthRef = useRef(messages.length);
  useEffect(() => { messagesLengthRef.current = messages.length; }, [messages.length]);

  // Emit typing start/stop as the user edits — debounced by the 6s
  // server-side auto-stop so we only fire on transitions, not every
  // keystroke. We send `start` on any non-empty text change; the next
  // `stop` fires on send (see `send()` below) or when the composer
  // clears to empty. For mission groups we fan to every other member;
  // the gateway forwards each frame only to that peer's connected
  // sockets so privacy is preserved.
  // Polish #1 (2026-07-02): typing fans out ONE frame per member (pairwise),
  // so an active group is O(N²) typing traffic across all members' clients.
  // Suppress typing entirely above a threshold — large groups don't benefit
  // from per-peer "is typing" and the WS churn hurts at scale (matches how
  // big-group typing is degraded in WhatsApp). 1:1 and small groups keep it.
  const TYPING_FANOUT_MAX_PEERS = 8;
  const typingActiveRef = useRef(false);
  // PRES-20 — when the last `start` was emitted. The server auto-stops
  // typing after 6s, so continued typing (text stays non-empty) must
  // re-emit `start` before that window lapses or the peer's indicator
  // goes stale mid-composition. Piggybacks on text changes; no timers.
  const lastTypingSentAtRef = useRef(0);
  useEffect(() => {
    if (!runtime || groupPeers.length === 0 || groupPeers.length > TYPING_FANOUT_MAX_PEERS) {return;}
    const shouldType = text.trim().length > 0;
    if (shouldType && !typingActiveRef.current) {
      for (const peer of groupPeers) {runtime.sendTyping(peer, 'start');}
      typingActiveRef.current = true;
      lastTypingSentAtRef.current = Date.now();
    } else if (shouldType && typingActiveRef.current
        && Date.now() - lastTypingSentAtRef.current > 5_000) {
      for (const peer of groupPeers) {runtime.sendTyping(peer, 'start');}
      lastTypingSentAtRef.current = Date.now();
    } else if (!shouldType && typingActiveRef.current) {
      for (const peer of groupPeers) {runtime.sendTyping(peer, 'stop');}
      typingActiveRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, runtime, groupPeersKey]);

  // Fix #33: when the user navigates between chats, fire a typing-stop
  // to the OUTGOING peer set so the previous chat doesn't show a
  // perpetual "Alice is typing…" on the recipient side. Without this,
  // a quick switch from chat A to chat B with text already in the
  // composer left the start-typing event unmatched on chat A; the
  // peer's typing indicator stuck until the 6 s server-side auto-stop
  // fired. Cleanup also resets the ref so the new chat's effect sees
  // a clean state regardless of the previous chat's draft.
  useEffect(() => {
    // Snapshot the OUTGOING peers — when this cleanup runs, groupPeers
    // refers to the chat we're leaving (the deps re-bind on
    // conversationId change so cleanup sees the OLD value via closure).
    const outgoingPeers = groupPeers;
    const outgoingRuntime = runtime;
    return () => {
      if (typingActiveRef.current && outgoingRuntime && outgoingPeers.length > 0) {
        for (const peer of outgoingPeers) {
          try { outgoingRuntime.sendTyping(peer, 'stop'); } catch { /* ignore */ }
        }
      }
      typingActiveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Hide the bottom tab bar while a conversation is open — keeps the chat
  // fullscreen and prevents the tab row overlapping the input on short
  // screens. Restored when the user backs out to MessengerHome.
  useEffect(() => {
    const tabNav = navigation.getParent();
    tabNav?.setOptions({tabBarStyle: {display: 'none'}});
    return () => tabNav?.setOptions({tabBarStyle: undefined});
  }, [navigation]);

  // LIVE-MONITOR (#9) — after a text send the composer swaps the send button for
  // the press-to-record mic at the SAME position; a quick follow-up tap would
  // otherwise arm the recorder. Hold a short settle window so the mic doesn't
  // appear under the finger immediately after a send.
  const [justSent, setJustSent] = useState(false);
  const justSentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (justSentTimer.current) { clearTimeout(justSentTimer.current); } }, []);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || !runtime) {return;}
    setText('');
    // B-73 — also clear the NATIVE field imperatively. `setText('')` alone
    // must round-trip through a re-render before the native EditText updates;
    // a fast next keystroke lands on the uncleared field and onChangeText
    // reports the concatenation ("2" → "23" → "234" under rapid send).
    inputRef.current?.clear();
    setEmojiOpen(false);
    setJustSent(true);
    if (justSentTimer.current) { clearTimeout(justSentTimer.current); }
    justSentTimer.current = setTimeout(() => setJustSent(false), 350);
    // BS-CHAT-SCROLL — when the user sends, always jump to the bottom so
    // their own message is visible (WhatsApp behaviour), even if they were
    // scrolled up reading history. Inverted list: bottom = offset 0.
    atBottomRef.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToOffset({offset: 0, animated: true}));
    const replySnapshot = replyTo;
    setReplyTo(null);
    if (typingActiveRef.current && groupPeers.length > 0) {
      for (const peer of groupPeers) {runtime.sendTyping(peer, 'stop');}
      typingActiveRef.current = false;
    }
    haptics.tap();
    try {
      const effectiveTtl = ttlSec ?? convTtl ?? undefined;
      await runtime.sendText(conversationId, trimmed, {
        peer:      resolvedPeer,
        isGroup,
        ttlSeconds: effectiveTtl,
        replyTo: replySnapshot
          ? {messageId: replySnapshot.messageId, preview: replySnapshot.preview}
          : undefined,
      });
    } catch (e) {
      useMessengerStore.getState().setError(sendErrorText(e, 'Send failed'));
    }
  };

  /**
   * Tap-to-retry for a failed outbound message. P1-1 — re-runs the send
   * pipeline under the SAME bubble id (relay clientMsgId dedup makes it
   * idempotent) after flipping the row back to `sending`. The old code
   * removed the failed bubble FIRST and then re-sent under a fresh id, so a
   * re-send that rejected at the cert fetch destroyed the persisted message
   * with no bubble and no retry chip. Media is now retryable too when the
   * encrypted object was already uploaded (upload-succeeded, send-failed);
   * a failed UPLOAD persisted no bytes, so that case can't be re-shipped.
   */
  const retrySend = useCallback(async (msg: LocalMessage) => {
    if (!runtime) {return;}
    // B-46 — `undelivered` (recipient destroyed the envelope: identity
    // churn) is retryable too: the auto-resend gets one bounded attempt;
    // this chip is the manual fallback and re-runs the full send pipeline
    // (fresh session against the peer's CURRENT identity).
    if (msg.status !== 'failed' && msg.status !== 'undelivered') {return;}

    const isMedia = msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'file';
    // P2-12 — re-ship an already-uploaded media object; a failed UPLOAD left no
    // object key and no persisted bytes, so it can't be retried here.
    const canReshipMedia = isMedia && !!msg.media_object_key && !!msg.media_key && !!msg.media_iv;
    if (isMedia && !canReshipMedia) {
      Alert.alert(
        'Retry not available',
        'This attachment could not finish uploading — re-attach and send the file again.',
      );
      return;
    }

    const content = msg.content ?? '';
    if (!isMedia && !content) {return;}
    const replyMeta = msg.reply_to_msg_id && msg.reply_to_preview
      ? {messageId: msg.reply_to_msg_id, preview: msg.reply_to_preview}
      : undefined;
    const ttl = msg.expires_at
      ? Math.max(1, Math.round((msg.expires_at - new Date(msg.created_at).getTime()) / 1000))
      : (convTtl ?? undefined);
    const attachment = canReshipMedia
      ? {
          objectKey: msg.media_object_key!,
          keyB64:    msg.media_key!,
          ivB64:     msg.media_iv!,
          mimeType:  msg.media_mime ?? 'application/octet-stream',
          size:      (msg as {media_size?: number}).media_size ?? 0,
          kind:      msg.type as 'image' | 'audio' | 'video' | 'file',
        }
      : undefined;

    // P1-1 — flip the EXISTING bubble to `sending` and re-send under the SAME
    // id (existingMsgId). Never remove the durable row first. clientMsgId dedup
    // on the relay makes a re-send idempotent, so no double delivery.
    useMessengerStore.getState().updateMessageStatus(conversationId, msg.id, 'sending');
    haptics.select();
    try {
      await runtime.sendText(conversationId, content, {
        peer:          resolvedPeer,
        isGroup,
        ttlSeconds:    ttl,
        replyTo:       replyMeta,
        existingMsgId: msg.id,
        attachment,
      });
    } catch (e) {
      useMessengerStore.getState().setError(sendErrorText(e, 'Retry failed'));
    }
  }, [runtime, conversationId, resolvedPeer, convTtl, isGroup]);

  const copyMessage = async (msg: LocalMessage) => {
    setActionMsg(null);
    if (!msg.content) {return;}
    try { await Clipboard.setStringAsync(msg.content); } catch { /* ignore */ }
    haptics.select();
  };

  // MX-12 — stable identity: renderItem closes over this, so it must not
  // re-mint every render (setters are identity-stable).
  const startReply = useCallback((msg: LocalMessage) => {
    setActionMsg(null);
    setReplyTo({
      messageId: msg.id,
      preview:   previewForReply(msg),
      fromSelf:  msg.sender_id === 'self',
    });
  }, []);

  const deleteMessage = (msg: LocalMessage) => {
    setActionMsg(null);
    // P2-10 — drop any still-queued outbox row(s) for this message so the next
    // reconnect drain doesn't ship a message the sender just deleted. For a 1:1
    // or group send the outbox key (clientMsgId) equals msg.id. Harmless no-op
    // for an already-delivered message (row already gone).
    void runtime?.discardOutboxForMessage(msg.id).catch(() => { /* best-effort */ });
    useMessengerStore.getState().removeMessage(conversationId, msg.id);
  };

  const startForward = (msg: LocalMessage) => {
    setActionMsg(null);
    setForwardSource(msg);
  };

  const forwardTo = async (targetConvId: string) => {
    const src = forwardSource;
    setForwardSource(null);
    if (!src || !runtime) {return;}

    const store   = useMessengerStore.getState();
    const target  = store.conversations[targetConvId];
    if (!target?.peer) {
      Alert.alert('Forward failed', 'Target conversation not found.');
      return;
    }

    const isMedia = src.type === 'image' || src.type === 'file' || src.type === 'audio' || src.type === 'video';
    // Audit MSG-11 — a forwardable media message ALREADY carries the encrypted
    // object key + AES key + IV, so forwarding needs NO re-upload: re-send via
    // sendText with the same attachment. sendText re-registers the media grant
    // for the new recipient (so they can download) and fans a real envelope.
    const canReforwardMedia = isMedia
      && !!src.media_object_key && !!src.media_key && !!src.media_iv;

    // Loopback mode's sendText only talks to LOOPBACK_PEER — the echo
    // fakes a round-trip locally. Real peers have no session, so we
    // can't call sendText. Instead, append a copy of the message
    // straight into the target's list.
    const isLoopback = runtime.mode !== 'production';

    // Local-fake ONLY for loopback, or for media we genuinely can't re-forward
    // (missing object key — e.g. a legacy local-only bubble).
    if (isLoopback || (isMedia && !canReforwardMedia)) {
      const forwarded: LocalMessage = {
        ...src,
        id:              Math.random().toString(36).slice(2) + Date.now().toString(36),
        conversation_id: targetConvId,
        sender_id:       'self',
        status:          isLoopback ? 'sent' : 'failed',   // honest: real send didn't happen
        created_at:      new Date().toISOString(),
        peer:            target.peer,
        // Reset reply/reactions on a forward — the quoted message belongs
        // to the source conversation, not this one.
        reply_to_msg_id:  undefined,
        reply_to_preview: undefined,
        reactions:        undefined,
        content:          src.sender_id === 'self' ? src.content : `↪ Forwarded\n${src.content ?? ''}`,
      };
      store.appendMessage(targetConvId, forwarded);
      haptics.tap();
      return;
    }

    // Production media forward — re-send the existing encrypted object.
    if (canReforwardMedia) {
      try {
        await runtime.sendText(targetConvId, src.content ?? '', {
          peer: target.peer,
          attachment: {
            objectKey: src.media_object_key!,
            keyB64:    src.media_key!,
            ivB64:     src.media_iv!,
            mimeType:  src.media_mime ?? 'application/octet-stream',
            size:      (src as {media_size?: number}).media_size ?? 0,
          },
        });
        haptics.tap();
      } catch (e) {
        useMessengerStore.getState().setError(sendErrorText(e, 'Forward failed'));
      }
      return;
    }

    // Production text-message forward — re-encrypt to the new peer.
    const prefix = src.sender_id === 'self' ? '' : '↪ Forwarded\n';
    const body   = src.content ?? '';
    try {
      await runtime.sendText(
        targetConvId,
        `${prefix}${body}`,
        {peer: target.peer},
      );
      haptics.tap();
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Unknown error';
      Alert.alert('Forward failed', reason);
    }
  };

  /**
   * Scroll the chat to the message whose id matches `targetId` and
   * pulse-highlight it for ~1.2s. Called from a tap on the reply strip.
   * If we don't have a recorded position (target is offscreen far above
   * and hasn't mounted yet) we still scroll to the top as a best-effort.
   */
  const jumpToMessage = (targetId: string) => {
    // Audit MSG-15 (2026-07-02): prefer INDEX-based scroll. The cached
    // y-offset map assumes the list only grows at the bottom, but
    // loadOlderMessages PREPENDS a page, shifting every recorded offset — so
    // after any scroll-back a reply-jump landed at the wrong bubble. The
    // current list index is always correct; onScrollToIndexFailed (added on
    // the FlatList) covers the un-measured-offscreen case.
    const idx = listItems.findIndex(it => it.kind === 'msg' && it.msg.id === targetId);
    if (idx >= 0) {
      try {
        // Inverted list: viewPosition is in flipped coordinates, so 0.7
        // places the target ~30% from the VISUAL top — comfortably in view.
        scrollRef.current?.scrollToIndex({index: idx, viewPosition: 0.7, animated: true});
      } catch {
        scrollRef.current?.scrollToEnd({animated: true});
      }
    } else {
      // Not in the currently-loaded window — jump toward the visual top
      // (inverted: end of content = oldest) so the user can scroll back.
      scrollRef.current?.scrollToEnd({animated: true});
    }
    haptics.select();
    setHighlightedId(targetId);
    setTimeout(() => setHighlightedId(curr => (curr === targetId ? null : curr)), 1200);
  };
  // F-14 — ref-mirror (same pattern as onSwipeReply in the bubble): the
  // MessageBubble memo comparator skips function props, so a bubble that
  // bails out keeps its FIRST onReplyTap closure — which would close over
  // a jumpToMessage whose listItems predate a pagination prepend and jump
  // to the wrong index. Calling through the ref always reads the latest.
  const jumpToMessageRef = useRef(jumpToMessage);
  useEffect(() => { jumpToMessageRef.current = jumpToMessage; });

  const conversationPeer = conversation?.peer;
  const reactToMessage = useCallback(async (msg: LocalMessage, emoji: string) => {
    setActionMsg(null);
    if (!runtime || !conversationPeer) {return;}
    const mine = msg.reactions?.self;
    const remove = mine === emoji;
    await runtime.sendReaction(conversationPeer, conversationId, msg.id, emoji, remove);
    haptics.impact();
  }, [runtime, conversationPeer, conversationId]);

  // ─── Encrypted media send ──────────────────────────────────────────
  // Pick → read bytes → runtime.sendMedia (AES-256-CBC encrypt, upload
  // ciphertext, ship the per-file key in-band inside the sealed envelope).
  // The runtime builds the local bubble + registers download grants.
  // MX-09 — sends run through a SERIAL queue that never blocks the
  // composer: each bubble appears immediately with a determinate upload
  // ring while the user keeps typing. Serial so an N-photo pick can't
  // hold N × ≤50 MB plaintext buffers at once.
  const [mediaQueue, setMediaQueue] = useState<{done: number; total: number} | null>(null);
  // B-87/MX-04 — assets awaiting review in the pre-send tray.
  const [pendingAssets, setPendingAssets] = useState<PickedAsset[]>([]);
  const mediaQueueRef     = useRef<PickedAsset[]>([]);
  const mediaQueueRunning = useRef(false);
  const queueTotalRef     = useRef(0);
  const queueDoneRef      = useRef(0);

  const sendPickedMedia = useCallback(async (
    uri: string,
    mimeType: string,
    kind: 'image' | 'audio' | 'video' | 'file',
    // Media-parity (2026-07-03) — optional display hints from the picker
    // (filename, dimensions, duration) shipped inside the sealed envelope.
    meta?: {name?: string; width?: number; height?: number; durationMs?: number},
  ) => {
    const rt = runtimeRef.current;
    if (!rt || typeof rt.sendMedia !== 'function') {
      Alert.alert('Cannot send', 'Secure session is still initialising. Try again in a moment.');
      return;
    }
    // Own media send lands at the bottom — surface it (WhatsApp behavior).
    atBottomRef.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToOffset({offset: 0, animated: true}));
    try {
      // Media-parity G3 — sender-side tiny JPEG thumbnail for images so
      // the recipient's bubble renders INSTANTLY from the envelope while
      // the full blob downloads. Best-effort: a manipulator failure just
      // means the old lock-box placeholder.
      let thumbB64: string | undefined;
      if (kind === 'image') {
        try {
          const t = await ImageManipulator.manipulateAsync(
            uri,
            [{resize: {width: 320}}],
            {compress: 0.35, format: ImageManipulator.SaveFormat.JPEG, base64: true},
          );
          if (t.base64 && t.base64.length <= 48 * 1024) {thumbB64 = t.base64;}
        } catch { /* thumbnail is a bonus, never a blocker */ }
      }
      const bytes = await readUriBytes(uri);
      // 50 MB cap mirrors the server's MEDIA_MAX_UPLOAD_BYTES — but the
      // server measures the CIPHERTEXT, and we cap the PLAINTEXT here.
      // v2 blob layout (aesCbc.ts): 1 version byte + PKCS#7-padded
      // AES-CBC (adds 1..16 bytes) + 32-byte HMAC tag = worst case
      // plaintext + 49 bytes, so a pick within 49 bytes of the limit
      // would pass here and 400 mid-upload (MEDIA-07 boundary).
      const V2_CIPHERTEXT_OVERHEAD = 1 + 16 + 32;
      if (bytes.byteLength > 50 * 1024 * 1024 - V2_CIPHERTEXT_OVERHEAD) {
        Alert.alert('File too large', 'Attachments are limited to 50 MB.');
        return;
      }
      await rt.sendMedia!(
        conversationIdRef.current,
        {bytes, mimeType, kind, meta: {...meta, ...(thumbB64 ? {thumbB64} : {})}},
        // P1-3 — plumb the disappearing-message TTL (per-message override, then
        // the conversation default) AND the group hint, mirroring the text path.
        // Without ttlSeconds, media in a disappearing chat never expired.
        {peer: resolvedPeer, ttlSeconds: ttlSec ?? convTtl ?? undefined, isGroup},
      );
      haptics.tap();
    } catch (e) {
      useMessengerStore.getState().setError(sendErrorText(e, 'Media send failed'));
      Alert.alert('Send failed', sendErrorText(e, 'Could not send the attachment.'));
    }
  }, [resolvedPeer, ttlSec, convTtl, isGroup]);

  /**
   * MX-09 — serial media queue. Every media send (library multi-pick,
   * camera, document, voice note) funnels through here so at most ONE
   * plaintext buffer is resident and the composer never locks. The chip
   * above the input bar narrates "k of n" for multi-sends.
   */
  // Ref-mirror so items enqueued MID-RUN are sent with the freshest
  // closure (TTL/peer changes during a long queue), not the one captured
  // when the runner started.
  const sendPickedMediaRef = useRef(sendPickedMedia);
  useEffect(() => { sendPickedMediaRef.current = sendPickedMedia; }, [sendPickedMedia]);

  const enqueueMediaAssets = useCallback((assets: PickedAsset[]) => {
    if (assets.length === 0) {return;}
    // One upfront readiness check — without it a 10-photo pick during
    // session boot raised 10 sequential "Cannot send" alerts.
    const rt = runtimeRef.current;
    if (!rt || typeof rt.sendMedia !== 'function') {
      Alert.alert('Cannot send', 'Secure session is still initialising. Try again in a moment.');
      return;
    }
    mediaQueueRef.current.push(...assets);
    queueTotalRef.current += assets.length;
    setMediaQueue({done: queueDoneRef.current, total: queueTotalRef.current});
    if (mediaQueueRunning.current) {return;}
    mediaQueueRunning.current = true;
    void (async () => {
      try {
        for (;;) {
          const next = mediaQueueRef.current.shift();
          if (!next) {break;}
          // sendPickedMedia surfaces its own failures (failed bubble +
          // retry chip); the queue just moves on to the next item.
          try { await sendPickedMediaRef.current(next.uri, next.mime, next.kind, next.meta); } catch { /* surfaced above */ }
          queueDoneRef.current += 1;
          setMediaQueue({done: queueDoneRef.current, total: queueTotalRef.current});
        }
      } finally {
        mediaQueueRunning.current = false;
        queueTotalRef.current = 0;
        queueDoneRef.current = 0;
        setMediaQueue(null);
      }
    })();
  }, []);

  const captureImage = async () => {
    setAttachOpen(false);
    try {
      // Media-parity G10 — compress camera shots (WhatsApp-comparable
      // 1920px/q0.8). Original-resolution photos were the single biggest
      // send+receive latency cost.
      const res = await launchCamera({
        mediaType: 'photo', saveToPhotos: false, includeBase64: false,
        quality: 0.8, maxWidth: 1920, maxHeight: 1920,
      });
      const asset = res.assets?.[0];
      if (res.didCancel || !asset?.uri) {return;}
      enqueueMediaAssets([{
        uri:  asset.uri,
        mime: asset.type ?? 'image/jpeg',
        kind: 'image',
        meta: {name: asset.fileName ?? undefined, width: asset.width, height: asset.height},
      }]);
    } catch {
      Alert.alert('Camera unavailable', 'Could not open the camera on this device.');
    }
  };

  const pickImage = async () => {
    setAttachOpen(false);
    try {
      // G10 — quality/max apply to photos; library videos pass through
      // untouched (transcoding is out of scope).
      // B-87/MX-04 — multi-select up to MAX_PICKED_ASSETS. A single pick
      // keeps the immediate-send fast path; 2+ open the review tray so a
      // batch is a deliberate, reviewed send.
      const res = await launchImageLibrary({
        mediaType: 'mixed', selectionLimit: MAX_PICKED_ASSETS, includeBase64: false,
        quality: 0.8, maxWidth: 1920, maxHeight: 1920,
      });
      if (res.didCancel) {return;}
      const assets = normalizePickedAssets(res.assets);
      if (assets.length === 0) {return;}
      if (assets.length === 1) {
        enqueueMediaAssets(assets);
        return;
      }
      haptics.select();
      setPendingAssets(assets);
    } catch {
      Alert.alert('Picker unavailable', 'Could not open the photo library.');
    }
  };

  const pickDocument = async () => {
    setAttachOpen(false);
    try {
      const res = await DocumentPicker.getDocumentAsync({type: '*/*', copyToCacheDirectory: true});
      if (res.canceled) {return;}
      const asset = res.assets?.[0];
      if (!asset?.uri) {return;}
      const mime = asset.mimeType ?? 'application/octet-stream';
      const kind: 'image' | 'audio' | 'video' | 'file' =
        mime.startsWith('image/') ? 'image'
        : mime.startsWith('audio/') ? 'audio'
        : mime.startsWith('video/') ? 'video'
        : 'file';
      // Media-parity M14 — the original filename used to be dropped here,
      // so recipients saw a bare mime type as the document title.
      enqueueMediaAssets([{uri: asset.uri, mime, kind, meta: {name: asset.name ?? undefined}}]);
    } catch {
      Alert.alert('Picker unavailable', 'Could not open the document picker.');
    }
  };

  const appendEmoji = (e: string) => {
    setText(prev => prev + e);
  };

  const statusLabel = useMemo(() => {
    if (error) {return `Error: ${error}`;}
    if (!ready) {return 'Initializing secure session…';}
    if (runtime?.mode === 'loopback-memory' || runtime?.mode === 'loopback-sqlcipher') {
      return 'LOOPBACK MODE — messages echo back to verify crypto';
    }
    return null;
  }, [error, ready, runtime]);

  const loopbackActive = runtime?.mode === 'loopback-memory' || runtime?.mode === 'loopback-sqlcipher';

  // Rank 13 day separators + one-shot unread divider, built chronologically
  // then REVERSED for the inverted list (see chatListItems.ts). Rows are
  // identity-stable across rebuilds (MX-07) so a single status flip only
  // re-renders the one changed bubble.
  const listItems = useMemo<ChatListItem[]>(
    () => buildInvertedChatListItems(messages, initialUnreadRef.current),
    [messages],
  );

  // Fix #30: hoist ListHeader / ListFooter / ListEmpty into memoised JSX.
  // Inline JSX in `ListHeaderComponent={(...)}` re-creates the element on
  // every render, forcing FlatList to re-mount the children — most notably
  // TypingBubble, whose animated dot loop restarts each time.
  // Inverted-list role swap: ListHeaderComponent renders at the VISUAL
  // BOTTOM (typing indicator, next to the composer) and ListFooterComponent
  // at the visual top. Header/footer are counter-flipped by
  // VirtualizedList, so their content renders upright.
  const listEmpty = useMemo(() => (
    <View style={styles.emptyWrap} collapsable={false}>
      {ready ? (
        <>
          <Icon name="shield-lock-outline" size={28} color="#244C82" />
          <Text style={styles.emptyText}>No messages yet.</Text>
          <Text style={styles.emptyHint}>
            {loopbackActive
              ? 'Loopback mode — messages echo back through an in-process peer to verify the crypto round-trip.'
              : 'Send a message — it will be end-to-end encrypted on this device before it leaves.'}
          </Text>
        </>
      ) : null}
    </View>
  ), [ready, loopbackActive]);
  const listBottomAccessory = useMemo(() => (
    <>
      <View style={{height: 8}} />
      <TypingBubble visible={peerTyping} />
    </>
  ), [peerTyping]);

  // Fix #30: stable onScroll via ref-mirror so RN doesn't re-bind the
  // native handler across the JNI bridge each render. Inverted list:
  // "at bottom" = contentOffset.y near 0. New-message auto-follow is
  // native now (maintainVisibleContentPosition.autoscrollToTopThreshold),
  // so no onContentSizeChange scroll pass is needed.
  const onScroll = useCallback((e: {nativeEvent: {contentOffset: {y: number}}}) => {
    // 48px slack so pinch-scrolls near the bottom still count as "at bottom".
    const near = e.nativeEvent.contentOffset.y <= 48;
    if (near !== atBottomRef.current) {
      atBottomRef.current = near;
      setAtBottom(near);
    }
  }, []);

  // Round 6 / pagination — inverted list puts the OLDER end at the end of
  // the data, so plain onEndReached is the pagination trigger (the old
  // non-inverted list needed an onScroll `y < 200` heuristic). Gated on a
  // loading-in-flight ref + an exhausted-latch ref so overlapping calls
  // can't spam the runtime. Appending an older page never shifts existing
  // inverted offsets, so there's no anchor jerk to compensate for.
  const onEndReached = useCallback(() => {
    if (loadingOlderRef.current || exhaustedOlderRef.current || messagesLengthRef.current === 0) {return;}
    loadingOlderRef.current = true;
    const liveRuntime = runtimeRef.current;
    const liveConvId  = conversationIdRef.current;
    void (async () => {
      try {
        const fn = liveRuntime?.loadOlderMessages;
        if (!fn) {
          // Loopback or runtime not ready — latch so we don't keep
          // probing on every scroll tick.
          exhaustedOlderRef.current = true;
          return;
        }
        const {exhausted} = await fn(liveConvId);
        if (exhausted) {exhaustedOlderRef.current = true;}
      } catch (err) {
        // Don't latch on transient errors — let the next scroll
        // try again. Quiet warn so the chat console doesn't blare.
        console.log('[chat.loadOlder] failed:', (err as Error).message);
      } finally {
        loadingOlderRef.current = false;
      }
    })();
  }, []);

  // MX-12 — renderItem as a useCallback instead of a fresh inline closure
  // per ChatScreen render. Its identity now only changes when the data it
  // actually reads changes; MessageBubble's memo comparator still absorbs
  // per-row work.
  const conversationName = conversation?.name;
  const renderListItem = useCallback(({item}: ListRenderItemInfo<ChatListItem>) => {
    if (item.kind === 'day') {
      return (
        <View style={styles.dateSep}>
          <View style={styles.dateLine} />
          <Text style={styles.dateText}>{item.label}</Text>
          <View style={styles.dateLine} />
        </View>
      );
    }
    if (item.kind === 'unread') {
      return (
        <View style={styles.unreadSep}>
          <View style={styles.unreadLine} />
          <View style={styles.unreadPill}>
            <Text style={styles.unreadPillText}>
              {item.count} UNREAD {item.count === 1 ? 'MESSAGE' : 'MESSAGES'}
            </Text>
          </View>
          <View style={styles.unreadLine} />
        </View>
      );
    }
    const msg = item.msg;
    // item.index is the CHRONOLOGICAL index (display order is reversed),
    // so prev/next run-grouping reads stay unchanged.
    const i = item.index;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    // Cross-day boundaries break the run regardless of time delta,
    // so a message at the start of a new day always paints with
    // its own header tick and avatar.
    const prevSameDay = prev && sameDay(prev.created_at, msg.created_at);
    const nextSameDay = next && sameDay(msg.created_at, next.created_at);
    const isFirstInGroup = !prev
      || !prevSameDay
      || prev.sender_id !== msg.sender_id
      || timeDeltaMs(prev.created_at, msg.created_at) > GROUP_THRESHOLD_MS;
    const isLastInGroup = !next
      || !nextSameDay
      || next.sender_id !== msg.sender_id
      || timeDeltaMs(msg.created_at, next.created_at) > GROUP_THRESHOLD_MS;
    const quoted = msg.reply_to_msg_id ? byIdCache.get(msg.reply_to_msg_id) : undefined;
    // Audit MSG-17 (2026-07-02): in a GROUP, attribute the quoted
    // message to its ACTUAL sender, not the group's name.
    const quotedSenderLabel = quoted
      ? (quoted.sender_id === 'self'
          ? 'You'
          : (isGroup && quoted.sender_id
              ? (groupNameMap?.[quoted.sender_id] ?? resolveSenderName(quoted.sender_id, name))
              : name))
      : msg.reply_to_msg_id
        ? name
        : undefined;
    // Group chat: label + color for each incoming sender. The admin
    // alias (groupNameMap) wins over the profile name so the rename
    // feature from GroupInfo reflects live in the chat.
    const senderLabel = isGroup && msg.sender_id && msg.sender_id !== 'self'
      ? (groupNameMap?.[msg.sender_id] ?? resolveSenderName(msg.sender_id, name))
      : undefined;
    const senderColor = isGroup && msg.sender_id && msg.sender_id !== 'self'
      ? senderColorFor(msg.sender_id)
      : undefined;
    // Call-record bubble renders as a centered pill, not a side-aligned
    // chat bubble. Tapping it launches a fresh call to the same peer.
    if (msg.type === 'call' && msg.call_meta) {
      return (
        <CallRecordRow
          msg={msg}
          peerName={conversationName ?? 'Contact'}
          onPress={() => launchCall(navigation, {
            conversationId,
            callType: msg.call_meta!.kind,
          })}
        />
      );
    }
    return (
      <MessageBubble
        msg={msg}
        isFirstInGroup={isFirstInGroup}
        isLastInGroup={isLastInGroup}
        highlighted={highlightedId === msg.id}
        quotedSenderLabel={quotedSenderLabel}
        senderLabel={senderLabel}
        senderColor={senderColor}
        onOpenImage={() => setViewerMsg(msg)}
        onLongPress={() => { haptics.impact(); setActionMsg(msg); }}
        onSwipeReply={() => { haptics.tap(); startReply(msg); }}
        onDoubleTap={() => { void reactToMessage(msg, '❤️'); }}
        onReplyTap={() => {
          if (msg.reply_to_msg_id) {jumpToMessageRef.current(msg.reply_to_msg_id);}
        }}
        onRetry={() => { void retrySend(msg); }}
      />
    );
  }, [messages, byIdCache, groupNameMap, highlightedId, isGroup, name, conversationName,
      conversationId, navigation, startReply, reactToMessage, retrySend]);

  return (
    <View style={[styles.root, {paddingTop: insets.top, backgroundColor: CHAT_BG}]}>
      <AmbientBg bg={CHAT_BG} />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* ── Premium chat header ────────────────────────────── */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="chevron-left" size={18} color={Bravo.text} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.contactInfo}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('ChatInfo', {conversationId})}>
          <View style={styles.avatarWrap}>
            {/* N-07 — prefer the store's name; route `name` may be absent on a
                notification-tap deep-link. initials() also guards undefined. */}
            <LinearGradient colors={AVATAR_GRADIENT} start={{x: 0.1, y: 0}} end={{x: 0.9, y: 1}} style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(conversation?.name ?? name)}</Text>
            </LinearGradient>
            {!isGroup && <OnlineDot state={headerDotState(peerPresence)} ringColor={CHAT_BG} />}
          </View>
          <View style={{flex:1, minWidth:0}}>
            <View style={styles.nameRow}>
              <Text style={styles.contactName} numberOfLines={1}>{conversation?.name ?? name ?? ''}</Text>
              <Icon name="shield-check" size={12} color={Bravo.signal} />
            </View>
            <View style={styles.presenceRow}>
              {isGroup && conversation ? (
                <GroupMemberStack participants={conversation.participants} />
              ) : (
                <PeerPresencePill presence={peerPresence} />
              )}
            </View>
          </View>
        </TouchableOpacity>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => launchCall(navigation, {conversationId, callType: 'voice'})} activeOpacity={0.7}>
            <Icon name="phone-outline" size={16} color={DM.onAccent} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => launchCall(navigation, {conversationId, callType: 'video'})} activeOpacity={0.7}>
            <Icon name="video-outline" size={17} color={DM.onAccent} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Stacked banners: E2E + loopback (premium) + connection */}
      <View style={styles.bannersStack}>
        <PremiumBanner tone="signal" label="Messages are end-to-end encrypted. Tap for more info." detail="" icon="lock" />
        {loopbackActive && (
          <PremiumBanner tone="amber" label="LOOPBACK MODE" detail="Echo verification active" icon="information-outline" />
        )}
      </View>

      <ConnectionBanner state={connectionState} />

      {/* Stable slot for error / init status (hidden when nothing to say) */}
      <View style={[styles.devBanner, error && styles.devBannerError, !statusLabel && styles.devBannerHidden]}>
        {statusLabel ? (
          <>
            <Icon
              name={error ? 'alert-circle' : ready ? 'information-outline' : 'progress-clock'}
              size={12}
              color={error ? Bravo.alert : Bravo.amber}
            />
            <Text style={[styles.devBannerText, error && {color: Bravo.alert}]}>{statusLabel}</Text>
          </>
        ) : null}
      </View>

      {/*
        Keyboard handling:
          - iOS: 'padding' keeps the composer pinned above the keyboard.
          - Android: pass `undefined` so the native `adjustResize` from
            the manifest handles it. Previously we used 'height' which
            left a "ghost footer" of reserved space when the keyboard
            closed — that was the bug the user flagged.
      */}
      {/* iOS: KeyboardAvoidingView with padding is reliable.
          Android: we track keyboard height via Keyboard events and apply
          it as paddingBottom directly — KAV on Android leaves ghost
          space after the keyboard closes regardless of behavior mode. */}
      <KeyboardAvoidingView
        style={[styles.flex, Platform.OS === 'android' && {paddingBottom: kbHeight}]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 10}>
        {!isGroup && (
          <PeerOfflineBanner presence={peerPresence} variant="chat" peerName={name} />
        )}
        <FlatList
          ref={scrollRef}
          style={styles.msgList}
          contentContainerStyle={styles.msgContent}
          data={listItems}
          keyExtractor={listItemKeyExtractor}
          // MX-05 — inverted: index 0 (newest) renders at the visual
          // bottom, so the chat opens ON the latest message with zero
          // scroll passes, exactly like WhatsApp/Signal.
          inverted
          // Audit MSG-15 — jumpToMessage uses scrollToIndex; with no
          // getItemLayout an offscreen target can't be measured yet, which
          // would otherwise THROW. Nudge toward the target and let the next
          // render settle instead of crashing.
          onScrollToIndexFailed={(info) => {
            // Polish #3 (2026-07-02): the approx offset lands NEAR the target;
            // once the surrounding cells have measured (highWaterMark advanced
            // past the index), retry a PRECISE scrollToIndex so a reply-quote
            // jump lands exactly on the quoted bubble like WhatsApp, not a
            // guess. Bounded single retry — if it still can't measure we keep
            // the approximate position rather than looping.
            const approx = Math.max(0, info.averageItemLength * info.index - 80);
            scrollRef.current?.scrollToOffset({offset: approx, animated: true});
            setTimeout(() => {
              try {
                scrollRef.current?.scrollToIndex({index: info.index, viewPosition: 0.7, animated: true});
              } catch { /* still unmeasured — approximate position stands */ }
            }, 180);
          }}
          // Virtualization windows. WindowSize 11 covers ~5 screens
          // either direction, which absorbs typical fast-scroll without
          // blank-frame flicker. initialNumToRender bounded so the
          // first paint is fast even on a 500-message backlog — and with
          // `inverted` those 20 are the NEWEST rows.
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={11}
          // We DO NOT supply getItemLayout — bubble heights vary
          // wildly (text, images, replies, group sender labels) and
          // an incorrect layout func produces jumpy scroll positions.
          // The cost is FlatList must measure as it renders, but the
          // virtualization win still dwarfs that.
          // Polish #4 (2026-07-02): recycle offscreen cells on ANDROID so a
          // long media-heavy chat doesn't grow native-view memory / GC pressure
          // on mid-range devices (the target class). Kept OFF on iOS where the
          // measure-on-render blank-frame flicker was observed.
          removeClippedSubviews={Platform.OS === 'android'}
          // Inverted-list anchor semantics: a NEW message prepends at data
          // index 0. If the user is within autoscrollToTopThreshold of the
          // bottom (coordinate top), the native side follows it into view;
          // if they're scrolled up reading history, minIndexForVisible: 0
          // holds their anchor row still instead of jerking the viewport.
          // Older-page APPENDS never shift inverted offsets, so pagination
          // needs no anchor work at all.
          maintainVisibleContentPosition={{minIndexForVisible: 0, autoscrollToTopThreshold: 80}}
          onScroll={onScroll}
          // MX-11 — 16 ms cadence: at-bottom detection (FAB visibility)
          // tracks the finger instead of lagging ~5 frames at 80 ms. The
          // handler only mutates a ref + one boolean.
          scrollEventThrottle={16}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.6}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={listBottomAccessory}
          ListFooterComponent={LIST_TOP_SPACER}
          ListEmptyComponent={listEmpty}
          renderItem={renderListItem}
        />

        {replyTo && (
          <View style={styles.replyBar}>
            <Icon name="reply" size={16} color={DM.quoteBar} />
            <View style={styles.replyBarBody}>
              <Text style={styles.replyBarLabel} numberOfLines={1}>
                {replyTo.fromSelf ? 'Replying to yourself' : `Replying to ${name}`}
              </Text>
              <Text style={styles.replyBarText} numberOfLines={1}>{replyTo.preview}</Text>
            </View>
            <TouchableOpacity style={styles.replyBarClose} onPress={() => setReplyTo(null)} activeOpacity={0.7}>
              <Icon name="close" size={15} color={DM.textDim} />
            </TouchableOpacity>
          </View>
        )}

        {mediaQueue && (
          // MX-09 — non-blocking narration: the composer stays live while
          // the serial queue encrypts + uploads (bubbles carry the ring).
          <View style={styles.mediaSendingBar}>
            <Icon name="lock" size={13} color="#1E88FF" />
            <Text style={styles.mediaSendingText}>
              {mediaQueue.total > 1
                ? `Encrypting & sending ${Math.min(mediaQueue.done + 1, mediaQueue.total)} of ${mediaQueue.total}…`
                : 'Encrypting & sending attachment…'}
            </Text>
          </View>
        )}

        <View style={[styles.inputBar, {paddingBottom: insets.bottom + 8}]}>
          <TouchableOpacity
            style={styles.attachBtn}
            activeOpacity={0.7}
            onPress={() => setAttachOpen(true)}>
            <Icon name="plus" size={22} color={DM.onAccent} />
          </TouchableOpacity>
          <View style={styles.inputWrap}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder={ready ? 'Type a secure message...' : 'Establishing session...'}
              placeholderTextColor="#7E8AA6"
              value={text}
              onChangeText={setText}
              editable={ready}
              multiline
            />
            <TouchableOpacity activeOpacity={0.7} onPress={() => setEmojiOpen(true)}>
              <Icon name="emoticon-outline" size={18} color="#7E8AA6" />
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.inputIconBtn, ttlSec ? styles.inputIconBtnActive : null]}
            activeOpacity={0.7}
            onPress={() => setTimerOpen(true)}>
            <Icon name="timer-outline" size={21} color={ttlSec ? '#fb923c' : '#7E8AA6'} />
            {ttlSec ? <Text style={styles.ttlBadge}>{ttlLabel(ttlSec)}</Text> : null}
          </TouchableOpacity>
          {text.trim() || justSent ? (
            <TouchableOpacity
              style={[styles.sendBtn, (!ready || !text.trim()) && {opacity: 0.5}]}
              onPress={() => { void send(); }}
              activeOpacity={0.85}
              disabled={!ready || !text.trim()}>
              <LinearGradient
                colors={MIC_GRADIENT}
                start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.micGradient]}
              />
              <Icon name="send" size={18} color="#FFF" />
            </TouchableOpacity>
          ) : (
            <VoiceNoteRecorder
              onComplete={(rec) => { enqueueMediaAssets([{uri: rec.uri, mime: rec.mimeType, kind: 'audio', meta: {durationMs: rec.durationMs}}]); }}
              onCancel={() => { /* discarded — nothing to do */ }}
              renderIdle={() => (
                <View style={styles.micBtn}>
                  <LinearGradient
                    colors={MIC_GRADIENT}
                    start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFill, styles.micGradient]}
                  />
                  <Icon name="microphone" size={18} color="#FFF" />
                </View>
              )}
            />
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Scroll-to-bottom FAB — appears when the user has scrolled up,
          badged with unread count when new messages arrive behind them. */}
      {!atBottom && (
        <TouchableOpacity
          style={[styles.scrollFab, {bottom: insets.bottom + 88}]}
          onPress={() => {
            scrollRef.current?.scrollToOffset({offset: 0, animated: true});
            setAtBottom(true);
            setNewCount(0);
          }}
          activeOpacity={0.8}>
          <Icon name="chevron-down" size={22} color="#B8C7E0" />
          {newCount > 0 && (
            <View style={styles.scrollFabBadge}>
              <Text style={styles.scrollFabBadgeText}>{newCount > 99 ? '99+' : newCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* Forward picker — lists other conversations */}
      <Modal visible={!!forwardSource} transparent animationType="slide" onRequestClose={() => setForwardSource(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setForwardSource(null)}>
          <Pressable style={[styles.sheet, {maxHeight: '70%'}]}>
            <Text style={styles.sheetTitle}>Forward to…</Text>
            <ForwardList
              currentConvId={conversationId}
              onPick={id => { void forwardTo(id); }}
            />
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setForwardSource(null)} activeOpacity={0.7}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Long-press message action sheet */}
      <Modal visible={!!actionMsg} transparent animationType="fade" onRequestClose={() => setActionMsg(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setActionMsg(null)}>
          <Pressable style={[styles.sheet, styles.actionSheet]}>
            {actionMsg && (
              <>
                <View style={styles.actionReactRow}>
                  {QUICK_REACTIONS.map(emoji => {
                    const mine = actionMsg.reactions?.self === emoji;
                    return (
                      <TouchableOpacity
                        key={emoji}
                        style={[styles.actionReactBtn, mine && styles.actionReactBtnMine]}
                        onPress={() => { void reactToMessage(actionMsg, emoji); }}
                        activeOpacity={0.7}>
                        <Text style={styles.actionReactEmoji}>{emoji}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <View style={styles.actionDivider} />
                <TouchableOpacity style={styles.sheetRow} onPress={() => startReply(actionMsg)} activeOpacity={0.7}>
                  <Icon name="reply" size={20} color="#1E88FF" />
                  <Text style={styles.sheetRowText}>Reply</Text>
                </TouchableOpacity>
                {actionMsg.content && (
                  <TouchableOpacity style={styles.sheetRow} onPress={() => { void copyMessage(actionMsg); }} activeOpacity={0.7}>
                    <Icon name="content-copy" size={20} color="#1E88FF" />
                    <Text style={styles.sheetRowText}>Copy</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.sheetRow} onPress={() => startForward(actionMsg)} activeOpacity={0.7}>
                  <Icon name="share-outline" size={20} color="#1E88FF" />
                  <Text style={styles.sheetRowText}>Forward</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.sheetRow} onPress={() => deleteMessage(actionMsg)} activeOpacity={0.7}>
                  <Icon name="trash-can-outline" size={20} color="#f87171" />
                  <Text style={[styles.sheetRowText, {color:'#f87171'}]}>Delete (this device)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.sheetCancel} onPress={() => setActionMsg(null)} activeOpacity={0.7}>
                  <Text style={styles.sheetCancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Attachment sheet — each row opens the matching native picker,
          encrypts the bytes (AES-256-CBC) on-device, and ships the
          per-file key in-band inside the sealed envelope. */}
      <Modal visible={attachOpen} transparent animationType="slide" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setAttachOpen(false)}>
          <Pressable>
            <LinearGradient colors={SHEET_GRADIENT} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.attachSheet}>
              <View style={styles.attachHandle} />
              <View style={styles.attachHeader}>
                <Text style={styles.attachTitle}>Attach</Text>
                <View style={styles.encBadge}>
                  <Icon name="lock" size={11} color={DM.signal} />
                  <Text style={styles.encBadgeText}>Encrypted</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.attachRow} onPress={() => { void captureImage(); }} activeOpacity={0.7}>
                <View style={styles.attachRowIcon}><Icon name="camera-outline" size={22} color={DM.onAccent} /></View>
                <View style={{flex: 1}}>
                  <Text style={styles.attachRowTitle}>Camera</Text>
                  <Text style={styles.attachRowSub}>Take a photo — encrypted before upload</Text>
                </View>
                <Icon name="chevron-right" size={20} color={DM.textFaint} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.attachRow} onPress={() => { void pickImage(); }} activeOpacity={0.7}>
                <View style={styles.attachRowIcon}><Icon name="image-outline" size={22} color={DM.onAccent} /></View>
                <View style={{flex: 1}}>
                  <Text style={styles.attachRowTitle}>Photo or Video</Text>
                  <Text style={styles.attachRowSub}>From your library — E2E encrypted</Text>
                </View>
                <Icon name="chevron-right" size={20} color={DM.textFaint} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.attachRow, styles.attachRowLast]} onPress={() => { void pickDocument(); }} activeOpacity={0.7}>
                <View style={styles.attachRowIcon}><Icon name="file-outline" size={22} color={DM.onAccent} /></View>
                <View style={{flex: 1}}>
                  <Text style={styles.attachRowTitle}>Document</Text>
                  <Text style={styles.attachRowSub}>Any file up to 50 MB — encrypted</Text>
                </View>
                <Icon name="chevron-right" size={20} color={DM.textFaint} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.attachCancel} onPress={() => setAttachOpen(false)} activeOpacity={0.8}>
                <Text style={styles.attachCancelText}>Cancel</Text>
              </TouchableOpacity>
            </LinearGradient>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full emoji keyboard — searchable, categorised, native-feel */}
      <EmojiPicker
        open={emojiOpen}
        onClose={() => setEmojiOpen(false)}
        onEmojiSelected={e => appendEmoji(e.emoji)}
        categoryPosition="top"
        enableSearchBar
        enableRecentlyUsed
        theme={{
          backdrop: 'rgba(6,20,43,0.85)',
          knob: '#1E88FF',
          container: '#162F54',
          header: '#FFFFFF',
          skinTonesContainer: '#1C3B66',
          category: {icon: '#7E8AA6', iconActive: '#FFFFFF', container: '#162F54', containerActive: '#1E88FF'},
          search: {background: '#1C3B66', text: '#FFFFFF', placeholder: '#7E8AA6', icon: '#7E8AA6'},
        }}
      />

      {/* B-87/MX-04 — pre-send review tray for a multi-photo pick. */}
      <MediaPreviewTray
        assets={pendingAssets}
        onRemoveAt={i => setPendingAssets(prev => prev.filter((_, idx) => idx !== i))}
        onCancel={() => setPendingAssets([])}
        onSend={() => {
          const assets = pendingAssets;
          setPendingAssets([]);
          haptics.tap();
          enqueueMediaAssets(assets);
        }}
      />

      {/* Full-screen attachment viewer — resolves the decrypted local
          uri (downloading + AES-decrypting received blobs on demand) and
          hands off to the shared FileViewer (image / video / audio /
          file) with vault + share + delete actions. */}
      {viewerMsg && (
        <ChatAttachmentViewer
          msg={viewerMsg}
          onClose={() => setViewerMsg(null)}
        />
      )}

      {/* Disappearing-message timer */}
      <Modal visible={timerOpen} transparent animationType="fade" onRequestClose={() => setTimerOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setTimerOpen(false)}>
          <Pressable style={styles.sheet}>
            <Text style={styles.sheetTitle}>Disappearing messages</Text>
            <Text style={styles.sheetSub}>Auto-delete on both devices + the relay</Text>
            {TTL_OPTIONS.map(opt => (
              <TouchableOpacity
                key={String(opt.sec)}
                style={styles.sheetRow}
                onPress={() => { setTtlSec(opt.sec); setTimerOpen(false); }}
                activeOpacity={0.7}>
                <Icon
                  name={ttlSec === opt.sec ? 'radiobox-marked' : 'radiobox-blank'}
                  size={20}
                  color={ttlSec === opt.sec ? '#fb923c' : '#7E8AA6'}
                />
                <Text style={styles.sheetRowText}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// Round 4 / Architecture audit fix: wrap ChatScreen in a per-screen
// ErrorBoundary so a single bad bubble (decrypt failure that escapes
// the bubble's own try/catch, malformed reaction map, etc.) doesn't
// kill the whole app via the root boundary. Retry remounts the screen.
const ChatScreen = withScreenErrorBoundary(ChatScreenInner, 'Chat');
export default ChatScreen;

const BURN_DURATION_MS = 900;

/**
 * Full-screen viewer wrapper for a chat attachment. Resolves the
 * decrypted local uri (downloading + AES-decrypting a received blob on
 * demand) and renders the shared FileViewer once ready. While the blob
 * is still being fetched/decrypted it shows a lightweight overlay so the
 * tap feels responsive instead of dead.
 */
function ChatAttachmentViewer({msg, onClose}: {msg: LocalMessage; onClose: () => void}) {
  const {uri, state, errorReason, load} = useAttachmentUri(msg, {auto: true});
  const removeMessage = useMessengerStore(s => s.removeMessage);

  if (state === 'loading' || (!uri && state !== 'error')) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.viewerRoot} onPress={onClose}>
          <Icon name="lock" size={36} color="#7E8AA6" />
          <Text style={[styles.imageBrokenText, {marginTop: 10}]}>Decrypting…</Text>
        </Pressable>
      </Modal>
    );
  }

  if (state === 'error' || !uri) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.viewerRoot} onPress={onClose}>
          <Icon name="image-broken-variant" size={36} color="#7E8AA6" />
          {/* Media-parity M17 — say WHY (no access / expired / offline)
              instead of one opaque "Attachment unavailable". */}
          <Text style={[styles.imageBrokenText, {marginTop: 10}]}>{attachmentErrorText(errorReason)}</Text>
          <TouchableOpacity onPress={load} activeOpacity={0.7} style={{marginTop: 12}}>
            <Text style={[styles.imageBrokenText, {color: '#1E88FF'}]}>Tap to retry</Text>
          </TouchableOpacity>
        </Pressable>
      </Modal>
    );
  }

  const file: ViewableFile = {
    id:        msg.id,
    // Media-parity M14 — prefer the real filename from the envelope.
    name:      msg.media_meta?.name
      || msg.content
      || (msg.type === 'video' ? 'Video' : msg.type === 'audio' ? 'Voice message' : 'File'),
    uri,
    mimeType:  msg.media_mime ?? 'application/octet-stream',
    size:      msg.media_meta?.sizeBytes,
    createdAt: new Date(msg.created_at).getTime(),
  };

  return (
    <FileViewer
      file={file}
      onClose={onClose}
      onDelete={() => { removeMessage(msg.conversation_id, msg.id); onClose(); }}
    />
  );
}

/**
 * Memoized so a new bubble at the bottom doesn't trigger a re-render
 * of every earlier bubble. Only the fields the bubble actually renders
 * are compared — status ticks and reactions can mutate in place.
 */
const MessageBubble = React.memo(MessageBubbleImpl, (prev, next) => (
  prev.msg.id              === next.msg.id &&
  prev.msg.status          === next.msg.status &&
  prev.msg.content         === next.msg.content &&
  prev.msg.expires_at      === next.msg.expires_at &&
  prev.msg.reactions       === next.msg.reactions &&
  prev.msg.reply_to_msg_id === next.msg.reply_to_msg_id &&
  prev.isFirstInGroup      === next.isFirstInGroup &&
  prev.isLastInGroup       === next.isLastInGroup &&
  prev.highlighted         === next.highlighted &&
  prev.quotedSenderLabel   === next.quotedSenderLabel &&
  prev.senderLabel         === next.senderLabel &&
  prev.senderColor         === next.senderColor
));

function MessageBubbleImpl({
  msg,
  onOpenImage,
  isFirstInGroup = true,
  isLastInGroup  = true,
  highlighted    = false,
  quotedSenderLabel,
  senderLabel,
  senderColor,
  onLongPress,
  onSwipeReply,
  onDoubleTap,
  onReplyTap,
  onRetry,
}: {
  msg: LocalMessage;
  onOpenImage: () => void;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  highlighted?:    boolean;
  quotedSenderLabel?: string;
  /** Group chat only: sender name shown above the incoming bubble. */
  senderLabel?: string;
  /** Group chat only: color used for the sender label + avatar accent. */
  senderColor?: string;
  onLongPress?: () => void;
  onSwipeReply?: () => void;
  onDoubleTap?:  () => void;
  onReplyTap?:   () => void;
  /** Fired when the user taps the "Tap to retry" affordance on a failed send. */
  onRetry?:      () => void;
}) {
  const sent = msg.sender_id === 'self';
  // Rounded silhouette shared by the bubble and its gradient underlay.
  const radii = bubbleRadii(sent, isFirstInGroup, isLastInGroup);
  const time = new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  const statusIcon = statusToIcon(msg.status);
  const expiresIn = useCountdown(msg.expires_at);
  // MX-09 — per-bubble subscription; only the uploading bubble ticks.
  const uploadProgress = useUploadProgress(msg.id);
  // Any message that carries an attachment — either the sender's local
  // pick (media_url) or a received blob reference (media_object_key).
  const hasAttachment = !!msg.media_url || !!msg.media_object_key;
  // MX-09 — while THIS device is still uploading, the row has neither
  // field yet (the object key is patched on after the PUT). Classify by
  // msg.type so the bubble renders its media chrome (thumb + progress
  // ring / % label) instead of falling through to an empty text bubble.
  const isUploading = sent && msg.status === 'sending' && uploadProgress !== null;
  const isImage = msg.type === 'image' && (hasAttachment || isUploading);
  const isVideo = msg.type === 'video' && (hasAttachment || isUploading);
  const isAudio = msg.type === 'audio' && (hasAttachment || isUploading);
  const isFileAtt = msg.type === 'file' && (hasAttachment || isUploading);
  // Auto-fetch only image thumbnails; video/audio/file load on tap so a
  // long thread doesn't eagerly pull every clip.
  const attachment = useAttachmentUri(msg, {auto: isImage});
  const removeMessage = useMessengerStore(s => s.removeMessage);
  const [imageBroken, setImageBroken] = useState(false);
  // Media-parity G8 — one-tap open: a user-initiated download auto-opens
  // the viewer when it resolves instead of demanding a second tap on
  // "Tap to open".
  const [autoOpen, setAutoOpen] = useState(false);
  useEffect(() => {
    if (autoOpen && attachment.uri) {
      setAutoOpen(false);
      onOpenImage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, attachment.uri]);
  // Media-parity G3 — bubble geometry + instant preview from the sealed
  // envelope's metadata (persisted media_meta): correct aspect ratio the
  // moment the row lands, and a tiny thumbnail under the decrypt.
  const mMeta = msg.media_meta;
  const imageH = (() => {
    if (!mMeta?.width || !mMeta?.height) {return 254;}
    const ratio = mMeta.height / Math.max(1, mMeta.width);
    return Math.max(140, Math.min(340, Math.round(254 * ratio)));
  })();
  // MX-10 — memoised: rebuilding the data-URI string per render made RN's
  // Image source prop see a "new" uri each pass on media-heavy threads.
  const thumbB64 = mMeta?.thumbB64;
  const thumbUri = useMemo(
    () => (thumbB64 ? `data:image/jpeg;base64,${thumbB64}` : null),
    [thumbB64],
  );
  // Only the last bubble of a run carries the metadata strip — keeps
  // quick-fire bursts visually tight (like WhatsApp / iMessage).
  const showMeta = isLastInGroup;

  // Animate entry ONLY for freshly-arrived messages. Opening an existing
  // conversation must not re-spring every historical bubble — that's what
  // created the "flash" on back/forward nav. We compare the message's
  // created_at to the component's first-render wall clock: older = skip.
  //
  // Restore stagger: when we're inside the post-restore animation
  // window (set by markRestoredNow at the end of restoreAllMessages),
  // bubbles spring-in on first mount regardless of their age. This
  // gives the user a premium "messages flowing in" feel right after
  // restore completes. The window is short (~8s) so normal scrolling
  // is unaffected.
  const isRestoreAnim = useRef((): boolean => {
    try {
      const {isInRestoreAnimWindow} = require('@/modules/messenger/runtime/expirySweeper') as
        typeof import('@/modules/messenger/runtime/expirySweeper');
      return isInRestoreAnimWindow();
    } catch { return false; }
  }).current();
  const isFresh = useRef(
    isRestoreAnim || Date.now() - new Date(msg.created_at).getTime() < 2000,
  ).current;
  const opacity    = useRef(new Animated.Value(isFresh ? 0   : 1)).current;
  const scale      = useRef(new Animated.Value(isFresh ? 0.9 : 1)).current;
  const translateY = useRef(new Animated.Value(isFresh ? 8   : 0)).current;
  const burnTint   = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isFresh) {return;}
    // Restore-mode: small random delay (0-280ms) per bubble so they
    // cascade into view instead of popping in lockstep — gives the
    // "messages flowing in" feel. Normal fresh sends don't need it.
    const delay = isRestoreAnim ? Math.floor(Math.random() * 280) : 0;
    Animated.parallel([
      Animated.spring(opacity,    {toValue: 1, useNativeDriver: true, tension: 90, friction: 10, delay}),
      Animated.spring(scale,      {toValue: 1, useNativeDriver: true, tension: 90, friction: 10, delay}),
      Animated.spring(translateY, {toValue: 0, useNativeDriver: true, tension: 90, friction: 10, delay}),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fix #27: ref-mirror removeMessage so the timer callback always
  // hits the freshest store action. The previous closure captured the
  // first render's reference; if Zustand swapped the action (it does
  // when the store is replaced — restore-from-disk path), the timer
  // would call into a dangling function that no longer wired into the
  // current store. Mixed-driver split (useNativeDriver:false for
  // burnTint vs true for opacity/scale/translateY) is preserved
  // exactly as before — that fix is still load-bearing.
  const removeMessageRef = useRef(removeMessage);
  useEffect(() => { removeMessageRef.current = removeMessage; }, [removeMessage]);
  useEffect(() => {
    if (!msg.expires_at) {return;}
    const msUntilExpiry = msg.expires_at - Date.now();
    const burnAt = Math.max(0, msUntilExpiry - BURN_DURATION_MS);

    const timer = setTimeout(() => {
      // CRITICAL: split into TWO separate `.start()` calls so we don't
      // mix `useNativeDriver: false` (burnTint colour interpolation) with
      // `useNativeDriver: true` (opacity/scale/translateY) inside the
      // SAME `Animated.parallel`. RN crashes with `mqt_v_native FATAL:
      // Attempting to run JS driven animation on animated node that has
      // been moved to "native" earlier` whenever the parallel block
      // schedules both drivers against nodes that the mount-spring
      // already pinned to native — repro: open a chat that contains a
      // disappearing message right when its burn timer fires (e.g. nav
      // away to a group call and back). Splitting keeps each driver
      // isolated; the visual effect is identical because both timings
      // start in the same JS tick.
      Animated.timing(burnTint, {
        toValue: 1, duration: 250,
        easing: Easing.out(Easing.ease),
        useNativeDriver: false,
      }).start();
      Animated.parallel([
        Animated.timing(opacity,    {toValue: 0,    duration: BURN_DURATION_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true}),
        Animated.timing(scale,      {toValue: 0.6,  duration: BURN_DURATION_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true}),
        Animated.timing(translateY, {toValue: -18,  duration: BURN_DURATION_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true}),
      ]).start(({finished}) => {
        if (finished) {removeMessageRef.current(msg.conversation_id, msg.id);}
      });
    }, burnAt);
    return () => clearTimeout(timer);
    // removeMessage intentionally omitted — read via ref above so the
    // timer doesn't churn whenever the store action identity flips.

  }, [msg.expires_at, msg.id, msg.conversation_id, opacity, scale, burnTint, translateY]);

  const burnBorder = burnTint.interpolate({
    inputRange:  [0, 1],
    outputRange: ['rgba(249,115,22,0.6)', 'rgba(220,38,38,1)'],
  });
  const burnBg = burnTint.interpolate({
    inputRange:  [0, 1],
    outputRange: ['rgba(249,115,22,0)', 'rgba(249,115,22,0.25)'],
  });

  // Swipe-to-reply: translate the bubble on pan, fire onSwipeReply when
  // the user drags past SWIPE_REPLY_THRESHOLD and releases. We animate
  // back to rest on release regardless of whether it triggered.
  const panX = useRef(new Animated.Value(0)).current;
  const lastTap = useRef(0);

  // Pulse-highlight when parent scrolls us into view via reply-tap.
  // Drives both a background tint and a scale "pop" — keeps the
  // reference visually obvious without being a flash-bang.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!highlighted) {return;}
    Animated.sequence([
      Animated.timing(pulse, {toValue: 1, duration: 200, useNativeDriver: false}),
      Animated.delay(600),
      Animated.timing(pulse, {toValue: 0, duration: 400, useNativeDriver: false}),
    ]).start();
  }, [highlighted, pulse]);
  const pulseBg = pulse.interpolate({
    inputRange:  [0, 1],
    // Cobalt "you jumped here" flash — matches the Bravo DM accent.
    outputRange: ['rgba(91,141,239,0)', 'rgba(91,141,239,0.32)'],
  });
  // Fix #28: ref-mirror onSwipeReply so the handler (created ONCE with
  // useRef + .current) reads the latest callback at fire time. Without
  // this, the handler closed over the FIRST render's onSwipeReply — so
  // subsequent re-renders that bound a fresh onSwipeReply (parent passes
  // a different replyTo target) would be ignored.
  const onSwipeReplyRef = useRef(onSwipeReply);
  useEffect(() => { onSwipeReplyRef.current = onSwipeReply; }, [onSwipeReply]);
  // MX-06 — the gesture writes translationX straight into panX on the UI
  // thread (Animated.event + native driver); JS only hears about END /
  // CANCEL to fire the reply + spring home. Right-swipe only; the clamp
  // interpolation keeps left-drags at 0 and caps the pull at 120 so it
  // never reads as a delete gesture.
  const panXClamped = useRef(panX.interpolate({
    inputRange:  [0, 120],
    outputRange: [0, 120],
    extrapolate: 'clamp',
  })).current;
  const onSwipeGestureEvent = useRef(Animated.event(
    [{nativeEvent: {translationX: panX}}],
    {useNativeDriver: true},
  )).current;
  const onSwipeStateChange = useRef((e: PanGestureHandlerStateChangeEvent) => {
    const {state, translationX} = e.nativeEvent;
    if (state === GestureState.BEGAN) {
      // A re-swipe within the ~300 ms spring-home window: stop the spring
      // so it doesn't fight the incoming native event stream on panX.
      panX.stopAnimation();
      return;
    }
    if (state === GestureState.END) {
      if (translationX > SWIPE_REPLY_THRESHOLD) {onSwipeReplyRef.current?.();}
      Animated.spring(panX, {toValue: 0, useNativeDriver: true, tension: 90, friction: 8}).start();
    } else if (state === GestureState.CANCELLED || state === GestureState.FAILED) {
      Animated.spring(panX, {toValue: 0, useNativeDriver: true, tension: 90, friction: 8}).start();
    }
  }).current;

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 280) {onDoubleTap?.();}
    lastTap.current = now;
  };

  return (
    <PanGestureHandler
      // Activate only on a deliberate rightward drag; vertical intent
      // (list scroll) and left drags fail fast so the FlatList keeps them.
      activeOffsetX={16}
      failOffsetX={-16}
      failOffsetY={[-14, 14]}
      onGestureEvent={onSwipeGestureEvent}
      onHandlerStateChange={onSwipeStateChange}>
    <Animated.View
      style={[
        styles.msgWrap,
        sent && styles.msgWrapSent,
        !isFirstInGroup && styles.msgWrapGrouped,
        {opacity, transform: [{scale}, {translateY}, {translateX: panXClamped}]},
      ]}>
      {/* Reply-jump highlight underlay. CRITICAL: the JS-driven
          backgroundColor pulse lives on its OWN node — it must NEVER share
          a node with the wrapper's native-driven opacity / transform /
          panX. Swipe-to-reply and scroll-steal (onPanResponderTerminate)
          move panX to the native driver; animating a JS-driven
          backgroundColor on that same node threw "Attempting to run JS
          driven animation on animated node that has been moved to native
          earlier", which the screen error boundary rendered as
          "Chat hit an error" on every reply-quote jump. Same mixed-driver
          class the burn-timer fix (above) guards against. pointerEvents
          none so it never intercepts taps meant for the bubble. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.pulseHalo, {backgroundColor: pulseBg}]}
      />
      {/* Group chat: sender callsign shown above the first bubble of a run */}
      {!sent && senderLabel && isFirstInGroup && (
        <Text style={[styles.groupSender, senderColor && {color: senderColor}]} numberOfLines={1}>
          {senderLabel}
        </Text>
      )}
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={onLongPress}
        onPress={handleTap}
        delayLongPress={280}
        style={[
          styles.bubble,
          sent ? styles.sentBubble : styles.recvBubble,
          sent && !isLastInGroup  && styles.sentBubbleRunMid,
          sent && !isFirstInGroup && styles.sentBubbleRunTail,
          !sent && !isLastInGroup  && styles.recvBubbleRunMid,
          !sent && !isFirstInGroup && styles.recvBubbleRunTail,
          !sent && senderLabel && senderColor && isFirstInGroup ? {borderLeftWidth: 2, borderLeftColor: senderColor} : undefined,
          msg.expires_at ? {borderLeftWidth: 2, borderLeftColor: '#fb923c'} : undefined,
          isImage ? styles.imageBubble : undefined,
        ]}
      >{!isImage && (
        // Gradient fill for text bubbles (Bravo DM Attach): cobalt outgoing,
        // obsidian incoming. Sits on its OWN node, clipped to the bubble
        // silhouette via matching radii, so it never intersects the wrapper's
        // native transforms (the reply-jump crash class).
        <LinearGradient
          colors={sent ? SENT_GRADIENT : RECV_GRADIENT}
          start={{x: 0, y: 0}} end={{x: 0, y: 1}}
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, radii]}
        />
      )}<Animated.View style={[
        styles.bubbleInner,
        msg.expires_at ? {backgroundColor: burnBg as unknown as string} : undefined,
        msg.expires_at ? {borderLeftWidth: 2, borderLeftColor: burnBorder as unknown as string} : undefined,
      ]}>
        {msg.reply_to_msg_id && msg.reply_to_preview && (
          <TouchableOpacity
            style={[styles.replyStrip, sent && styles.replyStripSent]}
            onPress={onReplyTap}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Jump to quoted message">
            <View style={styles.replyBody}>
              <Text style={[styles.replyAuthor, sent && styles.replyAuthorSent]} numberOfLines={1}>
                {quotedSenderLabel ?? 'Message'}
              </Text>
              <Text style={[styles.replyStripText, sent && styles.replyStripTextSent]} numberOfLines={2}>
                {msg.reply_to_preview}
              </Text>
            </View>
          </TouchableOpacity>
        )}
        {isImage ? (
          <TouchableOpacity activeOpacity={0.9} onPress={() => !imageBroken && attachment.uri && onOpenImage()}>
            {/* MX-09 — during upload there are no download keys yet, so the
                hook reports a TRANSIENT 'error'; suppress the broken tile
                (it self-heals when the object key lands and `load`'s
                identity re-fires the auto effect). */}
            {(imageBroken || attachment.state === 'error') && !isUploading ? (
              <View style={[styles.msgImage, {height: imageH}, styles.imageBrokenWrap]}>
                <Icon name="image-broken-variant" size={32} color="#7E8AA6" />
                <Text style={styles.imageBrokenText}>
                  {attachment.state === 'error' ? attachmentErrorText(attachment.errorReason) : 'Image unavailable'}
                </Text>
                {attachment.state === 'error' && msg.media_object_key && (
                  <TouchableOpacity onPress={attachment.load} activeOpacity={0.7}>
                    <Text style={[styles.imageBrokenText, {color: '#1E88FF'}]}>Tap to retry</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : attachment.uri ? (
              <Image
                source={{uri: attachment.uri}}
                style={[styles.msgImage, {height: imageH}]}
                resizeMode="cover"
                onError={() => {
                  // Audit MEDIA-A3 — a dead local pick uri (revoked content://
                  // after reboot, cache cleared) should fall back to the
                  // encrypted download the message also carries, not a
                  // permanently broken tile. onError() flips the hook to the
                  // download path; only give up if there's nothing to fetch.
                  if (msg.media_object_key && msg.media_key && msg.media_iv) {
                    attachment.onError();
                  } else {
                    setImageBroken(true);
                  }
                }}
              />
            ) : thumbUri ? (
              // Media-parity G3 — instant preview from the envelope's tiny
              // thumbnail while the real blob downloads/decrypts.
              <Image
                source={{uri: thumbUri}}
                style={[styles.msgImage, {height: imageH}]}
                resizeMode="cover"
                blurRadius={2}
              />
            ) : (
              <View style={[styles.msgImage, {height: imageH}, styles.imageBrokenWrap]}>
                <Icon name="lock" size={26} color="#7E8AA6" />
                <Text style={styles.imageBrokenText}>{isUploading ? 'Encrypting…' : 'Decrypting…'}</Text>
              </View>
            )}
            {/* MX-09 — determinate upload ring while this device ships the
                encrypted blob; cleared by the runtime the moment the PUT
                finishes (status stays 'sending' through seal+fan-out). */}
            {msg.status === 'sending' && uploadProgress !== null && (
              <UploadProgressRing fraction={uploadProgress} />
            )}
            {showMeta && attachment.uri && (
              <>
                {/* Gradient foot for meta legibility over photos */}
                <View style={styles.imageMetaShade} pointerEvents="none" />
                <View style={styles.imageMetaRow}>
                  <Text style={styles.imageMetaTime}>{time}</Text>
                  {msg.expires_at && (
                    <View style={styles.timerBadge}>
                      <Icon name="fire" size={11} color="#fb923c" />
                      <Text style={styles.timerText}>{expiresIn ?? '—'}</Text>
                    </View>
                  )}
                  {sent && statusIcon && (
                    <Icon name={statusIcon.name} size={13} color={statusIcon.color === '#7E8AA6' ? '#B8C7E0' : statusIcon.color} />
                  )}
                </View>
              </>
            )}
          </TouchableOpacity>
        ) : isVideo || isAudio || isFileAtt ? (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              if (attachment.uri) {onOpenImage();}
              // Media-parity G8 — one tap: download AND open when ready.
              else if (attachment.state !== 'loading') {setAutoOpen(true); attachment.load();}
            }}
            style={styles.fileAttachRow}>
            <View style={styles.fileAttachIcon}>
              {attachment.state === 'loading' ? (
                <Icon name="lock" size={20} color="#1E88FF" />
              ) : (
                <Icon
                  name={isVideo ? 'play-circle' : isAudio ? 'music-note' : 'file-document-outline'}
                  size={22}
                  color="#1E88FF"
                />
              )}
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.fileAttachName} numberOfLines={1}>
                {/* Media-parity M14 — real filename for documents; duration-
                    labelled rows for playable media. */}
                {mMeta?.name
                  ?? (isVideo ? 'Video' : isAudio ? 'Voice message' : (msg.media_mime ?? 'File'))}
              </Text>
              <Text style={styles.fileAttachSub}>
                {msg.status === 'sending' && uploadProgress !== null
                  ? `Encrypting & uploading… ${Math.round(uploadProgress * 100)}%`
                  : attachment.state === 'loading' ? (autoOpen ? 'Downloading…' : 'Decrypting…')
                  : attachment.state === 'error' ? attachmentErrorText(attachment.errorReason)
                  : attachment.uri ? (mediaSubLabel(mMeta, isVideo || isAudio) ?? 'Tap to open')
                  : (mediaSubLabel(mMeta, isVideo || isAudio) ?? 'Tap to download')}
              </Text>
            </View>
          </TouchableOpacity>
        ) : (
          <>
            {/* T-12 — URLs in the body are tappable; white on the cobalt
                outgoing gradient, soft cobalt on the obsidian incoming one. */}
            <LinkifiedText
              style={styles.msgText}
              linkColor={sent ? '#FFFFFF' : '#A9C5FF'}
              text={msg.content}
            />
            {/* T-12 privacy — received links never auto-fetch; the card asks
                for a tap first so merely receiving a message can't ping the
                link's host from this device. */}
            <LinkPreviewCard text={msg.content} autoFetch={sent} />
          </>
        )}
        {/* Optional caption under any attachment */}
        {hasAttachment && !!msg.content && (
          <LinkifiedText
            style={[styles.msgText, {marginTop: 6}]}
            linkColor={sent ? '#FFFFFF' : '#A9C5FF'}
            text={msg.content}
          />
        )}
      </Animated.View>
      </TouchableOpacity>
      {showMeta && (
        <View style={[styles.msgMeta, !sent && styles.msgMetaIn]}>
          <Text style={styles.msgTime}>{time}</Text>
          {msg.expires_at && (
            <View style={styles.timerBadge}>
              <Icon name="fire" size={12} color={Bravo.amber} />
              <Text style={styles.timerText}>{expiresIn ?? '—'}</Text>
            </View>
          )}
          {sent && statusIcon && (
            (msg.status === 'failed' || msg.status === 'undelivered') && onRetry ? (
              <TouchableOpacity
                style={styles.retryChip}
                onPress={onRetry}
                hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Retry sending this message">
                <Icon name={statusIcon.name} size={13} color={statusIcon.color} />
                <Text style={styles.retryChipText}>Tap to retry</Text>
              </TouchableOpacity>
            ) : (
              <Icon name={statusIcon.name} size={15} color={statusIcon.color} />
            )
          )}
        </View>
      )}
      {msg.reactions && Object.keys(msg.reactions).length > 0 && (
        <View style={[styles.reactionsRow, sent ? {alignSelf: 'flex-end'} : {alignSelf: 'flex-start'}]}>
          {groupReactions(msg.reactions).map(({emoji, count, mine}) => (
            <View key={emoji} style={[styles.reactionChip, mine && styles.reactionChipMine]}>
              <Text style={styles.reactionEmoji}>{emoji}</Text>
              {count > 1 && <Text style={styles.reactionCount}>{count}</Text>}
            </View>
          ))}
        </View>
      )}
    </Animated.View>
    </PanGestureHandler>
  );
}

/**
 * Fold `{userId: emoji}` into `{emoji, count, mine}[]` so the UI can
 * render one chip per distinct emoji. "Mine" is true when the current
 * user's userId is `"self"` in the map — matches how productionRuntime
 * stores the self-echo.
 */
function groupReactions(reactions: Record<string, string>): Array<{emoji: string; count: number; mine: boolean}> {
  const byEmoji = new Map<string, {count: number; mine: boolean}>();
  for (const [who, emoji] of Object.entries(reactions)) {
    const cur = byEmoji.get(emoji) ?? {count: 0, mine: false};
    cur.count += 1;
    if (who === 'self') {cur.mine = true;}
    byEmoji.set(emoji, cur);
  }
  return Array.from(byEmoji.entries()).map(([emoji, v]) => ({emoji, ...v}));
}

// Fix #26: ONE module-level 1 Hz tick that every disappearing-message
// bubble subscribes to via useSyncExternalStore. Prior implementation
// created a setInterval per bubble — a chat with 60+ active timed
// messages had 60+ intervals firing at the same offset, each calling
// setState on its own bubble, each scheduling a render commit. The
// JS thread was burning ~10 ms per second just on tick handlers.
// One subscription per bubble + one shared interval means JS only
// pays for the timer once. M-13: only ARMED bubbles (real expires_at)
// subscribe — the snapshot is Date.now(), which changes every tick, so
// any subscriber re-renders every second by design; unarmed bubbles get
// a no-op subscription in useCountdown instead.
let _countdownNowMs = Date.now();
const _countdownListeners = new Set<() => void>();
let _countdownTimer: ReturnType<typeof setInterval> | null = null;
function _ensureCountdownTimer(): void {
  if (_countdownTimer) {return;}
  // Why: the timer stops whenever no armed bubble is mounted, so the
  // cached snapshot can be minutes stale when the next one subscribes —
  // refresh it here or the first rendered countdown is wildly wrong.
  _countdownNowMs = Date.now();
  _countdownTimer = setInterval(() => {
    _countdownNowMs = Date.now();
    for (const cb of _countdownListeners) {
      try { cb(); } catch { /* one bad subscriber mustn't break the rest */ }
    }
  }, 1000);
}
function _stopCountdownTimerIfIdle(): void {
  if (_countdownTimer && _countdownListeners.size === 0) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
}
function _subscribeCountdown(cb: () => void): () => void {
  _countdownListeners.add(cb);
  _ensureCountdownTimer();
  return () => {
    _countdownListeners.delete(cb);
    _stopCountdownTimerIfIdle();
  };
}
function _getCountdownSnapshot(): number {
  return _countdownNowMs;
}

// M-13 — stable no-op pair for unarmed bubbles. React.memo CANNOT block
// a hook-driven self-render, so a real subscription here re-rendered
// every mounted bubble at 1 Hz regardless of expires_at.
const _noopSubscribe = (): (() => void) => () => {};
const _zeroSnapshot = (): number => 0;

function useCountdown(expiresAtMs?: number): string | null {
  // Hook call stays unconditional; only the ARGUMENTS switch, so unarmed
  // bubbles never re-render on the shared tick.
  const armed = typeof expiresAtMs === 'number' && expiresAtMs > 0;
  const now = React.useSyncExternalStore(
    armed ? _subscribeCountdown : _noopSubscribe,
    armed ? _getCountdownSnapshot : _zeroSnapshot,
  );
  if (!expiresAtMs) {return null;}
  const ms = expiresAtMs - now;
  if (ms <= 0) {return '0s';}
  const s = Math.floor(ms / 1000);
  if (s < 60) {return `${s}s`;}
  const m = Math.floor(s / 60);
  if (m < 60) {return `${m}m ${s % 60}s`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ${m % 60}m`;}
  return `${Math.floor(h / 24)}d`;
}

/**
 * Overlapping member-avatar stack for the group chat header. Shows up to
 * 6 colored dots (one per participant, using the deterministic
 * `senderColorFor` palette) with a "+N" pill when there are more.
 */
function GroupMemberStack({participants}: {participants: string[]}) {
  const MAX = 6;
  const shown = participants.slice(0, MAX);
  const overflow = participants.length - shown.length;
  return (
    <View style={styles.memberStackRow}>
      <View style={{flexDirection: 'row'}}>
        {shown.map((uid, i) => (
          <View
            key={uid}
            style={[
              styles.memberDot,
              {backgroundColor: senderColorFor(uid), marginLeft: i === 0 ? 0 : -6},
            ]}
          />
        ))}
      </View>
      <Text style={styles.memberStackText}>
        {overflow > 0 ? `+${overflow}` : `${participants.length} operators`}
      </Text>
      <Icon name="shield-lock-outline" size={10} color={Bravo.signal} />
      <Text style={styles.memberStackE2e}>E2E</Text>
    </View>
  );
}

/**
 * Deterministic accent color used for a sender's callsign label + bubble
 * accent border inside a group. Keyed on userId so each member keeps the
 * same color across the thread.
 */
function senderColorFor(userId: string | null | undefined): string {
  const palette = ['#A78BFA', '#60D394', '#F5B544', '#7FA8FF', '#F472B6', '#34D399', '#FB923C'];
  // Why: a malformed message row (e.g. partial decrypt, restored backup
  // that dropped sender_id) used to crash the whole chat-render here
  // with `Cannot read property 'length' of undefined`. Fall back to a
  // stable default color so the bubble still paints.
  if (!userId) {return palette[0];}
  let h = 0;
  for (let i = 0; i < userId.length; i++) {h = (h * 31 + userId.charCodeAt(i)) >>> 0;}
  return palette[h % palette.length];
}

/**
 * Group-chat sender label. In direct chats the peer's name is already in
 * the header, so callers skip this. In groups we resolve via the dev
 * contacts roster (stable userId → name) and fall back to the header
 * name then a short userId stub.
 */
function resolveSenderName(senderId: string | null | undefined, _fallback: string): string {
  // Why: same hardening as senderColorFor — a missing sender_id used to
  // crash with `Cannot read property 'slice' of undefined`. Show a
  // generic placeholder instead of letting the chat-render explode.
  if (!senderId) {return '???';}
  // 1) Hardcoded dev contacts.
  const dev = DEV_CONTACTS.find(c => c.userId === senderId);
  if (dev) {return dev.name;}
  // 2) Any 1:1 conversation we already have with this user — its
  //    `name` was populated from contact discovery, so it's the user's
  //    real display name.
  const directConvo = useMessengerStore.getState().conversations[`direct:${senderId}`];
  if (directConvo?.name && directConvo.name !== 'self') {
    return directConvo.name;
  }
  // 3) The previous version fell back to `fallback` (the GROUP's name),
  //    which made every member's bubble show the group name instead of
  //    their own. We deliberately ignore `_fallback` here — better to
  //    show a short id than a misleading group label.
  return senderId.slice(0, 8);
}

/**
 * Media-parity — WhatsApp-style sub-label for playable/file rows:
 * "0:42" for audio/video with a known duration, "1.2 MB" for documents.
 * Null when the envelope carried no metadata (legacy senders).
 */
function mediaSubLabel(
  meta: LocalMessage['media_meta'],
  playable: boolean,
): string | null {
  if (!meta) {return null;}
  if (playable && typeof meta.durationMs === 'number' && meta.durationMs > 0) {
    const total = Math.round(meta.durationMs / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  if (typeof meta.sizeBytes === 'number' && meta.sizeBytes > 0) {
    const kb = meta.sizeBytes / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
  }
  return null;
}

function statusToIcon(status: LocalMessage['status']): {name: 'check' | 'check-all' | 'alert-circle' | 'progress-clock'; color: string} | null {
  // Send-state ticks use the brand kit tokens. Sent/delivered are muted
  // (Bravo.textMute) so they sit unobtrusively under the bubble; read
  // jumps to Bravo.glow (#7ED6FF) — same cyan as the verified shield
  // and reply accent — to draw the eye when the recipient confirms.
  switch (status) {
    case 'sending':   return {name: 'progress-clock', color: Bravo.textMute};
    case 'sent':      return {name: 'check',          color: Bravo.textMute};
    case 'delivered': return {name: 'check-all',      color: Bravo.textMute};
    case 'read':      return {name: 'check-all',      color: Bravo.glow};
    case 'failed':    return {name: 'alert-circle',   color: Bravo.alert};
    // Recipient's device destroyed the envelope (decrypt failure) — the
    // message was NOT delivered; single gray tick would be a lie.
    case 'undelivered': return {name: 'alert-circle', color: Bravo.alert};
    default: return null;
  }
}

/**
 * Map the presence record (populated by the socket.io presence fan-out)
 * to the dot state. Round 7 / presence audit fix #7 — the server emits
 * the full 4-state ladder (online/active/away/offline); we now preserve
 * it and surface `away` peers as amber rather than the previous green
 * (which made backgrounded peers look like they were online).
 */
function headerDotState(
  rec: {state?: 'online' | 'active' | 'away' | 'offline'; online: boolean} | undefined,
): OnlineDotState {
  if (!rec) {return 'offline';}
  if (rec.state) {return rec.state;}
  // Back-compat for any record that predates the wider slice.
  return rec.online ? 'online' : 'offline';
}

// presenceTone + presenceLabel were inline helpers used by the old
// dot+text presence row; removed when we switched to PeerPresencePill.

/**
 * Forward picker list — excludes the current conversation so you can't
 * silently loop a message back to itself. Pressing a row fires the
 * handler; caller closes the modal.
 */
function ForwardList({currentConvId, onPick}: {currentConvId: string; onPick: (id: string) => void}) {
  const conversations     = useMessengerStore(s => s.conversations);
  const conversationOrder = useMessengerStore(s => s.conversationOrder);
  const rows = conversationOrder
    .map(id => conversations[id])
    .filter(c => c && c.id !== currentConvId);
  if (rows.length === 0) {
    return (
      <View style={{paddingVertical: 24, alignItems: 'center'}}>
        <Text style={{color:'#B8C7E0', fontSize:12}}>No other chats to forward to.</Text>
      </View>
    );
  }
  return (
    <ScrollView style={{maxHeight: 360}}>
      {rows.map(c => (
        <TouchableOpacity key={c.id}
          style={{flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:10}}
          activeOpacity={0.7}
          onPress={() => onPick(c.id)}>
          <View style={{width:36, height:36, borderRadius:18, backgroundColor:'#166ED1', alignItems:'center', justifyContent:'center'}}>
            <Text style={{color:'#FFF', fontWeight:'800', fontSize:11}}>{((c.name ?? c.peer?.userId ?? c.id ?? '?')).slice(0,2).toUpperCase()}</Text>
          </View>
          <View style={{flex:1}}>
            <Text style={{color:'#FFFFFF', fontSize:13, fontWeight:'700'}} numberOfLines={1}>{c.name ?? c.peer?.userId ?? c.id ?? '—'}</Text>
            <Text style={{color:'#7E8AA6', fontSize:10}} numberOfLines={1}>{c.last_message?.content ?? 'No messages yet'}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

/**
 * Build a short plaintext preview for the reply strip. Caps at 200
 * chars, collapses newlines, and falls back to a type icon label for
 * non-text messages so the recipient still sees context.
 */
function previewForReply(msg: LocalMessage): string {
  if (msg.type === 'image') {return '📷 Photo';}
  if (msg.type === 'file')  {return '📎 Attachment';}
  const s = (msg.content ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 197) + '…' : s;
}

function initials(name?: string): string {
  // N-07 — a notification-tap deep-link could omit `name`; `undefined.split`
  // threw a render-time TypeError caught by the screen boundary ("Chat hit an
  // error"). Guard so a missing name degrades to '?' instead of crashing.
  if (!name) {return '?';}
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map(s => s[0] ?? '')
    .join('')
    .toUpperCase() || '?';
}

// sameDay/formatDaySep moved to chatListItems.ts (MX-05) — the day
// interleave is built there so it stays unit-testable.

function formatCallDuration(seconds: number): string {
  if (seconds <= 0) {return '';}
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) {return `${s}s`;}
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function CallRecordRow({msg, onPress, peerName}: {
  msg: LocalMessage;
  onPress: () => void;
  peerName: string;
}) {
  const meta = msg.call_meta!;
  const isGroupCall = meta.groupCall === true;
  const time = new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  // Direction line — "You → Papai" for outgoing, "Papai → You" for
  // incoming. Mirrors WhatsApp's call-log row + makes the chat record
  // self-explanatory even without the icon. For group calls we show
  // "You" → "<group name>" because there's no single peer.
  const fromLabel = meta.direction === 'outgoing' ? 'You'      : peerName;
  const toLabel   = meta.direction === 'outgoing' ? peerName    : 'You';
  // Icon + tint encode direction × outcome at a glance:
  //   answered outgoing → phone-outgoing (green)
  //   answered incoming → phone-incoming (green)
  //   missed   incoming → phone-missed   (red)
  //   declined incoming → phone-cancel   (slate) — you tapped Decline
  //   declined outgoing → phone-cancel   (slate) — peer hung up
  //   failed             → phone-alert   (amber)
  const {icon, tint} = (() => {
    if (meta.outcome === 'failed')        {return {icon: 'phone-alert',     tint: '#F59E0B'};}
    if (meta.outcome === 'missed')        {return {icon: 'phone-missed',    tint: '#EF4444'};}
    if (meta.outcome === 'declined')      {return {icon: 'phone-cancel',    tint: '#94A3B8'};}
    if (meta.outcome === 'ended-by-host') {return {icon: 'phone-hangup',    tint: '#94A3B8'};}
    return meta.direction === 'outgoing'
      ? {icon: 'phone-outgoing', tint: '#10B981'}
      : {icon: 'phone-incoming', tint: '#10B981'};
  })();
  const label = (() => {
    const prefix = isGroupCall ? 'Group ' : '';
    if (meta.outcome === 'missed')        {return meta.kind === 'video' ? `Missed ${prefix.toLowerCase()}video call` : `Missed ${prefix.toLowerCase()}voice call`;}
    if (meta.outcome === 'declined')      {return meta.kind === 'video' ? `${prefix}Video call declined` : `${prefix}Voice call declined`;}
    if (meta.outcome === 'failed')        {return `${prefix}Call failed`;}
    if (meta.outcome === 'ended-by-host') {return `${prefix.trim() || 'Call'} ended by host`;}
    return meta.kind === 'video' ? `${prefix}Video call` : `${prefix}Voice call`;
  })();
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      style={[styles.callRow, meta.outcome === 'missed' && styles.callRowMissed]}>
      <View style={[styles.callIconWrap, {borderColor: tint, backgroundColor: `${tint}14`}]}>
        <Icon name={icon as React.ComponentProps<typeof Icon>['name']} size={20} color={tint} />
      </View>
      <View style={{flex: 1}}>
        <Text style={styles.callRowLabel}>{label}</Text>
        <View style={styles.callRowDirection}>
          <Text style={styles.callRowDirectionText}>{fromLabel}</Text>
          <Icon name="arrow-right" size={12} color={DM.textMute} />
          <Text style={styles.callRowDirectionText}>{toLabel}</Text>
        </View>
        <Text style={styles.callRowMeta}>
          {time}
          {/* B-59 defence-in-depth: an ANSWERED call always renders a
              duration (0:00 when it connected but logged zero seconds)
              rather than suppressing the slot — a blank length can't then
              be confused with the timestamp. Missed/declined/failed rows
              never connected, so they keep no duration. */}
          {meta.outcome !== 'missed' && meta.outcome !== 'declined' && meta.outcome !== 'failed'
            && ` · ${meta.duration > 0 ? formatCallDuration(meta.duration) : '0:00'}`}
        </Text>
      </View>
      <View style={styles.callBackBtn}>
        <Icon
          name={isGroupCall
            ? (meta.kind === 'video' ? 'video-account' : 'account-multiple')
            : (meta.kind === 'video' ? 'video-outline' : 'phone-outline')}
          size={17}
          color={DM.onAccent}
        />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor: CHAT_BG},
  flex: {flex:1},

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: Bravo.hair,
  },
  headerLeft: {flexDirection:'row', alignItems:'center', gap:8},
  backBtn: {
    width: 36, height: 36, borderRadius: 12,
    backgroundColor: DM.glassFill,
    borderWidth: 1, borderColor: DM.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  contactInfo: {flexDirection:'row', alignItems:'center', gap: 12, flex: 1, minWidth: 0},
  avatarWrap: {position:'relative'},
  // Premium double-ring avatar treatment from Bravo Chat Premium —
  // solid bg ring + outer cyan-glow ring against the navy header.
  avatarGlowOuter: {
    padding: 1,
    borderRadius: 999,
    backgroundColor: Bravo.glowSoft,
  },
  avatarGlowInner: {
    padding: 2,
    borderRadius: 999,
    backgroundColor: CHAT_BG,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#7C3AED',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: {fontFamily: BravoFont.display, color: '#FFF', fontSize: 14, fontWeight: '700'},
  // Cyan-shadowed online dot — matches premium "● Online · last seen now" cue.
  onlineDot: {
    position:'absolute', bottom:0, right:0, width:11, height:11, borderRadius:5.5,
    backgroundColor: Bravo.signal, borderWidth:2, borderColor: CHAT_BG,
    shadowColor: Bravo.signal, shadowOpacity: 0.85, shadowRadius: 4, shadowOffset: {width:0, height:0},
    elevation: 4,
  },
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  contactName: {fontFamily: BravoFont.display, color: Bravo.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, flexShrink: 1},
  handleBadge: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase'},
  onlineStatus: {color: Bravo.signal, fontSize: 10, fontWeight: '700', letterSpacing: 1.6},
  // Last-seen / presence row — sits below the contact name. Premium
  // treatment: 6px dot with a subtle glow halo + sentence-case
  // text in textDim (not muted) so "Online" / "Last seen 5m ago"
  // reads as primary metadata, not buried fine print.
  presenceRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, flexShrink: 1, minWidth: 0},
  presenceDot: {
    width: 7, height: 7, borderRadius: 3.5,
    shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.7, shadowRadius: 4,
    elevation: 3,
  },
  presenceText: {fontFamily: BravoFont.medium, color: Bravo.textDim, fontSize: 11, fontWeight: '500', letterSpacing: 0.1},
  headerActions: {flexDirection: 'row', gap: 8, flexShrink: 0},
  // Header voice/video pills — premium uses a soft glow-tinted fill
  // with a 1px ring, color-matched to the cyan accent so the whole
  // header reads as one cohesive system rather than the previous
  // muted gray buttons.
  iconBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: DM.glassFill,
    borderWidth: 1, borderColor: DM.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  bannersStack: {paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8, gap: 6},
  e2eBanner: {flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, paddingVertical:8, borderBottomWidth:1, borderBottomColor:'#1C3B66'},
  e2eText: {color:'#4ade80', fontSize:10, fontWeight:'800', letterSpacing:2},

  devBanner: {flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6, paddingVertical:6, paddingHorizontal:12, backgroundColor:'rgba(251, 191, 36, 0.08)', borderBottomWidth:1, borderBottomColor:'rgba(251, 191, 36, 0.25)'},
  devBannerError: {backgroundColor:'rgba(248, 113, 113, 0.1)', borderBottomColor:'rgba(248, 113, 113, 0.3)'},
  devBannerHidden: {height:0, paddingVertical:0, borderBottomWidth:0, overflow:'hidden'},
  devBannerText: {color:'#fbbf24', fontSize:10, fontWeight:'700', letterSpacing:1, flexShrink:1},

  msgList: {flex:1},
  // Inverted list: coordinate paddingBottom = VISUAL TOP (below the
  // header); the visual-bottom gap comes from the ListHeaderComponent
  // spacer. flexGrow keeps short threads hugging the composer.
  msgContent: {paddingHorizontal:16, paddingBottom:16, flexGrow:1},
  dateSep: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 16, marginTop: 4},
  dateLine: {flex: 1, height: 1, backgroundColor: Bravo.hair},
  dateText: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 9.5, letterSpacing: 1.3, textTransform: 'uppercase'},
  // Unread "N UNREAD MESSAGES" divider — accent-tinted line + pill so
  // the user's eye lands where they left off. Anchored once, never
  // re-positions while the chat is open.
  unreadSep: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 10, marginTop: 4},
  unreadLine: {flex: 1, height: 1, backgroundColor: 'rgba(91,141,239,0.35)'},
  unreadPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99,
    backgroundColor: 'rgba(91,141,239,0.12)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  unreadPillText: {
    fontFamily: BravoFont.mono, color: DM.accent,
    fontSize: 9.5, letterSpacing: 1.4, fontWeight: '700',
  },
  // Failed-send retry pill — only renders when status === 'failed'.
  // Larger hit target than a bare 15-dp icon; flush against the meta
  // row so it doesn't break the bubble layout.
  retryChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99,
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)',
  },
  retryChipText: {
    fontFamily: BravoFont.mono, color: Bravo.alert,
    fontSize: 9.5, letterSpacing: 1, fontWeight: '700',
    textTransform: 'uppercase',
  },

  emptyWrap: {alignItems:'center', paddingVertical:40, gap:8},
  emptyText: {color:'#7E8AA6', fontSize:12, fontWeight:'700', letterSpacing:1, textTransform:'uppercase'},
  emptyHint: {color:'#7E8AA6', fontSize:11, textAlign:'center', maxWidth:280, lineHeight:16},

  msgWrap: {alignItems:'flex-start', marginBottom:12, maxWidth:'78%', minWidth:68},
  msgWrapSent: {alignSelf:'flex-end', alignItems:'flex-end'},
  // Inside a run of consecutive same-sender bubbles: keep them visually
  // tight (small gap) but do NOT use a negative top margin — that was
  // pulling adjacent bubbles into each other and clipping the rounded
  // corners on stacked runs (user-reported "bubbles stuck together").
  msgWrapGrouped: {marginTop:2, marginBottom:4},
  // Reply-jump highlight ring. Absolutely positioned UNDER the bubble on
  // its own node (see the crash note where it's rendered) with negative
  // insets so the cobalt tint reads as a glow ring around the message.
  pulseHalo: {position:'absolute', top:-4, bottom:-4, left:-8, right:-8, borderRadius:26},
  // `minHeight` + `justifyContent:'center'` were vertically clipping
  // multi-line text on narrow phones because `minHeight` was treated
  // as a fixed centre-anchored box. Drop both — RN auto-sizes height
  // from content, and the meta row sits OUTSIDE the bubble anyway.
  bubble: {borderRadius: 22, paddingHorizontal: 16, paddingVertical: 11},
  // Premium me-bubble: 22 / 6 corners (softer, more WhatsApp-like),
  // action-blue fill with a layered glow shadow. The shadow opacity
  // was bumped from 0.45 → 0.5 and offset Y nudged to 8 to make the
  // bubble feel "lit from below" against the deep-navy backdrop.
  sentBubble: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 22, borderBottomRightRadius: 6,
    // Solid cobalt base under the gradient underlay: keeps the iOS glow
    // shadow (needs an opaque backing) and is the fallback if the gradient
    // fails to mount. The LinearGradient child paints over it.
    backgroundColor: DM.accentDeep,
    shadowColor: DM.accent, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: {width: 0, height: 8},
    elevation: 5,
  },
  sentBubbleRunMid:  {borderTopRightRadius: 6, borderBottomRightRadius: 6},
  sentBubbleRunTail: {borderTopRightRadius: 6},
  // Premium them-bubble: surface-2 navy with a 1px hairline border
  // and a subtle shadow so it doesn't feel flat next to the glowing
  // sent bubble. Symmetrical 22 / 6 to match the sent variant.
  recvBubble: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 6, borderBottomRightRadius: 22,
    // Obsidian receive bubble with a white hairline (Bravo DM Attach).
    backgroundColor: DM.recvBubble,
    borderWidth: 1, borderColor: DM.hair2,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  recvBubbleRunMid:  {borderTopLeftRadius: 6, borderBottomLeftRadius: 6},
  recvBubbleRunTail: {borderTopLeftRadius: 6},
  msgText: {fontFamily: BravoFont.sans, color: Bravo.text, fontSize: 14.5, lineHeight: 20.5, letterSpacing: -0.1},
  groupSender: {fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4, marginLeft: 4, color: DM.onAccent},
  memberStackRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  memberDot: {width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: CHAT_BG},
  memberStackText: {fontFamily: BravoFont.mono, fontSize: 10, color: Bravo.textMute, letterSpacing: 0.4, marginLeft: 2},
  memberStackE2e: {fontFamily: BravoFont.mono, fontSize: 10, color: Bravo.signal, fontWeight: '700', letterSpacing: 0.6},
  // Meta row sits OUTSIDE the bubble — small timestamp + ack ticks.
  // Uses textMute (token) instead of an rgba opacity trick so the
  // hierarchy is consistent with the rest of the app.
  msgMeta: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, alignSelf: 'flex-end', paddingHorizontal: 6},
  msgMetaIn: {alignSelf: 'flex-start'},
  msgTime: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 10, letterSpacing: 0.4, fontVariant: ['tabular-nums']},
  msgFingerprint: {fontFamily: BravoFont.mono, color: Bravo.textFaint, fontSize: 8.5, letterSpacing: 0.5},
  // Self-destruct accent — uses Bravo.amber (warning token) instead
  // of off-palette orange so it slots into the system color scheme.
  selfDestructBubble: {borderLeftWidth: 2, borderLeftColor: Bravo.amber},
  timerBadge: {flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 4},
  timerText: {fontFamily: BravoFont.semiBold, color: Bravo.amber, fontSize: 10, fontWeight: '700'},

  // Premium call-record card — surface-2 navy with hairline border
  // and a soft drop-shadow, matching the bubble depth treatment.
  // Centered between bubbles, comfortable padding for the icon +
  // 3-line content (label, direction, duration).
  callRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    alignSelf: 'stretch',
    marginHorizontal: 8, marginVertical: 8,
    paddingVertical: 14, paddingHorizontal: 15,
    borderRadius: 18,
    backgroundColor: DM.recvBubble,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.14)',
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  callRowMissed: {borderColor: 'rgba(255,93,93,0.16)'},
  callIconWrap: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  callRowLabel: {fontFamily: BravoFont.display, color: DM.text, fontSize: 15, fontWeight: '700', letterSpacing: -0.2},
  callRowDirection: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3},
  callRowDirectionText: {fontFamily: BravoFont.sans, color: DM.textMute, fontSize: 12.5, fontWeight: '500'},
  callRowMeta:  {fontFamily: BravoFont.mono, color: DM.textFaint, fontSize: 11, marginTop: 3, letterSpacing: 0.3},
  // Round cobalt call-back button on the trailing edge of the call card.
  callBackBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: DM.accentTint, borderWidth: 1, borderColor: DM.accentEdge,
  },

  inputBar: {flexDirection:'row', alignItems:'center', gap:9, paddingHorizontal:16, paddingTop:10, backgroundColor:CHAT_BG, borderTopWidth:1, borderTopColor: DM.hair2},
  inputIconBtn: {width:36, height:36, alignItems:'center', justifyContent:'center'},
  inputIconBtnActive: {backgroundColor:'rgba(251, 146, 60, 0.1)', borderRadius:18},
  ttlBadge: {position:'absolute', bottom:2, color:'#fb923c', fontSize:9, fontWeight:'700'},
  // Round cobalt-tinted "+" attach affordance (Bravo DM Attach).
  attachBtn: {width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center', backgroundColor: DM.accentTint, borderWidth:1, borderColor: DM.accentEdge},
  // Composer dock pill — glass fill on obsidian, white hairline, 23px radius.
  inputWrap: {flex:1, flexDirection:'row', alignItems:'center', backgroundColor: DM.glassFill, borderRadius:99, paddingHorizontal:14, paddingVertical:8, borderWidth:1, borderColor: DM.hair2, gap:8},
  input: {flex:1, color:'#FFFFFF', fontSize:13, maxHeight:100, padding:0},
  // Primary actions (send + mic) share one cobalt-gradient hero treatment so
  // the in-place swap on typing reads as one continuous button, not a
  // gradient→flat downgrade. Opaque cobalt base keeps the iOS glow shadow.
  sendBtn: {width:38, height:38, borderRadius:19, alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'rgba(255,255,255,0.22)', backgroundColor: DM.accentDeep, shadowColor: DM.accent, shadowOffset:{width:0,height:4}, shadowOpacity:0.55, shadowRadius:12, elevation:6},
  micBtn:  {width:38, height:38, borderRadius:19, alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'rgba(255,255,255,0.22)', backgroundColor: DM.accentDeep, shadowColor: DM.accent, shadowOffset:{width:0,height:4}, shadowOpacity:0.55, shadowRadius:12, elevation:6},
  micGradient: {borderRadius:19},
  // Disabled mic — slate fill + crossed-out icon so it reads as
  // "feature not yet shipped" rather than "tap to record".
  micBtnDisabled: {
    backgroundColor: 'rgba(71,85,105,0.25)',
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 1, borderColor: 'rgba(71,85,105,0.45)',
  },

  // Bubble inner + reply + reactions
  bubbleInner: {flexShrink: 1},
  // Premium "stitched" reply quote — translucent box that visually
  // fuses with the parent bubble (negative bottom margin). The
  // received variant uses a deeper navy + cyan accent bar; the sent
  // variant uses a white-tinted overlay + white accent bar so it
  // reads as "contained within" the blue bubble instead of looking
  // like a foreign element.
  // Quoted-reply preview inside a bubble (Bravo DM Attach "QuoteInBubble").
  // Tapping it jumps to + pulses the original message. A cobalt left bar +
  // tinted fill on the received side; a white-on-cobalt treatment on the
  // sent side so it reads as "contained within" the outgoing gradient.
  replyStrip: {
    flexDirection:'row', alignItems:'stretch',
    paddingHorizontal:10, paddingVertical:7,
    marginBottom: 7, borderRadius:12, overflow:'hidden',
    backgroundColor: DM.accentTint,
    borderLeftWidth: 3, borderLeftColor: DM.quoteBar,
  },
  replyStripSent: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderLeftColor: 'rgba(255, 255, 255, 0.6)',
  },
  replyBody:    {flex:1, minWidth:0},
  replyAuthor:     {fontFamily: BravoFont.semiBold, color: DM.onAccent, fontSize: 11, fontWeight: '700', marginBottom: 1, letterSpacing: 0.1},
  replyAuthorSent: {color: 'rgba(255,255,255,0.9)'},
  replyStripText:  {fontFamily: BravoFont.sans, color: DM.textDim, fontSize: 12.5, lineHeight: 16},
  replyStripTextSent: {color: 'rgba(255, 255, 255, 0.75)'},
  reactionsRow: {flexDirection:'row', gap:4, marginTop:-6, marginHorizontal:6, flexWrap:'wrap'},
  reactionChip: {flexDirection:'row', alignItems:'center', gap:3, paddingHorizontal:8, paddingVertical:4, borderRadius:14, backgroundColor: Bravo.cardSolid, borderWidth:1, borderColor: Bravo.hair},
  reactionChipMine: {backgroundColor: 'rgba(30,136,255,0.22)', borderColor: 'rgba(30,136,255,0.45)'},
  reactionEmoji: {fontSize:12},
  reactionCount: {color: Bravo.textDim, fontSize:10, fontWeight:'700'},

  // Reply preview bar (composer) — sits above the input pill when the
  // user taps "reply" on a message. Premium treatment: surface-2 fill
  // with a thin accent bar on the LEFT and a subtle backdrop tint so
  // it reads as a "scrap" of the original message before you type.
  replyBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8,
    marginHorizontal: 4, marginTop: 4,
    borderLeftWidth: 3, borderLeftColor: DM.quoteBar,
  },
  replyBarBody: {flex:1, minWidth:0},
  replyBarLabel: {fontFamily: BravoFont.semiBold, color: DM.onAccent, fontSize: 12.5, fontWeight: '700', letterSpacing: 0.2},
  replyBarText:  {fontFamily: BravoFont.sans, color: DM.textDim, fontSize: 12.5, marginTop: 2},
  // Round close chip on the composer reply bar.
  replyBarClose: {width:26, height:26, borderRadius:13, alignItems:'center', justifyContent:'center', backgroundColor:'rgba(255,255,255,0.06)'},

  // Scroll-to-bottom FAB
  scrollFab: {position:'absolute', right:12, width:44, height:44, borderRadius:22, backgroundColor:'#162F54', borderWidth:1, borderColor:'#1C3B66', alignItems:'center', justifyContent:'center', shadowColor:'#000', shadowOffset:{width:0,height:4}, shadowOpacity:0.4, shadowRadius:8, elevation:6},
  scrollFabBadge: {position:'absolute', top:-4, right:-4, minWidth:18, height:18, borderRadius:9, paddingHorizontal:4, backgroundColor:Colors.primary, alignItems:'center', justifyContent:'center'},
  scrollFabBadgeText: {color:'#FFF', fontSize:9, fontWeight:'800'},

  // Long-press action sheet
  actionSheet: {paddingBottom: 12},
  actionReactRow: {flexDirection:'row', gap:10, paddingHorizontal:20, paddingVertical:14, justifyContent:'center'},
  actionReactBtn: {width:44, height:44, borderRadius:22, backgroundColor:'#162F54', alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'#1C3B66'},
  actionReactBtnMine: {borderColor:'rgba(37,99,235,0.5)', backgroundColor:'rgba(37,99,235,0.15)'},
  actionReactEmoji: {fontSize:20},
  actionDivider: {height:1, backgroundColor:'#1C3B66', marginHorizontal:16},

  sheetBackdrop: {flex:1, backgroundColor:'rgba(0,0,0,0.55)', justifyContent:'flex-end'},
  sheet: {backgroundColor:'#162F54', borderTopLeftRadius:20, borderTopRightRadius:20, padding:20, borderTopWidth:1, borderColor:'#1C3B66', gap:2},
  sheetTitle: {color:'#FFFFFF', fontSize:16, fontWeight:'700', marginBottom:4},
  sheetSub: {color:'#7E8AA6', fontSize:12, marginBottom:12},
  sheetRow: {flexDirection:'row', alignItems:'center', gap:14, paddingVertical:14, borderBottomWidth:1, borderBottomColor:'rgba(30,136,255,0.08)'},
  sheetRowText: {color:'#FFFFFF', fontSize:15},
  // Visually-disabled attach row: dims the icon + label and surfaces a
  // "Coming soon" subtitle so the user reads the constraint BEFORE
  // tapping (vs. opening a picker that ends in an alert).
  sheetRowDisabled: {opacity: 0.6},
  sheetRowTextDisabled: {color: '#7E8AA6'},
  sheetRowSubtitle: {
    fontFamily: BravoFont.mono, color: '#7E8AA6',
    fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 2,
  },
  sheetCancel: {marginTop:10, paddingVertical:12, alignItems:'center', backgroundColor:'rgba(239,68,68,0.1)', borderRadius:10},
  sheetCancelText: {color:'#fca5a5', fontSize:14, fontWeight:'600'},

  // ── Attach sheet (Bravo DM Attach) — gradient sheet on a scrim with an
  //    encryption badge, rounded-square cobalt row icons + chevrons. ──
  attachSheet: {
    borderTopLeftRadius: 30, borderTopRightRadius: 30,
    paddingHorizontal: 22, paddingTop: 10, paddingBottom: 30,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(255,255,255,0.08)',
  },
  attachHandle: {width: 42, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.16)', alignSelf: 'center', marginBottom: 18},
  attachHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: 6},
  attachTitle: {fontFamily: BravoFont.display, color: DM.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4, flex: 1},
  encBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    backgroundColor: DM.signalTint, borderWidth: 1, borderColor: DM.signalEdge,
  },
  encBadgeText: {fontFamily: BravoFont.mono, color: DM.signal, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase'},
  attachRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 15,
    borderBottomWidth: 1, borderBottomColor: DM.hair,
  },
  attachRowLast: {borderBottomWidth: 0},
  attachRowIcon: {
    width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: DM.accentTint, borderWidth: 1, borderColor: DM.accentEdge,
  },
  attachRowTitle: {fontFamily: BravoFont.display, color: DM.text, fontSize: 16.5, fontWeight: '700', letterSpacing: -0.3},
  attachRowSub: {fontFamily: BravoFont.mono, color: DM.textMute, fontSize: 9.5, fontWeight: '500', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 4},
  attachCancel: {
    height: 52, marginTop: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,93,93,0.08)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.24)',
  },
  attachCancelText: {fontFamily: BravoFont.display, color: '#FF8B8B', fontSize: 15.5, fontWeight: '700'},

  imageBubble: {padding:3, maxWidth:260, overflow:'hidden'},
  msgImage: {width:254, height:254, borderRadius:12, backgroundColor:'#1C3B66'},
  imageBrokenWrap: {alignItems:'center', justifyContent:'center', gap:6},
  imageBrokenText: {color:'#B8C7E0', fontSize:12, fontWeight:'500'},
  fileAttachRow: {flexDirection:'row', alignItems:'center', gap:10, paddingVertical:4, minWidth:200},
  fileAttachIcon: {width:40, height:40, borderRadius:20, backgroundColor:'rgba(30,136,255,0.12)', borderWidth:1, borderColor:'rgba(30,136,255,0.3)', alignItems:'center', justifyContent:'center'},
  fileAttachName: {color:'#E8EEF7', fontSize:14, fontWeight:'600'},
  fileAttachSub: {color:'#9FB0C9', fontSize:11, marginTop:1},
  mediaSendingBar: {flexDirection:'row', alignItems:'center', gap:7, paddingHorizontal:16, paddingVertical:7, backgroundColor:'rgba(30,136,255,0.1)', borderTopWidth:1, borderTopColor:'rgba(30,136,255,0.2)'},
  mediaSendingText: {color:'#9FC2F0', fontSize:12, fontWeight:'600'},
  imageMetaShade: {
    position:'absolute', left:3, right:3, bottom:3, height:40,
    borderBottomLeftRadius:12, borderBottomRightRadius:12,
    backgroundColor:'rgba(0,0,0,0.45)',
  },
  imageMetaRow: {
    position:'absolute', right:10, bottom:10,
    flexDirection:'row', alignItems:'center', gap:6,
  },
  imageMetaTime: {color:'#B8C7E0', fontSize:10, fontWeight:'600'},
  msgMetaOverImage: {paddingHorizontal:6, paddingVertical:4},

  viewerRoot: {flex:1, backgroundColor:'rgba(0,0,0,0.95)', alignItems:'center', justifyContent:'center'},
  viewerImage: {width:Dimensions.get('window').width, height:Dimensions.get('window').height * 0.78},
  viewerClose: {position:'absolute', top:40, right:20, width:40, height:40, borderRadius:20, backgroundColor:'rgba(255,255,255,0.15)', alignItems:'center', justifyContent:'center'},
  viewerActionBar: {position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, backgroundColor: 'rgba(6,20,43,0.85)', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)'},
  viewerAction: {alignItems: 'center', gap: 6, minWidth: 70},
  viewerActionIcon: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(251,191,36,0.1)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.25)'},
  viewerActionText: {fontFamily: BravoFont.sans, color: '#FFF', fontSize: 10, fontWeight: '700', letterSpacing: 0.3},
}));
