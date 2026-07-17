/**
 * DepartmentalNavigator (Dept Chat v2 — Step 19) — the dedicated "Departmental"
 * 5-tab module from the PDF Product Map (Home · Channels · Attend · Incident ·
 * Vault). ONE shell, opened by BOTH parties: a managed CPO/member (pushed from
 * CpoNavigator) and a service-provider company/manager (pushed from
 * AgentNavigator). Only each tab's ROOT screen differs by role; authorization is
 * still decided server-side — this only picks which already-guarded screen shows
 * first. Pushed as a FULL-SCREEN route so its own obsidian footer is the only
 * one on screen (no nested-tab double footer). Every feature screen (PDF p.4–15)
 * is reused verbatim from Steps 12–18 — nothing is rebuilt here.
 */
import React from 'react';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAuthStore} from '@store/authStore';
import {OB} from '@screens/deptchat/_obsidian';
import type {
  DepartmentalTabParamList,
  DeptChannelsStackParamList,
  DeptAttendStackParamList,
  DeptIncidentStackParamList,
  DeptVaultStackParamList,
} from './types';

// Home (NEW, Step 19) + reused feature screens.
import DepartmentalHomeScreen from '@screens/deptchat/DepartmentalHomeScreen';
import DepartmentChannelsScreen from '@screens/messenger/DepartmentChannelsScreen';
import DepartmentChatScreen from '@screens/messenger/DepartmentChatScreen';
import ManageChannelsScreen from '@screens/deptchat/ManageChannelsScreen';
import ChannelEditorScreen from '@screens/deptchat/ChannelEditorScreen';
import ChannelMembersScreen from '@screens/deptchat/ChannelMembersScreen';
import AttendanceScreen from '@screens/agent/AttendanceScreen';
import VerifyAttendanceScreen from '@screens/deptchat/VerifyAttendanceScreen';
import AttendanceResultScreen from '@screens/deptchat/AttendanceResultScreen';
import MyAttendanceScreen from '@screens/deptchat/MyAttendanceScreen';
import AdminAttendanceScreen from '@screens/deptchat/AdminAttendanceScreen';
import ShiftManagementScreen from '@screens/deptchat/ShiftManagementScreen';
import ShiftEditorScreen from '@screens/deptchat/ShiftEditorScreen';
import DayStatusScreen from '@screens/deptchat/DayStatusScreen';
import ReportIncidentCategoryScreen from '@screens/deptchat/ReportIncidentCategoryScreen';
import ReportIncidentDetailsScreen from '@screens/deptchat/ReportIncidentDetailsScreen';
import IncidentSubmittedScreen from '@screens/deptchat/IncidentSubmittedScreen';
import IncidentQueueScreen from '@screens/deptchat/IncidentQueueScreen';
import IncidentDetailScreen from '@screens/deptchat/IncidentDetailScreen';
import MyIncidentsScreen from '@screens/deptchat/MyIncidentsScreen';
import MyIncidentDetailScreen from '@screens/deptchat/MyIncidentDetailScreen';
import FilesScreen from '@screens/messenger/FilesScreen';
import VaultScreen from '@screens/messenger/VaultScreen';
import VaultLockScreen from '@screens/messenger/VaultLockScreen';
import VaultNewPinScreen from '@screens/messenger/VaultNewPinScreen';
import VaultForgotScreen from '@screens/messenger/VaultForgotScreen';
import VaultOTPVerifyScreen from '@screens/messenger/VaultOTPVerifyScreen';
import FileVaultPurchaseScreen from '@screens/messenger/FileVaultPurchaseScreen';

// Role resolution — prefers the server-resolved `is_org_manager` flag from
// /auth/me, which mirrors OrgManagerGuard exactly (company account OR an active
// org_members manager). This fixes the under-privilege case where a user who is
// a CPO of one org but a manager of another resolved to account_kind='cpo' and
// was shown the member surface. Falls back to the account_kind heuristic for a
// session cached before /auth/me carried the flag. The branch only chooses each
// tab's first screen; the server guards still decide.
function useIsManager(): boolean {
  const user = useAuthStore(s => s.user);
  if (!user) {return false;}
  return user.is_org_manager ?? (user.role === 'service_provider' || user.account_kind === 'agency');
}

const stackOpts = {headerShown: false as const, contentStyle: {backgroundColor: OB.bg}};

// Hoisted tab-icon renderers (inline `options` would trip
// react/no-unstable-nested-components — fresh component type each render).
type TabIconArgs = {focused: boolean; color: string; size: number};
const HomeIcon = ({focused, color, size}: TabIconArgs) => <Icon name={focused ? 'home' : 'home-outline'} color={color} size={size} />;
const ChannelsIcon = ({focused, color, size}: TabIconArgs) => <Icon name={focused ? 'forum' : 'forum-outline'} color={color} size={size} />;
const AttendIcon = ({focused, color, size}: TabIconArgs) => <Icon name={focused ? 'calendar-check' : 'calendar-check-outline'} color={color} size={size} />;
const IncidentIcon = ({focused, color, size}: TabIconArgs) => <Icon name={focused ? 'alert-octagon' : 'alert-octagon-outline'} color={color} size={size} />;
const VaultIcon = ({focused, color, size}: TabIconArgs) => <Icon name={focused ? 'shield-lock' : 'shield-lock-outline'} color={color} size={size} />;

