import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, TextInput, TouchableOpacity, Linking, Keyboard, InteractionManager, ActivityIndicator, FlatList} from 'react-native';
import Svg, {Path, Circle} from 'react-native-svg';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {VBG, VbgScreen, VbgCard, SectionLabel, IconButton} from './vbgUi';
import {VbgFooter} from './VbgFooter';
import {
  UNIVERSAL_EMERGENCY, searchEmergency,
  emergencyForName, emergencyForIso, type EmergencyEntry,
} from './emergencyNumbers';
import {getDeviceCountryIso} from './deviceCountry';

type Rt = RouteProp<BookingStackParamList, 'VBGEmergency'>;

/** One dialable service chip — taps straight to the dialer. */
function CallChip({label, number, onCall, strong}: {label: string; number: string; onCall: (n: string) => void; strong?: boolean}) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      style={[styles.chip, strong && styles.chipStrong]}
      onPress={() => onCall(number)}
    >
      <Svg width={13} height={13} viewBox="0 0 24 24">
        <Path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5V18a2 2 0 0 1-2 2A14 14 0 0 1 5 6a2 2 0 0 1 0-2Z" stroke={strong ? '#fff' : VBG.signal} strokeWidth={1.7} fill="none" strokeLinejoin="round" />
      </Svg>
      <Text style={[styles.chipLabel, strong && styles.chipLabelStrong]}>{label}</Text>
      <Text style={[styles.chipNum, strong && styles.chipNumStrong]}>{number}</Text>
    </TouchableOpacity>
  );
}

/** All service chips for a country (only the ones that exist). */
function ServiceChips({e, onCall}: {e: EmergencyEntry; onCall: (n: string) => void}) {
  return (
    <View style={styles.chipWrap}>
      {e.all ? <CallChip label="All" number={e.all} onCall={onCall} strong /> : null}
      {e.police ? <CallChip label="Police" number={e.police} onCall={onCall} /> : null}
      {e.ambulance ? <CallChip label="Ambulance" number={e.ambulance} onCall={onCall} /> : null}
      {e.fire ? <CallChip label="Fire" number={e.fire} onCall={onCall} /> : null}
      {!e.all && !e.police && !e.ambulance && !e.fire
        ? <CallChip label="Emergency" number={UNIVERSAL_EMERGENCY} onCall={onCall} strong /> : null}
    </View>
  );
}

/** One country row. Memoized so typing only re-renders changed rows. */
const CountryRow = React.memo(function CountryRow({e, onCall}: {e: EmergencyEntry; onCall: (n: string) => void}) {
  return (
    <View style={styles.countryRow}>
      <View style={styles.countryHead}>
        <Text style={styles.countryName}>{e.name}</Text>
        <Text style={styles.countryIso}>{e.iso}</Text>
      </View>
      <ServiceChips e={e} onCall={onCall} />
    </View>
  );
});

