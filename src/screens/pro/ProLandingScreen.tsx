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
import {DynIcon} from '@components/DynIcon';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {PRO_MONTHLY_BC} from '@utils/tier';

const PRO = '#6366F1';

const FEATURES = [
  {icon: 'account-group', color: '#818cf8', bg: 'rgba(99,102,241,0.14)', title: 'Dedicated CPO Team', sub: 'Named agents assigned exclusively to your profile — available 24/7 for any deployment.'},
  {icon: 'auto-fix', color: '#818cf8', bg: 'rgba(99,102,241,0.14)', title: 'AI Itinerary Scheduling', sub: 'Upload travel plans and AI automatically schedules security coverage, route optimisation and standby slots.'},
  {icon: 'alert-circle', color: '#f87171', bg: 'rgba(239,68,68,0.1)', title: 'Event Risk Scoring', sub: 'Every event in your itinerary is scored for threat level — AI explains why and recommends additional resources.'},
  {icon: 'history', color: '#4ade80', bg: 'rgba(34,197,94,0.1)', title: 'Trip History & Activity Logs', sub: 'Complete audit trail of all operations, agent actions, and security incidents for compliance and review.'},
];

// Single Bravo Pro subscription — everything is included. Priced in Bravo
// Credits per 30-day period (matches the server + ProPaywall).
const PRO_PERKS = [
  'Dedicated CPO team · 24/7 standby',
  'AI itinerary scheduling + event risk scoring',
  'Department Channels (E2E encrypted)',
  'Trip history & compliance logs',
  'AES-256 encrypted comms · predictive threat intel',
];

