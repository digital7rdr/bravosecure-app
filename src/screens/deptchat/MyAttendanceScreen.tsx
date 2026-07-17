import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, ActivityIndicator, Modal, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardHeight} from '@hooks/useKeyboardHeight';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList} from '@navigation/types';
import {attendanceApi, type ShiftSessionDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, attendanceStatusMeta, reviewReasonLabel} from './_obsidian';
import {fmtTime} from './geo';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// PDF p.8 — member history with monthly grouping, the full review outcome per
// row, and the dispute support route (flags an own record back to the manager
// Pending Review queue with reason 'disputed').
export default function MyAttendanceScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-14 — Android Modal windows don't resize for the IME.
  const kbHeight = useKeyboardHeight();
  const navigation = useNavigation<Nav>();
  const [shifts, setShifts] = useState<ShiftSessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [disputeTarget, setDisputeTarget] = useState<ShiftSessionDto | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const {data} = await attendanceApi.myShifts();
      setShifts(data);
    } catch {
      setShifts([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const count = (pred: (s: ShiftSessionDto) => boolean) => shifts.filter(pred).length;
  const present = count(s => s.attendance_status === 'present');
  const late = count(s => s.attendance_status === 'late');
  const pending = count(s => s.review_status === 'pending');

  // Weekly/monthly view (PDF p.8): newest-first month sections.
  const sections = useMemo(() => {
    const byMonth = new Map<string, ShiftSessionDto[]>();
    for (const sh of shifts) {
      const d = new Date(sh.clock_in_at);
      const key = isNaN(d.getTime())
        ? 'Undated'
        : d.toLocaleDateString(undefined, {month: 'long', year: 'numeric'});
      const list = byMonth.get(key) ?? [];
      list.push(sh);
      byMonth.set(key, list);
    }
    return Array.from(byMonth.entries());
  }, [shifts]);

  const submitDispute = async () => {
    const target = disputeTarget;
    const note = disputeNote.trim();
    if (!target) {return;}
    if (note.length < 3) {
      Alert.alert('Dispute', 'Please describe why this record is wrong.');
      return;
    }
    setDisputeTarget(null);
    setBusy(true);
    try {
      await attendanceApi.disputeSession(target.id, note);
      Alert.alert('Dispute', 'Your dispute was sent to your admin for review.');
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Dispute', msg === 'already_pending_review'
        ? 'This record is already waiting for admin review.'
        : msg ?? 'Could not send the dispute. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="My Attendance" onBack={() => navigation.goBack()} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 32}}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />
        }>

        <View style={s.statsRow}>
          <Stat label="Present" value={present} color={OB.signal} />
          <Stat label="Late" value={late} color={OB.amber} />
          <Stat label="Pending" value={pending} color={OB.amber} />
        </View>

        {loading ? (
          <ActivityIndicator color={OB.accentSoft} style={{marginTop: 24}} />
        ) : shifts.length === 0 ? (
          <View style={{marginTop: 22}}>
            <SectionLabel>HISTORY</SectionLabel>
            <Card><Text style={s.empty}>No attendance records yet.</Text></Card>
          </View>
        ) : (
          sections.map(([month, rows]) => (
            <View key={month} style={{marginTop: 22}}>
              <SectionLabel>{month.toUpperCase()}</SectionLabel>
              <View style={{gap: 10}}>
                {rows.map(sh => {
                  const meta = attendanceStatusMeta(sh.attendance_status ?? (sh.status === 'open' ? null : 'present'));
                  const outcome = reviewOutcome(sh);
                  const canDispute = sh.status !== 'open' && sh.review_status !== 'pending';
                  const day = fmtDay(sh.clock_in_at);
                  return (
                    <Card key={sh.id} style={s.row}>
                      <View style={s.left}>
                        <Icon name={meta.icon} size={18} color={meta.color} />
                        <View style={{flex: 1, minWidth: 0}}>
                          <Text style={s.in}>{day ? `${day} · ` : ''}{fmtTime(sh.clock_in_at)}</Text>
                          <Text style={s.out} numberOfLines={2}>
                            {sh.clock_out_at ? `→ ${fmtTime(sh.clock_out_at)}` : '→ open'}
                            {outcome ? ` · ${outcome}` : ''}
                          </Text>
                        </View>
                      </View>
                      <View style={s.right}>
                        <View style={[s.chip, {backgroundColor: meta.color + '14', borderColor: meta.color + '4D'}]}>
                          <Text style={[s.chipText, {color: meta.color}]}>{meta.label}</Text>
                        </View>
                        {canDispute ? (
                          <Text
                            style={s.disputeLink}
                            onPress={() => { setDisputeNote(''); setDisputeTarget(sh); }}>
                            Dispute
                          </Text>
                        ) : null}
                      </View>
                    </Card>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <Modal visible={disputeTarget !== null} transparent animationType="fade" onRequestClose={() => setDisputeTarget(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[s.modalBackdrop, Platform.OS === 'android' && {paddingBottom: kbHeight}]}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Dispute this record</Text>
            <Text style={s.modalSub}>
              Tell your admin why this record is wrong. It goes back into their review queue.
            </Text>
            <TextInput
              style={s.modalInput}
              value={disputeNote}
              onChangeText={setDisputeNote}
              placeholder="e.g. I was on site — GPS was off"
              placeholderTextColor={OB.textMute}
              multiline
              maxLength={500}
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={[s.actBtn, s.cancel]} activeOpacity={0.8} onPress={() => setDisputeTarget(null)}>
                <Text style={[s.actText, {color: OB.textDim}]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.actBtn, s.send]} activeOpacity={0.8} disabled={busy} onPress={() => { void submitDispute(); }}>
                {busy ? <ActivityIndicator size="small" color={OB.accentSoft} /> : (
                  <Text style={[s.actText, {color: OB.accentSoft}]}>Send Dispute</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// The full review trail for a row: pending reason, or the admin's outcome.
function reviewOutcome(sh: ShiftSessionDto): string | null {
  if (sh.review_status === 'pending') {return reviewReasonLabel(sh.review_reason) ?? 'Pending review';}
  if (sh.review_status === 'approved') {return 'Approved by admin';}
  if (sh.review_status === 'rejected') {return 'Rejected by admin';}
  return null;
}

function fmtDay(iso?: string | null): string | null {
  if (!iso) {return null;}
  const d = new Date(iso);
  if (isNaN(d.getTime())) {return null;}
  return d.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric'});
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
  statsRow: {flexDirection: 'row', gap: 10, marginTop: 8},
  statCell: {flex: 1, alignItems: 'center', paddingVertical: 18},
  statValue: {fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.5},
  statLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 13},
  left: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0},
  right: {alignItems: 'flex-end', gap: 6},
  in: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13},
  out: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  chip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: 1},
  chipText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  disputeLink: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11, paddingVertical: 2},
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
  modalActions: {flexDirection: 'row', gap: 10},
  actBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 42, borderRadius: 12, borderWidth: 1},
  cancel: {backgroundColor: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.12)'},
  send: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.4)'},
  actText: {fontFamily: BravoFont.bold, fontSize: 12.5},
}));
