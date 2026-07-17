import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, StatusBar, Vibration, TextInput,
  Animated, Image,
  type ListRenderItemInfo,
} from 'react-native';
import {Alert} from '@utils/alert';
import {Swipeable} from 'react-native-gesture-handler';
import {useShallow} from 'zustand/react/shallow';
import {LinearGradient} from 'expo-linear-gradient';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {Colors} from '@theme/index';
import {Bravo, BravoFont} from '@/theme/bravo';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {PremiumBanner} from '@/modules/messenger/ui/PremiumBanner';
import {SponsoredSlot} from '@/modules/messenger/ui/SponsoredSlot';
import {ProfileDrawerModal} from '@components/ProfileDrawerModal';
import {useMessengerStore} from '@/modules/messenger/store';
import type {LocalConversation} from '@/modules/messenger/store';
import {compareConversationsForList} from './conversationListOrder';
import {ConnectionBanner} from '@/modules/messenger/ui/ConnectionBanner';
import NotificationPermissionBanner from '@components/NotificationPermissionBanner';
import NotificationReliabilityCard from '@components/NotificationReliabilityCard';
import {useMessenger} from '@/modules/messenger/hooks';
import {conversationApi, tokenStore, departmentApi} from '@services/api';
import {OnlineDot, type OnlineDotState} from '@/modules/messenger/ui/OnlineDot';
import LoadingView from '@components/LoadingView';
import {useAuthStore} from '@store/authStore';
import {UsersHttpClient} from '@bravo/messenger-core';
import {useDiscoveredContacts} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {useRegisteredNames} from '@/modules/messenger/contacts/useRegisteredNames';
import {drainConversationIntents} from '@/modules/messenger/orgWorkspace/conversationIntents';
import {
  flushRosterIntents, hasPendingRosterIntent, resolveRosterOverwrite,
} from '@/modules/messenger/runtime/pendingRosterIntents';
import {API_BASE_URL, DEPT_CHAT_V2} from '@utils/constants';
import {formatListTimestamp} from '@utils/helpers';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;

// Obsidian base from the Bravo Messenger design tokens (tokens.jsx
// `bg: #07090D`). Matches Command Home — the Messenger list is part of
// the same re-skin. Local constant so we don't mutate the app-wide
// Bravo.bg (which other navy screens still use). VISUAL ONLY — no data
// or backend wiring changes on this screen.
const MSG_BG = '#07090D';

// Module-level keyExtractor so FlatList sees a stable function identity
// across renders. Inline arrows allocate a fresh closure per render and
// defeat FlatList's prop diff.
const chatListKeyExtractor = (c: LocalConversation): string => c.id;

