import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  TextInput,
  Linking,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {scaleTextStyles} from '@utils/scaling';

// Why: Audit S2 — there is no /auth/vault-reset OTP endpoint. The previous
// flow accepted any email+phone string and routed into a downstream screen
// that accepted any 6-digit code, yielding a complete vault-takeover gadget.
// Until the backend ships the reset flow, fail closed and direct users to
// support.
const VAULT_RESET_BACKEND_AVAILABLE = false;

export default function VaultForgotScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const sendOTP = () => {
    if (!email.trim() || !phone.trim()) {return;}
    if (!VAULT_RESET_BACKEND_AVAILABLE) {
      Alert.alert(
        'Reset unavailable',
        'Vault PIN reset is not yet available in this build. Contact support to recover your vault.',
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Contact support',
            onPress: () => { void Linking.openURL('mailto:support@bravosecure.app?subject=Vault%20PIN%20reset'); },
          },
        ],
      );
      return;
    }
    navigation.navigate('VaultOTPVerify' as never);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#B8C7E0" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reset PIN</Text>
        <View style={styles.backBtn} />
      </View>

      <KeyboardAvoidingScreen
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 24}]}>

        {/* Icon + title */}
        <View style={styles.iconSection}>
          <View style={styles.iconWrap}>
            <Icon name="lock-reset" size={28} color="#1E88FF" />
          </View>
          <Text style={styles.title}>Forgot Your PIN?</Text>
          <Text style={styles.sub}>
            Enter your registered email and phone number.{'\n'}We'll send an OTP to both.
          </Text>
        </View>

        {/* Email field */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Email Address</Text>
          <View style={styles.fieldRow}>
            <Icon name="email-outline" size={18} color="#7E8AA6" />
            <TextInput
              style={styles.fieldInput}
              placeholder="you@example.com"
              placeholderTextColor="#7E8AA6"
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={setEmail}
            />
          </View>
        </View>

        {/* Phone field */}
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>Phone Number</Text>
          <View style={styles.fieldRow}>
            <Icon name="phone-outline" size={18} color="#7E8AA6" />
            <TextInput
              style={styles.fieldInput}
              placeholder="+1 000 000 0000"
              placeholderTextColor="#7E8AA6"
              keyboardType="phone-pad"
              value={phone}
              onChangeText={setPhone}
            />
          </View>
        </View>

        {/* Info note */}
        <View style={styles.infoNote}>
          <Icon name="information-outline" size={16} color="#1E88FF" />
          <Text style={styles.infoText}>
            A 6-digit OTP will be sent to both your email and phone number for verification.
          </Text>
        </View>

        {/* Send OTP */}
        <TouchableOpacity
          style={[styles.sendBtn, (!email.trim() || !phone.trim()) && {opacity: 0.5}]}
          onPress={sendOTP}
          activeOpacity={0.85}>
          <Text style={styles.sendBtnText}>Send OTP</Text>
        </TouchableOpacity>

        {/* Back link */}
        <TouchableOpacity style={styles.backLink} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Text style={styles.backLinkText}>Back to Vault Login</Text>
        </TouchableOpacity>

      </KeyboardAvoidingScreen>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(30,136,255,0.1)'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#B8C7E0'},

  scroll: {paddingHorizontal: 20, paddingTop: 24},

  iconSection: {alignItems: 'center', marginBottom: 24},
  iconWrap: {width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 12},
  title: {fontSize: 18, fontWeight: '800', color: '#FFFFFF', marginBottom: 4},
  sub: {fontSize: 11, color: '#7E8AA6', textAlign: 'center', lineHeight: 18},

  fieldGroup: {marginBottom: 16},
  fieldLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#1E88FF', marginBottom: 6},
  fieldRow: {flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 12, gap: 8, backgroundColor: '#162F54', borderWidth: 1, borderColor: '#1C3B66', borderRadius: 12},
  fieldInput: {flex: 1, fontSize: 13, fontWeight: '500', color: '#FFFFFF'},

  infoNote: {flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: 'rgba(30,136,255,0.07)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.15)', borderRadius: 12, padding: 12, marginBottom: 24},
  infoText: {flex: 1, fontSize: 11, color: '#B8C7E0', lineHeight: 17},

  sendBtn: {backgroundColor: '#1E88FF', borderRadius: 12, height: 44, alignItems: 'center', justifyContent: 'center', marginBottom: 16},
  sendBtnText: {fontSize: 13, fontWeight: '800', color: '#FFF', textTransform: 'uppercase', letterSpacing: 2},

  backLink: {alignItems: 'center', paddingVertical: 8},
  backLinkText: {fontSize: 12, color: '#7E8AA6', fontWeight: '500'},
}));