// ─── Channels tab (reused Step 12/18 screens) ────────────────────────────────
const ChannelsStack = createNativeStackNavigator<DeptChannelsStackParamList>();
function ChannelsTab() {
  return (
    <ChannelsStack.Navigator screenOptions={stackOpts}>
      <ChannelsStack.Screen name="DepartmentChannels" component={DepartmentChannelsScreen} />
      <ChannelsStack.Screen name="DepartmentChat" component={DepartmentChatScreen} />
      <ChannelsStack.Screen name="ManageChannels" component={ManageChannelsScreen} />
      <ChannelsStack.Screen name="ChannelEditor" component={ChannelEditorScreen} />
      <ChannelsStack.Screen name="ChannelMembers" component={ChannelMembersScreen} />
    </ChannelsStack.Navigator>
  );
}

// ─── Attend tab — role-branched root (member: Attendance / manager: Admin) ────
const AttendStack = createNativeStackNavigator<DeptAttendStackParamList>();
function AttendTab() {
  const isManager = useIsManager();
  return (
    <AttendStack.Navigator
      initialRouteName={isManager ? 'AdminAttendance' : 'Attendance'}
      screenOptions={stackOpts}>
      <AttendStack.Screen name="Attendance" component={AttendanceScreen} />
      <AttendStack.Screen name="VerifyAttendance" component={VerifyAttendanceScreen} />
      <AttendStack.Screen name="AttendanceResult" component={AttendanceResultScreen} options={{gestureEnabled: false}} />
      <AttendStack.Screen name="MyAttendance" component={MyAttendanceScreen} />
      <AttendStack.Screen name="AdminAttendance" component={AdminAttendanceScreen} />
      <AttendStack.Screen name="ShiftManagement" component={ShiftManagementScreen} />
      <AttendStack.Screen name="ShiftEditor" component={ShiftEditorScreen} />
      <AttendStack.Screen name="DayStatus" component={DayStatusScreen} />
    </AttendStack.Navigator>
  );
}

// ─── Incident tab — role-branched root (member: Report / manager: Queue) ──────
const IncidentStack = createNativeStackNavigator<DeptIncidentStackParamList>();
function IncidentTab() {
  const isManager = useIsManager();
  return (
    <IncidentStack.Navigator
      initialRouteName={isManager ? 'IncidentQueue' : 'MyIncidents'}
      screenOptions={stackOpts}>
      {/* Member root (Step 23): My Reports → Report wizard. Manager root: Queue → Detail. */}
      <IncidentStack.Screen name="MyIncidents" component={MyIncidentsScreen} />
      <IncidentStack.Screen name="MyIncidentDetail" component={MyIncidentDetailScreen} />
      <IncidentStack.Screen name="ReportIncidentCategory" component={ReportIncidentCategoryScreen} />
      <IncidentStack.Screen name="ReportIncidentDetails" component={ReportIncidentDetailsScreen} />
      <IncidentStack.Screen name="IncidentSubmitted" component={IncidentSubmittedScreen} options={{gestureEnabled: false}} />
      <IncidentStack.Screen name="IncidentQueue" component={IncidentQueueScreen} />
      <IncidentStack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
    </IncidentStack.Navigator>
  );
}

// ─── Vault tab — reuses the messenger vault flow + File-Vault MFA gate ────────
const VaultStack = createNativeStackNavigator<DeptVaultStackParamList>();
function VaultTab() {
  return (
    <VaultStack.Navigator screenOptions={stackOpts}>
      {/* Why: VaultLockScreen's hardware-back resets to a route literally named
          'MessengerHome' (its anti-leak exit). Naming the vault tab's root that
          routes the reset back to the Files landing instead of erroring, keeping
          the File-Vault MFA gate's exit behaviour intact inside this shell. */}
      <VaultStack.Screen name="MessengerHome" component={FilesScreen} />
      <VaultStack.Screen name="VaultLock" component={VaultLockScreen} />
      <VaultStack.Screen name="VaultScreen" component={VaultScreen} />
      <VaultStack.Screen name="VaultNewPin" component={VaultNewPinScreen} />
      <VaultStack.Screen name="VaultForgot" component={VaultForgotScreen} />
      <VaultStack.Screen name="VaultOTPVerify" component={VaultOTPVerifyScreen} />
      <VaultStack.Screen name="FileVaultPurchase" component={FileVaultPurchaseScreen} />
    </VaultStack.Navigator>
  );
}

const Tab = createBottomTabNavigator<DepartmentalTabParamList>();

export default function DepartmentalNavigator() {
  return (
    <Tab.Navigator
      sceneContainerStyle={{backgroundColor: OB.bg}}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {backgroundColor: OB.bg, borderTopColor: OB.hair2, borderTopWidth: 1, height: 62, paddingTop: 6, paddingBottom: 8},
        tabBarActiveTintColor: OB.accent,
        tabBarInactiveTintColor: OB.textMute,
        tabBarLabelStyle: {fontFamily: 'Manrope_600SemiBold', fontSize: 10, letterSpacing: 0.4},
      }}>
      <Tab.Screen name="Home" component={DepartmentalHomeScreen} options={{tabBarLabel: 'Home', tabBarIcon: HomeIcon}} />
      <Tab.Screen name="Channels" component={ChannelsTab} options={{tabBarLabel: 'Channels', tabBarIcon: ChannelsIcon}} />
      <Tab.Screen name="Attend" component={AttendTab} options={{tabBarLabel: 'Attend', tabBarIcon: AttendIcon}} />
      <Tab.Screen name="Incident" component={IncidentTab} options={{tabBarLabel: 'Incident', tabBarIcon: IncidentIcon}} />
      <Tab.Screen name="Vault" component={VaultTab} options={{tabBarLabel: 'Vault', tabBarIcon: VaultIcon}} />
    </Tab.Navigator>
  );
}
