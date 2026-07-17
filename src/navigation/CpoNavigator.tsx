/**
 * CpoNavigator (BUILD_RUNBOOK Step 17 / §35A) — the managed-guard shell: 4 bottom tabs
 * (On Duty / Mission / Comms / Me). Capability hiding (PR5) is STRUCTURAL — no booking
 * wizard, client wallet, job-offer accept, roster, assign-crew, or org-money screen is
 * registered here; a CPO simply cannot reach them. Comms reuses the existing messenger
 * stack (Ops Room). Tab CONTENTS for Duty/Mission/Me are fleshed out in the CPO-UI step;
 * this step ships the shell + the activation gate (in MainNavigator) + the mid-session
 * revocation re-check below.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, Image, ActivityIndicator} from 'react-native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAuthStore} from '@store/authStore';
import MessengerNavigator from './MessengerNavigator';
import DepartmentalNavigator from './DepartmentalNavigator';
import OnDutyHomeScreen from '@screens/cpo/OnDutyHomeScreen';
import AssignedMissionDetailScreen from '@screens/cpo/AssignedMissionDetailScreen';
import AgentLiveTrackerScreen from '@screens/agent/AgentLiveTrackerScreen';
import {useDeptUnreadTotal} from '@screens/deptchat/useDeptUnread';
import {useAvatarPicker} from '@modules/profile/useAvatarPicker';
import {AvatarPhotoSheet} from '@modules/profile/AvatarPhotoSheet';
import type {CpoTabParamList, CpoRootStackParamList} from './types';
import {scaleTextStyles} from '@utils/scaling';
import {DEPT_CHAT_V2} from '@utils/constants';

const Tab = createBottomTabNavigator<CpoTabParamList>();
const RootStack = createNativeStackNavigator<CpoRootStackParamList>();

// Hoisted tab-icon renderers (defining them inline in `options` trips
// react/no-unstable-nested-components — they'd be new component types each render).
type TabIconArgs = {color: string; size: number};
const DutyIcon = ({color, size}: TabIconArgs) => <Icon name="radar" color={color} size={size} />;
const MissionIcon = ({color, size}: TabIconArgs) => <Icon name="shield-account" color={color} size={size} />;
const CommsIcon = ({color, size}: TabIconArgs) => <Icon name="message-text" color={color} size={size} />;
const DeptIcon = ({color, size}: TabIconArgs) => <Icon name="office-building-outline" color={color} size={size} />;
const MeIcon = ({color, size}: TabIconArgs) => <Icon name="account-circle" color={color} size={size} />;

// The Departmental module is its own tab navigator, so it can't be mounted as a
// nested tab here (double footer). This placeholder never renders content — the
// tab's tabPress listener preventDefaults and jumps to the full-screen root
// `Departmental` route instead (see CpoTabs below).
const DeptTabPlaceholder = () => <View style={s.root} />;

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

// Default export = a thin native stack wrapping the 4-tab guard shell, so the
// dedicated Departmental module (Step 19) can be PUSHED full-screen over the tabs
// (its own footer, no nested-tab double footer) — reached from the On-Duty home.
// The four guard tabs live in CpoTabs below; capability lockdown (§35A §D) is
// unchanged (the source-scan test still sees exactly four <Tab.Screen>).
export default function CpoNavigator() {
  const recheckMembership = useAuthStore(s => s.recheckMembership);

  // §35A §F — mid-session revocation, mount-time check only. The foreground-
  // resume recheck now lives at the root (MainNavigator) so it covers EVERY
  // shell, not just this one — see RS-06. Keeping just the mount call here avoids
  // a double /auth/me on resume while still catching a guard suspended/removed
  // right before this shell mounts (force-logged-out via recheckMembership →
  // endCpoAccess).
  useEffect(() => {
    void recheckMembership();
  }, [recheckMembership]);

  return (
    <RootStack.Navigator screenOptions={{headerShown: false, contentStyle: {backgroundColor: D.bg}}}>
      <RootStack.Screen name="CpoTabs" component={CpoTabs} />
      <RootStack.Screen name="Departmental" component={DepartmentalNavigator} />
      {/* Step 31 — the map-first live tracker (design), pushed over the tabs. */}
      <RootStack.Screen name="CpoLiveTracker" component={AgentLiveTrackerScreen} options={{animation: 'fade'}} />
    </RootStack.Navigator>
  );
}

