/**
 * DepartmentalHomeScreen (Dept Chat v2 — Step 19, PDF p.3) — the Home tab of the
 * dedicated Departmental module. ONE component, two variants branched on the
 * canonical `isManager` (mirrors DepartmentChannelsScreen):
 *   · member  → welcome, secure/device-trust cue, today's attendance status, and
 *               quick actions that deep-link into the Attend / Incident / Channels
 *               / Vault tabs.
 *   · manager → the above PLUS role-gated alert tiles — Pending Review count and
 *               Open Incidents count — each deep-linking to the manager root of
 *               the relevant tab.
 * No incident details ever render in the member preview (PDF p.3). Authorization
 * stays server-side; the role-branch only chooses what to surface first.
 */
import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useAuthStore} from '@store/authStore';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {attendanceApi, incidentApi, departmentApi, type ShiftSessionDto, type ShiftDto, type DepartmentChannelDto} from '@services/api';
import type {DepartmentalTabParamList} from '@navigation/types';
import {OB, Card, SectionLabel, attendanceStatusMeta} from './_obsidian';

type IconName = React.ComponentProps<typeof Icon>['name'];
type Nav = BottomTabNavigationProp<DepartmentalTabParamList>;

const isToday = (iso?: string | null): boolean => {
  if (!iso) {return false;}
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
};

