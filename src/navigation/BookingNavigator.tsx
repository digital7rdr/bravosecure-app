import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {BookingStackParamList} from './types';
import {Colors} from '@theme/colors';

import BookingHomeScreen from '@screens/booking/BookingHomeScreen';
import ProDashboardScreen from '@screens/pro/ProDashboardScreen';
import ZoneMapScreen from '@screens/booking/ZoneMapScreen';
import AddOnsScreen from '@screens/booking/AddOnsScreen';
import BookingConfirmationScreen from '@screens/booking/BookingConfirmationScreen';
import TripSummaryScreen from '@screens/booking/TripSummaryScreen';
import BookingHistoryScreen from '@screens/booking/BookingHistoryScreen';
import MissionCompleteScreen from '@screens/booking/MissionCompleteScreen';
import InvoiceScreen from '@screens/booking/InvoiceScreen';
import RateAgencyScreen from '@screens/booking/RateAgencyScreen';
import SettingsScreen from '@screens/settings/SettingsScreen';
import CreditsScreen from '@screens/wallet/CreditsScreen';
import PaymentMethodsScreen from '@screens/wallet/PaymentMethodsScreen';
import LiveTrackingScreen from '@screens/liveops/LiveTrackingScreen';
import SOSScreen from '@screens/liveops/SOSScreen';
import ItineraryUploadScreen from '@screens/pro/ItineraryUploadScreen';
import TripHistoryScreen from '@screens/pro/TripHistoryScreen';
import VBGHomeScreen from '@screens/vbg/VBGHomeScreen';
import VBGMapScreen from '@screens/vbg/VBGMapScreen';
import VBGSRAScreen from '@screens/vbg/VBGSRAScreen';
import VBGOSINTScreen from '@screens/vbg/VBGOSINTScreen';
import VBGNearbyScreen from '@screens/vbg/VBGNearbyScreen';
import VBGGeoRiskScreen from '@screens/vbg/VBGGeoRiskScreen';
import VBGEmergencyScreen from '@screens/vbg/VBGEmergencyScreen';
import ProRetainersScreen from '@screens/pro/ProRetainersScreen';
import ProClientProfileScreen from '@screens/pro/ProClientProfileScreen';
import ProTeamConfigScreen from '@screens/pro/ProTeamConfigScreen';
import ProAISchedulingScreen from '@screens/pro/ProAISchedulingScreen';
import ProRiskReviewScreen from '@screens/pro/ProRiskReviewScreen';
import ProAssignedTeamScreen from '@screens/pro/ProAssignedTeamScreen';
import ProLiveMissionScreen from '@screens/pro/ProLiveMissionScreen';
import IndividualProfileScreen from '@screens/settings/IndividualProfileScreen';
import CorporateProfileScreen from '@screens/settings/CorporateProfileScreen';
import OpsDashboardScreen from '@screens/ops/OpsDashboardScreen';
import OpsMissionDetailScreen from '@screens/ops/OpsMissionDetailScreen';
import OpsRoomReviewScreen from '@screens/ops/OpsRoomReviewScreen';
import ProActivityHistoryScreen from '@screens/pro/ProActivityHistoryScreen';
import ProLandingScreen from '@screens/pro/ProLandingScreen';
import CreditPaywallScreen from '@screens/booking/CreditPaywallScreen';
import ProPaywallScreen from '@screens/pro/ProPaywallScreen';
import PricingScreen from '@screens/settings/PricingScreen';
import TierPaywallScreen from '@screens/pro/TierPaywallScreen';
import ServiceTypeScreen from '@screens/booking/ServiceTypeScreen';
import BaselinePackageScreen from '@screens/booking/BaselinePackageScreen';
import CustomizeAddOnsScreen from '@screens/booking/CustomizeAddOnsScreen';
import BookingDateTimeScreen from '@screens/booking/BookingDateTimeScreen';
import LocationPickerScreen from '@screens/booking/LocationPickerScreen';
import FindingDetailScreen from '@screens/booking/FindingDetailScreen';
import NoDetailScreen from '@screens/booking/NoDetailScreen';
import AgencyAcceptedScreen from '@screens/booking/AgencyAcceptedScreen';

const Stack = createNativeStackNavigator<BookingStackParamList>();

export default function BookingNavigator() {
  return (
    <Stack.Navigator
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
        name="BookingHome"
        component={BookingHomeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProDashboard"
        component={ProDashboardScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ItineraryUpload"
        component={ItineraryUploadScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="TripHistory"
        component={TripHistoryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="VBGHome"
        component={VBGHomeScreen}
        // animation:'none' — VBG screens are a footer "tab group"; a tab tap
        // should swap content instantly, not slide like a page push.
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGMap"
        component={VBGMapScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProRetainers"
        component={ProRetainersScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProClientProfile"
        component={ProClientProfileScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProTeamConfig"
        component={ProTeamConfigScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProAIScheduling"
        component={ProAISchedulingScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProRiskReview"
        component={ProRiskReviewScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProAssignedTeam"
        component={ProAssignedTeamScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProLiveMission"
        component={ProLiveMissionScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="VBGSRA"
        component={VBGSRAScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGOSINT"
        component={VBGOSINTScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGNearby"
        component={VBGNearbyScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGGeoRisk"
        component={VBGGeoRiskScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="VBGEmergency"
        component={VBGEmergencyScreen}
        options={{headerShown: false, animation: 'none'}}
      />
      <Stack.Screen
        name="IndividualProfile"
        component={IndividualProfileScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CorporateProfile"
        component={CorporateProfileScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ZoneMap"
        component={ZoneMapScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AddOns"
        component={AddOnsScreen}
        options={{title: 'Add-Ons'}}
      />
      <Stack.Screen
        name="BookingConfirmation"
        component={BookingConfirmationScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="TripSummary"
        component={TripSummaryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BookingHistory"
        component={BookingHistoryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="MissionComplete"
        component={MissionCompleteScreen}
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="Invoice"
        component={InvoiceScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="RateAgency"
        component={RateAgencyScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{headerShown: false}}
      />
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
        name="LiveTracking"
        component={LiveTrackingScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="SOSScreen"
        component={SOSScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OpsDashboard"
        component={OpsDashboardScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OpsMissionDetail"
        component={OpsMissionDetailScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="OpsRoomReview"
        component={OpsRoomReviewScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProActivityHistory"
        component={ProActivityHistoryScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProLanding"
        component={ProLandingScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CreditPaywall"
        component={CreditPaywallScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ProPaywall"
        component={ProPaywallScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Pricing"
        component={PricingScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="TierPaywall"
        component={TierPaywallScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="ServiceType"
        component={ServiceTypeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BaselinePackage"
        component={BaselinePackageScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="CustomizeAddOns"
        component={CustomizeAddOnsScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="BookingDateTime"
        component={BookingDateTimeScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="LocationPicker"
        component={LocationPickerScreen}
        options={{headerShown: false, presentation: 'modal', animation: 'slide_from_bottom'}}
      />
      {/* Step 19 — client auto-dispatch flow. Back-gesture is disabled on Finding while
          the search is live (managed inside the screen), so no swipe out mid-search. */}
      <Stack.Screen
        name="FindingDetail"
        component={FindingDetailScreen}
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="AgencyAccepted"
        component={AgencyAcceptedScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="NoDetail"
        component={NoDetailScreen}
        options={{headerShown: false}}
      />
    </Stack.Navigator>
  );
}
