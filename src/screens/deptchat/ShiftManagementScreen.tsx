/**
 * ShiftManagementScreen (Dept Chat v2 — Step 21, PDF p.5) — the manager's list of
 * the org's shifts + the entry to create a new one. Reached from the manager
 * Attend tab (AdminAttendance → "Manage shifts"). Read-only list; creating a
 * shift (with assigned CPOs) is what unblocks every CPO's check-in (G2).
 * Manager-only; GET /attendance/shifts is OrgManagerGuard-gated server-side.
 */
import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, ActivityIndicator, TouchableOpacity} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, type ShiftDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton} from './_obsidian';
import {fmtWindow} from './geo';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;

export default function ShiftManagementScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [shifts, setShifts] = useState<ShiftDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const {data} = await attendanceApi.listShifts();
      setShifts(data);
    } catch {
      setShifts([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // PDF p.9 shift management: edit (audited PATCH) + archive (soft delete).
  const archive = (sh: ShiftDto) => {
    Alert.alert(
      'Archive shift',
      `Archive "${sh.site_label ?? 'this shift'}"? Assigned ${deptMemberNoun(true)} will no longer see it as today's shift.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Archive', style: 'destructive',
          onPress: () => {
            void attendanceApi.archiveShift(sh.id)
              .then(() => load())
              .catch(() => Alert.alert('Shift', 'Could not archive. Please try again.'));
          },
        },
      ],
    );
  };

  const now = Date.now();
  const upcoming = shifts.filter(sh => new Date(sh.end_at).getTime() >= now);
  const past = shifts.filter(sh => new Date(sh.end_at).getTime() < now);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Shifts" onBack={() => navigation.goBack()} pill={`${shifts.length}`} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>

        {loading ? (
          <ActivityIndicator color={OB.accentSoft} style={{marginTop: 32}} />
        ) : shifts.length === 0 ? (
          <Card style={{marginTop: 8, alignItems: 'center', gap: 8, paddingVertical: 28}}>
            <Icon name="calendar-blank-outline" size={32} color={OB.textMute} />
            <Text style={s.emptyTitle}>No shifts yet</Text>
            <Text style={s.emptySub}>Create a shift and assign {deptMemberNoun(true)} so they can check in.</Text>
          </Card>
        ) : (
          <>
            {upcoming.length > 0 && (
              <View style={{marginTop: 8}}>
                <SectionLabel>UPCOMING &amp; ACTIVE</SectionLabel>
                <View style={{gap: 10}}>
                  {upcoming.map(sh => (
                    <ShiftRow key={sh.id} sh={sh}
                      onEdit={() => navigation.navigate('ShiftEditor', {shift: sh})}
                      onArchive={() => archive(sh)} />
                  ))}
                </View>
              </View>
            )}
            {past.length > 0 && (
              <View style={{marginTop: 22}}>
                <SectionLabel>PAST</SectionLabel>
                <View style={{gap: 10}}>
                  {past.map(sh => <ShiftRow key={sh.id} sh={sh} past onArchive={() => archive(sh)} />)}
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <View style={[s.footer, {paddingBottom: insets.bottom + 12}]}>
        <PrimaryButton label="New Shift" icon="plus" onPress={() => navigation.navigate('ShiftEditor')} />
      </View>
    </View>
  );
}

function ShiftRow({sh, past, onEdit, onArchive}: {
  sh: ShiftDto; past?: boolean; onEdit?: () => void; onArchive?: () => void;
}) {
  return (
    <Card style={[s.row, past ? {opacity: 0.6} : null]}>
      <View style={s.rowIcon}>
        <Icon name="calendar-check" size={18} color={OB.accentSoft} />
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {sh.site_label ?? 'Assigned site'}{sh.department ? ` · ${sh.department}` : ''}
        </Text>
        <Text style={s.rowWindow} numberOfLines={1}>{fmtWindow(sh.start_at, sh.end_at)}</Text>
        <View style={s.metaRow}>
          <Meta icon="account-group" text={`${sh.assigned_count ?? 0} assigned`} />
          {sh.site_lat !== null ? <Meta icon="target" text={`${sh.approved_radius_m} m`} /> : <Meta icon="map-marker-off-outline" text="no geofence" />}
        </View>
      </View>
      <View style={s.rowActions}>
        {onEdit ? (
          <TouchableOpacity onPress={onEdit} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="pencil-outline" size={18} color={OB.accentSoft} />
          </TouchableOpacity>
        ) : null}
        {onArchive ? (
          <TouchableOpacity onPress={onArchive} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="archive-arrow-down-outline" size={18} color={OB.textMute} />
          </TouchableOpacity>
        ) : null}
      </View>
    </Card>
  );
}

function Meta({icon, text}: {icon: React.ComponentProps<typeof Icon>['name']; text: string}) {
  return (
    <View style={s.meta}>
      <Icon name={icon} size={12} color={OB.textMute} />
      <Text style={s.metaText}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  emptyTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16, marginTop: 4},
  emptySub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', maxWidth: 240, lineHeight: 18},
  row: {flexDirection: 'row', alignItems: 'center', gap: 13},
  rowIcon: {
    width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  rowTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  rowWindow: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12, marginTop: 2},
  metaRow: {flexDirection: 'row', gap: 14, marginTop: 6},
  meta: {flexDirection: 'row', alignItems: 'center', gap: 5},
  metaText: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 0.3},
  rowActions: {alignItems: 'center', gap: 14, paddingLeft: 4},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
