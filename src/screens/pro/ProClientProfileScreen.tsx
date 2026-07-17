import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  TextInput,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const PRO = '#6366F1';

// Empty profile form — the user fills these in (no prefilled sample data).
const FIELDS = [
  {id: 'name', icon: 'account', label: 'Full Name', value: '', type: 'default', warning: false},
  {id: 'phone', icon: 'phone', label: 'Primary Mobile', value: '', type: 'phone-pad', warning: false},
  {id: 'email', icon: 'lock', label: 'Secure Email', value: '', type: 'email-address', warning: false},
  {id: 'passport', icon: 'card-account-details', label: 'Passport / Emirates ID', value: '', type: 'default', warning: false},
  {id: 'residence', icon: 'home', label: 'Primary Residence', value: '', type: 'default', warning: false},
  {id: 'medical', icon: 'alert', label: 'Medical Alerts', value: '', type: 'default', warning: true},
] as const;

export default function ProClientProfileScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<'individual' | 'corporate'>('individual');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(FIELDS.map(f => [f.id, f.value])),
  );

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Client Profile</Text>
        </View>
      </View>


      <KeyboardAvoidingScreen
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {/* Avatar card */}
        <View style={styles.avatarCard}>
          <View style={styles.avatar}>
            <Icon name="account" size={28} color="#FFF" />
          </View>
          <View style={styles.avatarInfo}>
            <Text style={styles.avatarName}>{values.name?.trim() || 'New Client Profile'}</Text>
            <Text style={styles.avatarRole}>{activeTab === 'corporate' ? 'Corporate account' : 'Individual account'}</Text>
            <View style={styles.avatarBadges}>
              <View style={styles.verifiedBadge}><Text style={styles.verifiedBadgeText}>BRAVO PRO</Text></View>
            </View>
          </View>
        </View>

        {/* Tab toggle */}
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'individual' && styles.tabBtnActive]}
            onPress={() => setActiveTab('individual')}
            activeOpacity={0.8}>
            <Text style={[styles.tabBtnText, activeTab === 'individual' && styles.tabBtnTextActive]}>Individual</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'corporate' && styles.tabBtnActive]}
            onPress={() => setActiveTab('corporate')}
            activeOpacity={0.8}>
            <Text style={[styles.tabBtnText, activeTab === 'corporate' && styles.tabBtnTextActive]}>Corporate</Text>
          </TouchableOpacity>
        </View>

        {/* Risk classification */}
        <View style={styles.riskCard}>
          <View style={styles.riskHeader}>
            <Text style={styles.riskLabel}>Risk Classification</Text>
            <Text style={styles.riskValue}>MEDIUM · 52</Text>
          </View>
          <View style={styles.riskBar}>
            <View style={styles.riskFill} />
          </View>
          <View style={styles.riskRange}>
            <Text style={styles.riskRangeText}>Low</Text>
            <Text style={styles.riskRangeText}>Critical</Text>
          </View>
        </View>

        {/* Profile Fields */}
        <View style={styles.fieldsSection}>
          <Text style={styles.sectionLabel}>Profile Details</Text>
          <View style={styles.fieldList}>
            {FIELDS.map(field => {
              const isEditing = editingField === field.id;
              return (
                <View key={field.id} style={[styles.fieldRow, isEditing && styles.fieldRowActive, field.warning && styles.fieldRowWarning]}>
                  <Icon name={field.icon} size={18} color={field.warning ? '#F59E0B' : '#64748B'} />
                  <View style={styles.fieldInfo}>
                    <Text style={styles.fieldLabel}>{field.label}</Text>
                    <TextInput
                      style={[styles.fieldInput, isEditing && styles.fieldInputActive]}
                      value={values[field.id]}
                      onChangeText={v => setValues(prev => ({...prev, [field.id]: v}))}
                      editable={isEditing}
                      pointerEvents={isEditing ? 'auto' : 'none'}
                    />
                  </View>
                  <TouchableOpacity onPress={() => setEditingField(isEditing ? null : field.id)} activeOpacity={0.7}>
                    <Icon name={isEditing ? 'check' : 'pencil'} size={16} color={isEditing ? PRO : '#475569'} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        </View>

      </KeyboardAvoidingScreen>

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 20}]}>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('ProTeamConfig')}
          activeOpacity={0.85}>
          <Text style={styles.ctaBtnText}>SAVE PROFILE → TEAM CONFIGURATION</Text>
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

  dots: {flexDirection: 'row', gap: 5, alignItems: 'center', paddingHorizontal: 20, paddingBottom: 16},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  dotDone: {backgroundColor: '#6366F1'},
  dotActive: {width: 18, borderRadius: 3, backgroundColor: '#6366F1'},

  content: {paddingHorizontal: 16, paddingTop: 4, gap: 16},

  avatarCard: {flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 16},
  avatar: {width: 56, height: 56, borderRadius: 28, backgroundColor: '#6366F1', alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  avatarInfo: {flex: 1},
  avatarName: {fontSize: 16, fontWeight: '700', color: '#F1F5F9'},
  avatarRole: {fontSize: 12, color: '#94A3B8', marginBottom: 8},
  avatarBadges: {flexDirection: 'row', gap: 8, flexWrap: 'wrap'},
  goldBadge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, backgroundColor: 'rgba(245,158,11,0.15)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)'},
  goldBadgeText: {fontSize: 10, fontWeight: '700', color: '#FCD34D'},
  verifiedBadge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, backgroundColor: 'rgba(34,197,94,0.12)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)'},
  verifiedBadgeText: {fontSize: 10, fontWeight: '700', color: '#4ADE80'},

  tabBar: {flexDirection: 'row', backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 4, gap: 4},
  tabBtn: {flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center'},
  tabBtnActive: {backgroundColor: '#6366F1'},
  tabBtnText: {fontSize: 13, fontWeight: '600', color: '#64748B'},
  tabBtnTextActive: {color: '#FFF'},

  riskCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 14},
  riskHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8},
  riskLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5},
  riskValue: {fontSize: 10, fontWeight: '700', color: '#F59E0B'},
  riskBar: {height: 6, borderRadius: 99, backgroundColor: '#1E2D45', overflow: 'hidden'},
  riskFill: {height: '100%', width: '52%', borderRadius: 99, backgroundColor: '#F59E0B'},
  riskRange: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 4},
  riskRangeText: {fontSize: 9, color: '#334155'},

  fieldsSection: {gap: 8},
  sectionLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5},
  fieldList: {gap: 8},
  fieldRow: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45'},
  fieldRowActive: {borderColor: '#6366F1'},
  fieldRowWarning: {borderColor: 'rgba(245,158,11,0.25)'},
  fieldInfo: {flex: 1},
  fieldLabel: {fontSize: 10, fontWeight: '600', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2},
  fieldInput: {fontSize: 14, fontWeight: '500', color: '#F1F5F9', padding: 0},
  fieldInputActive: {color: '#A5B4FC'},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: '#6366F1', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center'},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.5},
}));
