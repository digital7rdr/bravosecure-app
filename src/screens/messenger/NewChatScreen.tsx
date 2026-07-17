import React, {useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, StatusBar, ActivityIndicator, Linking,
  Modal, TextInput, KeyboardAvoidingView, Platform, Share,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardHeight} from '@hooks/useKeyboardHeight';
import {Colors} from '@theme/index';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useAuthStore} from '@store/authStore';
import {DEV_CONTACTS, isDevMode, otherDevContacts} from '@/modules/messenger/dev/devContacts';
import {useMessengerStore, resolveDirectConversationIdFromState} from '@/modules/messenger/store';
import {UsersHttpClient} from '@bravo/messenger-core';
import {
  useDiscoveredContacts,
  type DiscoveredRow,
} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {normalizeBatch, regionFromOwnPhone} from '@/modules/messenger/contacts/phoneNormalize';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {writeServerRosterOrQueue} from '@/modules/messenger/runtime/pendingRosterIntents';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;

export default function NewChatScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-11 — Android Modal windows don't resize for the IME.
  const kbHeight = useKeyboardHeight();
  const navigation = useNavigation<Nav>();
  // BS-GROUP-ADD — when launched from ChatInfo's "Add member", these are set
  // and picking a contact adds them to the existing group instead of opening
  // a new chat.
  const route = useRoute<RouteProp<MessengerStackParamList, 'NewChat'>>();
  const addToGroupId = route.params?.addToGroupId ?? null;
  const addGroupName = route.params?.groupName ?? null;
  const currentUser = useAuthStore(s => s.user);
  const upsertConversation = useMessengerStore(s => s.upsertConversation);

  // BS-INVITE — invite a non-Bravo contact via the native share sheet.
  // The user picks the recipient + channel (SMS / WhatsApp / etc.) in
  // their OS share UI, so we don't need to enumerate non-Bravo contacts.
  const inviteToBravo = async () => {
    const inviter = currentUser?.full_name ? `${currentUser.full_name} ` : '';
    const link = 'https://bravosecure.com/get'; // Why: public install/landing link.
    try {
      await Share.share({
        message: `${inviter}invited you to Bravo Secure — private, end-to-end encrypted messaging & calls. Get the app: ${link}`,
      });
    } catch { /* user dismissed the share sheet — no-op */ }
  };

  // Group-creation state. When groupMode is on, tapping a contact toggles
  // selection (WhatsApp-style multi-select) instead of opening a chat.
  const [groupMode, setGroupMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupNameModalOpen, setGroupNameModalOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  // Busy guard: createGroupChat is async (broadcastToGroup fans out
  // sealed envelopes to every member). Without this guard, each rapid
  // re-tap of the Create button kicked off a fresh group creation —
  // user reported "tapped 4-5 times, 5 groups created". The guard
  // keeps the button visibly disabled + ignores presses until the
  // first call resolves (success or failure).
  const [creating, setCreating] = useState(false);

  const showDevContacts = isDevMode();
  const devContacts = otherDevContacts(currentUser?.id);
  const seederReady = DEV_CONTACTS.every(c => c.userId !== 'REPLACE_WITH_SEEDED_UUID');

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next;
    });
  };

  const exitGroupMode = () => {
    setGroupMode(false);
    setSelectedIds(new Set());
  };

  const openGroupNamePrompt = () => {
    if (selectedIds.size === 0) {return;}
    setGroupName('');
    setGroupNameModalOpen(true);
  };

  const confirmCreateGroup = async () => {
    if (creating) {
      console.log('[group-create] tap ignored — already in flight');
      return;
    }
    const name = groupName.trim();
    const memberIds = Array.from(selectedIds);
    console.log('[group-create] tap Create — name =', JSON.stringify(name), 'members =', memberIds);
    if (!name || selectedIds.size === 0) {
      console.warn('[group-create] aborted — name empty or no members selected');
      return;
    }
    setCreating(true);
    try {
      console.log('[group-create] resolving runtime…');
      const runtime = await getMessengerRuntime();
      console.log('[group-create] runtime mode =', runtime.mode);
      // The runtime owns:
      //   - GroupState construction (groupId + master key)
      //   - upsertConversation for the local row
      //   - admin "create" envelope fan-out via E2E sealed envelopes
      //     so other members' clients call setGroupState +
      //     upsertConversation themselves and the chat appears in
      //     their inbox.
      const {conversationId, groupId} = await runtime.createGroupChat({name, members: memberIds});
      console.log('[group-create] OK conversationId =', conversationId, 'groupId =', groupId);
      setGroupNameModalOpen(false);
      exitGroupMode();
      navigation.navigate('Chat', {conversationId, name, isGroup: true});
    } catch (e) {
      console.warn('[group-create] FAILED:', (e as Error).message);
      // Surface to the user — without this they tap Create and nothing
      // happens visibly when the network is down or peers can't be
      // reached. The screen itself doesn't have an error banner today;
      // a short alert is the simplest stopgap.

      const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
      Alert.alert('Could not create group', (e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  // Build UsersHttpClient once — the RN token store gives us the
  // currently-signed-in user's JWT; API_BASE_URL points at auth-service
  // (http://10.0.2.2:3001 in dev, prod host otherwise).
  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      // Round 2: 401 mid-session = expired access token. Drive the
      // single-flight refresh chain instead of failing the lookup.
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );

  const {permission, loading, error, matches, refresh} = useDiscoveredContacts({
    users:        usersClient,
    ownPhoneE164: currentUser?.phone_e164 ?? null,
    enabled:      true,
  });

  const startDevChat = (peer: typeof DEV_CONTACTS[number]) => {
    // BS-NC1 — resolve to the CANONICAL direct conversation id. If a
    // server-UUID row already exists for this peer (created by an earlier
    // /conversations/mine sync), reuse it instead of minting a duplicate
    // `direct:<peer>` row. Without this, tapping a contact opens an empty
    // synthetic thread while history + new inbound route to the UUID row.
    const conversationId = resolveDirectConversationIdFromState(
      useMessengerStore.getState(), peer.userId,
    );
    // Only seed/refresh the row when it's the synthetic key (no UUID row
    // yet); never overwrite an existing canonical row's metadata.
    if (conversationId.startsWith('direct:')) {
      upsertConversation({
        id:             conversationId,
        type:           'direct',
        name:           peer.name,
        participants:   [currentUser?.id ?? 'self', peer.userId],
        unread_count:   0,
        is_muted:       false,
        created_at:     new Date().toISOString(),
        peer:           {userId: peer.userId, deviceId: peer.deviceId},
        session_state:  'fresh',
      });
    }
    navigation.navigate('Chat', {conversationId, name: peer.name, isGroup: false});
  };

  // BS-GROUP-ADD — add the picked contact to the existing group via the
  // runtime (which rekeys the group epoch + fans the new member's add
  // envelope out). On success, pop back to the group's ChatInfo.
  const addMemberToGroup = async (row: DiscoveredRow) => {
    if (!addToGroupId) {return;}
    const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
    try {
      const runtime = await getMessengerRuntime();
      if (!runtime.addGroupMember) {
        Alert.alert('Unavailable', 'Adding members isn’t supported in this mode.');
        return;
      }
      await runtime.addGroupMember({
        groupId:   addToGroupId,
        newMember: {userId: row.userId, deviceId: 1},
      });
      // P1-6 — the local add+rekey above gave the new member the group key, but
      // the server `conversation_members` roster is unchanged: the next
      // /conversations/mine sync would overwrite participants and silently drop
      // them from future fan-out (and prune the thread on their device). Write
      // the roster now; a failed write is durably queued + retried while the
      // Home sync guard keeps the local (grown) participants authoritative.
      const ownerKey = useMessengerStore.getState()._ownUserId ?? undefined;
      const res = await writeServerRosterOrQueue({
        conversationId: addToGroupId, memberUserId: row.userId, action: 'add', ownerKey,
      });
      if (res.queued) {
        Alert.alert(
          'Member added',
          'They now have the group key. The member list will finish syncing when you reconnect.',
        );
      }
      navigation.goBack();
    } catch (e) {
      Alert.alert('Could not add member', e instanceof Error ? e.message : 'Please try again.');
    }
  };

  const startRealChat = (row: DiscoveredRow) => {
    // BS-GROUP-ADD — in add-to-group mode, picking a contact adds them to
    // the group rather than opening a 1:1 chat.
    if (addToGroupId) { void addMemberToGroup(row); return; }
    // `localName` is how the user has the contact saved on their phone —
    // always beats display_name for a friendly UI. Phase-1 peers live on
    // signal deviceId=1; multi-device arrives with auth-service M12.
    // BS-NC1 — resolve to the canonical id (see startDevChat) to avoid
    // the split-brain duplicate-thread bug.
    const conversationId = resolveDirectConversationIdFromState(
      useMessengerStore.getState(), row.userId,
    );
    if (conversationId.startsWith('direct:')) {
      upsertConversation({
        id:             conversationId,
        type:           'direct',
        name:           row.localName,
        participants:   [currentUser?.id ?? 'self', row.userId],
        unread_count:   0,
        is_muted:       false,
        created_at:     new Date().toISOString(),
        peer:           {userId: row.userId, deviceId: 1},
        phoneE164:      row.phoneE164,
        session_state:  'fresh',
      });
    }
    navigation.navigate('Chat', {conversationId, name: row.localName, isGroup: false});
  };

  // ── Message-by-number ──────────────────────────────────────────────────────
  // Reach someone who isn't in your address book: type their number, we
  // normalise + look it up on the directory, and open a chat if they're a
  // Bravo user. Uses the same /users/lookup the contact sweep uses.
  const [byNumberOpen, setByNumberOpen] = useState(false);
  const [numberInput, setNumberInput] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const startChatByNumber = async () => {
    setLookupError(null);
    const callingCode = regionFromOwnPhone(currentUser?.phone_e164 ?? null);
    const [e164] = normalizeBatch([numberInput], callingCode);
    if (!e164) {
      setLookupError('Enter a valid phone number (with country code).');
      return;
    }
    if (e164 === currentUser?.phone_e164) {
      setLookupError("That's your own number.");
      return;
    }
    setLookupBusy(true);
    try {
      const hits = await usersClient.lookup([e164]);
      const hit = hits[0];
      if (!hit) {
        setLookupError('No Bravo account is registered to that number.');
        return;
      }
      const conversationId = resolveDirectConversationIdFromState(
        useMessengerStore.getState(), hit.userId,
      );
      if (conversationId.startsWith('direct:')) {
        upsertConversation({
          id:             conversationId,
          type:           'direct',
          name:           hit.displayName || e164,
          participants:   [currentUser?.id ?? 'self', hit.userId],
          unread_count:   0,
          is_muted:       false,
          created_at:     new Date().toISOString(),
          peer:           {userId: hit.userId, deviceId: 1},
          phoneE164:      e164,
          session_state:  'fresh',
        });
      }
      setByNumberOpen(false);
      setNumberInput('');
      navigation.navigate('Chat', {conversationId, name: hit.displayName || e164, isGroup: false});
    } catch (e) {
      setLookupError((e as Error).message || 'Lookup failed. Try again.');
    } finally {
      setLookupBusy(false);
    }
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => groupMode ? exitGroupMode() : navigation.goBack()}
          activeOpacity={0.7}>
          <Icon name={groupMode ? 'close' : 'arrow-left'} size={20} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={{flex: 1}}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {addToGroupId ? `Add to ${addGroupName ?? 'group'}` : groupMode ? 'Select Members' : 'New Message'}
          </Text>
          {groupMode && (
            <Text style={styles.headerSubtitle}>
              {selectedIds.size === 0 ? 'Tap contacts to add them' : `${selectedIds.size} selected`}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Icon name="magnify" size={17} color="#7E8AA6" />
          <Text style={styles.searchHint}>Search name or number…</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingBottom: insets.bottom + 24, flexGrow: 1}}>

        {/* New Group — only shown when NOT already selecting members */}
        {!groupMode && (
          <TouchableOpacity style={styles.newGroupRow} activeOpacity={0.8}
            onPress={() => setGroupMode(true)}>
            <View style={styles.newGroupIcon}>
              <Icon name="account-group" size={20} color="#1E88FF" />
            </View>
            <View style={styles.newGroupInfo}>
              <Text style={styles.newGroupTitle}>New Group</Text>
              <Text style={styles.newGroupSub}>Sealed-sender broadcast, pairwise E2E</Text>
            </View>
            <Icon name="chevron-right" size={18} color="#7E8AA6" />
          </TouchableOpacity>
        )}

        {/* Message by number — reach someone not in your contacts */}
        {!groupMode && (
          <TouchableOpacity style={styles.newGroupRow} activeOpacity={0.8}
            onPress={() => { setLookupError(null); setByNumberOpen(true); }}>
            <View style={styles.newGroupIcon}>
              <Icon name="dialpad" size={20} color="#1E88FF" />
            </View>
            <View style={styles.newGroupInfo}>
              <Text style={styles.newGroupTitle}>Message by Number</Text>
              <Text style={styles.newGroupSub}>Start a chat with any Bravo number</Text>
            </View>
            <Icon name="chevron-right" size={18} color="#7E8AA6" />
          </TouchableOpacity>
        )}

        {showDevContacts && (
          <DevContactsSection
            seederReady={seederReady}
            devContacts={devContacts}
            onPick={startDevChat}
            groupMode={groupMode}
            selectedIds={selectedIds}
            onToggle={toggleSelect}
          />
        )}
        <RealContactsSection
          permission={permission}
          loading={loading}
          error={error}
          matches={matches}
          onPick={startRealChat}
          onRetry={refresh}
          groupMode={groupMode}
          selectedIds={selectedIds}
          onToggle={toggleSelect}
        />

        {/* BS-INVITE — invite non-Bravo contacts. Always available; the
            native share sheet lets the user pick who + how to send. */}
        {!groupMode && !addToGroupId && (
          <TouchableOpacity style={styles.inviteRow} onPress={() => void inviteToBravo()} activeOpacity={0.8}>
            <View style={styles.inviteIcon}>
              <Icon name="account-plus-outline" size={20} color={Colors.primary} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={styles.inviteTitle}>Invite a friend to Bravo</Text>
              <Text style={styles.inviteSub}>Send an install link to someone not on Bravo yet</Text>
            </View>
            <Icon name="share-variant" size={18} color={Colors.textMuted ?? '#7E8AA6'} />
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Floating "Next" button when members are selected */}
      {groupMode && selectedIds.size > 0 && (
        <TouchableOpacity
          style={[styles.nextFab, {bottom: insets.bottom + 20}]}
          onPress={openGroupNamePrompt}
          activeOpacity={0.85}>
          <Icon name="arrow-right" size={22} color="#FFF" />
        </TouchableOpacity>
      )}

      {/* Group-name modal — WhatsApp-style name prompt after selection */}
      <Modal
        visible={groupNameModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setGroupNameModalOpen(false)}>
        <KeyboardAvoidingView
          style={[styles.modalOverlay, Platform.OS === 'android' && {paddingBottom: kbHeight}]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Group name</Text>
            <Text style={styles.modalSub}>{selectedIds.size} {selectedIds.size === 1 ? 'member' : 'members'}</Text>
            <TextInput
              style={styles.modalInput}
              value={groupName}
              onChangeText={setGroupName}
              placeholder="e.g. Ops Team"
              placeholderTextColor="#7E8AA6"
              autoFocus
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={() => { void confirmCreateGroup(); }}
            />
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setGroupNameModalOpen(false)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, (!groupName.trim() || creating) && {opacity: 0.4}]}
                disabled={!groupName.trim() || creating}
                onPress={() => { void confirmCreateGroup(); }}
                activeOpacity={0.85}>
                {creating
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={styles.modalCreateText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Message-by-number modal */}
      <Modal
        visible={byNumberOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setByNumberOpen(false)}>
        <KeyboardAvoidingView
          style={[styles.modalOverlay, Platform.OS === 'android' && {paddingBottom: kbHeight}]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Message by number</Text>
            <Text style={styles.modalSub}>Enter a phone number with country code</Text>
            <TextInput
              style={styles.modalInput}
              value={numberInput}
              onChangeText={t => { setNumberInput(t); setLookupError(null); }}
              placeholder="+971 50 123 4567"
              placeholderTextColor="#7E8AA6"
              autoFocus
              keyboardType="phone-pad"
              returnKeyType="go"
              onSubmitEditing={() => { void startChatByNumber(); }}
            />
            {lookupError && <Text style={styles.lookupError}>{lookupError}</Text>}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setByNumberOpen(false); setNumberInput(''); }} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreate, (!numberInput.trim() || lookupBusy) && {opacity: 0.4}]}
                disabled={!numberInput.trim() || lookupBusy}
                onPress={() => { void startChatByNumber(); }}
                activeOpacity={0.85}>
                {lookupBusy
                  ? <ActivityIndicator color="#FFF" />
                  : <Text style={styles.modalCreateText}>Message</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ─── Dev-contacts section (unchanged) ──────────────────────────────────

function DevContactsSection(props: {
  seederReady: boolean;
  devContacts: ReturnType<typeof otherDevContacts>;
  onPick: (c: typeof DEV_CONTACTS[number]) => void;
  groupMode: boolean;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const {seederReady, devContacts, onPick, groupMode, selectedIds, onToggle} = props;
  return (
    <>
      <View style={styles.devBanner}>
        <Icon name="information-outline" size={12} color="#fbbf24" />
        <Text style={styles.devBannerText}>
          DEV BUILD — dev contacts shown below. Production builds load peers from the contacts API.
        </Text>
      </View>
      <Text style={styles.sectionLabel}>Dev Contacts</Text>
      {!seederReady ? (
        <SeederNeeded />
      ) : devContacts.length === 0 ? (
        <EmptyDevContacts />
      ) : (
        devContacts.map(c => {
          const selected = selectedIds.has(c.userId);
          return (
            <TouchableOpacity key={c.userId} style={[styles.row, selected && styles.rowSelected]}
              onPress={() => groupMode ? onToggle(c.userId) : onPick(c)} activeOpacity={0.8}>
              <View style={styles.avWrap}>
                <View style={[styles.av, {backgroundColor: c.bg}]}>
                  <Text style={styles.avText}>{c.initials}</Text>
                </View>
                {groupMode && selected && (
                  <View style={styles.selectTick}>
                    <Icon name="check" size={12} color="#FFF" />
                  </View>
                )}
              </View>
              <View style={styles.rowInfo}>
                <View style={styles.nameRow}>
                  <Text style={styles.name}>{c.name}</Text>
                </View>
                <Text style={styles.phone}>{c.phoneE164}</Text>
              </View>
              {groupMode ? (
                <View style={[styles.checkbox, selected && styles.checkboxOn]}>
                  {selected && <Icon name="check" size={14} color="#FFF" />}
                </View>
              ) : (
                <Icon name="chevron-right" size={18} color="#7E8AA6" />
              )}
            </TouchableOpacity>
          );
        })
      )}
    </>
  );
}

// ─── Real-contacts section (new: permission + lookup + render) ────────

function RealContactsSection(props: {
  permission: 'unknown' | 'granted' | 'denied' | 'unavailable';
  loading:    boolean;
  error:      string | null;
  matches:    DiscoveredRow[];
  onPick:     (row: DiscoveredRow) => void;
  onRetry:    () => Promise<void>;
  groupMode:  boolean;
  selectedIds: Set<string>;
  onToggle:   (id: string) => void;
}) {
  const {permission, loading, error, matches, onPick, onRetry, groupMode, selectedIds, onToggle} = props;

  if (loading && matches.length === 0) {
    return (
      <View style={styles.blockWrap}>
        <ActivityIndicator color="#1E88FF" />
        <Text style={styles.blockTitle}>Finding your Bravo contacts…</Text>
        <Text style={styles.blockHint}>Reading your address book and checking which numbers are on Bravo.</Text>
      </View>
    );
  }

  if (permission === 'denied') {
    return (
      <View style={styles.blockWrap}>
        <Icon name="book-lock-outline" size={32} color="#244C82" />
        <Text style={styles.blockTitle}>Contacts access needed</Text>
        <Text style={styles.blockHint}>
          Grant contacts permission to see which of your saved numbers are on Bravo. We only
          send phone numbers to match against existing users — nothing else leaves your device.
        </Text>
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.85}
          onPress={() => { void Linking.openSettings(); }}>
          <Text style={styles.actionBtnText}>Open Settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (permission === 'unavailable') {
    return (
      <View style={styles.blockWrap}>
        <Icon name="cellphone-off" size={32} color="#244C82" />
        <Text style={styles.blockTitle}>Not supported here</Text>
        <Text style={styles.blockHint}>
          Contact discovery isn't available in this build. Sign in on a physical device.
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.blockWrap}>
        <Icon name="alert-circle-outline" size={32} color="#f87171" />
        <Text style={styles.blockTitle}>Lookup failed</Text>
        <Text style={styles.blockHint}>{error}</Text>
        <TouchableOpacity style={styles.actionBtn} activeOpacity={0.85}
          onPress={() => { void onRetry(); }}>
          <Text style={styles.actionBtnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (matches.length === 0) {
    return (
      <>
        <Text style={styles.sectionLabel}>Contacts on Bravo</Text>
        <View style={styles.blockWrap}>
          <Icon name="account-search-outline" size={32} color="#244C82" />
          <Text style={styles.blockTitle}>No matches yet</Text>
          <Text style={styles.blockHint}>
            None of your saved contacts are on Bravo. Invite them to join — anyone with
            a Bravo account will appear here automatically.
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Text style={styles.sectionLabel}>Contacts on Bravo · {matches.length}</Text>
      {matches.map(m => {
        const selected = selectedIds.has(m.userId);
        return (
          <TouchableOpacity key={m.userId} style={[styles.row, selected && styles.rowSelected]}
            onPress={() => groupMode ? onToggle(m.userId) : onPick(m)} activeOpacity={0.8}>
            <View style={styles.avWrap}>
              <View style={[styles.av, {backgroundColor: avatarColor(m.userId)}]}>
                <Text style={styles.avText}>{initialsOf(m.localName)}</Text>
              </View>
              {groupMode && selected && (
                <View style={styles.selectTick}>
                  <Icon name="check" size={12} color="#FFF" />
                </View>
              )}
            </View>
            <View style={styles.rowInfo}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{m.localName}</Text>
              </View>
              <Text style={styles.phone}>{m.phoneE164}</Text>
            </View>
            {groupMode ? (
              <View style={[styles.checkbox, selected && styles.checkboxOn]}>
                {selected && <Icon name="check" size={14} color="#FFF" />}
              </View>
            ) : (
              <Icon name="chevron-right" size={18} color="#7E8AA6" />
            )}
          </TouchableOpacity>
        );
      })}
    </>
  );
}

function SeederNeeded() {
  return (
    <View style={styles.blockWrap}>
      <Icon name="account-cog-outline" size={32} color="#244C82" />
      <Text style={styles.blockTitle}>Run the dev seeder</Text>
      <Text style={styles.blockHint}>
        No dev users yet. Start auth-service with OTP_DEV_BYPASS=true and run:{'\n'}
      </Text>
      <View style={styles.codeBlock}>
        <Text style={styles.codeText}>node scripts/seed-dev-users.mjs</Text>
      </View>
      <Text style={styles.blockHint}>
        Paste the printed UUIDs into{' '}
        <Text style={styles.codeInline}>src/modules/messenger/dev/devContacts.ts</Text>
        {' '}and rebuild.
      </Text>
    </View>
  );
}

function EmptyDevContacts() {
  return (
    <View style={styles.blockWrap}>
      <Icon name="account-question-outline" size={32} color="#244C82" />
      <Text style={styles.blockTitle}>No peers to message</Text>
      <Text style={styles.blockHint}>
        You're signed in as the only seeded user. Sign in as a different dev user on another device to start chatting.
      </Text>
    </View>
  );
}

/** Deterministic avatar color from the userId — stable across renders. */
function avatarColor(seed: string): string {
  const palette = ['#1E88FF', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#14B8A6'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {h = (h * 31 + seed.charCodeAt(i)) >>> 0;}
  return palette[h % palette.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},

  header: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingTop:6, paddingBottom:12, borderBottomWidth:1, borderBottomColor:'#1C3B66'},
  backBtn: {width:32, height:32, borderRadius:16, alignItems:'center', justifyContent:'center'},
  headerTitle: {flex:1, color:'#FFFFFF', fontSize:13, fontWeight:'800', letterSpacing:3, textTransform:'uppercase'},

  searchWrap: {paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'#1C3B66'},
  searchBar: {flexDirection:'row', alignItems:'center', gap:8, height:40, backgroundColor:'#162F54', borderRadius:12, paddingHorizontal:12, borderWidth:1, borderColor:'#1C3B66'},
  searchHint: {color:'#7E8AA6', fontSize:11, fontWeight:'600'},

  newGroupRow: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'#1C3B66'},
  newGroupIcon: {width:44, height:44, borderRadius:22, backgroundColor:'rgba(30,136,255,0.15)', borderWidth:1, borderColor:'rgba(30,136,255,0.25)', alignItems:'center', justifyContent:'center'},
  newGroupInfo: {flex:1},
  newGroupTitle: {color:'#1E88FF', fontSize:13, fontWeight:'700'},
  newGroupSub: {color:'#7E8AA6', fontSize:11, marginTop:2},

  devBanner: {flexDirection:'row', alignItems:'center', gap:6, paddingHorizontal:16, paddingVertical:8, backgroundColor:'rgba(251,191,36,0.08)', borderBottomWidth:1, borderBottomColor:'rgba(251,191,36,0.2)'},
  devBannerText: {color:'#fbbf24', fontSize:10, fontWeight:'600', flex:1, lineHeight:14},

  sectionLabel: {color:'#7E8AA6', fontSize:9, fontWeight:'800', letterSpacing:3, textTransform:'uppercase', paddingHorizontal:16, paddingTop:12, paddingBottom:6},

  row: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:11, borderBottomWidth:1, borderBottomColor:'rgba(28,59,102,0.5)'},
  avWrap: {position:'relative', width:44, height:44, flexShrink:0},
  av: {width:44, height:44, borderRadius:22, alignItems:'center', justifyContent:'center'},
  avText: {color:'#FFF', fontSize:11, fontWeight:'800'},
  rowInfo: {flex:1, minWidth:0},
  nameRow: {flexDirection:'row', alignItems:'center', gap:5},
  name: {color:'#FFFFFF', fontSize:13, fontWeight:'700', flexShrink:1},
  phone: {color:'#7E8AA6', fontSize:10, marginTop:2},

  // BS-INVITE — invite-a-friend row.
  inviteRow: {flexDirection:'row', alignItems:'center', gap:12, marginHorizontal:16, marginTop:14, paddingHorizontal:14, paddingVertical:13, borderRadius:14, borderWidth:1, borderColor:'rgba(28,59,102,0.7)', backgroundColor:'rgba(20,40,72,0.5)'},
  inviteIcon: {width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center', backgroundColor:'rgba(30,136,255,0.12)', flexShrink:0},
  inviteTitle: {color:'#FFFFFF', fontSize:13, fontWeight:'700'},
  inviteSub: {color:'#7E8AA6', fontSize:11, marginTop:2},

  blockWrap: {paddingHorizontal:32, paddingVertical:40, alignItems:'center', gap:10},
  blockTitle: {color:'#B8C7E0', fontSize:13, fontWeight:'700', marginTop:4},
  blockHint: {color:'#7E8AA6', fontSize:11, textAlign:'center', lineHeight:16, maxWidth:300},
  codeBlock: {backgroundColor:'#162F54', borderRadius:8, paddingHorizontal:12, paddingVertical:8, borderWidth:1, borderColor:'#1C3B66'},
  codeText: {color:'#B8C7E0', fontSize:11, fontFamily:'monospace'},
  codeInline: {color:'#B8C7E0', fontFamily:'monospace', fontSize:11},

  actionBtn: {marginTop:12, paddingHorizontal:18, paddingVertical:10, borderRadius:10, backgroundColor:'rgba(30,136,255,0.15)', borderWidth:1, borderColor:'rgba(30,136,255,0.35)'},
  actionBtnText: {color:'#1E88FF', fontSize:12, fontWeight:'700'},

  // ─── Group-selection UI ─────────────────────────────────────────
  headerSubtitle: {color:'#7E8AA6', fontSize:10, marginTop:2, letterSpacing:0.5},
  rowSelected: {backgroundColor:'rgba(30,136,255,0.08)'},
  selectTick: {position:'absolute', right:-2, bottom:-2, width:18, height:18, borderRadius:9, backgroundColor:'#1E88FF', alignItems:'center', justifyContent:'center', borderWidth:2, borderColor:Colors.background},
  checkbox: {width:22, height:22, borderRadius:11, borderWidth:1.5, borderColor:'#244C82', alignItems:'center', justifyContent:'center'},
  checkboxOn: {backgroundColor:'#1E88FF', borderColor:'#1E88FF'},
  nextFab: {position:'absolute', right:20, width:56, height:56, borderRadius:28, backgroundColor:'#1E88FF', alignItems:'center', justifyContent:'center', shadowColor:'#1E88FF', shadowOffset:{width:0,height:4}, shadowOpacity:0.5, shadowRadius:10, elevation:6},

  // ─── Group-name modal ────────────────────────────────────────────
  modalOverlay: {flex:1, backgroundColor:'rgba(6,20,43,0.85)', alignItems:'center', justifyContent:'center', paddingHorizontal:24},
  modalCard: {width:'100%', maxWidth:380, backgroundColor:'#122747', borderRadius:16, padding:20, borderWidth:1, borderColor:'#244C82'},
  modalTitle: {color:'#FFF', fontSize:16, fontWeight:'800', letterSpacing:0.3},
  modalSub: {color:'#7E8AA6', fontSize:11, marginTop:4, fontWeight:'600'},
  modalInput: {marginTop:18, backgroundColor:'#07090D', borderWidth:1, borderColor:'#244C82', borderRadius:10, paddingHorizontal:14, paddingVertical:12, color:'#FFF', fontSize:14},
  lookupError: {color:'#FF6B6B', fontSize:11, marginTop:8, fontWeight:'600'},
  modalRow: {flexDirection:'row', justifyContent:'flex-end', gap:8, marginTop:18},
  modalCancel: {paddingHorizontal:18, paddingVertical:10, borderRadius:8},
  modalCancelText: {color:'#B8C7E0', fontSize:13, fontWeight:'700'},
  modalCreate: {paddingHorizontal:22, paddingVertical:10, borderRadius:8, backgroundColor:'#1E88FF'},
  modalCreateText: {color:'#FFF', fontSize:13, fontWeight:'800'},
}));
