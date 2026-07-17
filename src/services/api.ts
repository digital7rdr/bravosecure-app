/**
 * API clients — auth service (port 3001) + business API
 */
import type {AxiosError} from 'axios';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {API_BASE_URL} from '@utils/constants';
import {supabase} from './supabase';
import type {AccountKind, Booking, BookingAddOn, Location, TripItinerary} from '@appTypes/index';

// ─── Auth service (NestJS, port 3001) ────────────────────────────────────────

const authHttp = axios.create({
  baseURL: API_BASE_URL,   // EXPO_PUBLIC_API_BASE_URL → http://10.0.2.2:3001
  timeout: 15_000,
  headers: {'Content-Type': 'application/json'},
});
console.log('[api] baseURL =', API_BASE_URL);

// Attach stored access token to every auth request
authHttp.interceptors.request.use(async config => {
  const token = await AsyncStorage.getItem('auth:access_token');
  if (token) {config.headers.Authorization = `Bearer ${token}`;}
  console.log('[api] →', config.method?.toUpperCase(), (config.baseURL ?? '') + (config.url ?? ''));
  return config;
});
// Single in-flight refresh guard — every 401 that races into the
// interceptor in parallel waits on the same refresh, avoiding a flood
// of /auth/refresh calls when the app wakes up with an expired token.
let refreshInFlight: Promise<void> | null = null;

async function refreshAccessToken(): Promise<void> {
  const refreshToken = await AsyncStorage.getItem('auth:refresh_token');
  if (!refreshToken) {throw new Error('No refresh token');}
  const res = await axios.post<{
    accessToken: string; refreshToken: string; expiresIn: number;
  }>(`${API_BASE_URL}/auth/refresh`, {refreshToken}, {timeout: 15_000});
  await AsyncStorage.multiSet([
    ['auth:access_token',  res.data.accessToken],
    ['auth:refresh_token', res.data.refreshToken],
  ]);
}

/**
 * Round 2 / Security audit fix: dedup-protected refresh hook for the
 * messenger-service HTTP clients (KeysHttpClient, SenderCertClient,
 * RelayHttpClient, UsersHttpClient). They each accept an optional
 * `refreshToken: () => Promise<void>` constructor option but the
 * `productionRuntime` builder was constructing them WITHOUT passing
 * one — so every 401 inside those clients fell through silently and
 * the user was stuck until they navigated to a screen that uses
 * `fetchWithRefresh`. Exposing the same single-flight chain here lets
 * productionRuntime wire it through to ALL the messenger HTTP paths.
 */
export function refreshAccessTokenShared(): Promise<void> {
  refreshInFlight ??= refreshAccessToken().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/**
 * Audit fix 0.8 — surface backend `403 tier_insufficient` to the UI
 * (e.g. an upgrade modal) without coupling axios to react-navigation.
 * Screens subscribe via `onTierInsufficient`; the interceptor fans the
 * event on any 403 whose body has `{code: 'tier_insufficient'}`.
 */
type TierInsufficientHandler = (info: {required_tier?: string; message?: string}) => void;
const tierInsufficientHandlers = new Set<TierInsufficientHandler>();

export function onTierInsufficient(fn: TierInsufficientHandler): () => void {
  tierInsufficientHandlers.add(fn);
  return () => tierInsufficientHandlers.delete(fn);
}

/**
 * LB-API1 — fired ONCE when the interceptor destroys the session because a
 * refresh genuinely failed (revoked/absent refresh token), so the app root can
 * route to a clean re-auth instead of leaving the user on a booking screen with
 * no tokens (where every subsequent call 401s and looks like "the API is down").
 * A transient network/timeout/5xx failure does NOT fire this and does NOT clear
 * tokens — see the interceptor below.
 */
type AuthLostHandler = () => void;
const authLostHandlers = new Set<AuthLostHandler>();
export function onAuthLost(fn: AuthLostHandler): () => void {
  authLostHandlers.add(fn);
  return () => authLostHandlers.delete(fn);
}
function emitAuthLost(): void {
  for (const fn of authLostHandlers) {
    try { fn(); } catch (cbErr) { console.log('[api] authLost handler threw', (cbErr as Error).message); }
  }
}

authHttp.interceptors.response.use(
  r => { console.log('[api] ←', r.status, r.config.url); return r; },
  async (e: AxiosError) => {
    const original = e.config as (typeof e.config & {_retry?: boolean}) | undefined;
    const status   = e.response?.status;
    // Auto-recover from an expired access token: refresh + replay once.
    // Guard against:
    //   - no original config (can't retry)
    //   - second 401 on the same request (the refresh itself is stale → bail)
    //   - 401 ON /auth/refresh (refresh token itself invalid → bail)
    if (
      status === 401 &&
      original &&
      !original._retry &&
      !original.url?.includes('/auth/refresh')
    ) {
      original._retry = true;
      try {
        refreshInFlight ??= refreshAccessToken().finally(() => { refreshInFlight = null; });
        await refreshInFlight;
        const fresh = await AsyncStorage.getItem('auth:access_token');
        if (fresh && original.headers) {original.headers.Authorization = `Bearer ${fresh}`;}
        console.log('[api] ↻ refreshed + retrying', original.method?.toUpperCase(), original.url);
        return authHttp(original);
      } catch (refreshErr) {
        // LB-API1 — only DESTROY the session on a genuine auth failure (the refresh
        // token is revoked/absent/rejected). A network blip, the 15s timeout, or a
        // 5xx (e.g. a 502 while auth-service redeploys) must NOT wipe a still-valid
        // refresh token — doing so turned a transient outage into a permanent,
        // self-perpetuating logout (every later call then 401s with no token).
        const refreshStatus = axios.isAxiosError(refreshErr) ? refreshErr.response?.status : undefined;
        const noToken = refreshErr instanceof Error && refreshErr.message === 'No refresh token';
        // 401/403 = revoked/invalid refresh; 404 = user_not_found (the account was
        // deleted) — also unrecoverable, so don't leave a zombie session on it.
        const authFailed = noToken || refreshStatus === 401 || refreshStatus === 403 || refreshStatus === 404;
        if (authFailed) {
          console.log('[api] ✗ refresh rejected (auth) — clearing tokens', (refreshErr as Error).message);
          await AsyncStorage.multiRemove(['auth:access_token', 'auth:refresh_token']);
          emitAuthLost();
        } else {
          console.log('[api] ✗ refresh failed (transient) — keeping tokens', (refreshErr as Error).message);
        }
      }
    }
    // Audit fix 0.8 — Pro tier paywall hook. Body shape is the NestJS
    // ForbiddenException payload we throw in booking.service:
    //   {code: 'tier_insufficient', required_tier: 'pro', message: '…'}.
    if (status === 403) {
      const body = e.response?.data as {code?: string; required_tier?: string; message?: string} | undefined;
      if (body?.code === 'tier_insufficient') {
        for (const fn of tierInsufficientHandlers) {
          try { fn({required_tier: body.required_tier, message: body.message}); }
          catch (cbErr) { console.log('[api] tier handler threw', (cbErr as Error).message); }
        }
      }
    }
    console.log('[api] ✗', e.code, e.message, 'url:', original?.url, 'resp:', status, e.response?.data);
    return Promise.reject(e);
  },
);

// B-76 — session-loss classifier lives in a pure leaf module so it can be unit
// tested without api.ts's bundle/side-effect import chain. Re-exported here so
// existing `import {isAuthLostError} from '@services/api'` call sites keep working.
export {isAuthLostError} from './authError';

/** Persist / retrieve / clear auth tokens in AsyncStorage */
export const tokenStore = {
  get:         () => AsyncStorage.getItem('auth:access_token'),
  getRefresh:  () => AsyncStorage.getItem('auth:refresh_token'),
  set: (access: string, refresh: string) =>
    AsyncStorage.multiSet([
      ['auth:access_token',  access],
      ['auth:refresh_token', refresh],
    ]),
  clear: () => AsyncStorage.multiRemove(['auth:access_token', 'auth:refresh_token']),
};

/**
 * Cross-host fetch with the same access-token + 401-refresh semantics
 * as the axios `authHttp` interceptor. Intended for non-axios call
 * sites that target services other than auth-service (e.g. the
 * messenger-service `/webrtc/turn-credentials` and `/sfu/*` endpoints).
 *
 * On a first 401 we drive the SAME `refreshAccessToken` chain that
 * axios uses (deduped via the `refreshInFlight` guard so concurrent
 * callers share one /auth/refresh round-trip), then replay the request
 * once with the fresh token. Any other status — or a second 401 after
 * refresh — surfaces to the caller as the original Response.
 */
export interface FetchWithRefreshInit extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}
export async function fetchWithRefresh(
  url: string,
  init: FetchWithRefreshInit = {},
): Promise<Response> {
  const {headers: callerHeaders, ...rest} = init;
  const buildHeaders = async (): Promise<Record<string, string>> => {
    const tok = await AsyncStorage.getItem('auth:access_token');
    return {
      ...(callerHeaders ?? {}),
      ...(tok ? {Authorization: `Bearer ${tok}`} : {}),
    };
  };
  let res = await fetch(url, {...rest, headers: await buildHeaders()});
  if (res.status !== 401) {return res;}
  // Single in-flight refresh — mirrors axios interceptor's dedupe.
  try {
    refreshInFlight ??= refreshAccessToken().finally(() => { refreshInFlight = null; });
    await refreshInFlight;
  } catch {
    return res; // refresh failed; let caller see the 401
  }
  res = await fetch(url, {...rest, headers: await buildHeaders()});
  return res;
}

/** Generate (once) and persist a random device UUID */
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem('device:id');
  if (!id) {
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
    await AsyncStorage.setItem('device:id', id);
  }
  return id;
}

export interface ApiUser {
  id: string;
  email: string;
  display_name: string;
  role: string;
  subscription_tier: string;
  phone_e164: string | null;
  /** ISO timestamp the current paid Pro period runs until (null on Lite). */
  pro_active_until?: string | null;
  /** Profile photo — a base64 data-URI (or null/absent). */
  avatar_url?: string | null;
}

