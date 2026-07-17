import React, {useState} from 'react';
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
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

type TabKey = 'CPOs' | 'Vehicles' | 'Resources';

// Team + vehicle assignment happens at dispatch (ops side). Until a mission
// is assigned there's nothing to show here — honest empty states per tab.
type Cpo = {
  initials: string; gradFrom: string;
  certs: {label: string; color: string; bg: string; border: string}[];
  name: string; role: string; missions: string; rating: string;
};
type Vehicle = {
  emoji: string; label: string; labelColor: string; labelBg: string; labelBorder: string;
  name: string; plate: string; stats: {v: string; l: string; c: string}[];
};
const CPOS: Cpo[] = [];
const VEHICLES: Vehicle[] = [];

export default function ProAssignedTeamScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabKey>('CPOs');
  const [assigned, setAssigned] = useState<Record<string, boolean>>({});

  const tabs: TabKey[] = ['CPOs', 'Vehicles', 'Resources'];

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Assigned Team</Text>
        </View>
      </View>


      {/* Tabs */}
      <View style={styles.tabBar}>
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tabBtn, activeTab === tab && styles.tabBtnActive]}
            onPress={() => setActiveTab(tab)}
            activeOpacity={0.8}>
            <Text style={[styles.tabBtnText, activeTab === tab && styles.tabBtnTextActive]}>{tab}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {activeTab === 'CPOs' && CPOS.length === 0 && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Your protection team is assigned by Ops once a mission is confirmed.</Text>
          </View>
        )}
        {activeTab === 'Vehicles' && VEHICLES.length === 0 && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Vehicles are allocated by Ops at mission dispatch.</Text>
          </View>
        )}

        {activeTab === 'CPOs' && CPOS.map(cpo => {
          const isAssigned = assigned[cpo.initials];
          return (
            <View key={cpo.initials} style={[styles.cpoCard, isAssigned && styles.cpoCardAssigned]}>
              <View style={styles.cpoHeader}>
                <View style={[styles.cpoAvatar, {backgroundColor: cpo.gradFrom}]}>
                  <Text style={styles.cpoAvatarText}>{cpo.initials}</Text>
                </View>
                <View style={styles.cpoInfo}>
                  <View style={styles.certRow}>
                    {cpo.certs.map((cert, ci) => (
                      <View key={ci} style={[styles.certBadge, {backgroundColor: cert.bg, borderColor: cert.border}]}>
                        <Text style={[styles.certText, {color: cert.color}]}>{cert.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={styles.cpoName}>{cpo.name}</Text>
                  <Text style={styles.cpoRole}>{cpo.role}</Text>
                </View>
                <View style={styles.availRow}>
                  <View style={styles.availDot} />
                  <Text style={styles.availText}>AVAIL</Text>
                </View>
              </View>
              <View style={styles.cpoStats}>
                <View style={styles.cpoStatItem}>
                  <Text style={styles.cpoStatValue}>{cpo.missions}</Text>
                  <Text style={styles.cpoStatLabel}>MISSIONS</Text>
                </View>
                <View style={styles.cpoStatItem}>
                  <Text style={styles.cpoStatValue}>{cpo.rating}</Text>
                  <Text style={styles.cpoStatLabel}>RATING</Text>
                </View>
              </View>
              <TouchableOpacity
                style={[styles.assignBtn, isAssigned && styles.assignBtnActive]}
                onPress={() => setAssigned(prev => ({...prev, [cpo.initials]: !prev[cpo.initials]}))}
                activeOpacity={0.85}>
                <Text style={[styles.assignBtnText, isAssigned && styles.assignBtnTextActive]}>
                  {isAssigned ? 'ASSIGNED ✓' : '+ ASSIGN'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}

        {activeTab === 'Vehicles' && VEHICLES.map((v, vi) => (
          <View key={vi} style={styles.cpoCard}>
            <View style={styles.vehicleHeader}>
              <View style={styles.vehicleIcon}>
                <Text style={{fontSize: 22}}>{v.emoji}</Text>
              </View>
              <View style={styles.cpoInfo}>
                <View style={[styles.certBadge, {backgroundColor: v.labelBg, borderColor: v.labelBorder}]}>
                  <Text style={[styles.certText, {color: v.labelColor}]}>{v.label}</Text>
                </View>
                <Text style={styles.cpoName}>{v.name}</Text>
                <Text style={styles.cpoRole}>{v.plate}</Text>
              </View>
              <View style={styles.availRow}>
                <View style={styles.availDot} />
                <Text style={styles.availText}>AVAIL</Text>
              </View>
            </View>
            <View style={styles.vehicleStats}>
              {v.stats.map((s, si) => (
                <View key={si} style={styles.vehicleStatItem}>
                  <Text style={[styles.vehicleStatValue, {color: s.c}]}>{s.v}</Text>
                  <Text style={styles.cpoStatLabel}>{s.l}</Text>
                </View>
              ))}
            </View>
          </View>
        ))}

        {activeTab === 'Resources' && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Comms equipment, medical kit, and tactical gear will be allocated upon mission confirmation.</Text>
          </View>
        )}

      </ScrollView>

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 20}]}>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('ProLiveMission')}
          activeOpacity={0.85}>
          <Text style={styles.ctaBtnText}>CONFIRM TEAM → MISSION MONITORING</Text>
          <Icon name="arrow-right" size={16} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

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

  tabBar: {flexDirection: 'row', backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 4, gap: 4, marginHorizontal: 16, marginBottom: 12},
  tabBtn: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center'},
  tabBtnActive: {backgroundColor: '#6366F1'},
  tabBtnText: {fontSize: 12, fontWeight: '700', color: '#64748B'},
  tabBtnTextActive: {color: '#FFF'},

  content: {paddingHorizontal: 16, gap: 12},

  cpoCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', padding: 14},
  cpoCardAssigned: {borderColor: '#6366F1', backgroundColor: 'rgba(99,102,241,0.06)'},
  cpoHeader: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12},
  cpoAvatar: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  cpoAvatarText: {fontSize: 14, fontWeight: '700', color: '#FFF'},
  cpoInfo: {flex: 1},
  certRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4},
  certBadge: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, borderWidth: 1},
  certText: {fontSize: 9, fontWeight: '800', letterSpacing: 0.5},
  cpoName: {fontSize: 14, fontWeight: '700', color: '#F1F5F9'},
  cpoRole: {fontSize: 10, color: '#64748B', marginTop: 2},
  availRow: {flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0},
  availDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#22C55E'},
  availText: {fontSize: 10, fontWeight: '700', color: '#4ADE80'},
  cpoStats: {flexDirection: 'row', gap: 8, marginBottom: 12},
  cpoStatItem: {flex: 1, backgroundColor: '#07111F', borderRadius: 8, borderWidth: 1, borderColor: '#1E2D45', padding: 8, alignItems: 'center'},
  cpoStatValue: {fontSize: 16, fontWeight: '800', color: '#A5B4FC'},
  cpoStatLabel: {fontSize: 9, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 2},
  assignBtn: {width: '100%', paddingVertical: 10, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#1E2D45'},
  assignBtnActive: {backgroundColor: '#6366F1', borderColor: '#6366F1'},
  assignBtnText: {fontSize: 11, fontWeight: '700', letterSpacing: 1.5, color: '#A5B4FC'},
  assignBtnTextActive: {color: '#FFF'},

  vehicleHeader: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12},
  vehicleIcon: {width: 44, height: 44, borderRadius: 12, backgroundColor: '#07111F', borderWidth: 1, borderColor: '#1E2D45', alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  vehicleStats: {flexDirection: 'row', gap: 8},
  vehicleStatItem: {flex: 1, backgroundColor: '#07111F', borderRadius: 8, borderWidth: 1, borderColor: '#1E2D45', padding: 8, alignItems: 'center'},
  vehicleStatValue: {fontSize: 12, fontWeight: '700'},

  resourcesCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', padding: 20, alignItems: 'center'},
  resourcesText: {fontSize: 13, color: '#64748B', textAlign: 'center', lineHeight: 20},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: '#6366F1', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.3},
}));