export default function MessengerHomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();

  // Why: M-18 — useShallow so a store commit that leaves every conversation
  // entry identical doesn't re-render Home. The whole-map `presence` and
  // `messages` subscriptions are gone: presence is per-row (RowOnlineDot)
  // and search reads messages via getState() at filter time.
  const conversations     = useMessengerStore(useShallow(s => s.conversations));
  const conversationOrder = useMessengerStore(s => s.conversationOrder);
  const connectionState   = useMessengerStore(s => s.connection);
  // B-46 — destroyed-envelope banner count (session-scoped).
  const undecryptableDrops = useMessengerStore(s => s.undecryptableDropCount);
  const setMuted          = useMessengerStore(s => s.setConversationMuted);
  const setPinned         = useMessengerStore(s => s.setConversationPinned);
  const removeConversation = useMessengerStore(s => s.removeConversation);
  const {runtime}         = useMessenger();
  const ownPhoneE164      = useAuthStore(s => s.user?.phone_e164 ?? null);
  // B-91 M1 R9 — profile drawer (account rows + Switch Dashboard).
  const user = useAuthStore(s => s.user);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const userInitials = (user?.full_name ?? user?.email ?? 'B')
    .split(/[\s@.]/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'B';

  // WhatsApp-style background contact sync. Mounted in PASSIVE mode so
  // the system permission prompt never fires from Home — only foreground
  // surfaces (NewChatScreen) should ever ask. When the user has already
  // granted contacts permission via the New Message flow, this hook
  // silently re-pairs the address book with the directory and patches
  // any auto-created direct conversation rows whose `name` is still the
  // 8-char userId placeholder ("abc12345") with the user's saved
  // contact label ("Alice"). Without this, a peer who messages us
  // BEFORE we ever opened New Message lands as an unrecognisable UUID
  // row in the chat list — exactly the "I have to enter manually"
  // symptom users hit.
  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );
  useDiscoveredContacts({
    users:        usersClient,
    ownPhoneE164,
    enabled:      true,
    passive:      true,
  });
  // B-79 — resolve the peer's REGISTERED Bravo name for any direct chat still on
  // the `Bravo · <hex>` placeholder (peers NOT in the address book). Runs after
  // useDiscoveredContacts so a saved contact name still wins.
  useRegisteredNames({users: usersClient, enabled: true});
  // Track the currently-open Swipeable so opening a second row closes
  // the first — matches iOS behaviour and prevents multiple rows
  // sitting half-open at once.
  const openSwipeRef = useRef<Swipeable | null>(null);
  // Fix #35: hoist the per-row Swipeable refs into a Map keyed by
  // conversation id. Previously each row's `swipeRef` was created
  // inside `.map()` as a fresh `{current: null}` object on every
  // re-render — the ref binding was effectively useless because each
  // render replaced it before the user could open a swipe, and
  // `closeAnd` couldn't find the open Swipeable to close it. The Map
  // gives us stable identity across renders so the close-others
  // behaviour actually works.
  const swipeableMapRef = useRef<Map<string, Swipeable>>(new Map());

  // Track whether the persist middleware has finished restoring conversations
  // from AsyncStorage. Without this we flash the "No conversations yet" empty
  // state for ~50-200ms on cold boot even when history exists.
  const [hydrated, setHydrated] = useState(() => useMessengerStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) {return;}
    const unsub = useMessengerStore.persist.onFinishHydration(() => setHydrated(true));
    // Safety — if we mounted after hydration finished, flip immediately.
    if (useMessengerStore.persist.hasHydrated()) {setHydrated(true);}
    return unsub;
  }, [hydrated]);

  // Sync conversations from the server. Without this, the local store only
  // ever holds rooms created on this device, so server-created threads
  // (mission groups, system DMs) never appear. Runs once on mount and any
  // time the runtime ready flag flips.
  //
  // ALSO prunes server-issued conversations the user is no longer a member
  // of — when ops completes a mission, the agent's `conversation_members`
  // row is removed (per ops.service.ts:completeBooking), so the mission
  // group stops appearing in /conversations/mine. Without the prune step
  // the agent's local store kept the row forever and the chat stayed
  // visible from cache. We restrict the prune to UUID-shaped ids so any
  // local-only drafts (non-UUID temp ids) survive a sync round-trip.
  useEffect(() => {
    if (!hydrated || !runtime) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const ownId = useMessengerStore.getState()._ownUserId;
        // P1-5 / P1-6 — push any locally-applied roster changes whose server
        // write failed earlier BEFORE pulling, so a successful flush means the
        // roster we pull below is already correct. Whatever stays pending is
        // consulted by the sync guard so the stale server roster can't undo a
        // local crypto add/remove/leave.
        await flushRosterIntents(ownId ?? undefined).catch(() => {});
        if (cancelled) {return;}
        const {data} = await conversationApi.listMine();
        if (cancelled) {return;}
        const upsert = useMessengerStore.getState().upsertConversation;
        const serverIds = new Set<string>();
        for (const c of data.conversations) {
          serverIds.add(c.id);
          const serverMemberIds = c.members.map(m => m.userId);
          const existing = useMessengerStore.getState().conversations[c.id];
          // P1-5 / P1-6 sync guard — while a roster write is pending for this
          // conversation the local participants are authoritative (the crypto
          // change already applied). Preserve them, or skip re-creating a group
          // we just left whose self-removal hasn't landed server-side yet.
          const guard = resolveRosterOverwrite({
            hasPending:           hasPendingRosterIntent(c.id),
            existingParticipants: existing?.participants,
            serverParticipants:   serverMemberIds,
          });
          if (guard.skip) {continue;}
          const participants = guard.participants;
          const others = participants.filter(uid => uid !== ownId);
          const peerUid = others[0] ?? c.members[0]?.userId ?? '';
          // Merge the server's authoritative member list into the local
          // row (unless the sync guard above kept the local participants).
          // The previous behaviour ("skip if existing") preserved unread
          // counters but also preserved STALE participants from earlier test
          // runs (e.g. Bob's userId from a prior dispatch), which then drove
          // sendText fan-out to encrypt to the wrong peer. Now: keep local-only
          // fields (unread, mute, pin, ttl) but overwrite the membership +
          // type from the server.
          upsert({
            id: c.id,
            type: c.kind,
            name: existing?.name ?? c.title ?? (c.kind === 'direct'
              ? (c.members.find(m => m.userId !== ownId)?.displayName ?? 'Direct chat')
              : 'Group'),
            participants,
            unread_count: existing?.unread_count ?? 0,
            is_muted:     existing?.is_muted     ?? false,
            is_pinned:    existing?.is_pinned    ?? false,
            default_ttl_sec: existing?.default_ttl_sec ?? null,
            created_at:   existing?.created_at   ?? c.createdAt,
            peer: existing?.peer?.userId
              ? existing.peer
              : {userId: peerUid, deviceId: 1},
            session_state: existing?.session_state ?? 'fresh',
            last_message: existing?.last_message,
          });
        }
        // Prune local conversations the server no longer returns. Only
        // touch UUID-shaped ids so non-server local-only drafts survive.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const localIds = Object.keys(useMessengerStore.getState().conversations);
        for (const localId of localIds) {
          if (UUID_RE.test(localId) && !serverIds.has(localId)) {
            useMessengerStore.getState().removeConversation(localId);
          }
        }
      } catch { /* transient — try again on next mount */ }
    })();
    return () => { cancelled = true; };
  }, [hydrated, runtime]);

  // RS-02 — drain pending conversation membership intents this device
  // administers: a server-side add/remove only wrote metadata; the actual
  // group rekey (planAddAndRekey / planRemoveAndRekey) happens here, on an
  // admin device. Fire-and-forget; the drain coalesces concurrent calls and
  // leaves intents it cannot act on pending for the right device.
  useEffect(() => {
    if (!hydrated || !runtime) {return;}
    void drainConversationIntents().catch(() => {});
  }, [hydrated, runtime]);

  const [query, setQuery] = useState('');
  // Fix #36: debounce the actual search input. Without this, every
  // keystroke ran the filter — for a 100-conversation list with the
  // last 30 messages each, that's ~3000 string ops per keystroke.
  // 150 ms swallows the burst (typical typing cadence is 100-200 ms
  // between strokes) so we filter once per word, not once per letter.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  // Hide departmental-channel groups from the Messenger list. A dept channel is an internal E2EE
  // Signal group whose conversation lives in the same store, but it must only appear in the
  // Departmental module's Channels tab — never here. Exclude any conversation whose id is a dept
  // channel's group_conversation_id (the server-authoritative set). Flag-gated; a non-dept user's
  // listChannels 403s → empty set → nothing filtered.
  const [deptGroupIds, setDeptGroupIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!DEPT_CHAT_V2) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await departmentApi.listChannels();
        if (!cancelled) {
          setDeptGroupIds(new Set(data.channels.map(c => c.group_conversation_id).filter((x): x is string => !!x)));
        }
      } catch { /* not a dept member / flag off — leave the set empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const ordered = useMemo<LocalConversation[]>(
    () => conversationOrder
      .map(id => conversations[id])
      .filter((c): c is LocalConversation => !!c && !deptGroupIds.has(c.id))
      // B-78 — sort by real last-message time (pinned first) rather than trust
      // conversationOrder's move-to-front order, which a bulk restore scrambles.
      .sort(compareConversationsForList),
    [conversationOrder, conversations, deptGroupIds],
  );

  // Fix #36 (cont.): cache each conversation's searchable haystack so
  // we don't rebuild it on every filter pass. Keyed by conversation
  // id; the cache key includes a coarse signature (name + last
  // message id + message count) so it invalidates only when something
  // search-relevant changes. Per-conversation entries also cache the
  // toLocaleLowerCase() result so the case-fold is paid once.
  const searchableCacheRef = useRef<Map<string, {sig: string; hay: string}>>(new Map());
  const searchableFor = (c: LocalConversation): string => {
    // Why: M-18 — read messages via getState() instead of subscribing;
    // subscribing re-rendered Home on every append in ANY conversation
    // while search only needs fresh data at (debounced) filter time.
    const msgs = useMessengerStore.getState().messages[c.id] ?? [];
    // Cheap signature — name + peer + count + last id. Excludes
    // message bodies so message edits to old messages don't reflect
    // until the count changes; this is a deliberate trade for speed.
    const sig = [
      c.name ?? '',
      c.peer?.userId ?? '',
      String(msgs.length),
      msgs[msgs.length - 1]?.id ?? '',
      c.last_message?.id ?? '',
    ].join('|');
    const cached = searchableCacheRef.current.get(c.id);
    if (cached && cached.sig === sig) {return cached.hay;}
    const hay = [
      c.name ?? '',
      c.peer?.userId ?? '',
      c.last_message?.content ?? '',
      ...msgs.slice(-30).map(m => m.content ?? ''),
    ].join(' ').toLocaleLowerCase();
    searchableCacheRef.current.set(c.id, {sig, hay});
    return hay;
  };

  /**
   * Filter by name / phone / most recent message content. Case- and
   * diacritic-blind via toLocaleLowerCase so "Jóse" matches "jose".
   * Empty query short-circuits to the full list.
   */
  const filtered = useMemo<LocalConversation[]>(() => {
    const q = debouncedQuery.trim().toLocaleLowerCase();
    if (!q) {return ordered;}
    return ordered.filter(c => searchableFor(c).includes(q));
    // searchableFor reads messages via getState() (deliberately not a
    // subscription); ordered + debouncedQuery are the user-visible
    // inputs that matter.
  }, [ordered, debouncedQuery]);

  // Subscribe to presence for every direct-chat peer so the row avatars
  // carry a live online dot. Bulk subscribe on mount + whenever the
  // conversation list changes; unsubscribe on unmount so the server
  // doesn't keep fanning out updates for chats we're not showing.
  // Fix #34: derive a STRING `peerIdsKey` (sorted, joined). The
  // subscribe effect re-fires only when the string changes — so a
  // reorder of `ordered` (e.g. unread bump moving a chat to the top)
  // doesn't re-subscribe to a presence list that's identical
  // member-wise. We also keep a ref to the current key so we can
  // bail inside the effect if the deps fired but the actual content
  // didn't change.
  const peerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of ordered) {
      if (c.type === 'direct' && c.peer?.userId) {ids.add(c.peer.userId);}
    }
    return Array.from(ids).sort();
  }, [ordered]);
  const peerIdsKey = peerIds.join('|');
  const lastSubscribedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runtime || peerIds.length === 0) {return;}
    if (lastSubscribedKeyRef.current === peerIdsKey) {return;}
    lastSubscribedKeyRef.current = peerIdsKey;
    runtime.subscribePresence(peerIds);
    const idsForCleanup = peerIds;
    return () => {
      try { runtime.unsubscribePresence(idsForCleanup); } catch { /* ignore */ }
      lastSubscribedKeyRef.current = null;
    };
    // peerIds array identity is intentionally not in deps — the
    // string key is the cheap stable signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, peerIdsKey]);

  const goChat  = useCallback((id: string, name: string, isGroup = false) =>
    navigation.navigate('Chat', {conversationId: id, name, isGroup}),
    [navigation],
  );

  // Stable per-row callbacks. Each row receives the conversation id and
  // calls back here; that way the row component itself doesn't close
  // over `c` and can be memoised against changes to neighbouring rows.
  const onTogglePin   = useCallback((id: string, next: boolean) => setPinned(id, next), [setPinned]);
  const onToggleMute  = useCallback((id: string, next: boolean) => setMuted(id, next), [setMuted]);
  const onRequestDelete = useCallback((c: LocalConversation) => {
    confirmDelete(c, removeConversation);
  }, [removeConversation]);
  const registerSwipeable = useCallback((id: string, r: Swipeable | null) => {
    if (r) {swipeableMapRef.current.set(id, r);}
    else   {swipeableMapRef.current.delete(id);}
  }, []);
  const onSwipeableWillOpen = useCallback((id: string) => {
    const live = swipeableMapRef.current.get(id);
    if (openSwipeRef.current && openSwipeRef.current !== live) {
      openSwipeRef.current.close();
    }
    openSwipeRef.current = live ?? null;
    Vibration.vibrate(8);
  }, []);
  const closeRow = useCallback((id: string) => {
    const live = swipeableMapRef.current.get(id);
    live?.close();
    if (openSwipeRef.current === live) {openSwipeRef.current = null;}
  }, []);

  const renderChatRow = useCallback(({item: c}: ListRenderItemInfo<LocalConversation>) => {
    // Why: M-18 — pass the peer id, not a presence-derived value; presence
    // frames no longer churn renderChatRow's identity or re-render the list.
    return (
      <ChatListRow
        conv={c}
        peerId={c.type === 'direct' ? c.peer?.userId : undefined}
        onPress={goChat}
        onTogglePin={onTogglePin}
        onToggleMute={onToggleMute}
        onRequestDelete={onRequestDelete}
        registerSwipeable={registerSwipeable}
        onSwipeableWillOpen={onSwipeableWillOpen}
        closeRow={closeRow}
      />
    );
  }, [goChat, onTogglePin, onToggleMute, onRequestDelete, registerSwipeable, onSwipeableWillOpen, closeRow]);

  const channelCount = ordered.length;

  return (
    <View style={[styles.root, {paddingTop: insets.top, backgroundColor: MSG_BG}]}>
      <AmbientBg bg={MSG_BG} />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      {/* N-31 — surface a blocked notification permission instead of failing silent. */}
      <NotificationPermissionBanner />
      {/* P2-BR-1 — battery-optimization exemption / OEM auto-start prompt. */}
      <NotificationReliabilityCard />
      <ConnectionBanner state={connectionState} />
      {/* B-46 — destroyed-envelope disclosure. Sealed sender means an
          undecryptable envelope has no known sender, so a per-thread
          placeholder is impossible; this counter banner is the ceiling
          of what the device can honestly disclose. Tap to dismiss. */}
      {undecryptableDrops > 0 && (
        <TouchableOpacity
          style={styles.dropBanner}
          onPress={() => useMessengerStore.getState().clearUndecryptableDrops()}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss undecryptable-messages notice">
          <Icon name="alert-circle-outline" size={13} color="#FBBF24" />
          <Text style={styles.dropBannerText}>
            {undecryptableDrops === 1
              ? 'A message sent while you were away couldn’t be decrypted. Ask the sender to resend it.'
              : `${undecryptableDrops} messages sent while you were away couldn’t be decrypted. Ask the senders to resend.`}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Header ───────────────────────────────────────────── */}
      <View style={styles.headerWrap}>
        <View style={styles.headerTop}>
          <View style={styles.headerLeft}>
            {/* B-91 M1 R9 — profile drawer entry (spec p.12): account rows +
                the only sanctioned cross-product switch live behind it. */}
            <TouchableOpacity
              style={styles.headerAvatarBtn}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Open profile drawer"
              onPress={() => setDrawerOpen(true)}>
              {user?.avatar_url ? (
                <Image source={{uri: user.avatar_url}} style={styles.headerAvatarImg} />
              ) : (
                <Text style={styles.headerAvatarText}>{userInitials}</Text>
              )}
            </TouchableOpacity>
            <View style={styles.headerMark}>
              <Icon name="message-processing" size={16} color={Bravo.accentSoft} />
            </View>
            <View style={{marginLeft: 4}}>
              <Text style={styles.headerTitle}>MESSENGER</Text>
              <Text style={styles.headerSubtitle}>
                {channelCount} SECURE CHANNEL{channelCount === 1 ? '' : 'S'}
              </Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.iconPill} onPress={() => navigation.navigate('NewChat')} activeOpacity={0.7}>
              <Icon name="pencil-box-outline" size={18} color={Bravo.text} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconPill} onPress={() => navigation.navigate('MessengerSettings')} activeOpacity={0.7}>
              <Icon name="cog-outline" size={18} color={Bravo.text} />
            </TouchableOpacity>
          </View>
        </View>

        {/* E2E banner — Signal Protocol · Verified */}
        <View style={{marginTop: 14}}>
          <PremiumBanner tone="signal" label="AES-256 ENCRYPTED" detail="VERIFIED" icon="lock" />
        </View>

        {/* Premium search */}
        <View style={styles.search}>
          <Icon name="magnify" size={15} color={Bravo.textMute} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search secure messages…"
            placeholderTextColor={Bravo.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <TouchableOpacity onPress={() => setQuery('')} activeOpacity={0.7}>
              <Icon name="close-circle" size={15} color={Bravo.textMute} />
            </TouchableOpacity>
          ) : (
            <View style={styles.kbdHint}><Text style={styles.kbdHintText}>⌘K</Text></View>
          )}
        </View>

        {/* "Recent · N" row */}
        <View style={styles.recentRow}>
          <Text style={styles.recentLabel}>{debouncedQuery ? `Results · ${filtered.length}` : `Recent · ${channelCount}`}</Text>
          <Text style={styles.recentAction}>Filter →</Text>
        </View>
      </View>

      {!hydrated ? (
        <LoadingView label="Loading your chats…" hint="Restoring end-to-end encrypted history from secure storage." />
      ) : ordered.length === 0 ? (
        <EmptyState onStart={() => navigation.navigate('NewChat')} />
      ) : filtered.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Icon name="magnify-close" size={32} color="#334155" />
          <Text style={styles.emptyTitle}>No matches</Text>
          <Text style={styles.emptyHint}>Nothing matches "{debouncedQuery}". Try a different phrase.</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={chatListKeyExtractor}
          renderItem={renderChatRow}
          // B-91 M1 R4 — the reserved sponsored slot sits above ALL chats
          // (user-pinned included) and cannot be dismissed. Stable component
          // reference so list re-renders don't remount it.
          ListHeaderComponent={SponsoredSlot}
          showsVerticalScrollIndicator={false}
          // Virtualization tuned for a chat list: rows are ~70 dp tall, so
          // initialNumToRender of 14 covers the viewport on common
          // phones without leaving the top blank. windowSize 7 means
          // ~3 screens overscan on each side — enough to avoid blank
          // frames during a fling without doubling the mount cost.
          initialNumToRender={14}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          contentContainerStyle={{paddingBottom: insets.bottom + MSG_TAB_HEIGHT + 88}}
        />
      )}

      <TouchableOpacity
        style={[styles.fabWrap, {bottom: insets.bottom + 72 + MSG_TAB_HEIGHT}]}
        onPress={() => navigation.navigate('NewChat')}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Compose new message">
        <LinearGradient
          colors={[Bravo.accentSoft, Bravo.accent, Bravo.accentDeep]}
          start={{x: 0.3, y: 0.2}}
          end={{x: 0.8, y: 1}}
          style={styles.fab}>
          <View style={styles.fabInnerHighlight} pointerEvents="none" />
          <Icon name="pencil" size={22} color="#FFF" />
        </LinearGradient>
      </TouchableOpacity>

      {/* ── Messenger Footer Tabs ─────────────────────────────── */}
      <MessengerTabBar navigation={navigation} insets={insets} />

      <ProfileDrawerModal visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}

