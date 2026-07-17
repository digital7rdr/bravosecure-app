import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, ActivityIndicator, TouchableOpacity, Modal, TextInput, KeyboardAvoidingView, Platform} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardHeight} from '@hooks/useKeyboardHeight';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, type ShiftSessionDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, attendanceStatusMeta, reviewReasonLabel} from './_obsidian';
import {fmtTime} from './geo';
import {deptMemberNoun} from './deptNoun';

// PDF p.9 filters — date presets + department, applied server-side.
const DATE_PRESETS = [
  {key: 'all', label: 'All', days: null},
  {key: 'today', label: 'Today', days: 1},
  {key: '7d', label: '7 days', days: 7},
  {key: '30d', label: '30 days', days: 30},
] as const;
type DateKey = (typeof DATE_PRESETS)[number]['key'];

function fromFor(key: DateKey): string | undefined {
  const preset = DATE_PRESETS.find(p => p.key === key);
  if (!preset?.days) {return undefined;}
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (preset.days - 1));
  return d.toISOString();
}

// Hosted in the Departmental Attend tab (Step 19); ShiftManagement is a sibling
// route (Step 21). Typed to that stack so the "Manage shifts" nav type-checks.
type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type Summary = {counts: Record<string, number>; total: number; pendingReview: number};

