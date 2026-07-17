import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, ActivityIndicator, TouchableOpacity, Modal} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {drainMembershipIntents} from '@/modules/messenger/orgWorkspace/membershipIntents';
import type {MessengerStackParamList} from '@navigation/types';
import {departmentApi, orgApi, type DepartmentMemberDto, type RosterMember} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton} from './_obsidian';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;
type Rt = RouteProp<MessengerStackParamList, 'ChannelMembers'>;

function initialOf(name?: string | null): string {
  const trimmed = name?.trim();
  return (trimmed ? trimmed[0] : '?').toUpperCase();
}

export default function ChannelMembersScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();
  const {channelId, channelName, isOwner} = params;
  const myId = useAuthStore(st => st.user?.id);

  const [members, setMembers] = useState<DepartmentMemberDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [roster, setRoster] = useState<RosterMember[]>([]);

  const load = useCallback(async () => {
    try {
      const {data} = await departmentApi.listMembers(channelId);
      setMembers(data.members);
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const memberIds = useMemo(() => new Set(members.map(m => m.user_id)), [members]);
  const addable = roster.filter(r => r.status === 'active' && !memberIds.has(r.member_user_id));

  const openPicker = async () => {
    setPicker(true);
    try {
      const {data} = await orgApi.listCpos();
      setRoster(data);
    } catch {
      setRoster([]);
    }
  };

  const add = async (r: RosterMember) => {
    setBusyId(r.member_user_id);
    try {
      await departmentApi.addMember(
        channelId, r.member_user_id,
        r.member_role === 'manager' ? 'admin' : 'viewer',
        r.member_role === 'manager' ? 'Manager' : deptMemberNoun(),
      );
      setPicker(false);
      await load();
      // Key the new member in NOW rather than waiting for the admin to revisit the
      // channel list — drainMembershipIntents broadcasts the add+rekey so they can
      // decrypt subsequent posts (audit D2-a). D2-b — AWAIT it (the row stays busy) so the
      // rekey lands before the admin can post: a message sent before the rekey would never
      // reach the new member (sealed-sender has no replay). Best-effort: a not-yet-provisioned
      // channel is skipped server+client and re-drained on the next list focus.
      await drainMembershipIntents().catch(() => {});
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Add member', msg ?? 'Could not add.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = (m: DepartmentMemberDto) => {
    Alert.alert('Remove member', `Remove ${m.display_name} from "${channelName}"? They are rekeyed out.`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Remove', style: 'destructive', onPress: () => { void doRemove(m); }},
    ]);
  };
  const doRemove = async (m: DepartmentMemberDto) => {
    setBusyId(m.user_id);
    try {
      await departmentApi.removeMember(channelId, m.user_id);
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Remove', msg ?? 'Could not remove.');
    } finally {
      setBusyId(null);
    }
  };

  // Flip a member between viewer (read-only) and admin (can post). Metadata-only
  // on the server (no rekey — they already hold the key).
  const toggleAccess = async (m: DepartmentMemberDto) => {
    setBusyId(m.user_id);
    try {
      await departmentApi.updateMemberRole(channelId, m.user_id, m.role === 'admin' ? 'viewer' : 'admin');
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Access', msg ?? 'Could not change access.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete channel', `Permanently delete "${channelName}"? This removes it for everyone.`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Delete', style: 'destructive', onPress: () => { void doDelete(); }},
    ]);
  };
  const doDelete = async () => {
    setBusyId('__delete__');
    try {
      await departmentApi.deleteChannel(channelId);
      navigation.goBack();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Delete', msg ?? 'Could not delete.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Members" onBack={() => navigation.goBack()} pill={`${members.length}`} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>
        <Text style={s.sub}>{channelName}</Text>
        <View style={{height: 14}} />
        <SectionLabel>MEMBERS</SectionLabel>
        {loading ? (
          <ActivityIndicator color={OB.accentSoft} style={{marginTop: 24}} />
        ) : members.length === 0 ? (
          <Card><Text style={s.empty}>No members yet.</Text></Card>
        ) : (
          <View style={{gap: 10}}>
            {members.map(m => {
              const isMe = m.user_id === myId;
              const busy = busyId === m.user_id;
              const isAdmin = m.role === 'admin';
              return (
                <Card key={m.user_id} style={s.row}>
                  <View style={s.avatar}><Text style={s.avatarText}>{initialOf(m.display_name)}</Text></View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.name} numberOfLines={1}>{m.display_name}{isMe ? ' (you)' : ''}</Text>
                    <Text style={s.role}>{(m.role_label ?? (isAdmin ? 'Admin' : deptMemberNoun()))} · {isAdmin ? 'can post' : 'read only'}</Text>
                  </View>
                  {!isMe && (
                    <View style={s.rowActions}>
                      <TouchableOpacity style={s.accessBtn} activeOpacity={0.8} disabled={busy} onPress={() => { void toggleAccess(m); }}>
                        {busy ? <ActivityIndicator size="small" color={OB.accentSoft} />
                              : <Text style={s.accessBtnText}>{isAdmin ? 'Make viewer' : 'Allow post'}</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity style={s.removeBtn} activeOpacity={0.8} disabled={busy} onPress={() => remove(m)}>
                        <Icon name="account-remove-outline" size={18} color={OB.alert} />
                      </TouchableOpacity>
                    </View>
                  )}
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>

      <View style={[s.footer, {paddingBottom: insets.bottom + 14}]}>
        <PrimaryButton label="Add member" icon="account-plus-outline" onPress={() => { void openPicker(); }} />
        {isOwner && (
          <TouchableOpacity style={s.deleteBtn} activeOpacity={0.8}
            disabled={busyId === '__delete__'} onPress={confirmDelete}>
            {busyId === '__delete__'
              ? <ActivityIndicator size="small" color={OB.alert} />
              : <>
                  <Icon name="trash-can-outline" size={16} color={OB.alert} />
                  <Text style={s.deleteText}>Delete channel</Text>
                </>}
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={picker} transparent animationType="slide" onRequestClose={() => setPicker(false)}>
        <View style={s.modalWrap}>
          <View style={[s.sheet, {paddingBottom: insets.bottom + 16}]}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle} numberOfLines={1}>Add to {channelName}</Text>
            <ScrollView style={{maxHeight: 360}} showsVerticalScrollIndicator={false}>
              {addable.length === 0 ? (
                <Text style={[s.empty, {paddingVertical: 18}]}>Everyone active is already a member.</Text>
              ) : addable.map(r => {
                const busy = busyId === r.member_user_id;
                return (
                  <TouchableOpacity key={r.member_user_id} style={s.pickRow} activeOpacity={0.8} disabled={busy} onPress={() => { void add(r); }}>
                    <View style={s.avatar}><Text style={s.avatarText}>{initialOf(r.display_name)}</Text></View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.name} numberOfLines={1}>{r.display_name ?? r.email ?? deptMemberNoun()}</Text>
                      <Text style={s.role}>{r.member_role === 'manager' ? 'Manager' : deptMemberNoun()}</Text>
                    </View>
                    {busy ? <ActivityIndicator size="small" color={OB.accentSoft} /> : <Icon name="plus" size={18} color={OB.accentSoft} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={s.closeBtn} activeOpacity={0.8} onPress={() => setPicker(false)}>
              <Text style={s.closeText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  sub: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 13, marginTop: 4},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  avatar: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: OB.hair2,
  },
  avatarText: {color: OB.accentSoft, fontFamily: BravoFont.bold, fontSize: 15},
  name: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  role: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  removeBtn: {
    width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,139,151,0.10)', borderWidth: 1, borderColor: 'rgba(245,139,151,0.35)',
  },
  rowActions: {flexDirection: 'row', alignItems: 'center', gap: 8},
  accessBtn: {
    paddingHorizontal: 10, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: OB.hair2,
  },
  accessBtnText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11},
  deleteBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, marginTop: 10},
  deleteText: {color: OB.alert, fontFamily: BravoFont.semiBold, fontSize: 13},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
  modalWrap: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)'},
  sheet: {
    backgroundColor: '#11151D', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 10, borderTopWidth: 1, borderColor: OB.hair2,
  },
  sheetHandle: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: OB.hair2, marginBottom: 14},
  sheetTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 15, marginBottom: 10},
  pickRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10},
  closeBtn: {alignItems: 'center', justifyContent: 'center', height: 50, marginTop: 8, borderTopWidth: 1, borderTopColor: OB.hair},
  closeText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 14},
}));
