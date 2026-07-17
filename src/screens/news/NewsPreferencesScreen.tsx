import React, {useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Switch,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';

const PREFS_KEY = 'bravo.news.prefs.v1';

const ALL_TOPICS = ['Business', 'Finance', 'Security', 'Energy', 'Technology', 'Defence', 'Aviation', 'Real Estate'];
const DEFAULT_ACTIVE = new Set(['Business', 'Finance', 'Security', 'Technology', 'Real Estate']);

const REGIONS = [
  {id: 'ae', code: 'AE', label: 'UAE', defaultOn: true},
  {id: 'sa', code: 'SA', label: 'Saudi Arabia', defaultOn: true},
  {id: 'global', code: null, label: 'Global', defaultOn: true, icon: 'earth'},
  {id: 'gb', code: 'GB', label: 'UK', defaultOn: false},
  {id: 'tech', code: null, label: 'Technology', defaultOn: false, icon: 'devices'},
];

export default function NewsPreferencesScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [activeTopics, setActiveTopics] = useState<Set<string>>(DEFAULT_ACTIVE);
  const [regionToggles, setRegionToggles] = useState<Record<string, boolean>>(
    Object.fromEntries(REGIONS.map(r => [r.id, r.defaultOn])),
  );

  // Hydrate persisted prefs on mount so prior selections survive restarts.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(PREFS_KEY)
      .then(raw => {
        if (cancelled || !raw) {return;}
        const saved = JSON.parse(raw) as {topics?: string[]; regions?: Record<string, boolean>};
        if (Array.isArray(saved.topics)) {setActiveTopics(new Set(saved.topics));}
        if (saved.regions && typeof saved.regions === 'object') {
          setRegionToggles(prev => ({...prev, ...saved.regions}));
        }
      })
      .catch(() => {/* corrupt/missing — keep defaults */});
    return () => { cancelled = true; };
  }, []);

  const savePrefs = async () => {
    try {
      await AsyncStorage.setItem(
        PREFS_KEY,
        JSON.stringify({topics: Array.from(activeTopics), regions: regionToggles}),
      );
    } catch {/* best-effort; navigation still proceeds */}
    navigation.goBack();
  };

  const toggleTopic = (t: string) => {
    setActiveTopics(prev => {
      const next = new Set(prev);
      if (next.has(t)) {next.delete(t);} else {next.add(t);}
      return next;
    });
  };

  const toggleRegion = (id: string) => {
    setRegionToggles(prev => ({...prev, [id]: !prev[id]}));
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>News Preferences</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        <Text style={styles.desc}>Select the topics and regions you're most interested in. Your feed will be personalised accordingly.</Text>

        {/* Topics */}
        <View>
          <Text style={styles.sectionLabel}>Topics</Text>
          <View style={styles.topicsWrap}>
            {ALL_TOPICS.map(topic => {
              const isActive = activeTopics.has(topic);
              return (
                <TouchableOpacity
                  key={topic}
                  style={[styles.topicChip, isActive && styles.topicChipActive]}
                  onPress={() => toggleTopic(topic)}
                  activeOpacity={0.8}>
                  <Text style={[styles.topicText, isActive && styles.topicTextActive]}>{topic}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Regions */}
        <View>
          <Text style={styles.sectionLabel}>Preferred Regions</Text>
          <View style={styles.regionList}>
            {REGIONS.map(region => {
              const isOn = regionToggles[region.id];
              return (
                <TouchableOpacity
                  key={region.id}
                  style={[styles.regionRow, isOn && styles.regionRowOn]}
                  onPress={() => toggleRegion(region.id)}
                  activeOpacity={0.85}>
                  {region.icon ? (
                    <View style={[styles.regionIcon, {backgroundColor: isOn ? 'rgba(37,99,235,0.12)' : '#1E2D45'}]}>
                      <Icon name={region.icon} size={14} color={isOn ? '#60A5FA' : '#64748B'} />
                    </View>
                  ) : (
                    <View style={[styles.codeTag, {backgroundColor: isOn ? 'rgba(37,99,235,0.15)' : '#1E2D45', borderColor: isOn ? 'rgba(37,99,235,0.3)' : 'transparent'}]}>
                      <Text style={[styles.codeText, {color: isOn ? '#60A5FA' : '#64748B'}]}>{region.code}</Text>
                    </View>
                  )}
                  <Text style={[styles.regionLabel, !isOn && styles.regionLabelOff]}>{region.label}</Text>
                  {/* Display-only: the row's TouchableOpacity owns the toggle.
                      pointerEvents=none stops the Switch firing a second
                      toggleRegion on top of the row press (double-toggle). */}
                  <Switch
                    value={isOn}
                    pointerEvents="none"
                    trackColor={{false: '#1E2D45', true: Colors.primary}}
                    thumbColor="#FFF"
                    style={{flexShrink: 0}}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

      </ScrollView>

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 20}]}>
        <TouchableOpacity
          style={styles.saveBtn}
          onPress={() => { void savePrefs(); }}
          activeOpacity={0.85}>
          <Text style={styles.saveBtnText}>SAVE PREFERENCES</Text>
          <Icon name="arrow-right" size={16} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {flex: 1, fontSize: 14, fontWeight: '700', color: '#E2E8F0', textAlign: 'center', marginRight: 36},
  headerSpacer: {width: 36},

  content: {paddingHorizontal: 16, paddingTop: 16, gap: 20},

  desc: {fontSize: 12, color: '#94A3B8', lineHeight: 18},

  sectionLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12},

  topicsWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  topicChip: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 99, borderWidth: 1.5, borderColor: '#1E2D45', backgroundColor: 'transparent'},
  topicChipActive: {backgroundColor: 'rgba(37,99,235,0.15)', borderColor: Colors.primary},
  topicText: {fontSize: 11, fontWeight: '700', color: '#64748B'},
  topicTextActive: {color: '#60A5FA'},

  regionList: {gap: 8},
  regionRow: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', backgroundColor: '#0D1929'},
  regionRowOn: {borderColor: 'rgba(37,99,235,0.3)'},
  regionIcon: {width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  codeTag: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, flexShrink: 0},
  codeText: {fontSize: 10, fontWeight: '800'},
  regionLabel: {flex: 1, fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  regionLabelOff: {color: '#64748B'},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  saveBtn: {backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  saveBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.8},
}));
