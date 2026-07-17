/**
 * CPO · Access Ended (BUILD_RUNBOOK Step 17 / §35A §F) — terminal screen shown when a
 * managed guard's agency membership is suspended/removed. On mount it runs the shared
 * revocation teardown (`endCpoAccess`: best-effort off-duty + full signOut, which drops
 * the CPO from Ops Rooms + wipes at-rest) — idempotent, so arriving here from a boot-as-
 * suspended-CPO or from a mid-session re-check both converge. Obsidian + platinum-cobalt
 * theme, matching the CPO shell.
 */
import React, {useEffect} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAuthStore} from '@store/authStore';
import {scaleTextStyles} from '@utils/scaling';

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

export default function AccessEndedScreen() {
  const insets = useSafeAreaInsets();
  const endCpoAccess = useAuthStore(s => s.endCpoAccess);
  const clearAccessEnded = useAuthStore(s => s.clearAccessEnded);

  // Run the teardown on mount — idempotent (no-op if recheckMembership already did it).
  useEffect(() => { void endCpoAccess(); }, [endCpoAccess]);

  return (
    <View style={[s.root, {paddingTop: insets.top + 40, paddingBottom: insets.bottom + 20}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.body}>
        <View style={s.iconWrap}>
          <Icon name="shield-off-outline" size={44} color={D.alert} />
        </View>
        <Text style={s.title}>Agency access ended</Text>
        <Text style={s.sub}>
          Your access to Bravo was provided by your agency and has been suspended or
          removed. You have been signed out and taken off duty.
        </Text>
        <Text style={s.subDim}>
          If you believe this is a mistake, contact your agency to be reinstated.
        </Text>
      </View>
      <TouchableOpacity activeOpacity={0.85} onPress={clearAccessEnded} style={s.btn}>
        <Text style={s.btnText}>Return to sign in</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, paddingHorizontal: 28, justifyContent: 'space-between'},
  body: {flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14},
  iconWrap: {
    width: 88, height: 88, borderRadius: 28, marginBottom: 8,
    backgroundColor: 'rgba(255,93,93,0.10)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.30)',
    alignItems: 'center', justifyContent: 'center',
  },
  title: {fontFamily: D.fBold, fontSize: 22, color: D.text, letterSpacing: -0.3, textAlign: 'center'},
  sub: {fontFamily: D.fSans, fontSize: 14, lineHeight: 21, color: D.textDim, textAlign: 'center', marginTop: 2},
  subDim: {fontFamily: D.fSans, fontSize: 12.5, lineHeight: 19, color: D.textMute, textAlign: 'center', marginTop: 4},
  btn: {
    height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  btnText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
}));
