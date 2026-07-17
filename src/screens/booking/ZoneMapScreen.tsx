/**
 * Booking · Step 01 — Select Location (Zone)
 *
 * Premium redesign (Bravo "Select Zone" design handoff): obsidian/cobalt
 * palette, a stylised live map card with an Abu Dhabi pin + amber CPO
 * availability badge, country zone rows with live "CPOs online" status,
 * and a gradient Continue CTA.
 *
 * Data layer is unchanged from the original: a static city-zone seed,
 * live per-region CPO counts from `bookingApi.regionsAvailability()`,
 * booking-draft update on continue, then navigate to ServiceType.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  ScrollView,
  Animated,
  Easing,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {bookingApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ZoneMap'>;

// Design tokens (Bravo "Select Zone" handoff — obsidian/cobalt premium).
// Kept inline so this screen matches the mockup exactly; the older
// Command-Navy theme isn't applied here on purpose.
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentGlow: 'rgba(91,141,239,0.35)',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

interface Region {
  code: string;     // dispatch key — matches region_code across the whole stack, DO NOT change
  badge: string;    // B-90 T-07 — 3-letter DISPLAY code shown on the tile (never sent to the API)
  name: string;     // full label, e.g. "UAE — Dubai, Abu Dhabi, Sharjah"
  country: string;  // e.g. "UAE"
  cities: string;   // e.g. "Dubai, Abu Dhabi, Sharjah"
  cpos: number;
  available: boolean;
}

// Static city seed; live `cpos`/`available` come from regionsAvailability
// and override these at mount (same contract as the original screen). The
// seed values are the fallback shown while the call is in flight (and
// permanently if it fails — better than a blank screen).
// Why KSA/RSA: the boss asked for 3-letter badges incl. "SA" for South
// Africa, but SA is Saudi Arabia's dispatch code — KSA (Saudi) / RSA
// (South Africa) resolves the collision without touching any region_code.
const REGION_SEED: Region[] = [
  {code: 'AE', badge: 'UAE', name: 'UAE — Dubai, Abu Dhabi, Sharjah',      country: 'UAE',            cities: 'Dubai, Abu Dhabi, Sharjah', cpos: 0, available: true},
  {code: 'SA', badge: 'KSA', name: 'Saudi Arabia — Riyadh, Jeddah',        country: 'Saudi Arabia',   cities: 'Riyadh, Jeddah',            cpos: 0, available: false},
  {code: 'BD', badge: 'BGD', name: 'Bangladesh — Dhaka Division',          country: 'Bangladesh',     cities: 'Dhaka Division',            cpos: 0, available: true},
  {code: 'GB', badge: 'GBR', name: 'United Kingdom — London',              country: 'United Kingdom', cities: 'London',                    cpos: 0, available: false},
  // B-93 — ZA is LAUNCHED (boss instruction): selectable even before its CPO
  // pool is staffed. Badge is "SA" per the boss's wording — no display clash,
  // Saudi renders "KSA" (the internal dispatch codes stay ZA vs SA).
  {code: 'ZA', badge: 'SA',  name: 'South Africa — Johannesburg, Cape Town', country: 'South Africa',  cities: 'Johannesburg, Cape Town',   cpos: 0, available: true},
];

function ZoneRow({region, selected, loaded, onPress}: {region: Region; selected: boolean; loaded: boolean; onPress: () => void}) {
  const live = region.available;
  return (
    <TouchableOpacity
      activeOpacity={live ? 0.85 : 1}
      onPress={live ? onPress : undefined}
      accessibilityRole="button"
      accessibilityState={{selected, disabled: !live}}
      accessibilityLabel={`${region.country}, ${live ? 'live' : 'coming soon'}`}
      style={[
        s.row,
        selected ? s.rowSelected : s.rowIdle,
        !live && s.rowDisabled,
      ]}>
      {selected && <View style={s.rowTopLight} />}

      {/* code tile */}
      {selected ? (
        <LinearGradient
          colors={['#6E9BF5', D.accentDeep]}
          start={{x: 0.15, y: 0}}
          end={{x: 0.85, y: 1}}
          style={s.codeTile}>
          <Text style={[s.codeText, {color: '#fff'}]}>{region.badge}</Text>
        </LinearGradient>
      ) : (
        <View style={[s.codeTile, s.codeTileIdle]}>
          <Text style={[s.codeText, {color: D.textMute}]}>{region.badge}</Text>
        </View>
      )}

      <View style={s.rowInfo}>
        <Text numberOfLines={1} style={s.rowTitle}>
          <Text style={{color: live ? D.text : D.textDim}}>{region.country}</Text>
          <Text style={s.rowCities}> — {region.cities}</Text>
        </Text>
        <View style={s.rowStatus}>
          {live ? (
            <>
              <View style={s.dot} />
              <Text style={s.statusLive}>{loaded ? `${region.cpos} CPOs online` : 'Checking…'}</Text>
            </>
          ) : (
            <Text style={s.statusSoon}>COMING SOON</Text>
          )}
        </View>
      </View>

      {live && (
        <View style={[s.chev, selected ? s.chevSelected : s.chevIdle]}>
          <Icon name="chevron-right" size={16} color={selected ? '#A9C5FF' : D.textMute} />
        </View>
      )}
    </TouchableOpacity>
  );
}