export default function ProLandingScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <View style={styles.liveRow}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>Live</Text>
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 100}]}
        showsVerticalScrollIndicator={false}>

        {/* Hero */}
        <View style={styles.hero}>
          {/* Glow orbs */}
          <View style={[styles.orb, {width: 200, height: 200, backgroundColor: PRO, top: -60, left: -40}]} />
          <View style={[styles.orb, {width: 150, height: 150, backgroundColor: '#4F46E5', top: 20, right: -30, opacity: 0.2}]} />

          <View style={styles.heroContent}>
            <View style={styles.proBadge}>
              <Icon name="shield-check" size={14} color={PRO} />
              <Text style={styles.proBadgeText}>Bravo Pro</Text>
            </View>

            <Text style={styles.heroTitle}>
              <Text style={styles.shimmerText}>Enterprise{'\n'}</Text>
              <Text style={styles.heroTitleWhite}>Security Intelligence</Text>
            </Text>
            <Text style={styles.heroSub}>
              Dedicated protection for VIP individuals and corporate clients — powered by AI scheduling and real-time threat analysis.
            </Text>
          </View>
        </View>

        {/* Feature cards */}
        <View style={styles.featureList}>
          {FEATURES.map((f, i) => (
            <View key={i} style={styles.featCard}>
              <View style={[styles.featIcon, {backgroundColor: f.bg}]}>
                <DynIcon name={f.icon} size={18} color={f.color} />
              </View>
              <View style={{flex: 1}}>
                <Text style={styles.featTitle}>{f.title}</Text>
                <Text style={styles.featSub}>{f.sub}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Single subscription */}
        <View style={styles.plansSection}>
          <View style={styles.planHeaderRow}>
            <Text style={styles.planSectionLabel}>Subscription</Text>
            <Text style={styles.planBilled}>billed monthly</Text>
          </View>

          <View style={[styles.planCard, styles.planCardPopular]}>
            <View style={styles.planHeaderCard}>
              <View style={styles.planNameRow}>
                <View style={[styles.planEmoji, {backgroundColor: 'rgba(99,102,241,0.12)'}]}>
                  <Icon name="shield-star" size={20} color={PRO} />
                </View>
                <View>
                  <Text style={[styles.planName, {color: '#a5b4fc'}]}>Bravo Pro</Text>
                  <Text style={styles.planTier}>ALL FEATURES INCLUDED</Text>
                </View>
              </View>
              <View style={{alignItems: 'flex-end'}}>
                <Text style={[styles.planPrice, {color: '#a5b4fc'}]}>{PRO_MONTHLY_BC.toLocaleString()} BC</Text>
                <Text style={styles.planPeriod}>/month</Text>
              </View>
            </View>

            <View style={[styles.planDivider, {backgroundColor: 'rgba(99,102,241,0.3)'}]} />

            <View style={styles.planPerks}>
              {PRO_PERKS.map((perk, pi) => (
                <View key={pi} style={styles.perkRow}>
                  <Icon name="check" size={13} color={PRO} />
                  <Text style={[styles.perkText, {color: '#CBD5E1'}]}>{perk}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 12}]}>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('ProPaywall' as never)}
          activeOpacity={0.85}>
          <Icon name="shield-star" size={20} color="#FFF" />
          <Text style={styles.ctaBtnText}>Subscribe to Bravo Pro</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, zIndex: 2},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  liveRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  liveDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#34d399'},
  liveText: {fontSize: 10, fontWeight: '700', color: '#34d399', textTransform: 'uppercase', letterSpacing: 2},

  scroll: {paddingBottom: 20},

  hero: {position: 'relative', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, overflow: 'hidden'},
  orb: {position: 'absolute', borderRadius: 999, opacity: 0.3},
  heroContent: {zIndex: 1},
  proBadge: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, alignSelf: 'flex-start', marginBottom: 16},
  proBadgeText: {fontSize: 11, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', color: '#a5b4fc'},
  heroTitle: {fontSize: 30, fontWeight: '800', lineHeight: 36, marginBottom: 8},
  shimmerText: {color: '#a5b4fc'},
  heroTitleWhite: {color: '#FFF'},
  heroSub: {fontSize: 14, color: '#94A3B8', lineHeight: 20},

  featureList: {paddingHorizontal: 16, gap: 10, marginBottom: 24},
  featCard: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 16, padding: 14},
  featIcon: {width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  featTitle: {fontSize: 14, fontWeight: '700', color: '#F1F5F9', marginBottom: 2},
  featSub: {fontSize: 12, color: '#64748B', lineHeight: 17},

  divider: {height: 1, backgroundColor: '#1E2D45', marginHorizontal: 16, marginBottom: 24},

  plansSection: {paddingHorizontal: 16},
  planHeaderRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16},
  planSectionLabel: {fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#64748B'},
  planBilled: {fontSize: 10, color: '#475569'},
  planList: {gap: 12},

  planCard: {backgroundColor: '#0D1929', borderWidth: 1.5, borderColor: '#1E2D45', borderRadius: 20, padding: 18},
  planCardPopular: {
    borderColor: PRO,
    backgroundColor: 'rgba(99,102,241,0.06)',
    shadowColor: PRO,
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.12,
    shadowRadius: 16,
  },
  popularBadge: {
    position: 'absolute',
    top: -11,
    alignSelf: 'center',
    backgroundColor: PRO,
    paddingHorizontal: 12,
    paddingVertical: 3,
    borderRadius: 99,
  },
  popularBadgeText: {fontSize: 9, fontWeight: '800', color: '#FFF', letterSpacing: 1},

  planHeaderCard: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12},
  planNameRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  planEmoji: {width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  planName: {fontSize: 14, fontWeight: '700'},
  planTier: {fontSize: 10, color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 2},
  planPrice: {fontSize: 14, fontWeight: '800'},
  planPeriod: {fontSize: 10, color: '#64748B', textAlign: 'right', marginTop: 1},

  planDivider: {height: 1, backgroundColor: '#1E2D45', marginBottom: 12},
  planPerks: {gap: 6},
  perkRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  perkText: {fontSize: 11, color: '#94A3B8'},

  enterpriseNote: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 12, backgroundColor: 'rgba(99,102,241,0.06)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', borderRadius: 12, padding: 14},
  enterpriseText: {flex: 1, fontSize: 11, color: '#94A3B8', lineHeight: 17},

  footer: {paddingHorizontal: 20, paddingTop: 12, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: PRO, borderRadius: 12, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaBtnText: {fontSize: 14, fontWeight: '700', color: '#FFF', letterSpacing: 1},
}));