/**
 * One row in the chat list — memoised so a `presence` slice update for
 * one peer doesn't re-render every other row. The previous inline
 * .map() allocated a fresh JSX subtree (including its own Swipeable
 * refs and arrow handlers) per conversation on every render, which is
 * what Rank 12 flagged: keystrokes in the search box re-rendered the
 * whole list. The wrapper component closes over stable callbacks the
 * parent hands down, and the comparator below ignores fields the row
 * doesn't visibly depend on.
 */
const ChatListRow = React.memo(function ChatListRow({
  conv: c,
  peerId,
  onPress,
  onTogglePin,
  onToggleMute,
  onRequestDelete,
  registerSwipeable,
  onSwipeableWillOpen,
  closeRow,
}: {
  conv: LocalConversation;
  peerId?: string;
  onPress: (id: string, name: string, isGroup: boolean) => void;
  onTogglePin:    (id: string, next: boolean) => void;
  onToggleMute:   (id: string, next: boolean) => void;
  onRequestDelete: (c: LocalConversation) => void;
  registerSwipeable: (id: string, r: Swipeable | null) => void;
  onSwipeableWillOpen: (id: string) => void;
  closeRow: (id: string) => void;
}) {
  const isGroup = c.type !== 'direct';
  const handleRef = useCallback((r: Swipeable | null) => registerSwipeable(c.id, r), [registerSwipeable, c.id]);
  const handleWillOpen = useCallback(() => onSwipeableWillOpen(c.id), [onSwipeableWillOpen, c.id]);
  const handlePress = useCallback(
    () => onPress(c.id, c.name ?? c.peer?.userId ?? c.id, isGroup),
    [onPress, c.id, c.name, c.peer?.userId, isGroup],
  );
  const handlePin = useCallback(() => {
    closeRow(c.id);
    onTogglePin(c.id, !c.is_pinned);
  }, [closeRow, onTogglePin, c.id, c.is_pinned]);
  const handleMute = useCallback(() => {
    closeRow(c.id);
    onToggleMute(c.id, !c.is_muted);
  }, [closeRow, onToggleMute, c.id, c.is_muted]);
  const handleDelete = useCallback(() => {
    closeRow(c.id);
    onRequestDelete(c);
  }, [closeRow, onRequestDelete, c]);

  return (
    <Swipeable
      ref={handleRef}
      onSwipeableWillOpen={handleWillOpen}
      friction={2.2}
      overshootFriction={10}
      leftThreshold={70}
      rightThreshold={70}
      renderLeftActions={(progress) => (
        <SwipeActionRevealSingle
          progress={progress}
          bg={Bravo.accent}
          icon={c.is_pinned ? 'pin-off' : 'pin'}
          label={c.is_pinned ? 'Unpin' : 'Pin'}
          onPress={handlePin}
          from="left"
        />
      )}
      renderRightActions={(progress) => (
        <View style={styles.swipeRightGroup}>
          <SwipeActionRevealSingle
            progress={progress}
            bg={'#475569'}
            icon={c.is_muted ? 'bell' : 'bell-off'}
            label={c.is_muted ? 'Unmute' : 'Mute'}
            onPress={handleMute}
            from="right"
            offset={0}
          />
          <SwipeActionRevealSingle
            progress={progress}
            bg={Bravo.alert}
            icon="trash-can-outline"
            label="Delete"
            onPress={handleDelete}
            from="right"
            offset={1}
          />
        </View>
      )}>
      <TouchableOpacity
        style={[
          styles.row,
          c.is_pinned && styles.rowPinned,
          c.unread_count > 0 && styles.rowActive,
        ]}
        onPress={handlePress}
        activeOpacity={0.8}>
        <View style={styles.avWrap}>
          <View style={[isGroup ? styles.groupAv : styles.personAv, {backgroundColor: avatarBg(c)}]}>
            <Text style={styles.avText}>{initialsOf(c)}</Text>
          </View>
          {!isGroup && <VerifiedBadge />}
          {!isGroup && <RowOnlineDot peerId={peerId} />}
        </View>
        <ConvBody
          name={c.name ?? c.peer?.userId ?? c.id ?? '—'}
          handle={isGroup ? 'GROUP' : 'DEV'}
          preview={previewOf(c)}
          previewKind={previewKindOf(c)}
          time={timeOf(c)}
          unread={c.unread_count}
          read={c.unread_count === 0}
          muted={c.is_muted}
          pinned={c.is_pinned}
        />
      </TouchableOpacity>
    </Swipeable>
  );
}, (prev, next) => {
  // Compare only the visible bits. Presence never flows through props —
  // RowOnlineDot subscribes to its own peer's entry — so identity
  // equality on the conversation reference is the cheap first gate
  // (Zustand+immer returns a NEW conv object when any of its fields
  // change).
  if (prev.conv   !== next.conv)   {return false;}
  if (prev.peerId !== next.peerId) {return false;}
  // Stable callbacks from the parent — identity check is enough.
  return (
    prev.onPress             === next.onPress &&
    prev.onTogglePin         === next.onTogglePin &&
    prev.onToggleMute        === next.onToggleMute &&
    prev.onRequestDelete     === next.onRequestDelete &&
    prev.registerSwipeable   === next.registerSwipeable &&
    prev.onSwipeableWillOpen === next.onSwipeableWillOpen &&
    prev.closeRow            === next.closeRow
  );
});

