import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {AgentStackParamList} from './types';
import {Colors} from '@theme/colors';

import AgentDashboardScreen from '@screens/agent/AgentDashboardScreen';
import AgentRegistrationScreen from '@screens/agent/AgentRegistrationScreen';
import AgentTypeSelectScreen from '@screens/agent/AgentTypeSelectScreen';
import AgentRegistrationWizardScreen from '@screens/agent/AgentRegistrationWizardScreen';
import AgentCoverageScreen from '@screens/agent/AgentCoverageScreen';
import AgentAvailabilityScreen from '@screens/agent/AgentAvailabilityScreen';
import AgentDocsUploadScreen from '@screens/agent/AgentDocsUploadScreen';
import AgentAdminApprovalScreen from '@screens/agent/AgentAdminApprovalScreen';
import AgentDeploymentRequirementsScreen from '@screens/agent/AgentDeploymentRequirementsScreen';
import MissionLeadConsoleScreen from '@screens/agent/MissionLeadConsoleScreen';
import AgentLiveTrackerScreen from '@screens/agent/AgentLiveTrackerScreen';
import AgentHomeScreen from '@screens/agent/AgentHomeScreen';
import AgentKYCScreen from '@screens/agent/AgentKYCScreen';
import AgentVerifiedScreen from '@screens/agent/AgentVerifiedScreen';
import AgentRejectedScreen from '@screens/agent/AgentRejectedScreen';
import JobMarketplaceScreen from '@screens/agent/JobMarketplaceScreen';
import JobDetailScreen from '@screens/agent/JobDetailScreen';
import EarningsScreen from '@screens/agent/EarningsScreen';
import CreditsScreen from '@screens/wallet/CreditsScreen';
import PaymentMethodsScreen from '@screens/wallet/PaymentMethodsScreen';
import OrgRosterScreen from '@screens/agent/OrgRosterScreen';
import OrgMissionsScreen from '@screens/agent/OrgMissionsScreen';
import JobPortalScreen from '@screens/agent/JobPortalScreen';
import OrgEarningsScreen from '@screens/agent/OrgEarningsScreen';
import OrgComplianceScreen from '@screens/agent/OrgComplianceScreen';
import OrgRegionScreen from '@screens/agent/OrgRegionScreen';
import OrgCreateCpoScreen from '@screens/agent/OrgCreateCpoScreen';
import OrgCpoMissionsScreen from '@screens/agent/OrgCpoMissionsScreen';
import OrgMissionDetailScreen from '@screens/agent/OrgMissionDetailScreen';
import IncomingOfferScreen from '@screens/agent/IncomingOfferScreen';
import IncomingOfferWatcher from '@screens/agent/IncomingOfferWatcher';
// Step 19 — the dedicated 5-tab Departmental module. The member/manager
// attendance + incident + channels + vault screens now live INSIDE this shell
// (reached via the dashboard's single "Departmental" entry), not as scattered
// flat routes here.
import DepartmentalNavigator from './DepartmentalNavigator';
import MissionSummaryScreen from '@screens/agent/MissionSummaryScreen';
import AgentVerificationStatusScreen from '@screens/agent/AgentVerificationStatusScreen';
import MessengerHomeScreen from '@screens/messenger/MessengerHomeScreen';
import ChatScreen from '@screens/messenger/ChatScreen';
import NewChatScreen from '@screens/messenger/NewChatScreen';
import ChatInfoScreen from '@screens/messenger/ChatInfoScreen';
import VaultScreen from '@screens/messenger/VaultScreen';
import VaultLockScreen from '@screens/messenger/VaultLockScreen';
import FileVaultPurchaseScreen from '@screens/messenger/FileVaultPurchaseScreen';
import VaultForgotScreen from '@screens/messenger/VaultForgotScreen';
import VaultOTPVerifyScreen from '@screens/messenger/VaultOTPVerifyScreen';
import VaultNewPinScreen from '@screens/messenger/VaultNewPinScreen';
import GroupsScreen from '@screens/messenger/GroupsScreen';
import FilesScreen from '@screens/messenger/FilesScreen';
import CallScreen from '@screens/messenger/CallScreen';
import GroupCallScreen from '@screens/messenger/GroupCallScreen';
import IncomingGroupCallScreen from '@screens/messenger/IncomingGroupCallScreen';
import IntelFeedScreen from '@screens/news/IntelFeedScreen';

const Stack = createNativeStackNavigator<AgentStackParamList>();