export default function DepartmentalHomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const user = useAuthStore(s => s.user);
  // Prefer the server-resolved is_org_manager flag (mirrors OrgManagerGuard);
  // fall back to the account_kind heuristic for a pre-flag cached session.
  const isManager = !!user && (user.is_org_manager ?? (user.role === 'service_provider' || user.account_kind === 'agency'));

  const [shifts, setShifts] = useState<ShiftSessionDto[]>([]);
  const [todayShift, setTodayShift] = useState<ShiftDto | null>(null);
  const [pendingReview, setPendingReview] = useState(0);
  const [openIncidents, setOpenIncidents] = useState(0);
  // Latest-announcement surface (PDF p.3): the org's board / read-only channel.
  // Channel message bodies are E2EE (never in metadata) — we surface the channel
  // + its unread count and deep-link in, rather than decrypting a preview here.
  const [announce, setAnnounce] = useState<DepartmentChannelDto | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The server hardcodes channel.unread_count to 0 (unread is a local concept —
  // the relay only holds ciphertext). Read the real per-channel count from the
  // encrypted messenger store, guarded when the channel has no Signal group yet.
  const announceUnread = useMessengerStore(s =>
    announce?.group_conversation_id ? (s.conversations[announce.group_conversation_id]?.unread_count ?? 0) : 0,
  );

  const load = useCallback(async () => {
    try { const {data} = await attendanceApi.myShifts(); setShifts(data); } catch { /* none */ }
    try { const {data} = await attendanceApi.myTodayShift(); setTodayShift(data ?? null); } catch { /* flag off / none */ }
    try {
      const {data} = await departmentApi.listChannels();
      setAnnounce(
        data.channels.find(c => c.channel_type === 'board')
        ?? data.channels.find(c => c.access === 'read_only')
        ?? null,
      );
    } catch { /* none */ }
    if (isManager) {
      try { const {data} = await attendanceApi.orgSummary(); setPendingReview(data.pendingReview); } catch { /* none */ }
      try {
        const {data} = await incidentApi.queue();
        setOpenIncidents(data.filter(i => i.status !== 'closed' && i.status !== 'resolved').length);
      } catch { /* none */ }
    }
    setRefreshing(false);
  }, [isManager]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const name = (user?.full_name ?? user?.email ?? 'there').split(' ')[0];
  const orgName = user?.org?.name ?? 'your organisation';

  // Member "today" chip — mirrors AttendanceScreen's derivation.
  const openShift = shifts.find(s => s.status === 'open') ?? null;
  const todaySession = shifts.find(s => isToday(s.clock_in_at)) ?? null;
  const today = openShift
    ? {label: 'On shift', color: OB.signal, icon: 'shield-check' as IconName}
    : todaySession?.attendance_status
      ? {...attendanceStatusMeta(todaySession.attendance_status)}
      : todayShift
        ? {label: 'Not checked in', color: OB.amber, icon: 'shield-alert-outline' as IconName}
        : {label: 'No shift today', color: OB.textMute, icon: 'shield-outline' as IconName};

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      {/* Header — exit returns to the host shell (CPO tabs / Agent dashboard). */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.exit}
          onPress={() => navigation.getParent()?.goBack()}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Departmental</Text>
        <View style={{width: 36}} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 28}}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(); }}
            tintColor={OB.accentSoft}
          />
        }>

        {/* Welcome */}
        <Text style={s.welcome}>Welcome, {name}</Text>
        <Text style={s.org}>{orgName} · Department</Text>

        {/* Secure / device-trust indicator (E2EE is always on). */}
        <Card style={s.secureCard}>
          <View style={s.secureIcon}>
            <Icon name="shield-lock" size={18} color={OB.signal} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.secureTitle}>Secure connection</Text>
            <Text style={s.secureSub}>End-to-end encrypted · device trusted</Text>
          </View>
          <View style={s.secureDot} />
        </Card>

        {/* Latest announcement (PDF p.3) — the board / read-only channel, with its
            unread count, deep-linking into the channel thread. */}
        {announce ? (
          <Card
            style={s.announceCard}
            onPress={() => navigation.navigate('Channels', {
              screen: 'DepartmentChat',
              params: {
                channelId: announce.id,
                channelName: announce.name,
                channelDesc: announce.description ?? '',
                groupConversationId: announce.group_conversation_id,
                myRole: announce.my_role,
              },
            })}>
            <View style={s.announceIcon}><Icon name="bullhorn-variant-outline" size={18} color={OB.accentSoft} /></View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.announceLabel}>ANNOUNCEMENTS</Text>
              <Text style={s.announceName} numberOfLines={1}>{announce.name}</Text>
            </View>
            {announceUnread > 0 ? (
              <View style={s.announceBadge}><Text style={s.announceBadgeText}>{announceUnread > 9 ? '9+' : String(announceUnread)}</Text></View>
            ) : <Icon name="chevron-right" size={18} color={OB.textMute} />}
          </Card>
        ) : null}

        {/* Member: today's attendance status. */}
        {!isManager && (
          <Card style={s.statusCard} onPress={() => navigation.navigate('Attend')}>
            <View style={[s.statusIcon, {borderColor: today.color + '66', backgroundColor: today.color + '14'}]}>
              <Icon name={today.icon} size={22} color={today.color} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.statusLabel}>Today's attendance</Text>
              <Text style={[s.statusValue, {color: today.color}]}>{today.label}</Text>
            </View>
            <Icon name="chevron-right" size={18} color={OB.textMute} />
          </Card>
        )}

        {/* Manager: role-gated alert tiles. */}
        {isManager && (
          <>
            <SectionLabel>NEEDS ATTENTION</SectionLabel>
            <View style={s.tileRow}>
              <AlertTile
                icon="clipboard-check-outline"
                count={pendingReview}
                label="Pending review"
                tint={OB.amber}
                onPress={() => navigation.navigate('Attend')}
              />
              <AlertTile
                icon="alert-decagram-outline"
                count={openIncidents}
                label="Open incidents"
                tint={OB.alert}
                onPress={() => navigation.navigate('Incident')}
              />
            </View>
          </>
        )}

        {/* Quick actions — deep-link into the tabs. */}
        <SectionLabel>QUICK ACTIONS</SectionLabel>
        <View style={s.grid}>
          <ActionCard
            icon="calendar-check"
            title={isManager ? 'Attendance' : 'My attendance'}
            sub={isManager ? 'Review & approve' : 'Check in & history'}
            onPress={() => navigation.navigate('Attend')}
          />
          <ActionCard
            icon={isManager ? 'alert-decagram-outline' : 'alert-octagon-outline'}
            title={isManager ? 'Incidents' : 'Report incident'}
            sub={isManager ? 'Manage the queue' : 'Log an incident'}
            onPress={() => {
              // Member: jump straight into the report wizard (the Incident tab's
              // member root is now the My-Reports list — Step 23). Manager: the queue.
              if (isManager) { navigation.navigate('Incident'); }
              else { navigation.navigate('Incident', {screen: 'ReportIncidentCategory'}); }
            }}
          />
          <ActionCard
            icon="forum-outline"
            title="Channels"
            sub="Secure team comms"
            onPress={() => navigation.navigate('Channels')}
          />
          <ActionCard
            icon="shield-lock-outline"
            title="Vault"
            sub="Files · MFA protected"
            onPress={() => navigation.navigate('Vault')}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function AlertTile({icon, count, label, tint, onPress}: {
  icon: IconName; count: number; label: string; tint: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={s.tile} activeOpacity={0.85} onPress={onPress}>
      <View style={s.tileTop}>
        <Icon name={icon} size={18} color={tint} />
        <Text style={[s.tileCount, {color: count > 0 ? tint : OB.textMute}]}>{count}</Text>
      </View>
      <Text style={s.tileLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function ActionCard({icon, title, sub, onPress}: {
  icon: IconName; title: string; sub: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={s.action} activeOpacity={0.85} onPress={onPress}>
      <View style={s.actionIcon}>
        <Icon name={icon} size={20} color={OB.accentSoft} />
      </View>
      <Text style={s.actionTitle}>{title}</Text>
      <Text style={s.actionSub} numberOfLines={1}>{sub}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, gap: 10,
  },
  exit: {
    width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  headerTitle: {flex: 1, textAlign: 'center', color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 15, letterSpacing: 0.4},

  welcome: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 24, letterSpacing: -0.5, marginTop: 12},
  org: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13, marginTop: 3},

  secureCard: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18},
  secureIcon: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.32)',
  },
  secureTitle: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13.5},
  secureSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 2},
  secureDot: {width: 9, height: 9, borderRadius: 5, backgroundColor: OB.signal},

  announceCard: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12},
  announceIcon: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  announceLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1.4, textTransform: 'uppercase'},
  announceName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14, marginTop: 2},
  announceBadge: {minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: OB.accent},
  announceBadgeText: {color: '#FFF', fontFamily: BravoFont.bold, fontSize: 11},

  statusCard: {flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12},
  statusIcon: {width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  statusLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase'},
  statusValue: {fontFamily: BravoFont.bold, fontSize: 17, marginTop: 3, letterSpacing: -0.2},

  tileRow: {flexDirection: 'row', gap: 12},
  tile: {
    flex: 1, borderRadius: 16, padding: 15, gap: 10,
    backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair,
  },
  tileTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  tileCount: {fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5},
  tileLabel: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 12.5},

  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  action: {
    width: '47.5%', flexGrow: 1, borderRadius: 16, padding: 15, gap: 7,
    backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair,
  },
  actionIcon: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  actionTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14, marginTop: 3},
  actionSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5},
}));
