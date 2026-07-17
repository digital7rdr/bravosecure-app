/**
 * ShiftEditorScreen (Dept Chat v2 — Step 21, PDF p.5 admin-logic) — the manager
 * surface that creates a shift (department, site label, geofence centre + radius,
 * start/end window) and assigns CPOs to it. Without this nothing ever calls
 * attendanceApi.createShift/assignCpos, so myTodayShift is always null and EVERY
 * CPO check-in is blocked ("No active shift assigned"). This unblocks the whole
 * attendance loop (G2). Manager-only — reached from the manager Attend tab; the
 * server still enforces OrgManagerGuard + assertOrgScope on every route.
 *
 * Geofence centre is OPTIONAL and set by the manager ("Use current location" or
 * manual lat/lng) — there is NO background/continuous tracking (PDF p.16). A shift
 * with no centre simply skips the radius check server-side.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity,
  Platform, Pressable, Modal, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, orgApi, type RosterMember} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton} from './_obsidian';
import {getGeo, fmtWindow} from './geo';
import {validateShiftDraft} from './shiftValidation';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type Rt = RouteProp<DeptAttendStackParamList, 'ShiftEditor'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

const nextTopOfHour = (): Date => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
};

export default function ShiftEditorScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  // Edit mode (PDF p.9 shift management): prefilled from the shift; Save patches
  // via updateShift (audited server-side). Assignments are managed separately.
  const editing = useRoute<Rt>().params?.shift ?? null;

  const [department, setDepartment] = useState(editing?.department ?? '');
  const [siteLabel, setSiteLabel] = useState(editing?.site_label ?? '');
  const [coords, setCoords] = useState<{lat: number; lng: number} | null>(
    editing?.site_lat !== null && editing?.site_lat !== undefined &&
    editing?.site_lng !== null && editing?.site_lng !== undefined
      ? {lat: editing.site_lat, lng: editing.site_lng}
      : null,
  );
  const [radius, setRadius] = useState(String(editing?.approved_radius_m ?? 150));
  const [startDate, setStartDate] = useState<Date>(() => (editing ? new Date(editing.start_at) : nextTopOfHour()));
  const [endDate, setEndDate] = useState<Date>(() =>
    editing ? new Date(editing.end_at) : new Date(nextTopOfHour().getTime() + 8 * 3600_000));
  const [picker, setPicker] = useState<{field: 'start' | 'end'; mode: 'date' | 'time'} | null>(null);

  const [cpos, setCpos] = useState<RosterMember[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingCpos, setLoadingCpos] = useState(true);
  const [capturing, setCapturing] = useState(false);
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

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next;
    });
  };

  const captureLocation = async () => {
    if (capturing) {return;}
    setCapturing(true);
    try {
      const geo = await getGeo();
      if (geo) {
        setCoords({lat: geo.lat, lng: geo.lng});
      } else {
        Alert.alert('Location', 'Could not read your location. Grant permission or enter coordinates manually.');
      }
    } finally {
      setCapturing(false);
    }
  };

  const onPickChange = (_ev: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS === 'android') {setPicker(null);}
    if (d && picker) {
      if (picker.field === 'start') {setStartDate(d);} else {setEndDate(d);}
    }
  };

  const onSave = async () => {
    const err = validateShiftDraft({
      startMs: startDate.getTime(), endMs: endDate.getTime(),
      // Edit mode never touches assignments, so the ≥1-CPO rule doesn't apply.
      selectedCount: editing ? 1 : selected.size,
      hasCoords: !!coords, radius: Number(radius) || 0,
    });
    if (err) { Alert.alert('Shift', err); return; }
    if (busy) {return;}
    setBusy(true);
    try {
      const body = {
        department: department.trim() || undefined,
        site_label: siteLabel.trim() || undefined,
        site_lat: coords?.lat,
        site_lng: coords?.lng,
        approved_radius_m: coords ? (Number(radius) || 150) : undefined,
        start_at: startDate.toISOString(),
        end_at: endDate.toISOString(),
      };
      if (editing) {
        await attendanceApi.updateShift(editing.id, body);
      } else {
        const {data: shift} = await attendanceApi.createShift(body);
        await attendanceApi.assignCpos(shift.id, [...selected]);
      }
      navigation.goBack();
    } catch (e: unknown) {
      Alert.alert('Shift', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const pickerValue = picker?.field === 'end' ? endDate : startDate;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title={editing ? 'Edit Shift' : 'New Shift'} onBack={() => navigation.goBack()} pill="ADMIN" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

        {/* Where */}
        <SectionLabel>WHERE</SectionLabel>
        <Card style={{gap: 14}}>
          <Field label="Department" value={department} onChangeText={setDepartment} placeholder="e.g. Operations" />
          <Field label="Site" value={siteLabel} onChangeText={setSiteLabel} placeholder="e.g. Main Office" />

          <View style={s.geoRow}>
            <TouchableOpacity style={s.geoBtn} activeOpacity={0.85} onPress={() => { void captureLocation(); }} disabled={capturing}>
              {capturing ? <ActivityIndicator size="small" color={OB.accentSoft} /> : <Icon name="crosshairs-gps" size={16} color={OB.accentSoft} />}
              <Text style={s.geoBtnText}>{coords ? 'Update location' : 'Use current location'}</Text>
            </TouchableOpacity>
            {coords ? (
              <TouchableOpacity onPress={() => setCoords(null)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="close-circle" size={18} color={OB.textMute} />
              </TouchableOpacity>
            ) : null}
          </View>
          {coords ? (
            <View style={s.coordRow}>
              <Icon name="map-marker-radius" size={14} color={OB.signal} />
              <Text style={s.coordText}>{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</Text>
              <View style={s.radiusWrap}>
                <TextInput
                  style={s.radiusInput}
                  value={radius}
                  onChangeText={t => setRadius(t.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  maxLength={5}
                  placeholder="150"
                  placeholderTextColor={OB.textMute}
                />
                <Text style={s.radiusUnit}>m radius</Text>
              </View>
            </View>
          ) : (
            <Text style={s.hint}>Optional — sets the approved check-in radius. Without it, attendance records the time only.</Text>
          )}
        </Card>

        {/* When */}
        <View style={{marginTop: 22}}>
          <SectionLabel>WHEN</SectionLabel>
          <Card style={{gap: 12}}>
            <WindowRow label="Start" date={startDate} onDate={() => setPicker({field: 'start', mode: 'date'})} onTime={() => setPicker({field: 'start', mode: 'time'})} />
            <View style={s.divider} />
            <WindowRow label="End" date={endDate} onDate={() => setPicker({field: 'end', mode: 'date'})} onTime={() => setPicker({field: 'end', mode: 'time'})} />
            <Text style={s.windowSummary}>{fmtWindow(startDate.toISOString(), endDate.toISOString())}</Text>
          </Card>
        </View>

        {/* Assign (create mode only — edits never touch assignments) */}
        {editing ? null : (
        <View style={{marginTop: 22}}>
          <SectionLabel right={<Text style={s.count}>{selected.size} selected</Text>}>{`ASSIGN ${deptMemberNoun(true).toUpperCase()}`}</SectionLabel>
          {loadingCpos ? (
            <ActivityIndicator color={OB.accentSoft} style={{marginTop: 20}} />
          ) : cpos.length === 0 ? (
            <Card><Text style={s.empty}>No active {deptMemberNoun(true)} in your roster yet. Add them from the roster first.</Text></Card>
          ) : (
            <View style={{gap: 10}}>
              {cpos.map(m => {
                const on = selected.has(m.member_user_id);
                return (
                  <Card key={m.member_user_id} style={s.cpoCard} onPress={() => toggle(m.member_user_id)}>
                    <View style={[s.check, on && s.checkOn]}>
                      {on ? <Icon name="check" size={14} color="#FFF" /> : null}
                    </View>
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
        )}
      </ScrollView>

      <View style={[s.footer, {paddingBottom: insets.bottom + 12}]}>
        <PrimaryButton
          label={editing ? 'Save Changes' : 'Create & Assign Shift'}
          icon={editing ? 'content-save-outline' : 'calendar-plus'}
          busy={busy}
          onPress={() => { void onSave(); }}
        />
      </View>

      {/* Android: native dialog. iOS: bottom-sheet spinner with Done. */}
      {picker && Platform.OS === 'android' && (
        <DateTimePicker value={pickerValue} mode={picker.mode} is24Hour display="default" onChange={onPickChange} />
      )}
      {picker && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setPicker(null)}>
          <Pressable style={s.iosBackdrop} onPress={() => setPicker(null)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker value={pickerValue} mode={picker.mode} is24Hour display="spinner" textColor={OB.text} themeVariant="dark" onChange={onPickChange} />
              <PrimaryButton label="Done" onPress={() => setPicker(null)} />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

function Field({label, value, onChangeText, placeholder}: {
  label: string; value: string; onChangeText: (t: string) => void; placeholder: string;
}) {
  return (
    <View style={{gap: 6}}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={OB.textMute}
      />
    </View>
  );
}

function WindowRow({label, date, onDate, onTime}: {
  label: string; date: Date; onDate: () => void; onTime: () => void;
}) {
  return (
    <View style={s.winRow}>
      <Text style={s.winLabel}>{label}</Text>
      <View style={s.winBtns}>
        <Chip icon="calendar" text={date.toLocaleDateString(undefined, {day: '2-digit', month: 'short'})} onPress={onDate} />
        <Chip icon="clock-outline" text={date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})} onPress={onTime} />
      </View>
    </View>
  );
}

function Chip({icon, text, onPress}: {icon: IconName; text: string; onPress: () => void}) {
  return (
    <TouchableOpacity style={s.chip} activeOpacity={0.8} onPress={onPress}>
      <Icon name={icon} size={14} color={OB.accentSoft} />
      <Text style={s.chipText}>{text}</Text>
    </TouchableOpacity>
  );
}

function errMsg(e: unknown): string {
  return (e as {response?: {data?: {message?: string}}})?.response?.data?.message
    ?? (e as Error)?.message
    ?? 'Please try again.';
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  fieldLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase'},
  input: {
    height: 46, borderRadius: 12, paddingHorizontal: 14, color: OB.text,
    fontFamily: BravoFont.semiBold, fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },

  geoRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  geoBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 12,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
  },
  geoBtnText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 13},
  coordRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  coordText: {color: OB.text, fontFamily: BravoFont.mono, fontSize: 12, flex: 1},
  radiusWrap: {flexDirection: 'row', alignItems: 'center', gap: 6},
  radiusInput: {
    width: 56, height: 36, borderRadius: 9, paddingHorizontal: 8, textAlign: 'center', color: OB.text,
    fontFamily: BravoFont.bold, fontSize: 13, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: OB.hair2,
  },
  radiusUnit: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5},
  hint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16},

  divider: {height: 1, backgroundColor: OB.hair},
  winRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  winLabel: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},
  winBtns: {flexDirection: 'row', gap: 8},
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  chipText: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12.5},
  windowSummary: {color: OB.accentSoft, fontFamily: BravoFont.mono, fontSize: 11, marginTop: 2},

  count: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 12},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  cpoCard: {flexDirection: 'row', alignItems: 'center', gap: 12},
  check: {
    width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: OB.hair2, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  checkOn: {backgroundColor: OB.accent, borderColor: OB.accent},
  cpoName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  cpoSub: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10.5, marginTop: 2},

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },

  iosBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  iosCard: {backgroundColor: '#10141C', padding: 16, paddingBottom: 28, gap: 12, borderTopLeftRadius: 20, borderTopRightRadius: 20},
}));