function EmptyState({onStart}: {onStart: () => void}) {
  return (
    <View style={styles.emptyWrap}>
      <View style={styles.emptyIconWrap}>
        <Icon name="message-lock-outline" size={44} color="#334155" />
      </View>
      <Text style={styles.emptyTitle}>No conversations yet</Text>
      <Text style={styles.emptyHint}>
        Start a new end-to-end encrypted chat. Messages never touch our servers in plaintext.
      </Text>
      <TouchableOpacity style={styles.emptyBtn} onPress={onStart} activeOpacity={0.85}>
        <Icon name="pencil-box-outline" size={16} color="#FFF" />
        <Text style={styles.emptyBtnText}>New message</Text>
      </TouchableOpacity>
    </View>
  );
}

type PreviewKind = 'text' | 'reply' | 'forward' | 'lock' | 'image' | 'file';

function ConvBody({name, handle, preview, previewKind, time, unread, read, muted, pinned}: {
  name: string; handle?: string; preview: string; previewKind?: PreviewKind; time: string;
  unread: number; read: boolean;
  muted?: boolean; pinned?: boolean;
}) {
  return (
    <View style={styles.rowBody}>
      <View style={styles.rowTop}>
        <View style={styles.nameRow}>
          <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
          {handle ? <Text style={styles.rowHandle}>· {handle}</Text> : null}
          {muted  && <Icon name="bell-off" size={12} color={Bravo.textMute} />}
          {pinned && <Icon name="pin"      size={12} color={Bravo.accent} />}
        </View>
        <Text style={[styles.rowTime, unread > 0 && {color: Bravo.accent, fontWeight: '600'}]}>{time}</Text>
      </View>
      <View style={styles.rowBottom}>
        <View style={styles.previewRow}>
          <PreviewIcon kind={previewKind ?? 'text'} />
          <Text style={[styles.rowPreview, read && {color: Bravo.textMute}]} numberOfLines={1}>{preview}</Text>
        </View>
        {unread > 0 ? (
          <View style={[styles.badge, muted && {backgroundColor: Bravo.textMute, shadowOpacity: 0}]}>
            <Text style={styles.badgeText}>{unread}</Text>
          </View>
        ) : (
          read && <Icon name="check-all" size={15} color={Bravo.accent} style={{opacity: 0.85}} />
        )}
      </View>
    </View>
  );
}

