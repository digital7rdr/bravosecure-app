import React, {useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Vibration,
  Image,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardHeight} from '@hooks/useKeyboardHeight';
import {Colors} from '@theme/index';
import type {MessengerScreenProps} from '@navigation/types';
import {useMessengerStore} from '@/modules/messenger/store';
import {useMessenger} from '@/modules/messenger/hooks';
import {addBlockedPeer, removeBlockedPeer} from '@/modules/messenger/runtime/blockedPeers';
import {writeServerRosterOrQueue} from '@/modules/messenger/runtime/pendingRosterIntents';
import {useAuthStore} from '@store/authStore';
import {DEV_CONTACTS} from '@/modules/messenger/dev/devContacts';
import {launchCall} from '@/modules/messenger/webrtc/launchCall';
import {UsersHttpClient} from '@bravo/messenger-core';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import * as Clipboard from 'expo-clipboard';
import {scaleTextStyles} from '@utils/scaling';

type Props = MessengerScreenProps<'ChatInfo'>;

const TTL_CHOICES: {label: string; sec: number | null}[] = [
  {label: 'Off',         sec: null},
  {label: '1 hour',      sec: 3600},
  {label: '24 hours',    sec: 24 * 3600},
  {label: '7 days',      sec: 7 * 24 * 3600},
];

function prettyTtl(sec: number | null): string {
  if (sec === null) {return 'Off';}
  if (sec < 3600) {return `${Math.round(sec / 60)} min`;}
  if (sec < 86400) {return `${Math.round(sec / 3600)} h`;}
  return `${Math.round(sec / 86400)} d`;
}

// Why: audit S12 — the previous FNV-1a hash of conversationId produced
// the same fingerprint for both peers regardless of their identity
// keys, so a MITM would still "verify". The real safety number is
// computed by the runtime over both identity public keys.

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

