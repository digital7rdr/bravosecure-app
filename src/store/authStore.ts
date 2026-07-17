import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import axios from 'axios';
import {Platform} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import {authApi, agentApi, getDeviceId, tokenStore, subscriptionApi, type ApiUser} from '@services/api';
import type {AccountKind, User, UserRole} from '@appTypes/index';
import {setUser as setObservabilityUser} from '@modules/observability';
import {pendingProvider} from '@store/pendingProvider';
// Type-only imports for the lazy `require(...)` calls inside signOut.
// We keep the require's so messenger modules don't get pulled into the
// bootstrap graph until logout actually runs (avoids circular boot-time
// dependencies between authStore and the runtime). The `import type *
// as` form is type-only at compile-time (no runtime value emitted) and
// is the form the lint config allows.
import type * as IncomingOneToOneBannerModule
  from '@/modules/messenger/webrtc/incomingOneToOneBanner';
import type * as CallRegistryModule
  from '@/modules/messenger/runtime/callRegistry';
import type * as GroupCallRegistryModule
  from '@/modules/messenger/runtime/groupCallRegistry';
import type * as BravoTonesModule
  from '@/modules/messenger/runtime/bravoTones';
import type * as ProductionRuntimeModule
  from '@/modules/messenger/runtime/productionRuntime';
import type * as RuntimeModule
  from '@/modules/messenger/runtime';
import type * as TransportRegistryModule
  from '@/modules/messenger/runtime/transportRegistry';
import type * as CallDispatcherModule
  from '@/modules/messenger/webrtc/callDispatcher';
import type * as SfuDispatcherModule
  from '@/modules/messenger/webrtc/sfuDispatcher';
import type * as GroupCallIdentityRegistryModule
  from '@/modules/messenger/webrtc/groupCallIdentityRegistry';
import type * as GroupCallRingDispatcherModule
  from '@/modules/messenger/webrtc/groupCallRingDispatcher';
import type * as RttRegistryModule
  from '@/modules/messenger/runtime/rttRegistry';
import type * as FcmBootstrapModule
  from '@/modules/messenger/push/fcmBootstrap';
import type * as MessageMirrorModule
  from '@/modules/messenger/backup/messageMirror';
import type * as MirrorBootstrapModule
  from '@/modules/messenger/backup/mirrorBootstrap';
import type * as IdentityBackupModule
  from '@/modules/messenger/backup/identityBackup';
import type * as MessengerStoreModule
  from '@/modules/messenger/store/messengerStore';
import type * as VoipWakeVerifyModule
  from '@/modules/messenger/push/voipWakeVerify';
import type * as UnregisterPushModule
  from '@/modules/messenger/push/unregisterPush';
import type * as WalletStoreModule from '@store/walletStore';
import type * as BookingStoreModule from '@store/bookingStore';

/**
 * Round 2 / Architecture audit fix: registration + verifyOtp used to
 * hard-code `platform: 'android'`, which meant iOS users were registered
 * as Android devices for FCM/APNs routing — push tokens went to the
 * wrong dispatcher and iOS users never received VoIP wakes. Use the
 * actual platform so the server's push.service.ts can route correctly.
 */
const DEVICE_PLATFORM: 'android' | 'ios' = Platform.OS === 'ios' ? 'ios' : 'android';

