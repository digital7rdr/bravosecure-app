import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Vibration,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useVaultStore} from '@/modules/messenger/vault';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'VaultNewPin'>;

const KEYPAD = [
  [{num: '1', sub: ''}, {num: '2', sub: 'ABC'}, {num: '3', sub: 'DEF'}],
  [{num: '4', sub: 'GHI'}, {num: '5', sub: 'JKL'}, {num: '6', sub: 'MNO'}],
  [{num: '7', sub: 'PQRS'}, {num: '8', sub: 'TUV'}, {num: '9', sub: 'WXYZ'}],
];

type Step = 'new' | 'confirm';

export default function VaultNewPinScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const setupPin = useVaultStore(s => s.setupPin);
  const hasPin   = useVaultStore(s => s.hasPin());
  const changePin = useVaultStore(s => s.changePin);
  const [step, setStep] = useState<Step>('new');
  const [newPin, setNewPin] = useState('');
  const [entered, setEntered] = useState('');
  const [status, setStatus] = useState<{text: string; color: string} | null>(null);
  const [dotState, setDotState] = useState<'normal' | 'success' | 'error'>('normal');

  const press = (digit: string) => {
    if (entered.length >= 6) {return;}
    Vibration.vibrate(8);
    const next = entered + digit;
    setEntered(next);
    if (next.length === 6) {
      setTimeout(() => handleComplete(next), 120);
    }
  };

  const backspace = () => {
    Vibration.vibrate(6);
    setEntered(p => p.slice(0, -1));
    setStatus(null);
  };

  const handleComplete = (pin: string) => {
    if (step === 'new') {
      setNewPin(pin);
      setEntered('');
      setStep('confirm');
      setStatus({text: 'PIN set — now confirm it', color: '#1E88FF'});
    } else {
      if (pin === newPin) {
        // First-time setup: seed the PIN, then jump straight into the
        // vault (the act of confirming counts as an unlock). Re-using
        // this screen for a PIN change route is just `changePin` — we
        // don't land on VaultLock afterwards.
        //
        // Audit fix #35 — setupPin/changePin are now async (Argon2id
        // takes ~300 ms on a mid-tier Android). Await them so the
        // success UI doesn't flash before the hash actually lands.
        // Audit fix #36 — biometric is no longer auto-enabled here;
        // the setup screen should show a separate "Enable Face ID?"
        // prompt and call setBiometricEnabled(true) on consent.
        const apply = hasPin ? changePin(pin) : setupPin(pin);
        void apply.then(() => {
          setDotState('success');
          setStatus({text: 'PIN saved — unlocking vault', color: '#00C853'});
          setTimeout(() => navigation.replace('VaultScreen'), 700);
        }).catch((e) => {
          Vibration.vibrate(50);
          setDotState('error');
          setStatus({text: `PIN setup failed: ${(e as Error).message}`, color: '#D50000'});
        });
      } else {
        Vibration.vibrate(50);
        setDotState('error');
        setStatus({text: 'PINs do not match. Try again.', color: '#D50000'});
        setTimeout(() => {
          setDotState('normal');
          setEntered('');
          setStep('new');
          setNewPin('');
          setStatus(null);
        }, 600);
      }
    }
  };

  const isConfirm = step === 'confirm';

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#B8C7E0" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isConfirm ? 'Confirm PIN' : 'New PIN'}</Text>
        <View style={styles.backBtn} />
      </View>

      {/* Icon + title */}
      <View style={styles.iconSection}>
        <View style={styles.iconWrap}>
          <Icon name={isConfirm ? 'lock' : 'lock-open-variant'} size={24} color="#1E88FF" />
        </View>
        <Text style={styles.title}>{isConfirm ? 'Confirm New PIN' : 'Set New PIN'}</Text>
        <Text style={styles.sub}>{isConfirm ? 'Re-enter your 6-digit PIN' : 'Enter a new 6-digit PIN'}</Text>
      </View>

      {/* PIN dots */}
      <View style={styles.dotsRow}>
        {Array.from({length: 6}).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i < entered.length && dotState === 'normal' && styles.dotFilled,
              i < entered.length && dotState === 'success' && styles.dotSuccess,
              i < entered.length && dotState === 'error' && styles.dotError,
            ]}
          />
        ))}
      </View>

      {/* Status message */}
      <Text style={[styles.statusMsg, {color: status?.color ?? 'transparent'}]}>
        {status?.text ?? '–'}
      </Text>

      {/* Keypad */}
      <View style={styles.keypad}>
        {KEYPAD.map((row, ri) => (
          <View key={ri} style={styles.keyRow}>
            {row.map(k => (
              <TouchableOpacity
                key={k.num}
                style={styles.keyBtn}
                onPress={() => press(k.num)}
                activeOpacity={0.7}>
                <Text style={styles.keyNum}>{k.num}</Text>
                {!!k.sub && <Text style={styles.keySub}>{k.sub}</Text>}
              </TouchableOpacity>
            ))}
          </View>
        ))}
        <View style={styles.keyRow}>
          <View style={styles.keyBtnEmpty} />
          <TouchableOpacity style={styles.keyBtn} onPress={() => press('0')} activeOpacity={0.7}>
            <Text style={styles.keyNum}>0</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.keyBtn} onPress={backspace} activeOpacity={0.7}>
            <Icon name="backspace-outline" size={22} color="#B8C7E0" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(30,136,255,0.1)'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#B8C7E0'},

  iconSection: {alignItems: 'center', paddingTop: 16, paddingBottom: 8},
  iconWrap: {width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  title: {fontSize: 16, fontWeight: '800', color: '#FFFFFF', marginBottom: 2},
  sub: {fontSize: 11, color: '#7E8AA6'},

  dotsRow: {flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 12, marginBottom: 4},
  dot: {width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#1C3B66', backgroundColor: 'transparent'},
  dotFilled: {backgroundColor: '#1E88FF', borderColor: '#1E88FF'},
  dotSuccess: {backgroundColor: '#00C853', borderColor: '#00C853'},
  dotError: {backgroundColor: '#D50000', borderColor: '#D50000'},

  statusMsg: {textAlign: 'center', fontSize: 11, fontWeight: '600', height: 16, marginBottom: 8},

  keypad: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24},
  keyRow: {flexDirection: 'row', gap: 20},
  keyBtn: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: 'rgba(30,136,255,0.08)',
    borderWidth: 1,
    borderColor: '#1C3B66',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyBtnEmpty: {width: 58, height: 58},
  keyNum: {fontSize: 19, fontWeight: '700', color: '#FFFFFF', lineHeight: 22},
  keySub: {fontSize: 7, fontWeight: '600', color: '#7E8AA6', letterSpacing: 1.5, marginTop: 1},
});