/**
 * Animated swipe-action pill — the icon + label scale and fade in
 * proportional to how far the row has been dragged. Interpolation is
 * driven by the `progress` Animated.Value that Swipeable hands us.
 * `from='left'` mirrors the X animation for left-rendered actions.
 */
function SwipeActionRevealSingle({
  progress, bg, icon, label, onPress, from, offset = 0,
}: {
  progress: Animated.AnimatedInterpolation<number>;
  bg: string;
  icon: keyof typeof Icon.glyphMap;
  label: string;
  onPress: () => void;
  from: 'left' | 'right';
  offset?: number;  // 0 = outermost (closest to the row edge), higher = further
}) {
  // Stagger multiple right-side actions so the outermost one leads.
  const start = 0.3 + offset * 0.15;
  const scale = progress.interpolate({
    inputRange: [0, start, 1], outputRange: [0.6, 0.9, 1],
    extrapolate: 'clamp',
  });
  const opacity = progress.interpolate({
    inputRange: [0, start, 1], outputRange: [0, 0.5, 1],
    extrapolate: 'clamp',
  });
  const translate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: from === 'left' ? [-30, 0] : [30, 0],
    extrapolate: 'clamp',
  });
  return (
    <Animated.View style={{
      opacity,
      transform: [{translateX: translate}, {scale}],
    }}>
      <TouchableOpacity
        style={[styles.swipeAction, {backgroundColor: bg}]}
        onPress={onPress}
        activeOpacity={0.85}>
        <Icon name={icon} size={20} color="#FFF" />
        <Text style={styles.swipeActionText}>{label}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function PreviewIcon({kind}: {kind: PreviewKind}) {
  if (kind === 'reply')   {return <Icon name="reply"         size={12} color={Bravo.textMute} />;}
  if (kind === 'forward') {return <Icon name="share-outline" size={12} color={Bravo.textMute} />;}
  if (kind === 'lock')    {return <Icon name="lock-outline"  size={12} color={Bravo.signal}    />;}
  if (kind === 'image')   {return <Icon name="image-outline" size={12} color={Bravo.textMute} />;}
  if (kind === 'file')    {return <Icon name="paperclip"     size={12} color={Bravo.textMute} />;}
  return null;
}

/**
 * Tiny verified-check badge anchored to an avatar's SE corner. Matches
 * the design handoff — signal-green circle with a 2px obsidian ring
 * so the badge visibly "sits on" the avatar.
 */
function VerifiedBadge() {
  return (
    <View style={styles.verifiedBadge}>
      <Icon name="check" size={9} color={Bravo.bg} />
    </View>
  );
}

/**
 * Pick a preview-icon kind from a conversation's last message so
 * the chat row telegraphs what kind of content the user is catching
 * up on. Text messages get no icon (the common case).
 */
function previewKindOf(c: LocalConversation): PreviewKind {
  // `last_message` is typed as the shared `Message` but at runtime we
  // always stuff a `LocalMessage` in via appendMessage. Cast to pick up
  // the reply marker without widening the public type.
  const last = c.last_message as (typeof c.last_message & {reply_to_msg_id?: string}) | undefined;
  if (!last) {return 'lock';}
  if (last.type === 'image') {return 'image';}
  // Audit MSG-13 — audio/video previously fell through to 'text' → the row
  // showed "(encrypted)". Map to the attachment ('file') icon (a distinct
  // audio/video icon would need the row component to learn new kinds); the
  // preview TEXT below disambiguates ("🎤 Voice message" / "🎬 Video").
  if (last.type === 'file' || last.type === 'audio' || last.type === 'video') {return 'file';}
  if (last.reply_to_msg_id)  {return 'reply';}
  if ((last.content ?? '').startsWith('↪ Forwarded')) {return 'forward';}
  return 'text';
}

function confirmDelete(c: LocalConversation, remove: (id: string) => void) {
  Alert.alert(
    'Delete conversation?',
    `This removes "${c.name ?? c.peer?.userId ?? 'this conversation'}" and all its local history from this device. The peer still keeps their copy.`,
    [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Delete', style: 'destructive', onPress: () => remove(c.id)},
    ],
  );
}

/**
 * Presence dot for one chat row. Subscribes narrowly to its OWN peer's
 * presence entry (a primitive-string selector), so a presence frame for
 * peer A re-renders only A's dot — not the screen, not the other rows.
 * Surfaces the full 4-state ladder so `away` peers paint amber rather
 * than green, falling back to the legacy boolean for any record that
 * predates the wider slice. No record at all (never subscribed) hides
 * the dot.
 */
const RowOnlineDot = React.memo(function RowOnlineDot({peerId}: {peerId?: string}) {
  const dot = useMessengerStore((s): OnlineDotState => {
    const rec = peerId ? s.presence[peerId] : undefined;
    if (!rec) {return 'offline';}
    return rec.state ?? (rec.online ? 'online' : 'offline');
  });
  return <OnlineDot state={dot} ringColor={MSG_BG} />;
});

function initialsOf(c: LocalConversation): string {
  // Why: a restored/synced conversation row can land with `name=null` AND
  // `peer=undefined` (group placeholder, partial restore, race against
  // contact discovery). The previous `c.name ?? c.peer.userId` crashed
  // the entire home screen render with "Cannot read property 'userId'
  // of undefined" the moment such a row existed. Walk the fallbacks
  // defensively so the worst case is just a generic placeholder.
  const s = c.name ?? c.peer?.userId ?? c.id ?? '';
  if (!s) {return '?';}
  return s.split(/\s+/).slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase() || '?';
}

function avatarBg(c: LocalConversation): string {
  const palette = ['#7B5EA7', '#0E7490', '#065f46', '#244C82', '#166ED1', '#1B3A66'];
  // Why: c.id could be null on a corrupt-row edge case (restore mid-flight).
  const id = c.id ?? '';
  let hash = 0;
  for (let i = 0; i < id.length; i++) {hash = (hash * 31 + id.charCodeAt(i)) >>> 0;}
  return palette[hash % palette.length];
}

function previewOf(c: LocalConversation): string {
  const last = c.last_message;
  if (!last) {return 'End-to-end encrypted · start chatting';}
  if (last.type === 'file')  {return '📎 Attachment';}
  if (last.type === 'image') {return '📷 Photo';}
  // Audit MSG-13 — audio/video now get a meaningful label instead of falling
  // through to '(encrypted)'.
  if (last.type === 'audio') {return '🎤 Voice message';}
  if (last.type === 'video') {return '🎬 Video';}
  return last.content || '(encrypted)';
}

function timeOf(c: LocalConversation): string {
  const last = c.last_message;
  if (!last) {return '';}
  return formatListTimestamp(last.created_at);
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor: Bravo.bg},
  // B-46 — destroyed-envelope disclosure strip (ConnectionBanner warn tone).
  dropBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6,
    borderBottomWidth: 1,
    backgroundColor: 'rgba(251,191,36,0.12)', borderColor: 'rgba(251,191,36,0.3)',
  },
  dropBannerText: {flex: 1, color: '#FBBF24', fontSize: 11, fontWeight: '600'},
  headerWrap: {paddingHorizontal: 22, paddingBottom: 10, paddingTop: 10},
  headerTop: {flexDirection:'row', alignItems:'center', justifyContent:'space-between'},
  headerLeft: {flexDirection:'row', alignItems:'center', gap: 10},
  headerAvatarBtn: {
    width: 34, height: 34, borderRadius: 17, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  headerAvatarImg: {width: 34, height: 34, borderRadius: 17},
  headerAvatarText: {color: '#A9C5FF', fontSize: 12, fontWeight: '800'},
  headerMark: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: 'rgba(91,141,239,0.14)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: BravoFont.display, color: Bravo.text, fontSize: 18, fontWeight: '700', letterSpacing: 1.6, lineHeight: 18},
  headerSubtitle: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 9, letterSpacing: 1.2, marginTop: 3, textTransform: 'uppercase'},
  // Legacy — kept so old refs don't break.
  liteBadge: {paddingHorizontal:7, paddingVertical:2, borderRadius:5, backgroundColor:'#0369a1'},
  liteBadgeText: {color:'#FFF', fontSize:8, fontWeight:'800', letterSpacing:1.2},
  headerActions: {flexDirection: 'row', alignItems: 'center', gap: 8},
  encBadge: {flexDirection:'row', alignItems:'center', gap:4, paddingHorizontal:8, paddingVertical:4, borderRadius:99, backgroundColor:'rgba(34,197,94,0.1)', borderWidth:1, borderColor:'rgba(34,197,94,0.25)'},
  encDot: {width:6, height:6, borderRadius:3, backgroundColor:'#22c55e'},
  encText: {color:'#4ade80', fontSize:9, fontWeight:'800', letterSpacing:1},
  iconBtn: {width:32, height:32, borderRadius:16, alignItems:'center', justifyContent:'center'},
  iconPill: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: Bravo.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  search: {
    marginTop: 14,
    height: 44, borderRadius: 14, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1, borderColor: Bravo.hair2,
  },
  searchHint: {color:'#7E8AA6', fontSize:11, fontWeight:'800', letterSpacing:2},
  searchInput: {flex:1, color: Bravo.text, fontSize: 14, fontFamily: BravoFont.sans, letterSpacing: 0.2, padding: 0},
  kbdHint: {
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: Bravo.hair,
  },
  kbdHintText: {fontFamily: BravoFont.mono, fontSize: 10, color: Bravo.textMute, letterSpacing: 0.5},

  recentRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12},
  recentLabel: {fontFamily: BravoFont.mono, color: Bravo.textDim, fontSize: 10.5, fontWeight: '600', letterSpacing: 1.8, textTransform: 'uppercase'},
  recentAction: {fontFamily: BravoFont.sans, color: Bravo.textMute, fontSize: 11, fontWeight: '500'},

  sectionLabel: {color: Bravo.textDim, fontSize: 10.5, fontFamily: BravoFont.mono, fontWeight: '600', letterSpacing: 1.8, textTransform: 'uppercase', paddingHorizontal: 22, paddingTop: 10, paddingBottom: 6},
  // Row — more breathing room + no harsh divider. Spacing between rows
  // comes from the `marginVertical` and an optional active/pinned bg.
  row: {flexDirection:'row', alignItems:'center', gap: 13, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14},
  avWrap: {position:'relative', width: 46, height: 46},
  groupAv: {width: 46, height: 46, borderRadius: 13, alignItems:'center', justifyContent:'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)'},
  personAv: {width: 46, height: 46, borderRadius: 23, alignItems:'center', justifyContent:'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)'},
  avText: {fontFamily: BravoFont.display, color: '#FFF', fontSize: 16, fontWeight: '700'},
  rowBody: {flex: 1, minWidth: 0},
  rowTop: {flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 3},
  nameRow: {flexDirection: 'row', alignItems: 'baseline', gap: 6, flex: 1},
  rowName: {fontFamily: BravoFont.display, color: Bravo.text, fontSize: 15, fontWeight: '600', letterSpacing: -0.15, flexShrink: 1},
  rowTime: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 10, letterSpacing: 0.3, flexShrink: 0},
  rowBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8},
  rowPreview: {fontFamily: BravoFont.sans, color: Bravo.textDim, fontSize: 12.5, letterSpacing: -0.1, flex: 1},
  badge: {
    minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6,
    backgroundColor: Bravo.accent,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: Bravo.accent, shadowOffset: {width: 0, height: 3}, shadowOpacity: 0.45, shadowRadius: 10, elevation: 4,
  },
  badgeText: {fontFamily: BravoFont.sans, color: '#FFF', fontSize: 11, fontWeight: '700'},

  emptyWrap: {alignItems:'center', paddingVertical:60, paddingHorizontal:32, gap:12, flex:1, justifyContent:'center'},
  emptyIconWrap: {width:80, height:80, borderRadius:40, backgroundColor:'#1B3A66', borderWidth:1, borderColor:'#1C3B66', alignItems:'center', justifyContent:'center', marginBottom:8},
  emptyTitle: {color:'#B8C7E0', fontSize:15, fontWeight:'700'},
  emptyHint: {color:'#7E8AA6', fontSize:12, textAlign:'center', lineHeight:18, maxWidth:300},
  emptyBtn: {marginTop:12, flexDirection:'row', alignItems:'center', gap:6, paddingHorizontal:20, paddingVertical:10, borderRadius:99, backgroundColor:Colors.primary},
  emptyBtnText: {color:'#FFF', fontSize:12, fontWeight:'800', letterSpacing:1.5},

  // Wrapper carries the absolute position + drop shadow; the gradient
  // fill lives inside so the shadow doesn't clip the radial highlight.
  fabWrap: {
    position: 'absolute', right: 22,
    width: 56, height: 56, borderRadius: 28,
    shadowColor: Bravo.accent, shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.55, shadowRadius: 24, elevation: 10,
  },
  fab: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    overflow: 'hidden',
  },
  fabInnerHighlight: {
    position: 'absolute', top: 2, left: 2, right: 2, bottom: '55%',
    borderRadius: 27,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.35)',
  },

  rowHandle: {fontFamily: BravoFont.mono, color: Bravo.textMute, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase'},
  previewRow: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0},

  // Verified check on avatar — 16×16 signal-green circle, anchored SE.
  verifiedBadge: {
    position: 'absolute', right: -2, bottom: -2,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: Bravo.signal,
    borderWidth: 2, borderColor: MSG_BG,
    alignItems: 'center', justifyContent: 'center',
  },

  // Chat-list swipe actions + active-row state
  rowActive: {
    backgroundColor: 'rgba(91,141,239,0.06)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.12)',
  },
  rowPinned: {backgroundColor:'rgba(96,165,250,0.04)'},
  swipeAction: {width:88, alignItems:'center', justifyContent:'center', gap:4, paddingHorizontal:8},
  swipeActionPin:    {backgroundColor:'#1E88FF'},
  swipeActionMute:   {backgroundColor:'#244C82'},
  swipeActionDelete: {backgroundColor:'#DC2626'},
  swipeActionText: {color:'#FFF', fontSize:10, fontWeight:'800', letterSpacing:1.2, textTransform:'uppercase'},
  swipeRightGroup: {flexDirection:'row'},
}));