export default function AdminAttendanceScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-13 — Android Modal windows don't resize for the IME.
  const kbHeight = useKeyboardHeight();
  const navigation = useNavigation<Nav>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pending, setPending] = useState<ShiftSessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // PDF p.9 — approve/reject must support admin notes; collected in a modal
  // (Alert.prompt is iOS-only) and stored in the session's admin_notes.
  const [reviewTarget, setReviewTarget] = useState<{id: string; decision: 'approve' | 'reject'} | null>(null);
  const [notes, setNotes] = useState('');
  const [dateKey, setDateKey] = useState<DateKey>('all');
  const [department, setDepartment] = useState<string | null>(null);
  const [departments, setDepartments] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const from = fromFor(dateKey);
      const dept = department ?? undefined;
      const [sum, pend, shifts] = await Promise.all([
        attendanceApi.orgSummary({from, department: dept}).then(r => r.data).catch(() => null),
        attendanceApi.pendingQueue(dept ? {department: dept} : undefined).then(r => r.data).catch(() => []),
        attendanceApi.listShifts().then(r => r.data).catch(() => []),
      ]);
      setSummary(sum);
      setPending(pend);
      setDepartments(Array.from(new Set(shifts.map(sh => sh.department).filter((d): d is string => !!d))));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateKey, department]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const review = (id: string, decision: 'approve' | 'reject') => {
    setNotes('');
    setReviewTarget({id, decision});
  };

  const doReview = async (id: string, decision: 'approve' | 'reject', reviewNotes?: string) => {
    if (busyId) {return;}
    setBusyId(id);
    try {
      const trimmed = reviewNotes?.trim();
      await attendanceApi.reviewSession(id, decision, trimmed ? trimmed : undefined);
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Review', msg ?? 'Could not update. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const c = summary?.counts ?? {};

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader
        title="Admin Attendance"
        onBack={() => navigation.goBack()}
        pill={summary ? `${summary.pendingReview} PENDING` : undefined}
        pillTone={summary && summary.pendingReview > 0 ? 'warn' : 'good'}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 32}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>

        {/* PDF p.9 — date + department filters (server-side). */}
        <View style={s.filterRow}>
          {DATE_PRESETS.map(p => (
            <TouchableOpacity
              key={p.key}
              style={[s.filterChip, dateKey === p.key && s.filterChipOn]}
              activeOpacity={0.8}
              onPress={() => setDateKey(p.key)}>
              <Text style={[s.filterText, dateKey === p.key && s.filterTextOn]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {departments.length > 0 ? (
          <View style={s.filterRow}>
            <TouchableOpacity
              style={[s.filterChip, department === null && s.filterChipOn]}
              activeOpacity={0.8}
              onPress={() => setDepartment(null)}>
              <Text style={[s.filterText, department === null && s.filterTextOn]}>All depts</Text>
            </TouchableOpacity>
            {departments.map(d => (
              <TouchableOpacity
                key={d}
                style={[s.filterChip, department === d && s.filterChipOn]}
                activeOpacity={0.8}
                onPress={() => setDepartment(cur => (cur === d ? null : d))}>
                <Text style={[s.filterText, department === d && s.filterTextOn]} numberOfLines={1}>{d}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <View style={s.statsRow}>
          <Stat label="Present" value={c.present ?? 0} color={OB.signal} />
          <Stat label="Late" value={c.late ?? 0} color={OB.amber} />
          <Stat label="Absent" value={c.absent ?? 0} color={OB.alert} />
        </View>

        {/* Step 21 — manage shifts (create + assign CPOs). Without an assigned
            shift, a CPO's check-in is blocked, so this is the entry that makes
            attendance reachable end-to-end. */}
        <Card style={s.manageRow} onPress={() => navigation.navigate('ShiftManagement')}>
          <View style={s.manageIcon}><Icon name="calendar-edit" size={18} color={OB.accentSoft} /></View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.manageTitle}>Manage shifts</Text>
            <Text style={s.manageSub}>Create shifts &amp; assign {deptMemberNoun(true)}</Text>
          </View>
          <Icon name="chevron-right" size={18} color={OB.textMute} />
        </Card>

        {/* Step 22 (G5) — set a non-check-in day status (leave/sick/off-duty/absent). */}
        <Card style={s.manageRow} onPress={() => navigation.navigate('DayStatus')}>
          <View style={s.manageIcon}><Icon name="calendar-account" size={18} color={OB.accentSoft} /></View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.manageTitle}>Set day status</Text>
            <Text style={s.manageSub}>Leave · sick leave · off duty · absent</Text>
          </View>
          <Icon name="chevron-right" size={18} color={OB.textMute} />
        </Card>

        <View style={{marginTop: 22}}>
          <SectionLabel>PENDING REVIEW</SectionLabel>
          {loading ? (
            <ActivityIndicator color={OB.accentSoft} style={{marginTop: 24}} />
          ) : pending.length === 0 ? (
            <Card><Text style={s.empty}>Nothing waiting for review.</Text></Card>
          ) : (
            <View style={{gap: 10}}>
              {pending.map(p => {
                const meta = attendanceStatusMeta(p.attendance_status);
                const reason = reviewReasonLabel(p.review_reason);
                const busy = busyId === p.id;
                return (
                  <Card key={p.id} style={{gap: 12}}>
                    <View style={s.pendTop}>
                      <Icon name={meta.icon} size={18} color={meta.color} />
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.pendIn}>{fmtTime(p.clock_in_at)}</Text>
                        <Text style={s.pendReason} numberOfLines={2}>{reason ?? 'Pending review'}</Text>
                      </View>
                    </View>
                    <View style={s.actions}>
                      <TouchableOpacity style={[s.actBtn, s.reject]} activeOpacity={0.8} disabled={busy} onPress={() => review(p.id, 'reject')}>
                        <Icon name="close" size={15} color={OB.alert} />
                        <Text style={[s.actText, {color: OB.alert}]}>Reject</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.actBtn, s.approve]} activeOpacity={0.8} disabled={busy} onPress={() => review(p.id, 'approve')}>
                        {busy ? <ActivityIndicator size="small" color={OB.signal} /> : <Icon name="check" size={15} color={OB.signal} />}
                        <Text style={[s.actText, {color: OB.signal}]}>Approve</Text>
                      </TouchableOpacity>
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      <Modal visible={reviewTarget !== null} transparent animationType="fade" onRequestClose={() => setReviewTarget(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[s.modalBackdrop, Platform.OS === 'android' && {paddingBottom: kbHeight}]}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>
              {reviewTarget?.decision === 'approve' ? 'Approve check-in' : 'Reject check-in'}
            </Text>
            <Text style={s.modalSub}>
              {reviewTarget?.decision === 'approve'
                ? 'Mark this attendance as confirmed?'
                : 'Reject this check-in? It stays flagged.'}
            </Text>
            <TextInput
              style={s.modalInput}
              value={notes}
              onChangeText={setNotes}
              placeholder="Notes (optional)"
              placeholderTextColor={OB.textMute}
              multiline
              maxLength={500}
            />
            <View style={s.actions}>
              <TouchableOpacity style={[s.actBtn, s.cancel]} activeOpacity={0.8} onPress={() => setReviewTarget(null)}>
                <Text style={[s.actText, {color: OB.textDim}]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.actBtn, reviewTarget?.decision === 'reject' ? s.reject : s.approve]}
                activeOpacity={0.8}
                onPress={() => {
                  const t = reviewTarget;
                  setReviewTarget(null);
                  if (t) { void doReview(t.id, t.decision, notes); }
                }}>
                <Text style={[s.actText, {color: reviewTarget?.decision === 'reject' ? OB.alert : OB.signal}]}>
                  {reviewTarget?.decision === 'approve' ? 'Approve' : 'Reject'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function Stat({label, value, color}: {label: string; value: number; color: string}) {
  return (
    <Card style={s.statCell}>
      <Text style={[s.statValue, {color}]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </Card>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  filterRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8},
  filterChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)', backgroundColor: 'rgba(255,255,255,0.03)',
  },
  filterChipOn: {borderColor: 'rgba(91,141,239,0.55)', backgroundColor: 'rgba(91,141,239,0.14)'},
  filterText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  filterTextOn: {color: OB.accentSoft},
  statsRow: {flexDirection: 'row', gap: 10, marginTop: 8},
  statCell: {flex: 1, alignItems: 'center', paddingVertical: 18},
  manageRow: {flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 12},
  manageIcon: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  manageTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  manageSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 2},
  statValue: {fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.5},
  statLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  pendTop: {flexDirection: 'row', alignItems: 'center', gap: 12},
  pendIn: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13.5},
  pendReason: {color: OB.amber, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 2},
  actions: {flexDirection: 'row', gap: 10},
  actBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 42, borderRadius: 12, borderWidth: 1},
  reject: {backgroundColor: 'rgba(245,139,151,0.10)', borderColor: 'rgba(245,139,151,0.4)'},
  approve: {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: 'rgba(74,222,128,0.4)'},
  actText: {fontFamily: BravoFont.bold, fontSize: 12.5},
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  modalCard: {
    width: '100%', borderRadius: 18, padding: 20, gap: 10,
    backgroundColor: '#0C1017', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  modalTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 17, letterSpacing: -0.3},
  modalSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, lineHeight: 18},
  modalInput: {
    minHeight: 72, maxHeight: 140, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    color: OB.text, fontFamily: BravoFont.regular, fontSize: 13, textAlignVertical: 'top',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  cancel: {backgroundColor: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.12)'},
}));
