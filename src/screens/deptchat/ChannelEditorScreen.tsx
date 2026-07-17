import React, {useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {ensureChannelProvisioned} from '@/modules/messenger/orgWorkspace/provisionChannel';
import type {MessengerStackParamList} from '@navigation/types';
import {departmentApi, type ChannelTypeDto, type ChannelAccessDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, GhostButton} from './_obsidian';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;
type Rt = RouteProp<MessengerStackParamList, 'ChannelEditor'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

const TYPES: Array<{key: ChannelTypeDto; label: string; icon: IconName}> = [
  {key: 'board', label: 'Board', icon: 'bullhorn-variant-outline'},
  {key: 'department', label: 'Department', icon: 'pound'},
  {key: 'incident', label: 'Incident', icon: 'shield-alert-outline'},
];
// Why hint is a function: the member noun is audience-dependent (M1A —
// "Employees" for an enterprise individual, "CPOs" for a provider org),
// so it must resolve at render time, not module load.
const ACCESS: Array<{key: ChannelAccessDto; label: string; hint: () => string}> = [
  {key: 'standard', label: 'Standard', hint: () => 'All members read; managers post'},
  {key: 'read_only', label: 'Read only', hint: () => 'Announcement — managers post only'},
  {key: 'restricted', label: 'Restricted', hint: () => `Managers only — ${deptMemberNoun(true)} never see it`},
];

export default function ChannelEditorScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();
  const editing = params?.channel;

  const [name, setName] = useState(editing?.name ?? '');
  const [department, setDepartment] = useState(editing?.department ?? '');
  const [type, setType] = useState<ChannelTypeDto>(editing?.channel_type ?? 'department');
  const [access, setAccess] = useState<ChannelAccessDto>(editing?.access ?? 'standard');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { Alert.alert('Channel', 'Give the channel a name.'); return; }
    if (busy) { return; }
    setBusy(true);
    try {
      const body = {name: trimmed, department: department.trim() || null, channel_type: type, access};
      if (editing) {
        await departmentApi.configureChannel(editing.id, body);
      } else {
        const {data: created} = await departmentApi.createChannel(body);
        // Eagerly provision the E2EE group so the channel is active the moment it's
        // opened, not on a later admin tap (audit D1-a). Fire-and-forget: a channel
        // with no other members yet returns 'needs_members' and provisions when a CPO
        // is added; a failure is non-fatal (the open-flow fallback re-tries).
        void ensureChannelProvisioned(created.id, created.name, null).catch(() => {});
      }
      navigation.goBack();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Channel', msg ?? 'Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const archive = () => {
    if (!editing) { return; }
    Alert.alert('Archive channel', `Hide "${editing.name}" from the hub? Members stop seeing it.`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Archive', style: 'destructive', onPress: () => { void doArchive(); }},
    ]);
  };
  const doArchive = async () => {
    if (!editing) { return; }
    setBusy(true);
    try {
      await departmentApi.archiveChannel(editing.id);
      navigation.goBack();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Archive', msg ?? 'Could not archive.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title={editing ? 'Edit Channel' : 'New Channel'} onBack={() => navigation.goBack()} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 40}}
        keyboardShouldPersistTaps="handled">

        <SectionLabel>NAME</SectionLabel>
        <Card>
          <TextInput style={s.input} placeholder="e.g. Operations" placeholderTextColor={OB.textMute} value={name} onChangeText={setName} maxLength={80} />
        </Card>

        <View style={{height: 18}} />
        <SectionLabel>DEPARTMENT (OPTIONAL)</SectionLabel>
        <Card>
          <TextInput style={s.input} placeholder="e.g. Intel" placeholderTextColor={OB.textMute} value={department} onChangeText={setDepartment} maxLength={80} />
        </Card>

        <View style={{height: 18}} />
        <SectionLabel>TYPE</SectionLabel>
        <View style={s.segRow}>
          {TYPES.map(t => (
            <TouchableOpacity key={t.key} style={[s.seg, type === t.key && s.segOn]} activeOpacity={0.85} onPress={() => setType(t.key)}>
              <Icon name={t.icon} size={16} color={type === t.key ? OB.accentSoft : OB.textMute} />
              <Text style={[s.segText, type === t.key && {color: OB.text}]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{height: 18}} />
        <SectionLabel>ACCESS</SectionLabel>
        <View style={{gap: 10}}>
          {ACCESS.map(a => (
            <Card key={a.key} onPress={() => setAccess(a.key)} style={[s.accRow, access === a.key && s.accOn]}>
              <View style={{flex: 1}}>
                <Text style={[s.accLabel, access === a.key && {color: OB.text}]}>{a.label}</Text>
                <Text style={s.accHint}>{a.hint()}</Text>
              </View>
              <Icon name={access === a.key ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={access === a.key ? OB.accent : OB.textMute} />
            </Card>
          ))}
        </View>

        {type === 'incident' && access !== 'restricted' && (
          <Text style={s.note}>Incident channels are managers-only regardless of access.</Text>
        )}

        <View style={{height: 26}} />
        <PrimaryButton label={editing ? 'Save changes' : 'Create channel'} icon="check" onPress={() => { void save(); }} busy={busy} />

        {editing && (
          <>
            <View style={{height: 12}} />
            <GhostButton
              label="Members"
              icon="account-multiple-outline"
              onPress={() => navigation.navigate('ChannelMembers', {channelId: editing.id, channelName: editing.name})}
            />
            {!editing.archived && (
              <TouchableOpacity style={s.archiveBtn} activeOpacity={0.8} onPress={archive}>
                <Icon name="archive-outline" size={16} color={OB.alert} />
                <Text style={s.archiveText}>Archive channel</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  input: {color: OB.text, fontFamily: BravoFont.regular, fontSize: 15, padding: 0},
  segRow: {flexDirection: 'row', gap: 8},
  seg: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 46, borderRadius: 12, borderWidth: 1, borderColor: OB.hair2, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  segOn: {borderColor: OB.accent + '80', backgroundColor: 'rgba(91,141,239,0.12)'},
  segText: {color: OB.textMute, fontFamily: BravoFont.semiBold, fontSize: 12},
  accRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  accOn: {borderColor: OB.accent + '66'},
  accLabel: {color: OB.textDim, fontFamily: BravoFont.bold, fontSize: 14},
  accHint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  note: {color: OB.amber, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 12},
  archiveBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, marginTop: 12},
  archiveText: {color: OB.alert, fontFamily: BravoFont.semiBold, fontSize: 13},
}));
