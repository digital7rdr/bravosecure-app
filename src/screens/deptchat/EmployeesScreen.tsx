import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl,
  ActivityIndicator, TextInput, TouchableOpacity,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useFocusEffect} from '@react-navigation/native';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {orgApi, type RosterMember} from '@services/api';
import {OB, ObHeader, SectionLabel, Card} from './_obsidian';

/**
 * M1A rule 16 — the Enterprise workspace roster: enroll existing app users
 * as EMPLOYEES (dept channels + attendance + incident reporting; never a
 * deployable CPO, never changes the member's own app). Also usable by a
 * provider org for back-office staff — their CPO roster lives elsewhere
 * and is untouched (rule 7).
 */
export default function EmployeesScreen() {
  const insets = useSafeAreaInsets();
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [needle, setNeedle] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const {data} = await orgApi.listCpos();
      setMembers(data);
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const add = useCallback(async () => {
    const v = needle.trim();
    if (!v || adding) {return;}
    setAdding(true);
    try {
      await orgApi.addEmployee(v);
      setNeedle('');
      await load();
    } catch (e: unknown) {
      const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      const msg = code === 'user_not_found'
        ? 'No Bravo account found with that email or phone. Ask them to sign up first (Lite is free).'
        : code === 'already_a_member'
          ? 'They are already on your team.'
          : code === 'member_exists_use_roster_status'
            ? 'This person is on your roster with another role — manage them from the roster instead.'
            : code === 'provider_account_cannot_be_employee'
              ? 'That account is a service provider (agency / CPO), not an individual. Only individual Bravo users can be added as employees.'
              : 'Could not add this person. Check the details and try again.';
      Alert.alert('Could not add', msg);
    } finally {
      setAdding(false);
    }
  }, [needle, adding, load]);

  const setStatus = useCallback((m: RosterMember, status: 'active' | 'suspended' | 'removed') => {
    const label = m.display_name ?? m.email ?? 'this member';
    const verb = status === 'removed' ? 'Remove' : status === 'suspended' ? 'Suspend' : 'Reinstate';
    Alert.alert(
      `${verb} ${label}?`,
      status === 'removed'
        ? 'They lose access to your channels, attendance and incident reporting. Their own Bravo account is unaffected.'
        : status === 'suspended'
          ? 'They temporarily lose workspace access until reinstated.'
          : 'They regain access to your workspace.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: verb,
          style: status === 'active' ? 'default' : 'destructive',
          onPress: () => {
            void (async () => {
              setBusyId(m.member_user_id);
              try {
                await orgApi.setCpoStatus(m.member_user_id, status);
                await load();
              } catch {
                Alert.alert('Update failed', 'Please try again.');
              } finally {
                setBusyId(null);
              }
            })();
          },
        },
      ],
    );
  }, [load]);

  const employees = members.filter(m => m.member_role === 'employee' && m.status !== 'removed');
  const others = members.filter(m => m.member_role !== 'employee' && m.status !== 'removed');

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Employees" pill="WORKSPACE" />

      <ScrollView
        contentContainerStyle={{padding: 16, paddingBottom: insets.bottom + 32, gap: 12}}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={OB.accent}
          onRefresh={() => { setRefreshing(true); void load(); }} />}
        showsVerticalScrollIndicator={false}>

        <Card>
          <SectionLabel>ADD BY EMAIL OR PHONE</SectionLabel>
          <View style={s.addRow}>
            <TextInput
              style={s.input}
              value={needle}
              onChangeText={setNeedle}
              placeholder="name@company.com or +9715…"
              placeholderTextColor={OB.textMute}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!adding}
            />
            <TouchableOpacity
              style={[s.addBtn, (!needle.trim() || adding) && {opacity: 0.5}]}
              disabled={!needle.trim() || adding}
              onPress={() => { void add(); }}
              accessibilityRole="button"
              accessibilityLabel="Add employee">
              {adding ? <ActivityIndicator color="#FFF" size="small" /> : <Icon name="account-plus" size={20} color="#FFF" />}
            </TouchableOpacity>
          </View>
          <Text style={s.hint}>
            They must already have a Bravo account (Lite is free). Adding them
            unlocks your department channels, attendance and incident reporting
            for them — it never changes their own plan or app.
          </Text>
        </Card>

        <SectionLabel>{`EMPLOYEES · ${employees.length}`}</SectionLabel>
        {loading ? (
          <ActivityIndicator color={OB.accent} style={{marginTop: 24}} />
        ) : employees.length === 0 ? (
          <Card>
            <Text style={s.empty}>No employees yet. Add your first team member above.</Text>
          </Card>
        ) : employees.map(m => (
          <Card key={m.member_user_id}>
            <View style={s.memberRow}>
              <View style={s.avatar}>
                <Icon name="account" size={20} color={OB.accent} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.name} numberOfLines={1}>{m.display_name ?? m.email ?? 'Employee'}</Text>
                <Text style={s.sub} numberOfLines={1}>
                  {m.email ?? '—'} · {m.status === 'suspended' ? 'Suspended' : 'Active'}
                </Text>
              </View>
              {busyId === m.member_user_id ? (
                <ActivityIndicator color={OB.accent} size="small" />
              ) : (
                <View style={s.actions}>
                  {m.status === 'suspended' ? (
                    <TouchableOpacity onPress={() => setStatus(m, 'active')} style={s.actBtn}
                      accessibilityRole="button" accessibilityLabel="Reinstate">
                      <Icon name="account-check" size={18} color="#34d399" />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={() => setStatus(m, 'suspended')} style={s.actBtn}
                      accessibilityRole="button" accessibilityLabel="Suspend">
                      <Icon name="pause-circle-outline" size={18} color="#F59E0B" />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => setStatus(m, 'removed')} style={s.actBtn}
                    accessibilityRole="button" accessibilityLabel="Remove">
                    <Icon name="account-remove-outline" size={18} color="#F87171" />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </Card>
        ))}

        {others.length > 0 && (
          <>
            <SectionLabel>{`OTHER ROSTER MEMBERS · ${others.length}`}</SectionLabel>
            <Card>
              <Text style={s.empty}>
                {others.length} CPO/manager roster member{others.length === 1 ? '' : 's'} managed
                from your provider roster — untouched here.
              </Text>
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  addRow: {flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 8},
  input: {
    flex: 1, height: 46, borderRadius: 12, borderWidth: 1, borderColor: OB.hair,
    backgroundColor: 'rgba(255,255,255,0.03)', color: OB.text, paddingHorizontal: 14, fontSize: 14,
  },
  addBtn: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: OB.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  hint: {color: OB.textMute, fontSize: 11, lineHeight: 16, marginTop: 10},
  empty: {color: OB.textDim, fontSize: 12.5, lineHeight: 18},
  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  avatar: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  name: {color: OB.text, fontSize: 14.5, fontWeight: '700'},
  sub: {color: OB.textMute, fontSize: 11.5, marginTop: 2},
  actions: {flexDirection: 'row', gap: 6},
  actBtn: {
    width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair,
  },
}));
