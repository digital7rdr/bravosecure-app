import React, {useState} from 'react';
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
import {DynIcon} from '@components/DynIcon';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const PRO_INDIGO = '#6366F1';
const PRO_INDIGO_LIGHT = '#818CF8';

type UploadState = 'idle' | 'parsing' | 'done';
type LegStatus = 'booked' | 'pending' | 'open';

interface TravelLeg {
  id: number;
  icon: string;
  iconColor: string;
  route: string;
  meta: string;
  status: LegStatus;
  items: {icon: string; color: string; label: string}[];
}

const LEGS: TravelLeg[] = [
  {
    id: 1,
    icon: 'airplane-takeoff',
    iconColor: PRO_INDIGO,
    route: 'Dubai → London',
    meta: 'EK003 · Mon 14 Apr · Dep 09:20',
    status: 'booked',
    items: [
      {icon: 'check-circle', color: '#4ade80', label: 'Airport CPO pre-assigned — DXB T3'},
      {icon: 'check-circle', color: '#4ade80', label: 'Armoured vehicle — kerbside LHR T5'},
      {icon: 'check-circle', color: '#4ade80', label: 'Control room notified · ETA flagged'},
    ],
  },
  {
    id: 2,
    icon: 'car',
    iconColor: '#F59E0B',
    route: 'LHR → Mayfair Hotel',
    meta: 'Ground transfer · Mon 14 Apr · ~16:45',
    status: 'pending',
    items: [
      {icon: 'check-circle', color: '#4ade80', label: 'Driver pre-booked — awaiting confirmation'},
      {icon: 'clock-outline', color: '#F59E0B', label: 'Route risk assessment in progress'},
      {icon: 'clock-outline', color: '#F59E0B', label: 'Control room handover — pending ETA lock'},
    ],
  },
  {
    id: 3,
    icon: 'train',
    iconColor: '#64748B',
    route: 'London → Edinburgh',
    meta: 'LNER · Thu 17 Apr · Dep 11:00',
    status: 'open',
    items: [],
  },
];

interface CtrlToggle {
  id: string;
  icon: string;
  iconColor: string;
  title: string;
  sub: string;
  enabled: boolean;
}

const CTRL_TOGGLES: CtrlToggle[] = [
  {id: 'departure', icon: 'airplane', iconColor: PRO_INDIGO_LIGHT, title: 'Departure & Arrival Alerts', sub: 'Ops room notified at check-in and landing', enabled: true},
  {id: 'route', icon: 'routes', iconColor: PRO_INDIGO_LIGHT, title: 'Real-Time Route Updates', sub: 'Live GPS tracking pushed to control room', enabled: true},
  {id: 'delay', icon: 'update', iconColor: '#FBBF24', title: 'Delay & Schedule Changes', sub: 'Flight delays, gate changes sent immediately', enabled: true},
  {id: 'emergency', icon: 'alert', iconColor: '#F87171', title: 'Emergency Escalation', sub: 'Auto-escalate SOS to on-call duty officer', enabled: true},
  {id: 'hotel', icon: 'hotel', iconColor: '#64748B', title: 'Hotel Check-In Confirmation', sub: 'Notify control room when principal is secured', enabled: false},
];

