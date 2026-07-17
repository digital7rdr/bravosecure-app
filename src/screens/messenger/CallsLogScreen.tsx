import React, {useMemo, useState} from 'react';
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
import {useMessengerStore, selectCallMessages} from '@/modules/messenger/store';
import {scaleTextStyles} from '@utils/scaling';

type FilterTab = 'all' | 'missed' | 'voice' | 'video';

interface CallLog {
  id: string;
  conversationId: string;
  name: string;
  initials: string;
  bg: string;
  rounded: boolean;
  type: 'voice' | 'video';
  /** WhatsApp-style direction+outcome combined for the colored arrow. */
  direction: 'in' | 'out' | 'missed';
  /** Outcome from call_meta — drives the red/green tint on the icon. */
  outcome: 'answered' | 'missed' | 'declined' | 'failed' | 'ended-by-host';
  duration?: string;
  time: string;
  timestampMs: number;
  isGroup?: boolean;
}

const PALETTE = ['#1B3A66', '#7C3AED', '#0EA5E9', '#F59E0B', '#10B981', '#EF4444'];
function avatarBg(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {h = (h * 31 + seed.charCodeAt(i)) >>> 0;}
  return PALETTE[h % PALETTE.length];
}
function initialsOf(s: string): string {
  return s.split(/\s+/).slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase() || '?';
}
function fmtDuration(sec?: number): string | undefined {
  if (!sec || sec < 1) {return undefined;}
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) {return `${s}s`;}
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)        {return 'just now';}
  if (diff < 3_600_000)     {return `${Math.floor(diff / 60_000)}m ago`;}
  if (diff < 86_400_000)    {return `${Math.floor(diff / 3_600_000)}h ago`;}
  if (diff < 7 * 86_400_000){return `${Math.floor(diff / 86_400_000)}d ago`;}
  return new Date(ms).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

const FILTERS: {key: FilterTab; label: string}[] = [
  {key: 'all', label: 'All'},
  {key: 'missed', label: 'Missed'},
  {key: 'voice', label: 'Voice'},
  {key: 'video', label: 'Video'},
];