export const authApi = {
  /**
   * Step 1 of registration: duplicate check + Twilio OTP send. Does NOT create
   * the user row — that only happens on registerVerify() after the OTP is
   * approved by Twilio.
   */
  register: async (dto: {
    email: string; password: string; displayName: string;
    phoneE164: string;
  }) => {
    // Why: DTO audit P0-V1 — the server rejects `role`/`subscriptionTier`
    // on the unauthenticated registration surface (forbidNonWhitelisted),
    // so sending them 400s under STRICT_VALIDATION. Role/tier are
    // server-defaulted ('individual'/'lite').
    const res = await authHttp.post<{otpSentTo: string}>('/auth/register', dto);
    return res.data;
  },

  /** Step 2: verify the OTP and create the user atomically. Returns tokens. */
  registerVerify: async (dto: {
    email: string; password: string; displayName: string;
    phoneE164: string;
    code: string; deviceId: string; platform: string;
  }) => {
    const res = await authHttp.post<{
      user: ApiUser; accessToken: string; refreshToken: string; expiresIn: number;
    }>('/auth/register/verify', dto);
    await tokenStore.set(res.data.accessToken, res.data.refreshToken);
    return res.data;
  },

  login: async (dto: {email?: string; phoneE164?: string; password: string}) => {
    const res = await authHttp.post<{
      userId: string | null; otpSentTo: string | null; devOtpCode?: string;
    }>('/auth/login', dto);
    return res.data;
  },

  verify: async (dto: {userId: string; code: string; deviceId: string; platform: string}) => {
    const res = await authHttp.post<{
      user: ApiUser; accessToken: string; refreshToken: string; expiresIn: number;
    }>('/auth/verify', dto);
    await tokenStore.set(res.data.accessToken, res.data.refreshToken);
    return res.data;
  },

  refresh: async () => {
    const refreshToken = await tokenStore.getRefresh();
    if (!refreshToken) {throw new Error('No refresh token');}
    const res = await authHttp.post<{
      accessToken: string; refreshToken: string; expiresIn: number;
    }>('/auth/refresh', {refreshToken});
    await tokenStore.set(res.data.accessToken, res.data.refreshToken);
    return res.data;
  },

  me: async () => {
    // Server-computed app-routing fields (§35A) ride alongside the user; the
    // discriminator is never a client flag or a JWT claim.
    const res = await authHttp.get<{
      user: ApiUser;
      account_kind: AccountKind;
      is_org_manager: boolean;
      org: {id: string; name: string} | null;
      must_set_password: boolean;
      membership_status: string | null;
      cpo_needs_onboarding?: boolean; // CPO onboarding gate; optional so old servers default false
      auto_dispatch_enabled?: boolean; // Bug 1: server-driven; optional so old servers default false
    }>('/auth/me');
    return res.data;
  },

  // Self-service profile update — display name and/or avatar (a small base64
  // data-URI, or null to clear). Returns the same {user} shape as /auth/me.
  updateProfile: async (dto: {display_name?: string; avatar_url?: string | null}) => {
    const res = await authHttp.patch<{user: ApiUser}>('/auth/me', dto);
    return res.data;
  },

  // Credential rotation (POST /auth/me/password). Used by the CPO first-login
  // activation (Step 17) to swap the agency-set temp password for the guard's own.
  // ⚠️ The server revokes EVERY live session on success (incl. this one) and returns
  // no new tokens — the caller must re-authenticate with the new password afterwards.
  changePassword: async (dto: {currentPassword: string; newPassword: string}) => {
    const res = await authHttp.post<{ok: true; sessionsRevoked: number}>('/auth/me/password', dto);
    return res.data;
  },

  signOut: async (deviceId: string) => {
    try {
      await authHttp.delete('/auth/session', {data: {deviceId}});
    } finally {
      await tokenStore.clear();
    }
  },
};

// Step 25 — user preferences (language / currency / notifications / location-scope /
// app-lock). The server forces the Safety notification category on regardless of input.
export interface UserPreferences {
  language: 'en' | 'ar' | 'bn';
  currency: 'AED' | 'SAR' | 'BDT' | 'GBP' | null;
  notifPrefs: Record<string, boolean>;
  locationScope: 'while_on_duty' | 'during_mission' | 'never';
  appLock: boolean;
  // REGION (#8) — persisted home region; 'N/A' = outside supported coverage, null = unset.
  homeRegion: 'AE' | 'SA' | 'BD' | 'GB' | 'ZA' | 'N/A' | null;
}

export const preferencesApi = {
  get: () => authHttp.get<UserPreferences & {id: string}>('/users/me'),
  patch: (patch: Partial<UserPreferences>) =>
    authHttp.patch<UserPreferences & {id: string}>('/users/me/preferences', patch),
};

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: {'Content-Type': 'application/json'},
});

// Attach Supabase JWT to every request
api.interceptors.request.use(async config => {
  const {data} = await supabase.auth.getSession();
  if (data.session?.access_token) {
    config.headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  return config;
});

// Global error handling
api.interceptors.response.use(
  response => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      void supabase.auth.signOut();
    }
    return Promise.reject(error);
  },
);

// ─── Booking API ─────────────────────────────────────────────────────────────
//
// Routes through `authHttp` (auth-service on port 3001) — the booking module
// now lives inside auth-service and relies on the auth-service JWT for identity.

export interface BookingCreateBody {
  type: Booking['type'];
  pickup: Location;
  dropoff?: Location;
  start_time: string;
  duration_hours?: number;
  add_ons: string[];
  payment_method: Booking['payment_method'];
  region: string;
  region_label?: string;
  service?: string;
  booking_mode?: 'now' | 'later';
  passengers?: number;
  cpo_count?: number;
  vehicle_count?: number;
  driver_only?: boolean;
  notes?: string;
  // Step 22 — lawful-basis consent (required by the server on the auto path).
  location_consent?: boolean;
  terms_accepted?: boolean;
  location_consent_version?: string;
  terms_accepted_version?: string;
}

export const bookingApi = {
  create: (data: BookingCreateBody) =>
    authHttp.post<{booking: Booking; client_secret?: string}>('/bookings', data),

  // Step 19 — auto-dispatch request (POST /dispatch/request): creates the booking + starts
  // the matchmaker server-side in one call, so it comes back already DISPATCHING (or
  // NO_PROVIDER if the pool was empty). DARK behind AUTO_DISPATCH_ENABLED — 400s
  // `auto_dispatch_disabled` until cut-over. Idempotency-Key prevents a retry double-create
  // (the server's one-active-booking guard is the backstop). The client must run its own
  // affordability soft-check before calling this (route a short balance to the paywall).
  requestAuto: (data: BookingCreateBody, idempotencyKey: string) =>
    authHttp.post<{booking: Booking}>('/dispatch/request', data, {
      headers: {'Idempotency-Key': idempotencyKey},
    }),

  getById: (id: string) => authHttp.get<Booking>(`/bookings/${id}`),

  // Step 19 — coarse provider reveal for the agency that accepted an auto booking
  // (name/call-sign/★/missions only; no precise location, LB1). 404 `no_provider_yet`
  // while still searching.
  getProvider: (id: string) =>
    authHttp.get<{
      display_name: string | null;
      call_sign: string | null;
      rating: number | null;
      jobs_total: number;
    }>(`/bookings/${id}/provider`),

  list: (params?: {status?: Booking['status']; page?: number}) =>
    authHttp.get<{bookings: Booking[]; total: number}>('/bookings', {params}),

  // `already_ended` — the search finished on its own (NO_PROVIDER / earlier cancel /
  // agency no-show) before the tap landed; the server answers idempotent-success
  // instead of the old FSM 403. Route on `status`, don't assume CANCELLED.
  cancel: (id: string) =>
    authHttp.post<{id: string; status: string; refunded_credits?: number; already_ended?: boolean}>(`/bookings/${id}/cancel`),

  // Step 24 — client rates the agency on a COMPLETED booking. Server is idempotent
  // (one rating per booking) + recomputes agents.rating; a stable key collapses retries.
  submitRating: (id: string, body: {stars: number; tags?: string[]; tip?: number}) =>
    authHttp.post<{id: string; rating: number; agency_rating: number | null}>(
      `/bookings/${id}/rating`, body, {headers: {'Idempotency-Key': `rate-${id}`}},
    ),

  // Stable per-booking idempotency key — server-side IdempotencyInterceptor
  // (booking.controller.ts) collapses retries onto the cached first
  // response (24h TTL). A network blip auto-retry or a multi-device race
  // therefore cannot double-debit the wallet. Key is `paywc-<bookingId>`
  // so concurrent calls for the SAME booking converge; different bookings
  // (or, in future, a deliberate fresh attempt) get distinct keys.
  //
  // Separator is `-`, NOT `:` — the interceptor's shape gate is
  // /^[A-Za-z0-9_-]{8,128}$/ and a `:` makes it throw
  // `idempotency_key_invalid_shape` (the "PAYMENT FAILED" bug). Booking
  // ids are UUIDs ([0-9a-f-]) so the whole key stays inside the charset.
  payWithCredits: (id: string) =>
    authHttp.post<{booking: Booking}>(
      `/bookings/${id}/pay-with-credits`,
      undefined,
      {headers: {'Idempotency-Key': `paywc-${id}`}},
    ),

  getAddOns: (region: string) =>
    authHttp.get<BookingAddOn[]>('/bookings/add-ons', {params: {region}}),

  // Audit fix 3.1 — live CPO availability per region. Replaces the
  // mobile-side hardcoded REGIONS array. Returned shape is stable so
  // a network failure in the screen falls back gracefully to the
  // static label list.
  regionsAvailability: () =>
    authHttp.get<Array<{
      code: string;
      name: string;
      cpos_available: number;
      cpos_total: number;
      available: boolean;
    }>>('/bookings/regions/availability'),

  estimatePrice: (data: {
    type: Booking['type'];
    duration_hours?: number;
    add_ons: string[];
    region: string;
    cpo_count?: number;
    vehicle_count?: number;
    driver_only?: boolean;
    pickup_time?: string;
  }) =>
    authHttp.post<{total: number; breakdown: Record<string, number>}>(
      '/bookings/estimate',
      data,
    ),

  // Step 16 — on-arrival identity handshake. The client reads the rotating verify
  // code (+ the assigned lead's name/call-sign) and compares it face-to-face with the
  // code the lead shows from their app. 400 (`no_crew_assigned`) until crew is assigned.
  getVerifyCode: (id: string) =>
    authHttp.get<{
      code: string;
      rotates_at: string;
      lead: {display_name: string | null; call_sign: string | null};
    }>(`/bookings/${id}/verify-code`),

  // F1 — the numbered receipt (COMPLETED) / credit note (refunded terminal).
  getInvoice: (id: string) =>
    authHttp.get<InvoiceDto>(`/bookings/${id}/invoice`),

  // Step 16 — panic path: the arriving person is NOT the dispatched guard. Stamps the
  // marker AND raises a booking-scoped SOS (crew + ops alerted). Idempotency-keyed so a
  // frantic double-tap doesn't double-raise. NO "are you sure" gate — it's a panic press.
  notMyGuard: (id: string) =>
    authHttp.post<{ok: true; sos_event_id: string}>(
      `/bookings/${id}/not-my-guard`,
      undefined,
      {headers: {'Idempotency-Key': `nmg-${id}`}},
    ),

  // Step 16 — escalate a stranded NO_PROVIDER booking to the safety hotline. Side-channel
  // only (no status change); the fallback block on getById drives the NoDetail UI.
  escalate: (id: string) =>
    authHttp.post<{ok: true; hotline_e164: string}>(
      `/bookings/${id}/escalate`,
      undefined,
      {headers: {'Idempotency-Key': `esc-${id}`}},
    ),
};

