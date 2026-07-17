import React, {useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList} from '@navigation/types';
import type {IncidentCategoryDto, IncidentSeverityDto} from '@services/api';
import {OB, ObHeader, SectionLabel, PrimaryButton} from './_obsidian';
import {INCIDENT_CATEGORIES, INCIDENT_CATEGORY_META, INCIDENT_SEVERITIES} from './incidentMeta';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

export default function ReportIncidentCategoryScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [category, setCategory] = useState<IncidentCategoryDto | null>(null);
  const [severity, setSeverity] = useState<IncidentSeverityDto | null>(null);

  const ready = category !== null && severity !== null;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Report Incident" onBack={() => navigation.goBack()} pill="STEP 1" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

        <View style={{marginTop: 6}}>
          <SectionLabel>CATEGORY</SectionLabel>
          <View style={s.grid}>
            {INCIDENT_CATEGORIES.map(key => {
              const m = INCIDENT_CATEGORY_META[key];
              const on = category === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={[s.cat, on && s.catOn]}
                  activeOpacity={0.8}
                  onPress={() => setCategory(key)}>
                  <Icon name={m.icon} size={22} color={on ? OB.glow : OB.textDim} />
                  <Text style={[s.catLabel, on && {color: OB.text}]} numberOfLines={2}>{m.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={{marginTop: 22}}>
          <SectionLabel>SEVERITY</SectionLabel>
          <View style={s.sevRow}>
            {INCIDENT_SEVERITIES.map(sv => {
              const on = severity === sv.key;
              return (
                <TouchableOpacity
                  key={sv.key}
                  style={[s.sev, on && {backgroundColor: sv.color + '1F', borderColor: sv.color}]}
                  activeOpacity={0.8}
                  onPress={() => setSeverity(sv.key)}>
                  <View style={[s.sevDot, {backgroundColor: sv.color}]} />
                  <Text style={[s.sevText, on && {color: sv.color}]}>{sv.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <View style={[s.footer, {paddingBottom: insets.bottom + 12}]}>
        <PrimaryButton
          label="Continue"
          icon="arrow-right"
          disabled={!ready}
          onPress={() => {
            if (category && severity) {
              navigation.navigate('ReportIncidentDetails', {category, severity});
            }
          }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  cat: {
    width: '47.8%', minHeight: 84, borderRadius: 15, padding: 13, gap: 9,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: OB.hair,
  },
  catOn: {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.45)'},
  catLabel: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 12.5, lineHeight: 16},
  sevRow: {flexDirection: 'row', gap: 9},
  sev: {
    flex: 1, alignItems: 'center', gap: 7, paddingVertical: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: OB.hair,
  },
  sevDot: {width: 9, height: 9, borderRadius: 5},
  sevText: {color: OB.textDim, fontFamily: BravoFont.bold, fontSize: 11.5},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
