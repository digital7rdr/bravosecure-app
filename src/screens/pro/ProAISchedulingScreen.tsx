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

export default function ProAISchedulingScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  // AI scheduling builds the coverage plan from an uploaded itinerary. With
  // no itinerary loaded there's no schedule to show — guide the user to the
  // itinerary upload (the real entry point) instead of a simulated calendar.
  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>AI Scheduling</Text>
        </View>
      </View>

      <View style={styles.emptyWrap}>
        <View style={styles.emptyIcon}>
          <Icon name="calendar-clock" size={40} color="#6366F1" />
        </View>
        <Text style={styles.emptyTitle}>No schedule yet</Text>
        <Text style={styles.emptySub}>
          Upload a travel itinerary and the AI engine builds a CPO coverage
          plan — scheduling agents, optimising routes and flagging risk per event.
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

  aiBanner: {flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(99,102,241,0.08)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(99,102,241,0.25)', padding: 14},
  aiDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E', flexShrink: 0},
  aiBannerText: {flex: 1},
  aiTitle: {fontSize: 10, fontWeight: '700', color: '#A5B4FC', letterSpacing: 1.5, textTransform: 'uppercase'},
  aiSub: {fontSize: 12, color: '#64748B', lineHeight: 17, marginTop: 2},

  viewToggle: {flexDirection: 'row', backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 4, gap: 4},
  viewBtn: {flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center'},
  viewBtnActive: {backgroundColor: '#6366F1'},
  viewBtnText: {fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: '#64748B'},
  viewBtnTextActive: {color: '#FFF'},

  calendarCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  calRow: {flexDirection: 'row'},
  calTimeSpacer: {width: 40},
  calDayHead: {flex: 1, alignItems: 'center', paddingVertical: 6},
  calDayText: {fontSize: 8, fontWeight: '700', color: '#64748B', textAlign: 'center'},
  calDayToday: {color: '#6366F1'},
  calScroll: {maxHeight: 220},
  calTime: {width: 40, paddingTop: 2, paddingLeft: 6, alignItems: 'flex-start'},
  calTimeText: {fontSize: 9, fontWeight: '600', color: '#334155'},
  calCell: {flex: 1, minHeight: 36, borderLeftWidth: 1, borderTopWidth: 1, borderColor: 'rgba(30,45,69,0.5)'},
  calEvent: {position: 'absolute', top: 2, left: 1, right: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2, borderLeftWidth: 2},
  calEventText: {fontSize: 7, fontWeight: '700'},

  listCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  listRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12},
  listBorder: {borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  listAccent: {width: 3, height: 36, borderRadius: 2, flexShrink: 0},
  listInfo: {flex: 1},
  listTitle: {fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  listMeta: {fontSize: 10, color: '#64748B', marginTop: 2},
  listBadge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  listBadgeText: {fontSize: 9, fontWeight: '700'},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: '#6366F1', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.5},
}));
