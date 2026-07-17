import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useAuthStore} from '@store/authStore';
import {departmentApi} from '@services/api';
import {useMessengerStore, EMPTY_MESSAGES} from '@/modules/messenger/store/messengerStore';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {AttachmentFileViewer, type AttachmentViewTarget} from '@/modules/messenger/ui/AttachmentFileViewer';
import type {MessengerStackParamList} from '@navigation/types';
import {useKeyboardHeight} from '@hooks/useKeyboardHeight';
import {OB} from '@screens/deptchat/_obsidian';

type Rt = RouteProp<MessengerStackParamList, 'DepartmentChat'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

// Stable per-sender accent colour so each member's name keeps the same
// colour across messages (the brief: "in their assigned colour").
const ROLE_COLORS = ['#60A5FA', '#34d399', '#F59E0B', '#A78BFA', '#F472B6', '#22D3EE'];
function colorForSender(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {h = (h * 31 + id.charCodeAt(i)) >>> 0;}
  return ROLE_COLORS[h % ROLE_COLORS.length];
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {return '?';}
  if (parts.length === 1) {return parts[0].slice(0, 2).toUpperCase();}
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
}

function sameDay(a: string, b: string): boolean {
  const da = new Date(a); const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
function dayLabel(iso: string): string {
  const now = new Date();
  if (sameDay(iso, now.toISOString())) {return 'Today';}
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(iso, y.toISOString())) {return 'Yesterday';}
  return new Date(iso).toLocaleDateString([], {day: '2-digit', month: 'short'});
}

// @mention + announcement (area 6). Both ride INSIDE the already-E2EE message body —
// the relay never sees plaintext, and we never log the parsed token/segments
// (logAudit). A mention is `@[Display Name](userId)`; an announcement is a body that
// leads with ANNOUNCE_PREFIX, styled distinctly + (for the recipient) a megaphone.
const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;
const ANNOUNCE_PREFIX = '​📣 '; // zero-width guard so a user typing 📣 isn't mistaken for an announcement

// Discord-style slash commands. Typing "/" at the start of the composer opens this palette;
// extend the list to add more. `/announce` ties into the existing announcement broadcast.
type SlashCmd = {cmd: string; icon: string; desc: string};
const SLASH_COMMANDS: SlashCmd[] = [
  {cmd: '/announce', icon: 'bullhorn-variant', desc: 'Post as an announcement (📣 alerts everyone)'},
  {cmd: '/shrug',    icon: 'emoticon-neutral-outline', desc: 'Append ¯\\_(ツ)_/¯'},
];

interface Segment {text?: string; mention?: string; userId?: string}
function parseSegments(body: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    if (m.index > last) {out.push({text: body.slice(last, m.index)});}
    out.push({mention: m[1], userId: m[2]});
    last = m.index + m[0].length;
  }
  if (last < body.length) {out.push({text: body.slice(last)});}
  return out;
}