// ─── Agent Matching API ──────────────────────────────────────────────────────

// ─── Agent Portal — backs the 9-screen onboarding flow ──────────────────
// Lifecycle: DRAFT → PROFILE_COMPLETE → KYC_PENDING → DOCS_PENDING →
//            SUBMITTED → UNDER_REVIEW → APPROVED → ACTIVE (or REJECTED)

export type AgentPortalStatus =
  | 'DRAFT' | 'PROFILE_COMPLETE' | 'KYC_PENDING' | 'DOCS_PENDING'
  | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'ACTIVE';

export type AgentPortalType = 'company' | 'cpo' | 'transport';

export interface AgentPortalState {
  agent: {
    user_id: string;
    type: AgentPortalType;
    status: AgentPortalStatus;
    tier: number;
    call_sign: string | null;
    display_name: string | null;
    rate_aed_per_hour: string | null;
    rating: string | null;
    jobs_total: number;
    duty_hours_mtd: number;
    on_duty: boolean;
    // Bug 3 — dispatch eligibility inputs (region the agency operates in + DPA acceptance time).
    region_code?: string | null;
    dpa_accepted_at?: string | null;
  };
  profile: {
    company: Record<string, unknown>;
    contact: Record<string, unknown>;
    capabilities: string[];
    coverage: {
      countries: Array<{code: string; on: boolean}>;
      services: Array<{key: string; on: boolean}>;
    };
    availability: {mode: string; loadout: string[]};
  };
  kyc: Array<{
    kind: 'gov_id' | 'proof_address' | 'sia_licence' | 'police';
    state: 'queued' | 'running' | 'done' | 'failed';
    subject: string | null;
    file_url?: string | null;
    uploaded_at?: string | null;
  }>;
  documents: Array<{
    id: string;
    slot: 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv';
    required: boolean;
    title: string;
    state: 'upload' | 'done' | 'rejected';
  }>;
  review: Array<{
    step: 'submit' | 'docs' | 'kyc' | 'ops' | 'partner';
    state: 'pending' | 'in_progress' | 'done' | 'rejected';
    // Server includes the operator's review note on the `partner` step
    // when a decision is recorded — surfaced on AgentRejectedScreen so
    // the agent can see the actual rejection reason.
    notes?: string | null;
  }>;
  deployment: Array<{
    check_key: 'dress' | 'vehicle' | 'equip' | 'briefing';
    state: 'pending' | 'passed' | 'failed';
  }>;
}

// Shared shape for a per-mission live read consumed by the live tracker. The
// crew-gated agent deployment read (Step 21/29) and the org-scoped manager
// monitor (Step 32) both return this, so the tracker works against either source.
export interface MissionDeploymentResponse {
  checks: Array<{
    check_key: 'dress' | 'vehicle' | 'equip' | 'briefing';
    state: 'pending' | 'passed' | 'failed';
    notes: string | null;
    signed_at: string | null;
  }>;
  mission: {
    short_code: string; status: string; booking_id: string;
    route_distance_m: number | null; route_duration_s: number | null;
    route_polyline: string | null;
    current_lat: number | null; current_lng: number | null;
    // Optional — rotates the tracker's heading cone when the server surfaces it.
    current_heading_deg?: number | null;
    // Step 29 — the principal's last-known GPS (client-ping) for the user marker.
    client_lat: number | null; client_lng: number | null;
    client_recorded_at: string | null;
    comms_channel_id: string | null;
  } | null;
  crew_role: {is_lead: boolean; team_idx: number; role: string; call_sign: string} | null;
  dress_instructions: string | null;
  dress_acknowledged_at: string | null;
  waypoints: Array<{
    seq: number; tag: string; event: string; state: string;
    settled_at: string | null; marked_via: string | null;
  }>;
  booking: {
    pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
    dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
    booking_status: string; client_name: string | null;
  } | null;
  crew: Array<{call_sign: string | null; role: string; team_idx: number; is_lead: boolean; is_me: boolean}>;
}