function MapCard({pinLabel, cpoLabel}: {pinLabel: string; cpoLabel: string}) {
  // Pin pulse — expanding/fading ring (mirrors the design's pinpulse keyframe).
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1, duration: 2400, easing: Easing.out(Easing.ease), useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const pulseScale = pulse.interpolate({inputRange: [0, 1], outputRange: [0.6, 2.2]});
  const pulseOpacity = pulse.interpolate({inputRange: [0, 1], outputRange: [0.7, 0]});

  return (
    <LinearGradient colors={['#0C1220', '#080C16']} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={s.map}>
      {/* grid */}
      <View style={s.mapGrid} pointerEvents="none">
        {Array.from({length: 6}).map((_, i) => (
          <View key={`h${i}`} style={[s.gridLine, {top: i * 38}]} />
        ))}
        {Array.from({length: 9}).map((_, i) => (
          <View key={`v${i}`} style={[s.gridLineV, {left: i * 38}]} />
        ))}
      </View>
      {/* top edge light */}
      <View style={s.mapTopLight} pointerEvents="none" />

      {/* title chip */}
      <Text style={s.mapTitle}>SELECT ZONE</Text>

      {/* pin */}
      <View style={s.pinWrap}>
        <View style={s.pinLabel}>
          <Text numberOfLines={1} style={s.pinLabelText}>{pinLabel}</Text>
        </View>
        <Animated.View
          style={[s.pinPulse, {transform: [{scale: pulseScale}], opacity: pulseOpacity}]}
          pointerEvents="none"
        />
        <View style={s.pinDot} />
      </View>

      {/* CPO badge */}
      <View style={s.cpoBadge}>
        <Icon name="star-four-points" size={13} color={D.amber} />
        <Text numberOfLines={1} style={s.cpoBadgeText}>{cpoLabel}</Text>
      </View>
    </LinearGradient>
  );
}