// ─── Messenger Footer Tab Bar ─────────────────────────────────────────────────

const MSG_TAB_HEIGHT = 60;

type MsgTab = {icon: React.ComponentProps<typeof Icon>['name']; label: string; route: keyof MessengerStackParamList | null};
const MSG_TABS: MsgTab[] = [
  {icon: 'message-text-outline', label: 'Chat',   route: null},
  {icon: 'account-group-outline', label: 'Groups', route: 'Groups'},
  {icon: 'phone-outline',         label: 'Call',   route: 'CallsLog'},
  {icon: 'folder-outline',        label: 'Files',  route: 'Files'},
  {icon: 'newspaper-variant-outline', label: 'News', route: 'NewsHub'},
];

function MessengerTabBar({
  navigation,
  insets,
}: {
  navigation: NativeStackNavigationProp<MessengerStackParamList, 'MessengerHome'>;
  insets: {bottom: number};
}) {
  const handlePress = (route: keyof MessengerStackParamList | null) => {
    if (route === 'Groups')    {navigation.navigate('Groups');}
    else if (route === 'CallsLog') {navigation.navigate('CallsLog');}
    else if (route === 'Files')    {navigation.navigate('Files');}
    else if (route === 'NewsHub')  {navigation.navigate('NewsHub');}
  };
  return (
    <View style={[msgTabStyles.bar, {paddingBottom: Math.max(insets.bottom, 8)}]}>
      <View style={msgTabStyles.hairline} />
      <View style={msgTabStyles.row}>
        {MSG_TABS.map(tab => {
          const active = tab.route === null;
          return (
            <TouchableOpacity
              key={tab.label}
              style={msgTabStyles.item}
              activeOpacity={0.7}
              hitSlop={{top: 8, bottom: 8, left: 4, right: 4}}
              onPress={() => handlePress(tab.route)}>
              {active && <View style={msgTabStyles.activeBar} />}
              <Icon name={tab.icon} size={22} color={active ? Bravo.accent : Bravo.textMute} />
              <Text style={[msgTabStyles.label, active && msgTabStyles.labelActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const msgTabStyles = StyleSheet.create(scaleTextStyles({
  bar: {
    backgroundColor: MSG_BG,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    paddingTop: 10,
  },
  hairline: {},
  row: {flexDirection: 'row', alignItems: 'flex-start'},
  item: {flex: 1, alignItems: 'center', justifyContent: 'flex-start', gap: 3, position: 'relative'},
  activeBar: {
    position: 'absolute', top: -10, width: 28, height: 2.5, borderRadius: 2,
    backgroundColor: Bravo.accent,
    shadowColor: Bravo.accent, shadowOpacity: 1, shadowRadius: 8, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  label: {fontFamily: BravoFont.sans, fontSize: 10, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', color: Bravo.textMute},
  labelActive: {color: Bravo.text},
}));
