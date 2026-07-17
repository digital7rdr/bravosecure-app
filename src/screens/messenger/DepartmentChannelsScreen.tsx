import React, {useCallback, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useAuthStore} from '@store/authStore';
import {useEntitlements} from '@store/entitlements';
import {departmentApi, type DepartmentChannelDto} from '@services/api';
import {ensureChannelProvisioned} from '@/modules/messenger/orgWorkspace/provisionChannel';
import {drainMembershipIntents} from '@/modules/messenger/orgWorkspace/membershipIntents';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {OB, Card, SectionLabel, channelStateMeta} from '@screens/deptchat/_obsidian';

type IconName = React.ComponentProps<typeof Icon>['name'];

// Channel-type → section label + row glyph. The design uses a `#` hash for the
// department list; board/incident groups keep their own glyph so the type still
// reads at a glance (the app surfaces more channel types than the mock).
const GROUPS = [
  {type: 'board', label: 'Board', icon: 'bullhorn-variant-outline'},
  {type: 'department', label: 'Department', icon: 'pound'},
  {type: 'incident', label: 'Incident', icon: 'shield-alert-outline'},
] as const;

export default function DepartmentChannelsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const user = useAuthStore(s => s.user);
  // Entitlement: org tenancy (service-provider company / ACTIVE CPO/manager)
  // OR an active Enterprise tier (M1A rule 16 — the individual runs their own
  // single-tenant workspace). One selector, mirroring DeptChatAccessGuard's
  // three paths — this screen previously kept an inline org-only copy of the
  // rule and locked paying Enterprise users out of their own workspace.
  const entitlements = useEntitlements();
  const entitled = entitlements.hasDeptChannels;
  // Company/agency account surfaces the manage entry (delegated managers are
  // allowed server-side too; the button is just a soft hint). Prefer the
  // server-resolved is_org_manager flag (mirrors OrgManagerGuard) so a manager
  // who is also a CPO elsewhere isn't hidden; fall back to the heuristic.
  const isManager = !!user && (user.is_org_manager ?? (user.role === 'service_provider' || user.account_kind === 'agency'));

  const [channels, setChannels] = useState<DepartmentChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [provisioning, setProvisioning] = useState<string | null>(null);

  // Summary chips. Unread is a local concept (the relay only holds ciphertext),
  // so total unread is summed from the encrypted messenger store per channel.
  const totalUnread = useMessengerStore(s =>
    channels.reduce((sum, c) =>
      sum + (c.group_conversation_id ? (s.conversations[c.group_conversation_id]?.unread_count ?? 0) : 0), 0),
  );
  const adminCount = channels.filter(c => c.my_role === 'admin').length;

  // Open a channel. If it has no Signal group yet AND the caller is an admin,
  // bootstrap the encrypted group on this device (makeNewGroup via the
  // existing createGroupChat) and register its id with the channel metadata,
  // THEN navigate. Viewers on an unprovisioned channel just see the honest
  // "not yet active" state inside the chat screen.
  // Owner reactivation of an orphaned channel: clear the dead linkage server-side,
  // then mint a fresh encrypted group + register it, then open it.
  const recoverChannel = useCallback(async (c: DepartmentChannelDto) => {
    setProvisioning(c.id);
    try {
      await departmentApi.resetGroup(c.id);
      const res = await ensureChannelProvisioned(c.id, c.name, null);
      if (res.status === 'ok') {
        setChannels(prev => prev.map(ch =>
          ch.id === c.id ? {...ch, group_conversation_id: res.groupConversationId} : ch));
        navigation.navigate('DepartmentChat', {
          channelId: c.id, channelName: c.name, channelDesc: c.description ?? '',
          groupConversationId: res.groupConversationId, myRole: c.my_role, isOwner: true,
        });
      } else if (res.status === 'needs_members') {
        Alert.alert('Channel reactivated', 'No other members were reachable to re-key yet. Add a member to start messaging.');
      } else if (res.status === 'failed') {
        Alert.alert('Could not reactivate', res.message);
      }
    } catch (e) {
      Alert.alert('Could not reactivate', (e as Error)?.message ?? 'Reset failed.');
    } finally {
      setProvisioning(null);
    }
  }, [navigation]);

  const openChannel = useCallback(async (c: DepartmentChannelDto) => {
    let groupConversationId = c.group_conversation_id;
    const isOwner = !!user?.id && c.created_by === user.id;
    const hasKey = !!groupConversationId &&
      !!useMessengerStore.getState().groups[groupConversationId]?.masterKeyB64;

    if (!groupConversationId && c.my_role === 'admin') {
      // First-time provisioning of a brand-new / seeded default channel.
      setProvisioning(c.id);
      const res = await ensureChannelProvisioned(c.id, c.name, c.group_conversation_id);
      setProvisioning(null);
      if (res.status === 'ok' || res.status === 'already') {
        groupConversationId = res.groupConversationId;
        setChannels(prev => prev.map(ch =>
          ch.id === c.id ? {...ch, group_conversation_id: res.groupConversationId} : ch));
      } else if (res.status === 'needs_members') {
        Alert.alert('Channel not active yet',
          'Add a member to this channel first — its encrypted group is created once there is someone to message.');
        return;
      } else {
        Alert.alert('Could not open channel', res.message);
        return;
      }
    } else if (groupConversationId && !hasKey && isOwner) {
      // ORPHANED: the owner's device has the channel's group id but lost its master
      // key (re-share is impossible — the owner IS the key source). Reset the server
      // linkage and mint a FRESH group so the channel sends/receives again. This
      // re-keys the current members (fixes "explicit peer address" + empty threads).
      Alert.alert('Reactivate channel?',
        'This channel lost its encryption key on this device. Reactivating creates a fresh encrypted group and re-keys its members. Earlier messages stay unreadable.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Reactivate', onPress: () => { void recoverChannel(c); }},
        ]);
      return;
    }
    navigation.navigate('DepartmentChat', {
      channelId: c.id,
      channelName: c.name,
      channelDesc: c.description ?? '',
      groupConversationId,
      myRole: c.my_role,
      isOwner,
    });
  }, [navigation, user?.id, recoverChannel]);

  const load = useCallback(async () => {
    if (!entitled) {setLoading(false); return;}
    try {
      const {data} = await departmentApi.listChannels();
      setChannels(data.channels);
      // Security: drain any pending membership-change intents so removed CPOs
      // are rekeyed out (and new ones rekeyed in). Best-effort, admin-device
      // only — non-admins / unprovisioned channels are skipped server+client.
      void drainMembershipIntents().catch(() => {});
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, [entitled]);

  // D5-a — pull-to-refresh so a viewer can force a directory + provisioning-state refresh
  // (an admin may have just activated a channel) without waiting for the next focus.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  // Refresh on focus so unread counts reflect reads done inside a channel, and so the
  // list unlocks the instant Pro is activated via the paywall. D5-b — useFocusEffect ALSO
  // fires on mount, so a separate useEffect(load) would double-fire load() (and two
  // concurrent drainMembershipIntents passes); the single focus path is the only loader.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // ── Org-membership gate (workspace is an org feature, not individual Pro) ──
  if (!entitled) {
    return (
      <View style={[styles.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
        <AmbientBg bg={OB.bg} />
        <ChannelsHeader onBack={() => navigation.goBack()} />
        <View style={styles.gateWrap}>
          <View style={styles.gateIcon}>
            <Icon name="forum-outline" size={38} color={OB.accentSoft} />
          </View>
          <Text style={styles.gateTitle}>Department Channels</Text>
          <Text style={styles.gateSub}>
            Department channels are part of a service-provider organisation
            workspace — managers create channels and add their CPOs and staff.
            Once you're added to an org, your channels appear here.
          </Text>
          <View style={styles.gateBullets}>
            {[
              'Board, department and incident channels',
              'Same AES-256 Signal Protocol encryption as all Bravo chats',
              'Managers post; CPOs read — unread badges per channel',
            ].map(b => (
              <View key={b} style={styles.gateBulletRow}>
                <Icon name="check-circle" size={15} color={OB.signal} />
                <Text style={styles.gateBulletText}>{b}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.gateHint}>Ask your organisation admin for access.</Text>
        </View>
      </View>
    );
  }

  // ── Entitled: real channel directory ──────────────────────────────────
  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ChannelsHeader
        onBack={() => navigation.goBack()}
        onManage={isManager ? () => navigation.navigate('ManageChannels') : undefined}
      />

      {/* M1A rule 16 — attendance + incident reporting live in the full
          workspace shell (the same navigator providers mount). Managers run
          shifts/reviews/queues there; employees check in and report. */}
      <TouchableOpacity
        style={styles.workspaceRow}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Open attendance and incident reporting"
        onPress={() => navigation.navigate('Departmental')}>
        <View style={styles.workspaceIcon}>
          <Icon name="calendar-check-outline" size={19} color={OB.accentSoft} />
        </View>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={styles.workspaceTitle}>Attendance & Incidents</Text>
          <Text style={styles.workspaceSub}>
            {isManager ? 'Shifts, day status, reviews and the incident queue' : 'Check in and report incidents'}
          </Text>
        </View>
        <Icon name="chevron-right" size={20} color={OB.textMute} />
      </TouchableOpacity>

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color={OB.accentSoft} size="large" />
        </View>
      ) : channels.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={styles.gateIcon}>
            <Icon name="forum-outline" size={34} color={OB.textMute} />
          </View>
          <Text style={styles.emptyText}>No channels yet</Text>
          {isManager ? (
            // M1A rule 16 — an owner/manager (incl. an Enterprise individual)
            // creates channels and enrolls employees right here, not via ops.
            <>
              <Text style={styles.emptySub}>
                Create your first channel, then add your team under Employees.
              </Text>
              <View style={styles.emptyCtas}>
                <TouchableOpacity
                  style={styles.emptyCta}
                  onPress={() => navigation.navigate('ManageChannels')}
                  accessibilityRole="button">
                  <Icon name="plus-circle-outline" size={16} color="#FFF" />
                  <Text style={styles.emptyCtaText}>Create channel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.emptyCta, styles.emptyCtaGhost]}
                  onPress={() => navigation.navigate('Employees')}
                  accessibilityRole="button">
                  <Icon name="account-multiple-plus-outline" size={16} color={OB.accentSoft} />
                  <Text style={[styles.emptyCtaText, {color: OB.accentSoft}]}>Employees</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <Text style={styles.emptySub}>Your org admin creates department channels from the Ops console.</Text>
          )}
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }} tintColor={OB.accentSoft} />
          }
          contentContainerStyle={[styles.list, {paddingBottom: insets.bottom + 28}]}>

          {/* Summary chips — Channels · Unread · Admin. */}
          <View style={styles.chipRow}>
            <StatChip value={channels.length} label="Channels" tint />
            <StatChip value={totalUnread} label="Unread" tint={totalUnread > 0} accentValue={totalUnread > 0} />
            <StatChip value={adminCount} label="Admin" tint={false} />
          </View>

          {/* Dept Chat v2 (Step 12) — grouped by channel type. Incident/restricted
              channels only appear when the server seeded membership (managers);
              normal CPOs never receive the row, so this is presentation only. */}
          {GROUPS.map(({type, label, icon}) => {
            const group = channels.filter(c => (c.channel_type ?? 'department') === type);
            if (group.length === 0) {return null;}
            return (
              <View key={type} style={styles.groupBlock}>
                <SectionLabel>{label}</SectionLabel>
                <Card style={styles.groupCard}>
                  {group.map((c, i) => (
                    <ChannelRow
                      key={c.id}
                      c={c}
                      icon={icon}
                      last={i === group.length - 1}
                      busy={provisioning === c.id}
                      onPress={() => { void openChannel(c); }}
                    />
                  ))}
                </Card>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

// Per-channel row. Unread is read from the encrypted messenger store (the relay
// holds only ciphertext). An un-provisioned channel (no Signal group) reads as
// INACTIVE — otherwise the shared channelStateMeta drives the badge (PDF p.4).
function ChannelRow({c, icon, last, busy, onPress}: {
  c: DepartmentChannelDto;
  icon: IconName;
  last: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const unread = useMessengerStore(s =>
    c.group_conversation_id ? (s.conversations[c.group_conversation_id]?.unread_count ?? 0) : 0,
  );
  const hot = unread > 0;
  const state = c.group_conversation_id
    ? channelStateMeta({channel_type: c.channel_type, access: c.access, my_role: c.my_role})
    : {label: 'Inactive', color: OB.textMute};
  const tone = badgeTone(state.color);

  return (
    <TouchableOpacity
      style={[styles.row, !last && styles.rowDivider]}
      activeOpacity={0.8}
      disabled={busy}
      onPress={onPress}>
      <View style={[styles.rowIcon, hot && styles.rowIconHot]}>
        <Icon name={icon} size={20} color={hot ? OB.accentSoft : '#7C9BD6'} />
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <View style={styles.rowNameLine}>
          <Text style={[styles.rowName, hot && styles.rowNameHot]} numberOfLines={1}>{c.name}</Text>
          <View style={[styles.badge, {borderColor: tone.bd, backgroundColor: tone.bg}]}>
            <Text style={[styles.badgeText, {color: tone.fg}]}>{state.label}</Text>
          </View>
        </View>
        <Text style={styles.rowPreview} numberOfLines={1}>
          {c.department ?? (c.group_conversation_id ? 'Tap to open' : 'Not yet active')}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator color={OB.accentSoft} size="small" />
      ) : hot ? (
        <LinearGradient
          colors={['#6E9BF5', OB.accentDeep]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={styles.unreadPill}>
          <Text style={styles.unreadPillText}>{unread > 99 ? '99+' : String(unread)}</Text>
        </LinearGradient>
      ) : (
        <Icon name="chevron-right" size={18} color={OB.textMute} />
      )}
    </TouchableOpacity>
  );
}

// channelStateMeta returns OB palette colors (some are rgba() strings, so hex-alpha
// concat is unsafe). Map each state colour to a valid {fg,bg,border} badge tone —
// accent / good / warn are tinted, everything else (read-only, inactive) is neutral.
function badgeTone(color: string): {fg: string; bg: string; bd: string} {
  switch (color) {
    case OB.accentSoft: return {fg: OB.accentSoft, bg: 'rgba(91,141,239,0.14)', bd: 'rgba(91,141,239,0.4)'};
    case OB.signal:     return {fg: OB.signal, bg: 'rgba(74,222,128,0.13)', bd: 'rgba(74,222,128,0.36)'};
    case OB.amber:      return {fg: OB.amber, bg: 'rgba(226,200,147,0.13)', bd: 'rgba(226,200,147,0.36)'};
    default:            return {fg: OB.textDim, bg: 'rgba(255,255,255,0.05)', bd: OB.hair2};
  }
}

function StatChip({value, label, tint, accentValue}: {
  value: number; label: string; tint: boolean; accentValue?: boolean;
}) {
  return (
    <View style={[styles.chip, tint ? styles.chipTint : styles.chipPlain]}>
      <Text style={[styles.chipValue, accentValue && {color: OB.accentSoft}]}>{value}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

function ChannelsHeader({onBack, onManage}: {onBack: () => void; onManage?: () => void}) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        style={styles.hBtn}
        onPress={onBack}
        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
        activeOpacity={0.7}>
        <Icon name="chevron-left" size={20} color={OB.text} />
      </TouchableOpacity>
      <View style={styles.hMeta}>
        <Text style={styles.hTitle}>Department Channels</Text>
        <Text style={styles.hSub}>Department threads · unread counts</Text>
      </View>
      {onManage ? (
        <TouchableOpacity
          style={[styles.hBtn, styles.hBtnAccent]}
          onPress={onManage}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="cog-outline" size={19} color={OB.accentSoft} />
        </TouchableOpacity>
      ) : (
        <View style={styles.hSpacer} />
      )}
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  loader: {flex: 1, alignItems: 'center', justifyContent: 'center'},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: OB.hair,
  },
  hBtn: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  hBtnAccent: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.28)'},
  hSpacer: {width: 40},
  hMeta: {flex: 1},
  hTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 20, letterSpacing: -0.4},
  hSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12, marginTop: 2},

  // List
  list: {paddingHorizontal: 20, paddingTop: 20},

  chipRow: {flexDirection: 'row', gap: 10, marginBottom: 22},
  chip: {flex: 1, borderRadius: 15, paddingVertical: 13, paddingHorizontal: 15, borderWidth: 1},
  chipTint: {backgroundColor: 'rgba(91,141,239,0.07)', borderColor: 'rgba(91,141,239,0.24)'},
  chipPlain: {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: OB.hair2},
  chipValue: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5},
  chipLabel: {
    color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '600',
    letterSpacing: 1, textTransform: 'uppercase', marginTop: 2,
  },

  groupBlock: {marginBottom: 22},
  groupCard: {padding: 0},

  row: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15, paddingHorizontal: 16},
  rowDivider: {borderBottomWidth: 1, borderBottomColor: OB.hair},
  rowIcon: {
    width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  rowIconHot: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.4)'},
  rowNameLine: {flexDirection: 'row', alignItems: 'center', gap: 9},
  rowName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16.5, letterSpacing: -0.3, flexShrink: 1},
  rowNameHot: {fontFamily: BravoFont.extraBold},
  rowPreview: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, marginTop: 3},

  badge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  badgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase'},

  unreadPill: {
    minWidth: 24, height: 24, paddingHorizontal: 7, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 3}, shadowOpacity: 0.5, shadowRadius: 10, elevation: 4,
  },
  unreadPillText: {color: '#FFF', fontFamily: BravoFont.extraBold, fontSize: 12},

  // Empty
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32},
  emptyText: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16, marginTop: 4},
  emptySub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', lineHeight: 18},
  emptyCtas: {flexDirection: 'row', gap: 10, marginTop: 16},
  workspaceRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 4, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: OB.hair2, backgroundColor: 'rgba(255,255,255,0.03)'},
  workspaceIcon: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)'},
  workspaceTitle: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13.5},
  workspaceSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  emptyCta: {flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: OB.accent, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11},
  emptyCtaGhost: {backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)'},
  emptyCtaText: {color: '#FFF', fontFamily: BravoFont.semiBold, fontSize: 13},

  // Gate
  gateWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 14},
  gateIcon: {
    width: 84, height: 84, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
  },
  gateTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22},
  gateSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13, textAlign: 'center', lineHeight: 19},
  gateBullets: {alignSelf: 'stretch', gap: 10, marginTop: 4},
  gateBulletRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  gateBulletText: {flex: 1, color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5},
  gateHint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11},
}));
