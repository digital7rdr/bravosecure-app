import React, {useMemo, useState, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useMessengerStore, selectLastMessageByConv} from '@/modules/messenger/store';
import type {LocalConversation} from '@/modules/messenger/store';
import {departmentApi} from '@services/api';
import {DEPT_CHAT_V2} from '@utils/constants';
import {useEntitlements, showEnterpriseUpgradePrompt} from '@store/entitlements';
import {openPricing} from '@navigation/openPricing';
import {formatListTimestamp} from '@utils/helpers';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'Groups'>;

interface GroupItem {
  id: string;
  name: string;
  lastMsg: string;
  time: string;
  avatarBg: string;
  avatarIcon?: string;
  avatarIconColor?: string;
  initials?: string;
  unread?: number;
  activeMission?: boolean;
  memberCount?: string;
}

function conversationToGroupItem(c: LocalConversation, lastMsgText: string, lastTime: string): GroupItem {
  const name = c.name ?? 'Unnamed group';
  // Defensive: restored conversations from a v1.0.4-or-earlier mirror
  // can have `participants` undefined. v1.0.5+ writes a real array, but
  // we still need to handle pre-existing local rows from older builds
  // without crashing the entire Groups screen.
  const participantCount = c.participants?.length ?? 0;
  const unreadCount      = c.unread_count ?? 0;
  return {
    id:         c.id,
    name,
    lastMsg:    lastMsgText,
    time:       lastTime,
    avatarBg:   avatarBgFor(c.id),
    initials:   initialsOf(name),
    unread:     unreadCount > 0 ? unreadCount : undefined,
    memberCount: participantCount > 0 ? `${participantCount} members` : undefined,
  };
}

