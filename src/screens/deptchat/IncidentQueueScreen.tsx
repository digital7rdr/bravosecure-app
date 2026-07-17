import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, ActivityIndicator, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList} from '@navigation/types';
import {incidentApi, type IncidentReportDto, type IncidentSeverityDto, type IncidentStatusDto} from '@services/api';
import {OB, ObHeader, Card} from './_obsidian';
import {INCIDENT_CATEGORY_META, INCIDENT_STATUS_META, severityColor} from './incidentMeta';
import {fmtTime} from './geo';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
const FILTERS: ({key: 'all'} | {key: IncidentSeverityDto})[] = [
  {key: 'all'}, {key: 'critical'}, {key: 'high'}, {key: 'medium'}, {key: 'low'},
];
// PDF p.14 — status filter row (server-side; severity row above it).
const STATUS_FILTERS: Array<'all' | IncidentStatusDto> = [
  'all', 'submitted', 'received', 'under_review', 'action_assigned', 'resolved', 'closed',
];

export default function IncidentQueueScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [items, setItems] = useState<IncidentReportDto[]>([]);
  const [filter, setFilter] = useState<'all' | IncidentSeverityDto>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | IncidentStatusDto>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (sev: 'all' | IncidentSeverityDto, st: 'all' | IncidentStatusDto) => {
    try {
      const {data} = await incidentApi.queue({
        ...(sev === 'all' ? {} : {severity: sev}),
        ...(st === 'all' ? {} : {status: st}),
      });
      setItems(data);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(filter, statusFilter); }, [load, filter, statusFilter]));

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Incident Queue" onBack={() => navigation.goBack()} pill={`${items.length}`} />

      <View style={s.filterRow}>
        {FILTERS.map(f => {
          const on = filter === f.key;
          const color = f.key === 'all' ? OB.accentSoft : severityColor(f.key);
          return (
            <TouchableOpacity
              key={f.key}
              style={[s.chip, on && {backgroundColor: color + '1F', borderColor: color}]}
              activeOpacity={0.8}
              onPress={() => { setFilter(f.key); setLoading(true); }}>
              <Text style={[s.chipText, on && {color}]}>{f.key === 'all' ? 'All' : f.key[0].toUpperCase() + f.key.slice(1)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.statusScroll} contentContainerStyle={s.statusRow}>
        {STATUS_FILTERS.map(st => {
          const on = statusFilter === st;
          const label = st === 'all' ? 'Any status' : INCIDENT_STATUS_META[st]?.label ?? st;
          return (
            <TouchableOpacity
              key={st}
              style={[s.chip, s.statusChip, on && {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.55)'}]}
              activeOpacity={0.8}
              onPress={() => { setStatusFilter(st); setLoading(true); }}>
              <Text style={[s.chipText, on && {color: OB.accentSoft}]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Managers can also file their own report (submit() is gated only by
          JwtAuthGuard) — without this they'd have to drop to a member surface. */}
      <View style={{paddingHorizontal: 20, paddingBottom: 12}}>
        <TouchableOpacity style={s.reportBtn} activeOpacity={0.85} onPress={() => navigation.navigate('ReportIncidentCategory')}>
          <Icon name="alert-octagon-outline" size={16} color={OB.accentSoft} />
          <Text style={s.reportText}>Report an Incident</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 32}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(filter, statusFilter); }} tintColor={OB.accentSoft} />}>
        {loading ? (
          <ActivityIndicator color={OB.accentSoft} style={{marginTop: 32}} />
        ) : items.length === 0 ? (
          <Card><Text style={s.empty}>No incidents in this view.</Text></Card>
        ) : (
          <View style={{gap: 10}}>
            {items.map(it => {
              const cat = INCIDENT_CATEGORY_META[it.category];
              const sevC = severityColor(it.severity);
              const st = INCIDENT_STATUS_META[it.status];
              return (
                <Card key={it.id} onPress={() => navigation.navigate('IncidentDetail', {incidentId: it.id, ref: it.ref})} style={{gap: 11}}>
                  <View style={s.rowTop}>
                    <View style={[s.sevBar, {backgroundColor: sevC}]} />
                    <Icon name={cat?.icon ?? 'alert-octagon-outline'} size={18} color={OB.glow} />
                    <Text style={s.cat} numberOfLines={1}>{cat?.label ?? it.category}</Text>
                    <Text style={s.ref}>{it.ref ?? '—'}</Text>
                  </View>
                  <View style={s.rowBottom}>
                    <View style={[s.tag, {backgroundColor: sevC + '1A', borderColor: sevC + '4D'}]}>
                      <Text style={[s.tagText, {color: sevC}]}>{it.severity.toUpperCase()}</Text>
                    </View>
                    <View style={[s.tag, {backgroundColor: st.color + '1A', borderColor: st.color + '4D'}]}>
                      <Text style={[s.tagText, {color: st.color}]}>{st.label}</Text>
                    </View>
                    <Text style={s.time}>{fmtTime(it.updated_at)}</Text>
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  filterRow: {flexDirection: 'row', gap: 7, paddingHorizontal: 20, paddingBottom: 12},
  chip: {flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: OB.hair},
  statusScroll: {flexGrow: 0},
  statusRow: {flexDirection: 'row', gap: 7, paddingHorizontal: 20, paddingBottom: 12},
  statusChip: {flex: 0, paddingHorizontal: 12},
  chipText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  reportBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 12, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  reportText: {color: OB.accentSoft, fontFamily: BravoFont.bold, fontSize: 13},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  rowTop: {flexDirection: 'row', alignItems: 'center', gap: 10},
  sevBar: {width: 3, height: 18, borderRadius: 2},
  cat: {flex: 1, color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  ref: {color: OB.glow, fontFamily: BravoFont.mono, fontSize: 11, fontWeight: '700', letterSpacing: 0.5},
  rowBottom: {flexDirection: 'row', alignItems: 'center', gap: 8},
  tag: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  tagText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  time: {flex: 1, textAlign: 'right', color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 10.5},
}));