// Coerce API user (snake_case) into the mobile `User` model. The optional
// `kind` carries the server-computed app-routing fields from /auth/me (§35A):
// account_kind, org, must_set_password, membership_status — the discriminator the
// root routes off (never a client flag or JWT claim).
function toUser(
  u: ApiUser,
  kind?: {
    account_kind?: AccountKind;
    is_org_manager?: boolean;
    membership_status?: string | null;
    org?: {id: string; name: string} | null;
    must_set_password?: boolean;
    cpo_needs_onboarding?: boolean;
    auto_dispatch_enabled?: boolean;
  },
): User {
  return {
    id: u.id,
    email: u.email,
    phone_e164: u.phone_e164 ?? undefined,
    full_name: u.display_name,
    role: u.role as UserRole,
    subscription_tier: u.subscription_tier,
    pro_active_until: u.pro_active_until ?? null,
    account_kind: kind?.account_kind,
    is_org_manager: kind?.is_org_manager,
    membership_status: kind?.membership_status ?? null,
    org: kind?.org ?? null,
    must_set_password: kind?.must_set_password ?? false,
    // Routes a managed CPO to the document-upload onboarding until ops approves them.
    cpo_needs_onboarding: kind?.cpo_needs_onboarding ?? false,
    // Bug 1: server-driven auto-dispatch flag (replaces the build-time EXPO_PUBLIC_AUTO_DISPATCH).
    // Fail-closed to legacy: defaults false until /auth/me confirms it.
    auto_dispatch_enabled: kind?.auto_dispatch_enabled ?? false,
    avatar_url: u.avatar_url ?? undefined,
  } as unknown as User;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  // True only while signOut() is tearing the session down. Drives the
  // blocking "Signing out…" overlay (RootNavigator). Kept separate from
  // isLoading so it can't be cleared by a concurrent load and so the
  // overlay text/behaviour differs from the boot "Verifying session…" one.
  isSigningOut: boolean;
  // §35A §F — set true when a managed CPO's agency access has ended
  // (membership_status != 'active', or a 401/403 on the session re-check). Survives
  // signOut() so the RootNavigator can show AccessEndedScreen instead of the login
  // form. Cleared by clearAccessEnded() ("Return to sign in").
  accessEnded: boolean;
  error: string | null;
  pendingUserId: string | null;     // set between register/login and OTP verify
  pendingPhone: string | null;
}