function CpoTabs() {
  const deptUnread = useDeptUnreadTotal();
  const deptBadge = deptUnread > 0 ? (deptUnread > 9 ? '9+' : deptUnread) : undefined;
  return (
    <Tab.Navigator
      sceneContainerStyle={{backgroundColor: D.bg}}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {backgroundColor: D.bg, borderTopColor: D.hair2, borderTopWidth: 1, height: 62, paddingTop: 6, paddingBottom: 8},
        tabBarActiveTintColor: D.accent,
        tabBarInactiveTintColor: D.textMute,
        tabBarLabelStyle: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 0.4},
      }}>
      <Tab.Screen name="CpoDuty" component={OnDutyHomeScreen}
        options={{tabBarLabel: 'On Duty', tabBarIcon: DutyIcon}} />
      <Tab.Screen name="CpoMission" component={AssignedMissionDetailScreen}
        options={{tabBarLabel: 'Mission', tabBarIcon: MissionIcon}} />
      <Tab.Screen name="CpoComms" component={MessengerNavigator}
        options={{tabBarLabel: 'Comms', tabBarIcon: CommsIcon}} />
      {/* Dark behind the flag, like every other Dept Chat v2 entry point (the
          agent-dashboard row and the On-Duty home card are already gated). */}
      {DEPT_CHAT_V2 ? (
        <Tab.Screen name="CpoDept" component={DeptTabPlaceholder}
          options={{
            tabBarLabel: 'Dept',
            tabBarIcon: DeptIcon,
            tabBarBadge: deptBadge,
            tabBarBadgeStyle: {backgroundColor: '#EF4444', color: '#FFFFFF'},
          }}
          listeners={({navigation}) => ({
            tabPress: e => {
              e.preventDefault();
              // Land on the Channels tab (the channel LIST) so all the CPO's channels show,
              // not the Home tab's single announcement card.
              navigation.navigate('Departmental', {screen: 'Channels'});
            },
          })} />
      ) : null}
      <Tab.Screen name="CpoMe" component={CpoMeScreen}
        options={{tabBarLabel: 'Me', tabBarIcon: MeIcon}} />
    </Tab.Navigator>
  );
}

// ─── Me tab (On Duty + Mission tabs now use the Step-21 screens above) ────────

function CpoMeScreen() {
  const insets = useSafeAreaInsets();
  const user = useAuthStore(s => s.user);
  const signOut = useAuthStore(s => s.signOut);
  const picker = useAvatarPicker();
  const [sheet, setSheet] = useState(false);
  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.meBody}>
        <View style={s.idCard}>
          <TouchableOpacity activeOpacity={0.85} style={s.avatarWrap} onPress={() => setSheet(true)}>
            <View style={s.icon}>
              {user?.avatar_url ? (
                <Image source={{uri: user.avatar_url}} style={s.avatarImg} />
              ) : (
                <Icon name="shield-account" size={28} color={D.accentSoft} />
              )}
              {picker.busy ? (
                <View style={s.avatarBusy}><ActivityIndicator color="#fff" /></View>
              ) : null}
            </View>
            <View style={s.cameraBadge}><Icon name="camera" size={12} color="#fff" /></View>
          </TouchableOpacity>
          <Text style={s.idLabel}>YOU BELONG TO</Text>
          <Text style={s.idOrg}>{user?.org?.name ?? 'your agency'}</Text>
          <Text style={s.idName}>{user?.full_name ?? user?.email ?? 'Close Protection Officer'}</Text>
        </View>
        <TouchableOpacity activeOpacity={0.85} style={s.signOutBtn} onPress={() => void signOut()}>
          <Icon name="logout-variant" size={18} color={D.text} />
          <Text style={s.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>
      <AvatarPhotoSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        hasPhoto={picker.hasPhoto}
        onLibrary={() => { void picker.pickFromLibrary(); }}
        onCamera={() => { void picker.takePhoto(); }}
        onRemove={() => { void picker.removePhoto(); }}
      />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 12},
  icon: {
    width: 72, height: 72, borderRadius: 22, marginBottom: 4, overflow: 'hidden',
    backgroundColor: 'rgba(91,141,239,0.12)', alignItems: 'center', justifyContent: 'center',
  },
  avatarWrap: {position: 'relative'},
  avatarImg: {width: '100%', height: '100%', borderRadius: 22},
  avatarBusy: {...StyleSheet.absoluteFillObject, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)'},
  cameraBadge: {
    position: 'absolute', bottom: 0, right: -2, width: 26, height: 26, borderRadius: 13,
    backgroundColor: D.accent, borderWidth: 2.5, borderColor: D.bg, alignItems: 'center', justifyContent: 'center',
  },
  title: {fontFamily: D.fBold, fontSize: 20, color: D.text, letterSpacing: -0.2, textAlign: 'center'},
  body: {fontFamily: D.fSans, fontSize: 13.5, lineHeight: 20, color: D.textDim, textAlign: 'center'},
  meBody: {flex: 1, paddingHorizontal: 22, paddingTop: 16, justifyContent: 'space-between', paddingBottom: 30},
  idCard: {
    borderRadius: 20, padding: 22, alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  idLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.6, color: D.textMute, marginTop: 6},
  idOrg: {fontFamily: D.fBold, fontSize: 22, color: D.text, letterSpacing: -0.3, textAlign: 'center'},
  idName: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, marginTop: 2},
  signOutBtn: {
    flexDirection: 'row', gap: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  signOutText: {fontFamily: D.fBold, fontSize: 14.5, color: D.text, letterSpacing: 0.2},
}));