function avatarColor(seed: string): string {
  const palette = ['#1E88FF', '#7C3AED', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#14B8A6'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {h = (h * 31 + seed.charCodeAt(i)) >>> 0;}
  return palette[h % palette.length];
}

function resolveUserName(
  userId: string,
  selfId: string | undefined,
  selfName: string | undefined,
  conversations: Record<string, {peer?: {userId: string}; type: string; name?: string}>,
): string {
  if (userId === selfId || userId === 'self') {return selfName ? `${selfName} (You)` : 'You';}
  // Best source: an existing direct conversation with this user — that
  // row's name is whatever the contact-discovery flow already resolved
  // (typically the user's display_name from the auth-service profile).
  // Without this, group members fall through to the 8-char uuid-prefix
  // and the group info screen looks like a list of opaque hashes.
  const direct = Object.values(conversations).find(
    c => c.type === 'direct' && c.peer?.userId === userId && c.name,
  );
  if (direct?.name) {return direct.name;}
  // Dev/local contacts (used in early test rigs).
  const dev = DEV_CONTACTS.find(c => c.userId === userId);
  if (dev) {return dev.name;}
  return userId.slice(0, 8);
}

function resolveUserPhone(userId: string): string | undefined {
  const dev = DEV_CONTACTS.find(c => c.userId === userId);
  return dev?.phoneE164;
}

export default function ChatInfoScreen({navigation, route}: Props) {
  const {conversationId} = route.params;
  const insets = useSafeAreaInsets();
  // B-84 / KB-10 — Android Modal windows don't resize for the IME.
  const kbHeight = useKeyboardHeight();
  const conversation = useMessengerStore(s => s.conversations[conversationId]);
  const currentUser  = useAuthStore(s => s.user);
  const removeConversation = useMessengerStore(s => s.removeConversation);
  const clearMessages      = useMessengerStore(s => s.clearMessages);
  const setConversationMuted = useMessengerStore(s => s.setConversationMuted);
  const setConversationTtl   = useMessengerStore(s => s.setConversationTtl);
  const {runtime} = useMessenger();
  const [resetting, setResetting] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const groupNameMap = useMessengerStore(s => s.groupMemberNames[conversationId]);
  const setGroupMemberName = useMessengerStore(s => s.setGroupMemberName);

  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );

  const upsertConversation = useMessengerStore(s => s.upsertConversation);

  const blockPeer = () => {
    if (!conversation?.peer || isGroup || blocking) {return;}
    const peerId = conversation.peer.userId;
    // Why: optimistic UX. The previous flow waited on the HTTP round-
    // trip before removing the conversation + popping, which felt
    // unresponsive on a flaky network. Block now feels instant — pop
    // first, reconcile on failure by re-inserting the snapshot.
    const snapshot = conversation;
    setBlocking(true);
    removeConversation(conversationId);
    // M-07 — record the block locally so the receive path drops (and doesn't
    // resurrect) inbound messages from this peer; sealed sender means the relay
    // can't gate delivery, so the recipient client is the only enforcement point.
    void addBlockedPeer(peerId);
    navigation.goBack();
    void (async () => {
      try {
        await usersClient.block(peerId);
      } catch (e) {
        // Block failed server-side — roll the local block back too.
        void removeBlockedPeer(peerId);
        // Restore the conversation so the user can see what happened
        // and retry. Surface the error via the global messenger error
        // banner since the screen has already been popped.
        upsertConversation(snapshot);
        useMessengerStore.getState().setError(
          `Block failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        );
      } finally {
        setBlocking(false);
      }
    })();
  };

  const isMuted = !!conversation?.is_muted;
  const ttlSec  = conversation?.default_ttl_sec ?? null;

  const [ttlPickerOpen, setTtlPickerOpen] = useState(false);
  const [fingerprintOpen, setFingerprintOpen] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  const [safetyCopied, setSafetyCopied] = useState(false);
  // Audit P0-I3 / P0-1 — verification state mirrors the persisted ack
  // in trusted_identities. `verifiedAtMs` is set once the user taps
  // "Mark as verified"; cleared by saveIdentity on any subsequent key
  // flip (the store auto-clears) OR by the explicit "Clear" button.
  const [verifiedAtMs, setVerifiedAtMs] = useState<number | null>(null);
  const [verifyBusy,   setVerifyBusy]   = useState(false);

  // Load the real safety number on demand when the user opens the
  // fingerprint modal. Lazy because the production path may need a
  // server round-trip (recipientIdentityKeyB64 prefers the latest
  // server-side bundle over a stale local cache).
  useEffect(() => {
    if (!fingerprintOpen || !runtime || !conversation?.peer || conversation.type !== 'direct') {return;}
    const peer = conversation.peer;
    let cancelled = false;
    setSafetyNumber(null);
    setSafetyError(null);
    setSafetyCopied(false);
    setVerifiedAtMs(null);
    void (async () => {
      try {
        const code = await runtime.getSafetyNumber(peer);
        if (!cancelled) {setSafetyNumber(code);}
        // Audit P0-I3 — pull the persisted verification ack so the CTA
        // can render the right state on open. Null = TOFU-trusted only.
        try {
          const v = await runtime.getPeerVerification(peer);
          if (!cancelled) {setVerifiedAtMs(v?.verifiedAtMs ?? null);}
        } catch { /* non-fatal — leave CTA in unverified state */ }
      } catch (e) {
        if (!cancelled) {setSafetyError(e instanceof Error ? e.message : 'Could not load fingerprint');}
      }
    })();
    return () => { cancelled = true; };
  }, [fingerprintOpen, runtime, conversation?.peer, conversation?.type]);

  // Audit P0-I3 — toggle the verification record. Disabled while the
  // safety number is still loading (we'd hash an empty string), while
  // the runtime call is in flight, and for group conversations.
  const onToggleVerified = async (): Promise<void> => {
    if (!runtime || !conversation?.peer || conversation.type !== 'direct') {return;}
    if (!safetyNumber || verifyBusy) {return;}
    setVerifyBusy(true);
    try {
      if (verifiedAtMs !== null) {
        await runtime.clearPeerVerification(conversation.peer);
        setVerifiedAtMs(null);
      } else {
        const ok = await runtime.markPeerVerified(conversation.peer, safetyNumber);
        if (ok) {setVerifiedAtMs(Date.now());}
      }
    } catch {
      // Surface as an inline error inside the modal — don't crash the
      // screen if the store reject the call (e.g. peer has no trust
      // row yet because we've never decrypted anything from them).
      setSafetyError('Could not update verification status');
    } finally {
      setVerifyBusy(false);
    }
  };

  const isGroup = conversation?.type === 'group';
  // In this local-admin model the group creator (self) is the admin.
  // Future: read admin roles off the conversation record when M-roles lands.
  const isAdmin = isGroup;
  // GRP-20/25 — real admin flag from the E2EE group state (members map
  // carries {admin}). Gates the destructive "Remove from group" action;
  // the runtime re-checks and throws for non-admins anyway.
  const groupState = useMessengerStore(s => s.groups[conversationId]);
  const isGroupAdmin = !!(currentUser?.id && groupState?.members?.[currentUser.id]?.admin);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameUserId, setRenameUserId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameProfile, setRenameProfile] = useState('');
  const [removingMember, setRemovingMember] = useState(false);

  // Pull the full conversations map so resolveUserName can look up
  // peer names from existing direct chats — that's the only name
  // source we have today besides the per-group rename overrides.
  const allConversations = useMessengerStore(s => s.conversations);
  // Fix #37: build a stable signature of the only fields the members
  // useMemo actually consumes (peer userId + name + type per
  // conversation). Without this, ANY mutation to ANY conversation
  // (unread count bump on a 1:1, last_message tick on an unrelated
  // group, etc.) re-ran the members computation. The signature is a
  // joined string sorted by id so it's stable across reorderings of
  // the underlying object's keys.
  const conversationsNameSignature = useMemo(() => {
    const parts: string[] = [];
    const ids = Object.keys(allConversations).sort();
    for (const id of ids) {
      const c = allConversations[id];
      parts.push(`${id}:${c.type}:${c.name ?? ''}:${c.peer?.userId ?? ''}`);
    }
    return parts.join('|');
  }, [allConversations]);

  const members = useMemo(() => {
    if (!conversation) {return [];}
    return (conversation.participants ?? []).map(userId => {
      const profileName = resolveUserName(
        userId, currentUser?.id, currentUser?.full_name ?? undefined,
        allConversations as unknown as Record<string, {peer?: {userId: string}; type: string; name?: string}>,
      );
      const override    = groupNameMap?.[userId];
      return {
        userId,
        name:        override ?? profileName,
        profileName,
        overridden:  !!override,
        phone:       resolveUserPhone(userId),
        isSelf:      userId === currentUser?.id || userId === 'self',
      };
    });
    // allConversations intentionally omitted — we depend on the
    // signature instead, which only flips on members-relevant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, currentUser, groupNameMap, conversationsNameSignature]);

  // BS-MEMBER-AVATARS — fetch member profile photos by userId. The server
  // returns avatarUrl only for non-blocked, known users; everyone else
  // falls back to coloured initials below. Best-effort: a failed fetch
  // simply leaves the initials in place.
  const [memberAvatars, setMemberAvatars] = useState<Record<string, string | null>>({});
  const memberIdSignature = members.map(m => m.userId).sort().join(',');
  useEffect(() => {
    const ids = memberIdSignature ? memberIdSignature.split(',') : [];
    if (ids.length === 0) {return;}
    let cancelled = false;
    void usersClient.getProfilesByIds(ids)
      .then(profiles => {
        if (cancelled) {return;}
        const map: Record<string, string | null> = {};
        for (const p of profiles) {map[p.userId] = p.avatarUrl;}
        setMemberAvatars(prev => ({...prev, ...map}));
      })
      .catch(() => { /* best-effort — initials remain */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIdSignature]);

  // Peer userId for a 1:1 conversation (used to show their avatar at the
  // top). Null for groups / when the peer isn't resolved.
  const peerId = (!isGroup && conversation?.peer?.userId) ? conversation.peer.userId : null;

  const openRename = (userId: string, current: string, profile: string) => {
    setRenameUserId(userId);
    setRenameValue(current);
    setRenameProfile(profile);
    setRenameOpen(true);
  };

  const saveRename = () => {
    if (!renameUserId) {return;}
    const trimmed = renameValue.trim();
    // Empty value clears the override and restores the profile name.
    setGroupMemberName(
      conversationId,
      renameUserId,
      trimmed && trimmed !== renameProfile ? trimmed : null,
    );
    setRenameOpen(false);
    setRenameUserId(null);
  };

  const resetToProfile = () => {
    if (!renameUserId) {return;}
    setGroupMemberName(conversationId, renameUserId, null);
    setRenameOpen(false);
    setRenameUserId(null);
  };

  // GRP-20/25 — admin removes a member. removeGroupMember rekeys the group
  // (remove @ epoch E, fresh master key @ E+1) and fails fast BEFORE any
  // state change, so a failure here leaves the group intact.
  const confirmRemoveMember = () => {
    const removeFn = runtime?.removeGroupMember;
    if (!renameUserId || removingMember || !removeFn) {return;}
    const target = members.find(m => m.userId === renameUserId);
    if (!target || target.isSelf) {return;}
    Alert.alert(
      'Remove from group?',
      `Remove ${target.name}? They will no longer receive new messages.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setRemovingMember(true);
              try {
                await removeFn({groupId: conversationId, removedUserId: target.userId});
                // P1-5 — the local crypto rekey above already excludes the
                // member from the new master key; now reconcile the SERVER
                // roster so the next /conversations/mine sync can't resurrect
                // them into fan-out (media keys + download grants). A failed
                // write is durably queued + retried; until then the Home sync
                // guard keeps the local (shrunk) participants authoritative.
                const ownerKey = useMessengerStore.getState()._ownUserId ?? undefined;
                const res = await writeServerRosterOrQueue({
                  conversationId, memberUserId: target.userId, action: 'remove', ownerKey,
                });
                if (res.queued) {
                  useMessengerStore.getState().setError(
                    'Member removed on this device. The group roster will finish syncing when you reconnect.',
                  );
                }
                setRenameOpen(false);
                setRenameUserId(null);
              } catch (e) {
                Alert.alert('Remove failed', e instanceof Error ? e.message : 'Could not remove this member.');
              } finally {
                setRemovingMember(false);
              }
            })();
          },
        },
      ],
    );
  };

  if (!conversation) {
    return (
      <View style={[styles.root, {paddingTop: insets.top, justifyContent: 'center', alignItems: 'center'}]}>
        <Text style={{color: '#7E8AA6', fontSize: 13}}>Conversation not found.</Text>
      </View>
    );
  }

  const title     = conversation.name ?? 'Chat';
  const partLen = conversation.participants?.length ?? 0;
  const subtitle  = isGroup
    ? `${partLen} ${partLen === 1 ? 'member' : 'members'}`
    : conversation.phoneE164 ?? resolveUserPhone(conversation.peer.userId) ?? '';

  const handleResetSession = () => {
    if (!runtime || !conversation?.peer || isGroup) {return;}
    Alert.alert(
      'Reset secure session?',
      'Use this if recent messages from this contact show "decrypt failed" — usually because they reinstalled. Your local session is rebuilt; the next message you send will rebuild theirs too.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setResetting(true);
              try {
                await runtime.resetSessionWith(conversation.peer);
                Alert.alert('Session reset', 'Send a message to complete the rebuild on their side.');
              } catch (e) {
                Alert.alert('Reset failed', e instanceof Error ? e.message : 'Could not refetch peer keys.');
              } finally {
                setResetting(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handleDelete = () => {
    Alert.alert(
      isGroup ? 'Leave group?' : 'Delete chat?',
      isGroup
        ? 'You will leave the group and the other members are notified that you left. This device drops the chat and its key.'
        : 'The chat is removed entirely from this device — both the conversation row and all messages and call records.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: isGroup ? 'Leave' : 'Delete', style: 'destructive', onPress: () => {
          void (async () => {
            // P1-G4 — for a group, broadcast leave + rekey to the remaining
            // members (forward secrecy) BEFORE dropping it locally. Best-effort:
            // a failed fan-out must not strand the user in a group they left, so
            // the local removal below always runs.
            if (isGroup) {
              try { await runtime?.leaveGroup?.({groupId: conversationId}); }
              catch (e) { console.warn('[ChatInfo.leaveGroup] failed:', (e as Error).message); }
              // P1-5 — drop SELF from the server roster too. Without this the
              // server still lists us and /conversations/mine re-creates the
              // group on our next sync (the leave never "sticks"). Await BEFORE
              // the local removal below so a failed write enqueues its retry
              // intent before any Home sync runs — the guard then skips
              // re-creating this left group while the self-removal is pending.
              const selfId = currentUser?.id ?? useMessengerStore.getState()._ownUserId;
              if (selfId) {
                const res = await writeServerRosterOrQueue({
                  conversationId, memberUserId: selfId, action: 'remove',
                  ownerKey: useMessengerStore.getState()._ownUserId ?? undefined,
                }).catch(() => ({queued: false} as const));
                if (res.queued) {
                  useMessengerStore.getState().setError(
                    'You left the group. The roster will finish syncing when you reconnect.',
                  );
                }
              }
            }
            removeConversation(conversationId);
            navigation.navigate('MessengerHome');
          })();
        }},
      ],
    );
  };

  const handleClearMessages = () => {
    Alert.alert(
      'Clear messages?',
      'Every text, attachment, and call record in this chat will be removed from this device. The conversation itself stays in your list. Cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Clear', style: 'destructive', onPress: () => {
          // P2-10 — also drop every still-queued outbox row so the reconnect
          // drain doesn't ship a message the user just cleared.
          void runtime?.discardOutboxForConversation?.(conversationId).catch(() => { /* best-effort */ });
          clearMessages(conversationId);
          navigation.goBack();
        }},
      ],
    );
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#B8C7E0" />
          <Text style={styles.headerTitle}>{isGroup ? 'Group Info' : 'Chat Info'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[{paddingBottom: insets.bottom + 40}]}
        showsVerticalScrollIndicator={false}>

        {/* Profile */}
        <View style={styles.profileSection}>
          {!isGroup && peerId && memberAvatars[peerId]
            ? <Image source={{uri: memberAvatars[peerId]!}} style={styles.profileAvatar} />
            : (
              <View style={[styles.profileAvatar, {backgroundColor: avatarColor(conversation.id)}]}>
                {isGroup
                  ? <Icon name="account-group" size={40} color="#FFF" />
                  : <Text style={styles.profileInitials}>{initialsOf(title)}</Text>
                }
              </View>
            )}
          <Text style={styles.profileName}>{title}</Text>
          {!!subtitle && <Text style={styles.profilePhone}>{subtitle}</Text>}
          <View style={styles.e2eBadge}>
            <Icon name="lock" size={13} color="#4ade80" />
            <Text style={styles.e2eText}>AES-256 Encrypted</Text>
          </View>
        </View>

        {/* Quick actions */}
        <View style={styles.quickActionsRow}>
          <QuickAction
            icon="phone" color="#4ade80" bg="rgba(34,197,94,0.12)" border="rgba(34,197,94,0.25)" label="Call"
            onPress={() => launchCall(navigation, {conversationId, callType: 'voice'})} />
          <QuickAction
            icon="video" color="#1E88FF" bg="rgba(30,136,255,0.12)" border="rgba(30,136,255,0.25)" label="Video"
            onPress={() => launchCall(navigation, {conversationId, callType: 'video'})} />
          <QuickAction
            icon={isMuted ? 'bell' : 'bell-off'}
            color={isMuted ? '#F59E0B' : '#B8C7E0'}
            bg={isMuted ? 'rgba(245,158,11,0.12)' : 'rgba(100,116,139,0.12)'}
            border={isMuted ? 'rgba(245,158,11,0.3)' : 'rgba(100,116,139,0.25)'}
            label={isMuted ? 'Unmute' : 'Mute'}
            onPress={() => setConversationMuted(conversationId, !isMuted)} />
          <QuickAction
            icon={isGroup ? 'account-plus' : 'block-helper'}
            color={isGroup ? '#A78BFA' : '#f87171'}
            bg={isGroup ? 'rgba(167,139,250,0.1)' : 'rgba(239,68,68,0.1)'}
            border={isGroup ? 'rgba(167,139,250,0.25)' : 'rgba(239,68,68,0.2)'}
            label={isGroup ? 'Add' : 'Block'}
            onPress={isGroup
              ? () => navigation.navigate('NewChat')
              : () => Alert.alert('Block contact?', 'Incoming messages will be silently dropped. You can unblock from Settings.', [
                  {text: 'Cancel', style: 'cancel'},
                  {text: 'Block', style: 'destructive', onPress: blockPeer},
                ])
            } />
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Members — groups only */}
        {isGroup && (
          <>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>Members · {members.length}</Text>
              {isAdmin && <Text style={styles.sectionHint}>Tap to rename</Text>}
            </View>
            {/* BS-GROUP-ADD — add a member to an existing group. Routes to
                NewChat in add-to-group mode, which calls runtime.addGroupMember
                (rekeys the group epoch) on pick. */}
            {isAdmin && (
              <TouchableOpacity
                style={styles.addMemberRow}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('NewChat', {
                  addToGroupId: conversationId,
                  groupName:    title,
                })}>
                <View style={styles.addMemberIcon}>
                  <Icon name="account-plus" size={20} color={Colors.primary} />
                </View>
                <Text style={styles.addMemberText}>Add member</Text>
              </TouchableOpacity>
            )}
            {members.map(m => (
              <TouchableOpacity
                key={m.userId}
                style={styles.memberRow}
                activeOpacity={isAdmin && !m.isSelf ? 0.7 : 1}
                disabled={!isAdmin || m.isSelf}
                onPress={() => openRename(m.userId, m.name, m.profileName)}>
                {memberAvatars[m.userId]
                  ? <Image source={{uri: memberAvatars[m.userId]!}} style={styles.memberAvatar} />
                  : (
                    <View style={[styles.memberAvatar, {backgroundColor: avatarColor(m.userId)}]}>
                      <Text style={styles.memberInitials}>{initialsOf(m.profileName)}</Text>
                    </View>
                  )}
                <View style={{flex: 1, minWidth: 0}}>
                  <View style={styles.memberNameRow}>
                    <Text style={styles.memberName} numberOfLines={1}>{m.name}</Text>
                    {m.overridden && (
                      <View style={styles.aliasTag}>
                        <Icon name="pencil" size={9} color="#1E88FF" />
                        <Text style={styles.aliasTagText}>ALIAS</Text>
                      </View>
                    )}
                  </View>
                  {m.overridden
                    ? <Text style={styles.memberPhone} numberOfLines={1}>was {m.profileName}</Text>
                    : !!m.phone && <Text style={styles.memberPhone} numberOfLines={1}>{m.phone}</Text>
                  }
                </View>
                {m.isSelf
                  ? <Text style={styles.selfBadge}>YOU</Text>
                  : isAdmin && <Icon name="pencil-outline" size={16} color="#7E8AA6" />
                }
              </TouchableOpacity>
            ))}
            <View style={styles.divider} />
          </>
        )}

        {/* Settings */}
        <Text style={styles.sectionHeader}>Settings</Text>

        <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={() => setTtlPickerOpen(true)}>
          <View style={[styles.settingIcon, {backgroundColor: 'rgba(30,136,255,0.12)', borderColor: 'rgba(30,136,255,0.2)'}]}>
            <Icon name="send-clock" size={18} color="#1E88FF" />
          </View>
          <Text style={styles.settingTitle}>Disappearing Messages</Text>
          <Text style={[styles.settingRight, {color: '#1E88FF'}]}>{prettyTtl(ttlSec)}</Text>
        </TouchableOpacity>

        {!isGroup && (
          <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={() => setFingerprintOpen(true)}>
            <View style={[styles.settingIcon, {backgroundColor: 'rgba(234,179,8,0.1)', borderColor: 'rgba(234,179,8,0.2)'}]}>
              <Icon name="key-variant" size={18} color="#FBBF24" />
            </View>
            <Text style={styles.settingTitle}>Encryption Key</Text>
            <Text style={[styles.settingRight, {color: '#1E88FF'}]}>View Safety Number</Text>
          </TouchableOpacity>
        )}

        {/* Reset secure session — only meaningful for direct chats. */}
        {!isGroup && (
          <TouchableOpacity
            style={styles.settingRow}
            activeOpacity={0.8}
            onPress={handleResetSession}
            disabled={resetting}>
            <View style={[styles.settingIcon, {backgroundColor: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.2)'}]}>
              <Icon name="key-change" size={18} color="#F59E0B" />
            </View>
            <Text style={styles.settingTitle}>
              {resetting ? 'Resetting…' : 'Reset Secure Session'}
            </Text>
            <Text style={styles.settingRight}>Recovery</Text>
          </TouchableOpacity>
        )}

        {/* Clear messages — keeps the conversation row but wipes
            text bubbles, attachments, and call records. Useful for
            testing without re-creating the chat from scratch. */}
        {!isGroup && (
          <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={handleClearMessages}>
            <View style={[styles.settingIcon, {backgroundColor: 'rgba(251,191,36,0.08)', borderColor: 'rgba(251,191,36,0.2)'}]}>
              <Icon name="broom" size={18} color="#fbbf24" />
            </View>
            <Text style={[styles.settingTitle, {color: '#fbbf24'}]}>
              Clear Messages
            </Text>
          </TouchableOpacity>
        )}

        {/* Destructive action — removes the whole chat from the list. */}
        <TouchableOpacity style={styles.settingRow} activeOpacity={0.8} onPress={handleDelete}>
          <View style={[styles.settingIcon, {backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)'}]}>
            <Icon name={isGroup ? 'exit-run' : 'delete-sweep'} size={18} color="#ef4444" />
          </View>
          <Text style={[styles.settingTitle, {color: '#ef4444'}]}>
            {isGroup ? 'Exit Group' : 'Delete Chat'}
          </Text>
        </TouchableOpacity>

      </ScrollView>

      {/* Disappearing messages — TTL picker */}
      <Modal
        visible={ttlPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTtlPickerOpen(false)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setTtlPickerOpen(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Disappearing Messages</Text>
            <Text style={styles.modalSub}>Messages auto-burn after the chosen duration. Applies to all new messages in this chat.</Text>
            <View style={{marginTop: 12}}>
              {TTL_CHOICES.map(opt => {
                const active = opt.sec === ttlSec;
                return (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.ttlOption, active && styles.ttlOptionActive]}
                    onPress={() => { setConversationTtl(conversationId, opt.sec); setTtlPickerOpen(false); }}
                    activeOpacity={0.8}>
                    <Text style={[styles.ttlOptionText, active && {color: '#1E88FF'}]}>{opt.label}</Text>
                    {active && <Icon name="check" size={18} color="#1E88FF" />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Encryption fingerprint */}
      <Modal
        visible={fingerprintOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setFingerprintOpen(false)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setFingerprintOpen(false)}>
          <View style={styles.modalCard}>
            <View style={{alignItems: 'center', marginBottom: 12}}>
              <Icon name="shield-check" size={32} color="#4ade80" />
            </View>
            <Text style={[styles.modalTitle, {textAlign: 'center'}]}>Safety Number</Text>
            <Text style={[styles.modalSub, {textAlign: 'center'}]}>
              Compare these 60 digits with your contact in person, on a call, or via a trusted channel. If both phones show the same number, your conversation has not been intercepted.
            </Text>
            <View style={styles.fingerprintBox}>
              {safetyError
                ? <Text style={[styles.fingerprintText, {color: '#f87171'}]}>{safetyError}</Text>
                : safetyNumber
                  ? <Text style={styles.fingerprintText}>{safetyNumber}</Text>
                  : <Text style={[styles.fingerprintText, {color: '#7E8AA6'}]}>Computing…</Text>}
            </View>
            {/* Audit P0-I3 — verification status banner. Renders only
                once the safety number has resolved (so the CTA below
                can actually hash and persist it). */}
            {safetyNumber && (
              <View
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  alignSelf: 'center', marginTop: 12,
                }}>
                <Icon
                  name={verifiedAtMs !== null ? 'shield-check' : 'shield-alert-outline'}
                  size={14}
                  color={verifiedAtMs !== null ? '#4ade80' : '#7E8AA6'}
                />
                <Text style={{color: verifiedAtMs !== null ? '#4ade80' : '#7E8AA6', fontSize: 12}}>
                  {verifiedAtMs !== null
                    ? `Verified ${new Date(verifiedAtMs).toLocaleDateString()}`
                    : 'Not yet verified'}
                </Text>
              </View>
            )}
            <View style={{flexDirection: 'row', gap: 8, alignSelf: 'center', marginTop: 16, flexWrap: 'wrap', justifyContent: 'center'}}>
              <TouchableOpacity
                style={[styles.fingerprintAction, !safetyNumber && {opacity: 0.4}]}
                onPress={() => {
                  if (!safetyNumber) {return;}
                  void Clipboard.setStringAsync(safetyNumber);
                  Vibration.vibrate(8);
                  setSafetyCopied(true);
                  setTimeout(() => setSafetyCopied(false), 1400);
                }}
                disabled={!safetyNumber}
                activeOpacity={0.85}>
                <Icon name={safetyCopied ? 'check' : 'content-copy'} size={14} color="#1E88FF" />
                <Text style={styles.fingerprintActionText}>{safetyCopied ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
              {/* Audit P0-I3 — mark / clear verification CTA. */}
              <TouchableOpacity
                style={[styles.fingerprintAction, (!safetyNumber || verifyBusy) && {opacity: 0.4}]}
                onPress={() => { void onToggleVerified(); }}
                disabled={!safetyNumber || verifyBusy}
                activeOpacity={0.85}>
                <Icon
                  name={verifiedAtMs !== null ? 'shield-off-outline' : 'shield-check'}
                  size={14}
                  color="#1E88FF"
                />
                <Text style={styles.fingerprintActionText}>
                  {verifiedAtMs !== null ? 'Clear' : 'Mark verified'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalSave}
                onPress={() => setFingerprintOpen(false)}
                activeOpacity={0.85}>
                <Text style={styles.modalSaveText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Admin: rename member in this group */}
      <Modal
        visible={renameOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameOpen(false)}>
        <KeyboardAvoidingView
          style={[styles.modalOverlay, Platform.OS === 'android' && {paddingBottom: kbHeight}]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename member</Text>
            <Text style={styles.modalSub}>
              Only shown inside this group. Their profile stays as <Text style={{color: '#B8C7E0'}}>{renameProfile}</Text>.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={renameValue}
              onChangeText={setRenameValue}
              placeholder={renameProfile}
              placeholderTextColor="#7E8AA6"
              autoFocus
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={saveRename}
            />
            {/* GRP-20/25 — admin-only destructive removal (never for self) */}
            {isGroupAdmin && !!runtime?.removeGroupMember && (
              <TouchableOpacity
                style={[styles.modalRemoveRow, removingMember && {opacity: 0.5}]}
                onPress={confirmRemoveMember}
                disabled={removingMember}
                activeOpacity={0.8}>
                <Icon name="account-remove-outline" size={16} color="#F87171" />
                <Text style={styles.modalRemoveText}>
                  {removingMember ? 'Removing…' : 'Remove from group'}
                </Text>
              </TouchableOpacity>
            )}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={resetToProfile} activeOpacity={0.8}>
                <Text style={styles.modalResetText}>Reset</Text>
              </TouchableOpacity>
              <View style={{flex: 1}} />
              <TouchableOpacity style={styles.modalCancel} onPress={() => setRenameOpen(false)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSave} onPress={saveRename} activeOpacity={0.85}>
                <Text style={styles.modalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function QuickAction({icon, color, bg, border, label, onPress}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  color: string; bg: string; border: string; label: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity style={styles.quickAction} activeOpacity={0.8} onPress={onPress}>
      <View style={[styles.quickCircle, {backgroundColor: bg, borderColor: border}]}>
        <Icon name={icon} size={22} color={color} />
      </View>
      <Text style={styles.quickLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)'},
  backBtn: {flexDirection: 'row', alignItems: 'center', gap: 6},
  headerTitle: {fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, color: '#B8C7E0'},

  profileSection: {alignItems: 'center', paddingTop: 32, paddingBottom: 20, paddingHorizontal: 16},
  profileAvatar: {width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 16, shadowColor: '#000', shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.3, shadowRadius: 16, elevation: 8},
  profileInitials: {color: '#FFF', fontSize: 24, fontWeight: '800', letterSpacing: 1},
  profileName: {fontSize: 18, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 2, color: '#FFFFFF', marginBottom: 4, textAlign: 'center'},
  profilePhone: {fontSize: 12, color: '#7E8AA6', marginBottom: 12},
  e2eBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99},
  e2eText: {fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#4ade80'},

  quickActionsRow: {flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 20, gap: 8},
  quickAction: {flex: 1, alignItems: 'center', gap: 6},
  quickCircle: {width: 50, height: 50, borderRadius: 25, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  quickLabel: {fontSize: 9, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', color: '#7E8AA6'},

  divider: {height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginHorizontal: 16},
  sectionHeader: {fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', color: '#7E8AA6', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8},

  sectionHeaderRow: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingRight: 16},
  sectionHint: {color: '#1E88FF', fontSize: 9, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase'},

  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10},
  memberAvatar: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  memberInitials: {color: '#FFF', fontSize: 12, fontWeight: '800'},
  // BS-GROUP-ADD — "Add member" row.
  addMemberRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10},
  addMemberIcon: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(30,136,255,0.12)', flexShrink: 0},
  addMemberText: {color: Colors.primary, fontSize: 14, fontWeight: '700'},
  memberNameRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  memberName: {color: '#FFFFFF', fontSize: 13, fontWeight: '700', flexShrink: 1},
  memberPhone: {color: '#7E8AA6', fontSize: 11, marginTop: 2},
  aliasTag: {flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.28)'},
  aliasTagText: {color: '#1E88FF', fontSize: 8, fontWeight: '800', letterSpacing: 1.2},
  selfBadge: {color: '#1E88FF', fontSize: 9, fontWeight: '800', letterSpacing: 1.5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(30,136,255,0.1)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.3)'},

  settingRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.07)'},
  settingIcon: {width: 36, height: 36, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  settingTitle: {flex: 1, fontSize: 13, fontWeight: '700', color: '#FFFFFF'},
  settingRight: {fontSize: 11, fontWeight: '700', color: '#7E8AA6'},

  // Admin rename modal
  modalOverlay: {flex: 1, backgroundColor: 'rgba(6,20,43,0.85)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  modalCard: {width: '100%', maxWidth: 380, backgroundColor: '#122747', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: '#244C82'},
  modalTitle: {color: '#FFF', fontSize: 16, fontWeight: '800', letterSpacing: 0.3},
  modalSub: {color: '#7E8AA6', fontSize: 11, marginTop: 6, lineHeight: 16},
  modalInput: {marginTop: 16, backgroundColor: '#07090D', borderWidth: 1, borderColor: '#244C82', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, color: '#FFF', fontSize: 14},
  modalRemoveRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, paddingVertical: 11, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.08)'},
  modalRemoveText: {color: '#F87171', fontSize: 13, fontWeight: '700'},
  modalRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18},
  modalCancel: {paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8},
  modalCancelText: {color: '#B8C7E0', fontSize: 13, fontWeight: '700'},
  modalResetText: {color: '#F87171', fontSize: 13, fontWeight: '700'},
  modalSave: {paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: '#1E88FF'},
  modalSaveText: {color: '#FFF', fontSize: 13, fontWeight: '800'},

  ttlOption: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, marginBottom: 6, borderWidth: 1, borderColor: '#1C3B66'},
  ttlOptionActive: {borderColor: '#1E88FF', backgroundColor: 'rgba(30,136,255,0.08)'},
  ttlOptionText: {color: '#FFF', fontSize: 13, fontWeight: '600'},

  fingerprintBox: {marginTop: 16, padding: 14, borderRadius: 10, backgroundColor: '#07090D', borderWidth: 1, borderColor: '#244C82'},
  fingerprintText: {color: '#4ade80', fontSize: 14, fontWeight: '700', letterSpacing: 2, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'},
  fingerprintAction: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.25)'},
  fingerprintActionText: {color: '#1E88FF', fontSize: 13, fontWeight: '700'},
}));
