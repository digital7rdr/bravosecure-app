/**
 * DayStatusScreen (Dept Chat v2 — Step 22, G5, PDF p.8) — lets a manager set a
 * non-check-in day status (Leave / Sick leave / Off duty / Absent) for a CPO on a
 * given day. Reached from the manager Attend root (Admin Attendance). Writes go
 * through the audited attendanceApi.setDayStatus (OrgManagerGuard server-side);
 * the original captured attendance is never overwritten (Step 6 invariant).
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity,
  Platform, Pressable, Modal, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, orgApi, type RosterMember} from '@services/api';
import {useKeyboardHeight, useRevealOnKeyboard} from '@hooks/useKeyboardHeight';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, attendanceStatusMeta} from './_obsidian';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type DayStatus = 'leave' | 'sick_leave' | 'off_duty' | 'absent';

const DAY_STATUSES: DayStatus[] = ['leave', 'sick_leave', 'off_duty', 'absent'];

// Local calendar day (YYYY-MM-DD) — represents the intended day unambiguously
// regardless of timezone, rather than a full timestamp.
const toDayString = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

export default function DayStatusScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-15 — no keyboard handling existed; the bottom note input
  // was covered by the IME. kb padding shrinks the scroll area (native
  // ScrollView then keeps the focused field visible) + reveal on focus.
  const kbHeight = useKeyboardHeight();
  const scrollRef = useRef<ScrollView>(null);
  const revealField = useRevealOnKeyboard(scrollRef);
  const navigation = useNavigation<Nav>();

  const [cpos, setCpos] = useState<RosterMember[]>([]);
  const [loadingCpos, setLoadingCpos] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<DayStatus | null>(null);
  const [date, setDate] = useState<Date>(() => new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCpos = useCallback(async () => {
    try {
      const {data} = await orgApi.listCpos();
      setCpos(data.filter(m => m.status === 'active' && m.member_role !== 'manager'));
    } catch {
      setCpos([]);
    } finally {
      setLoadingCpos(false);
    }
  }, []);
  useEffect(() => { void loadCpos(); }, [loadCpos]);

  const onPickChange = (_ev: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS === 'android') {setShowPicker(false);}
    if (d) {setDate(d);}
  };

  const onSave = async () => {
    if (!selected || !status) {
      Alert.alert('Day status', `Pick ${deptMemberNoun() === 'Employee' ? 'an employee' : 'a CPO'} and a status.`);
      return;
    }
    if (busy) {return;}
    setBusy(true);
    try {
      await attendanceApi.setDayStatus({
        cpo_user_id: selected,
        status,
        date: toDayString(date),
        notes: note.trim() || undefined,
      });
      navigation.goBack();
    } catch (e: unknown) {
      Alert.alert('Day status', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top, paddingBottom: kbHeight}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Set Day Status" onBack={() => navigation.goBack()} pill="ADMIN" />

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

        {/* Status */}
        <SectionLabel>STATUS</SectionLabel>
        <View style={s.grid}>
          {DAY_STATUSES.map(st => {
            const meta = attendanceStatusMeta(st);
            const on = status === st;
            return (
              <TouchableOpacity
                key={st}
                style={[s.statCell, on && {borderColor: meta.color, backgroundColor: meta.color + '1A'}]}
                activeOpacity={0.85}
                onPress={() => setStatus(st)}>
                <Icon name={meta.icon} size={20} color={on ? meta.color : OB.textMute} />
                <Text style={[s.statText, on && {color: meta.color}]}>{meta.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Day */}
        <View style={{marginTop: 22}}>
          <SectionLabel>DAY</SectionLabel>
          <TouchableOpacity style={s.dateRow} activeOpacity={0.8} onPress={() => setShowPicker(true)}>
            <Icon name="calendar" size={16} color={OB.accentSoft} />
            <Text style={s.dateText}>{date.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})}</Text>
            <Icon name="chevron-down" size={16} color={OB.textMute} />
          </TouchableOpacity>
        </View>

        {/* CPO */}
        <View style={{marginTop: 22}}>
          <SectionLabel>CPO</SectionLabel>
          {loadingCpos ? (
            <ActivityIndicator color={OB.accentSoft} style={{marginTop: 20}} />
          ) : cpos.length === 0 ? (
            <Card><Text style={s.empty}>No active {deptMemberNoun(true)} in your roster yet.</Text></Card>
          ) : (
            <View style={{gap: 10}}>
              {cpos.map(m => {
                const on = selected === m.member_user_id;
                return (
                  <Card key={m.member_user_id} style={s.cpoCard} onPress={() => setSelected(m.member_user_id)}>
                    <View style={[s.radio, on && s.radioOn]}>{on ? <View style={s.radioDot} /> : null}</View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.cpoName} numberOfLines={1}>{m.display_name ?? m.email ?? deptMemberNoun()}</Text>
                      {m.call_sign ? <Text style={s.cpoSub}>{m.call_sign}</Text> : null}
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>

        {/* Note */}
        <View style={{marginTop: 22, gap: 8}}>
          <SectionLabel>NOTE (OPTIONAL)</SectionLabel>
          <TextInput
            style={s.note}
            value={note}
            onChangeText={setNote}
            placeholder="Reason or context"
            placeholderTextColor={OB.textMute}
            multiline
            onFocus={revealField}
          />
        </View>
      </ScrollView>

      <View style={[s.footer, {paddingBottom: insets.bottom + 12}]}>
        <PrimaryButton label="Set Status" icon="check" busy={busy} onPress={() => { void onSave(); }} />
      </View>

      {showPicker && Platform.OS === 'android' && (
        <DateTimePicker value={date} mode="date" display="default" onChange={onPickChange} />
      )}
      {showPicker && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setShowPicker(false)}>
          <Pressable style={s.iosBackdrop} onPress={() => setShowPicker(false)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker value={date} mode="date" display="spinner" textColor={OB.text} themeVariant="dark" onChange={onPickChange} />
              <PrimaryButton label="Done" onPress={() => setShowPicker(false)} />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

function errMsg(e: unknown): string {
  return (e as {response?: {data?: {message?: string}}})?.response?.data?.message
    ?? (e as Error)?.message
    ?? 'Please try again.';
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  statCell: {
    width: '47.5%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 15, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair,
  },
  statText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 13.5},

  dateRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, height: 50, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  dateText: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},

  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  cpoCard: {flexDirection: 'row', alignItems: 'center', gap: 12},
  radio: {
    width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: OB.hair2,
  },
  radioOn: {borderColor: OB.accent},
  radioDot: {width: 11, height: 11, borderRadius: 6, backgroundColor: OB.accent},
  cpoName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  cpoSub: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10.5, marginTop: 2},

  note: {
    minHeight: 70, borderRadius: 12, padding: 14, color: OB.text,
    fontFamily: BravoFont.regular, fontSize: 13.5, textAlignVertical: 'top',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
  iosBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  iosCard: {backgroundColor: '#10141C', padding: 16, paddingBottom: 28, gap: 12, borderTopLeftRadius: 20, borderTopRightRadius: 20},
}));
