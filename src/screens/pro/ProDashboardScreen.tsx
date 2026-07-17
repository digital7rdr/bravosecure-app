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
import {useAuthStore} from '@store/authStore';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {isProActive} from '@utils/tier';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const PRO_INDIGO = '#6366F1';

const FEATURES = [
  {icon:'account-group', iconColor:'#818CF8', iconBg:'rgba(99,102,241,0.14)', title:'Dedicated CPO Team', desc:'Named agents assigned exclusively to your profile — available 24/7 for any deployment.'},
  {icon:'robot', iconColor:'#818CF8', iconBg:'rgba(99,102,241,0.14)', title:'AI Itinerary Scheduling', desc:'Upload travel plans and AI automatically schedules security coverage, route optimisation and standby slots.'},
  {icon:'alert-circle', iconColor:'#F87171', iconBg:'rgba(239,68,68,0.1)', title:'Event Risk Scoring', desc:'Every event in your itinerary is scored for threat level — AI explains why and recommends additional resources.'},
  {icon:'history', iconColor:'#4ade80', iconBg:'rgba(34,197,94,0.1)', title:'Trip History & Activity Logs', desc:'Complete audit trail of all operations, agent actions, and security incidents for compliance and review.'},
  {icon:'shield-half-full', iconColor:'#60A5FA', iconBg:'rgba(37,99,235,0.12)', title:'Perimeter Security', desc:'Full site assessment and dedicated perimeter team for high-risk venues and residences.'},
];

const QUICK_ACTIONS = [
  {icon:'shield-plus', label:'Book Protection', desc:'CPO · Armed escort · Surveillance', screen:'ZoneMap', color:'#818CF8'},
  {icon:'map-marker-radius', label:'Zone Risk Map', desc:'Live threat overlay & safe routes', screen:'ZoneMap', color:'#60A5FA'},
  {icon:'calendar-check', label:'My Assignments', desc:'Active & upcoming bookings', screen:'BookingHome', color:'#4ade80'},
] as const satisfies ReadonlyArray<{icon: string; label: string; desc: string; screen: keyof BookingStackParamList; color: string}>;

