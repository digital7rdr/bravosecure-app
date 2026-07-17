import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Platform, PermissionsAndroid, Linking } from 'react-native';
import {Alert} from '@utils/alert';
import {requestPreciseLocation} from '@utils/locationPermission';
import {SafeAreaView} from 'react-native-safe-area-context';
import Geolocation from 'react-native-geolocation-service';
import {Camera} from 'expo-camera';
import {Audio} from 'expo-av';
import * as Contacts from 'expo-contacts';
import {useAuthStore} from '@store/authStore';
import type {AuthScreenProps} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';

type Props = Partial<AuthScreenProps<'Permissions'>> & {onDone?: () => void};
type PermStatus = 'idle' | 'granted' | 'denied' | 'blocked';

interface PermDef {
  id: string;
  label: string;
  icon: string;
  desc: string;
  required: boolean;
}

const PERM_LIST: PermDef[] = [
  {id:'location',      label:'Location',      icon:'📍', desc:'Live tracking, SOS response, and bookings',  required:true},
  {id:'contacts',      label:'Contacts',      icon:'👥', desc:'See which of your contacts use Bravo Secure', required:false},
  {id:'notifications', label:'Notifications', icon:'🔔', desc:'Alerts, SOS updates, booking confirmations', required:false},
  {id:'camera',        label:'Camera',        icon:'📷', desc:'Document scanning and video calls',          required:false},
  {id:'microphone',    label:'Microphone',    icon:'🎙️', desc:'Voice notes and secure calls',               required:false},
];

// ─── Per-permission OS request ───────────────────────────────────────────────

async function requestPerm(id: string): Promise<PermStatus> {
  try {
    // Contacts is cross-platform via expo-contacts — handle it before the
    // Android/iOS split so the same flow runs on both.
    if (id === 'contacts') {
      const perm = await Contacts.requestPermissionsAsync();
      if (perm.status === Contacts.PermissionStatus.GRANTED) {return 'granted';}
      // canAskAgain === false means the user permanently denied — route to
      // Settings like the other blocked permissions.
      if (perm.canAskAgain === false) {return 'blocked';}
      return 'denied';
    }
    if (Platform.OS === 'android') {
      // B-89 MG-06 — location requests FINE+COARSE together (the Android 12+
      // contract) and detects an approximate-only grant instead of silently
      // running the live maps on ~km-accurate fixes.
      if (id === 'location') {
        const grant = await requestPreciseLocation({
          title: 'Location Access',
          message: 'Bravo Secure needs your location for live mission tracking.',
        });
        if (grant === 'precise' || grant === 'approximate') {return 'granted';}
        return grant;
      }
      let androidPerm: string;
      switch (id) {
        case 'location':
          androidPerm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION; break;
        case 'camera':
          androidPerm = PermissionsAndroid.PERMISSIONS.CAMERA; break;
        case 'microphone':
          androidPerm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO; break;
        case 'notifications':
          // POST_NOTIFICATIONS only exists on Android 13+ (API 33+)
          if ((Platform.Version as number) < 33) {return 'granted';}
          androidPerm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS; break;
        default:
          return 'granted';
      }
      const result = await PermissionsAndroid.request(androidPerm, {
        title:          `${id.charAt(0).toUpperCase() + id.slice(1)} Access`,
        message:        `Bravo Secure needs ${id} permission to work correctly.`,
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      });
      if (result === PermissionsAndroid.RESULTS.GRANTED)        {return 'granted';}
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {return 'blocked';}
      return 'denied';
    }

    // iOS
    switch (id) {
      case 'location': {
        // B-89 MG-16 — was 'always', which iOS treats as the scariest
        // prompt and most users deny; nothing in the app implements
        // background location yet (the mission foreground service is
        // Android). whenInUse matches every runtime call site.
        const auth = await Geolocation.requestAuthorization('whenInUse');
        if (auth === 'granted')  {return 'granted';}
        if (auth === 'denied')   {return 'denied';}
        return 'blocked'; // restricted / disabled
      }
      case 'camera': {
        const {status} = await Camera.requestCameraPermissionsAsync();
        if (status === 'granted') {return 'granted';}
        if (status === 'denied')  {return 'blocked';} // iOS: denied = blocked, no re-ask
        return 'denied';
      }
      case 'microphone': {
        const {status} = await Audio.requestPermissionsAsync();
        return status === 'granted' ? 'granted' : 'denied';
      }
      case 'notifications':
        return 'granted'; // handled separately via expo-notifications if needed
      default:
        return 'granted';
    }
  } catch {
    return 'denied';
  }
}