export default function CallsLogScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterTab>('all');
  // Round 6 / perf — subscribe ONLY to the call-message slice (already
  // filtered + sorted newest-first by selectCallMessages, memoised on
  // the live `messages` map). Previously this screen subscribed to the
  // entire `s.messages` map, so any append to ANY chat re-rendered the
  // call log. Now it only re-renders when an actual call bubble is
  // added/removed (the sort is stable across same-input identity, so
  // the frozen array reference is reused until the underlying map flips).
  const callMessages  = useMessengerStore(selectCallMessages);
  const conversations = useMessengerStore(s => s.conversations);

  // Build the row view-models. The selector handed us the filtered +
  // sorted message list; we still need the per-row name / direction
  // mapping, but that's pure transform.
  const calls: CallLog[] = useMemo(() => {
    const out: CallLog[] = [];
    for (const m of callMessages) {
      const meta = m.call_meta!;
      const convId = m.conversation_id;
      const conv = conversations[convId];
      const convName = conv?.name ?? convId.replace(/^direct:/, '').slice(0, 8);
      const isGroup  = conv?.type === 'group';
      const ms = m.created_at ? Date.parse(m.created_at) : Date.now();
      const direction: CallLog['direction'] =
        meta.outcome === 'missed' || meta.outcome === 'declined' ? 'missed' :
        meta.direction === 'incoming' ? 'in' : 'out';
      out.push({
        id:             m.id,
        conversationId: convId,
        name:           convName,
        initials:       initialsOf(convName),
        bg:             avatarBg(convId),
        rounded:        true,
        type:           meta.kind,
        direction,
        outcome:        meta.outcome,
        duration:       fmtDuration(meta.duration),
        time:           fmtRelative(ms),
        timestampMs:    ms,
        isGroup,
      });
    }
    return out;
  }, [callMessages, conversations]);

  const visible = calls.filter(c => {
    if (filter === 'all') {return true;}
    if (filter === 'missed') {return c.direction === 'missed';}
    if (filter === 'voice') {return c.type === 'voice';}
    if (filter === 'video') {return c.type === 'video';}
    return true;
  });

  // WhatsApp-style colored direction icons:
  //   • missed/declined → red phone-missed
  //   • outgoing answered → green outgoing-arrow
  //   • incoming answered → green incoming-arrow
  //   • failed → amber alert-triangle
  const getDirectionIcon = (c: CallLog): {name: string; color: string} => {
    if (c.direction === 'missed') {return {name: 'phone-missed', color: '#FF3B3B'};}
    if (c.outcome === 'failed')   {return {name: 'phone-alert', color: '#FFC107'};}
    return {
      name:  c.type === 'video' ? 'video-outline' : 'phone-in-talk',
      color: '#00C853',
    };
  };

  const getDirArrow = (c: CallLog): {name: string; color: string} | null => {
    if (c.direction === 'out')    {return {name: 'arrow-top-right',    color: '#00C853'};}
    if (c.direction === 'in')     {return {name: 'arrow-bottom-left',  color: '#00C853'};}
    if (c.direction === 'missed') {return {name: 'arrow-bottom-left',  color: '#FF3B3B'};}
    return null;
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
        <Text style={[styles.headerTitle, {flex: 1}]}>Calls</Text>
        <TouchableOpacity
          style={styles.linksBtn}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Show links shared in chats"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          onPress={() => navigation.navigate('Links')}>
          <Text style={styles.linksText}>Links</Text>
          <Icon name="chevron-right" size={16} color="#1E88FF" />
        </TouchableOpacity>
      </View>

      {/* Filter tabs */}
      <View style={styles.tabRow}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f.key}
            style={[styles.tab, filter === f.key && styles.tabActive]}
            onPress={() => setFilter(f.key)}
            activeOpacity={0.8}>
            <Text style={[styles.tabText, filter === f.key && styles.tabTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[{paddingBottom: insets.bottom + 24}]}
        showsVerticalScrollIndicator={false}>

        {visible.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Icon name="phone-outline" size={44} color="#244C82" />
            <Text style={styles.emptyTitle}>No calls yet</Text>
            <Text style={styles.emptyHint}>
              Tap the phone or video icon in any chat to start a DTLS-SRTP encrypted call.
              Call history will appear here.
            </Text>
          </View>
        ) : <Text style={styles.sectionLabel}>Recent Calls</Text>}

        {visible.map(c => {
          const dirIcon = getDirectionIcon(c);
          const arrowIcon = getDirArrow(c);
          return (
            <TouchableOpacity
              key={c.id}
              style={styles.callRow}
              onPress={() => {
                // Tapping a call row re-launches the call against the
                // SAME conversation, mirroring WhatsApp. The previous
                // code mistakenly passed the call-record id as
                // conversationId, which didn't resolve any peer.

                const {launchCall} = require('@/modules/messenger/webrtc/launchCall') as typeof import('@/modules/messenger/webrtc/launchCall');
                launchCall(navigation as unknown as {navigate: (s: string, p?: Record<string, unknown>) => void}, {
                  conversationId: c.conversationId,
                  callType:       c.type,
                });
              }}
              activeOpacity={0.8}>

              {/* Avatar */}
              <View style={[
                styles.avatar,
                {backgroundColor: c.bg},
                !c.rounded && styles.avatarSquare,
              ]}>
                {c.isGroup
                  ? <Icon name="earth" size={20} color="#7DD3FC" />
                  : <Text style={styles.avatarText}>{c.initials}</Text>
                }
              </View>

              {/* Info */}
              <View style={styles.callInfo}>
                <Text style={styles.callName} numberOfLines={1}>{c.name}</Text>
                <View style={styles.callMeta}>
                  <Icon name={dirIcon.name} size={13} color={dirIcon.color} />
                  {c.direction === 'missed'
                    ? <Text style={styles.missedLabel}>Missed</Text>
                    : <>
                        {/* B-59 defence-in-depth: an answered row always shows a
                            MM:SS/0:00 duration in THIS slot. A zero/absent
                            duration used to render empty, leaving only the
                            right-column "Nm ago" age visible — which the tester
                            read as the "1M/2M/3M" call length. */}
                        <Text style={styles.callDuration}>{c.duration ?? '0:00'}</Text>
                        {arrowIcon && <Icon name={arrowIcon.name} size={12} color={arrowIcon.color} />}
                      </>
                  }
                  {c.isGroup && <Text style={styles.groupLabel}>Group · </Text>}
                  {c.outcome === 'ended-by-host' && (
                    <Text style={styles.endedByHostLabel}>Ended by host</Text>
                  )}
                </View>
              </View>

              {/* Right side */}
              <View style={styles.callRight}>
                <Text style={styles.callTime}>{c.time}</Text>
                <TouchableOpacity
                  style={styles.callBtn}
                  onPress={() => {
                    // Same path as the row tap — launchCall resolves the
                    // peer from the conversation. The previous code passed
                    // the call-record id (c.id) as conversationId and
                    // navigated CallScreen directly, so no peer resolved
                    // and the call stuck in connecting. Mirror the row.
                    const {launchCall} = require('@/modules/messenger/webrtc/launchCall') as typeof import('@/modules/messenger/webrtc/launchCall');
                    launchCall(navigation as unknown as {navigate: (s: string, p?: Record<string, unknown>) => void}, {
                      conversationId: c.conversationId,
                      callType:       c.type,
                    });
                  }}
                  activeOpacity={0.7}>
                  <Icon name="phone" size={18} color="#1E88FF" />
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1C3B66'},
  headerTitle: {fontSize: 17, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 3, color: '#FFFFFF'},
  linksBtn: {flexDirection: 'row', alignItems: 'center', gap: 2},
  linksText: {fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5, color: '#1E88FF'},

  tabRow: {flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1C3B66'},
  tab: {flex: 1, alignItems: 'center', paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: 'transparent'},
  tabActive: {borderBottomColor: '#1E88FF'},
  tabText: {fontSize: 10, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase', color: '#7E8AA6'},
  tabTextActive: {color: '#1E88FF'},

  sectionLabel: {fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', color: '#7E8AA6', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6},

  callRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: 'rgba(28,59,102,0.7)'},
  avatar: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  avatarSquare: {borderRadius: 13},
  avatarText: {fontSize: 13, fontWeight: '700', color: '#FFF'},
  callInfo: {flex: 1, minWidth: 0},
  callName: {fontSize: 13, fontWeight: '700', color: '#FFFFFF', marginBottom: 3},
  callMeta: {flexDirection: 'row', alignItems: 'center', gap: 6},
  callDuration: {fontSize: 11, color: '#7E8AA6'},
  missedLabel: {fontSize: 11, color: '#f87171', fontWeight: '600'},
  groupLabel: {fontSize: 11, color: '#7E8AA6'},
  endedByHostLabel: {fontSize: 11, color: '#94A3B8', fontStyle: 'italic'},
  callRight: {alignItems: 'flex-end', gap: 4, flexShrink: 0},
  callTime: {fontSize: 10, color: '#7E8AA6'},
  callBtn: {width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center'},

  emptyWrap: {alignItems: 'center', paddingVertical: 60, paddingHorizontal: 32, gap: 10},
  emptyTitle: {color: '#B8C7E0', fontSize: 14, fontWeight: '700', marginTop: 8},
  emptyHint: {color: '#7E8AA6', fontSize: 11, textAlign: 'center', lineHeight: 16, maxWidth: 300},
}));