interface AuthActions {
  initialize: () => Promise<void>;
  /** Step 1 of registration — only sends OTP; user row is NOT created yet. */
  register: (p: {
    email: string; password: string; fullName: string; phoneE164: string;
    role?: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise';
  }) => Promise<{phone: string}>;
  /** Step 2 of registration — verifies OTP AND creates the user atomically. */
  verifyRegister: (p: {
    email: string; password: string; fullName: string; phoneE164: string;
    role?: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise';
    code: string;
  }) => Promise<void>;
  login: (p: {email?: string; phoneE164?: string; password: string}) =>
    Promise<{userId: string | null; phone: string | null; devOtpCode?: string}>;
  verifyOtp: (userId: string, code: string) => Promise<void>;
  completeAuth: () => Promise<void>;
  /**
   * Sign in with biometric if a previous session's refresh token is
   * still on disk. Prompts device biometric; on success refreshes the
   * access token and pulls `/auth/me` without ever asking for password.
   * Returns true when the user is fully authenticated; false otherwise
   * (caller falls back to the password form).
   */
  biometricSignIn: () => Promise<boolean>;
  // `wipeAtRest` (default FALSE) — a plain "Sign out" now PRESERVES local history
  // (the SQLCipher message DB + keychain key, scoped to the stable owner key, are
  // left intact so re-login re-opens the same encrypted store and history returns).
  // Only an explicit "Remove account from this device" passes {wipeAtRest:true} to
  // run the full P0-S1 at-rest destroy. (User decision 2026-06-26 — logout must not
  // erase chat history; the secure wipe moves to a dedicated remove-account action.)
  signOut: (opts?: {wipeAtRest?: boolean}) => Promise<void>;
  /**
   * §35A §F — CPO mid-session revocation re-check. Re-fetches /auth/me; if the
   * caller is a CPO whose `membership_status != 'active'` (suspended/removed), or
   * /auth/me 401/403s (the Step-4 session guard), it ends their access:
   * best-effort `setDuty(false)`, then the full `signOut()` teardown (drops the
   * CPO from Ops Rooms / wipes at-rest), and raises `accessEnded`. Otherwise it
   * refreshes the local user (so e.g. `must_set_password` clears post-activation).
   * No-op for individual / agency accounts.
   */
  recheckMembership: () => Promise<void>;
  /** Shared revocation teardown — idempotent. Used by recheckMembership and by the
   *  AccessEndedScreen mount (covers a boot/login as an already-suspended CPO). */
  endCpoAccess: () => Promise<void>;
  /** Clear the access-ended flag ("Return to sign in" on AccessEndedScreen). */
  clearAccessEnded: () => void;
  setRole: (role: UserRole) => Promise<void>;
  /**
   * Activate Bravo Pro: debit the Pro price in BC server-side and flip the
   * local user to the 'pro' tier. Throws on `insufficient_credits` so the
   * caller (paywall) can route into the card top-up fallback, then retry.
   */
  subscribeToPro: (autoRenew?: boolean) => Promise<void>;
  subscribeToTier: (tier: 'pro' | 'enterprise', autoRenew?: boolean) => Promise<void>;
  updateProfile: (updates: Partial<User>) => Promise<void>;
  /** Set (or clear with null) the device-local profile photo. Persists per-user
   *  and reflects everywhere that renders `user.avatar_url`. */
  setAvatar: (uri: string | null) => Promise<void>;
  /** Update the device-local display name. Persists per-user and reflects
   *  everywhere that renders `user.full_name`. */
  setDisplayName: (name: string) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState & AuthActions>()(
  immer(set => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    isSigningOut: false,
    accessEnded: false,
    error: null,
    pendingUserId: null,
    pendingPhone: null,

    initialize: async () => {
      set(s => { s.isLoading = true; });
      try {
        const t = await tokenStore.get();
        if (!t) {return;}
        const {user, account_kind, is_org_manager, org, must_set_password, membership_status, cpo_needs_onboarding, auto_dispatch_enabled} = await authApi.me();
        set(s => { s.user = toUser(user, {account_kind, is_org_manager, membership_status, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled}); s.isAuthenticated = true; });
      } catch (e: unknown) {
        // Only wipe tokens on genuine auth failure (401/403). A network
        // error during boot (auth-service cold-starting, adb reverse
        // not yet wired, Wi-Fi blip) must NOT force the user to sign
        // in again — the refresh interceptor will recover naturally.
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        if (status === 401 || status === 403) {
          await tokenStore.clear();
        }
        // Intentionally swallow transient errors; UI stays unauthenticated
        // for this session but tokens remain for the next boot.
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    register: async ({email, password, fullName, phoneE164}) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        // Why: role/tier are server-controlled (DTO audit P0-V1). They're
        // accepted in the action signature only to carry UI/navigation
        // context to the OTP screen — never sent to /auth/register, which
        // 400s on those fields under STRICT_VALIDATION.
        const res = await authApi.register({
          email, password,
          displayName: fullName,
          phoneE164,
        });
        // No user row yet — we only track the pending phone for the OTP screen.
        set(s => { s.pendingUserId = null; s.pendingPhone = res.otpSentTo; });
        return {phone: res.otpSentTo};
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Registration failed';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    verifyRegister: async ({email, password, fullName, phoneE164, code}) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        const deviceId = await getDeviceId();
        // Why: role/tier are server-defaulted (DTO audit P0-V1); sending
        // them 400s under STRICT_VALIDATION. The server creates the user
        // as 'individual'/'lite' and returns the authoritative role.
        const resp = await authApi.registerVerify({
          email, password,
          displayName: fullName,
          phoneE164,
          code, deviceId, platform: DEVICE_PLATFORM,
        });
        const mapped = toUser(resp.user);
        set(s => {
          s.user = mapped;
          s.isAuthenticated = true;
          s.pendingUserId = null;
          s.pendingPhone = null;
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Verification failed';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    login: async ({email, phoneE164, password}) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        const res = await authApi.login({email, phoneE164, password});
        set(s => { s.pendingUserId = res.userId; s.pendingPhone = res.otpSentTo; });
        return {userId: res.userId, phone: res.otpSentTo, devOtpCode: res.devOtpCode};
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Sign in failed';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    verifyOtp: async (userId, code) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        const deviceId = await getDeviceId();
        await authApi.verify({userId, code, deviceId, platform: DEVICE_PLATFORM});
        // Tokens persisted inside authApi.verify — don't flip isAuthenticated
        // yet; let the success screen call completeAuth.
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Invalid code';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    completeAuth: async () => {
      try {
        const {user, account_kind, is_org_manager, org, must_set_password, membership_status, cpo_needs_onboarding, auto_dispatch_enabled} = await authApi.me();
        set(s => {
          s.user = toUser(user, {account_kind, is_org_manager, membership_status, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled});
          s.isAuthenticated = true;
          s.pendingUserId = null;
          s.pendingPhone = null;
        });
        setObservabilityUser(user.id);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Could not load profile';
        set(s => { s.error = msg; });
      }
    },

    biometricSignIn: async () => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        // A valid refresh token must exist — biometric doesn't *create*
        // a session, it unlocks an existing one. (Fresh installs or
        // post-signout states have no refresh token to unlock.)
        const refresh = await tokenStore.getRefresh();
        if (!refresh) {return false;}

        // Device must have hardware + be enrolled, otherwise the prompt
        // would no-op or hang indefinitely.
        const [hasHw, hasCreds] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!hasHw || !hasCreds) {return false;}

        const result = await LocalAuthentication.authenticateAsync({
          promptMessage:         'Sign in to Bravo Secure',
          fallbackLabel:         'Use device PIN',
          cancelLabel:           'Cancel',
          disableDeviceFallback: false,
        });
        if (!result.success) {return false;}

        // Swap the refresh token for a fresh access token, then pull
        // the profile. Both go through the axios interceptor so a
        // truly expired refresh token raises the usual 401 path.
        await authApi.refresh();
        const {user, account_kind, is_org_manager, org, must_set_password, membership_status, cpo_needs_onboarding, auto_dispatch_enabled} = await authApi.me();
        set(s => {
          s.user = toUser(user, {account_kind, is_org_manager, membership_status, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled});
          s.isAuthenticated = true;
          s.pendingUserId = null;
          s.pendingPhone  = null;
        });
        setObservabilityUser(user.id);
        return true;
      } catch (e) {
        // Don't wipe tokens here — network flakes shouldn't force the
        // user back to password entry on the next attempt. Surface the
        // error so the UI can tell them something went wrong.
        const msg = e instanceof Error ? e.message : 'Biometric sign-in failed';
        set(s => { s.error = msg; });
        return false;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    signOut: async (opts) => {
      // IDN-22 — re-entrancy guard: a second tap while the teardown is in
      // flight must be a no-op, not a concurrent second teardown.
      if (useAuthStore.getState().isSigningOut) {return;}
      // Raise the blocking "Signing out…" overlay for the whole teardown.
      // Every step below is best-effort and self-guarded; the flag clears
      // in the finally so a failed sign-out can't brick the button.
      set(s => { s.isSigningOut = true; });
      try {
      // getDeviceId is the only un-guarded await in this method; a failure
      // here must not strand the overlay, so make it best-effort too.
      let deviceId = '';
      try { deviceId = await getDeviceId(); } catch { /* device id unavailable */ }
      // Audit P0-S1 — capture the per-user persistence key NOW, before
      // any of the runtime/auth/registry tear-downs run. The wipe step
      // at the end of this method needs to know which SQLCipher DB
      // filename + keychain entries to destroy; _resetMessengerRuntime
      // nulls productionConfig, so we'd lose the key otherwise.
      let ownerKeyForWipe: string | null = null;
      try {
        const {getActiveOwnerKey} = require('@/modules/messenger/runtime') as
          typeof RuntimeModule;
        ownerKeyForWipe = getActiveOwnerKey();
      } catch { /* runtime not configured — no DB to wipe */ }
      // Audit P0-N2 — revoke the messenger-service push tokens BEFORE
      // authApi.signOut() runs. Once auth invalidates the JTI, the
      // DELETE /push/register* calls would 401 against JwtHttpGuard's
      // revocation check. Without this, the previous user's FCM token
      // + iOS PushKit token stay registered server-side; when the next
      // user signs in on the same physical device they inherit those
      // tokens and receive chat/VoIP wakes meant for the prior account.
      // Best-effort with a 4s timeout each so a slow relay doesn't stall
      // the logout flow.
      try {
        const {revokeServerPushTokens} = require('@/modules/messenger/push/unregisterPush') as
          typeof UnregisterPushModule;
        await revokeServerPushTokens();
      } catch { /* push module not loaded — fine */ }
      try { await authApi.signOut(deviceId); } catch { /* ignore */ }
      // Clear any pending incoming-1:1 banner left from the previous
      // session — without this, an offer that arrived seconds before
      // logout would resurrect on the login screen of the next user
      // and prompt them to accept a call meant for the prior account.
      try {

        const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof IncomingOneToOneBannerModule;
        banner.clearPendingOneToOne();
      } catch { /* module not available — fine */ }
      // Round 2 / Architecture audit: end any active 1:1 or group call
      // BEFORE we tear the runtime down. Without this, a logout during
      // an active call left the floating overlay's subscriber pinned,
      // the controller still holding the (now-stale) CallSignalling
      // referencing the still-open socket, and the audioSessionStartedFor
      // set retaining the callId. Logging back in re-rendered the overlay
      // over the new user's home screen.
      try {

        const {endActiveCall} = require('@/modules/messenger/runtime/callRegistry') as typeof CallRegistryModule;
        endActiveCall('ended');
      } catch { /* no active call — fine */ }
      try {

        const {endActiveGroupCall} = require('@/modules/messenger/runtime/groupCallRegistry') as typeof GroupCallRegistryModule;
        await endActiveGroupCall();
      } catch { /* no active group call — fine */ }
      // Round 2 fix: stop any in-progress ringtone/ringback so it can't
      // bleed into the login screen of the next user.
      try {

        const {stopAllTones} = require('@/modules/messenger/runtime/bravoTones') as typeof BravoTonesModule;
        await stopAllTones();
      } catch { /* expo-av not available in tests — fine */ }
      // Round 8 — tear down the backup mirror BEFORE the runtime so a
      // pending flush doesn't fire under the new owner. Clears the
      // queue, dedup cache, master key handle, owner gate, AppState
      // hook. Also stops the mirrorBootstrap subscription so a stale
      // store update doesn't push messages into the post-dispose void.
      // And locks identityBackup's pinned master key so an attacker
      // who got the device after logout can't trigger a re-mirror.
      try {

        const {disposeMirror} = require('@/modules/messenger/backup/messageMirror') as typeof MessageMirrorModule;
        disposeMirror();
      } catch { /* module not loaded yet — fine */ }
      try {

        const {stopMirrorBootstrap} = require('@/modules/messenger/backup/mirrorBootstrap') as typeof MirrorBootstrapModule;
        stopMirrorBootstrap();
      } catch { /* module not loaded yet — fine */ }
      try {

        const {lockIdentityBackup} = require('@/modules/messenger/backup/identityBackup') as typeof IdentityBackupModule;
        lockIdentityBackup();
      } catch { /* module not loaded yet — fine */ }

      // Audit fixes #1/#9/#12/#21: tear down the messenger runtime
      // before wiping auth state. Without this:
      //   - the heartbeat interval keeps pinging an unauthorized
      //     socket (Fix #1)
      //   - ExpirySweeper keeps firing against a soon-to-be-stale DB
      //     (Fix #9)
      //   - call/transport registries hold stale refs (Fix #12)
      //   - FCM token-refresh listener stays attached (Fix #21)
      try {

        const {disposeLiveRuntime} = require('@/modules/messenger/runtime/productionRuntime') as typeof ProductionRuntimeModule;
        disposeLiveRuntime();
      } catch { /* runtime not built yet — fine */ }
      try {

        const {_resetMessengerRuntime} = require('@/modules/messenger/runtime') as typeof RuntimeModule;
        _resetMessengerRuntime();
      } catch { /* ignore */ }
      // Round 8 / false-active audit — wipe cached presence on logout.
      // setOwner() also clears it on the next user-switch, but an
      // explicit signOut without a follow-up login (or before the
      // next user logs in) would otherwise leave the previous
      // session's online dots visible behind any sign-in screen
      // surface that reads from the messenger store.
      try {

        const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as typeof MessengerStoreModule;
        useMessengerStore.getState().clearAllPresence();
      } catch { /* store not loaded yet — fine */ }
      // Round 2 fix: clearLiveTransport now also closes the underlying
      // socket (see transportRegistry.ts) so the previous user's WS is
      // gone from the fd and the persisted recoveryPid is wiped.
      try {

        const {clearLiveTransport} = require('@/modules/messenger/runtime/transportRegistry') as typeof TransportRegistryModule;
        clearLiveTransport();
      } catch { /* ignore */ }
      // Round 2 / Architecture audit: every WebRTC dispatcher kept its
      // module-level Maps populated across logouts. A late-arriving
      // call.offer / sfu.new-producer / sfu.ring.incoming would route
      // into the prior user's listener closures (which themselves
      // pin unmounted screens and a torn-down mediasoup Device). Drop
      // them all so the next user's session boots from a clean slate.
      try {

        const {clearAllCallDispatchState} = require('@/modules/messenger/webrtc/callDispatcher') as typeof CallDispatcherModule;
        clearAllCallDispatchState();
      } catch { /* ignore */ }
      try {

        const {clearAllSfuHandlers} = require('@/modules/messenger/webrtc/sfuDispatcher') as typeof SfuDispatcherModule;
        clearAllSfuHandlers();
      } catch { /* ignore */ }
      try {

        const {clearAllRoomIdentities} = require('@/modules/messenger/webrtc/groupCallIdentityRegistry') as typeof GroupCallIdentityRegistryModule;
        clearAllRoomIdentities();
      } catch { /* ignore */ }
      try {
        // Audit BS-LEAK — drop any stashed minimize→restore mediasoup
        // handles so logout doesn't pin the prior user's transports.
        const {clearAllLiveSfuHandles} = require('@/modules/messenger/webrtc/useGroupCall') as typeof import('@/modules/messenger/webrtc/useGroupCall');
        clearAllLiveSfuHandles();
      } catch { /* ignore */ }
      try {

        const {clearAllGroupCallRingHandlers} = require('@/modules/messenger/webrtc/groupCallRingDispatcher') as typeof GroupCallRingDispatcherModule;
        clearAllGroupCallRingHandlers();
      } catch { /* ignore */ }
      try {

        const {clearRtt} = require('@/modules/messenger/runtime/rttRegistry') as typeof RttRegistryModule;
        clearRtt();
      } catch { /* ignore */ }
      try {

        const {stopFcmBootstrap} = require('@/modules/messenger/push/fcmBootstrap') as typeof FcmBootstrapModule;
        stopFcmBootstrap();
      } catch { /* native module missing — fine */ }
      try {
        // Round 5 / Security S3 — burn the per-device VoIP wake key on
        // logout. Without this, a future login on the same device would
        // inherit the previous user's key and reject every signed wake
        // (or worse, accept wakes minted under the wrong identity).

        const {clearVoipWakeKey} = require('@/modules/messenger/push/voipWakeVerify') as typeof VoipWakeVerifyModule;
        await clearVoipWakeKey();
      } catch { /* keychain missing or no key persisted — fine */ }
      // Audit P0-S1 — destroy every at-rest artifact tied to this
      // user: the SQLCipher DB file (op-sqlite native delete clears
      // .db + .db-wal + .db-shm), the per-user keychain entries
      // (SQLCipher key, group-wrap key, mirror master key), and the
      // owner's vault slice in AsyncStorage. Runs LAST in this method
      // so the runtime/registry tear-downs above have already closed
      // their handles — wipeUserAtRest re-opens the SQLCipher file
      // just to call its native `delete()`. Best-effort; the per-step
      // WipeReport is logged so telemetry can flag a stuck phone.
      //
      // GATED (2026-06-26) — only on an EXPLICIT remove-account
      // (opts.wipeAtRest). A plain "Sign out" leaves the encrypted DB +
      // key intact so re-login restores chat history; the destroy is
      // reserved for "Remove account from this device". The DB/key are
      // keyed to the STABLE owner key, so a non-wiping logout re-opens
      // the same store on the next login.
      if (ownerKeyForWipe && opts?.wipeAtRest) {
        try {
          const {wipeUserAtRest} =
            require('@/modules/messenger/runtime/wipeAtRest') as
              typeof import('@/modules/messenger/runtime/wipeAtRest');
          const report = await wipeUserAtRest(ownerKeyForWipe);
          if (report.errors.length > 0) {
            console.warn('[authStore.signOut] wipeUserAtRest partial:', report);
          }
        } catch (e) {
          // Catastrophic wipe failure (module load error, etc.) — log
          // but do not block the logout. The user's auth state is
          // gone; a subsequent login attempt will get the residual
          // wiped on its next signOut.
          console.warn('[authStore.signOut] wipeUserAtRest failed', e);
        }
      }
      // Reset the in-memory app stores so the next account that signs in on
      // this device doesn't briefly see the previous user's wallet balance
      // or bookings before the refetch. These are memory-only (no persist
      // middleware), so a process-alive logout would otherwise retain them.
      try {
        const {useWalletStore} = require('@store/walletStore') as typeof WalletStoreModule;
        useWalletStore.getState().reset();
      } catch { /* store not loaded — fine */ }
      try {
        const {useBookingStore} = require('@store/bookingStore') as typeof BookingStoreModule;
        useBookingStore.getState().reset();
      } catch { /* store not loaded — fine */ }
      // B-91 M0 — forget the active product so the next account on this
      // device gets the product gate instead of the previous user's choice.
      try {
        const {useProductStore} = require('@store/productStore') as typeof import('@store/productStore');
        useProductStore.getState().reset();
      } catch { /* store not loaded — fine */ }
      // RS-07 — clear the provider-signup bridge flag on logout. Without this a
      // user who tapped "Service Provider" but never finished POST /agents stays
      // pinned to the agency shell (resolveAuthedRoute pendingProvider fallback)
      // on the NEXT account that signs in on this device.
      try { await pendingProvider.clear(); } catch { /* storage blip — fine */ }
      set(s => {
        s.user = null;
        s.isAuthenticated = false;
        s.pendingUserId = null;
        s.pendingPhone = null;
      });
      setObservabilityUser(null);
      } finally {
        set(s => { s.isSigningOut = false; });
      }
    },

    recheckMembership: async () => {
      try {
        const {user, account_kind, is_org_manager, org, must_set_password, membership_status, cpo_needs_onboarding, auto_dispatch_enabled} = await authApi.me();
        if (account_kind === 'cpo' && membership_status && membership_status !== 'active') {
          // Agency revoked/suspended this CPO — end their access.
          await useAuthStore.getState().endCpoAccess();
          return;
        }
        // Still active (or not a CPO) — just refresh the local user so a freshly
        // cleared must_set_password / changed org name reflects immediately.
        set(s => { s.user = toUser(user, {account_kind, is_org_manager, membership_status, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled}); });
      } catch (e: unknown) {
        // A 401/403 on the re-check is a revocation signal ONLY for a managed
        // CPO — the §35A session guard fail-closes a suspended/removed CPO and
        // that shell is designed to eject on it. Since RS-06 this catch also runs
        // on foreground-resume for EVERY shell, where a 401 can equally be a
        // TRANSIENT refresh outage (e.g. auth-service mid-deploy: the interceptor
        // rejects with the original /auth/me 401 when /auth/refresh is briefly
        // unreachable). Force-logging client/agency users out on that would be a
        // false-positive logout wave, so we only tear down for CPOs; a genuinely
        // revoked client/agency user is caught by their next real API call, not by
        // a resume re-check. A transient network error (no response) is never a
        // revocation for anyone.
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        const isCpo = useAuthStore.getState().user?.account_kind === 'cpo';
        if (isCpo && (status === 401 || status === 403)) {
          await useAuthStore.getState().endCpoAccess();
        }
      }
    },

    endCpoAccess: async () => {
      // Idempotent: once the teardown has run (flag raised) a second call is a no-op,
      // so recheckMembership and the AccessEndedScreen mount can both call it safely.
      if (useAuthStore.getState().accessEnded) {return;}
      set(s => { s.accessEnded = true; });
      // Best-effort: take the guard off duty so dispatch stops ranking them.
      try { await agentApi.setDuty(false); } catch { /* offline / already revoked — fine */ }
      // Full teardown — drops the CPO from Ops Rooms, tears down the runtime, wipes
      // at-rest, clears tokens. accessEnded survives this (signOut doesn't touch it).
      await useAuthStore.getState().signOut();
    },

    clearAccessEnded: () =>
      set(s => { s.accessEnded = false; }),

    setRole: async () => { /* no-op: role chosen at registration */ },

    subscribeToPro: async (autoRenew = false) => {
      await useAuthStore.getState().subscribeToTier('pro', autoRenew);
    },

    subscribeToTier: async (tier, autoRenew = false) => {
      // Server is the source of truth — it debits BC + flips the tier
      // atomically and returns the new state. We mirror it locally so the
      // UI (badges, gated screens) updates without a full /auth/me refetch.
      const {data} = await subscriptionApi.subscribeTier(tier, autoRenew);
      set(s => {
        if (s.user) {
          s.user.subscription_tier = data.subscription_tier;
          s.user.pro_active_until = data.active_until;
        }
      });
    },

    updateProfile: async updates => {
      set(s => {
        if (s.user) {Object.assign(s.user, updates);}
      });
    },

    setAvatar: async uri => {
      // Optimistic local update for instant UI, then persist server-side; the
      // server response is the source of truth and /auth/me returns it on every
      // future boot/login (so it reflects everywhere + across devices).
      set(s => { if (s.user) { s.user.avatar_url = uri ?? undefined; } });
      try {
        const {user} = await authApi.updateProfile({avatar_url: uri});
        set(s => { s.user = toUser(user); });
      } catch (e: unknown) {
        set(s => { s.error = e instanceof Error ? e.message : 'Could not update photo'; });
        throw e;
      }
    },

    setDisplayName: async name => {
      const trimmed = name.trim();
      if (!trimmed) {return;}
      set(s => { if (s.user) { s.user.full_name = trimmed; } });
      try {
        const {user} = await authApi.updateProfile({display_name: trimmed});
        set(s => { s.user = toUser(user); });
      } catch (e: unknown) {
        set(s => { s.error = e instanceof Error ? e.message : 'Could not update name'; });
        throw e;
      }
    },

    clearError: () =>
      set(s => { s.error = null; }),
  })),
);
