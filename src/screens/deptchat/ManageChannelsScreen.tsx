import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, ActivityIndicator} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {MessengerStackParamList} from '@navigation/types';
import {departmentApi, type ManagedChannelDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, channelStateMeta} from './_obsidian';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;
type IconName = React.ComponentProps<typeof Icon>['name'];

const TYPE_META: Record<ManagedChannelDto['channel_type'], {label: string; icon: IconName}> = {
  board: {label: 'Board', icon: 'bullhorn-variant-outline'},
  department: {label: 'Department', icon: 'pound'},
  incident: {label: 'Incident', icon: 'shield-alert-outline'},
};

export default function ManageChannelsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [channels, setChannels] = useState<ManagedChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const {data} = await departmentApi.listManagedChannels();
      setChannels(data.channels);
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const active = channels.filter(c => !c.archived);
  const archived = channels.filter(c => c.archived);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Manage Channels" onBack={() => navigation.goBack()} pill={`${active.length}`} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>

        {loading ? (
          <ActivityIndicator color={OB.accentSoft} style={{marginTop: 40}} />
        ) : (
          <>
            <View style={{marginTop: 8}}>
              <SectionLabel>CHANNELS</SectionLabel>
              {active.length === 0 ? (
                <Card><Text style={s.empty}>No channels yet. Create the first one below.</Text></Card>
              ) : (
                <View style={{gap: 10}}>
                  {active.map(c => (
                    <Row key={c.id} c={c} onPress={() => navigation.navigate('ChannelEditor', {channel: pick(c)})} />
                  ))}
                </View>
              )}
            </View>

            {archived.length > 0 && (
              <View style={{marginTop: 22}}>
                <SectionLabel>ARCHIVED</SectionLabel>
                <View style={{gap: 10}}>
                  {archived.map(c => (
                    <Row key={c.id} c={c} onPress={() => navigation.navigate('ChannelEditor', {channel: pick(c)})} />
                  ))}
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>

      <View style={[s.footer, {paddingBottom: insets.bottom + 14}]}>
        <PrimaryButton label="New channel" icon="plus" onPress={() => navigation.navigate('ChannelEditor', {})} />
        {/* M1A rule 16 — the workspace roster (enroll existing users as
            employees). Providers' CPO roster lives in their own shell. */}
        <PrimaryButton label="Employees" icon="account-multiple-plus-outline" onPress={() => navigation.navigate('Employees')} />
      </View>
    </View>
  );
}

function pick(c: ManagedChannelDto) {
  return {
    id: c.id, name: c.name, department: c.department,
    channel_type: c.channel_type, access: c.access, archived: c.archived,
  };
}

function Row({c, onPress}: {c: ManagedChannelDto; onPress: () => void}) {
  const tm = TYPE_META[c.channel_type];
  const st = channelStateMeta({channel_type: c.channel_type, access: c.access, archived: c.archived});
  return (
    <Card onPress={onPress} style={s.row}>
      <View style={s.rowIcon}><Icon name={tm.icon} size={18} color={OB.accentSoft} /></View>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={s.rowName} numberOfLines={1}>{c.name}</Text>
        <Text style={s.rowSub} numberOfLines={1}>
          {tm.label}{c.department ? ` · ${c.department}` : ''} · {c.member_count} member{c.member_count === 1 ? '' : 's'}
          {c.provisioned ? '' : ' · not active'}
        </Text>
      </View>
      <View style={[s.badge, {borderColor: st.color + '4D', backgroundColor: st.color + '14'}]}>
        <Text style={[s.badgeText, {color: st.color}]}>{st.label}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={OB.textMute} />
    </Card>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  rowIcon: {
    width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: OB.hair2,
  },
  rowName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  rowSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  badge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, borderWidth: 1},
  badgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