export default function AgentNavigator() {
  // Brand-new agents land on screen 01 (AgentTypeSelect) and walk the
  // 9-screen onboarding. Activated agents navigate back to AgentDashboard
  // which remains registered in this stack.
  return (
    <>
      {/* Step 20 — agency-wide incoming-offer interrupt (poll-based; self-disables for
          non-agency callers). Renders nothing; deep-links into IncomingOffer on a new offer. */}
      <IncomingOfferWatcher />
    <Stack.Navigator
      initialRouteName="AgentTypeSelect"
      screenOptions={{
        headerStyle: {backgroundColor: Colors.surface},
        headerTintColor: Colors.textPrimary,
        headerShadowVisible: false,
        contentStyle: {backgroundColor: Colors.background},
        // Round 7 / back-button audit — enable Android swipe-back.
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
      }}>
      <Stack.Screen
        name="AgentDashboard"
        component={AgentDashboardScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentRegistration"
        component={AgentRegistrationScreen}
        options={{title: 'Agent Registration'}}
      />
      <Stack.Screen
        name="AgentTypeSelect"
        component={AgentTypeSelectScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentRegistrationWizard"
        component={AgentRegistrationWizardScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentCoverage"
        component={AgentCoverageScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentAvailability"
        component={AgentAvailabilityScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentDocsUpload"
        component={AgentDocsUploadScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentAdminApproval"
        component={AgentAdminApprovalScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentDeploymentRequirements"
        component={AgentDeploymentRequirementsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="MissionLeadConsole"
        component={MissionLeadConsoleScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentLiveTracker"
        component={AgentLiveTrackerScreen}
        options={{headerShown: false, animation: 'fade'}}
      />
      <Stack.Screen
        name="AgentHome"
        component={AgentHomeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentKYC"
        component={AgentKYCScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentVerified"
        component={AgentVerifiedScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentRejected"
        component={AgentRejectedScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="JobMarketplace"
        component={JobMarketplaceScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="JobDetail"
        component={JobDetailScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Earnings"
        component={EarningsScreen}
        options={{headerShown: false}}
      />
      {/* Wallet top-up (audit F-04) — purchase must be reachable for agency/
          CPO roles, not just clients. Same screens the client stack uses. */}
      <Stack.Screen
        name="Credits"
        component={CreditsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="PaymentMethods"
        component={PaymentMethodsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgRoster"
        component={OrgRosterScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgMissions"
        component={OrgMissionsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="JobPortal"
        component={JobPortalScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgEarnings"
        component={OrgEarningsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgCompliance"
        component={OrgComplianceScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgRegion"
        component={OrgRegionScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="IncomingOffer"
        component={IncomingOfferScreen}
        // Full-screen interrupt — no swipe-back mid-decision; the screen itself handles
        // Accept/Decline/passed exits.
        options={{headerShown: false, gestureEnabled: false, animation: 'fade'}}
      />
      <Stack.Screen
        name="OrgCreateCpo"
        component={OrgCreateCpoScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgCpoMissions"
        component={OrgCpoMissionsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OrgMissionDetail"
        component={OrgMissionDetailScreen}
        options={{headerShown: false}}
      />
      {/* Dept Chat v2 (Step 19) — the dedicated Departmental module. All member +
          manager attendance/incident/channels/vault screens are reused INSIDE
          this 5-tab shell; the company/manager lands role-branched on its manager
          roots. Pushed full-screen so its own footer is the only one shown. */}
      <Stack.Screen name="Departmental" component={DepartmentalNavigator} options={{headerShown: false}} />
      <Stack.Screen
        name="MissionSummary"
        component={MissionSummaryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AgentVerificationStatus"
        component={AgentVerificationStatusScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen name="MessengerHome"      component={MessengerHomeScreen}      options={{headerShown: false}} />
      {/* MX-13 — mirror MessengerNavigator's chat polish (freeze + native
          slide) so agency-shell chats get the same transition + stop
          rendering behind the pushed screen. */}
      <Stack.Screen name="Chat"               component={ChatScreen}               options={{headerShown: false, freezeOnBlur: true, animation: 'slide_from_right', animationDuration: 220}} />
      <Stack.Screen name="NewChat"            component={NewChatScreen}            options={{headerShown: false}} />
      <Stack.Screen name="ChatInfo"           component={ChatInfoScreen}           options={{headerShown: false}} />
      <Stack.Screen name="VaultLock"          component={VaultLockScreen}          options={{headerShown: false}} />
      <Stack.Screen name="VaultScreen"        component={VaultScreen}              options={{headerShown: false}} />
      <Stack.Screen name="FileVaultPurchase"  component={FileVaultPurchaseScreen}  options={{headerShown: false}} />
      <Stack.Screen name="VaultForgot"        component={VaultForgotScreen}        options={{headerShown: false}} />
      <Stack.Screen name="VaultOTPVerify"     component={VaultOTPVerifyScreen}     options={{headerShown: false}} />
      <Stack.Screen name="VaultNewPin"        component={VaultNewPinScreen}        options={{headerShown: false}} />
      <Stack.Screen name="Groups"             component={GroupsScreen}             options={{headerShown: false}} />
      <Stack.Screen name="Files"              component={FilesScreen}              options={{headerShown: false}} />
      <Stack.Screen name="VoiceCall"          component={CallScreen}               options={{headerShown: false}} />
      <Stack.Screen name="CallScreen"         component={CallScreen}               options={{headerShown: false, animation: 'fade'}} />
      <Stack.Screen name="GroupCallScreen"    component={GroupCallScreen}          options={{headerShown: false, animation: 'fade'}} />
      <Stack.Screen name="IncomingGroupCallScreen" component={IncomingGroupCallScreen} options={{headerShown: false, animation: 'fade', presentation: 'modal'}} />
      <Stack.Screen name="IntelFeed"          component={IntelFeedScreen}          options={{headerShown: false}} />
    </Stack.Navigator>
    </>
  );
}
