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

const PRO = '#6366F1';

const TIERS = [
  {id: 'silver', emoji: '🥈', label: 'Silver Retainer', price: '19,000 BC', priceColor: '#94A3B8', iconBg: 'rgba(148,163,184,0.12)', details: null},
  {id: 'gold', emoji: '🥇', label: 'Gold Retainer', price: '42,000 BC', priceColor: '#F59E0B', iconBg: 'rgba(245,158,11,0.15)', details: ['2 CPOs', '2 Vehicles', '180 hrs/mo', '24 / 7']},
  {id: 'platinum', emoji: '💎', label: 'Platinum Retainer', price: '95,000 BC', priceColor: '#A5B4FC', iconBg: 'rgba(99,102,241,0.12)', details: null},
];

const INCLUSIONS = [
  'AI calendar scheduling & Itinerary sync',
  'Dedicated ops room handler & risk analyst',
  'Predictive threat intelligence · AES-256 comms',
];

export default function ProRetainersScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<string>('gold');

  const tierColor = (id: string) => id === 'gold' ? '#F59E0B' : id === 'silver' ? '#94A3B8' : '#A5B4FC';

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Bravo Pro Retainers</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        <Text style={styles.subtitle}>Choose your permanent security retainer tier. All plans include a dedicated ops room handler and AI-assisted scheduling.</Text>

        {/* Tiers */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Select Retainer Tier</Text>
          <View style={styles.tierList}>
            {TIERS.map(tier => {
              const isSelected = selected === tier.id;
              const color = tierColor(tier.id);
              return (
                <TouchableOpacity
                  key={tier.id}
                  style={[styles.tierCard, isSelected && {borderColor: color, backgroundColor: `${color}14`}]}
                  onPress={() => setSelected(tier.id)}
                  activeOpacity={0.85}>
                  <View style={styles.tierRow}>
                    <View style={styles.tierLeft}>
                      <View style={[styles.tierIcon, {backgroundColor: tier.iconBg}]}>
                        <Text style={styles.tierEmoji}>{tier.emoji}</Text>
                      </View>
                      <View>
                        <Text style={[styles.tierLabel, isSelected && {color}]}>{tier.label}</Text>
                        <Text style={[styles.tierPrice, {color}]}>
                          {tier.price}<Text style={styles.tierPriceSub}>/month</Text>
                        </Text>
                      </View>
                    </View>
                    <View style={[styles.radio, {borderColor: isSelected ? color : '#475569'}]}>
                      {isSelected && <View style={[styles.radioFill, {backgroundColor: color}]} />}
                    </View>
                  </View>
                  {/* Gold expanded details */}
                  {isSelected && tier.details && (
                    <View style={styles.tierDetails}>
                      {tier.details.map((d, idx) => (
                        <View key={idx} style={[styles.tierDetailItem, {backgroundColor: `${color}14`, borderColor: `${color}33`}]}>
                          <Text style={[styles.tierDetailText, {color}]}>{d}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Inclusions */}
        <View style={styles.inclusionsCard}>
          <Text style={styles.sectionLabel}>All Retainers Include</Text>
          <View style={styles.inclusionList}>
            {INCLUSIONS.map((inc, idx) => (
              <View key={idx} style={styles.inclusionRow}>
                <Icon name="check-circle" size={14} color={PRO} />
                <Text style={styles.inclusionText}>{inc}</Text>
              </View>
            ))}
          </View>
        </View>

      </ScrollView>

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 20}]}>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('ProClientProfile')}
          activeOpacity={0.85}>
          <Text style={styles.ctaBtnText}>SELECT GOLD RETAINER → CLIENT PROFILE</Text>
        </TouchableOpacity>
        {/* Audit F-05 — the Pro subscription paywall was unreachable; give the
            upgrade funnel a direct path to the 2,000 BC/mo subscription. */}
        <TouchableOpacity
          style={styles.proLink}
          onPress={() => navigation.navigate('ProPaywall', {})}
          activeOpacity={0.7}>
          <Text style={styles.proLinkText}>Or subscribe to Bravo Pro · 2,000 BC/month</Text>
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

  dots: {flexDirection: 'row', gap: 5, alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  dotActive: {width: 18, borderRadius: 3, backgroundColor: '#6366F1'},

  content: {paddingHorizontal: 16, paddingTop: 4, gap: 20},

  subtitle: {fontSize: 12, color: '#94A3B8', lineHeight: 18},

  section: {gap: 12},
  sectionLabel: {fontSize: 10, fontWeight: '700', letterSpacing: 1.5, color: '#64748B', textTransform: 'uppercase'},
  tierList: {gap: 12},
  tierCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1.5, borderColor: '#1E2D45', padding: 16},
  tierRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  tierLeft: {flexDirection: 'row', alignItems: 'center', gap: 12},
  tierIcon: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  tierEmoji: {fontSize: 18},
  tierLabel: {fontSize: 14, fontWeight: '700', color: '#E2E8F0'},
  tierPrice: {fontSize: 12, fontWeight: '700'},
  tierPriceSub: {fontWeight: '400', color: '#64748B'},
  radio: {width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center'},
  radioFill: {width: 10, height: 10, borderRadius: 5},
  tierDetails: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12},
  tierDetailItem: {flex: 1, minWidth: '45%', borderRadius: 8, padding: 10, alignItems: 'center', borderWidth: 1},
  tierDetailText: {fontSize: 14, fontWeight: '700'},

  inclusionsCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 16, gap: 12},
  inclusionList: {gap: 8},
  inclusionRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 8},
  inclusionText: {fontSize: 12, color: '#CBD5E1', flex: 1},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: '#6366F1', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center'},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.8},
  proLink: {alignItems: 'center', paddingVertical: 10},
  proLinkText: {color: '#6366F1', fontSize: 12, fontWeight: '600'},
}));