async function checkPerm(id: string): Promise<PermStatus> {
  try {
    if (id === 'contacts') {
      const perm = await Contacts.getPermissionsAsync();
      return perm.status === Contacts.PermissionStatus.GRANTED ? 'granted' : 'idle';
    }
    if (Platform.OS === 'android') {
      let androidPerm: string;
      switch (id) {
        case 'location':
          androidPerm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION; break;
        case 'camera':
          androidPerm = PermissionsAndroid.PERMISSIONS.CAMERA; break;
        case 'microphone':
          androidPerm = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO; break;
        case 'notifications':
          if ((Platform.Version as number) < 33) {return 'granted';}
          androidPerm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS; break;
        default:
          return 'granted';
      }
      const granted = await PermissionsAndroid.check(androidPerm);
      return granted ? 'granted' : 'idle';
    }
    return 'idle';
  } catch {
    return 'idle';
  }
}

const FOOTER_H = 148;

export default function PermissionsScreen({navigation, onDone}: Props) {
  const {completeAuth} = useAuthStore();
  const [statuses, setStatuses] = useState<Record<string, PermStatus>>(
    Object.fromEntries(PERM_LIST.map(p => [p.id, 'idle'])),
  );
  const [requesting, setRequesting] = useState<string | null>(null);
  const [locationError, setLocationError] = useState(false);

  // Pre-populate statuses from what's already granted (e.g. returning user).
  useEffect(() => {
    void (async () => {
      const results = await Promise.all(PERM_LIST.map(p => checkPerm(p.id)));
      setStatuses(Object.fromEntries(PERM_LIST.map((p, i) => [p.id, results[i]])));
    })();
  }, []);

  const handleAllow = useCallback(async (id: string) => {
    const current = statuses[id];
    if (current === 'granted') {return;}

    // Blocked = user permanently denied — send to OS settings.
    if (current === 'blocked') {
      Alert.alert(
        'Permission blocked',
        'You permanently denied this permission. Open Settings to re-enable it.',
        [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Open Settings', onPress: () => { void Linking.openSettings(); }},
        ],
      );
      return;
    }

    setRequesting(id);
    const result = await requestPerm(id);
    setStatuses(prev => ({...prev, [id]: result}));
    setRequesting(null);

    if (id === 'location' && result !== 'granted') {setLocationError(true);}
    if (id === 'location' && result === 'granted')  {setLocationError(false);}
  }, [statuses]);

  // Universal "Allow all" — request every not-yet-granted permission in
  // sequence. Blocked ones are skipped (they need OS settings, not a prompt).
  const handleAllowAll = useCallback(async () => {
    for (const perm of PERM_LIST) {
      if (statuses[perm.id] === 'granted' || statuses[perm.id] === 'blocked') {continue;}
      setRequesting(perm.id);
      const result = await requestPerm(perm.id);
      setStatuses(prev => ({...prev, [perm.id]: result}));
      if (perm.id === 'location') {setLocationError(result !== 'granted');}
    }
    setRequesting(null);
  }, [statuses]);

  const finish = useCallback(() => {
    if (onDone) {
      onDone(); // gate mode — RootNavigator handles the rest
    } else {
      void completeAuth(); // auth-flow mode — flip isAuthenticated
    }
  }, [onDone, completeAuth]);

  const handleContinue = useCallback(() => {
    const locStatus = statuses.location;
    if (locStatus !== 'granted') {
      setLocationError(true);
      void handleAllow('location');
      return;
    }
    finish();
  }, [statuses, handleAllow, finish]);

  const handleSkip = useCallback(() => {
    const locStatus = statuses.location;
    if (locStatus !== 'granted') {
      setLocationError(true);
      void handleAllow('location');
      return;
    }
    finish();
  }, [statuses, handleAllow, finish]);

  const allGranted = PERM_LIST.every(p => statuses[p.id] === 'granted');
  const locGranted = statuses.location === 'granted';

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        bounces>

        <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>

        <View style={s.heading}>
          <Text style={s.title}>Allow access</Text>
          <Text style={s.subtitle}>Bravo Secure needs these to keep you protected</Text>
        </View>

        {!allGranted && (
          <TouchableOpacity
            style={s.allowAllBtn}
            onPress={() => { void handleAllowAll(); }}
            disabled={!!requesting}
            activeOpacity={0.85}>
            <Text style={s.allowAllText}>{requesting ? 'Requesting…' : 'Allow all'}</Text>
          </TouchableOpacity>
        )}

        <View style={s.list}>
          {PERM_LIST.map(perm => {
            const status  = statuses[perm.id];
            const loading = requesting === perm.id;
            const isBlocked = status === 'blocked';
            const isDenied  = status === 'denied';
            const isGranted = status === 'granted';

            return (
              <View
                key={perm.id}
                style={[
                  s.row,
                  perm.required && locationError && perm.id === 'location' && s.rowError,
                  isGranted && s.rowGranted,
                ]}>
                <View style={[s.iconBox, isGranted && s.iconBoxGranted]}>
                  <Text style={s.iconEmoji}>{perm.icon}</Text>
                </View>

                <View style={s.rowText}>
                  <View style={s.rowLabelRow}>
                    <Text style={s.rowLabel}>{perm.label}</Text>
                    {perm.required && (
                      <View style={[s.reqBadge, isGranted && s.reqBadgeGranted]}>
                        <Text style={[s.reqBadgeText, isGranted && s.reqBadgeTextGranted]}>
                          REQUIRED
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={s.rowDesc}>{perm.desc}</Text>
                  {isDenied && !isBlocked && (
                    <Text style={s.deniedHint}>Denied — tap Allow to try again</Text>
                  )}
                  {isBlocked && (
                    <Text style={s.deniedHint}>Blocked — tap to open Settings</Text>
                  )}
                </View>

                {isGranted ? (
                  <View style={s.checkBox}>
                    <Text style={s.checkMark}>✓</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[
                      s.allowBtn,
                      status === 'idle'   && s.allowBtnPrimary,
                      isDenied            && s.allowBtnRetry,
                      isBlocked           && s.allowBtnBlocked,
                      loading             && s.allowBtnLoading,
                    ]}
                    onPress={() => { void handleAllow(perm.id); }}
                    disabled={loading}
                    activeOpacity={0.8}>
                    <Text style={[s.allowBtnText, (isDenied || isBlocked) && s.allowBtnTextMuted]}>
                      {loading ? '…' : isBlocked ? 'Settings' : isDenied ? 'Retry' : 'Allow'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>

        {locationError && !locGranted && (
          <View style={s.errorBanner}>
            <Text style={s.errorBannerText}>📍 Location is required to continue. Please allow access above.</Text>
          </View>
        )}

        <View style={{height: FOOTER_H + 20}} />
      </ScrollView>

      <View style={s.footer}>
        <TouchableOpacity
          style={[s.continueBtn, !locGranted && s.continueBtnDisabled]}
          onPress={handleContinue}
          activeOpacity={0.85}>
          <Text style={s.continueBtnText}>
            {allGranted ? 'Continue' : locGranted ? 'Continue' : 'Allow Location to Continue'}
          </Text>
        </TouchableOpacity>
        {locGranted && (
          <TouchableOpacity onPress={handleSkip} activeOpacity={0.7}>
            <Text style={s.skipText}>Skip remaining — I'll do this later</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const PRIMARY  = '#2563EB';
const BG       = '#0A0F1E';
const BORDER   = '#1E2D45';
const OK       = '#22c55e';
const ERR      = '#ef4444';
const WARN_CLR = '#f59e0b';

const s = StyleSheet.create(scaleTextStyles({
  safe:    {flex:1, backgroundColor:BG},
  scroll:  {flex:1},
  content: {paddingHorizontal:24},

  backBtn:  {marginTop:8, marginBottom:4, width:40, height:40, borderRadius:20, backgroundColor:'rgba(255,255,255,0.05)', alignItems:'center', justifyContent:'center'},
  backIcon: {fontSize:20, color:'#f1f5f9'},

  pills:      {flexDirection:'row', justifyContent:'center', gap:8, paddingVertical:20},
  pill:       {height:6, width:24, borderRadius:3, backgroundColor:'rgba(37,99,235,0.2)'},
  pillActive: {width:40, backgroundColor:PRIMARY},

  allowAllBtn: {alignSelf:'flex-start', paddingHorizontal:16, paddingVertical:9, borderRadius:20, backgroundColor:'rgba(37,99,235,0.15)', borderWidth:1, borderColor:'rgba(37,99,235,0.4)', marginBottom:16},
  allowAllText: {fontSize:13, fontWeight:'800', color:'#60A5FA', letterSpacing:0.5},

  heading:  {marginBottom:24},
  title:    {fontSize:28, fontWeight:'700', color:'#f1f5f9', letterSpacing:-0.5, marginBottom:6},
  subtitle: {fontSize:15, color:'#64748b'},

  list: {gap:12},

  row: {
    flexDirection:'row', alignItems:'center', gap:14,
    backgroundColor:'rgba(37,99,235,0.05)',
    borderWidth:1, borderColor:BORDER,
    padding:16, borderRadius:16,
  },
  rowGranted: {borderColor:'rgba(34,197,94,0.3)', backgroundColor:'rgba(34,197,94,0.04)'},
  rowError:   {borderColor:'rgba(239,68,68,0.5)',  backgroundColor:'rgba(239,68,68,0.05)'},

  iconBox:        {width:48, height:48, borderRadius:12, backgroundColor:'rgba(37,99,235,0.15)', alignItems:'center', justifyContent:'center'},
  iconBoxGranted: {backgroundColor:'rgba(34,197,94,0.12)'},
  iconEmoji:      {fontSize:22},

  rowText:     {flex:1},
  rowLabelRow: {flexDirection:'row', alignItems:'center', gap:7, marginBottom:2, flexWrap:'wrap'},
  rowLabel:    {fontSize:15, fontWeight:'700', color:'#f1f5f9'},
  rowDesc:     {fontSize:12, color:'#64748b', lineHeight:16},
  deniedHint:  {fontSize:11, color:WARN_CLR, marginTop:4, fontStyle:'italic'},

  reqBadge:          {paddingHorizontal:5, paddingVertical:2, borderRadius:4, backgroundColor:'rgba(239,68,68,0.2)', borderWidth:1, borderColor:'rgba(239,68,68,0.4)'},
  reqBadgeGranted:   {backgroundColor:'rgba(34,197,94,0.15)', borderColor:'rgba(34,197,94,0.4)'},
  reqBadgeText:      {fontSize:8, fontWeight:'800', color:ERR, letterSpacing:0.8},
  reqBadgeTextGranted:{color:OK},

  checkBox:  {width:32, height:32, borderRadius:16, backgroundColor:'rgba(34,197,94,0.15)', alignItems:'center', justifyContent:'center'},
  checkMark: {fontSize:16, color:OK, fontWeight:'700'},

  allowBtn:        {paddingHorizontal:16, paddingVertical:8, borderRadius:20},
  allowBtnPrimary: {backgroundColor:PRIMARY},
  allowBtnRetry:   {backgroundColor:'rgba(245,158,11,0.15)', borderWidth:1, borderColor:WARN_CLR},
  allowBtnBlocked: {backgroundColor:'rgba(239,68,68,0.1)',   borderWidth:1, borderColor:ERR},
  allowBtnLoading: {opacity:0.5},
  allowBtnText:    {fontSize:13, fontWeight:'700', color:'#fff'},
  allowBtnTextMuted:{color:'#94a3b8'},

  errorBanner: {
    marginTop:16, padding:12, borderRadius:12,
    backgroundColor:'rgba(239,68,68,0.1)', borderWidth:1, borderColor:'rgba(239,68,68,0.35)',
  },
  errorBannerText: {fontSize:12, color:ERR, lineHeight:18, fontWeight:'600'},

  footer: {
    position:'absolute', bottom:0, left:0, right:0, height:FOOTER_H,
    paddingHorizontal:24, paddingTop:12, paddingBottom:32, gap:12, alignItems:'center',
    backgroundColor:BG, borderTopWidth:1, borderTopColor:BORDER,
  },
  continueBtn:         {width:'100%', height:56, backgroundColor:PRIMARY, borderRadius:14, alignItems:'center', justifyContent:'center', shadowColor:PRIMARY, shadowOpacity:0.25, shadowRadius:12, shadowOffset:{width:0,height:4}, elevation:6},
  continueBtnDisabled: {backgroundColor:'#1e3a6e', shadowOpacity:0},
  continueBtnText:     {fontSize:16, fontWeight:'700', color:'#fff'},
  skipText:            {fontSize:14, color:'#64748b', fontWeight:'500'},
}));
