import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Switch, StatusBar, ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Colors} from '@theme/index';
import {UsersHttpClient, type Me, type BlockedUser} from '@bravo/messenger-core';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {setReadReceiptsEnabled as cacheReadReceiptsEnabled} from '@/modules/messenger/store/privacySettings';
import {setBlockedPeers, removeBlockedPeer} from '@/modules/messenger/runtime/blockedPeers';
import {readBackupEnabledSource} from '@/modules/messenger/backup/backupFlags';
import {useAuthStore} from '@store/authStore';
import {scaleTextStyles} from '@utils/scaling';

/**
 * Messenger profile + privacy + blocked-users pane. Pulls `/users/me`
 * on mount, lets the user edit display name / bio / avatar URL, flip
 * last-seen + read-receipt visibility, and unblock previously-blocked
 * users. Block is initiated from ChatInfoScreen; unblock lives here
 * so it's never more than two taps away.
 */
type Nav = NativeStackNavigationProp<MessengerStackParamList, 'MessengerSettings'>;

type PrivacyField = 'lastSeenVisible' | 'readReceiptsEnabled';

/**
 * Latest-wins sequencer for optimistic toggles. `begin(fields)` bumps a
 * per-field request seq and returns an `isLatest()` probe; a request may
 * commit or revert its fields only while it is still the newest one.
 */
// Why: SET-08 — burst taps race their HTTP round-trips; an older response
// resolving late clobbered the newest tap's optimistic state.
export function createLatestWins<K extends string>(): (fields: K[]) => () => boolean {
  const seq = new Map<K, number>();
  return fields => {
    const mine = fields.map(f => {
      const n = (seq.get(f) ?? 0) + 1;
      seq.set(f, n);
      return [f, n] as const;
    });
    return () => mine.every(([f, n]) => seq.get(f) === n);
  };
}

