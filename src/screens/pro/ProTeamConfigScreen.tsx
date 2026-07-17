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
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const PRO = '#6366F1';

type Gender = 'none' | 'male' | 'female';

export default function ProTeamConfigScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [cpos, setCpos] = useState(2);
  const [vehicles, setVehicles] = useState(1);
  const [driverOnly, setDriverOnly] = useState(false);
  const [gender, setGender] = useState<Gender>('female');

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Team Configuration</Text>
        </View>
      </View>


      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {/* Team Composition */}
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Team Composition</Text>

          {/* CPOs */}
          <View style={styles.configRow}>
            <View style={styles.configInfo}>
              <Text style={styles.configLabel}>CPOs</Text>
              <Text style={styles.configSub}>1 CPO · <Text style={{color: PRO}}>{(1640).toLocaleString()} BC/mo</Text></Text>
            </View>
            <View style={styles.counter}>
              <TouchableOpacity
                style={styles.counterBtn}
                onPress={() => setCpos(Math.max(1, cpos - 1))}
                activeOpacity={0.7}>
                <Icon name="minus" size={14} color="#94A3B8" />
              </TouchableOpacity>
              <Text style={styles.counterValue}>{cpos}</Text>
              <TouchableOpacity
                style={[styles.counterBtn, styles.counterBtnActive]}
                onPress={() => setCpos(cpos + 1)}
                activeOpacity={0.7}>
                <Icon name="plus" size={14} color={PRO} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Vehicles */}
          <View style={[styles.configRow, styles.configBorder]}>
            <View style={styles.configInfo}>
              <Text style={styles.configLabel}>Vehicles + Drivers</Text>
              <Text style={styles.configSub}>1 Vehicle · <Text style={{color: PRO}}>{(1800).toLocaleString()} BC/mo</Text></Text>
            </View>
            <View style={styles.counter}>
              <TouchableOpacity
                style={styles.counterBtn}
                onPress={() => setVehicles(Math.max(1, vehicles - 1))}
                activeOpacity={0.7}>
                <Icon name="minus" size={14} color="#94A3B8" />
              </TouchableOpacity>
              <Text style={styles.counterValue}>{vehicles}</Text>
              <TouchableOpacity
                style={[styles.counterBtn, styles.counterBtnActive]}
                onPress={() => setVehicles(vehicles + 1)}
                activeOpacity={0.7}>
                <Icon name="plus" size={14} color={PRO} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Driver Only */}
          <View style={[styles.configRow, styles.configBorder]}>
            <View style={styles.configInfo}>
              <Text style={styles.configLabel}>Driver Only (Client Vehicle)</Text>
              <Text style={styles.configSub}>Client provides armoured vehicle</Text>
            </View>
            <Switch
              value={driverOnly}
              onValueChange={setDriverOnly}
              trackColor={{false: '#1E2D45', true: PRO}}
              thumbColor="#FFF"
            />
          </View>
        </View>

        {/* Gender Preference */}
        <View style={styles.genderCard}>
          <Text style={styles.sectionLabel}>Staff Gender Preference</Text>
          <View style={styles.genderRow}>
            <TouchableOpacity
              style={[styles.genderChip, gender === 'male' && styles.genderChipActive]}
              onPress={() => setGender(gender === 'male' ? 'none' : 'male')}
              activeOpacity={0.8}>
              <Icon name="human-male" size={20} color={gender === 'male' ? '#A5B4FC' : '#64748B'} />
              <Text style={[styles.genderChipText, gender === 'male' && styles.genderChipTextActive]}>MALE ONLY</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.genderChip, gender === 'female' && styles.genderChipActive]}
              onPress={() => setGender(gender === 'female' ? 'none' : 'female')}
              activeOpacity={0.8}>
              <Icon name="human-female" size={20} color={gender === 'female' ? '#A5B4FC' : '#64748B'} />
              <Text style={[styles.genderChipText, gender === 'female' && styles.genderChipTextActive]}>FEMALE ONLY</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Ops warning */}
        {cpos > 1 && (
          <View style={styles.warningCard}>
            <Icon name="alert" size={16} color="#F59E0B" style={{flexShrink: 0, marginTop: 2}} />
            <Text style={styles.warningText}>{cpos} CPOs selected — above baseline. Ops approval required with extended lead time.</Text>
          </View>
        )}

      </ScrollView>

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 20}]}>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('ProAIScheduling')}
          activeOpacity={0.85}>
          <Text style={styles.ctaBtnText}>CONFIRM TEAM → AI SCHEDULING</Text>
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

  content: {paddingHorizontal: 16, paddingTop: 8, gap: 16},

  card: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  sectionLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8},
  configRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12},
  configBorder: {borderTopWidth: 1, borderTopColor: '#1E2D45'},
  configInfo: {flex: 1},
  configLabel: {fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  configSub: {fontSize: 11, color: '#64748B', marginTop: 2},
  counter: {flexDirection: 'row', alignItems: 'center', gap: 12},
  counterBtn: {width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: '#1E2D45'},
  counterBtnActive: {backgroundColor: 'rgba(99,102,241,0.15)', borderColor: 'rgba(99,102,241,0.3)'},
  counterValue: {fontSize: 16, fontWeight: '800', color: '#F1F5F9', width: 24, textAlign: 'center'},

  genderCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', padding: 16, gap: 12},
  genderRow: {flexDirection: 'row', gap: 8},
  genderChip: {flex: 1, paddingVertical: 10, paddingHorizontal: 4, borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', alignItems: 'center', gap: 4},
  genderChipActive: {backgroundColor: 'rgba(99,102,241,0.12)', borderColor: '#6366F1'},
  genderChipText: {fontSize: 11, fontWeight: '700', color: '#64748B'},
  genderChipTextActive: {color: '#A5B4FC'},

  warningCard: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 12, backgroundColor: 'rgba(234,179,8,0.08)', borderWidth: 1, borderColor: 'rgba(234,179,8,0.2)'},
  warningText: {fontSize: 12, color: '#FCD34D', lineHeight: 18, flex: 1},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: '#6366F1', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.5},
}));
