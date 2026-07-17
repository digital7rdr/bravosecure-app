/**
 * ActivityCenterScreen (Step 18 / B2) — the durable, locally-persisted notifications inbox.
 * Renders the activity store's rows (newest first), marks everything read on open, and
 * deep-links a tapped row to the right surface (offer → booking, mission → tracker, SOS →
 * SOS). Rows are pure metadata fetched on each opaque wake — no message body, no key.
 */
import React, {useCallback, useEffect} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useActivityStore, type ActivityClass, type ActivityRowData} from '@store/activityStore';
import ActivityRow from '@components/ui/ActivityRow';
import EmptyState from '@components/ui/EmptyState';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';

const CLASS_META: Record<ActivityClass, {icon: string; tint: string}> = {
  booking:  {icon: 'calendar-check', tint: UI.accentSoft},
  dispatch: {icon: 'radar',          tint: UI.accent},
  mission:  {icon: 'shield-account', tint: UI.signal},
  payout:   {icon: 'wallet',         tint: UI.amber},
  sos:      {icon: 'alarm-light',    tint: UI.alert},
  agent:    {icon: 'account-badge',  tint: UI.accentSoft},
  incident: {icon: 'alert-octagon',  tint: UI.alert},
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) {return 'now';}
  if (m < 60) {return `${m}m`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h`;}
  return `${Math.floor(h / 24)}d`;
}

export default function ActivityCenterScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<{goBack: () => void; navigate: (n: string, p?: object) => void}>();
  const rows = useActivityStore(st => st.rows);
  const markAllRead = useActivityStore(st => st.markAllRead);
  const markRead = useActivityStore(st => st.markRead);
  const clear = useActivityStore(st => st.clear);

  // Opening the inbox clears the unread badge.
  useEffect(() => { markAllRead(); }, [markAllRead]);

  const onRow = useCallback((row: ActivityRowData) => {
    markRead(row.id);
    // Best-effort deep-link; unknown targets just mark the row read.
    try {
      if (row.eventClass === 'sos' && row.bookingId) {navigation.navigate('SOSScreen', {bookingId: row.bookingId}); return;}
      if (row.missionId) {navigation.navigate('AgentLiveTracker', {missionId: row.missionId}); return;}
      if (row.bookingId) {navigation.navigate('LiveTracking', {bookingId: row.bookingId}); return;}
    } catch { /* route not in this shell — leave it as a read row */ }
  }, [navigation, markRead]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={22} color={UI.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>ACTIVITY</Text>
        {rows.length > 0 && (
          <TouchableOpacity onPress={clear} activeOpacity={0.7}><Text style={s.clear}>Clear</Text></TouchableOpacity>
        )}
      </View>

      <ScrollView contentContainerStyle={[s.body, {paddingBottom: insets.bottom + 24}]} showsVerticalScrollIndicator={false}>
        {rows.length === 0 ? (
          <View style={{marginTop: 60}}>
            <EmptyState icon="bell-sleep-outline" title="Nothing yet"
              body="Offers, status changes, payments, and alerts will show up here — even after a silent notification." />
          </View>
        ) : (
          rows.map(r => {
            const meta = CLASS_META[r.eventClass] ?? CLASS_META.booking;
            return (
              <ActivityRow key={r.id} icon={meta.icon} tint={meta.tint} title={r.title} subtitle={r.subtitle}
                timeLabel={relTime(r.ts)} unread={!r.read} expiresAt={r.expiresAt} onPress={() => onRow(r)} />
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: UI.hair, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: UI.accent},
  headerTitle: {flex: 1, fontFamily: UI.fBold, fontSize: 13, letterSpacing: 2.2, color: UI.text},
  clear: {fontFamily: UI.fSemi, fontSize: 12.5, color: UI.textDim},
  body: {paddingHorizontal: 20, paddingTop: 4, gap: 10},
}));