function avatarBgFor(seed: string): string {
  const palette = ['#166ED1', '#7C3AED', '#065F46', '#B45309', '#DC2626', '#0369A1'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {h = (h * 31 + seed.charCodeAt(i)) >>> 0;}
  return palette[h % palette.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

function GroupRow({item, onPress}: {item: GroupItem; onPress: () => void}) {
  return (
    <TouchableOpacity style={styles.groupRow} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.avatarWrap}>
        <View style={[
          styles.avatar,
          {backgroundColor: item.avatarBg === 'linear' ? '#166ED1' : item.avatarBg},
        ]}>
          {item.avatarIcon
            ? <Icon name={item.avatarIcon} size={22} color={item.avatarIconColor ?? '#FFF'} />
            : <Text style={styles.avatarText}>{item.initials}</Text>
          }
        </View>
        {item.activeMission && <View style={styles.missionDot} />}
      </View>
      <View style={styles.groupInfo}>
        <View style={styles.groupTopRow}>
          <Text style={styles.groupName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.groupTime}>{item.time}</Text>
        </View>
        <View style={styles.groupBottomRow}>
          <Text style={styles.groupLastMsg} numberOfLines={1}>{item.lastMsg}</Text>
          {item.unread
            ? <View style={styles.unreadBadge}><Text style={styles.unreadText}>{item.unread}</Text></View>
            : item.memberCount
            ? <Text style={styles.memberCount}>{item.memberCount}</Text>
            : null
          }
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function GroupsScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const entitlements = useEntitlements();
  const conversations = useMessengerStore(s => s.conversations);
  // Round 6 / perf — subscribe to the last-message-per-conversation
  // map only. This screen never reads anything but the LAST bubble of
  // each group; previously it took the entire `s.messages` map and
  // re-rendered on every append in every chat (group OR direct).
  // selectLastMessageByConv is memoised on the live messages map, so
  // an append that moves a group's last message produces a fresh
  // outer reference (re-render); an append to a direct chat we don't
  // display still flips the WeakMap key but the screen's downstream
  // useMemo bails because no group's lastMsg changed.
  const lastByConv = useMessengerStore(selectLastMessageByConv);

  // Hide departmental-channel groups here too — they belong only in the Departmental module's
  // Channels tab, not the messenger Groups list. (Same server-authoritative exclusion set as
  // MessengerHomeScreen.) Flag-gated; a non-dept user's listChannels 403s → empty set.
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
      } catch { /* not a dept member / flag off */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // WhatsApp parity: groups sorted by LAST ACTIVITY (newest message
  // first), with creation date as the fallback when there are no
  // messages yet. Previously sorted purely by created_at, so a group
  // you actively chat in would sink under a freshly-created empty one.
  const groups = useMemo<GroupItem[]>(() => {
    const arr = Object.values(conversations)
      .filter(c => c.type === 'group' && !deptGroupIds.has(c.id))
      .map(c => {
        const last = lastByConv[c.id];
        const lastText = last
          ? (last.type === 'image' ? '📷 Photo' : last.type === 'file' ? '📎 Attachment' : (last.content || '(encrypted)'))
          : 'End-to-end encrypted · tap to start';
        const lastTime = last ? formatListTimestamp(last.created_at) : '';
        const sortKey = last ? Date.parse(last.created_at) :
          c.created_at ? Date.parse(c.created_at) : 0;
        return {item: conversationToGroupItem(c, lastText, lastTime), sortKey};
      });
    arr.sort((a, b) => b.sortKey - a.sortKey);
    return arr.map(x => x.item);
  }, [conversations, lastByConv, deptGroupIds]);

  const openGroup = (g: GroupItem) => {
    navigation.navigate('Chat', {conversationId: g.id, name: g.name, isGroup: true});
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
          style={{paddingRight: 12}}>
          <Icon name="arrow-left" size={20} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, {flex: 1}]}>Groups</Text>
        <TouchableOpacity
          style={styles.newGroupBtn}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('NewChat' as never)}>
          <Icon name="plus" size={14} color="#1E88FF" />
          <Text style={styles.newGroupText}>New Group</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[{paddingBottom: insets.bottom + 80}]}
        showsVerticalScrollIndicator={false}>

        {/* B-91 M1 R5 — Departmental Chat is an ENTERPRISE feature (spec p.8).
            Non-Enterprise accounts see the card locked; tapping it opens the
            upgrade prompt instead of the feature. The server's
            DeptChatAccessGuard remains the real gate — this is presentation. */}
        <TouchableOpacity
          style={[styles.deptRow, !entitlements.hasDeptChannels && styles.deptRowLocked]}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityState={{disabled: !entitlements.hasDeptChannels}}
          accessibilityLabel={entitlements.hasDeptChannels
            ? 'Open Departmental Chat'
            : 'Departmental Chat, Enterprise feature, locked'}
          onPress={() => {
            if (entitlements.hasDeptChannels) {
              navigation.navigate('DepartmentChannels' as never);
            } else {
              // M1A — the Enterprise tier is now purchasable in-app: route
              // "View Enterprise" into Settings → Pricing instead of the
              // old contact-us explainer.
              showEnterpriseUpgradePrompt({onViewPlans: openPricing});
            }
          }}>
          <View style={styles.deptIcon}>
            <Icon
              name={entitlements.hasDeptChannels ? 'forum' : 'lock-outline'}
              size={20}
              color="#1E88FF"
            />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.deptTitle}>Departmental Chat</Text>
            <Text style={styles.deptSub}>Team broadcast channels · Enterprise</Text>
          </View>
          <View style={styles.deptProTag}>
            <Text style={styles.deptProTagText}>ENTERPRISE</Text>
          </View>
          <Icon name="chevron-right" size={18} color="#334155" />
        </TouchableOpacity>

        {groups.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Icon name="account-group-outline" size={44} color="#244C82" />
            <Text style={styles.emptyTitle}>No groups yet</Text>
            <Text style={styles.emptyHint}>
              Groups broadcast as N pairwise sealed Signal envelopes — the
              server never sees membership. Tap below to start one.
            </Text>
            <TouchableOpacity
              style={styles.emptyCta}
              activeOpacity={0.85}
              onPress={() => navigation.navigate('NewChat')}>
              <Icon name="plus" size={16} color="#FFF" />
              <Text style={styles.emptyCtaText}>Create Group</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Your Groups · {groups.length}</Text>
            {groups.map(g => (
              <GroupRow key={g.id} item={g} onPress={() => openGroup(g)} />
            ))}
          </>
        )}

      </ScrollView>

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, {bottom: insets.bottom + 16}]}
        activeOpacity={0.85}
        onPress={() => navigation.navigate('NewChat')}>
        <Icon name="account-multiple-plus" size={22} color="#FFF" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1C3B66'},
  headerTitle: {fontSize: 17, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 3, color: '#FFFFFF'},
  newGroupBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, backgroundColor: 'rgba(30,136,255,0.08)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.35)'},
  newGroupText: {fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, color: '#1E88FF'},

  sectionLabel: {fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', color: '#7E8AA6', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6},

  deptRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 12, padding: 14, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 14},
  deptRowLocked: {opacity: 0.62},
  deptIcon: {width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(30,136,255,0.12)', alignItems: 'center', justifyContent: 'center'},
  deptTitle: {fontSize: 14, fontWeight: '700', color: '#F1F5F9'},
  deptSub: {fontSize: 11.5, color: '#64748B', marginTop: 2},
  deptProTag: {backgroundColor: '#166ED1', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5},
  deptProTagText: {fontSize: 8, fontWeight: '800', color: '#FFF', letterSpacing: 1},

  groupRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1C3B66'},
  avatarWrap: {position: 'relative', flexShrink: 0},
  avatar: {width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center'},
  avatarText: {fontSize: 13, fontWeight: '800', color: '#FFF'},
  missionDot: {position: 'absolute', top: -4, right: -4, width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444', shadowColor: '#ef4444', shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.6, shadowRadius: 4},
  groupInfo: {flex: 1, minWidth: 0},
  groupTopRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3},
  groupName: {fontSize: 13, fontWeight: '700', color: '#FFFFFF', flex: 1},
  groupTime: {fontSize: 10, color: '#7E8AA6', flexShrink: 0, marginLeft: 8},
  groupBottomRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  groupLastMsg: {fontSize: 11, color: '#B8C7E0', flex: 1},
  unreadBadge: {minWidth: 18, height: 18, borderRadius: 9, backgroundColor: '#1E88FF', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, marginLeft: 8},
  unreadText: {fontSize: 10, fontWeight: '800', color: '#FFF'},
  memberCount: {fontSize: 10, color: '#7E8AA6', marginLeft: 8},

  fab: {position: 'absolute', right: 20, width: 52, height: 52, borderRadius: 26, backgroundColor: '#1E88FF', alignItems: 'center', justifyContent: 'center', shadowColor: '#1E88FF', shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.5, shadowRadius: 16, elevation: 8},

  emptyWrap: {alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32, gap: 10},
  emptyTitle: {color: '#B8C7E0', fontSize: 14, fontWeight: '700', marginTop: 8},
  emptyHint: {color: '#7E8AA6', fontSize: 11, textAlign: 'center', lineHeight: 16, maxWidth: 300},
  emptyCta: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 99, backgroundColor: '#1E88FF'},
  emptyCtaText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.5},
}));