export default function ItineraryUploadScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [uploadState, setUploadState] = useState<UploadState>('done');
  const [bookedLegs, setBookedLegs] = useState<number[]>([1]);
  const [ctrlToggles, setCtrlToggles] = useState<Record<string, boolean>>(
    Object.fromEntries(CTRL_TOGGLES.map(t => [t.id, t.enabled])),
  );

  const toggleCtrl = (id: string) => {
    setCtrlToggles(prev => ({...prev, [id]: !prev[id]}));
  };

  const handlePrebook = (legId: number) => {
    setBookedLegs(prev => [...prev, legId]);
  };

  const getBorderColor = (status: LegStatus) => {
    if (status === 'booked') {return 'rgba(99,102,241,0.35)';}
    if (status === 'pending') {return 'rgba(245,158,11,0.3)';}
    return '#1E2D45';
  };

  const getStatusBadge = (status: LegStatus) => {
    if (status === 'booked') {return {bg: 'rgba(99,102,241,0.12)', color: '#A5B4FC', border: 'rgba(99,102,241,0.3)', label: 'BOOKED'};}
    if (status === 'pending') {return {bg: 'rgba(245,158,11,0.1)', color: '#FBBF24', border: 'rgba(245,158,11,0.3)', label: 'PENDING'};}
    return {bg: 'rgba(100,116,139,0.1)', color: '#64748B', border: '#1E2D45', label: 'OPEN'};
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#CBD5E1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Itinerary Upload</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {/* Upload Zone */}
        <View style={styles.uploadZone}>
          {uploadState === 'idle' && (
            <TouchableOpacity style={styles.uploadInner} activeOpacity={0.8}
              onPress={() => { setUploadState('parsing'); setTimeout(() => setUploadState('done'), 2000); }}>
              <Text style={styles.uploadEmoji}>📁</Text>
              <Text style={styles.uploadTitle}>UPLOAD ITINERARY</Text>
              <Text style={styles.uploadSub}>PDF · ICS · Excel · Word</Text>
              <Text style={styles.uploadHint}>Tap to browse files</Text>
            </TouchableOpacity>
          )}
          {uploadState === 'parsing' && (
            <View style={styles.uploadInner}>
              <Text style={styles.uploadEmoji}>📄</Text>
              <Text style={styles.uploadFilename}>itinerary_april.pdf</Text>
              <View style={styles.parseTrack}>
                <View style={styles.parseBar} />
              </View>
              <Text style={styles.uploadHint}>Parsing itinerary…</Text>
            </View>
          )}
          {uploadState === 'done' && (
            <View style={styles.uploadInner}>
              <Text style={styles.uploadEmoji}>✅</Text>
              <Text style={styles.uploadFilename}>itinerary_april.pdf</Text>
              <Text style={styles.uploadDetected}>14 events detected · 3 travel legs</Text>
            </View>
          )}
        </View>

        {/* Journey Management */}
        <View>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>Travel Journey Management</Text>
            <View style={styles.legsBadge}>
              <Text style={styles.legsBadgeText}>3 LEGS</Text>
            </View>
          </View>

          {LEGS.map(leg => {
            const badge = getStatusBadge(leg.status);
            const isBooked = bookedLegs.includes(leg.id);
            const effectiveStatus: LegStatus = isBooked ? 'booked' : leg.status;
            const effectiveBadge = getStatusBadge(effectiveStatus);
            return (
              <View key={leg.id} style={[styles.legCard, {borderColor: getBorderColor(isBooked ? 'booked' : leg.status)}]}>
                <View style={styles.legHeader}>
                  <View style={styles.legLeft}>
                    <DynIcon name={leg.icon} size={16} color={isBooked ? PRO_INDIGO : leg.iconColor} />
                    <View>
                      <Text style={[styles.legRoute, leg.status === 'open' && !isBooked && {color: '#64748B'}]}>
                        {leg.route}
                      </Text>
                      <Text style={styles.legMeta}>{leg.meta}</Text>
                    </View>
                  </View>
                  <View style={[styles.statusBadge, {backgroundColor: effectiveBadge.bg, borderColor: effectiveBadge.border}]}>
                    <Text style={[styles.statusBadgeText, {color: effectiveBadge.color}]}>
                      {isBooked ? 'BOOKED' : badge.label}
                    </Text>
                  </View>
                </View>

                <View style={styles.legBody}>
                  {(isBooked ? [{icon: 'check-circle', color: '#4ade80', label: 'Security coverage confirmed for this leg'}, ...leg.items.slice(0, 2)] : leg.items).map((item, idx) => (
                    <View key={idx} style={styles.legItem}>
                      <DynIcon name={item.icon} size={12} color={item.color} />
                      <Text style={styles.legItemText}>{item.label}</Text>
                    </View>
                  ))}
                  {leg.status === 'open' && !isBooked && (
                    <TouchableOpacity style={styles.prebookBtn} onPress={() => handlePrebook(leg.id)} activeOpacity={0.8}>
                      <Icon name="plus-circle-outline" size={14} color={PRO_INDIGO_LIGHT} />
                      <Text style={styles.prebookBtnText}>PRE-BOOK SECURITY FOR THIS LEG</Text>
                    </TouchableOpacity>
                  )}
                  {leg.status !== 'open' && !isBooked && (
                    <TouchableOpacity style={styles.editBtn} activeOpacity={0.8}>
                      <Text style={styles.editBtnText}>
                        {leg.status === 'pending' ? 'CONFIRM' : 'EDIT'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })}
        </View>

        {/* Control Room Updates */}
        <View style={styles.ctrlCard}>
          <View style={styles.ctrlCardHeader}>
            <View style={styles.ctrlCardTitle}>
              <Icon name="antenna" size={16} color={PRO_INDIGO} />
              <Text style={styles.ctrlCardTitleText}>Control Room Updates</Text>
            </View>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
            </View>
          </View>

          {CTRL_TOGGLES.map((item, idx) => (
            <TouchableOpacity key={item.id}
              style={[styles.ctrlRow, idx === CTRL_TOGGLES.length - 1 && {borderBottomWidth: 0}]}
              onPress={() => toggleCtrl(item.id)} activeOpacity={0.9}>
              <DynIcon name={item.icon} size={18} color={item.iconColor} />
              <View style={styles.ctrlRowText}>
                <Text style={styles.ctrlRowTitle}>{item.title}</Text>
                <Text style={styles.ctrlRowSub}>{item.sub}</Text>
              </View>
              <Switch
                value={ctrlToggles[item.id]}
                onValueChange={() => toggleCtrl(item.id)}
                trackColor={{false: '#1E2D45', true: PRO_INDIGO}}
                thumbColor="#FFF"
                style={{transform: [{scaleX: 0.75}, {scaleY: 0.75}]}}
              />
            </TouchableOpacity>
          ))}
        </View>

      </ScrollView>

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 16}]}>
        <TouchableOpacity style={styles.ctaBtn} onPress={() => navigation.navigate('TripHistory')} activeOpacity={0.85}>
          <Icon name="routes" size={16} color="#FFF" />
          <Text style={styles.ctaBtnText}>CONFIRM JOURNEY & CONTINUE</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 8},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {color: PRO_INDIGO, fontSize: 12, fontWeight: '800', letterSpacing: 2, textTransform: 'uppercase'},
  stepBadge: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)'},
  stepBadgeText: {color: PRO_INDIGO, fontSize: 10, fontWeight: '800'},

  dotsRow: {flexDirection: 'row', gap: 5, paddingHorizontal: 20, paddingBottom: 12},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  dotDone: {backgroundColor: PRO_INDIGO},
  dotActive: {width: 18, borderRadius: 3, backgroundColor: PRO_INDIGO},

  content: {paddingHorizontal: 16, paddingTop: 4, gap: 16},

  uploadZone: {borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(99,102,241,0.4)', borderRadius: 20, backgroundColor: 'rgba(99,102,241,0.04)', padding: 24, alignItems: 'center'},
  uploadInner: {alignItems: 'center', gap: 4, width: '100%'},
  uploadEmoji: {fontSize: 36, marginBottom: 4},
  uploadTitle: {color: '#A5B4FC', fontSize: 12, fontWeight: '800', letterSpacing: 2, textTransform: 'uppercase'},
  uploadSub: {color: '#475569', fontSize: 12, marginTop: 2},
  uploadHint: {color: '#334155', fontSize: 11},
  uploadFilename: {color: '#F1F5F9', fontSize: 13, fontWeight: '700'},
  uploadDetected: {color: PRO_INDIGO_LIGHT, fontSize: 11, marginTop: 2},
  parseTrack: {width: '80%', height: 3, backgroundColor: '#1E2D45', borderRadius: 3, overflow: 'hidden', marginVertical: 6},
  parseBar: {width: '70%', height: '100%', backgroundColor: PRO_INDIGO, borderRadius: 3},

  sectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  sectionLabel: {color: '#475569', fontSize: 10, fontWeight: '800', letterSpacing: 2, textTransform: 'uppercase'},
  legsBadge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, backgroundColor: 'rgba(99,102,241,0.1)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.25)'},
  legsBadgeText: {color: PRO_INDIGO_LIGHT, fontSize: 9, fontWeight: '800', letterSpacing: 1},

  legCard: {backgroundColor: '#0D1929', borderWidth: 1, borderRadius: 14, overflow: 'hidden', marginBottom: 8},
  legHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, paddingBottom: 10},
  legLeft: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1},
  legRoute: {color: '#F1F5F9', fontSize: 12, fontWeight: '700'},
  legMeta: {color: '#475569', fontSize: 10, marginTop: 1},
  statusBadge: {paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, borderWidth: 1},
  statusBadgeText: {fontSize: 8, fontWeight: '800', letterSpacing: 1.2},

  legBody: {borderTopWidth: 1, borderTopColor: '#1E2D45', padding: 14, paddingTop: 10, gap: 8},
  legItem: {flexDirection: 'row', alignItems: 'center', gap: 8},
  legItemText: {color: '#94A3B8', fontSize: 10, flex: 1},
  prebookBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(99,102,241,0.25)', backgroundColor: 'rgba(99,102,241,0.08)'},
  prebookBtnText: {color: PRO_INDIGO_LIGHT, fontSize: 10, fontWeight: '800'},
  editBtn: {alignSelf: 'flex-end', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.1)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.2)'},
  editBtnText: {color: PRO_INDIGO_LIGHT, fontSize: 9, fontWeight: '800'},

  ctrlCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  ctrlCardHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  ctrlCardTitle: {flexDirection: 'row', alignItems: 'center', gap: 8},
  ctrlCardTitleText: {color: '#F1F5F9', fontSize: 11, fontWeight: '700'},
  liveBadge: {flexDirection: 'row', alignItems: 'center', gap: 5},
  liveDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ade80'},
  liveBadgeText: {color: '#4ade80', fontSize: 9, fontWeight: '800', letterSpacing: 1.5},

  ctrlRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  ctrlRowText: {flex: 1},
  ctrlRowTitle: {color: '#F1F5F9', fontSize: 12, fontWeight: '600'},
  ctrlRowSub: {color: '#475569', fontSize: 10, marginTop: 1},

  footer: {paddingHorizontal: 16, paddingTop: 12, backgroundColor: 'transparent'},
  ctaBtn: {paddingVertical: 14, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PRO_INDIGO, shadowColor: PRO_INDIGO, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.4, shadowRadius: 14, elevation: 6},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.5},
}));