export default function DepartmentChatScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-03 — Android keyboard covered the bottom composer (KAV has
  // no Android behavior; adjustResize is dead under edge-to-edge).
  // ChatScreen pattern: manual kb padding.
  const kbHeight = useKeyboardHeight();
  const navigation = useNavigation();
  const route = useRoute<Rt>();
  const {channelId, channelName, channelDesc, isOwner} = route.params;
  // D1-h — track the group id locally; route params freeze it at navigation time, so a
  // channel an admin provisions AFTER we opened it would stay stuck on "not yet active".
  const [groupConversationId, setGroupConversationId] = useState<string | null>(route.params.groupConversationId ?? null);
  // Role is tracked locally + refreshed on focus AND re-verified at send time: a member just
  // downgraded to 'viewer' must lose the composer and be blocked from posting. Group sends are
  // E2EE + client-driven (no server gate on plaintext), so this client gate is the enforcement.
  const [myRole, setMyRole] = useState<'admin' | 'viewer'>(route.params.myRole === 'admin' ? 'admin' : 'viewer');
  const myId = useAuthStore(s => s.user?.id);

  // Decrypted messages come from the messenger store, keyed by the group
  // conversation id. The relay only ever held the ciphertext — decryption
  // happened in the runtime's receive path (parseGroupMessage). No channel
  // plaintext is ever fetched from the department REST API.
  const messages = useMessengerStore(s =>
    groupConversationId ? (s.messages[groupConversationId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  // Member count for the header meta — sourced from the local conversation's
  // participants (hydrated on focus from the server-authoritative roster).
  const memberCount = useMessengerStore(s =>
    groupConversationId ? (s.conversations[groupConversationId]?.participants?.length ?? 0) : 0,
  );

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // @mention members (userId -> display name) for this channel's group, and the
  // announcement toggle. memberNames is populated by the group runtime as members
  // are keyed in; absent until then (autocomplete just shows nothing).
  const memberNames = useMessengerStore(s =>
    groupConversationId ? s.groupMemberNames[groupConversationId] : undefined,
  );
  const [announce, setAnnounce] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  // Media-parity M2 — dept-chat attachments were a dead "Open" label.
  const [viewerTarget, setViewerTarget] = useState<AttachmentViewTarget | null>(null);

  const onDraftChange = useCallback((t: string) => {
    setDraft(t);
    // Slash-command palette (Discord-style): active while typing the leading "/command" token.
    if (t.startsWith('/') && !/\s/.test(t)) {
      setSlashQuery(t);
      setMentionQuery(null);
      return;
    }
    setSlashQuery(null);
    // Active @mention = the token after the last '@' that starts a word, with no
    // newline/second-'@', short enough to be a name fragment.
    const at = t.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(t[at - 1]))) {
      const after = t.slice(at + 1);
      setMentionQuery(!after.includes('\n') && !after.includes('@') && after.length <= 30 ? after : null);
    } else {
      setMentionQuery(null);
    }
  }, []);

  // @mention autocomplete: members of THIS channel whose display name matches the typed
  // keyword, TOP 5 (names are hydrated on focus from departmentApi.listMembers below).
  const suggestions = useMemo<Array<[string, string]>>(() => {
    if (mentionQuery === null || !memberNames) {return [];}
    const q = mentionQuery.trim().toLowerCase();
    return Object.entries(memberNames)
      .filter(([uid, name]) => uid !== myId && (q === '' || name.toLowerCase().includes(q)))
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, 5);
  }, [mentionQuery, memberNames, myId]);

  const slashSuggestions = useMemo<SlashCmd[]>(() => {
    if (slashQuery === null) {return [];}
    const q = slashQuery.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.cmd.startsWith(q));
  }, [slashQuery]);

  const insertMention = useCallback((uid: string, name: string) => {
    setDraft(prev => {
      const at = prev.lastIndexOf('@');
      return at < 0 ? prev : `${prev.slice(0, at)}@[${name}](${uid}) `;
    });
    setMentionQuery(null);
  }, []);

  const applySlash = useCallback((cmd: string) => {
    setSlashQuery(null);
    if (cmd === '/announce') { setAnnounce(true); setDraft(''); }
    else if (cmd === '/shrug') { setDraft(d => `${d.replace(/^\/shrug\s*/, '')}¯\\_(ツ)_/¯`); }
  }, []);

  // Pull any queued envelopes + mark the conversation read on open.
  useEffect(() => {
    if (!groupConversationId) {return;}
    void (async () => {
      try {
        const rt = await getMessengerRuntime('production');
        await rt.pullEnvelopes();
        rt.markRead(groupConversationId);
      } catch (e) {
        console.log('[dept.chat] pull skipped:', (e as Error).message);
      }
    })();
  }, [groupConversationId]);

  // Mark this channel active while focused so the per-channel unread badge
  // (ChannelUnread / the Home announcement badge) zeroes out — rt.markRead
  // only acks the relay, it never touches the local unread_count. Mirrors
  // ChatScreen: clear on blur only if we're still the active conversation.
  useFocusEffect(
    useCallback(() => {
      if (!groupConversationId) {return;}
      useMessengerStore.getState().setActiveConversation(groupConversationId);
      void (async () => {
        // D3-a/b + D2-d — hydrate the local conversation's participants from the
        // SERVER-AUTHORITATIVE dept roster. Dept‑channel groups are never written to
        // /conversations/mine, so on a fresh login / reinstall / 2nd-admin device
        // convo.participants is empty → the group fan-out throws "no other participants"
        // (D3-a) and the key self-heal has no peer to ask for the key (D2-d). listMembers
        // IS the server's authoritative membership, so sourcing recipients from it upholds
        // the "server authoritative for membership" invariant. METADATA ONLY — this never
        // touches the master key (which lives in store.groups, keyed separately).
        try {
          const {data} = await departmentApi.listMembers(channelId);
          const memberIds = data.members.map(m => m.user_id).filter(Boolean);
          const st = useMessengerStore.getState();
          // Names for the sender label (#1) + @mention picker (#3): map userId → display name
          // from the roster so a bubble shows the REAL name, not a userId prefix.
          for (const mem of data.members) {
            st.setGroupMemberName(groupConversationId, mem.user_id, mem.display_name || mem.user_id.slice(0, 8));
          }
          // Refresh my role (#2) so a downgrade to viewer hides the composer on next focus.
          setMyRole(data.my_role === 'admin' ? 'admin' : 'viewer');
          if (memberIds.length) {
            const existing = st.conversations[groupConversationId];
            st.upsertConversation({
              ...(existing ?? {
                unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
                peer: {userId: memberIds.find(id => id !== myId) ?? memberIds[0], deviceId: 1},
                session_state: 'fresh',
              }),
              id: groupConversationId,
              type: 'group',
              name: channelName,
              participants: memberIds,
            });
          }
        } catch { /* best-effort — a roster fetch miss must not block the thread */ }
        // Self-heal — if we hold this department group but have no master key for it
        // (logged back in / reinstalled / missed the fan-out), ask the owner to re-share it
        // so messages decrypt and the thread fills in. Runs AFTER hydration so the resync
        // has participants to request from. Rate-limited inside the runtime; no-op once present.
        if (!useMessengerStore.getState().groups[groupConversationId]?.masterKeyB64) {
          try {
            const rt = await getMessengerRuntime('production');
            await rt.requestGroupKeyResync?.(groupConversationId);
          } catch { /* best-effort */ }
        }
      })();
      return () => {
        try {
          const live = useMessengerStore.getState().activeConversationId;
          if (live === groupConversationId) {
            useMessengerStore.getState().setActiveConversation(null);
          }
        } catch { /* defensive — store could be torn down on app exit */ }
      };
    }, [groupConversationId, channelId, channelName, myId]),
  );

  // D1-h — while unprovisioned, re-read the channel on focus so the "not yet active" state
  // clears the moment an admin provisions it, without having to leave and re-enter the thread.
  useFocusEffect(
    useCallback(() => {
      if (groupConversationId) {return;}
      let cancelled = false;
      void (async () => {
        try {
          const {data} = await departmentApi.listChannels();
          const ch = data.channels.find(c => c.id === channelId);
          if (!cancelled && ch?.group_conversation_id) {setGroupConversationId(ch.group_conversation_id);}
        } catch { /* best-effort */ }
      })();
      return () => { cancelled = true; };
    }, [groupConversationId, channelId]),
  );

  const send = useCallback(async () => {
    let text = draft.trim();
    if (!text || sending || !groupConversationId) {return;}
    // #4 — inline slash command: "/announce <text>" posts as an announcement.
    let isAnnounce = announce;
    if (/^\/announce\b/i.test(text)) { text = text.replace(/^\/announce\s*/i, '').trim(); isAnnounce = true; }
    if (!text) {return;} // a bare "/announce" with no body — nothing to send
    setSending(true);
    // #2 — re-verify role at send time so a member JUST downgraded to viewer can't post. Group
    // sends are E2EE + client-fanned-out, so there is no server gate; this is the enforcement.
    try {
      const {data} = await departmentApi.listMembers(channelId);
      setMyRole(data.my_role === 'admin' ? 'admin' : 'viewer');
      if (data.my_role !== 'admin') {
        setSending(false);
        Alert.alert('Read-only', 'You no longer have permission to post in this channel.');
        return;
      }
    } catch { /* offline: fall back to the cached role gate below (best we can do) */ }
    if (myRole !== 'admin') { setSending(false); return; }
    // Announcement rides as a prefixed body (no backend message-type needed) — the
    // renderer styles it + shows a megaphone; recipients whose name is @mentioned in
    // the body get a highlighted bubble.
    const body = isAnnounce ? `${ANNOUNCE_PREFIX}${text}` : text;
    setDraft('');
    setMentionQuery(null);
    setSlashQuery(null);
    try {
      const rt = await getMessengerRuntime('production');
      // Same encrypted group fan-out every Bravo group chat uses — broadcastToGroup seals one
      // envelope per member under their pairwise Signal session, master-key-wrapped.
      await rt.sendText(groupConversationId, body);
      setAnnounce(false);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({animated: true}));
    } catch (e) {
      // Surface the REAL failure (e.g. group not synced yet) and restore the draft so the
      // post isn't lost. A merely-offline channel keeps the post durably queued, not thrown.
      setDraft(text);
      Alert.alert('Could not post', (e as Error).message || 'Message could not be sent.');
    } finally {
      setSending(false);
    }
  }, [draft, sending, myRole, groupConversationId, channelId, announce]);

  // Channel exists in metadata but no Signal group has been bootstrapped yet
  // (admin hasn't opened it on a device). Honest empty state, not a fake feed.
  const notProvisioned = !groupConversationId;

  return (
    <KeyboardAvoidingView
      style={[styles.root, {paddingTop: insets.top}, Platform.OS === 'android' && {paddingBottom: kbHeight}]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.hBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>

        <LinearGradient
          colors={['rgba(91,141,239,0.22)', 'rgba(47,91,224,0.06)']}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={styles.glyphTile}>
          <Icon name="pound" size={20} color={OB.accentSoft} />
        </LinearGradient>

        <View style={styles.headerMeta}>
          <Text style={styles.headerTitle} numberOfLines={1}>{channelName}</Text>
          <View style={styles.metaRow}>
            {memberCount > 0 ? (
              <>
                <Text style={styles.metaText}>{memberCount} {memberCount === 1 ? 'member' : 'members'}</Text>
                <View style={styles.metaDot} />
              </>
            ) : null}
            <Icon name="lock" size={11} color={OB.signal} />
            <Text style={styles.metaEnc}>Encrypted</Text>
          </View>
        </View>

        {myRole === 'admin' ? (
          <TouchableOpacity
            style={styles.hBtn}
            activeOpacity={0.7}
            hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
            onPress={() => (navigation as any).navigate('ChannelMembers', {channelId, channelName, isOwner})}>
            <Icon name="account-multiple-outline" size={19} color={OB.accentSoft} />
          </TouchableOpacity>
        ) : (
          <View style={styles.hBtn} />
        )}
      </View>

      {/* Pinned channel description as a notice */}
      {!!channelDesc && (
        <View style={styles.notice}>
          <Icon name="pin-outline" size={13} color={OB.accentSoft} />
          <Text style={styles.noticeText} numberOfLines={2}>{channelDesc}</Text>
        </View>
      )}

      {notProvisioned ? (
        <View style={styles.loader}>
          <View style={styles.emptyIcon}>
            <Icon name="lock-clock" size={30} color={OB.textMute} />
          </View>
          <Text style={styles.emptyTitle}>Channel not yet active</Text>
          <Text style={styles.emptySub}>
            An admin needs to open this channel on their device to set up its
            encrypted group before messages can flow.
          </Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.feedScroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.feed}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({animated: false})}>
          {messages.length === 0 ? (
            <View style={styles.emptyInline}>
              <Text style={styles.emptySub}>No messages yet.</Text>
            </View>
          ) : (
            messages.map((m, i) => {
              const mine = m.sender_id === 'self' || m.sender_id === myId;
              const accent = colorForSender(m.sender_id);
              // #1 — resolve the REAL display name from the roster (hydrated on focus); fall back
              // to any embedded sender_name, then a short id only if the name isn't known yet.
              const senderName = memberNames?.[m.sender_id]
                ?? (m as {sender_name?: string}).sender_name ?? m.sender_id.slice(0, 8);
              const rawBody = m.content ?? '';
              const isAnn = rawBody.startsWith(ANNOUNCE_PREFIX);
              const body = isAnn ? rawBody.slice(ANNOUNCE_PREFIX.length) : rawBody;
              const segs = parseSegments(body);
              const iAmMentioned = !mine && segs.some(s => s.userId === myId);
              const prev = i > 0 ? messages[i - 1] : null;
              const showDay = !prev || !sameDay(prev.created_at, m.created_at);
              // Group consecutive same-sender incoming messages under one avatar + name header.
              const showHeader = !mine && (showDay || !prev || prev.sender_id !== m.sender_id);
              return (
                <View key={m.id}>
                  {showDay && (
                    <View style={styles.dayDivider}>
                      <View style={styles.dayLine} />
                      <Text style={styles.dayLabel}>{dayLabel(m.created_at)} · {formatTime(m.created_at)}</Text>
                      <View style={styles.dayLine} />
                    </View>
                  )}
                  <View style={[styles.msgRow, mine && styles.msgRowMine]}>
                    {!mine && (
                      showHeader ? (
                        <LinearGradient
                          colors={[accent, accent + '99']}
                          start={{x: 0, y: 0}}
                          end={{x: 1, y: 1}}
                          style={styles.avatar}>
                          <Text style={styles.avatarText}>{initialsFor(senderName)}</Text>
                        </LinearGradient>
                      ) : <View style={styles.avatarSpacer} />
                    )}
                    <View style={[styles.msgCol, mine && styles.msgColMine]}>
                      {showHeader && (
                        <Text style={[styles.senderName, {color: accent}]} numberOfLines={1}>{senderName}</Text>
                      )}
                      <View style={[
                        styles.bubble,
                        mine ? styles.bubbleMine : styles.bubbleIn,
                        isAnn && styles.bubbleAnnounce,
                        iAmMentioned && styles.bubbleMentioned,
                      ]}>
                        {!mine && <View style={styles.bubbleEdge} />}
                        {isAnn && (
                          <View style={styles.annHead}>
                            <Icon name="bullhorn-variant" size={13} color={OB.amber} />
                            <Text style={styles.annLabel}>ANNOUNCEMENT</Text>
                          </View>
                        )}
                        {!!body && (
                          <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>
                            {segs.map((s, si) => s.mention
                              ? <Text key={si} style={[styles.mention, s.userId === myId && styles.mentionSelf]}>@{s.mention}</Text>
                              : <Text key={si}>{s.text}</Text>)}
                          </Text>
                        )}
                        {!!m.media_object_key && (
                          <TouchableOpacity
                            style={styles.fileCard}
                            activeOpacity={0.85}
                            onPress={() => setViewerTarget({
                              id:               m.id,
                              conversationId:   m.conversation_id,
                              name:             m.media_meta?.name || (m.media_mime ?? 'Attachment'),
                              media_object_key: m.media_object_key,
                              media_key:        m.media_key,
                              media_iv:         m.media_iv,
                              media_mime:       m.media_mime,
                              sizeBytes:        m.media_meta?.sizeBytes,
                              createdAt:        new Date(m.created_at).getTime(),
                            })}>
                            <View style={styles.fileIcon}>
                              <Icon name="file-document-outline" size={18} color={OB.accentSoft} />
                            </View>
                            <Text style={styles.fileName} numberOfLines={1}>{m.media_meta?.name || (m.media_mime ?? 'Attachment')}</Text>
                            <View style={styles.fileOpenBtn}><Text style={styles.fileOpenText}>OPEN</Text></View>
                          </TouchableOpacity>
                        )}
                      </View>
                      <View style={[styles.meta, mine && styles.metaMine]}>
                        <Text style={styles.metaTime}>{formatTime(m.created_at)}</Text>
                        {mine && <Icon name="check-all" size={13} color={OB.accent} />}
                      </View>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Composer — admins post; viewers see the read-only notice instead */}
      {myRole === 'admin' && !notProvisioned ? (
        <View>
          {/* #4 — slash-command palette (Discord-style), shown while typing "/…" */}
          {slashSuggestions.length > 0 && (
            <View style={styles.slashBar}>
              {slashSuggestions.map(c => (
                <TouchableOpacity key={c.cmd} style={styles.slashRow} activeOpacity={0.8}
                  onPress={() => applySlash(c.cmd)}>
                  <Icon name={c.icon as IconName} size={16} color={OB.accentSoft} />
                  <Text style={styles.slashCmd}>{c.cmd}</Text>
                  <Text style={styles.slashDesc} numberOfLines={1}>{c.desc}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {/* @mention autocomplete (top 5, keyword-filtered) */}
          {suggestions.length > 0 && (
            <View style={styles.mentionBar}>
              {suggestions.map(([uid, name]) => (
                <TouchableOpacity key={uid} style={styles.mentionChip} activeOpacity={0.8}
                  onPress={() => insertMention(uid, name)}>
                  <Icon name="at" size={13} color={OB.accentSoft} />
                  <Text style={styles.mentionChipText} numberOfLines={1}>{name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          <View style={[styles.composer, {paddingBottom: insets.bottom + 12}]}>
            <TouchableOpacity
              style={[styles.annToggle, announce && styles.annToggleOn]}
              onPress={() => setAnnounce(a => !a)}
              activeOpacity={0.8}>
              <Icon name="bullhorn-variant" size={18} color={announce ? '#1A1710' : OB.textMute} />
            </TouchableOpacity>
            <View style={styles.inputPill}>
              <Icon name="lock" size={13} color={OB.signal} />
              <TextInput
                style={styles.input}
                placeholder={announce ? 'Post an announcement…' : `Post to ${channelName}…  @ to mention`}
                placeholderTextColor={OB.textMute}
                value={draft}
                onChangeText={onDraftChange}
                multiline
              />
            </View>
            <TouchableOpacity
              onPress={() => { void send(); }}
              disabled={!draft.trim() || sending}
              activeOpacity={0.85}>
              <LinearGradient
                colors={['#7FA8FF', OB.accent, OB.accentDeep]}
                start={{x: 0.3, y: 0}}
                end={{x: 0.8, y: 1}}
                style={[styles.sendBtn, (!draft.trim() || sending) && {opacity: 0.5}]}>
                {sending
                  ? <ActivityIndicator color="#FFF" size="small" />
                  : <Icon name="send" size={18} color="#FFF" />}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      ) : !notProvisioned ? (
        <View style={[styles.viewerBar, {paddingBottom: insets.bottom + 12}]}>
          <Icon name="eye-outline" size={15} color={OB.textMute} />
          <Text style={styles.viewerText}>You are a viewer</Text>
        </View>
      ) : null}
      <AttachmentFileViewer target={viewerTarget} onClose={() => setViewerTarget(null)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  loader: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 36},
  emptyIcon: {
    width: 72, height: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: OB.hair2,
  },

  // Header
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 13, borderBottomWidth: 1, borderBottomColor: OB.hair},
  hBtn: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  glyphTile: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
  },
  headerMeta: {flex: 1, minWidth: 0},
  headerTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16, letterSpacing: -0.2},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3},
  metaText: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10},
  metaDot: {width: 3, height: 3, borderRadius: 2, backgroundColor: OB.textMute},
  metaEnc: {color: OB.signal, fontFamily: BravoFont.mono, fontSize: 10},

  notice: {flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 16, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: OB.hair},
  noticeText: {flex: 1, color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16},

  feedScroll: {flex: 1},
  feed: {paddingHorizontal: 16, paddingVertical: 14, gap: 14, flexGrow: 1, justifyContent: 'flex-end'},
  emptyInline: {alignItems: 'center', paddingVertical: 24},
  emptyTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16},
  emptySub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', lineHeight: 18},

  // Day divider
  dayDivider: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 28, marginBottom: 14},
  dayLine: {flex: 1, height: 1, backgroundColor: OB.hair},
  dayLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1.3, textTransform: 'uppercase'},

  // Message row + grouping
  msgRow: {flexDirection: 'row', gap: 10, alignItems: 'flex-start'},
  msgRowMine: {justifyContent: 'flex-end'},
  avatar: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: 2,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  avatarText: {color: '#FFF', fontFamily: BravoFont.bold, fontSize: 11.5},
  avatarSpacer: {width: 32},
  msgCol: {flex: 1, minWidth: 0, alignItems: 'flex-start', maxWidth: '86%'},
  msgColMine: {alignItems: 'flex-end'},
  senderName: {fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6, marginLeft: 2, maxWidth: 200},

  bubble: {position: 'relative', overflow: 'hidden', maxWidth: '100%', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 11, gap: 8},
  bubbleIn: {backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: OB.hair2, borderRadius: 16, borderTopLeftRadius: 4},
  bubbleMine: {backgroundColor: OB.accentDeep, borderWidth: 1, borderColor: 'rgba(127,168,255,0.4)', borderRadius: 16, borderTopRightRadius: 4},
  bubbleEdge: {position: 'absolute', top: 0, left: 12, right: 12, height: 1, backgroundColor: 'rgba(255,255,255,0.12)'},
  bubbleText: {color: OB.text, fontFamily: BravoFont.regular, fontSize: 14, lineHeight: 20, letterSpacing: -0.1},
  bubbleTextMine: {color: '#F4F7FF'},

  meta: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingLeft: 4},
  metaMine: {justifyContent: 'flex-end', paddingLeft: 0, paddingRight: 2},
  metaTime: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5},

  // @mention + announcement
  mention: {color: OB.accentSoft, fontFamily: BravoFont.semiBold},
  mentionSelf: {color: OB.amber},
  bubbleAnnounce: {borderColor: OB.amber, backgroundColor: 'rgba(226,200,147,0.08)'},
  bubbleMentioned: {borderColor: 'rgba(226,200,147,0.5)'},
  annHead: {flexDirection: 'row', alignItems: 'center', gap: 5},
  annLabel: {color: OB.amber, fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '800', letterSpacing: 1},

  // File card
  fileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 11, borderRadius: 14,
    backgroundColor: 'rgba(17,21,29,0.6)', borderWidth: 1, borderColor: OB.hair2,
  },
  fileIcon: {
    width: 38, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
  },
  fileName: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12.5, letterSpacing: -0.1},
  fileOpenBtn: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9, backgroundColor: 'rgba(91,141,239,0.13)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  fileOpenText: {color: OB.accentSoft, fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.2},

  // Autocomplete bars
  mentionBar: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  mentionChip: {flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)', borderRadius: 14, paddingHorizontal: 9, paddingVertical: 5, maxWidth: 150},
  mentionChipText: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12},
  slashBar: {paddingVertical: 4, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  slashRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 9},
  slashCmd: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13},
  slashDesc: {flex: 1, color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5},

  // Composer
  composer: {flexDirection: 'row', alignItems: 'flex-end', gap: 9, paddingHorizontal: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: OB.bg},
  annToggle: {
    width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  annToggleOn: {backgroundColor: OB.amber, borderColor: OB.amber},
  inputPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 42, maxHeight: 120,
    borderRadius: 21, paddingLeft: 14, paddingRight: 12, paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  input: {flex: 1, color: OB.text, fontFamily: BravoFont.regular, fontSize: 14, paddingVertical: Platform.OS === 'ios' ? 8 : 4, maxHeight: 110},
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.4, shadowRadius: 16, elevation: 6,
  },

  viewerBar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  viewerText: {color: OB.textMute, fontFamily: BravoFont.semiBold, fontSize: 12.5},
}));