export default function ZoneMapScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draftCode = useBookingStore(st => st.draft.zone_code);

  const [selectedCode, setSelectedCode] = useState<string>(draftCode || 'AE');
  const [regions, setRegions] = useState<Region[]>(REGION_SEED);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    bookingApi.regionsAvailability()
      .then(res => {
        if (cancelled) {return;}
        const live = new Map(res.data.map(r => [r.code, r]));
        setRegions(REGION_SEED.map(seed => {
          const v = live.get(seed.code);
          if (!v) {return seed;}
          return {...seed, cpos: v.cpos_available, available: v.available};
        }));
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) {setLoaded(true);} /* keep seed; better than blank */ });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => regions.find(r => r.code === selectedCode) ?? regions[0],
    [regions, selectedCode],
  );

  const liveCount = regions.filter(r => r.available).length;
  const soonCount = regions.length - liveCount;

  const handleContinue = () => {
    if (!selected.available) {return;}
    updateDraft({zone_code: selected.code, zone_label: selected.name, region: selected.code});
    navigation.navigate('ServiceType');
  };

  // Map card reflects the selected region (pin label + CPO badge).
  const pinLabel = selected.country === 'UAE' ? 'Abu Dhabi' : selected.cities.split(',')[0].trim();
  const cpoLabel = selected.available
    ? `${selected.cpos} CPOS AVAILABLE · ${selected.badge}`
    : `COMING SOON · ${selected.badge}`;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.title}>Select Location</Text>
          <Text numberOfLines={1} ellipsizeMode="tail" style={s.subTitle}>STEP 1 · CHOOSE OPERATING ZONE</Text>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 140}}
        showsVerticalScrollIndicator={false}>
        <MapCard pinLabel={pinLabel} cpoLabel={cpoLabel} />

        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>AVAILABLE ZONES</Text>
          <Text style={s.sectionMeta}>{liveCount} LIVE · {soonCount} SOON</Text>
        </View>

        <View style={{gap: 11}}>
          {regions.map(r => (
            <ZoneRow
              key={r.code}
              region={r}
              selected={r.code === selectedCode}
              loaded={loaded}
              onPress={() => setSelectedCode(r.code)}
            />
          ))}
        </View>
      </ScrollView>

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: Math.max(insets.bottom, 12) + 12}]}>
        <TouchableOpacity
          activeOpacity={selected.available ? 0.9 : 1}
          disabled={!selected.available}
          onPress={handleContinue}>
          <LinearGradient
            colors={selected.available ? ['#6E9BF5', D.accent, D.accentDeep] : ['#27324A', '#1C2436']}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, !selected.available && s.ctaDisabled]}>
            <Text style={s.ctaText}>Continue</Text>
            <Icon name="arrow-right" size={19} color="#fff" />
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  subTitle: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  scroll: {flex: 1},

  // Map card
  map: {
    height: 218, borderRadius: 22, overflow: 'hidden',
    borderWidth: 1, borderColor: D.hair2,
    shadowColor: '#000', shadowOpacity: 0.34, shadowRadius: 18, shadowOffset: {width: 0, height: 12}, elevation: 8,
  },
  mapGrid: {...StyleSheet.absoluteFillObject},
  gridLine: {position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(91,141,239,0.08)'},
  gridLineV: {position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(91,141,239,0.08)'},
  mapTopLight: {position: 'absolute', top: 0, left: 22, right: 22, height: 1, backgroundColor: 'rgba(120,160,255,0.3)'},
  mapTitle: {
    position: 'absolute', top: 14, alignSelf: 'center',
    fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 2.5, color: D.textDim,
  },

  // Pin
  pinWrap: {position: 'absolute', left: 96, top: 118, width: 20, height: 20, alignItems: 'center', justifyContent: 'center'},
  pinPulse: {position: 'absolute', width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(91,141,239,0.3)'},
  pinDot: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: '#7FA8FF',
    borderWidth: 2, borderColor: '#0A0D12',
    shadowColor: D.accent, shadowOpacity: 0.9, shadowRadius: 16, shadowOffset: {width: 0, height: 0}, elevation: 10,
  },
  pinLabel: {
    position: 'absolute', top: -38, left: -8,
    paddingVertical: 5, paddingHorizontal: 11, borderRadius: 9,
    backgroundColor: 'rgba(10,16,28,0.92)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },
  pinLabelText: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: '#fff'},

  // CPO badge
  cpoBadge: {
    position: 'absolute', bottom: 16, alignSelf: 'center', maxWidth: '86%',
    flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingVertical: 9, paddingHorizontal: 16, borderRadius: 999,
    backgroundColor: 'rgba(245,181,68,0.10)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.45)',
  },
  cpoBadgeText: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: D.amber},

  // Section label
  sectionRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 12, paddingHorizontal: 2},
  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim},
  sectionMeta: {fontFamily: D.fMono, fontSize: 9, letterSpacing: 1, color: D.textMute},

  // Zone row
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 15, borderRadius: 18, overflow: 'hidden',
  },
  rowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  rowSelected: {
    backgroundColor: 'rgba(16,26,46,0.9)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.5)',
    shadowColor: '#14285A', shadowOpacity: 0.34, shadowRadius: 16, shadowOffset: {width: 0, height: 12}, elevation: 8,
  },
  rowDisabled: {opacity: 0.62},
  rowTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(120,160,255,0.35)'},

  codeTile: {
    width: 50, height: 50, borderRadius: 14, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  codeTileIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  codeText: {fontFamily: D.fBold, fontSize: 13, letterSpacing: 0.5},

  rowInfo: {flex: 1, minWidth: 0},
  rowTitle: {fontFamily: D.fBold, fontSize: 15, letterSpacing: -0.2},
  rowCities: {color: D.textMute, fontFamily: D.fSemi},
  rowStatus: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5},
  dot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: D.signal,
    shadowColor: D.signal, shadowOpacity: 1, shadowRadius: 7, shadowOffset: {width: 0, height: 0}, elevation: 3,
  },
  statusLive: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 0.4, color: D.signal},
  statusSoon: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1, color: D.textMute,
    paddingVertical: 2, paddingHorizontal: 8, borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    overflow: 'hidden',
  },

  chev: {
    width: 28, height: 28, borderRadius: 14, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  chevIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  chevSelected: {backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    height: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16.5, letterSpacing: 0.3, color: '#fff'},
}));