export default function ProDashboardScreen() {
  const {user} = useAuthStore();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 32}]}>

        {/* Hero */}
        <View style={styles.hero}>
          {/* Glow orbs */}
          <View style={styles.orb1} />
          <View style={styles.orb2} />
          <View style={styles.heroInner}>
            <View style={styles.proBadge}>
              <Icon name="shield-check" size={14} color={PRO_INDIGO} />
              <Text style={styles.proBadgeText}>BRAVO PRO</Text>
            </View>
            <Text style={styles.heroTitle}>
              <Text style={styles.heroTitleShimmer}>Enterprise</Text>
              {'\n'}Security Intelligence
            </Text>
            <Text style={styles.heroSub}>
              Dedicated protection for {user?.full_name ? user.full_name : 'VIP'} — powered by AI scheduling and real-time threat analysis.
            </Text>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
            </View>
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Quick Actions</Text>
          <View style={styles.actionsGrid}>
            {QUICK_ACTIONS.map(a => (
              <TouchableOpacity key={a.label}
                style={styles.actionCard}
                onPress={() => navigation.navigate(a.screen)}
                activeOpacity={0.85}>
                <View style={[styles.actionIcon, {backgroundColor: a.color + '20'}]}>
                  <DynIcon name={a.icon} size={20} color={a.color} />
                </View>
                <Text style={styles.actionLabel}>{a.label}</Text>
                <Text style={styles.actionDesc}>{a.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Feature list */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>What's Included</Text>
          {FEATURES.map(f => (
            <View key={f.title} style={styles.featCard}>
              <View style={[styles.featIcon, {backgroundColor: f.iconBg}]}>
                <DynIcon name={f.icon} size={18} color={f.iconColor} />
              </View>
              <View style={styles.featText}>
                <Text style={styles.featTitle}>{f.title}</Text>
                <Text style={styles.featDesc}>{f.desc}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Upgrade CTA (if not pro) */}
        {!isProActive(user) && (
          <View style={styles.ctaCard}>
            <Text style={styles.ctaTitle}>Upgrade to Pro</Text>
            <Text style={styles.ctaSub}>Get the full enterprise protection suite — starting from 19,000 BC/month</Text>
            <TouchableOpacity style={styles.ctaBtn} activeOpacity={0.85}>
              <Text style={styles.ctaBtnText}>View Plans →</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},
  content: {paddingHorizontal:16, gap:20},

  hero: {paddingTop:16, paddingBottom:24, position:'relative', overflow:'hidden'},
  orb1: {position:'absolute', width:200, height:200, borderRadius:100, backgroundColor:PRO_INDIGO, top:-60, left:-40, opacity:0.18},
  orb2: {position:'absolute', width:150, height:150, borderRadius:75, backgroundColor:'#4F46E5', top:20, right:-30, opacity:0.12},
  heroInner: {position:'relative', zIndex:2},
  proBadge: {flexDirection:'row', alignItems:'center', gap:6, alignSelf:'flex-start', paddingHorizontal:12, paddingVertical:6, borderRadius:99, backgroundColor:'rgba(99,102,241,0.12)', borderWidth:1, borderColor:'rgba(99,102,241,0.3)', marginBottom:14},
  proBadgeText: {color:'#A5B4FC', fontSize:11, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  heroTitle: {color:'#FFF', fontSize:28, fontWeight:'800', lineHeight:36, marginBottom:10},
  heroTitleShimmer: {color:'#A5B4FC'},
  heroSub: {color:'#94A3B8', fontSize:13, lineHeight:20, marginBottom:14},
  liveBadge: {flexDirection:'row', alignItems:'center', gap:6, alignSelf:'flex-start', paddingHorizontal:10, paddingVertical:4, borderRadius:99, backgroundColor:'rgba(34,197,94,0.1)', borderWidth:1, borderColor:'rgba(34,197,94,0.25)'},
  liveDot: {width:6, height:6, borderRadius:3, backgroundColor:'#4ade80'},
  liveBadgeText: {color:'#4ade80', fontSize:9, fontWeight:'800', letterSpacing:1.5},

  section: {gap:10},
  sectionLabel: {color:'#475569', fontSize:10, fontWeight:'800', letterSpacing:2.5, textTransform:'uppercase', marginBottom:2},
  actionsGrid: {flexDirection:'row', flexWrap:'wrap', gap:10},
  actionCard: {flex:1, minWidth:140, backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:14, padding:14, gap:8},
  actionIcon: {width:36, height:36, borderRadius:10, alignItems:'center', justifyContent:'center'},
  actionLabel: {color:'#F1F5F9', fontSize:13, fontWeight:'700'},
  actionDesc: {color:'#475569', fontSize:11, lineHeight:15},

  featCard: {flexDirection:'row', alignItems:'flex-start', gap:12, backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:14, padding:14},
  featIcon: {width:36, height:36, borderRadius:10, alignItems:'center', justifyContent:'center', flexShrink:0},
  featText: {flex:1},
  featTitle: {color:'#F1F5F9', fontSize:13, fontWeight:'700', marginBottom:4},
  featDesc: {color:'#475569', fontSize:11, lineHeight:17},

  ctaCard: {backgroundColor:'rgba(99,102,241,0.08)', borderWidth:1, borderColor:'rgba(99,102,241,0.3)', borderRadius:16, padding:20, gap:8},
  ctaTitle: {color:'#A5B4FC', fontSize:17, fontWeight:'800'},
  ctaSub: {color:'#94A3B8', fontSize:12, lineHeight:18},
  ctaBtn: {alignSelf:'flex-start', paddingHorizontal:20, paddingVertical:10, borderRadius:10, backgroundColor:PRO_INDIGO},
  ctaBtnText: {color:'#FFF', fontSize:13, fontWeight:'800', letterSpacing:0.3},
}));