export default function VBGEmergencyScreen() {
  const navigation = useNavigation();
  const route = useRoute<Rt>();
  const [query, setQuery] = useState('');
  // Defer the full ~180-country list until AFTER the navigation transition so
  // the push animation stays smooth (rendering all rows + their SVG call icons
  // up-front blocked the JS thread and made the screen feel laggy to open).
  // The header, universal-call button, search and pinned country render
  // immediately; the list fades in a beat later behind a small spinner.
  const [listReady, setListReady] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setListReady(true));
    return () => task.cancel();
  }, []);

  const call = useCallback((n: string) => {
    Keyboard.dismiss();
    const tel = `tel:${n.replace(/[^\d+*#]/g, '')}`;
    Linking.openURL(tel).catch(() => {});
  }, []);

  // Detected country: prefer the geocoded ISO code passed from Home (audit
  // L-5 — robust to name variants), then the geocoded country NAME, then the
  // device locale region (offline fallback). Any resolves to a bundled entry.
  const detected = useMemo<EmergencyEntry | null>(() => {
    const byIso = emergencyForIso(route.params?.countryIso ?? null);
    if (byIso) {return byIso;}
    const byName = emergencyForName(route.params?.countryName);
    if (byName) {return byName;}
    return emergencyForIso(getDeviceCountryIso());
  }, [route.params?.countryIso, route.params?.countryName]);

  const results = useMemo(() => {
    const list = searchEmergency(query);
    // When not searching, drop the pinned country from the main list (it's
    // shown at the top) so it isn't duplicated.
    if (!query.trim() && detected) {
      return list.filter(e => e.iso !== detected.iso);
    }
    return list;
  }, [query, detected]);

  // Header chrome above the virtualized list — intro, universal-call button,
  // search box, and the pinned detected country. Kept out of the row data so
  // FlatList owns the scroll and only mounts on-screen country rows.
  const header = (
    <View style={styles.body}>
      <Text style={styles.intro}>
        Tap a number to call directly. <Text style={{color: VBG.accentSoft, fontWeight: '600'}}>{UNIVERSAL_EMERGENCY}</Text> reaches emergency services on any network worldwide.
      </Text>

      {/* Universal — always one tap away, works on any SIM/network. */}
      <TouchableOpacity activeOpacity={0.9} style={styles.universal} onPress={() => call(UNIVERSAL_EMERGENCY)}>
        <View style={styles.universalIcon}>
          <Svg width={20} height={20} viewBox="0 0 24 24"><Path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5V18a2 2 0 0 1-2 2A14 14 0 0 1 5 6a2 2 0 0 1 0-2Z" stroke="#fff" strokeWidth={1.7} fill="none" strokeLinejoin="round" /></Svg>
        </View>
        <View style={{flex: 1}}>
          <Text style={styles.universalTitle}>Universal Emergency</Text>
          <Text style={styles.universalSub}>Reachable on any network · no SIM needed</Text>
        </View>
        <Text style={styles.universalNum}>{UNIVERSAL_EMERGENCY}</Text>
      </TouchableOpacity>

      {/* Search */}
      <View style={styles.searchRow}>
        <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
          <Circle cx={11} cy={11} r={7} stroke={VBG.textMute} strokeWidth={1.8} fill="none" />
          <Path d="M20 20l-4-4" stroke={VBG.textMute} strokeWidth={1.8} strokeLinecap="round" />
        </Svg>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search country…"
          placeholderTextColor={VBG.textMute}
          autoCorrect={false}
          autoCapitalize="words"
          style={styles.input}
        />
        {query.length > 0 ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Svg width={14} height={14} viewBox="0 0 24 24"><Path d="M6 6l12 12M18 6L6 18" stroke={VBG.textMute} strokeWidth={1.8} strokeLinecap="round" /></Svg>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Detected country pinned at top (only when not searching). */}
      {!query.trim() && detected ? (
        <View>
          <SectionLabel dot={VBG.signal} style={{marginBottom: 8, marginLeft: 2}}>Your Location</SectionLabel>
          <VbgCard pad={14} rail={VBG.signal}>
            <View style={styles.countryHead}>
              <Text style={styles.countryName}>{detected.name}</Text>
              <Text style={styles.countryIso}>{detected.iso}</Text>
            </View>
            <ServiceChips e={detected} onCall={call} />
          </VbgCard>
        </View>
      ) : null}

      <SectionLabel style={{marginBottom: 8, marginLeft: 2, marginTop: 4}}>
        {query.trim() ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'All Countries'}
      </SectionLabel>

      {!listReady ? (
        <View style={styles.loading}>
          <ActivityIndicator color={VBG.accent} />
          <Text style={styles.loadingText}>Loading directory…</Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <VbgScreen scroll={false} footer={<VbgFooter />}>
      <View style={styles.header}>
        <IconButton onPress={() => navigation.goBack()}>
          <Svg width={9} height={15} viewBox="0 0 9 15"><Path d="M8 1L1.5 7.5 8 14" stroke={VBG.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </IconButton>
        <SectionLabel color={VBG.text} style={{fontSize: 12, letterSpacing: 2}}>Emergency Services</SectionLabel>
      </View>

      <FlatList
        data={listReady ? results : []}
        keyExtractor={e => e.iso}
        renderItem={({item}) => (
          <View style={styles.body}><CountryRow e={item} onCall={call} /></View>
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={listReady ? (
          <View style={[styles.body, styles.empty]}>
            <Text style={styles.emptyTitle}>No match</Text>
            <Text style={styles.emptyHint}>No country found for “{query.trim()}”. Use {UNIVERSAL_EMERGENCY} above — it works everywhere.</Text>
          </View>
        ) : null}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingBottom: 120}}
        initialNumToRender={12}
        windowSize={9}
        removeClippedSubviews
      />
    </VbgScreen>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16},
  body: {paddingHorizontal: 18, gap: 13},
  intro: {fontSize: 12.5, lineHeight: 18, color: VBG.textDim, letterSpacing: -0.05},

  universal: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: 'rgba(255,93,93,0.10)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.34)'},
  universalIcon: {width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: VBG.alert},
  universalTitle: {fontSize: 14, fontWeight: '700', color: VBG.text, letterSpacing: -0.2},
  universalSub: {fontSize: 10.5, color: VBG.textMute, marginTop: 2},
  universalNum: {fontSize: 22, fontWeight: '800', color: '#FF8B8B', letterSpacing: -0.5},

  searchRow: {flexDirection: 'row', alignItems: 'center', gap: 9, height: 46, paddingHorizontal: 13, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: VBG.hair2},
  input: {flex: 1, color: VBG.text, fontSize: 13.5, padding: 0},

  countryRow: {paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: VBG.hair},
  countryHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9},
  countryName: {fontSize: 14, fontWeight: '600', color: VBG.text, letterSpacing: -0.2, flex: 1},
  countryIso: {fontSize: 10, fontWeight: '700', color: VBG.textMute, letterSpacing: 1, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden'},

  chipWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 7},
  chip: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: 'rgba(74,222,128,0.08)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)'},
  chipStrong: {backgroundColor: VBG.signal, borderColor: VBG.signal},
  chipLabel: {fontSize: 11, fontWeight: '600', color: VBG.signal},
  chipLabelStrong: {color: '#06140C'},
  chipNum: {fontSize: 11.5, fontWeight: '800', color: VBG.text, letterSpacing: 0.2},
  chipNumStrong: {color: '#06140C'},

  loading: {alignItems: 'center', paddingVertical: 30, gap: 9},
  loadingText: {fontSize: 11, color: VBG.textMute, letterSpacing: 1},
  empty: {alignItems: 'center', paddingVertical: 28, gap: 7},
  emptyTitle: {fontSize: 13, fontWeight: '700', color: VBG.text},
  emptyHint: {fontSize: 10.5, color: VBG.textMute, textAlign: 'center', paddingHorizontal: 24, lineHeight: 15},
}));
