import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {BottomTabScreenProps} from '@react-navigation/bottom-tabs';
import type {CompositeScreenProps, NavigatorScreenParams} from '@react-navigation/native';
import type {
  AttendanceStatusDto, ReviewReasonDto,
  IncidentCategoryDto, IncidentSeverityDto, IncidentStatusDto, IncidentReportDto,
  OrgMissionDto, ShiftDto,
} from '@services/api';

// ─── Auth Stack ───────────────────────────────────────────────────────────────

export type AuthStackParamList = {
  Splash: undefined;
  Onboarding: undefined;
  Login: undefined;
  Register: {role: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise'} | undefined;
  OTPVerification: {
    phone: string;
    mode: 'login' | 'register';
    // Pending signup payload — present only when mode === 'register'.
    email?: string;
    password?: string;
    fullName?: string;
    // Mirrors Register / SignupSuccess and the authStore register action,
    // which all accept 'agent'. OTPVerification forwards this straight into
    // register(), so the value must flow through rather than be narrowed away.
    role?: 'individual' | 'corporate' | 'agent';
    tier?: 'lite' | 'pro' | 'enterprise';
  };
  // IDN-12/28 — login OTP entry when /auth/login returns no devOtpCode
  // (live Twilio delivery). userId comes from the login response.
  OtpVerify: {userId: string; phoneHint?: string};
  RoleSelection: undefined;
  ProfileCompletion: undefined;
  HomeSelection: undefined;
  SignupSuccess: {fullName: string; role: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise'};
  Permissions: undefined;
};

// ─── Main Bottom Tabs ─────────────────────────────────────────────────────────

export type MainTabParamList = {
  Dashboard: undefined;
  MessengerTab: NavigatorScreenParams<MessengerStackParamList> | undefined;
  SecureTab: NavigatorScreenParams<BookingStackParamList> | NavigatorScreenParams<AgentStackParamList> | undefined;
  NewsTab: NavigatorScreenParams<NewsStackParamList> | undefined;
  ProfileTab: undefined;
};

// ─── Messenger Stack ─────────────────────────────────────────────────────────

export type MessengerStackParamList = {
  MessengerHome: undefined;
  Chat: {conversationId: string; name: string; isGroup: boolean; draft?: string};
  VaultLock: undefined;
  // `addToGroupId` (+ name) puts NewChat in "add member to existing group"
  // mode: picking a contact calls runtime.addGroupMember instead of opening
  // a new chat. Undefined param = normal new-message / new-group flow.
  NewChat: {addToGroupId: string; groupName: string} | undefined;
  VaultScreen: undefined;
  FileVaultPurchase: undefined;
  VaultForgot: undefined;
  VaultOTPVerify: undefined;
  VaultNewPin: undefined;
  CallsLog: undefined;
  Links: undefined;
  Groups: undefined;
  ChatInfo: {conversationId: string};
  Files: undefined;
  DepartmentChannels: undefined;
  DepartmentChat: {
    channelId: string;
    channelName: string;
    channelDesc: string;
    /** Messenger group conversation id carrying the E2EE posts. May be null
     *  if the channel's Signal group hasn't been bootstrapped yet. */
    groupConversationId?: string | null;
    myRole?: 'admin' | 'viewer';
    /** True when the viewer created the channel — gates owner-only delete. */
    isOwner?: boolean;
  };
  // Manager channel management (Step 18). ChannelEditor with no `channel` = create.
  ManageChannels: undefined;
  /** M1A rule 16 — Enterprise workspace employee roster (add/suspend/remove). */
  Employees: undefined;
  /** M1A rule 16 — the full dept workspace shell (attendance + incidents +
   *  channels tabs), the same navigator providers mount. */
  Departmental: undefined;
  ChannelEditor: {
    channel?: {
      id: string;
      name: string;
      department: string | null;
      channel_type: 'board' | 'department' | 'incident';
      access: 'standard' | 'read_only' | 'restricted';
      archived: boolean;
    };
  } | undefined;
  ChannelMembers: {channelId: string; channelName: string; isOwner?: boolean};
  VoiceCall: {conversationId: string; name: string};
  CallScreen: {
    conversationId: string;
    callType: 'voice' | 'video';
    isIncoming: boolean;
    remoteUserId?: string;
    /**
     * Required for a real WebRTC call. Outgoing calls generate a fresh
     * id at the call site; incoming calls get the id from `call.offer`.
     * Routes that omit this fall back to demo-only mode.
     */
    callId?: string;
    /** Required for incoming — the offer SDP from `call.offer.from`. */
    remoteDeviceId?: number;
    incomingSdp?: string;
    /**
     * P1-BR-2 — set when the user answered from the notification/Telecom
     * surface. CallScreen auto-accepts as soon as the offer SDP is present
     * (including a queued offer replayed over the reconnecting WS) instead
     * of showing a second in-app Accept button.
     */
    autoAccept?: boolean;
  };
  /** mediasoup SFU group call (3+ participants). Bypasses CallScreen. */
  GroupCallScreen: {
    conversationId: string;
    callType: 'voice' | 'video';
    /**
     * `outgoing` rings everyone via sfu.ring; `incoming` joins straight
     * in (the IncomingGroupCallScreen already handled the ring).
     */
    direction: 'outgoing' | 'incoming';
    /** Optional: join an existing room. Omit to create one. */
    roomId?: string;
    /** Other group members to ring (exclude self). */
    recipientUserIds: string[];
    /** Display label shown in recipients' incoming ring UI. */
    callerName: string;
    /**
     * BS-CALL-ADHOC — the host/owner userId of an ad-hoc ('Call') group.
     * The host files the call master key under `direct:<owner>` on every
     * recipient (productionRuntime alias). The joiner must look the key
     * up under that SAME id, not its own asymmetric `conversationId`
     * (which is the host's local thread key and means a different user on
     * the joiner's device). Set on the incoming path from the ring's
     * `from.userId`; absent on the outgoing/host path (host owns it).
     */
    hostUserId?: string;
    /**
     * Audit P0-C2 / row #5 — per-caller HMAC room-access token.
     * Incoming path: from `sfu.ring.incoming` via IncomingGroupCall-
     * Screen. Outgoing path: host obtains its own from `POST /sfu/
     * rooms` (or 2nd-member via GET /sfu/rooms/by-conversation).
     */
    roomToken?: string;
  };
  /** Incoming group-call ring UI — accept/decline. */
  IncomingGroupCallScreen: {
    roomId:         string;
    conversationId: string;
    callType:       'voice' | 'video';
    callerName:     string;
    fromUserId:     string;
    /** Audit P0-C2 / row #5 — token to echo back in sfu.join + decline. */
    roomToken?:     string;
    /**
     * P1-BR-1 / P1-BR-2 — set when the user answered the group ring from the
     * notification. IncomingGroupCallScreen joins the room directly instead
     * of waiting on a second in-app Accept.
     */
    autoAccept?:    boolean;
  };
  MessengerSettings: undefined;
  /** Backup setup — first-time prompt to enable encrypted chat backup. */
  BackupSetup: undefined;
  /** Backup restore — entered after login when an existing backup is found. */
  BackupRestore: undefined;
  NewsHub: undefined;
  // News sub-screens accessible from the NewsHub tap targets — we host
  // them inside MessengerStack now that the root NewsTab is gone.
  IntelFeed: undefined;
  NewsFeed: undefined;
  NewsArticle: {articleId?: string; category?: string; title?: string};
  NewsPreferences: undefined;
};

// ─── Booking Stack ───────────────────────────────────────────────────────────

export type BookingStackParamList = {
  BookingHome: undefined;
  ProDashboard: undefined;
  ItineraryUpload: undefined;
  TripHistory: undefined;
  VBGHome: undefined;
  VBGMap: undefined;
  VBGNearby: undefined;
  VBGSRA: undefined;
  VBGOSINT: undefined;
  VBGGeoRisk: undefined;
  VBGEmergency: {countryName?: string; countryIso?: string} | undefined;
  IndividualProfile: undefined;
  CorporateProfile: undefined;
  ZoneMap: undefined;
  AddOns: undefined;
  BookingConfirmation: {
    bookingId: string;
    amountPaid?: number;
    currency?: string;
    paymentMethod?: 'card' | 'bravo_credits' | 'corporate';
    creditsAwarded?: number;
  };
  Credits: undefined;
  PaymentMethods: undefined;
  LiveTracking: {bookingId: string};
  TripSummary: {bookingId: string};
  // LM-U8 — full booking list behind Home's View All.
  BookingHistory: undefined;
  // F2 — the completion moment (rate + invoice + done).
  MissionComplete: {bookingId: string};
  // F1 — the numbered receipt / credit note.
  Invoice: {bookingId: string};
  RateAgency: {bookingId: string};
  Settings: undefined;
  SOSScreen: {bookingId: string};
  ProRetainers: undefined;
  ProClientProfile: undefined;
  ProTeamConfig: undefined;
  ProAIScheduling: undefined;
  ProRiskReview: undefined;
  ProAssignedTeam: undefined;
  ProLiveMission: undefined;
  OpsDashboard: undefined;
  OpsMissionDetail: {missionId: string};
  OpsRoomReview: {bookingId?: string} | undefined;
  ProActivityHistory: undefined;
  ProLanding: undefined;
  /** Bravo Pro subscription paywall. `returnTo` is the screen to navigate
   *  to once Pro is active (e.g. the gated screen re-renders unlocked). */
  ProPaywall: undefined | {returnTo?: keyof BookingStackParamList};
  /** M1A — Settings → Pricing (full tier matrix + plan changes). */
  Pricing: undefined;
  /** M1A — generic paid-tier paywall (Bravo Pro / Enterprise). */
  TierPaywall: {tier: 'pro' | 'enterprise'; returnTo?: keyof BookingStackParamList};
  CreditPaywall: undefined | {
    /** When the paywall is opened from OpsRoomReview after an existing
     *  booking failed the auto-debit, this carries the booking id so the
     *  success CTA can retry the charge against the right booking instead
     *  of creating a fresh draft. */
    bookingId?: string;
    source?: 'booking-flow' | 'opsroom' | 'wallet';
    amountDue?: number;
  };
  // Step 19 — client auto-dispatch flow (Uber-style): Searching → Accepted → (or No detail).
  FindingDetail: {bookingId: string};
  NoDetail: {bookingId: string};
  AgencyAccepted: {bookingId: string};
  ServiceType: undefined;
  BaselinePackage: undefined;
  CustomizeAddOns: undefined;
  BookingDateTime: undefined | {
    pickedAddress?: string;
    pickedLat?: number;
    pickedLng?: number;
    pickedKind?: 'pickup' | 'dropoff';
    /** timestamp used as a "dirty" marker so the Schedule screen picks up
     *  fresh coordinates even when the object otherwise matches a previous
     *  selection (React Navigation shallow-compares params). */
    pickedAt?: number;
  };
  LocationPicker: {
    kind: 'pickup' | 'dropoff';
    countryCode: string;
    initial?: {latitude: number; longitude: number; address?: string};
    /** Reserved for future callback-style invocations. */
    onPickRouteKey?: string;
  };
};

// ─── News Stack ──────────────────────────────────────────────────────────────

export type NewsStackParamList = {
  NewsHub: undefined;
  NewsFeed: undefined;
  NewsArticle: {articleId?: string; category?: string; title?: string};
  IntelFeed: undefined;
  NewsPreferences: undefined;
};

// ─── Agent Stack ─────────────────────────────────────────────────────────────

export type AgentStackParamList = {
  AgentDashboard: undefined;
  AgentRegistration: undefined;
  AgentTypeSelect: undefined;
  AgentRegistrationWizard: undefined;
  AgentCoverage: undefined;
  AgentAvailability: undefined;
  AgentDocsUpload: undefined;
  AgentAdminApproval: undefined;
  AgentDeploymentRequirements: {missionId: string};
  MissionLeadConsole: {missionId: string};
  AgentLiveTracker: {missionId: string; mode?: 'agent' | 'cpo' | 'monitor'};
  AgentHome: undefined;
  AgentKYC: undefined;
  AgentVerified: undefined;
  AgentRejected: undefined;
  JobMarketplace: undefined;
  JobDetail: {jobId: string};
  Earnings: undefined;
  // Wallet top-up (audit F-04) — purchase reachable for provider roles too.
  Credits: {tab?: 'balance' | 'topup' | 'history'} | undefined;
  PaymentMethods: undefined;
  MissionSummary: {bookingId: string};
  // Service-provider org — managed-CPO roster + create + missions board (Step 13)
  OrgRoster: undefined;
  OrgMissions: undefined;
  // JOB_PORTAL_MARKETPLACE_SPEC Fix B — the standalone open-jobs marketplace.
  JobPortal: undefined;
  // F6 — the agency earnings roll-up.
  OrgEarnings: undefined;
  OrgCompliance: undefined;
  // Provider operating-region setting (agents.region_code) — GPS default-assign + change guard.
  OrgRegion: undefined;
  OrgCreateCpo: undefined;
  // MISSION-HISTORY (#3) — a roster CPO's completed/aborted-mission call-log.
  OrgCpoMissions: {memberUserId: string; displayName?: string | null};
  // SP-MISSION-DETAIL (#2nd) — full mission detail page (escrow + crew + step flow).
  OrgMissionDetail: {job: OrgMissionDto};
  // Step 20 — full-screen incoming-offer interrupt (countdown bound to expires_at).
  IncomingOffer: {offerId: string; bookingId?: string};
  Attendance: undefined;
  // Dept Chat v2 — member attendance + incident screens (flag-gated entries).
  VerifyAttendance: {shiftId?: string; siteLabel?: string | null; mode?: 'checkin' | 'checkout'};
  AttendanceResult: {
    status?: AttendanceStatusDto | null;
    reviewReason?: ReviewReasonDto | null;
    clockInAt?: string | null;
    siteLabel?: string | null;
    mode?: 'checkin' | 'checkout';
  };
  MyAttendance: undefined;
  ReportIncidentCategory: undefined;
  ReportIncidentDetails: {category: IncidentCategoryDto; severity: IncidentSeverityDto};
  IncidentSubmitted: {ref: string | null; status: IncidentStatusDto; severity: IncidentSeverityDto};
  // Manager surfaces (Step 15)
  AdminAttendance: undefined;
  IncidentQueue: undefined;
  IncidentDetail: {incidentId: string; ref?: string | null};
  // Step 19 — the dedicated 5-tab "Departmental" module (pushed full-screen).
  Departmental: NavigatorScreenParams<DepartmentalTabParamList> | undefined;
  AgentVerificationStatus: undefined;
  // Cross-module messenger screens (full stack available from agent portal)
  MessengerHome: undefined;
  Chat: {conversationId: string; name: string; isGroup: boolean; draft?: string};
  NewChat: {addToGroupId: string; groupName: string} | undefined;
  ChatInfo: {conversationId: string};
  VaultLock: undefined;
  VaultScreen: undefined;
  FileVaultPurchase: undefined;
  VaultForgot: undefined;
  VaultOTPVerify: undefined;
  VaultNewPin: undefined;
  Groups: undefined;
  Files: undefined;
  // VoiceCall is the legacy alias used in older agent flows. The
  // call screens are all also registered here so the agent UI can
  // launch into a 1:1 / group / ringing flow. Full param shapes live
  // on the MessengerStackParamList side; agent-side typing stays
  // loose because the same components are reached via different
  // navigation paths.
  VoiceCall: {conversationId: string; name: string};
  CallScreen: MessengerStackParamList['CallScreen'];
  GroupCallScreen: MessengerStackParamList['GroupCallScreen'];
  IncomingGroupCallScreen: MessengerStackParamList['IncomingGroupCallScreen'];
  IntelFeed: undefined;
};

// ─── CPO Stack (managed guard — §35A) ────────────────────────────────────────
// The 4-tab guard shell. Capability-hidden by construction: no booking wizard,
// client wallet, job-offer accept, roster/assign-crew, or org-money screens are
// registered here (PR5). Tab contents are fleshed out in the CPO-UI step; this
// step wires the shell + activation gate + access-ended.
export type CpoTabParamList = {
  CpoDuty: undefined;
  CpoMission: undefined;
  CpoComms: NavigatorScreenParams<MessengerStackParamList> | undefined;
  CpoDept: undefined;
  CpoMe: undefined;
};

// ─── Departmental module (Dept Chat v2 — Step 19) ─────────────────────────────
// The dedicated 5-tab "Departmental" shell (PDF p.2 Product Map), opened by BOTH
// parties (managed CPO + service-provider company/manager) as a full-screen push.
// Each tab is its own native-stack reusing the Step 12–18 feature screens; param
// shapes are kept in sync with the canonical Agent/Messenger lists via indexed
// access so the reused screens type-check unchanged.

export type DeptChannelsStackParamList = {
  DepartmentChannels: MessengerStackParamList['DepartmentChannels'];
  DepartmentChat: MessengerStackParamList['DepartmentChat'];
  ManageChannels: MessengerStackParamList['ManageChannels'];
  ChannelEditor: MessengerStackParamList['ChannelEditor'];
  ChannelMembers: MessengerStackParamList['ChannelMembers'];
};

export type DeptAttendStackParamList = {
  Attendance: AgentStackParamList['Attendance'];
  VerifyAttendance: AgentStackParamList['VerifyAttendance'];
  AttendanceResult: AgentStackParamList['AttendanceResult'];
  MyAttendance: AgentStackParamList['MyAttendance'];
  AdminAttendance: AgentStackParamList['AdminAttendance'];
  // Step 21 — manager shift management (create shift + geofence + assign CPOs).
  ShiftManagement: undefined;
  ShiftEditor: {shift?: ShiftDto} | undefined;
  // Step 22 (G5) — manager sets a non-check-in day status (leave/sick/off-duty/absent).
  DayStatus: undefined;
};

export type DeptIncidentStackParamList = {
  ReportIncidentCategory: AgentStackParamList['ReportIncidentCategory'];
  ReportIncidentDetails: AgentStackParamList['ReportIncidentDetails'];
  IncidentSubmitted: AgentStackParamList['IncidentSubmitted'];
  IncidentQueue: AgentStackParamList['IncidentQueue'];
  IncidentDetail: AgentStackParamList['IncidentDetail'];
  // Step 23 — member's own submitted incidents (read-only; never internal notes).
  MyIncidents: undefined;
  MyIncidentDetail: {report: IncidentReportDto};
};

// Vault tab reuses the messenger vault flow verbatim. The root is named
// 'MessengerHome' (FilesScreen) so VaultLockScreen's hardware-back reset target
// resolves to the vault tab root instead of erroring — see DepartmentalNavigator.
export type DeptVaultStackParamList = {
  MessengerHome: undefined;
  VaultLock: undefined;
  VaultScreen: undefined;
  VaultNewPin: undefined;
  VaultForgot: undefined;
  VaultOTPVerify: undefined;
  FileVaultPurchase: undefined;
};

export type DepartmentalTabParamList = {
  Home: undefined;
  Channels: NavigatorScreenParams<DeptChannelsStackParamList> | undefined;
  Attend: NavigatorScreenParams<DeptAttendStackParamList> | undefined;
  Incident: NavigatorScreenParams<DeptIncidentStackParamList> | undefined;
  Vault: NavigatorScreenParams<DeptVaultStackParamList> | undefined;
};

// CPO root — wraps the 4-tab guard shell so the Departmental module can be pushed
// full-screen over it (its own footer, no nested-tab double footer). The four
// guard tabs stay in CpoTabParamList — capability lockdown (§35A §D) unchanged.
export type CpoRootStackParamList = {
  CpoTabs: NavigatorScreenParams<CpoTabParamList> | undefined;
  Departmental: NavigatorScreenParams<DepartmentalTabParamList> | undefined;
  // Step 31 — the map-first live tracker (the design), pushed full-screen over
  // the guard tabs. Reuses AgentLiveTrackerScreen in cpo mode (dual markers +
  // Google-Maps turn-by-turn). Reached from the Mission tab while DISPATCHED/PICKUP/LIVE.
  CpoLiveTracker: {missionId: string; mode?: 'cpo'};
};

// ─── Pro Stack ───────────────────────────────────────────────────────────────

export type ProStackParamList = {
  ProDashboard: undefined;
  ItineraryUpload: undefined;
  ItineraryDetail: {itineraryId: string};
  TripHistory: undefined;
  TripDetail: {bookingId: string};
};

// ─── Root Stack (wraps all) ──────────────────────────────────────────────────

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
  AgentStack: undefined;
  ProStack: undefined;
  // §35A §F — terminal CPO access-ended screen, shown above the auth form once a
  // revoked guard has been torn down (survives signOut via the accessEnded flag).
  AccessEnded: undefined;
};

// ─── Screen prop types ────────────────────────────────────────────────────────

export type AuthScreenProps<T extends keyof AuthStackParamList> = NativeStackScreenProps<
  AuthStackParamList,
  T
>;

export type MessengerScreenProps<T extends keyof MessengerStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<MessengerStackParamList, T>,
  BottomTabScreenProps<MainTabParamList>
>;

export type BookingScreenProps<T extends keyof BookingStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<BookingStackParamList, T>,
  BottomTabScreenProps<MainTabParamList>
>;
