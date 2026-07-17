import React, {useState, useRef, useEffect} from 'react';
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

// Why: Audit S2/S4 — the previous regex (`^\d{6}$/`) accepted any 6 digits,
// converting Forgot → OTP → NewPin into a full vault-takeover gadget.
// Until auth-service exposes a vault-PIN-reset OTP endpoint (no
// /auth/vault-reset/* route exists today), this screen FAILS CLOSED: the
// verify button is disabled and routes only to a support flow.
const VAULT_RESET_BACKEND_AVAILABLE = false;

export default function VaultOTPVerifyScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [emailCode, setEmailCode] = useState(['', '', '', '', '', '']);
  const [phoneCode, setPhoneCode] = useState(['', '', '', '', '', '']);
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [countdown, setCountdown] = useState(45);
  const [canResend, setCanResend] = useState(false);

  const emailRefs = useRef<(TextInput | null)[]>([]);
  const phoneRefs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    const iv = setInterval(() => {
      setCountdown(s => {
        if (s <= 1) {
          clearInterval(iv);
          setCanResend(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const resend = () => {
    setCanResend(false);
    setCountdown(30);
    const iv = setInterval(() => {
      setCountdown(s => {
        if (s <= 1) {
          clearInterval(iv);
          setCanResend(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  const handleBox = (prefix: 'email' | 'phone', i: number, val: string) => {
    const digit = val.replace(/\D/g, '').slice(-1);
    if (prefix === 'email') {
      const next = [...emailCode];
      next[i] = digit;
      setEmailCode(next);
      if (digit && i < 5) {emailRefs.current[i + 1]?.focus();}
    } else {
      const next = [...phoneCode];
      next[i] = digit;
      setPhoneCode(next);
      if (digit && i < 5) {phoneRefs.current[i + 1]?.focus();}
    }
  };

  const handleBackspace = (prefix: 'email' | 'phone', i: number) => {
    if (prefix === 'email') {
      if (emailCode[i] === '' && i > 0) {
        emailRefs.current[i - 1]?.focus();
      } else {
        const next = [...emailCode];
        next[i] = '';
        setEmailCode(next);
      }
    } else {
      if (phoneCode[i] === '' && i > 0) {
        phoneRefs.current[i - 1]?.focus();
      } else {
        const next = [...phoneCode];
        next[i] = '';
        setPhoneCode(next);
      }
    }
  };

  const verify = () => {
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
    // Reserved for when auth-service exposes /auth/vault-reset/verify. Until then,
    // the gate above ensures this never executes. Keep the focus/clear UX hooks
    // ready for that wiring.
    setEmailError('');
    setPhoneError('');
  };

  const renderBoxes = (prefix: 'email' | 'phone', code: string[], refs: React.MutableRefObject<(TextInput | null)[]>, error: string) => (
    <View style={styles.boxRow}>
      {code.map((val, i) => (
        <TextInput
          key={i}
          ref={el => { refs.current[i] = el; }}
          style={[styles.otpBox, !!error && styles.otpBoxError, val && styles.otpBoxFilled]}
          value={val}
          onChangeText={v => handleBox(prefix, i, v)}
          onKeyPress={({nativeEvent}) => {
            if (nativeEvent.key === 'Backspace') {handleBackspace(prefix, i);}
          }}
          keyboardType="number-pad"
          maxLength={1}
          selectTextOnFocus
        />
      ))}
    </View>
  );

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#B8C7E0" />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingScreen contentContainerStyle={styles.main}>
        <Text style={styles.heading}>Verify your identity</Text>
        <Text style={styles.sub}>
          Enter the 6-digit codes sent to your email and phone number.
        </Text>

        {/* Email OTP */}
        <View style={styles.otpBlock}>
          <View style={styles.otpLabelRow}>
            <Icon name="email-outline" size={15} color="#1E88FF" />
            <Text style={styles.otpLabel}>Email OTP</Text>
            <Text style={styles.otpHint}>· you@example.com</Text>
          </View>
          {renderBoxes('email', emailCode, emailRefs, emailError)}
          <Text style={[styles.errorText, !emailError && {opacity: 0}]}>{emailError || ' '}</Text>
        </View>

        {/* Phone OTP */}
        <View style={styles.otpBlock}>
          <View style={styles.otpLabelRow}>
            <Icon name="phone-outline" size={15} color="#1E88FF" />
            <Text style={styles.otpLabel}>Phone OTP</Text>
            <Text style={styles.otpHint}>· +1 ••• ••• 1234</Text>
          </View>
          {renderBoxes('phone', phoneCode, phoneRefs, phoneError)}
          <Text style={[styles.errorText, !phoneError && {opacity: 0}]}>{phoneError || ' '}</Text>
        </View>

        {/* Resend */}
        <View style={styles.resendRow}>
          {canResend ? (
            <TouchableOpacity onPress={resend} activeOpacity={0.7}>
              <Text style={styles.resendActive}>Resend codes</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.resendLabel}>
              Resend codes in <Text style={styles.resendTimer}>0:{String(countdown).padStart(2, '0')}</Text>
            </Text>
          )}
        </View>

        {/* Verify */}
        <View style={styles.btnWrap}>
          <TouchableOpacity
            style={[styles.verifyBtn, !VAULT_RESET_BACKEND_AVAILABLE && styles.verifyBtnDisabled]}
            onPress={verify}
            disabled={!VAULT_RESET_BACKEND_AVAILABLE}
            activeOpacity={0.85}>
            <Text style={styles.verifyBtnText}>
              {VAULT_RESET_BACKEND_AVAILABLE ? 'Verify & Continue' : 'Reset unavailable'}
            </Text>
          </TouchableOpacity>
        </View>

        {!VAULT_RESET_BACKEND_AVAILABLE && (
          <Text style={styles.demoHint}>
            Vault reset is not available in this build. Contact support to recover your vault.
          </Text>
        )}
      </KeyboardAvoidingScreen>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {paddingHorizontal: 16, paddingBottom: 8},
  backBtn: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},

  main: {paddingHorizontal: 20, paddingBottom: 24, flexGrow: 1},
  heading: {fontSize: 24, fontWeight: '700', color: '#FFFFFF', marginBottom: 4},
  sub: {fontSize: 14, color: '#B8C7E0', lineHeight: 20, marginBottom: 20},

  otpBlock: {marginBottom: 4},
  otpLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8},
  otpLabel: {fontSize: 12, fontWeight: '600', color: '#B8C7E0', textTransform: 'uppercase', letterSpacing: 1.5},
  otpHint: {fontSize: 12, color: '#7E8AA6'},

  boxRow: {flexDirection: 'row', gap: 8},
  otpBox: {
    flex: 1,
    height: 52,
    backgroundColor: '#162F54',
    borderWidth: 1,
    borderColor: '#1C3B66',
    borderRadius: 10,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  otpBoxFilled: {borderColor: '#1E88FF', borderWidth: 2},
  otpBoxError: {borderColor: '#D50000', borderWidth: 2},
  errorText: {fontSize: 12, color: '#f87171', fontWeight: '600', marginTop: 4, height: 16},

  resendRow: {alignItems: 'center', marginBottom: 16, marginTop: 4},
  resendLabel: {fontSize: 14, color: '#B8C7E0'},
  resendTimer: {color: '#1E88FF', fontWeight: '700'},
  resendActive: {fontSize: 14, color: '#1E88FF', fontWeight: '700'},

  btnWrap: {marginTop: 'auto'},
  verifyBtn: {backgroundColor: '#1E88FF', borderRadius: 12, paddingVertical: 16, alignItems: 'center'},
  verifyBtnDisabled: {backgroundColor: '#244C82', opacity: 0.6},
  verifyBtnText: {fontSize: 15, fontWeight: '700', color: '#FFF'},

  demoHint: {textAlign: 'center', fontSize: 11, color: '#244C82', marginTop: 12},
}));