export const agentApi = {
  // 01 · Profile creation
  create: (type: AgentPortalType, display_name?: string) =>
    authHttp.post('/agents', {type, display_name}),

  getMe: () => authHttp.get<AgentPortalState>('/agents/me'),

  // 02 · Registration wizard
  updateCompany: (
    dto: {
      legal_name?: string; company_number?: string; regulator?: string;
      established?: string; primary_contact?: string; primary_email?: string;
      primary_phone?: string; capabilities?: string[];
    },
  ) => authHttp.patch('/agents/me/company', dto),

  // 03 · KYC
  startKyc: () => authHttp.post('/agents/me/kyc/start'),

  // 03b · Agent attaches supporting evidence for a KYC slot.
  uploadKycDoc: (
    kind: 'gov_id' | 'proof_address' | 'sia_licence' | 'police',
    dto: {file_url: string; subject?: string; file_hash_sha256?: string},
  ) => authHttp.post(`/agents/me/kyc/${kind}/upload`, dto),

  // 03c · Skip the standalone KYC screen — auto-settles all 4 KYC
  // checks and mirrors any uploads into the compliance pack. Idempotent.
  skipKyc: () => authHttp.post('/agents/me/kyc/skip'),

  // Generic file upload — POSTs the file as multipart/form-data and
  // returns the absolute URL where ops-console can render it.
  uploadFile: async (file: {uri: string; name: string; type?: string}): Promise<string> => {
    const fd = new FormData();
    fd.append('file', {
      uri:  file.uri,
      name: file.name,
      type: file.type ?? 'application/octet-stream',
    } as unknown as Blob);
    const res = await authHttp.post<{file_url: string}>('/agents/me/upload', fd, {
      headers: {'Content-Type': 'multipart/form-data'},
    });
    return res.data.file_url;
  },

  // 04 · Coverage
  updateCoverage: (dto: {
    countries: Array<{code: string; on: boolean}>;
    services: Array<{key: string; on: boolean}>;
  }) => authHttp.patch('/agents/me/coverage', dto),

  // 05 · Availability
  updateAvailability: (dto: {mode: string; loadout: string[]}) =>
    authHttp.patch('/agents/me/availability', dto),

  // 06 · Documents
  uploadDoc: (dto: {
    slot: 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv';
    title: string; file_url: string; file_hash_sha256?: string;
  }) => authHttp.post('/agents/me/documents', dto),

  submit: () => authHttp.post('/agents/me/submit'),

  // Bug 3 · operating region + DPA acceptance (dispatch-eligibility inputs, company agents only).
  setAgencyProfile: (dto: {region_code: string; dpa_accepted: boolean; dpa_version?: string}) =>
    authHttp.patch<{region_code: string | null; dpa_accepted_at: string | null}>('/agents/me/agency-profile', dto),

  // 07 · Admin review (ADMIN role)
  openReview:  (agentId: string) => authHttp.post(`/agents/${agentId}/review/open`),
  decide:      (agentId: string, decision: 'APPROVED' | 'REJECTED', notes?: string) =>
    authHttp.post(`/agents/${agentId}/review/decision`, {decision, notes}),

  // 08 · Dashboard mutations
  setDuty:        (on_duty: boolean) => authHttp.patch('/agents/me/duty', {on_duty}),
  updateLocation: (
    lat: number, lng: number,
    quality?: {accuracy_m?: number; speed_kph?: number; is_mocked?: boolean},
  ) => authHttp.patch('/agents/me/location', {lat, lng, ...quality}),
  bumpStats:      (d: {duty_hours_delta?: number; jobs_delta?: number}) =>
    authHttp.patch('/agents/me/stats', d),

  // Published jobs the agent can see and apply for.
  getAvailableJobs: () =>
    authHttp.get<{jobs: Array<{
      id: string; short_code: string; status: string; region_code: string;
      route_label: string; dispatch_at: string; duration_hours: number;
      cpo_slots: number; slots_filled: number;
      service: string;
      pickup_lat: string | null; pickup_lng: string | null;
      dropoff_lat: string | null; dropoff_lng: string | null;
      applied: boolean;
      application_status: 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN' | null;
    }>}>('/agents/me/available-jobs'),

  // Job Portal browse (company agents only, LB1 coarse cards). Omit region (or
  // pass 'ALL') for every supported region.
  getOpenJobs: (region?: string) =>
    authHttp.get<{jobs: OpenJobDto[]}>('/agents/me/open-jobs',
      region && region !== 'ALL' ? {params: {region}} : undefined),

  // Job Portal pull-claim (JOB_PORTAL_MARKETPLACE_SPEC §2) — first agency to tap wins;
  // a 409 means the job was taken/withdrawn in the race (refresh the feed, never retry
  // blind). Why the key carries a per-tap nonce: a booking can legitimately become
  // claimable AGAIN (claim → withdraw → relist), and a static `claim-<id>` key would
  // replay the first claim's cached success for 24h — a false "accepted" masking the
  // real provider_excluded 409. One key per user intent, not per booking.
  claimOpenJob: (bookingId: string) =>
    authHttp.post<{offer_id: string; booking_id: string; status: 'CONFIRMED'}>(
      `/dispatch/open-jobs/${bookingId}/claim`, undefined,
      {headers: {'Idempotency-Key': `claim-${bookingId}-${Date.now()}`}},
    ),

  applyToJob: (jobId: string, dressPledge: string) =>
    authHttp.post<{application: {id: string; status: string; applied_at: string}}>(
      `/agents/me/jobs/${jobId}/apply`, {dress_pledge: dressPledge},
      // Stable per-job key — a network blip auto-retry returns the
      // cached first response rather than bumping `dress_pledged_at`.
      {headers: {'Idempotency-Key': `apply-${jobId}`}},
    ),

  withdrawApplication: (jobId: string) =>
    authHttp.post<{ok: true}>(`/agents/me/jobs/${jobId}/withdraw`, {},
      {headers: {'Idempotency-Key': `withdraw-${jobId}`}}),

  // Mission post-mortem the Earnings screen taps into. Server gates this
  // on a real mission_payouts row for (booking, agent), so 404 == "you
  // never crewed this booking" rather than "this booking doesn't exist".
  getPayoutSummary: (bookingId: string) =>
    authHttp.get<{
      mission: {
        id: string; short_code: string; status: string;
        started_at: string | null; ended_at: string | null;
        route_distance_m: number | null; route_duration_s: number | null;
      };
      booking: {
        id: string; pickup_address: string; dropoff_address: string | null;
        pickup_time: string; service: string; region_label: string;
        total_eur: string; total_aed: string; cpo_count: number;
      };
      payout: {
        paid_credits: number; proposed_credits: number;
        deduction_credits: number; deduction_reason: string | null;
        decided_at: string;
      };
    }>(`/agents/me/payouts/${bookingId}/summary`),

  getMyApplications: () =>
    authHttp.get<{applications: Array<{
      id: string; status: 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';
      applied_at: string;
      job_id: string; short_code: string; route_label: string;
      dispatch_at: string; duration_hours: number; cpo_slots: number;
      slots_filled: number; job_status: string;
    }>}>('/agents/me/applications'),

  // Mission deployment checks for the agent (polled on deployment screen).
  getMissionDeployment: (missionId: string) =>
    authHttp.get<MissionDeploymentResponse>(`/agents/me/missions/${missionId}/deployment`),

  acknowledgeDress: (missionId: string) =>
    authHttp.post<{ok: true; acknowledged_at: string}>(
      `/agents/me/missions/${missionId}/dress-acknowledge`,
      undefined,
      {headers: {'Idempotency-Key': `dress-${missionId}`}},
    ),

  // LM-C2 — self-acknowledge one deploy check (dress/vehicle/equip/briefing).
  // All four gate the lead's Start server-side.
  acknowledgeDeployCheck: (missionId: string, checkKey: string) =>
    authHttp.post<{ok: true}>(
      `/agents/me/missions/${missionId}/checks/${encodeURIComponent(checkKey)}/acknowledge`,
      undefined,
      {headers: {'Idempotency-Key': `check-${missionId}-${checkKey}`}},
    ),

  // LM-C4 — any crew member marks themselves in position (not just the lead).
  crewCheckIn: (missionId: string) =>
    authHttp.post<{ok: true; checked_in_at: string}>(
      `/agents/me/missions/${missionId}/check-in`,
      undefined,
      {headers: {'Idempotency-Key': `checkin-${missionId}`}},
    ),

  // LM-C7 — ask the agency to close the mission when the lead is unreachable.
  requestComplete: (missionId: string) =>
    authHttp.post<{ok: true}>(
      `/agents/me/missions/${missionId}/request-complete`,
      undefined,
      {headers: {'Idempotency-Key': `reqcomplete-${missionId}-${Math.floor(Date.now() / 60_000)}`}},
    ),

  // Lead-CPO mission FSM transitions. Idempotency-Key collapses retries
  // onto the cached server response so a network blip + auto-retry
  // doesn't double-fire side effects. LM-C3 — each may carry the device fix
  // for the server's geofence warning (never blocks).
  missionPickup: (missionId: string, fix?: {lat?: number; lng?: number}) =>
    authHttp.post<{ok: true}>(`/agents/me/missions/${missionId}/pickup`, fix ?? {},
      {headers: {'Idempotency-Key': `pickup-${missionId}`}}),
  missionGoLive: (missionId: string, fix?: {lat?: number; lng?: number}) =>
    authHttp.post<{ok: true}>(`/agents/me/missions/${missionId}/go-live`, fix ?? {},
      {headers: {'Idempotency-Key': `golive-${missionId}`}}),
  missionComplete: (missionId: string, fix?: {lat?: number; lng?: number}) =>
    // B-76 — Finish runs the escrow proof-gate + settle server-side (a longer
    // round-trip than start/go-live). Give it 30s so a slow-but-succeeding
    // settle doesn't trip the default 15s timeout and surface a "lost-200"
    // error for a mission that actually completed.
    authHttp.post<{ok: true}>(`/agents/me/missions/${missionId}/complete`, fix ?? {},
      {headers: {'Idempotency-Key': `complete-${missionId}`}, timeout: 30_000}),

  // Step 16 — the assigned lead reads the SAME rotating verify code the client sees, to
  // confirm identity at handover. Lead-only (non-lead / non-member is rejected). The
  // lead's "Arrived" confirm is missionPickup above (DISPATCHED → PICKUP).
  missionVerifyCode: (missionId: string) =>
    authHttp.get<{code: string; rotates_at: string}>(
      `/agents/me/missions/${missionId}/verify-code`),

  // CPO panic button. The reason is bounded server-side to 200 chars.
  raiseSos: (missionId: string, body: {reason: string; lat?: number; lng?: number}) =>
    authHttp.post<{ok: true; sos_event_id: string}>(
      `/agents/me/missions/${missionId}/sos`,
      body,
      // Bucket the idempotency key to a 60s window so a deliberate
      // second SOS minutes later DOES fire — but a frantic multi-tap
      // collapses to one row.
      {headers: {'Idempotency-Key': `sos-${missionId}-${Math.floor(Date.now() / 60_000)}`}},
    ),

  // The mission this agent is currently crewed on (DISPATCHED/PICKUP/LIVE/SOS),
  // or null. Used by the dashboard "Next on Ops" card.
  getActiveMission: () =>
    authHttp.get<null | {
      mission_id: string; short_code: string; status: string;
      is_lead: boolean; role: string;
      pickup_address: string; dropoff_address: string | null;
      pickup_time: string; region_label: string | null;
    }>('/agents/me/active-mission'),

  // Completed/aborted mission history (newest first), each row carrying the
  // agent's own payout if one was settled. Powers the "My Missions" list.
  getMissionHistory: () =>
    authHttp.get<Array<{
      mission_id: string; booking_id: string; short_code: string; status: string;
      role: string; is_lead: boolean;
      started_at: string | null; ended_at: string | null;
      route_distance_m: number | null; route_duration_s: number | null;
      pickup_address: string; dropoff_address: string | null; region_label: string | null;
      paid_credits: number | null; deduction_credits: number | null;
    }>>('/agents/me/missions'),

  // Detail view for one job — used by JobDetailScreen.
  getJob: (jobId: string) =>
    authHttp.get<{
      job: {
        id: string; booking_id: string; short_code: string; status: string;
        region_code: string; route_label: string; dispatch_at: string;
        duration_hours: number; cpo_slots: number; slots_filled: number;
        published_at: string;
      };
      booking: {
        pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
        dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
        pickup_time: string; total_eur: string; total_aed: string;
        cpo_count: number; vehicle_count: number; driver_only: boolean;
        passengers: number; add_ons: unknown; notes: string | null;
        service: string; region_label: string; dress_instructions: string | null;
      } | null;
      application: {id: string; status: string; applied_at: string} | null;
    }>(`/agents/me/jobs/${jobId}`),

  // Mission lead — mark a manual waypoint.
  markWaypoint: (missionId: string, tag: 'DISPATCH' | 'RECON' | 'PICKUP' | 'DROPOFF') =>
    authHttp.post<{
      ok: true; tag: string; seq: number; settled_at: string;
      auto_marks: string[];
    }>(`/agents/me/missions/${missionId}/waypoints/mark`, {tag},
      {headers: {'Idempotency-Key': `wp-${missionId}-${tag}`}}),

  // Mission lead — push GPS telemetry. Backend auto-fires CHKPT 01/02.
  pushTelemetry: (missionId: string, sample: {
    lat: number; lng: number;
    heading_deg?: number; speed_kph?: number;
    accuracy_m?: number; battery_pct?: number;
  }) =>
    authHttp.post<{
      ok: true; auto_marks: string[];
      distance_to_dropoff_m: number | null;
      progress_pct: number | null;
    }>(`/agents/me/missions/${missionId}/telemetry`, sample),

  // Deployment sign-off moved server-side to `OpsController` under
  // AdminGuard. Mobile agents don't sign their own checks — ops does, via
  // the ops console. No agent-facing route remains here.
};

// ─── Org API (NestJS /org/*, OrgManagerGuard-gated) ──────────────────────────
// Service-provider managers manage their own CPO roster. Every route resolves
// the caller's org server-side from org_members — no org id is sent from here.

export interface RosterMember {
  member_user_id: string;
  display_name: string | null;
  email: string | null;
  call_sign: string | null;
  member_role: 'cpo' | 'manager' | 'employee';
  status: 'invited' | 'active' | 'suspended' | 'removed';
  agent_status: string | null;
  missions_completed: number;
  created_at: string;
  // LM-A4/F11 — server-truth availability for the assign sheet + roster.
  on_duty: boolean;
  on_mission: boolean;
  armed_authorized: boolean;
}

