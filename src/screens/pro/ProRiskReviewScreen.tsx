import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

// Risk review is generated from an uploaded itinerary's events. With no
// itinerary analysed there are no events to review — honest empty state.
export default function ProRiskReviewScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Risk Review</Text>
        </View>
      </View>

      <View style={styles.emptyWrap}>
        <View style={styles.emptyIcon}>
          <Icon name="shield-search" size={40} color="#6366F1" />
        </View>
        <Text style={styles.emptyTitle}>No events to review</Text>
        <Text style={styles.emptySub}>
          Upload a travel itinerary and the AI engine scores each event for
          threat level, flags risks, and recommends coverage here.
        </Text>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('ItineraryUpload')}
          activeOpacity={0.85}>
          <Icon name="upload" size={16} color="#FFF" />
          <Text style={styles.ctaBtnText}>Upload itinerary</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32},
  emptyIcon: {width: 84, height: 84, borderRadius: 26, backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.25)', alignItems: 'center', justifyContent: 'center'},
  emptyTitle: {fontSize: 18, fontWeight: '800', color: '#F1F5F9'},
  emptySub: {fontSize: 13, color: '#94A3B8', textAlign: 'center', lineHeight: 19, marginBottom: 8},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 8},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', color: '#6366F1', letterSpacing: 1.5, textTransform: 'uppercase'},
  stepBadge: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)'},
  stepText: {fontSize: 10, fontWeight: '700', color: '#6366F1'},

  dots: {flexDirection: 'row', gap: 5, alignItems: 'center', paddingHorizontal: 20, paddingBottom: 8},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  dotDone: {backgroundColor: '#6366F1'},
  dotActive: {width: 18, borderRadius: 3, backgroundColor: '#6366F1'},

  content: {paddingHorizontal: 16, paddingTop: 8, gap: 16},

  statsRow: {flexDirection: 'row', gap: 8},
  statCard: {flex: 1, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 12, alignItems: 'center'},
  statValue: {fontSize: 20, fontWeight: '800', color: '#F1F5F9'},
  statLabel: {fontSize: 9, fontWeight: '700', color: '#64748B', letterSpacing: 1.5, marginTop: 2, textTransform: 'uppercase'},

  sectionLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5},

  eventCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', borderLeftWidth: 3, overflow: 'hidden'},
  eventHeader: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: 14, paddingBottom: 8},
  eventHeaderLeft: {flex: 1},
  eventHeaderRight: {flexDirection: 'row', alignItems: 'center', gap: 6},
  eventTitle: {fontSize: 12, fontWeight: '700', color: '#F1F5F9'},
  eventDate: {fontSize: 10, color: '#64748B', marginTop: 2},
  riskBadge: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, borderWidth: 1},
  riskBadgeText: {fontSize: 9, fontWeight: '700'},
  riskBarWrap: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 12},
  riskBarBg: {flex: 1, height: 6, borderRadius: 99, backgroundColor: '#1E2D45', overflow: 'hidden'},
  riskBarFill: {height: '100%', borderRadius: 99},
  riskScore: {fontSize: 10, fontWeight: '700', minWidth: 40, textAlign: 'right'},

  expandedBody: {borderTopWidth: 1, paddingHorizontal: 14, paddingVertical: 12, gap: 8},
  factorsLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.5},
  factorsList: {gap: 4},
  factorRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  factorDot: {width: 6, height: 6, borderRadius: 3, flexShrink: 0},
  factorText: {fontSize: 11, color: '#CBD5E1'},
  aiRec: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4},
  aiRecLabel: {fontSize: 9, fontWeight: '700', color: '#6366F1', letterSpacing: 1.5, textTransform: 'uppercase'},
  aiRecText: {fontSize: 11, color: '#CBD5E1', marginLeft: 18},
  actionRow: {flexDirection: 'row', gap: 8, marginTop: 4},
  approveBtn: {flex: 1, paddingVertical: 8, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(34,197,94,0.12)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)'},
  approveBtnText: {fontSize: 11, fontWeight: '700', color: '#4ADE80'},
  escalateBtn: {flex: 1, paddingVertical: 8, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(239,68,68,0.1)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)'},
  escalateBtnText: {fontSize: 11, fontWeight: '700', color: '#FCA5A5'},
  statusConfirm: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10},
  statusApproved: {backgroundColor: 'rgba(34,197,94,0.08)'},
  statusEscalated: {backgroundColor: 'rgba(239,68,68,0.08)'},
  statusText: {fontSize: 12, fontWeight: '700'},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: '#6366F1', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.5},
}));
