import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'NewsHub'>;

const WIRE_PREVIEW = [
  {level: 'CRIT', color: '#FF3B30', bg: 'rgba(255,59,48,0.15)', border: 'rgba(255,59,48,0.3)', headline: 'Ballistic alert — Red Sea corridor ACTIVE'},
  {level: 'HIGH', color: '#FFB800', bg: 'rgba(255,184,0,0.12)', border: 'rgba(255,184,0,0.3)', headline: 'Riyadh protest zone — 400+ crowd, police deployed'},
];

const FEED_PREVIEW = [
  {region: 'UAE', headline: 'UAE DIFC records highest Q1 volume in financial services'},
  {region: 'KSA', headline: 'Saudi Aramco Q1 earnings beat forecast on energy demand'},
];

interface SectionCardProps {
  icon: string;
  iconBg: string;
  iconBorder: string;
  iconColor: string;
  title: string;
  sub: string;
  badge?: {label: string; color: string; bg: string; border: string};
  onPress: () => void;
  browseLabel: string;
  children?: React.ReactNode;
}

function SectionCard({icon, iconBg, iconBorder, iconColor, title, sub, badge, onPress, browseLabel, children}: SectionCardProps) {
  return (
    <TouchableOpacity style={styles.sectionCard} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.sectionCardBody}>
        <View style={styles.sectionCardHeader}>
          <View style={styles.sectionLeft}>
            <View style={[styles.sectionIconWrap, {backgroundColor: iconBg, borderColor: iconBorder}]}>
              <Icon name={icon} size={16} color={iconColor} />
            </View>
            <View>
              <Text style={styles.sectionTitle}>{title}</Text>
              <Text style={styles.sectionSub}>{sub}</Text>
            </View>
          </View>
          {badge && (
            <View style={[styles.badgeWrap, {backgroundColor: badge.bg, borderColor: badge.border}]}>
              <Text style={[styles.badgeText, {color: badge.color}]}>{badge.label}</Text>
            </View>
          )}
        </View>
        {children}
      </View>
      <View style={styles.browseBtnRow}>
        <Text style={styles.browseLabel}>{browseLabel}</Text>
        <Icon name="chevron-right" size={16} color="#60A5FA" />
      </View>
    </TouchableOpacity>
  );
}

export default function NewsHubScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} activeOpacity={0.7} onPress={() => navigation.goBack()}>
          <Icon name="chevron-left" size={22} color="#B8C7E0" />
        </TouchableOpacity>
        <View style={{flex: 1}}>
          <Text style={styles.headerEyebrow}>Bravo Messenger</Text>
          <Text style={styles.headerTitle}>News Feed</Text>
        </View>
        <TouchableOpacity style={styles.tuneBtn} activeOpacity={0.7} onPress={() => navigation.navigate('NewsPreferences')}>
          <Icon name="tune-variant" size={20} color="#94A3B8" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 120}]}>

        {/* Bravo Intel Feed */}
        <SectionCard
          icon="earth"
          iconBg="rgba(37,99,235,0.15)"
          iconBorder="rgba(37,99,235,0.3)"
          iconColor="#60A5FA"
          title="Bravo Intel"
          sub="Global intelligence · OSINT · Signals"
          badge={{label: 'LIVE', color: '#4ade80', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.3)'}}
          onPress={() => navigation.navigate('IntelFeed')}
          browseLabel="OPEN INTEL FEED">
          <View style={styles.miniList}>
            {WIRE_PREVIEW.map((item, idx) => (
              <View key={idx} style={[styles.miniItem, idx === WIRE_PREVIEW.length - 1 && {borderBottomWidth: 0}]}>
                <View style={[styles.miniLevelBadge, {backgroundColor: item.bg, borderColor: item.border}]}>
                  <Text style={[styles.miniLevelText, {color: item.color}]}>{item.level}</Text>
                </View>
                <Text style={styles.miniHeadline} numberOfLines={1}>{item.headline}</Text>
              </View>
            ))}
          </View>
        </SectionCard>

        {/* My Feed */}
        <SectionCard
          icon="tune-variant"
          iconBg="rgba(37,99,235,0.15)"
          iconBorder="rgba(37,99,235,0.3)"
          iconColor="#60A5FA"
          title="My Feed"
          sub="Personalised by your preferences"
          onPress={() => navigation.navigate('NewsFeed')}
          browseLabel="OPEN MY FEED">
          {/* Preference tags */}
          <View style={styles.prefTags}>
            {['UAE', 'KSA', 'GLOBAL', 'Business', 'Finance', 'Security'].map(tag => (
              <View key={tag} style={styles.prefTag}>
                <Text style={styles.prefTagText}>{tag}</Text>
              </View>
            ))}
          </View>
          <View style={styles.miniList}>
            {FEED_PREVIEW.map((item, idx) => (
              <View key={idx} style={[styles.miniItem, idx === FEED_PREVIEW.length - 1 && {borderBottomWidth: 0}]}>
                <View style={styles.regionBadge}>
                  <Text style={styles.regionBadgeText}>{item.region}</Text>
                </View>
                <Text style={styles.miniHeadline} numberOfLines={1}>{item.headline}</Text>
              </View>
            ))}
          </View>
        </SectionCard>

        {/* B-91 M1 R8 — the Advertisements and Bravo Services sections and
            the Virtual Bodyguard CTA are gone: the News Feed carries news
            and intelligence ONLY (spec p.11). Advertising lives solely in
            the pinned sponsored slot on the Chat list; other products are
            reached via Profile → Switch Dashboard. */}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1E2D45', backgroundColor: Colors.background},
  headerEyebrow: {color: '#334155', fontSize: 9, fontWeight: '700', letterSpacing: 3, textTransform: 'uppercase'},
  headerTitle: {color: '#F1F5F9', fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginTop: 2},
  tuneBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 4},

  content: {paddingHorizontal: 16, paddingTop: 16, gap: 12},

  sectionCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  sectionCardBody: {paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12},
  sectionCardHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  sectionLeft: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1},
  sectionIconWrap: {width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  sectionTitle: {color: '#F1F5F9', fontSize: 13, fontWeight: '800'},
  sectionSub: {color: '#475569', fontSize: 10, marginTop: 1},
  badgeWrap: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, borderWidth: 1},
  badgeText: {fontSize: 9, fontWeight: '800', letterSpacing: 1},

  miniList: {gap: 0},
  miniItem: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  miniLevelBadge: {paddingHorizontal: 4, paddingVertical: 1, borderRadius: 2, borderWidth: 1, flexShrink: 0},
  miniLevelText: {fontSize: 7, fontWeight: '800', letterSpacing: 1},
  miniHeadline: {color: '#CBD5E1', fontSize: 11, fontWeight: '600', flex: 1},

  prefTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8},
  prefTag: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, backgroundColor: 'rgba(37,99,235,0.1)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.25)'},
  prefTagText: {color: '#93C5FD', fontSize: 9, fontWeight: '700', letterSpacing: 0.4},
  regionBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(37,99,235,0.15)', flexShrink: 0},
  regionBadgeText: {color: '#93C5FD', fontSize: 8, fontWeight: '800'},

  cardDesc: {color: '#475569', fontSize: 11, lineHeight: 17},

  browseBtnRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: '#1E2D45'},
  browseLabel: {color: '#60A5FA', fontSize: 11, fontWeight: '800', letterSpacing: 0.4},

}));