export const orgApi = {
  listCpos: () => authHttp.get<RosterMember[]>('/org/cpos'),

  /** M1A rule 16 — enroll an EXISTING app user as an org 'employee'
   *  (Enterprise workspace: dept channels + attendance + incidents; never a
   *  deployable CPO and never changes the member's own app shell). */
  addEmployee: (emailOrPhone: string) =>
    authHttp.post<RosterMember>('/org/employees', {email_or_phone: emailOrPhone}),

  createCpo: (dto: {
    display_name: string; email: string; phone_e164: string;
    temp_password: string; call_sign?: string; member_role?: 'cpo' | 'manager';
  }) => authHttp.post<RosterMember>('/org/cpos', dto),

  setCpoStatus: (memberUserId: string, status: 'active' | 'suspended' | 'removed') =>
    authHttp.patch<{ok: true; member_user_id: string; status: string}>(
      `/org/cpos/${memberUserId}/status`, {status}),

  // RS-10 — promote/demote a roster member (owner-only, server-enforced).
  setCpoRole: (memberUserId: string, member_role: 'cpo' | 'manager') =>
    authHttp.patch<{ok: true; member_user_id: string; member_role: 'cpo' | 'manager'}>(
      `/org/cpos/${memberUserId}/role`, {member_role}),

  // Step 13 — the agency mission board (jobs grouped needs-crew / active / recent).
  listMissions: () =>
    authHttp.get<{
      needs_crew: OrgMissionDto[]; active: OrgMissionDto[]; recent: OrgMissionDto[];
    }>('/org/missions'),

  // Step 32 — one mission's live positions (CPO leader + principal) for the org
  // desk monitor. Same shape as the crew-gated agent read so the tracker reuses it.
  getMissionLive: (missionId: string) =>
    authHttp.get<MissionDeploymentResponse>(`/org/missions/${missionId}/live`),

  // JOB_PORTAL_MARKETPLACE_SPEC §3 — hand an accepted-but-uncrewed booking back to the
  // Job Portal (pre-crew only; 409 crew_already_assigned once a mission exists). The
  // client keeps their escrow hold — the next accepting agency takes it over. Per-tap
  // nonce for the same reason as claimOpenJob (the booking can be re-accepted later).
  withdrawBooking: (bookingId: string, reason?: string) =>
    authHttp.post<{booking_id: string; status: 'DISPATCHING'}>(
      `/dispatch/bookings/${bookingId}/withdraw`, {reason},
      {headers: {'Idempotency-Key': `withdraw-bk-${bookingId}-${Date.now()}`}},
    ),

  // Step 13 — crew a CONFIRMED booking (pick guards + a leader → creates the mission).
  // Idempotency-Key collapses a double-confirm onto one mission (server-enforced).
  assignCrew: (bookingId: string, body: {cpo_user_ids: string[]; lead_user_id: string}) =>
    authHttp.post<{ok: true; mission_id: string; short_code: string; crew: number; lead_user_id: string}>(
      `/org/bookings/${bookingId}/crew`, body,
      {headers: {'Idempotency-Key': `crew-${bookingId}`}},
    ),

  // Step 20 — capacity summary for the dashboard "X of Y guards free" strip.
  getSummary: () =>
    authHttp.get<{
      guards_total: number;
      guards_free: number;
      guards_on_duty: number;
      active_missions: number;
    }>('/org/summary'),

  // MISSION-HISTORY (#3) — a roster CPO's completed/aborted-mission call-log
  // (org-scoped + IDOR-gated server-side).
  listMemberMissions: (memberUserId: string) =>
    authHttp.get<Array<{
      mission_id: string; booking_id: string; short_code: string; status: string;
      role: string; is_lead: boolean; started_at: string | null; ended_at: string | null;
      route_distance_m: number | null; route_duration_s: number | null;
      pickup_address: string; dropoff_address: string | null; region_label: string | null;
      paid_credits: number | null;
    }>>(`/org/cpos/${memberUserId}/missions`),

  // MISSION-HISTORY (#3) — the agency's all-completed-missions list + total count.
  listCompletedMissions: () =>
    authHttp.get<{completed_count: number; missions: OrgMissionDto[]}>('/org/missions/completed'),

  // SP-MISSION-DETAIL (#2nd) — the agency's escrow view for a booking it owns
  // (payout + hold status only; null = legacy booking with no hold).
  getMissionEscrow: (bookingId: string) =>
    authHttp.get<{
      status: string; basis: string | null; currency: string | null;
      gross_credits: number; to_provider_credits: number | null; platform_fee_credits: number | null;
    } | null>(`/org/bookings/${bookingId}/escrow`),

  // LM-C7 — the agency confirms completion when the lead can't (crew requested
  // it / lead phone died). Same money-safe path as the lead Finish.
  completeMission: (missionId: string) =>
    authHttp.post<{ok: true; completed: boolean}>(
      `/org/missions/${missionId}/complete`, undefined,
      {headers: {'Idempotency-Key': `orgcomplete-${missionId}`}},
    ),

  // F6 — the agency earnings roll-up (totals + per-mission escrow splits).
  getEarnings: () =>
    authHttp.get<{
      total_missions: number;
      total_gross_credits: number;
      total_fee_credits: number;
      total_net_credits: number;
      pending_credits: number;
      rows: Array<{
        booking_id: string; short_code: string | null; service: string;
        region_label: string; ended_at: string | null; hold_status: string;
        gross_credits: number; platform_fee_credits: number | null; to_provider_credits: number | null;
      }>;
    }>('/org/earnings'),
};

// F1 — numbered, line-itemised receipt / credit note.
export interface InvoiceDto {
  id: string;
  invoice_number: string;
  booking_id: string;
  kind: 'client_receipt' | 'credit_note';
  issued_at: string;
  currency: string;
  line_items: Array<{label: string; per_hour: number | null; hours: number | null; amount_credits: number}>;
  subtotal_credits: number;
  tax_rate_pct: number;
  tax_credits: number;
  total_credits: number;
  booking: {
    service: string; region_label: string; pickup_time: string;
    pickup_address: string; dropoff_address: string | null;
    cpo_count: number; duration_hours: number;
  };
}

// ─── Auto-dispatch offer card (agency-facing, Step 20) ───────────────────────
// CoarseOfferDto (LB1): the agency's single live OFFERED offer joined with COARSE
// booking data — region + bucketed distance + when/price/headcount/requirements, and
// crucially the server `expires_at` (the countdown MUST bind to this, not a 0-start
// local timer). NO exact pickup/dropoff coord or address pre-accept.
export interface CoarseOffer {
  offer_id: string;
  expires_at: string;
  region_code: string;
  region_label: string;
  service: string;
  pickup_time: string;
  duration_hours: number;
  distance_bucket: string; // '<2km' | '2-5km' | '5-10km' | '>10km' | 'unknown'
  cpo_count: number;
  vehicle_count: number;
  price: {eur: string; aed: string};
  requirements: {armed: boolean; driver_only: boolean; add_ons: string[]; flags: Record<string, boolean>};
}

// Testing affordance — provider region browse of open jobs. LB1 coarse-only:
// region, truncated pickup area (zone), time window, service, cpo_count, armed
// flag, price — never exact coords, full addresses, or client identity pre-accept.
export interface OpenJobDto {
  booking_id: string;
  status: string;
  region_code: string;
  region_label: string;
  service: string;
  pickup_area: string | null;
  pickup_time: string;
  duration_hours: number;
  cpo_count: number;
  armed_required: boolean;
  total_eur: string;
  total_aed: string;
  created_at: string;
  // Only 'auto' bookings are claimable (charge-on-accept consent); legacy rows render
  // browse-only. Optional so a not-yet-redeployed server (field absent) degrades to
  // claimable — the server-side consent gate is authoritative either way.
  dispatch_mode?: string | null;
}

export interface OrgMissionDto {
  booking_id: string;
  booking_status: string;
  service: string;
  region_label: string;
  pickup_time: string;
  pickup_address: string;
  pickup_lat: string | null;
  pickup_lng: string | null;
  dropoff_address: string | null;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  cpo_count: number;
  armed_required: boolean;
  mission_id: string | null;
  mission_status: string | null;
  short_code: string | null;
  crew: Array<{user_id: string; call_sign: string | null; role: string; is_lead: boolean}>;
}

// ─── Attendance API (NestJS /attendance/*) ───────────────────────────────────

// Dept Chat v2 closed sets (mirror attendance.service.ts / the CHECK constraints).
export type AttendanceStatusDto =
  | 'present' | 'late' | 'absent' | 'early_checkout'
  | 'leave' | 'sick_leave' | 'off_duty' | 'pending_review';
export type ReviewStatusDto = 'none' | 'pending' | 'approved' | 'rejected';
export type ReviewReasonDto = 'face_mismatch' | 'out_of_radius' | 'permission_denied' | 'offline';

export interface ShiftSessionDto {
  id: string;
  org_user_id: string;
  cpo_user_id: string;
  status: 'open' | 'closed' | 'edited';
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_at: string | null;
  edit_reason: string | null;
  // Dept Chat v2 — null/absent on legacy rows.
  shift_id?: string | null;
  face_verified?: boolean | null;
  within_radius?: boolean | null;
  distance_m?: number | null;
  attendance_status?: AttendanceStatusDto | null;
  review_status?: ReviewStatusDto;
  review_reason?: ReviewReasonDto | null;
  reviewed_at?: string | null;
  admin_notes?: string | null;
}

// cpo_shifts — an expected duty window + geofence centre + radius (Dept Chat v2).
export interface ShiftDto {
  id: string;
  org_user_id: string;
  department: string | null;
  site_label: string | null;
  site_lat: number | null;
  site_lng: number | null;
  approved_radius_m: number;
  start_at: string;
  end_at: string;
  created_by: string;
  archived_at: string | null;
  created_at: string;
  assigned_count?: number;
}

export interface ClockInBody {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  // Dept Chat v2 verified check-in (Step 5). face_meta is non-biometric metadata
  // only (model/version tag, confidence bucket) — never frames or descriptors.
  shift_id?: string;
  face_ok?: boolean;
  // Camera/face step couldn't run (permission denied) — distinct review reason.
  face_unavailable?: boolean;
  face_meta?: Record<string, unknown>;
  offline?: boolean;
}

export const attendanceApi = {
  clockIn: (body?: ClockInBody) =>
    authHttp.post<ShiftSessionDto>('/attendance/clock-in', body ?? {}),
  // PDF p.5 — check-out carries the same face + location verification fields.
  clockOut: (body?: {lat?: number; lng?: number; accuracy_m?: number; face_ok?: boolean; face_unavailable?: boolean}) =>
    authHttp.post<ShiftSessionDto>('/attendance/clock-out', body ?? {}),
  disputeSession: (id: string, note: string) =>
    authHttp.post<ShiftSessionDto>(`/attendance/sessions/${id}/dispute`, {note}),
  updateShift: (id: string, body: {
    department?: string; site_label?: string; site_lat?: number; site_lng?: number;
    approved_radius_m?: number; start_at?: string; end_at?: string;
  }) => authHttp.patch<ShiftDto>(`/attendance/shifts/${id}`, body),
  archiveShift: (id: string) => authHttp.delete<ShiftDto>(`/attendance/shifts/${id}`),
  myShifts: () => authHttp.get<ShiftSessionDto[]>('/attendance/me'),
  // Provider (org manager) roster view.
  orgSessions: (cpoUserId?: string) =>
    authHttp.get<ShiftSessionDto[]>('/attendance/org/sessions', {
      params: cpoUserId ? {cpo_user_id: cpoUserId} : undefined,
    }),
  // Dept Chat v2 (flag-gated server-side — 404 when off).
  myTodayShift: () => authHttp.get<ShiftDto | null>('/attendance/my-shift/today'),
  listShifts: () => authHttp.get<ShiftDto[]>('/attendance/shifts'),
  createShift: (body: {
    department?: string; site_label?: string; site_lat?: number; site_lng?: number;
    approved_radius_m?: number; start_at: string; end_at: string;
  }) => authHttp.post<ShiftDto>('/attendance/shifts', body),
  assignCpos: (shiftId: string, cpoUserIds: string[]) =>
    authHttp.post<{assigned: number}>(`/attendance/shifts/${shiftId}/assignments`, {
      cpo_user_ids: cpoUserIds,
    }),
  // Manager (org) — Step 6/7.
  orgSummary: (params?: {from?: string; to?: string; cpo_user_id?: string; department?: string; shift_id?: string}) =>
    authHttp.get<{counts: Record<string, number>; total: number; pendingReview: number}>(
      '/attendance/org/summary', {params},
    ),
  pendingQueue: (params?: {department?: string}) =>
    authHttp.get<ShiftSessionDto[]>('/attendance/org/pending', {params}),
  reviewSession: (id: string, decision: 'approve' | 'reject', notes?: string) =>
    authHttp.patch<ShiftSessionDto>(`/attendance/sessions/${id}/review`, {decision, notes}),
  setDayStatus: (body: {cpo_user_id: string; status: 'leave' | 'sick_leave' | 'off_duty' | 'absent'; date?: string; notes?: string}) =>
    authHttp.post<ShiftSessionDto>('/attendance/day-status', body),
  exportSessions: (body?: {from?: string; to?: string; cpo_user_id?: string; department?: string; shift_id?: string}) =>
    authHttp.post<string>('/attendance/org/export', body ?? {}, {responseType: 'text'}),
};

