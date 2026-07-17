import React, {useEffect} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Platform, InteractionManager, Image, AppState, BackHandler, type ViewStyle} from 'react-native';
import {createBottomTabNavigator, type BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {getFocusedRouteNameFromRoute, CommonActions, useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useAuthStore} from '@store/authStore';
import {useProductStore} from '@store/productStore';
import {pendingProvider} from '@store/pendingProvider';
import {pendingTier} from '@store/pendingTier';
import {effectiveTier} from '@utils/tier';
import TierPaywall from '@screens/pro/TierPaywall';
import {configureMessengerRuntime, getMessengerRuntime, _resetMessengerRuntime} from '@/modules/messenger/runtime';
import {setIncomingCallHandler, setCallOfferVerifier} from '@/modules/messenger/webrtc/callDispatcher';
import {setGroupCallRingHandler} from '@/modules/messenger/webrtc/groupCallRingDispatcher';
import {useMessengerStore, resolveDirectConversationIdFromState} from '@/modules/messenger/store';
import {useActivityStore} from '@store/activityStore';
import {API_BASE_URL, MSG_BASE_URL} from '@utils/constants';
import {onTierInsufficient, onAuthLost} from '@services/api';
import {navigationRef} from './navigationRef';
import {BravoFont} from '@/theme/bravo';
import type {MainTabParamList} from './types';

// XEd25519 (Curve25519) sender-cert public key, base64. Pinned at
// build time from EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64; the matching
// private key lives only in auth-service .env. The constant fallback
// matches the dev keypair in apps/auth-service/.env so the app boots
// out-of-the-box without env wiring — flip both before staging/prod.
const SENDER_CERT_PUBLIC_KEY_B64 =
  process.env.EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 ??
  '7uox+8+kRi7Sy3jb+ibmm+Dt2S/LPtSiT2hkF1GjjyQ=';

import ProductGateScreen from '@screens/auth/ProductGateScreen';
import MessengerNavigator from './MessengerNavigator';
import BookingNavigator from './BookingNavigator';
import ProfileScreen from '@screens/settings/ProfileScreen';
import AgentNavigator from './AgentNavigator';
import CpoNavigator from './CpoNavigator';
import CpoOnboardingNavigator from './CpoOnboardingNavigator';
import CpoActivationScreen from '@screens/cpo/CpoActivationScreen';
import AccessEndedScreen from '@screens/cpo/AccessEndedScreen';
import {resolveAuthedRoute} from './resolveRoute';

const Tab = createBottomTabNavigator<MainTabParamList>();

// Command Home obsidian background (matches DashboardScreen's local
// T.bg / the Bravo Command Home design tokens). Kept here so the tab
// bar + scene container can match the Home screen without pulling in
// DashboardScreen's local token block.
const HOME_BG = '#07090D';
// Universal footer palette — obsidian + platinum-cobalt, matching the Bravo
// Secure design handoff (no navy shade). The root tab bar is the app-wide
// footer, so these apply on every tab.
const FOOTER_ACCENT = '#5B8DEF';
const FOOTER_ACCENT_DEEP = '#2F5BE0';
const FOOTER_MUTE = 'rgba(180,188,204,0.45)';
const FOOTER_TEXT = '#F2F4F8';

type IconName = React.ComponentProps<typeof Icon>['name'];

const ICONS: Record<string, {default: IconName; active: IconName; label: string}> = {
  Dashboard:    {default: 'home-outline',            active: 'home',                  label: 'Home'},
  MessengerTab: {default: 'message-text-outline',    active: 'message-text',          label: 'Messenger'},
  SecureTab:    {default: 'shield-check-outline',    active: 'shield-check',          label: 'Secure'},
  AgentJobs:    {default: 'clipboard-list-outline',  active: 'clipboard-list',        label: 'Jobs'},
  ProfileTab:   {default: 'account-circle-outline',  active: 'account-circle',        label: 'Profile'},
};

// VBG screens render fullscreen (no root tab bar). Keep in sync with the
// VBG* routes registered in BookingNavigator.
const VBG_FULLSCREEN_ROUTES = new Set(['VBGHome', 'VBGMap', 'VBGSRA', 'VBGOSINT', 'VBGNearby', 'VBGGeoRisk', 'VBGEmergency']);

// Screens hosted in the SecureTab stack but reached FROM Profile — the footer
// should highlight PROFILE while these are open (not SECURE). Payment/booking
// flows (CreditPaywall, ProRetainers, ProPaywall) intentionally stay SECURE.
const PROFILE_HOSTED_ROUTES = new Set([
  'IndividualProfile', 'CorporateProfile', 'TripHistory', 'ProActivityHistory',
  // 'Credits' = Profile → Transaction History (wallet balance/batches), an
  // account-history view, so keep PROFILE highlighted like the others.
  'Credits', 'PaymentMethods',
]);

// B-91 M0 — per-product bottom-bar contents. Messenger owns its internal
// 5-tab bar so the root bar never shows there; Secure Services and VBG show
// Messenger (the communication MODULE) + Profile, per the spec's taskbars.
// VBG's own 3-tab footer renders on VBG screens (which hide this bar).
const PRODUCT_TABS: Record<string, ReadonlyArray<string>> = {
  messenger: ['MessengerTab'],
  secure: ['MessengerTab', 'ProfileTab'],
  vbg: ['MessengerTab', 'ProfileTab'],
};

function CustomTabBar({state, descriptors, navigation}: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const {user} = useAuthStore();
  const activeProduct = useProductStore(s => s.activeProduct);
  const userInitials = (user?.full_name ?? user?.email ?? 'B')
    .split(/[\s@.]/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'B';
  // Honour per-screen `tabBarStyle: {display:'none'}` set from nested
  // stack screens (e.g. CallScreen wants full immersion). Without this
  // the custom bar always renders and ignores the option.
  const focusedRoute   = state.routes[state.index];
  const focusedOptions = descriptors[focusedRoute.key]?.options;
  const tabBarStyle = focusedOptions?.tabBarStyle as ViewStyle | undefined;
  if (tabBarStyle && tabBarStyle.display === 'none') {return null;}
  // Messenger owns its own internal tab bar (Chat / Groups / Call /
  // Files / News), so always hide the root app bar while inside that
  // nested stack. Belt-and-braces over `tabBarStyle` — some RN Nav
  // versions drop the style on deeply-nested descriptors.
  if (focusedRoute.name === 'MessengerTab') {return null;}

  // Profile-hosted screens (My Profile, My Bookings, Activity History, etc.)
  // physically live in the SecureTab/BookingNavigator stack, so the active
  // tab is SecureTab when they're open. Visually, though, the user came from
  // Profile — so highlight PROFILE, not SECURE, while one of these is focused.
  const secureNested = focusedRoute.name === 'SecureTab'
    ? getFocusedRouteNameFromRoute(focusedRoute)
    : undefined;
  const showProfileAsActive = !!secureNested && PROFILE_HOSTED_ROUTES.has(secureNested);

  // The footer is universally obsidian (#07090D) to match the Bravo Secure
  // design — same bar on every tab, no navy shade.
  return (
    <View style={[s.bar, {paddingBottom: Math.max(insets.bottom, 8) + 6}]}>
      <View style={s.hairline} />
      <View style={s.row}>
        {state.routes
          .filter(route => (PRODUCT_TABS[activeProduct ?? 'secure'] ?? []).includes(route.name))
          .map(route => {
          let focused = state.routes[state.index]?.key === route.key;
          // Override: while a profile-hosted screen is open inside SecureTab,
          // render PROFILE active and SECURE inactive.
          if (showProfileAsActive) {
            if (route.name === 'ProfileTab') {focused = true;}
            else if (route.name === 'SecureTab') {focused = false;}
          }
          const {options} = descriptors[route.key];
          const meta = ICONS[route.name] ?? ICONS.Dashboard;

          const iconName = focused ? meta.active : meta.default;
          const label    = options.tabBarLabel === 'Jobs' ? 'Jobs' : meta.label;

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress', target: route.key, canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          const isProfileTab = route.name === 'ProfileTab';

          return (
            <TouchableOpacity
              key={route.key}
              accessibilityRole="button"
              accessibilityState={focused ? {selected: true} : {}}
              onPress={onPress}
              activeOpacity={0.7}
              style={s.item}>
              {/* Top glow indicator — only visible on the active tab. */}
              {focused && <View style={s.activeIndicator} />}
              <View style={s.iconWrap}>
                {isProfileTab ? (
                  user?.avatar_url ? (
                    <Image
                      source={{uri: user.avatar_url}}
                      style={[s.profileAvatar, focused && s.profileAvatarActive]}
                    />
                  ) : (
                    <View style={[s.profileAvatar, s.profileAvatarFallback, focused && s.profileAvatarActive]}>
                      <Text style={s.profileAvatarText}>{userInitials}</Text>
                    </View>
                  )
                ) : (
                  <Icon
                    name={iconName}
                    size={22}
                    color={focused ? FOOTER_ACCENT : FOOTER_MUTE}
                  />
                )}
              </View>
              <Text style={[s.label, focused && s.labelActive]} numberOfLines={1}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function MainNavigator() {
  const {user} = useAuthStore();
  const recheckMembership = useAuthStore(s => s.recheckMembership);
  // B-91 M0 — which standalone product the client shell mounts. Adopt the
  // pre-auth selector choice once (no-op when an active product already
  // persists or nothing is pending).
  const activeProduct = useProductStore(s => s.activeProduct);
  const gateVisible = useProductStore(s => s.gateVisible);
  React.useEffect(() => {
    useProductStore.getState().adoptPendingProduct();
  }, []);

  // B-95 — the keyed remount of the tab tree below is NOT enough to reset it
  // on a product switch: React Navigation stores the nested navigator's state
  // on the parent 'Main' route, and a freshly-keyed navigator REHYDRATES that
  // state (all three products share route names, so it is always "valid"),
  // ignoring initialRouteName — the old product's screen survived the switch.
  // The library's own cleanup (useNavigationBuilder unmount → setTimeout(0) →
  // state=undefined) also skips itself when the replacement navigator has
  // already mounted. So: hold one navigator-free frame on switch, let the
  // deferred cleanup clear the slate, then mount the new product's tree.
  const [mountedProduct, setMountedProduct] = React.useState(activeProduct);
  useEffect(() => {
    if (mountedProduct === activeProduct) {return;}
    const t = setTimeout(() => setMountedProduct(activeProduct), 30);
    return () => clearTimeout(t);
  }, [mountedProduct, activeProduct]);

  const navigation = useNavigation<{setParams: (p: object) => void}>();
  // A provider who just signed up is still role='individual' until they create
  // their company agent. The persisted pendingProvider flag bridges that window
  // so they enter the agent flow (AgentTypeSelect → POST /agents → role flips)
  // instead of the client home. Cleared once the company agent exists.
  const [pendingProv, setPendingProv] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void pendingProvider.get().then(v => { if (alive) {setPendingProv(v);} });
    return () => { alive = false; };
  }, [user?.role]);

  // M1A rule 5 — the paid tier picked on the pre-auth plan screen. Loaded
  // async; 'unknown' keeps us from flashing the product gate for one frame
  // before the paywall on a fresh Pro/Enterprise signup. Resolved (subscribe
  // OR "Start as Lite today") → cleared and never asked again.
  const [pendingPaidTier, setPendingPaidTier] =
    React.useState<'unknown' | 'pro' | 'enterprise' | null>('unknown');
  React.useEffect(() => {
    let alive = true;
    void pendingTier.get().then(v => {
      if (!alive) {return;}
      // Already paid (re-login, ops grant, second device) — nothing to ask.
      if (v && effectiveTier(useAuthStore.getState().user) !== 'lite') {
        void pendingTier.clear();
        setPendingPaidTier(null);
        return;
      }
      setPendingPaidTier(v);
    });
    return () => { alive = false; };
  }, [user?.id]);
  const resolvePaywall = React.useCallback(() => {
    void pendingTier.clear();
    setPendingPaidTier(null);
    // Spec routing (M1A §2): Lite/Pro land on the Chat list; Enterprise stays
    // inside Messenger. Either way the tier flow enters the Messenger product
    // — the combined home no longer exists and the gate isn't re-asked here.
    useProductStore.getState().setActiveProduct('messenger');
  }, []);

  // RS-06 — refresh /auth/me whenever the app returns to the foreground, for
  // EVERY shell (not just the CPO shell). A server-side role / tier / membership
  // change made while the app was backgrounded otherwise stays invisible on a
  // warm app. recheckMembership re-pulls /auth/me (updating the local user →
  // resolveAuthedRoute re-routes) and, for a suspended/removed CPO, runs the
  // endCpoAccess teardown. Min-interval guarded so rapid fg/bg toggles don't
  // hammer the endpoint, and gated on an authenticated user so it never fires
  // on the login surface. No mount fire — addEventListener doesn't emit for the
  // already-'active' state, so this can't double-pull right after initialize().
  const lastMeRefresh = React.useRef(0);
  React.useEffect(() => {
    if (!user?.id) {return;}
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') {return;}
      const now = Date.now();
      if (now - lastMeRefresh.current < 30_000) {return;}
      lastMeRefresh.current = now;
      void recheckMembership();
    });
    return () => sub.remove();
  }, [user?.id, recheckMembership]);

  // VBG audit H-3 — resume the encrypted-telemetry loop on app boot for a
  // principal already enrolled in monitoring (no-op when no key is stored).
  useEffect(() => {
    if (!user?.id) {return;}
    void import('@/services/vbgTelemetry').then(m => m.ensureVbgTelemetry()).catch(() => {});
  }, [user?.id]);

  // §35A §B — route off the SERVER-authenticated account_kind (never a client flag).
  // pendingProvider + the legacy role strings survive only as the agency self-signup
  // fallback (resolveAuthedRoute folds them in). Decided once here; the branch happens
  // after the messenger-runtime bootstrap below so a CPO's Ops Room comms still warm up.
  const authedRoute = resolveAuthedRoute({
    accountKind:     user?.account_kind,
    mustSetPassword: user?.must_set_password,
    membershipStatus: user?.membership_status,
    cpoNeedsOnboarding: user?.cpo_needs_onboarding,
    legacyRole:      user?.role,
    pendingProvider: pendingProv,
  });

  // Audit F-05 — a Pro-gated 403 (tier_insufficient) anywhere in the app
  // routes the CLIENT into the Pro paywall instead of failing silently.
  // Provider shells (cpo/agency) have no paywall route, so no-op there.
  const isClientShell = !['access-ended', 'cpo-activation', 'cpo-onboarding', 'cpo', 'agency'].includes(authedRoute as string);
  useEffect(() => {
    if (!isClientShell) {return;}
    return onTierInsufficient(() => {
      if (navigationRef.isReady()) {
        navigationRef.dispatch(
          CommonActions.navigate('Main', {screen: 'SecureTab', params: {screen: 'ProPaywall'}}),
        );
      }
    });
  }, [isClientShell]);

  // LB-API1 — a genuine session loss (revoked/absent refresh token; most often a
  // single-device takeover when the same account signs in elsewhere) clears the
  // tokens in the api interceptor. Without this the app would sit tokenless on a
  // booking screen and every call would 401 ("the API stopped working"). Tear the
  // session down so RootNavigator swaps to the login stack. Applies to ALL shells.
  useEffect(() => {
    return onAuthLost(() => {
      // signOut is idempotent + best-effort; guard so a burst of 401s (the live
      // screen fires several concurrent polls) triggers exactly one teardown.
      const st = useAuthStore.getState();
      if (st.isSigningOut || !st.isAuthenticated) {return;}
      void st.signOut();
    });
  }, []);

  // B-95 — hardware back at a product's ROOT re-opens the product gate
  // instead of closing the app (Main is the only root route, so there is
  // nothing to pop and Android would exit). Screen-level handlers (calls,
  // vault lock) register later and win first; while anything can pop we
  // return false so the container's own back handling runs. On the gate
  // itself this handler is unregistered — back there backgrounds the app,
  // the normal Android root behaviour.
  useEffect(() => {
    if (!isClientShell || !activeProduct || gateVisible) {return;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (navigationRef.isReady() && navigationRef.canGoBack()) {return false;}
      useProductStore.getState().requestGate();
      return true;
    });
    return () => sub.remove();
  }, [isClientShell, activeProduct, gateVisible]);

  // B-95 — deep-link navigates (incoming call / notification tap →
  // navigate('Main', {screen: 'MessengerTab', …})) leave those params ON the
  // Main route. A freshly-mounted nested navigator lets `params.screen`
  // override its initialRouteName, so a stale deep-link would re-aim every
  // later product switch at MessengerTab. Neutralize the nested params each
  // time the client tab tree goes hidden (gate or switch hold-frame);
  // anything that navigates AFTER this transition still lands normally.
  const treeHidden = !activeProduct || gateVisible || mountedProduct !== activeProduct;
  useEffect(() => {
    if (!isClientShell || !treeHidden) {return;}
    navigation.setParams({screen: undefined, params: undefined, initial: undefined, state: undefined});
  }, [isClientShell, treeHidden, navigation]);

  // Configure + pre-warm the messenger runtime the moment the Dashboard
  // paints, so the first tap on a Chat doesn't block on ~1s of pure-JS
  // libsignal keygen. Without configureMessengerRuntime() the runtime
  // falls through to loopback-memory mode and messages echo locally
  // instead of routing through the relay — see BRAVO-INTEL banner.
  useEffect(() => {
    if (!user?.id || !SENDER_CERT_PUBLIC_KEY_B64) {return;}
    // Isolation layer 3 (in-memory): wipe the Zustand store if a
    // *different* identity logs in. Keyed on a stable identifier
    // (email/phone) rather than user.id — auth-service mints a fresh
    // UUID on every re-register, which would otherwise wipe the store
    // for the same human in dev. Production identities are stable
    // either way.
    // L5 OWNERKEY-DRIFT-HISTORY-LOSS — PIN the SQLCipher persistence key to the
    // immutable user.id. The old `email ?? phone ?? id` chain silently re-keyed
    // the DB (and orphaned the user's chat history) whenever a re-login returned
    // a /me payload WITHOUT email — the reported "messages gone after logout/
    // login". We now resolve ownerKey ONCE per user.id and reuse it: existing
    // installs adopt their CURRENT email-based key on first run (no orphan),
    // and every later login is drift-proof regardless of payload completeness
    // or a later profile email change. Async (one AsyncStorage read) so the
    // body that configures the runtime runs after the pin resolves.
    const userId = user.id;
    const computedOwnerKey = user.email ?? user.phone_e164 ?? userId;
    let cancelled = false;
    let task: ReturnType<typeof InteractionManager.runAfterInteractions> | null = null;
    void (async () => {
    let ownerKey = computedOwnerKey;
    try {
      const pinned = await AsyncStorage.getItem(`msg:ownerKey:${userId}`);
      if (pinned) {
        ownerKey = pinned;
      } else {
        await AsyncStorage.setItem(`msg:ownerKey:${userId}`, ownerKey);
      }
    } catch { /* storage blip — fall back to the computed key (no worse than before) */ }
    if (cancelled) {return;}
    const store = useMessengerStore.getState();
    store.setOwner(ownerKey);
    // Step 18 — scope the activity feed to this identity too, so a user switch on the
    // same device wipes the previous account's notifications inbox (P0 isolation).
    useActivityStore.getState().setOwner(ownerKey);
    // N-20 — hydrate the in-app bell from the durable server inbox now + on
    // every foreground, so a wake missed while killed/Dozed still backfills.
    try {
      const {startActivitySync} = require('@store/activitySync') as typeof import('@store/activitySync');
      startActivitySync();
    } catch { /* non-fatal — local activity still renders */ }
    // Also tear down the runtime singleton so the new user gets a fresh
    // SQLCipher DB opened with their own key, not the previous user's.
    _resetMessengerRuntime();
    // socket.io-client accepts the http(s) base URL + strips `/ws`
    // internally, so we hand it the same messenger base URL — the path
    // is configured inside TransportClient.
    const wsUrl = `${MSG_BASE_URL.replace(/^http/, 'ws')}/ws`;
    configureMessengerRuntime({
      authBaseUrl:      API_BASE_URL,
      messengerBaseUrl: MSG_BASE_URL,
      wsUrl,
      getToken:         () => AsyncStorage.getItem('auth:access_token'),
      // Round 2 fix: drive the single-flight refresh chain so the
      // KeysHttpClient / SenderCertClient / RelayHttpClient 401 retry
      // paths actually fire. Lazy-required to avoid a boot-time cycle.
      refreshToken:     () => {

        const {refreshAccessTokenShared} = require('@/services/api') as typeof import('@/services/api');
        return refreshAccessTokenShared();
      },
      authorityPubKeyB64: SENDER_CERT_PUBLIC_KEY_B64,
      ownUserId:        userId,
      // Stable persistence key — matches the messengerStore vault key,
      // so SQLCipher messages stay paired with the conversation list
      // even if user.id rotates across re-registrations.
      ownerKey,
    });
    task = InteractionManager.runAfterInteractions(() => {
      // CRITICAL ORDER: probe for backup BEFORE the messenger runtime
      // boots. Reason: buildProductionRuntime() unconditionally calls
      // installIdentity(), which auto-creates a fresh Signal identity
      // when the local store has none. After that, "no local identity"
      // is no longer a detectable state — the runtime always has one.
      //
      // So if a user clears app data with a server backup in place, the
      // post-runtime probe always returned "case B — backup + local
      // identity" (the freshly-installed one) and skipped the restore
      // screen. The user then saw the BackupSetup prompt and lost their
      // chats.
      //
      // Fix: peek the keychain BEFORE runtime init. Empty keychain +
      // backup-on-server → push BackupRestore, which will install the
      // OLD identity from the wrapped backup, then init the runtime.
      // Otherwise just init the runtime as before.

      const {runBackupBoot} = require('@/modules/messenger/backup/backupBoot') as typeof import('@/modules/messenger/backup/backupBoot');
      void runBackupBoot(navigationRef, {ownerKey, legacyOwnerId: userId, getMessengerRuntime})
        .catch(e => console.warn('[MainNavigator] backup boot failed:', (e as Error).message));
      // FCM bootstrap — request POST_NOTIFICATIONS on Android 13+,
      // grab the FCM token, POST to /push/register-voip so the gateway
      // can VoIP-wake this device for inbound 1:1 / group calls. Idempotent.

      const {startFcmBootstrap} = require('@/modules/messenger/push/fcmBootstrap') as typeof import('@/modules/messenger/push/fcmBootstrap');
      void startFcmBootstrap().catch(e =>
        console.warn('[MainNavigator] FCM bootstrap failed:', (e as Error).message));
    });
    })();
    return () => { cancelled = true; task?.cancel(); };
    // user.email + user.phone_e164 derive into ownerKey; we
    // intentionally re-init only on user.id change so a profile
    // edit doesn't trigger a full SQLCipher re-open + WS reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Wire the global incoming-call handler. Without this the dispatcher
  // silently drops every `call.offer` whose callId isn't already
  // registered locally — the symptom is "I called but the other phone
  // never rang." Navigates to CallScreen with direction='incoming' so
  // the ringing UI mounts and useCall picks up the offer SDP.
  useEffect(() => {
    if (!user?.id) {return;}
    setIncomingCallHandler((data) => {
      if (!navigationRef.isReady()) {return;}
      // Resolve the CANONICAL conversation for this peer (the server-UUID row if one already
      // exists) instead of a fresh `direct:<peer>` synthetic — otherwise every inbound call spawns
      // a DUPLICATE thread next to the real chat (named with the raw user-id hex) and the call
      // record lands in the duplicate. Mirrors the message send/receive resolver paths.
      const store = useMessengerStore.getState();
      const conversationId = resolveDirectConversationIdFromState(store, data.from.userId);
      // Prefer the real chat name for the CallKit / lock-screen label; short id only for a
      // genuinely-new contact whose name we don't know yet.
      const callerName = store.conversations[conversationId]?.name ?? data.from.userId.slice(0, 8);
      // CallKit/Telecom bridge — system UI for inbound calls. Layered
      // alongside the existing notifee path on Android (de-duped by
      // callId). iOS stays skeleton-inert until the VoIP cert lands.
      // The same cache the Telecom event handlers consume is also
      // populated here so a foreground / warm-running incoming call
      // can be answered/declined from the lock-screen UI.
      try {

        const {reportIncomingCall} = require('@/modules/messenger/push/callKitBridge') as typeof import('@/modules/messenger/push/callKitBridge');

        const cache = require('@/modules/messenger/push/incomingCallCache') as typeof import('@/modules/messenger/push/incomingCallCache');
        cache.setIncomingCallPayload({
          callId:         data.callId,
          callerName,
          kind:           data.kind === 'video' ? 'video' : 'voice',
          fromUserId:     data.from.userId,
          remoteDeviceId: data.from.deviceId,
          incomingSdp:    data.sdp,
          conversationId,
        });
        reportIncomingCall({
          callId:     data.callId,
          callerName,
          kind:       data.kind === 'video' ? 'video' : 'voice',
        });
      } catch (e) { console.warn('[MainNavigator] callkit + cache failed:', (e as Error).message); }

      // EDGE CASE: user is mid group call when a 1:1 offer lands.
      // WhatsApp-style: instead of yanking them away from the group
      // call (which would tear it down without consent), publish to
      // the in-call banner registry so GroupCallScreen can render an
      // accept/decline overlay. Accept hangs up the group call THEN
      // navigates to CallScreen; decline sends call.hangup so the
      // offerer doesn't keep ringing forever. Without this branch
      // the receiver's app silently switches surfaces and the group
      // call's leave path never runs — peers see the receiver as a
      // black tile that won't go away.

      const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
      if (groupReg.getActiveGroupCall()) {

        const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof import('@/modules/messenger/webrtc/incomingOneToOneBanner');
        // Hangup any older banner before replacing — only the latest
        // ring is shown, mirroring WhatsApp.
        const prev = banner.getPendingOneToOne();
        if (prev && prev.callId !== data.callId) {
          try {

            const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
            const tx = reg.getLiveTransport();
            tx?.send({event: 'call.hangup', data: {callId: prev.callId, to: prev.from, reason: 'busy'}} as never);
          } catch { /* fire-and-forget */ }
        }
        banner.setPendingOneToOne(data);
        return;
      }

      // Audit CALL-N10 (2026-07-02): a SECOND inbound 1:1 while already on a
      // 1:1 call must NOT hijack the screen. The old code navigated to
      // CallScreen with the new call's params, which re-keyed useCall's boot
      // deps → its cleanup ran controller.hangup('ended') and tore down the
      // LIVE call (the current peer got dropped) so the new ring could take
      // over, with no choice offered. Auto-reply busy to the new caller and
      // stay on the current call — mirrors the group-call branch above. (A
      // full accept-and-end / call-waiting banner is a follow-up.)
      {
        const callReg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const liveCall = callReg.getActiveCall();
        if (liveCall && liveCall.callId !== data.callId) {
          try {
            const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
            const tx = reg.getLiveTransport();
            tx?.send({event: 'call.hangup', data: {callId: data.callId, to: data.from, reason: 'busy'}} as never);
          } catch { /* fire-and-forget */ }
          return;
        }
      }

      // Auto-create a row ONLY for a genuinely-new contact — i.e. the resolver returned a
      // synthetic `direct:<peer>` key AND no row exists yet. If an existing UUID (or synthetic)
      // row was resolved above, we reuse it and NEVER spawn a duplicate. A cold contact still
      // needs a row so the call-record bubble has somewhere to land.
      if (conversationId.startsWith('direct:') && !store.conversations[conversationId]) {
        store.upsertConversation({
          id:             conversationId,
          type:           'direct',
          name:           data.from.userId.slice(0, 8), // best-effort label until profile fetch fills it in
          participants:   [data.from.userId],
          unread_count:   0,
          is_muted:       false,
          created_at:     new Date().toISOString(),
          peer:           {userId: data.from.userId, deviceId: data.from.deviceId},
          session_state:  'fresh',
        });
      }

      // Cast through `as unknown as never` because navigationRef.navigate
      // has a deeply nested type union for nested-stack params and TS5's
      // tuple narrowing can't satisfy both overloads at once. The single-
      // `as never` cast resolved to the [never, never] overload, which
      // then rejected the params object. Two-step cast bypasses that.
      (navigationRef.navigate as (name: string, params?: unknown) => void)('Main', {
        screen: 'MessengerTab',
        params: {
          screen: 'CallScreen',
          params: {
            callType:       data.kind,
            isIncoming:     true,
            conversationId,
            callId:         data.callId,
            remoteUserId:   data.from.userId,
            remoteDeviceId: data.from.deviceId,
            incomingSdp:    data.sdp,
          },
        },
      });
    });
    return () => setIncomingCallHandler(null);
  }, [user?.id]);

  // Audit S7 — install the caller-identity verifier for inbound 1:1
  // call.offer frames. Runs alongside setIncomingCallHandler; the
  // dispatcher invokes the verifier BEFORE the handler so a spoofed
  // offer never reaches the navigation root. Verifier is async so we
  // import lazily — the @bravo/messenger-core helper itself is sync to
  // import but pulling it at module top-level creates a circular load
  // with the messenger runtime on cold start.
  useEffect(() => {
    if (!user?.id) {return;}
    const selfUserId   = user.id;
    const selfDeviceId = 1; // Phase-1 single-device, mirrors signalDeviceId default
    setCallOfferVerifier(async (offer) => {
      // Audit Round-2 P0-C1 — fail-CLOSED on missing auth. A compromised
      // gateway (or any insider with WS access) could otherwise mint a
      // call.offer attributing it to any user, ring the callee's screen
      // with a spoofed identity, and — on accept — establish DTLS-SRTP
      // to the attacker. The signed `auth` block (XEd25519 sender cert
      // + AAD over callId/from/to/kind/ts) is the only end-to-end check
      // that the offer actually came from the named caller. Emergency
      // rollback for a legacy client surfacing in the wild:
      //   EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER=true
      // Default is reject so the policy is safe even if the env is
      // never set.
      if (!offer.auth) {
        const legacyOk = (process.env.EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER ?? '') === 'true';
        if (legacyOk) {
          console.warn(`[bravo.callDispatcher] inbound call.offer carries no auth block (cid=${offer.callId.slice(0, 8)} from=${offer.from.userId.slice(0, 8)}) — accepting under EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER legacy flag`);
          return {ok: true};
        }
        return {ok: false, reason: 'missing_auth'};
      }
      try {
        const {verifyCallOfferAuth} = require('@bravo/messenger-core') as typeof import('@bravo/messenger-core');
        const result = await verifyCallOfferAuth({
          auth: offer.auth,
          wire: {callId: offer.callId, from: offer.from, kind: offer.kind},
          self: {userId: selfUserId, deviceId: selfDeviceId},
          authorityPubKeyB64: SENDER_CERT_PUBLIC_KEY_B64,
        });
        return result.ok ? {ok: true} : {ok: false, reason: result.reason};
      } catch (e) {
        return {ok: false, reason: `verifier_threw:${(e as Error).message}`};
      }
    });
    return () => setCallOfferVerifier(null);
  }, [user?.id]);

  // Group-call ring handler. Server fans `sfu.ring.incoming` to every
  // recipient's userRoom when one member taps the phone icon. We wake
  // the IncomingGroupCallScreen so it can play the ringtone + show
  // accept/decline. Cancel/decline frames are handled by the screen
  // itself (it registers its own handler in the same multi-subscriber
  // dispatcher).
  useEffect(() => {
    if (!user?.id) {return;}
    const unsub = setGroupCallRingHandler({
      onIncoming: (ring) => {
        if (!navigationRef.isReady()) {return;}
        // B-08 — suppress duplicate rings (server re-fan-out, the host's
        // own ring echoing back, or a presence/ring race) that would
        // navigate over an in-progress GroupCallScreen and abort its join.
        const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
        const active = groupReg.getActiveGroupCall();
        const route  = navigationRef.getCurrentRoute();
        const routeRoomId = (route?.params as {roomId?: string} | undefined)?.roomId;
        if (!groupReg.shouldNavigateForRing(ring.roomId, active?.roomId ?? null, route?.name, routeRoomId)) {
          return;
        }
        // Why: navigationRef.navigate's nested-stack param union can't be
        // satisfied by the single-step cast (TS2352); two-step bypass.
        (navigationRef.navigate as unknown as (name: string, params?: unknown) => void)('Main', {
          screen: 'MessengerTab',
          params: {
            screen: 'IncomingGroupCallScreen',
            params: {
              roomId:         ring.roomId,
              conversationId: ring.conversationId,
              callType:       ring.callType,
              callerName:     ring.callerName,
              fromUserId:     ring.from.userId,
              // Audit row #5 — thread the per-recipient room-token
              // through ring → IncomingGroupCallScreen → GroupCall-
              // Screen → sfu.join. Server requires this echo when
              // SFU_ROOM_TOKEN_SECRET is configured.
              roomToken:      ring.roomToken,
            },
          },
        });
      },
      onCancel:  () => { /* IncomingGroupCallScreen handles its own cancel */ },
      onDecline: () => { /* IncomingGroupCallScreen handles its own decline */ },
    });
    return unsub;
  }, [user?.id]);

  // §35A §B — mount exactly one shell by account_kind.
  //   access-ended → a suspended/removed CPO (covers boot/login as already-revoked).
  //   cpo-activation → first login, set password before the home.
  //   cpo → the managed-guard shell (CpoNavigator).
  //   agency → the 9-screen Agent Portal (AgentNavigator) — also the legacy/pendingProvider fallback.
  //   client → the consumer tabs below.
  if (authedRoute === 'access-ended') {
    return <AccessEndedScreen />;
  }
  if (authedRoute === 'cpo-activation') {
    return <CpoActivationScreen />;
  }
  if (authedRoute === 'cpo-onboarding') {
    return <CpoOnboardingNavigator />;
  }
  if (authedRoute === 'cpo') {
    return <CpoNavigator />;
  }
  if (authedRoute === 'agency') {
    return <AgentNavigator />;
  }

  // M1A rule 5 — the end-of-signup subscription ask. Shown once, before the
  // shell, when a paid tier was picked pre-auth and the account is still
  // effectively Lite (an already-paid account skips straight through).
  // Declining is first-class: "Start as Lite today" lands a working Lite
  // account; tier changes live in Settings → Pricing thereafter.
  if (pendingPaidTier === 'unknown') {
    return <View style={{flex: 1, backgroundColor: HOME_BG}} />;
  }
  if (pendingPaidTier) {
    return <TierPaywall tier={pendingPaidTier} standalone onDone={resolvePaywall} />;
  }

  // B-91 M0 — client accounts live inside ONE standalone product at a time.
  // No persisted product yet (fresh installs + every pre-split account) →
  // the product gate. There is no combined home to fall back to. B-95 also
  // re-opens the gate on demand (drawer "Choose dashboard" / back at a
  // product root) — unmounting the tab tree here is what lets its nested
  // navigation state clear before the next product mounts.
  if (!activeProduct || gateVisible) {
    return <ProductGateScreen />;
  }

  // B-95 — one navigator-free frame per product switch so the previous
  // product's nested state finishes cleaning up (see effect above).
  if (mountedProduct !== activeProduct) {
    return <View style={{flex: 1, backgroundColor: HOME_BG}} />;
  }

  return (
    <Tab.Navigator
      // Why: keying by product remounts the whole tab tree on a product
      // switch — the old product's navigation stacks die with it, which IS
      // the spec's back-stack-reset rule (no reset() bookkeeping to drift).
      key={activeProduct}
      initialRouteName={activeProduct === 'messenger' ? 'MessengerTab' : 'SecureTab'}
      tabBar={renderCustomTabBar}
      // Scene background = obsidian so the Command Home status-bar / safe-
      // area zone reads near-black instead of the default navy stage. Other
      // tabs paint their own background on top, so this only shows through
      // on Home (which is intentionally #07090D).
      sceneContainerStyle={{backgroundColor: HOME_BG}}
      // BS-TABBACK — back from a non-Home tab (e.g. Messenger) returns to
      // the previously-focused tab instead of EXITING the app. Default
      // bottom-tab back behaviour let a back-swipe out of Messenger close
      // the app entirely. `history` walks the tab-focus history back to
      // Dashboard/Home, matching WhatsApp/standard Android expectations.
      backBehavior="history"
      screenOptions={{headerShown: false}}>
      {/* B-91 M0 — the combined command home (Dashboard) is no longer a
          route: the spec deletes it. Its SOS duty lives on in the VBG
          hold-to-alert; the screen file stays in-tree pending INDEX Q8. */}
      <Tab.Screen name="MessengerTab" component={MessengerNavigator} options={{tabBarLabel: 'Messenger', tabBarStyle: {display: 'none'}}} />
      <Tab.Screen
        name="SecureTab"
        component={BookingNavigator}
        // VBG product opens straight onto the VBG dashboard; Secure opens
        // on the booking home (its registered initial route).
        initialParams={activeProduct === 'vbg' ? {screen: 'VBGHome'} : undefined}
        options={({route}) => ({
          tabBarLabel: 'Secure',
          // VBG screens go fullscreen — hide the root tab bar when the
          // nested focused route is any VBG* screen.
          tabBarStyle: VBG_FULLSCREEN_ROUTES.has(getFocusedRouteNameFromRoute(route) ?? '')
            ? {display: 'none'}
            : undefined,
        })}
        listeners={({navigation: nav}) => ({
          // Land on the product's root when re-entered via the bar —
          // booking home for Secure Services, VBG dashboard for VBG.
          tabPress: e => {
            e.preventDefault();
            nav.navigate('SecureTab', {
              screen: activeProduct === 'vbg' ? 'VBGHome' : 'BookingHome',
            });
          },
        })}
      />
      <Tab.Screen name="ProfileTab"   component={ProfileScreen}      options={{tabBarLabel: 'Profile'}} />
    </Tab.Navigator>
  );
}

// Hoisted out of MainNavigator so React doesn't see a fresh component
// type on every parent render (which would unmount/remount the entire
// tab bar subtree and lose its animation/state).
function renderCustomTabBar(props: React.ComponentProps<typeof CustomTabBar>): React.ReactElement {
  return <CustomTabBar {...props} />;
}

const s = StyleSheet.create({
  bar: {
    backgroundColor: HOME_BG,
    paddingTop: 14,
    ...Platform.select({
      ios: {
        shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 18,
        shadowOffset: {width: 0, height: -6},
      },
      android: {elevation: 20},
    }),
  },
  // Thin top-edge hairline — fades at the edges like the design atom.
  hairline: {
    height: 1, marginHorizontal: 20, marginBottom: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 8,
  },
  item: {
    flex: 1, alignItems: 'center', justifyContent: 'flex-start',
    paddingVertical: 2,
    position: 'relative',
  },
  // Blue glowing indicator pip above the icon — only shown on active.
  activeIndicator: {
    position: 'absolute', top: -14, width: 26, height: 2.5, borderRadius: 2,
    backgroundColor: FOOTER_ACCENT,
    shadowColor: FOOTER_ACCENT, shadowOpacity: 1, shadowRadius: 12, shadowOffset: {width: 0, height: 0}, elevation: 6,
  },
  iconWrap: {
    width: 28, height: 28,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 5,
  },
  iconWrapActive: {},  // (legacy — kept for any outside refs, no effect)
  label: {
    fontFamily: BravoFont.sans,
    fontSize: 10, fontWeight: '600', letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: FOOTER_MUTE,
  },
  labelActive: {color: FOOTER_TEXT},
  profileAvatar: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  profileAvatarActive: {
    backgroundColor: FOOTER_ACCENT_DEEP,
    borderColor: FOOTER_ACCENT,
  },
  profileAvatarFallback: {
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarText: {
    fontFamily: BravoFont.sans,
    color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.3,
  },
});