export default function MessengerSettingsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const client = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      // Round 2: drive the single-flight refresh chain on 401 mid-session.
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );

  const [me, setMe]       = useState<Me | null>(null);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio]                 = useState('');
  const [avatarUrl, setAvatarUrl]     = useState('');
  const [backupEnabled, setBackupEnabled] = useState(false);
  // P3-B-2 — canonical owner (email ?? phone ?? id), same scoping the
  // keychain + backup boot gate use for owner-keyed flags.
  const ownerKey = useAuthStore(s => s.user?.email ?? s.user?.phone_e164 ?? s.user?.id ?? null);
  // N-16 — message-content preview in notifications is a privacy choice; OFF by
  // default (name-only banner) so plaintext never leaves the runtime into a
  // notification. Opt-in here.
  const [notifPreview, setNotifPreview] = useState(true); // B-65 — default ON

  // Reflect whether encrypted backup is already on so the row's subtitle
  // is status-aware instead of always showing the first-time setup hint.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // P3-B-2 — owner-scoped flag with the legacy-global fallback so a
        // pre-migration enable still renders as "on" for a status hint.
        const source = await readBackupEnabledSource(ownerKey ?? '');
        if (!cancelled) {setBackupEnabled(source !== null);}
      } catch {
        // Non-fatal — fall back to the setup hint.
      }
      try {
        // B-65 — default ON (Telegram/WhatsApp parity); only an explicit '0'
        // opt-out disables. Must match backgroundMessageNotifier's read.
        const p = await AsyncStorage.getItem('bravo:notif-content-preview');
        if (!cancelled) {setNotifPreview(p !== '0');}
      } catch { /* default on */ }
    })();
    return () => { cancelled = true; };
  }, [ownerKey]);

  const toggleNotifPreview = async (v: boolean) => {
    setNotifPreview(v);
    try { await AsyncStorage.setItem('bravo:notif-content-preview', v ? '1' : '0'); } catch { /* best-effort */ }
    try {
      const {setContentPreviewEnabled} = require('@/modules/messenger/push/backgroundMessageNotifier') as
        typeof import('@/modules/messenger/push/backgroundMessageNotifier');
      setContentPreviewEnabled(v); // apply live without a restart
    } catch { /* module not loaded — picked up on next notifier start */ }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, b] = await Promise.all([client.me(), client.listBlocked()]);
        if (cancelled) {return;}
        setMe(m);
        setBlocked(b);
        // M-07 — refresh the local block set from the authoritative server list
        // so the receive path drops blocked peers even after a reinstall.
        void setBlockedPeers(b.map(u => u.userId));
        setDisplayName(m.displayName);
        setBio(m.bio ?? '');
        setAvatarUrl(m.avatarUrl ?? '');
        // Audit P1-T3 — refresh the local privacy cache from the
        // server's authoritative value so the runtime's `markRead`
        // gate matches what the user sees in this screen.
        void cacheReadReceiptsEnabled(m.readReceiptsEnabled);
      } catch (e) {
        if (!cancelled) {
          Alert.alert('Could not load settings', e instanceof Error ? e.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => { cancelled = true; };
  }, [client]);

  const save = async () => {
    if (!me) {return;}
    setSaving(true);
    try {
      const next = await client.updateMe({
        displayName,
        bio,
        avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
      });
      setMe(next);
      Alert.alert('Saved', 'Profile updated.');
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const privacySeq = useRef(createLatestWins<PrivacyField>()).current;

  const togglePrivacy = async (patch: {lastSeenVisible?: boolean; readReceiptsEnabled?: boolean}) => {
    if (!me) {return;}
    const fields = (Object.keys(patch) as PrivacyField[]).filter(f => patch[f] !== undefined);
    const isLatest = privacySeq(fields);
    // Optimistic: flip UI first, revert on failure. Privacy toggles are
    // latency-sensitive (user wants to SEE the switch flip) and the
    // server-side effect is idempotent.
    setMe(cur => (cur ? {...cur, ...patch} : cur));
    // Audit P1-T3 — write-through the read-receipts flag so the
    // runtime's `markRead` gate honours the new value on the very
    // next read without a screen re-mount.
    if (patch.readReceiptsEnabled !== undefined) {
      void cacheReadReceiptsEnabled(patch.readReceiptsEnabled);
    }
    try {
      const next = await client.updatePrivacy(patch);
      if (!isLatest()) {return;}
      // Why: merge only this request's fields — a full setMe(next) could
      // clobber a newer optimistic flip on the other toggle mid-flight.
      setMe(cur => {
        if (!cur) {return next;}
        const merged = {...cur};
        for (const f of fields) {merged[f] = next[f];}
        return merged;
      });
      if (patch.readReceiptsEnabled !== undefined) {
        void cacheReadReceiptsEnabled(next.readReceiptsEnabled);
      }
    } catch (e) {
      if (!isLatest()) {return;}
      // Why: revert by flipping the patch on CURRENT state — the captured
      // `me` may predate other toggles and would restore stale values.
      const revert: Partial<Me> = {};
      for (const f of fields) {revert[f] = !patch[f];}
      setMe(cur => (cur ? {...cur, ...revert} : cur));
      // Revert the cache too — leaving it on the optimistic value
      // would silently disable receipts even though the server still
      // has the old setting.
      if (patch.readReceiptsEnabled !== undefined) {
        void cacheReadReceiptsEnabled(!patch.readReceiptsEnabled);
      }
      Alert.alert('Could not update', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const unblock = async (userId: string) => {
    try {
      await client.unblock(userId);
      setBlocked(list => list.filter(b => b.userId !== userId));
      // M-07 — clear the local block so this peer's messages deliver again.
      void removeBlockedPeer(userId);
    } catch (e) {
      Alert.alert('Unblock failed', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  if (loading) {
    return (
      <View style={[styles.root, {alignItems:'center', justifyContent:'center', paddingTop: insets.top}]}>
        <ActivityIndicator color="#1E88FF" />
      </View>
    );
  }

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <KeyboardAvoidingScreen contentContainerStyle={{paddingBottom: insets.bottom + 48}}>
        <Text style={styles.sectionLabel}>Profile</Text>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Display name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            placeholderTextColor="#7E8AA6"
            maxLength={80}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Bio</Text>
          <TextInput
            style={[styles.input, {minHeight: 64}]}
            value={bio}
            onChangeText={setBio}
            placeholder="Something about yourself…"
            placeholderTextColor="#7E8AA6"
            maxLength={280}
            multiline
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Avatar URL</Text>
          <TextInput
            style={styles.input}
            value={avatarUrl}
            onChangeText={setAvatarUrl}
            placeholder="https://…"
            placeholderTextColor="#7E8AA6"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <TouchableOpacity
          style={[styles.saveBtn, saving && {opacity: 0.5}]}
          onPress={() => { void save(); }}
          disabled={saving}
          activeOpacity={0.85}>
          <Text style={styles.saveBtnText}>{saving ? 'SAVING…' : 'SAVE PROFILE'}</Text>
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>Privacy</Text>
        <View style={styles.row}>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>Show last seen</Text>
            <Text style={styles.rowHint}>Contacts can see when you were last online.</Text>
          </View>
          <Switch
            value={me?.lastSeenVisible ?? true}
            onValueChange={v => togglePrivacy({lastSeenVisible: v})}
            trackColor={{false: '#244C82', true: '#1E88FF'}}
          />
        </View>
        <View style={styles.row}>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>Send read receipts</Text>
            <Text style={styles.rowHint}>Let senders know when you've read their messages.</Text>
          </View>
          <Switch
            value={me?.readReceiptsEnabled ?? true}
            onValueChange={v => togglePrivacy({readReceiptsEnabled: v})}
            trackColor={{false: '#244C82', true: '#1E88FF'}}
          />
        </View>

        <Text style={styles.sectionLabel}>Notifications</Text>
        <View style={styles.row}>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>Show message preview</Text>
            <Text style={styles.rowHint}>Show the sender and a message preview in notifications. Off keeps banners to the sender's name only.</Text>
          </View>
          <Switch
            value={notifPreview}
            onValueChange={toggleNotifPreview}
            trackColor={{false: '#244C82', true: '#1E88FF'}}
          />
        </View>

        <Text style={styles.sectionLabel}>Chat Backup</Text>
        <TouchableOpacity
          style={styles.row}
          activeOpacity={0.75}
          onPress={() => navigation.navigate('BackupSetup')}>
          <View style={styles.backupIconWrap}>
            <Icon name="shield-key-outline" size={20} color="#1E88FF" />
          </View>
          <View style={{flex:1}}>
            <Text style={styles.rowTitle}>End-to-end encrypted backup</Text>
            <Text style={styles.rowHint}>
              {backupEnabled
                ? 'On · chats are backed up.'
                : 'Set a password so chats survive reinstall + new device.'}
            </Text>
          </View>
          <Icon name="chevron-right" size={20} color="#7E8AA6" />
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>Blocked · {blocked.length}</Text>
        {blocked.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Icon name="shield-check-outline" size={28} color="#244C82" />
            <Text style={styles.emptyBlockText}>You haven't blocked anyone.</Text>
          </View>
        ) : (
          blocked.map(b => (
            <View key={b.userId} style={styles.row}>
              <View style={styles.blockAv}>
                <Text style={styles.blockAvText}>{initials(b.displayName)}</Text>
              </View>
              <View style={{flex:1}}>
                <Text style={styles.rowTitle}>{b.displayName}</Text>
              </View>
              <TouchableOpacity onPress={() => { void unblock(b.userId); }} activeOpacity={0.8} style={styles.unblockBtn}>
                <Text style={styles.unblockBtnText}>UNBLOCK</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </KeyboardAvoidingScreen>
    </View>
  );
}

function initials(s: string): string {
  return s.split(/\s+/).slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase() || '·';
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},
  header: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingTop:6, paddingBottom:12, borderBottomWidth:1, borderBottomColor:'#1C3B66'},
  backBtn: {width:32, height:32, borderRadius:16, alignItems:'center', justifyContent:'center'},
  headerTitle: {flex:1, color:'#FFFFFF', fontSize:13, fontWeight:'800', letterSpacing:3, textTransform:'uppercase'},

  sectionLabel: {color:'#7E8AA6', fontSize:9, fontWeight:'800', letterSpacing:3, textTransform:'uppercase', paddingHorizontal:16, paddingTop:18, paddingBottom:8},

  field: {paddingHorizontal:16, paddingVertical:6},
  fieldLabel: {color:'#B8C7E0', fontSize:10, fontWeight:'700', letterSpacing:1, marginBottom:4},
  input: {color:'#FFFFFF', fontSize:13, backgroundColor:'#162F54', borderRadius:10, paddingHorizontal:12, paddingVertical:10, borderWidth:1, borderColor:'#1C3B66'},

  saveBtn: {marginHorizontal:16, marginTop:14, height:44, borderRadius:10, backgroundColor:Colors.primary, alignItems:'center', justifyContent:'center'},
  saveBtnText: {color:'#FFF', fontSize:12, fontWeight:'800', letterSpacing:2},

  row: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingVertical:12, borderTopWidth:1, borderTopColor:'#1C3B66'},
  rowTitle: {color:'#FFFFFF', fontSize:13, fontWeight:'700'},
  rowHint:  {color:'#7E8AA6', fontSize:10.5, marginTop:2},

  emptyBlock: {alignItems:'center', paddingVertical:28, gap:8},
  emptyBlockText: {color:'#7E8AA6', fontSize:12},

  backupIconWrap: {width:36, height:36, borderRadius:10, backgroundColor:'rgba(30,136,255,0.12)', borderWidth:1, borderColor:'rgba(30,136,255,0.3)', alignItems:'center', justifyContent:'center'},
  blockAv: {width:36, height:36, borderRadius:18, backgroundColor:'#1C3B66', alignItems:'center', justifyContent:'center'},
  blockAvText: {color:'#FFFFFF', fontSize:11, fontWeight:'800'},
  unblockBtn: {paddingHorizontal:12, paddingVertical:6, borderRadius:14, backgroundColor:'rgba(248,113,113,0.12)', borderWidth:1, borderColor:'rgba(248,113,113,0.3)'},
  unblockBtnText: {color:'#F87171', fontSize:10, fontWeight:'800', letterSpacing:1.5},
}));