// ─── Incident API (NestJS /incidents/*, Dept Chat v2) ────────────────────────

export type IncidentCategoryDto =
  | 'security_concern' | 'safety_issue' | 'medical_incident' | 'suspicious_activity'
  | 'access_control' | 'property_damage' | 'vehicle_issue' | 'staff_misconduct'
  | 'visitor_contractor' | 'equipment_failure' | 'operational_disruption'
  | 'harassment_workplace' | 'lost_property' | 'fire_hazard' | 'other';
export type IncidentSeverityDto = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatusDto =
  | 'submitted' | 'received' | 'under_review' | 'action_assigned' | 'resolved' | 'closed';

export interface IncidentReportDto {
  id: string;
  ref: string | null;
  org_user_id: string;
  submitter_id: string;
  department: string | null;
  category: IncidentCategoryDto;
  severity: IncidentSeverityDto;
  description: string;
  location_label: string | null;
  location_lat: number | null;
  location_lng: number | null;
  status: IncidentStatusDto;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentEventDto {
  id: string;
  incident_id: string;
  actor_id: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  note_internal: boolean;
  created_at: string;
}

export const incidentApi = {
  submit: (body: {
    category: IncidentCategoryDto;
    severity: IncidentSeverityDto;
    description: string;
    department?: string;
    location_label?: string;
    location_lat?: number;
    location_lng?: number;
  }) =>
    authHttp.post<{id: string; ref: string | null; status: IncidentStatusDto; severity: IncidentSeverityDto}>(
      '/incidents', body,
    ),
  mine: () => authHttp.get<IncidentReportDto[]>('/incidents/mine'),
  // Manager (org) — Step 9.
  queue: (params?: {
    status?: string; severity?: string; category?: string; submitter_id?: string;
    from?: string; to?: string; department?: string;
  }) =>
    authHttp.get<IncidentReportDto[]>('/incidents/queue', {params}),
  detail: (id: string) =>
    authHttp.get<{report: IncidentReportDto; events: IncidentEventDto[]}>(`/incidents/${id}`),
  updateStatus: (id: string, to: IncidentStatusDto, note?: string) =>
    authHttp.patch<{id: string; status: IncidentStatusDto}>(`/incidents/${id}/status`, {to, note}),
  assign: (id: string, assigneeUserId: string) =>
    authHttp.post<{id: string; assigned_to: string}>(`/incidents/${id}/assign`, {assignee_user_id: assigneeUserId}),
  addNote: (id: string, note: string, internal = true) =>
    authHttp.post<{ok: true}>(`/incidents/${id}/note`, {note, internal}),
  // Step 10 — evidence pointers. The bytes are encrypted + uploaded via the
  // existing media pipeline (MediaClient.uploadEncrypted); only the opaque
  // objectKey is posted here. The per-file key/iv ride the sealed envelope.
  attach: (id: string, storageKey: string) =>
    authHttp.post<{id: string}>(`/incidents/${id}/attachments`, {storage_key: storageKey}),
  listAttachments: (id: string) =>
    authHttp.get<Array<{id: string; incident_id: string; storage_key: string; created_by: string; created_at: string}>>(
      `/incidents/${id}/attachments`,
    ),
  // Step 10 · E2 — E2EE evidence key delivery. The per-file media key is sealed
  // (outer-ECIES) to each recipient device; the server stores opaque blobs only.
  evidenceRecipients: (id: string) =>
    authHttp.get<string[]>(`/incidents/${id}/recipients`),
  storeAttachmentKeys: (
    id: string, attachmentId: string,
    keys: {recipient_user_id: string; device_id: number; sealed_key: string}[],
  ) =>
    authHttp.post<{stored: number}>(`/incidents/${id}/attachments/${attachmentId}/keys`, {keys}),
  getAttachmentKey: (id: string, attachmentId: string, deviceId: number) =>
    authHttp.get<{sealed_key: string}>(`/incidents/${id}/attachments/${attachmentId}/key`, {
      params: {device_id: deviceId},
    }),
};

// ─── Ops API (NestJS /ops/*, admin-gated) ────────────────────────────────────

export const opsApi = {
  // Mission detail bundle — backs the mobile OpsMissionDetailScreen.
  // Server returns the mission row (with comms_channel_id), assigned crew,
  // waypoints, principals, sos, audit, booking, and vehicle. The group chat
  // is provisioned at dispatch (ops.service.ts:dispatchBooking), so
  // comms_channel_id is non-null for LIVE / PICKUP / SOS missions.
  getMission: (missionId: string) =>
    authHttp.get<{
      mission: {
        id: string; booking_id: string; status: string; short_code: string;
        started_at: string; ended_at: string | null;
        current_lat: number | null; current_lng: number | null;
        comms_channel_id: string | null;
      };
      crew: Array<{
        mission_id: string; agent_id: string; slot: number;
        role: string; call_sign: string | null; is_lead: boolean;
        team_idx: number;
      }>;
      booking: {
        id: string; client_id: string;
        pickup_address: string; dropoff_address: string | null;
        pickup_time: string; total_eur: string; total_aed: string;
        client_display_name: string | null;
      } | null;
    }>(`/ops/missions/${missionId}`),
};

// ─── AI / Claude API (Edge functions on Vercel) ──────────────────────────────

export const aiApi = {
  parseItinerary: (fileUri: string, mimeType: string) => {
    const formData = new FormData();
    formData.append('file', {uri: fileUri, type: mimeType, name: 'itinerary'} as unknown as Blob);
    return api.post<TripItinerary>('/ai/parse-itinerary', formData, {
      headers: {'Content-Type': 'multipart/form-data'},
    });
  },

  getRiskScore: (location: Location) =>
    api.post<{score: number; reason: string; recommendations: string[]}>('/ai/risk-score', {location}),

  getBookingSuggestions: (location: Location, date: string) =>
    api.post('/ai/booking-suggestions', {location, date}),
};

// ─── News API ────────────────────────────────────────────────────────────────

export const newsApi = {
  getFeed: (params?: {category?: string; region?: string; page?: number}) =>
    api.get('/news/feed', {params}),
};

// ─── Wallet API ──────────────────────────────────────────────────────────────
//
// Wallet endpoints live on auth-service now (port 3001). `authHttp` carries
// the access-token interceptor + refresh flow, so we route through it.
// Vault-storage endpoints still hit the legacy `api` surface until that
// backend lands.

export interface WalletBalanceDto {
  bravo_credits: number;
  currency: string;
  stripe_customer_id?: string | null;
}

export interface WalletTransactionDto {
  id: string;
  user_id: string;
  type: 'topup' | 'payment' | 'refund' | 'payout';
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amount: number;
  currency: string;
  description: string;
  booking_id?: string;
  created_at: string;
}

export interface WalletTopUpResponse {
  transaction_id: string;
  credits_awarded: number;
  client_secret?: string;
  intent_id?: string;
  customer_id?: string;
  fallback?: true;
  balance: WalletBalanceDto;
}

export interface SavedCardDto {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
}

export const walletApi = {
  getBalance: () => authHttp.get<WalletBalanceDto>('/wallet/balance'),
  // Saved cards (Payment Methods)
  listCards: () => authHttp.get<{cards: SavedCardDto[]}>('/wallet/payment-methods'),
  cardSetupIntent: () => authHttp.post<{client_secret: string}>('/wallet/payment-methods/setup-intent'),
  removeCard: (id: string) => authHttp.delete<{removed: true}>(`/wallet/payment-methods/${id}`),
  setDefaultCard: (id: string) => authHttp.post<{default_id: string}>(`/wallet/payment-methods/${id}/default`),
  getTransactions: (params?: {limit?: number; offset?: number}) =>
    authHttp.get<{transactions: WalletTransactionDto[]}>('/wallet/transactions', {params}),
  topUp: (amount: number, currency: string) =>
    authHttp.post<WalletTopUpResponse>('/wallet/topup', {amount, currency}),
  redeemPromo: (code: string) =>
    authHttp.post<{credits_awarded: number; balance: WalletBalanceDto}>('/wallet/redeem-promo', {code}),
  /**
   * Called after PaymentSheet reports success. Asks the server to verify
   * the intent with Stripe + settle the pending ledger row + credit BC.
   * Safe to re-call (idempotent server-side).
   */
  confirmTopUp: (intentId: string) =>
    authHttp.post<{
      transaction_id: string;
      status: 'pending' | 'succeeded' | 'failed' | 'refunded';
      credits_awarded: number;
      balance: WalletBalanceDto;
    }>('/wallet/topup/confirm', {intent_id: intentId}),
  /** Active credit batches with expiry — live endpoint since CREDITS_BC_AUDIT F-06. */
  getCreditBatches: () => authHttp.get('/wallet/credits/batches'),
  // Phase-1 placeholders — no backend yet. Left on the Supabase-auth client
  // so their 404s fail independently of wallet-balance health.
  purchaseVaultStorage: (incrementMb: number) =>
    api.post('/vault/storage/purchase', {increment_mb: incrementMb}),
  getVaultStorage: () => api.get('/vault/storage'),
};

// ─── Subscription (Bravo Pro) ─────────────────────────────────────────────────

export interface SubscribeProResponse {
  subscription_tier: 'pro';
  active_until: string;
  charged_credits: number;
  balance: {bravo_credits: number; currency: string};
  auto_renew: boolean;
}

/**
 * B-91 M1 R4 — the permanently pinned sponsored slot on the Chat list.
 * Content is meant to be a remotely-managed client campaign; the endpoint
 * is not deployed yet (INDEX Q3), so callers fall back to the bundled
 * default campaign when this 404s.
 */
export interface SponsoredCampaign {
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
  icon_url?: string | null;
}

export const adsApi = {
  getPinnedCampaign: (slot = 'messenger_pinned') =>
    authHttp.get<SponsoredCampaign>('/ads/campaign', {params: {slot}}),
};

export const subscriptionApi = {
  /**
   * Debit the Pro price in Bravo Credits and flip the caller's tier to
   * 'pro'. Returns 400 `insufficient_credits` when the wallet is short —
   * the paywall catches that and routes into the card top-up fallback.
   * Pass {autoRenew:true} to also create a Stripe recurring subscription.
   */
  subscribePro: (autoRenew = false) =>
    authHttp.post<SubscribeProResponse>('/subscription/pro', {auto_renew: autoRenew}),
  /** M1A — Enterprise (individual paid tier). Same contract as subscribePro. */
  subscribeEnterprise: (autoRenew = false) =>
    authHttp.post<SubscribeProResponse>('/subscription/enterprise', {auto_renew: autoRenew}),
  /** Generic paid-tier subscribe — routes to the tier's endpoint. */
  subscribeTier: (tier: 'pro' | 'enterprise', autoRenew = false) =>
    authHttp.post<SubscribeProResponse>(`/subscription/${tier}`, {auto_renew: autoRenew}),
  /** Stop auto-renew; the current paid period is kept until it lapses. */
  cancelAutoRenew: () =>
    authHttp.post<{cancelled: boolean}>('/subscription/pro/cancel', {}),
  /**
   * Live tier prices in BC (ops-editable — M1A/S9). Charged at charge time:
   * a price change applies to every subscribe/renewal AFTER it, while paid
   * periods finish at the price already charged. Falls back to the bundled
   * constants when unreachable.
   */
  getPrices: () =>
    authHttp.get<{pro: number; enterprise: number}>('/subscription/prices'),
};

// ─── Department Channels (Pro) ────────────────────────────────────────────────

export interface DepartmentChannelDto {
  id: string;
  name: string;
  description: string | null;
  department: string | null;
  /** Messenger group conversation id carrying the E2EE posts (null until an
   *  admin device has bootstrapped the Signal group). */
  group_conversation_id: string | null;
  unread_count: number;
  my_role: 'admin' | 'viewer';
  // Dept Chat v2 (Step 12). Default 'department'/'standard' on pre-v2 channels.
  channel_type?: 'board' | 'department' | 'incident';
  access?: 'standard' | 'read_only' | 'restricted';
  // Creator — gates owner-only actions (re-provision orphaned channel, delete).
  created_by?: string;
}

export interface DepartmentMemberDto {
  user_id: string;
  role: 'admin' | 'viewer';
  role_label: string | null;
  display_name: string;
}

export type ChannelTypeDto = 'board' | 'department' | 'incident';
export type ChannelAccessDto = 'standard' | 'read_only' | 'restricted';

// Manager manage-screen view of an org channel (Step 18) — org-wide, incl. archived.
export interface ManagedChannelDto {
  id: string;
  name: string;
  department: string | null;
  description: string | null;
  channel_type: ChannelTypeDto;
  access: ChannelAccessDto;
  member_count: number;
  provisioned: boolean;
  archived: boolean;
  created_at: string;
}

export interface ChannelInput {
  name?: string;
  department?: string | null;
  channel_type?: ChannelTypeDto;
  access?: ChannelAccessDto;
}

// METADATA ONLY — message content is E2EE and flows through the messenger
// runtime (broadcastToGroup), never these endpoints. These manage the
// directory, roster/role, and the encrypted-group linkage.
export const departmentApi = {
  listChannels: () =>
    authHttp.get<{channels: DepartmentChannelDto[]}>('/department/channels'),
  listMembers: (channelId: string) =>
    authHttp.get<{members: DepartmentMemberDto[]; my_role: 'admin' | 'viewer'}>(
      `/department/channels/${channelId}/members`,
    ),
  /** Admin device registers the messenger group it created for this channel. */
  registerGroup: (channelId: string, groupConversationId: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/group`, {
      group_conversation_id: groupConversationId,
    }),

  // ── Manager channel management (Step 18; OrgManagerGuard server-side) ──
  /** Every channel of the manager's org (incl. archived) for the manage screen. */
  listManagedChannels: () =>
    authHttp.get<{channels: ManagedChannelDto[]}>('/department/manage/channels'),
  createChannel: (input: ChannelInput & {name: string}) =>
    authHttp.post<{id: string; name: string; channel_type: ChannelTypeDto; access: ChannelAccessDto}>(
      '/department/channels', input,
    ),
  configureChannel: (channelId: string, input: ChannelInput) =>
    authHttp.patch<{ok: true}>(`/department/channels/${channelId}`, input),
  archiveChannel: (channelId: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/archive`),

  // Membership management (channel admins / org). Each enqueues a server-side
  // intent the admin device drains to broadcast the matching E2EE rekey.
  addMember: (channelId: string, userId: string, role: 'admin' | 'viewer' = 'viewer', roleLabel?: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/members`, {
      user_id: userId, role, role_label: roleLabel,
    }),
  removeMember: (channelId: string, userId: string) =>
    authHttp.delete<{ok: true}>(`/department/channels/${channelId}/members/${userId}`),
  /** Change a member's access: viewer (read-only) ↔ admin (can post). Admin-only. */
  updateMemberRole: (channelId: string, userId: string, role: 'admin' | 'viewer') =>
    authHttp.patch<{ok: true}>(`/department/channels/${channelId}/members/${userId}/role`, {role}),
  /** Delete the channel — creator only. */
  deleteChannel: (channelId: string) =>
    authHttp.delete<{ok: true}>(`/department/channels/${channelId}`),
  /** Owner only: clear the E2EE group linkage so the owner can re-provision an
   *  orphaned channel (recovery for "explicit peer address" on send / empty thread). */
  resetGroup: (channelId: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/reset-group`),

  // Pending add/remove intents for channels the caller administers. The admin
  // device runs the matching rekey (addGroupMember/removeGroupMember) then acks.
  listMembershipIntents: () =>
    authHttp.get<{intents: Array<{
      id: string; channel_id: string; group_conversation_id: string | null;
      member_user_id: string; action: 'add' | 'remove'; created_at: string;
    }>}>('/department/membership-intents'),
  ackMembershipIntent: (intentId: string) =>
    authHttp.post<{ok: true}>(`/department/membership-intents/${intentId}/ack`),
};

// ─── Dispatch Ops Room intents (agency device) ───────────────────────────────
// METADATA ONLY — message content is E2EE through the messenger runtime. These
// manage the encrypted booking Ops Room roster linkage (Step 12): when a CPO is
// assigned to a booking, the server enqueues a pending intent; the agency device
// (the room creator/admin that holds the group key) drains it by running the
// matching rekey then acks. Mirrors departmentApi.{list,ack}MembershipIntent.
export const dispatchApi = {
  listRoomIntents: () =>
    authHttp.get<{intents: Array<{
      id: string; booking_id: string; conversation_id: string;
      member_user_id: string; action: 'add' | 'remove'; created_at: string;
      // MISSION-GROUP (area 5) — agency device bootstraps the Ops Room E2EE
      // group (with the client as initial member) before applying CPO adds.
      client_id: string; conversation_title: string | null;
    }>}>('/dispatch/room-intents'),
  ackRoomIntent: (intentId: string) =>
    authHttp.post<{ok: true}>(`/dispatch/room-intents/${intentId}/ack`),

  // Step 20 — the agency's single live coarse offer (or null). Polled while Online +
  // re-fetched on a dispatch push wake (the FCM payload itself stays opaque).
  getCurrentOffer: () =>
    authHttp.get<CoarseOffer | null>('/dispatch/offers/current'),

  // Accept the offer → charges the client into escrow server-side + flips the booking
  // CONFIRMED. Idempotency-Key (accept-<offerId>) so a retry can't double-act; a 400
  // (`offer_not_available`) means it was won/expired in the race — show "passed", NEVER retry.
  accept: (offerId: string) =>
    authHttp.post<{offer_id: string; booking_id: string; status: 'CONFIRMED'}>(
      `/dispatch/offers/${offerId}/accept`,
      undefined,
      {headers: {'Idempotency-Key': `accept-${offerId}`}},
    ),

  // Decline → cascades to the next-nearest agency. Reason is optional + server-redacted.
  reject: (offerId: string, reason?: string) =>
    authHttp.post<{ok: true}>(`/dispatch/offers/${offerId}/reject`, reason ? {reason} : {}),
};

// ─── Provider compliance (vetting docs — Step 15) ────────────────────────────
export interface ComplianceDocDto {
  id: string; doc_type: string; region_code: string; reference: string | null;
  expires_at: string; state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'; reject_reason: string | null;
}
export const complianceApi = {
  listMine: () => authHttp.get<ComplianceDocDto[]>('/compliance/me'),
  submit: (body: {doc_type: 'licence' | 'insurance' | 'armed_permit'; region_code: string; expires_at: string; reference?: string; cpo_user_id?: string}) =>
    authHttp.post<{id: string; doc_type: string; state: 'PENDING'}>('/compliance', body),
};

// ─── Assignment / Telemetry ──────────────────────────────────────────────────

export interface AssignedCpoDto {
  // Audit H5 — the server no longer sends the internal agent user id to
  // clients. `call_sign` is the stable public identifier the UI keys on.
  call_sign: string;
  display_name: string;
  role: string;
  armed: boolean;
  female: boolean;
  specialties: string[];
}

export interface AssignedVehicleDto {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
}

export interface TelemetryFixDto {
  lat: number;
  lng: number;
  heading_deg?: number;
  speed_kph?: number;
  eta_minutes?: number;
  recorded_at: string;
  source: string;
}

export const assignmentApi = {
  getTeam: (bookingId: string) =>
    authHttp.get<{cpos: AssignedCpoDto[]; vehicle: AssignedVehicleDto | null}>(
      `/bookings/${bookingId}/team`,
    ),
};

/**
 * Audit fix 0.7 — client-raised SOS. Wires the dashboard panic button
 * to /sos/raise on the auth-service. Cancel is local to the user.
 */
export interface SosStatusDto {
  id:                string;
  status:            string;
  triggered_at:      string;
  acknowledged_at:   string | null;
  acknowledged_by:   string | null;
  escalated_at:      string | null;
  resolved_at:       string | null;
}

export const sosApi = {
  raise: (body: {
    bookingId?: string;
    lat?: number;
    lng?: number;
    reason?: string;
    payload?: Record<string, unknown>;
  }) =>
    authHttp.post<{id: string; triggered_at: string}>('/sos/raise', body),
  cancel: (sosId: string) =>
    authHttp.post<{ok: true}>(`/sos/${sosId}/cancel`, {}),
  // Audit fix 0.7 (round-trip) — dashboard polls this until
  // `acknowledged_at !== null` before showing "Ops Room On Standby".
  status: (sosId: string) =>
    authHttp.get<SosStatusDto>(`/sos/${sosId}/status`),
};

export const telemetryApi = {
  latest: (bookingId: string) =>
    authHttp.get<{latest: TelemetryFixDto | null}>(`/telemetry/${bookingId}/latest`),
  recent: (bookingId: string, count = 60) =>
    authHttp.get<{fixes: TelemetryFixDto[]}>(`/telemetry/${bookingId}/recent`, {params: {count}}),
  // B-89 P3-D — the client-side `ping` wrapper was removed: it had ZERO
  // callers, and the fact that nothing wrote the client-facing stores was
  // exactly the MG-01 bug (the server now mirrors the CPO's push).
  // Client (booking owner) pushes their own GPS so ops can see the
  // principal marker on /live alongside the CPO Lead. Backend stores
  // these as missions.client_lat/lng (separate from agent telemetry).
  clientPing: (bookingId: string, fix: {lat: number; lng: number}) =>
    authHttp.post<{ok: true}>(`/telemetry/${bookingId}/client-ping`, fix),
};

export interface ConversationRecordDto {
  id:         string;
  kind:       'direct' | 'group';
  title:      string | null;
  createdAt:  string;
  createdBy:  string;
  members:    Array<{userId: string; displayName: string; role: 'admin' | 'member'; joinedAt: string}>;
  myRole:     'admin' | 'member';
}

export const conversationApi = {
  /** All conversations the signed-in user is a member of. */
  listMine: () =>
    authHttp.get<{conversations: ConversationRecordDto[]}>('/conversations/mine'),

  // Audit P1-5 / P1-6 — write the server `conversation_members` roster after a
  // mobile add/remove/leave whose E2EE rekey already ran on-device. Without
  // this the /conversations/mine sync resurrects a removed member (media-grant
  // leak) or drops an added one. The server also enqueues an RS-02 intent for
  // the metadata→rekey seam; since this device already rekeyed, its own drain
  // treats that intent as an idempotent no-op and self-acks.
  addMember: (conversationId: string, userId: string) =>
    authHttp.post<ConversationRecordDto>(`/conversations/${conversationId}/members`, {userId}),
  removeMember: (conversationId: string, userId: string) =>
    authHttp.delete<{ok: true}>(`/conversations/${conversationId}/members/${userId}`),

  // RS-02 — membership-intent drain for conversation-admin devices (the
  // conversations parallel of departmentApi.listMembershipIntents).
  listMembershipIntents: () =>
    authHttp.get<{intents: Array<{
      id: string; conversation_id: string; member_user_id: string;
      action: 'add' | 'remove'; created_at: string;
    }>}>('/conversations/membership-intents'),

  ackMembershipIntent: (intentId: string) =>
    authHttp.post<{ok: true}>(`/conversations/membership-intents/${intentId}/ack`),
};

// ─── Virtual Bodyguard (VBG) ──────────────────────────────────────────────────
// VBG-specific persistence the rest of the app didn't already have. The
// live threat feed itself stays client-side (useIntelFeed / Bravo Intel
// aggregator); these endpoints back biometric-liveness monitoring, the
// SRA snapshot, and nearby key points. All go through authHttp so the
// JWT + refresh interceptors apply automatically.
export interface VbgMonitoringStatus {
  enrolled:          boolean;
  status:            string | null;
  interval_min:      number | null;
  enrolled_at:       string | null;
  last_heartbeat_at: string | null;
  missed_count:      number;
  overdue:           boolean;
}

export interface VbgThreatCounts {
  critical:    number;
  caution:     number;
  information: number;
}

export interface VbgSraSnapshot {
  region:          string;
  context:         string;
  risk_score:      number;
  level:           'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary:         string;
  risks:           Array<{
    name:    string;
    level:   'low' | 'medium' | 'high';
    /** Live news backing this category — shown when the row is tapped. */
    articles?: Array<{title: string; url: string; source: string; seenAt: string; severity: 'critical' | 'caution' | 'information'}>;
  }>;
  recommendations: string[];
  counts:          VbgThreatCounts;
  lat:             number | null;
  lng:             number | null;
  created_at:      string;
}

export interface VbgThreat {
  title:    string;
  url:      string;
  source:   string;
  seenAt:   string;
  severity: 'critical' | 'caution' | 'information';
  theme:    string;
}

export interface VbgRegionThreats {
  region:  string;
  context: string;
  /** ISO-3166 alpha-2 of the reverse-geocoded country (emergency-number pinning). */
  country: string | null;
  threats: VbgThreat[];
  counts:  VbgThreatCounts;
}

export interface VbgKeyPoint {
  kind:       'police' | 'hospital' | 'embassy' | 'fire';
  label:      string;
  lat:        number;
  lng:        number;
  distanceKm: number;
}

export interface VbgGeofence {
  id:     string;
  name:   string;
  kind:   'safe' | 'danger';
  active: boolean;
}

export interface VbgFavorite {
  id:       string;
  name:     string;
  phone:    string;
  position: number;
}

export const vbgApi = {
  // Enroll returns a one-time per-device AES-256 telemetry key the client
  // must persist in the keychain (see modules/vbg/telemetryCrypto).
  enrollMonitoring: (body: {intervalMin?: number; lat?: number; lng?: number} = {}) =>
    authHttp.post<VbgMonitoringStatus & {telemetryKeyB64?: string}>('/vbg/monitoring/enroll', body),
  /** @deprecated use biometricCheckin('pass') — kept for back-compat. */
  heartbeat: (body: {lat?: number; lng?: number} = {}) =>
    authHttp.post<VbgMonitoringStatus>('/vbg/monitoring/heartbeat', body),
  biometricCheckin: (body: {result: 'pass' | 'fail'; lat?: number; lng?: number}) =>
    authHttp.post<VbgMonitoringStatus>('/vbg/biometric/checkin', body),
  monitoringStatus: () =>
    authHttp.get<VbgMonitoringStatus>('/vbg/monitoring/status'),
  // BE-7.1 — encrypted telemetry body (AES-256-GCM, base64 iv‖ct‖tag).
  telemetry: (sealed: string) =>
    authHttp.post<{ok: true; breach: boolean}>('/vbg/telemetry', {sealed}),
  panic: (body: {lat?: number; lng?: number} = {}) =>
    authHttp.post<{id: string; triggered_at: string}>('/vbg/panic', body),
  track: (sinceSec = 600) =>
    authHttp.get<{fixes: Array<{lat: number; lng: number; recordedAt: string}>}>('/vbg/track', {params: {sinceSec}}),
  // radiusKm (5/50/200) + timeWindowHours (24/48/72) are the GeoRisk search
  // controls; both optional — omitted falls back to region defaults.
  sra: (params: {lat?: number; lng?: number; radiusKm?: number; timeWindowHours?: number} = {}) =>
    authHttp.get<VbgSraSnapshot>('/vbg/sra', {params}),
  threats: (params: {lat?: number; lng?: number; timeWindowHours?: number} = {}) =>
    authHttp.get<VbgRegionThreats>('/vbg/threats', {params}),
  keypoints: (params: {lat?: number; lng?: number; radiusKm?: number} = {}) =>
    authHttp.get<{keypoints: VbgKeyPoint[]}>('/vbg/keypoints', {params}),
  // BE-7.3 — geofence management.
  listGeofences: () =>
    authHttp.get<{zones: VbgGeofence[]}>('/vbg/geofences'),
  createGeofence: (body: {name: string; kind: 'safe' | 'danger'; ring: Array<[number, number]>}) =>
    authHttp.post<{id: string}>('/vbg/geofences', body),
  deleteGeofence: (id: string) =>
    authHttp.delete<{ok: true}>(`/vbg/geofences/${id}`),
  // BE-7.6 — Next-of-Kin favorites (server-backed; survive reinstall).
  listFavorites: () =>
    authHttp.get<{favorites: VbgFavorite[]}>('/vbg/favorites'),
  setFavorites: (favorites: Array<{name: string; phone: string}>) =>
    authHttp.put<{favorites: VbgFavorite[]}>('/vbg/favorites', {favorites}),
};

// ─── Family hierarchy + shared credits ───────────────────────────────────────
export interface FamilyMember {
  id:         string;
  memberId:   string | null;
  name:       string;
  status:     'pending' | 'active' | 'revoked' | 'declined';
  spendLimit: number | null;
  spent:      number;
  invitedAt:  string;
  acceptedAt: string | null;
}

export interface FamilyInvite {
  id:         string;
  holderId:   string;
  holderName: string;
  invitedAt:  string;
}

export interface FamilyMembership {
  holderId:   string;
  holderName: string;
  spendLimit: number | null;
  spent:      number;
}

export interface FamilyUsage {
  totalSpent: number;
  members: Array<{id: string; name: string; spent: number; spendLimit: number | null; sharePct: number}>;
  recent: Array<{name: string; credits: number; at: string; bookingId: string | null}>;
}

export const familyApi = {
  // Holder side
  invite: (phoneE164: string, spendLimitCredits?: number | null) =>
    authHttp.post<{id: string; status: string}>('/family/invite', {phoneE164, spendLimitCredits}),
  members: () =>
    authHttp.get<{members: FamilyMember[]}>('/family/members'),
  usage: () =>
    authHttp.get<FamilyUsage>('/family/usage'),
  setLimit: (id: string, spendLimitCredits: number | null) =>
    authHttp.patch<{ok: true}>(`/family/members/${id}/limit`, {spendLimitCredits}),
  remove: (id: string) =>
    authHttp.delete<{ok: true}>(`/family/members/${id}`),
  // Member side
  membership: () =>
    authHttp.get<{membership: FamilyMembership | null}>('/family/membership'),
  invites: () =>
    authHttp.get<{invites: FamilyInvite[]}>('/family/invites'),
  accept: (id: string) =>
    authHttp.post<{ok: true}>(`/family/invites/${id}/accept`, {}),
  decline: (id: string) =>
    authHttp.post<{ok: true}>(`/family/invites/${id}/decline`, {}),
};

export default api;
