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
import {DynIcon} from '@components/DynIcon';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';

export default function ProLiveMissionScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  // Live mission monitoring streams from the assigned mission's telemetry.
  // There is no active mission to monitor outside a live deployment — show
  // an honest empty state rather than a simulated map/feed. When a mission
  // is live, the booking flow routes to LiveTrackingScreen (real telemetry).
  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Mission Monitoring</Text>
        </View>
      </View>

      <View style={styles.emptyWrap}>
        <View style={styles.emptyIcon}>
          <DynIcon name="map-marker-radius" size={40} color="#6366F1" />
        </View>
        <Text style={styles.emptyTitle}>No active mission</Text>
        <Text style={styles.emptySub}>
          Live asset tracking, intel and encrypted comms appear here while a
          mission is in progress. Start or open a booking to monitor it live.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 32},
  emptyIcon: {width: 84, height: 84, borderRadius: 26, backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.25)', alignItems: 'center', justifyContent: 'center'},
  emptyTitle: {fontSize: 18, fontWeight: '800', color: '#F1F5F9'},
  emptySub: {fontSize: 13, color: '#94A3B8', textAlign: 'center', lineHeight: 19},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 8},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', color: '#6366F1', letterSpacing: 1.5, textTransform: 'uppercase'},
  headerRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  liveBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(239,68,68,0.15)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)'},
  liveDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#F87171'},
  liveText: {fontSize: 10, fontWeight: '700', color: '#F87171'},
  stepBadge: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)'},
  stepText: {fontSize: 10, fontWeight: '700', color: '#6366F1'},

  dots: {flexDirection: 'row', gap: 5, alignItems: 'center', paddingHorizontal: 20, paddingBottom: 6},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  dotDone: {backgroundColor: '#6366F1'},
  dotActive: {width: 18, borderRadius: 3, backgroundColor: '#6366F1'},

  trackedRow: {paddingHorizontal: 16, paddingBottom: 6},
  trackedBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)'},
  trackedDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ADE80'},
  trackedText: {fontSize: 10, fontWeight: '700', color: '#4ADE80'},

  mapContainer: {height: 160, marginHorizontal: 16, marginBottom: 8, borderRadius: 12, backgroundColor: '#06101E', borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden', position: 'relative'},
  gridH: {position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(99,102,241,0.06)'},
  gridV: {position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(99,102,241,0.06)'},
  routeLabel: {position: 'absolute', right: 12, top: 10},
  routeLabelText: {fontSize: 8, fontWeight: '700', color: '#A5B4FC'},
  asset: {position: 'absolute', width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: '#FFF'},
  mapStatusBanner: {position: 'absolute', bottom: 8, left: 8, right: 8, backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: 8, borderWidth: 1, borderColor: 'rgba(34,197,94,0.3)', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6},
  mapStatusDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ADE80'},
  mapStatusText: {fontSize: 10, fontWeight: '700', color: '#4ADE80'},
  mapLegend: {position: 'absolute', top: 8, right: 8, gap: 2},
  legendItem: {flexDirection: 'row', alignItems: 'center', gap: 4},
  legendDot: {width: 6, height: 6, borderRadius: 3},
  legendText: {fontSize: 7, color: '#64748B'},

  tabBar: {flexDirection: 'row', backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 4, gap: 4, marginHorizontal: 16, marginBottom: 8},
  tabBtn: {flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center'},
  tabBtnActive: {backgroundColor: '#6366F1'},
  tabBtnText: {fontSize: 11, fontWeight: '700', color: '#64748B', letterSpacing: 0.5},
  tabBtnTextActive: {color: '#FFF'},

  content: {paddingHorizontal: 16, gap: 8},

  assetRow: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, padding: 12},
  assetDot: {width: 8, height: 8, borderRadius: 4, flexShrink: 0},
  assetInfo: {flex: 1},
  assetTitle: {fontSize: 12, fontWeight: '700', color: '#F1F5F9'},
  assetSub: {fontSize: 10, color: '#64748B', marginTop: 1},
  assetStatus: {fontSize: 10, fontWeight: '700', flexShrink: 0},

  sectionLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 4},
  timelineCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 12},
  tlRow: {flexDirection: 'row', gap: 12},
  tlLine: {alignItems: 'center', width: 12},
  tlDot: {width: 8, height: 8, borderRadius: 4},
  tlStem: {width: 1, flex: 1, backgroundColor: '#1E2D45', marginVertical: 3},
  tlContent: {flex: 1, paddingBottom: 16},
  tlText: {fontSize: 11, fontWeight: '700', color: '#E2E8F0'},
  tlTime: {fontSize: 10, color: '#334155', marginTop: 2},

  intelCard: {borderRadius: 12, borderWidth: 1, padding: 12},
  intelHeader: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6},
  intelLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, flex: 1},
  intelTime: {fontSize: 10, color: '#64748B'},
  intelText: {fontSize: 12, color: '#CBD5E1', lineHeight: 18},

  commsCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 12},
  commsHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12},
  commsHeaderText: {flex: 1, fontSize: 12, fontWeight: '700', color: '#CBD5E1'},
  commsDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ADE80'},
  messageList: {gap: 8},
  msgWrap: {alignItems: 'flex-start'},
  msgWrapRight: {alignItems: 'flex-end'},
  msgBubble: {maxWidth: '80%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8},
  msgBubbleRight: {backgroundColor: '#6366F1', borderTopRightRadius: 4},
  msgBubbleLeft: {backgroundColor: '#1E2D45', borderTopLeftRadius: 4},
  msgText: {fontSize: 12, color: '#94A3B8', lineHeight: 17},
  msgTextRight: {color: '#FFF'},
  msgMeta: {fontSize: 9, color: '#334155', marginTop: 3},
}));
