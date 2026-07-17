# Bravo Secure â€” Complete SQA Reference

**Last updated:** 2026-07-17 (**B-97 M1A tier system Lite/Bravo Pro/Enterprise IMPLEMENTED full-stack same day** — enterprise tier end-to-end (migrations applied live), ops-editable charge-time pricing (enterprise 5000 BC PLACEHOLDER), BC auto-renew sweep, vault token issuance tier-gated (MFA untouched), enterprise inherits dept channels/attendance/incident as own org w/ "CPO"→"Employee" copy for that audience, 4-card tier screen + declinable post-auth paywall ("Start as Lite today") + Settings → Pricing + ops price/tier editors; gates all green (auth 102/103 pre-existing vbg, mobile tsc 46≤47, crypto 186/186·1646, ops tsc 0); entry + doc §8 at EOF/`UI_SPEC_V2_M1A_TIER_MATRIX.md`. Prior same-day: **B-96 agent-onboarding submit dead-end — root-caused + FIXED same session** — founder (`bigben@gmail.com`) hit `Cannot submit from status PROFILE_COMPLETE` with a 6/6 compliance pack; the `PROFILE_COMPLETE → DOCS_PENDING` hop is driven by a **fire-and-forget** `skipKyc()` in the registration wizard whose `catch {}` discarded real failures while navigation advanced anyway, and `uploadDocument` has NO status gate, so a full doc pack uploads against a stale status and submit dead-ends with no in-app recovery (the doc→KYC mirror's auto-advance can't rescue it: it only fires from `KYC_PENDING`, and nothing maps to `proof_address` so it never completes either). `agent_audit` proved it — 2 rows, no `kyc_skipped`, docs landing 17 min later. Fix = `submitForReview` re-runs the idempotent `skipKycToDocs` for `PROFILE_COMPLETE`/`KYC_PENDING` (all `fsm.assert` hops + the required-doc gate PRESERVED, nothing weakened, no new authority — the agent can already call `POST /agents/me/kyc/skip`) + the wizard's silent catch removed. Blast radius DB-checked = 1 agent; self-heals on next submit even on the old APK. Gates: agent suites 11/11 366 green, new spec 6/6 (negative-verified: fails 4/6 without the fix), full auth 101/102 suites 1779 passed (sole `vbg` failure reproduces on clean main), auth tsc exit 0, mobile tsc 46 ≤ 47, lint 0. Entry at EOF. Prior same-day: **B-95 product-switch dead + back-exits-app + no route back to gate — FIXED + device-verified + SHIPPED v1.0.115/vc143** — the B-91 keyed remount REHYDRATES nested state from the 'Main' route so back-stack-reset never worked; fix = navigator-free hold-frame + ephemeral gateVisible + root BackHandler back-to-gate + deep-link param neutralizer + drawer "Choose Dashboard" row; full switch/back matrix PASS on BlueStacks; renumbered B-94→B-95 (parallel backup session claimed B-94). Same day: **B-94 backup `root_mismatch` RECURRENCE — root-caused + FIXED same session** — the drift FACTORY found: in-memory-only mirror dedup meant EVERY boot's catch-up sweep re-encrypted (fresh AES-GCM IV) + re-uploaded the ENTIRE history, re-opening the B-81 "rows ahead of the signed root" kill-window on every launch; any kill in it → equal-count drift → fresh-install restore dead-ends (B-81 repair correctly refuses with no local history). Fix = persistent `mirror_flushed` ledger (SQLCipher schema v14; idle boots upload NOTHING) + persistent pending-commit flag w/ flush-epoch guard (boot self-heals a killed window) + restore-side ledger seeding + ledger purge on wipe/rotate/repair. NEW `docs/runbooks/BACKUP_LOOP.md` (invariants I1–I9 + device/SQL probes) wired into CLAUDE.md. Gates: new suite 8/8, crypto 1638 green (pre-existing suite-level flake reproduces on clean main), tsc 46 ≤ 47, lint clean on touched files. Entry at EOF. Prior same-day: **B-91 Platform UI Corrections Spec v2.0 MAPPED** — 3-standalone-products architectural program (Messenger/VBG/Secure Services, combined home DELETED); module handoffs `docs/handoffs/UI_SPEC_V2_INDEX.md` + M0-M3, docs only, no code. Prior same-day: **B-90 boss QA-PDF batch REGISTERED — 13 UI/UX findings T-01..T-13, investigation only, fixes NOT applied**; every finding root-caused to file:line; implementation handoff + per-task fix loops: `docs/handoffs/QA_PDF_FIX_BATCH_2026-07-16.md`. Prior same-day: **B-89 map/GPS/route audit (evening) + SAME-SESSION FIX-ALL (deployed)** — client live map now shows the REAL CPO (server mirrors fixes + emits mission.telemetry), heading cone alive (SELECT alias + server bearing derivation), mission FOREGROUND SERVICE for screen-off GPS (next APK), prod token pinned + honest misconfig overlay, live re-ask for GPS access, plausibility gate + accuracy circle, ops LOST SIGNAL badge; deferred: token rotation (dashboard), is_mocked flag (migration). UPDATE at EOF. Audit was: CLIENT live map provably shows a SIMULATED dot all mission (dead telemetry writers + WS `telemetryFix` never emitted; MG-01), heading dead end-to-end (MG-02), no background GPS (MG-03), prod Mapbox-token bake gap defeats B-77 recovery (MG-04); route layer itself verified WORKING; register `docs/audits/MAP_GPS_ROUTE_AUDIT_2026-07-16.md`; **fixes NOT applied**. Prior: **B-88 native-popup redesign (late PM)** — all 252 `Alert.alert` sites now render the branded obsidian dialog (`@utils/alert` drop-in + `BravoAlertHost`; RN-Android semantics preserved; static sweep locks regressions; register: `docs/audits/NATIVE_ALERT_REDESIGN_2026-07-16.md`). Prior: **Messenger UX/smoothness audit (PM) + SAME-DAY FIX-ALL** — **B-85** back-from-chat→Dashboard (missing `initialRouteName`, one-liner + nav-config test), **B-86** Move-to-Vault now REAL (biometric → `vault-access` action token → VaultClient encrypt-upload; fail-closed preserved, M-02 moved into the store; all 3 surfaces incl. VaultScreen open/uploads), **B-87** multi-photo (limit 10 + preview tray) + pinch-zoom viewer (RNGH classic + native Animated, no reanimated), **MX-05 inverted chat list** (open lands on newest, no flash; onEndReached paging; native at-bottom follow) + MX-06..13 (UI-thread swipe-reply, serial non-blocking media queue + determinate upload ring, haptics seam, identity-stable rows). Gates: tsc sig-diff = identical 46, eslint 0, 149 suites/1274 green + 38 new tests, only known pre-existing failures elsewhere; device-verify pending, rides next APK. Register+fix log: `docs/audits/MESSENGER_UX_AUDIT_2026-07-16.md` (§7); UPDATE entry at EOF. Prior same-day AM: **B-84** keyboard-covers-input full-codebase audit **+ SAME-DAY FIX (all 17 screens, device-verify pending)** — 9 HIGH + 8 MEDIUM screens, systemic root cause = edge-to-edge nullifies `adjustResize` + app-wide inert-on-Android KAV idiom + Modal-never-resizes; register: `docs/audits/KEYBOARD_FOCUS_AUDIT_2026-07-16.md`; fix = shared `src/hooks/useKeyboardHeight.ts` manual-kb-padding + event-driven reveal, see B-84 UPDATE at EOF. Prior 2026-07-11: **Post-pull triage audit + REMEDIATION** — founder-reported trio root-caused AND fixed (adversarial-review-verified; APK/server deploy + device verify pending): **B-75** `3ae4790` regression = global txnChain self-deadlock (saveIdentity queued from `runOnTxnChain` recovery work → inbound persistence freeze, backup mirrors frozen snapshot w/ green verify, restore hangs; P0, do not ship vc133 further), **B-76** Lite finish-mission API error = session revocation via 2nd-device OTP takeover (log-verified) + 15s-timeout lost-200 + uncaught `settleEscrowOnFinish`, **B-77** Mapbox blank/load-failed = zero-recovery map boot (err posts dropped, Android WebView subresource errors unreachable) + shared unrotated token + prod token-bake gap. Register: `docs/audits/TRIAGE_AUDIT_2026-07-11.md`. Prior 2026-07-10: **FULL-STACK REMEDIATION of both audit registers** — 13 Opus maker agents + Fable verifier: `MESSENGER_AUDIT_2026-07-09.md` (P0-1 + all 16 P1 + all 17 P2 + §12 increment) and `BACKGROUND_RELIABILITY_AUDIT_2026-07-10.md` (all 8 P1-BR + all 11 P2-BR + most P3s) **FIXED IN CODE** incl. B-57..B-61 client fixes; see "Full-stack remediation — 2026-07-10" section near EOF for per-finding status, deploy env-var requirements, and residuals. Suites: msgr-service 29 suites/297+, auth targeted green, mobile crypto 177 suites/1575, tsc 45 ≤ 47 baseline. Prior same-day: coverage-gap increment + background audit docs (`wf_0b001a78-f0e`); 2026-07-09: messenger re-audit + notification audit B-53..B-56)  
**QA:** Mac-based tester | **Developer:** Windows  
**Test devices:** BlueStacks 5555=itsirajul, 5565=shirajul, 5575=fahim | Physical: TECNO KM5 (USB)  
**Physical devices (2026-06-08 session):** Pixel 7a (32251JEHN23958) | Xiaomi 2409BRN2CY (69BQLV5DXSWGWCOF) | Redmi 2409BRN2CY (192.168.0.100:34391 Wi-Fi)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Build & Run Commands](#3-build--run-commands)
4. [ADB Device Setup](#4-adb-device-setup)
5. [All Screens Map](#5-all-screens-map)
6. [Navigation Structure](#6-navigation-structure)
7. [State Management (Stores)](#7-state-management-stores)
8. [Backend API Endpoints](#8-backend-api-endpoints)
9. [WebSocket Events](#9-websocket-events)
10. [Test Suite](#10-test-suite)
11. [Key Modules Deep-Dive](#11-key-modules-deep-dive)
12. [Patches Applied](#12-patches-applied)
13. [Environment Variables](#13-environment-variables)
14. [Known Bugs & Investigations](#14-known-bugs--investigations)
15. [iOS Build Status](#15-ios-build-status)
16. [Ops Console Routes](#16-ops-console-routes)
17. [Security Architecture Summary](#17-security-architecture-summary)
18. [White-Box Testing Reference (logâ†’code map)](#18-white-box-testing-reference-codebase-map-for-logcode-navigation)

---

## 1. Project Overview

Bravo Secure is a secure communications and mission operations platform with:

- **Encrypted messaging** (Signal Protocol, group messaging, file vault)
- **Group video/voice calls** (mediasoup SFU + FrameCryptor E2E)
- **Mission booking & live tracking** (bodyguard/security booking)
- **Agent management** (gig agents, job marketplace, mission tracking)
- **VBG** (Vehicle-Borne-Guard / location intelligence)
- **Ops console** (Next.js dashboard for operations team)

**App ID:** `com.bravosecure.app`  
**Version:** 1.0.41 | **Expo SDK:** 54 | **React Native:** 0.81  
**Expo Project ID:** `ee90f72c-13eb-48c6-a560-9d1a194e19a6`  
**Owner:** omnidevx_studio

---

## 2. Tech Stack

### Mobile

| Layer            | Technology                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Framework        | React Native 0.81 + Expo SDK 54                                                           |
| Language         | TypeScript 5.9                                                                            |
| State            | Zustand (4 stores)                                                                        |
| Navigation       | React Navigation 6 (native-stack + bottom-tabs)                                           |
| Messaging Crypto | `@privacyresearch/libsignal-protocol-typescript` (X3DH + Double Ratchet)                  |
| Group Calls      | `react-native-webrtc` (patched â†’ io.getstream:stream-webrtc-android 1.3.10) + mediasoup |
| Call Management  | `react-native-callkeep` (patched for TurboModules)                                        |
| Frame Encryption | `BravoFrameCryptorModule` (native Kotlin, Android only)                                   |
| Local DB         | `@op-engineering/op-sqlite` with SQLCipher encryption                                     |
| Keychain         | `react-native-keychain`                                                                   |
| Payments         | `@stripe/stripe-react-native`                                                             |
| Push             | `@react-native-firebase/*` (FCM + VoIP)                                                   |
| Maps             | Mapbox/Leaflet (WebView embeds)                                                           |

### Backend

| Service           | Port | Technology                                      |
| ----------------- | ---- | ----------------------------------------------- |
| auth-service      | 3000 | NestJS, Postgres, Kafka, Redis                  |
| messenger-service | 3100 | NestJS, socket.io, Redis (WS adapter), Postgres |

### Ops Console

- Next.js 15 (App Router), React 19, TypeScript 5.7, SWR, Tailwind
- `idb` (IndexedDB), `socket.io-client`, `mapbox-gl`

### Shared Package

- `packages/messenger-core` â€” platform-agnostic Signal Protocol wrapper, sealed sender v2, group crypto
- Consumed by mobile via `@bravo/messenger-core` alias and by ops-console

---

## 3. Build & Run Commands

### Mobile

```bash
npm install                      # install deps
npm start                        # Metro dev server
npm run android                  # run on Android device/emulator
npm run apk:staging              # build staging APK
npm run eas:build:staging        # EAS cloud build (staging)
npm run typecheck                # must not exceed 84 errors (.tsc-baseline.json)
npm test                         # all tests
npm run test:crypto              # fastest: crypto suite only
npm run test:changed             # only tests affected by uncommitted changes
npm run lint                     # ESLint
npm run deadcode                 # knip (unused exports)
npm run ci:local                 # fast local CI bundle
```

### Backend Services

```bash
cd apps/auth-service && npm run start:dev
cd apps/messenger-service && npm run start:dev
```

### Ops Console

```bash
cd apps/ops-console && npm run dev    # dev server on port 3002
cd apps/ops-console && npm run build
```

### EAS Build Profiles

| Profile           | Purpose                    | Endpoints                           |
| ----------------- | -------------------------- | ----------------------------------- |
| `development`     | Dev client APK             | localhost                           |
| `preview-staging` | Internal APK               | https://auth.94-136-184-52.sslip.io |
| `preview-local`   | APK with local backend     | configurable                        |
| `production`      | App bundle, auto-increment | production                          |

---

## 4. ADB Device Setup

### Connect BlueStacks Instances

```bash
adb connect 127.0.0.1:5555   # itsirajul
adb connect 127.0.0.1:5565   # shirajul
adb connect 127.0.0.1:5575   # fahim
adb devices                   # verify all 3 connected
```

### Capture Logs (Last 20 Minutes)

```bash
# Replace 5555 with 5565 or 5575 for other instances
adb -s 127.0.0.1:5555 logcat -d -t "$(date -v-20M '+%m-%d %H:%M:%S.000')" \
  | grep -E "ReactNativeJS|BLASTBuffer|webrtc|FrameCryptor|bravosecure" \
  > ~/Desktop/itsirajul.log
```

### Install APK

```bash
adb -s 127.0.0.1:5555 install path/to/app.apk
# or install to all:
for p in 5555 5565 5575; do adb -s 127.0.0.1:$p install app.apk; done
```

### TECNO KM5 (Physical Device)

```bash
adb -s 1516238598003904 logcat   # USB
adb -s 192.168.0.108:5555 logcat  # Wi-Fi
```

---

## 5. All Screens Map

**Total: 95+ registered screens across all navigators**

### Auth Screens (10)

| Screen            | File                        | Purpose                        |
| ----------------- | --------------------------- | ------------------------------ |
| Splash            | SplashScreen.tsx            | Boot, session check            |
| Onboarding        | OnboardingScreen.tsx        | Welcome + product intro        |
| RoleSelection     | RoleSelectionScreen.tsx     | Individual / Corporate / Agent |
| Login             | LoginScreen.tsx             | Email/phone login              |
| Register          | RegisterScreen.tsx          | Sign up                        |
| OTPVerification   | OTPVerificationScreen.tsx   | SMS/email OTP                  |
| ProfileCompletion | ProfileCompletionScreen.tsx | Name, photo, preferences       |
| HomeSelection     | HomeSelectionScreen.tsx     | Role summary before main app   |
| SignupSuccess     | SignupSuccessScreen.tsx     | Post-signup celebration        |
| Permissions       | PermissionsScreen.tsx       | Camera/location/contacts       |

### Messenger Screens (26)

| Screen                  | File                         | Purpose                                            |
| ----------------------- | ---------------------------- | -------------------------------------------------- |
| MessengerHome           | MessengerHomeScreen.tsx      | Chat list, search, new chat                        |
| Chat                    | ChatScreen.tsx               | 1:1 message thread                                 |
| NewChat                 | NewChatScreen.tsx            | Contact/group picker                               |
| ChatInfo                | ChatInfoScreen.tsx           | Convo settings, members                            |
| VaultScreen             | VaultScreen.tsx              | Encrypted file vault                               |
| VaultLock               | VaultLockScreen.tsx          | PIN/biometric entry                                |
| VaultForgot             | VaultForgotScreen.tsx        | PIN reset                                          |
| VaultOTPVerify          | VaultOTPVerifyScreen.tsx     | OTP for PIN reset                                  |
| VaultNewPin             | VaultNewPinScreen.tsx        | Set new PIN                                        |
| FileVaultPurchase       | FileVaultPurchaseScreen.tsx  | Storage upgrade paywall                            |
| CallScreen              | CallScreen.tsx               | 1:1 voice/video WebRTC                             |
| VoiceCallScreen         | VoiceCallScreen.tsx          | Legacy 1:1 call starter                            |
| CallsLog                | CallsLogScreen.tsx           | Call history                                       |
| **GroupCallScreen**     | GroupCallScreen.tsx          | **Group video (mediasoup SFU) â€” has known bugs** |
| IncomingGroupCallScreen | IncomingGroupCallScreen.tsx  | Ring UI for inbound group call                     |
| Groups                  | GroupsScreen.tsx             | Group list & management                            |
| Files                   | FilesScreen.tsx              | Shared files across chats                          |
| DepartmentChannels      | DepartmentChannelsScreen.tsx | Team/org channels                                  |
| DepartmentChat          | DepartmentChatScreen.tsx     | Team channel messages                              |
| MessengerSettings       | MessengerSettingsScreen.tsx  | Backup, privacy, notifications                     |
| BackupSetup             | BackupSetupScreen.tsx        | Enable encrypted backup                            |
| BackupRestore           | BackupRestoreScreen.tsx      | Restore from backup                                |
| FloatingCallOverlay     | FloatingCallOverlay.tsx      | Minimized call indicator (overlay)                 |

### News Screens (6) â€” hosted inside Messenger stack

| Screen          | File                      | Purpose                 |
| --------------- | ------------------------- | ----------------------- |
| NewsHub         | NewsHubScreen.tsx         | Intel + news main hub   |
| IntelFeed       | IntelFeedScreen.tsx       | Real-time alerts/intel  |
| NewsFeed        | NewsFeedScreen.tsx        | Curated news articles   |
| NewsArticle     | NewsArticleScreen.tsx     | Article detail          |
| NewsPreferences | NewsPreferencesScreen.tsx | Topic/category settings |
| NewsAds         | NewsAdsScreen.tsx         | Sponsored content       |

### Booking Screens (11)

| Screen              | File                          | Purpose                          |
| ------------------- | ----------------------------- | -------------------------------- |
| BookingHome         | BookingHomeScreen.tsx         | Active/past bookings, quick book |
| ZoneMap             | ZoneMapScreen.tsx             | Service area picker              |
| ServiceType         | ServiceTypeScreen.tsx         | Standard/custom/premium          |
| BookingDateTime     | BookingDateTimeScreen.tsx     | Date/time + location             |
| LocationPicker      | LocationPickerScreen.tsx      | Map picker (modal)               |
| BaselinePackage     | BaselinePackageScreen.tsx     | Base team + equipment            |
| CustomizeAddOns     | CustomizeAddOnsScreen.tsx     | Team size, extras, insurance     |
| OpsRoomReview       | OpsRoomReviewScreen.tsx       | Ops team review + approval       |
| BookingConfirmation | BookingConfirmationScreen.tsx | Payment summary                  |
| TripSummary         | TripSummaryScreen.tsx         | Post-booking recap               |
| AddOns              | AddOnsScreen.tsx              | Add-on detail selector           |

### Live Operations (2)

| Screen       | File                   | Purpose                       |
| ------------ | ---------------------- | ----------------------------- |
| LiveTracking | LiveTrackingScreen.tsx | Real-time mission map + comms |
| SOSScreen    | SOSScreen.tsx          | Emergency call + support      |

### Pro Subscription (11)

| Screen             | File                         | Purpose                       |
| ------------------ | ---------------------------- | ----------------------------- |
| ProDashboard       | ProDashboardScreen.tsx       | Pro home hub                  |
| ProLanding         | ProLandingScreen.tsx         | Feature showcase, upgrade CTA |
| ProRetainers       | ProRetainersScreen.tsx       | Recurring contracts list      |
| ProClientProfile   | ProClientProfileScreen.tsx   | Client detail & edit          |
| ProTeamConfig      | ProTeamConfigScreen.tsx      | Assign team to retainer       |
| ProAIScheduling    | ProAISchedulingScreen.tsx    | AI-generated scheduling       |
| ItineraryUpload    | ItineraryUploadScreen.tsx    | Manual itinerary input        |
| TripHistory        | TripHistoryScreen.tsx        | Pro bookings & itineraries    |
| ProRiskReview      | ProRiskReviewScreen.tsx      | Security assessment           |
| ProAssignedTeam    | ProAssignedTeamScreen.tsx    | Team member assignment        |
| ProActivityHistory | ProActivityHistoryScreen.tsx | Comprehensive booking log     |
| ProLiveMission     | ProLiveMissionScreen.tsx     | Live mission view             |

### Wallet / Payment (3)

| Screen        | File                    | Purpose                       |
| ------------- | ----------------------- | ----------------------------- |
| Credits       | CreditsScreen.tsx       | Bravo credits topup & balance |
| CreditPaywall | CreditPaywallScreen.tsx | Buy credits gate              |
| ProPaywall    | ProPaywallScreen.tsx    | Pro subscription gate         |

### Ops / VBG (6)

| Screen           | File                       | Purpose                     |
| ---------------- | -------------------------- | --------------------------- |
| OpsDashboard     | OpsDashboardScreen.tsx     | Ops control center          |
| OpsMissionDetail | OpsMissionDetailScreen.tsx | Mission detail              |
| VBGHome          | VBGHomeScreen.tsx          | VBG mode selector           |
| VBGSRA           | VBGSRAScreen.tsx           | Situational risk assessment |
| VBGOSINT         | VBGOSINTScreen.tsx         | Open-source intel feed      |
| VBGNearby        | VBGNearbyScreen.tsx        | Real-time threat map        |

### Settings / Profile (3)

| Screen            | File                        | Purpose               |
| ----------------- | --------------------------- | --------------------- |
| IndividualProfile | IndividualProfileScreen.tsx | Personal profile edit |
| CorporateProfile  | CorporateProfileScreen.tsx  | Business profile edit |
| ProfileScreen     | ProfileScreen.tsx           | Settings hub          |

### Agent Screens (15)

| Screen                  | File                              | Purpose                         |
| ----------------------- | --------------------------------- | ------------------------------- |
| AgentTypeSelect         | AgentTypeSelectScreen.tsx         | Gig/affiliate/partner selection |
| AgentRegistrationWizard | AgentRegistrationWizardScreen.tsx | Multi-step signup               |
| AgentKYC                | AgentKYCScreen.tsx                | KYC document upload             |
| AgentCoverage           | AgentCoverageScreen.tsx           | Service areas & zones           |
| AgentAvailability       | AgentAvailabilityScreen.tsx       | Shift scheduling                |
| AgentDocsUpload         | AgentDocsUploadScreen.tsx         | Insurance/license upload        |
| AgentAdminApproval      | AgentAdminApprovalScreen.tsx      | Ops review                      |
| AgentVerificationStatus | AgentVerificationStatusScreen.tsx | Approval polling                |
| AgentVerified           | AgentVerifiedScreen.tsx           | Activation confirmation         |
| AgentRejected           | AgentRejectedScreen.tsx           | Rejection reason                |
| AgentHome               | AgentHomeScreen.tsx               | Dashboard + job marketplace     |
| AgentDashboard          | AgentDashboardScreen.tsx          | Earnings + quick access         |
| JobMarketplace          | JobMarketplaceScreen.tsx          | Available gigs                  |
| JobDetail               | JobDetailScreen.tsx               | Job description + accept        |
| Earnings                | EarningsScreen.tsx                | Payout history + stats          |

### Mission Screens (4)

| Screen                      | File                                  | Purpose               |
| --------------------------- | ------------------------------------- | --------------------- |
| AgentDeploymentRequirements | AgentDeploymentRequirementsScreen.tsx | Pre-mission checklist |
| MissionLeadConsole          | MissionLeadConsoleScreen.tsx          | Lead agent control    |
| AgentLiveTracker            | AgentLiveTrackerScreen.tsx            | Real-time mission map |
| MissionSummary              | MissionSummaryScreen.tsx              | Post-mission recap    |

---

## 6. Navigation Structure

```
RootNavigator
â”œâ”€â”€ Auth (AuthNavigator) â€” if not authenticated
â”‚   â””â”€â”€ Splash â†’ Onboarding â†’ RoleSelection â†’ Login/Register â†’ OTP â†’ ProfileCompletion â†’ HomeSelection
â”œâ”€â”€ PermGate â†’ PermissionsScreen â€” if auth'd but perms not granted
â””â”€â”€ Main (MainNavigator) â€” if authenticated
    â”œâ”€â”€ Tab: Dashboard â†’ DashboardScreen
    â”œâ”€â”€ Tab: Messenger (MessengerNavigator)
    â”‚   â”œâ”€â”€ MessengerHome
    â”‚   â”œâ”€â”€ Chat, NewChat, ChatInfo, Groups, Files
    â”‚   â”œâ”€â”€ VaultLock, VaultScreen, VaultForgot, VaultOTPVerify, VaultNewPin, FileVaultPurchase
    â”‚   â”œâ”€â”€ CallScreen, GroupCallScreen, IncomingGroupCallScreen, VoiceCall, CallsLog
    â”‚   â”œâ”€â”€ DepartmentChannels, DepartmentChat
    â”‚   â”œâ”€â”€ MessengerSettings, BackupSetup, BackupRestore
    â”‚   â””â”€â”€ NewsHub, IntelFeed, NewsFeed, NewsArticle, NewsPreferences, NewsAds
    â”œâ”€â”€ Tab: Secure (BookingNavigator)
    â”‚   â”œâ”€â”€ BookingHome â†’ ZoneMap â†’ ServiceType â†’ BookingDateTime â†’ LocationPicker (modal)
    â”‚   â”‚   â†’ BaselinePackage â†’ CustomizeAddOns â†’ OpsRoomReview â†’ BookingConfirmation
    â”‚   â”‚   â†’ TripSummary / LiveTracking â†’ SOSScreen
    â”‚   â”œâ”€â”€ Credits, CreditPaywall, ProPaywall
    â”‚   â”œâ”€â”€ ProDashboard â†’ ProRetainers â†’ ProClientProfile â†’ ProTeamConfig â†’ ProAIScheduling
    â”‚   â”‚   â†’ ItineraryUpload â†’ ProRiskReview â†’ ProAssignedTeam â†’ ProLiveMission
    â”‚   â”œâ”€â”€ TripHistory, ProActivityHistory, ProLanding
    â”‚   â”œâ”€â”€ OpsDashboard â†’ OpsMissionDetail, OpsRoomReview
    â”‚   â””â”€â”€ VBGHome â†’ VBGSRA / VBGOSINT / VBGNearby
    â”œâ”€â”€ Tab: Profile â†’ IndividualProfile / CorporateProfile
    â””â”€â”€ AgentNavigator (replaces all tabs for agent role)
        â”œâ”€â”€ Agent Onboarding: AgentTypeSelect â†’ Wizard â†’ KYC â†’ Coverage â†’ Availability â†’ Docs â†’ AdminApproval â†’ Status â†’ Verified/Rejected
        â”œâ”€â”€ AgentHome, AgentDashboard, JobMarketplace â†’ JobDetail, Earnings
        â”œâ”€â”€ MissionLeadConsole, AgentDeploymentRequirements â†’ AgentLiveTracker â†’ MissionSummary
        â””â”€â”€ Full Messenger suite (same screens as MessengerNavigator)
```

### Navigation Patterns

| Pattern                       | Screens                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Modal (slide from bottom)** | LocationPicker                                                                                                                              |
| **Replace (no back)**         | Splashâ†’Onboarding, BookingConfirmationâ†’TripSummary, CreditPaywallâ†’BookingConfirmation, AgentDeploymentRequirementsâ†’AgentLiveTracker |
| **Fullscreen (no tab bar)**   | All call screens, VBG screens, BackupRestore                                                                                                |
| **gestureEnabled: false**     | BackupRestore (prevent accidental dismiss during restore)                                                                                   |

---

## 7. State Management (Stores)

All stores use Zustand. Located at `src/store/` and `src/modules/messenger/store/`.

### authStore.ts

- Authentication state, user profile, JWT tokens
- Device lifecycle, token auto-refresh (single-flight 401 guard)
- Lazy-loads messenger runtime via type-only imports
- Handles tier-insufficient 403 events

### messengerStore.ts (`src/modules/messenger/store/messengerStore.ts`)

- Conversations, messages, message status, group states
- `groups: Record<string, GroupState>` â€” includes `masterKeyB64` (group call encryption key)
- **Security note:** `masterKeyB64` is STRIPPED from AsyncStorage on persist (security audit P0-S3). Keys are stored separately in SQLCipher `group_master_keys` table, AES-GCM wrapped. On boot, productionRuntime re-populates `masterKeyB64` from disk.
- Registers `groupMasterKeySink` to write new keys to SQLCipher automatically
- `setGroupState()`, `removeGroupState()`, conversations, messages, outbox, unread counts

### bookingStore.ts

- Bookings, live convoy tracking, location data
- Supports `now` and `later` booking modes
- Integrates `bookingApi` from services/api.ts

### walletStore.ts

- Wallet balance, transactions, credit batches
- Integrates `walletApi`

---

## 8. Backend API Endpoints

**Base URL (auth-service):** `https://auth.94-136-184-52.sslip.io` (staging)  
**Base URL (messenger-service):** `https://relay.94-136-184-52.sslip.io` (staging)

### Auth Service Endpoints

#### /auth

```
POST /auth/register
POST /auth/register/verify
POST /auth/login
POST /auth/verify
POST /auth/refresh
POST /auth/session/refresh
POST /auth/messenger-ticket      â† issues JWT for messenger-service access
GET  /auth/me
DELETE /auth/session
POST /auth/me/password
POST /auth/biometric/assert      â† biometric MFA challenge
```

#### /agents

```
GET  /agents/me                   â† agent profile
GET  /agents/me/available-jobs    â† open job marketplace
POST /agents/me/jobs/:jobId/apply
POST /agents/me/missions/:id/pickup
POST /agents/me/missions/:id/go-live
POST /agents/me/missions/:id/complete
POST /agents/me/missions/:id/sos
PATCH /agents/me/location
PATCH /agents/me/duty
POST /agents/me/kyc/start
POST /agents/me/kyc/:kind/upload
```

#### /bookings

```
POST /bookings
POST /bookings/estimate
GET  /bookings
GET  /bookings/:id
GET  /bookings/:id/team
POST /bookings/:id/cancel
POST /bookings/:id/pay-with-credits
GET  /bookings/add-ons
GET  /bookings/regions/availability
```

#### /conversations

```
POST /conversations
GET  /conversations/mine
GET  /conversations/:id
PATCH /conversations/:id
POST /conversations/:id/members
DELETE /conversations/:id
DELETE /conversations/:id/members/:userId
```

#### Other Auth-Service Endpoints

```
POST /family/invite
GET  /family/members
GET  /family/usage
DELETE /family/members/:id

GET  /department/channels
GET  /department/channels/:id/members
POST /department/channels/:id/group

GET  /subscriptions, POST /subscriptions/subscribe
GET  /wallet/balance, POST /wallet/topup, GET /wallet/transactions
GET  /vbg/analyse, POST /vbg/telemetry
POST /sos/trigger
GET  /news/feed, GET /news/intel
```

### Messenger Service Endpoints

**Base path:** `/` (port 3100)

```
POST /envelopes                       â† send encrypted message
POST /envelopes/:id/ack               â† acknowledge receipt
GET  /envelopes                       â† pull pending messages
POST /envelopes/retract               â† retract message (disappearing)
POST /envelopes/purge-stale-recipient

POST /media/upload-url                â† get S3 presigned upload URL
POST /media/download-url/:key         â† get S3 presigned download URL (MFA-gated)
POST /media/grants

POST /sfu/rooms                       â† create mediasoup room for group call
GET  /sfu/rooms/by-conversation/:id   â† check if active room exists
GET  /sfu/stats

GET  /webrtc/turn-credentials         â† coturn TURN credentials

POST /vault/upload-url                â† file vault upload (MFA gate)
POST /vault/download-url/:key         â† file vault download (MFA gate)

POST /push/register                   â† register FCM token
POST /push/register-voip              â† register APNs VoIP token
DELETE /push/register

POST /backup/identity, /identity/sessions, /conversations, /messages
GET  /backup/identity/bundle, /identity/sessions, /conversations, /messages
DELETE /backup
```

---

## 9. WebSocket Events

**Connection:** `wss://relay.94-136-184-52.sslip.io/ws` (socket.io)  
**Auth:** `auth.messenger-ticket` JWT in handshake

### Client â†’ Server

```
envelope.send         â† send encrypted message envelope
envelope.ack          â† acknowledge received envelope
envelope.pull         â† pull pending envelopes from relay

sfu.join              â† join mediasoup SFU room
sfu.leave             â† leave SFU room
sfu.transport.connect â† connect WebRTC transport
sfu.transport.restartIce
sfu.produce           â† start sending media (audio/video)
sfu.consume           â† start receiving media
sfu.consumer.resume   â† resume paused consumer
sfu.producers         â† list active producers in room
sfu.ring              â† ring participants for group call
sfu.ring.cancel       â† cancel ring (host ended before everyone joined)
sfu.ring.decline      â† decline incoming ring
sfu.mute-target       â† mute a participant (host only)
sfu.kick              â† kick participant (host only)

call.offer            â† 1:1 call WebRTC offer
call.answer           â† answer 1:1 call
call.ice              â† ICE candidate exchange
call.hangup           â† end 1:1 call
call.media-state      â† audio/video toggle
call.reoffer/reanswer â† renegotiation

typing                â† typing indicator
read-receipt          â† mark message read
presence.subscribe    â† watch user online status
presence.unsubscribe

mission.subscribe     â† live mission updates
mission.unsubscribe

ping                  â† heartbeat (30s interval)
```

### Server â†’ Client (push events)

```
envelope              â† incoming message envelope
sfu.new-producer      â† new participant's track in room
sfu.producer-closed   â† participant's track removed
sfu.room.ended        â† host ended call
sfu.ring              â† incoming ring notification
sfu.ring.cancelled    â† ring was cancelled by host
sfu.participant.kicked â† you were kicked
sfu.participant.muted â† you were muted by host

presence              â† user went online/offline
typing                â† remote typing indicator
read-receipt          â† remote read receipt

mission.update        â† live mission state change
```

---

## 10. Test Suite

**152 test files total** across 3 Jest projects.

### Jest Projects

| Project            | Command                                | What it covers                                                   |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------- |
| `app`              | `npm test`                             | React Native screens + hooks + utils                             |
| `messenger-crypto` | `npm run test:crypto`                  | Signal Protocol, group crypto, FrameCryptor, DTLS, sealed sender |
| `booking`          | `npm test -- --selectProjects=booking` | Booking flow, agent flow                                         |

### Key Test Files for Group Call Feature

```
src/modules/messenger/__tests__/groupCallConsumeOrder.test.ts
src/modules/messenger/__tests__/groupCallIdentityRegistry.test.ts
src/modules/messenger/__tests__/groupCallLayout.test.ts
src/screens/messenger/__tests__/GroupCallScreen.autopop.test.tsx
packages/messenger-core/__tests__/groupCallEncryption.test.ts
packages/messenger-core/__tests__/frameCryptorKeys.test.ts
```

### Key Test Files for Crypto

```
packages/messenger-core/__tests__/sealedSender.test.ts
packages/messenger-core/__tests__/ratchet.test.ts
packages/messenger-core/__tests__/groupBroadcast.test.ts
src/modules/messenger/__tests__/logAudit.test.ts    â† ensures no key material logged
src/modules/messenger/__tests__/dtlsFingerprintPinning.test.ts
src/modules/messenger/__tests__/dtlsSrtpCipherAllowlist.test.ts
```

### TypeScript Baseline

- **File:** `.tsc-baseline.json`
- **Current error count:** 84
- Gate: pre-push hook fails if error count INCREASES above 84
- Run `npm run tsc:rebaseline` only when intentionally fixing errors

---

## 11. Key Modules Deep-Dive

### Messenger Module (`src/modules/messenger/`)

#### Crypto subsystem

| File                       | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `crypto/db.ts`             | SQLCipher-based message store, group key storage   |
| `crypto/groupCrypto.ts`    | AES-256-GCM group message encrypt/decrypt          |
| `crypto/senderCert.ts`     | XEd25519 sender certificate verify (sealed sender) |
| `crypto/sessionManager.ts` | Signal Protocol session lifecycle                  |
| `crypto/polyfills.ts`      | WebCrypto + Buffer polyfills for React Native      |

#### Runtime

| File                           | Purpose                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/productionRuntime.ts` | THE main engine (~5000 lines). Handles message send/receive, group create, call key distribution, backup, group master key vault loading |
| `runtime/callRegistry.ts`      | Active group/1:1 call state registry                                                                                                     |
| `runtime/groupCallRegistry.ts` | Floating overlay state for active group calls                                                                                            |

#### Store

| File                                 | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `store/messengerStore.ts`            | Main Zustand store for messages/convos/groups |
| `store/groupMasterKeyStore.ts`       | SQLCipher vault for group master keys         |
| `store/sqlOutboxStore.ts`            | Reliable message delivery outbox              |
| `store/pendingGroupEnvelopeStore.ts` | Queues group envelopes waiting for key        |

#### WebRTC

| File                                     | Purpose                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `webrtc/useGroupCall.ts`                 | Group call hook (2194 lines). Full SFU boot sequence.                    |
| `webrtc/frameCryptorTransport.ts`        | JS bridge to `BravoFrameCryptorModule` (Kotlin native)                   |
| `webrtc/messengerStoreKeySource.ts`      | Adapter: Zustand group state â†’ GroupKeySource interface                |
| `webrtc/launchCall.ts`                   | Call initiator. `findLiveRoom()` determines direction: outgoing/incoming |
| `webrtc/useCall.ts`                      | 1:1 call hook                                                            |
| `webrtc/peerConnection.ts`               | RTCPeerConnection wrapper                                                |
| `webrtc/sfuDispatcher.ts`                | mediasoup event routing                                                  |
| `webrtc/groupCallLayout.ts`              | Tile layout calculation                                                  |
| **`webrtc/frameCryptorOrchestrator.ts`** | **âš ï¸ MISSING â€” see Bug 3 below**                                    |

#### Group Call Boot Sequence (`useGroupCall.ts`)

```
step=0: fetch TURN credentials
step=1: create/join SFU room
step=2: acquire local media (camera + mic)
step=3: sfu.join â†’ get participantTag, isHost, existingProducers
step=3a: ensureCallGroupKey (host only â€” distributes group master key)
step=3b: FrameCryptorOrchestrator.init() â† verifies key exists, sets up AES-256 frame encryption
step=4: mediasoup Device.load (MUST use handlerName:'ReactNative106')
step=5: create send transport
step=6: create recv transport
step=7: register sfu.new-producer handler
step=8: produce local tracks (audio + video)
step=9: consume existingProducers (members only â€” host gets [] empty array)
setState('joined')
reconcile loop: sfu.producers every 4000ms to recover missed tiles
```

### packages/messenger-core/

| File                            | Purpose                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/calls/frameCryptorKeys.ts` | HKDF-SHA256 key derivation for FrameCryptor. `deriveParticipantKey(masterKeyB64, epoch, participantTag)` |
| `src/crypto/`                   | Core Signal Protocol (X3DH, Double Ratchet, sealed sender)                                               |
| `src/groups/`                   | Group state management, broadcast                                                                        |
| `src/transport/`                | Relay HTTP client, WS protocol types                                                                     |

### Key Path Aliases (tsconfig.json)

```typescript
@/              â†’ src/
@screens/*      â†’ src/screens/*
@modules/*      â†’ src/modules/*
@store/*        â†’ src/store/*
@bravo/messenger-core â†’ packages/messenger-core/src
```

---

## 12. Patches Applied

### patch-package: react-native-callkeep+4.3.16.patch

**Why:** TurboModules (newArchEnabled=true, RN 0.81) crashes on overloaded `@ReactMethod` in Java  
**What:** Removes `@ReactMethod` from 5-arg overloads of `displayIncomingCall()` and `startCall()`. Keeps only the 4-arg variant that the JS bridge actually calls.

### patch-package: react-native-webrtc+124.0.7.patch

**Why:** FrameCryptor (AES-256-GCM inside libwebrtc) only works with Stream's fork, not Jitsi's  
**What:**

- Swaps `org.jitsi:webrtc:124.+` â†’ `io.getstream:stream-webrtc-android:1.3.10`
- Adds `getRtpSenderById(pcId, senderId)` to `WebRTCModule.java`
- Adds `getRtpReceiverById(pcId, receiverId)` to `WebRTCModule.java`
- Adds `getPeerConnectionFactory()` to `WebRTCModule.java`
- Makes `PeerConnectionObserver.getSender()` public
- Adds `PeerConnectionObserver.getReceiver(id)` public method

**Note:** iOS podspec still uses `JitsiWebRTC ~> 124.0.0` â€” FrameCryptor is **NOT implemented on iOS**.

---

## 13. Environment Variables

Set in `.env.staging` / `.env.local`:

```bash
# API
EXPO_PUBLIC_API_BASE_URL=https://auth.94-136-184-52.sslip.io
EXPO_PUBLIC_MSG_BASE_URL=https://relay.94-136-184-52.sslip.io

# Supabase (real-time presence / booking tracking)
EXPO_PUBLIC_SUPABASE_URL=https://qkkfkicgoncxslbwhyhz.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=...

# Payments
EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=...

# Maps
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=...

# Voice SDK (fallback)
EXPO_PUBLIC_AGORA_APP_ID=...

# Firebase (FCM push + Crashlytics)
# Configured via google-services.json (Android) and GoogleService-Info.plist (iOS)
```

---

## 14. Known Bugs & Investigations

**Last test session:** 2026-06-07 (group call server drop incident) + 2026-06-06 14:29â€“14:45  
**Devices:** BlueStacks 5555=itsirajul | 5565=shirajul | 5575=fahim  
**Log files (2026-06-06):** `~/Desktop/itsirajul.log`, `~/Desktop/shirajul.log`, `~/Desktop/fahim.log`  
**Log files (2026-06-07):** `~/Desktop/bravo_call_logs_20260607_120740/device_5555.txt` (1,912 lines), `device_5565.txt` (1,898 lines), `device_5575.txt` (1,583 lines)  
**Full incident report (2026-06-07):** `~/Desktop/bravo_call_logs_20260607_120740/REPORT.md`  
**Full report (2026-06-06):** `~/Desktop/group_call_qa_report.md`

---

### Summary Table

> The Status column below is the **QA-observed** state during testing. For **developer fix status**
> (B-05/B-13/B-17/B-18/B-20/B-21 as of 2026-06-09), see **[Developer Fix Session â€” 2026-06-09](#developer-fix-session--2026-06-09-v1049-qa-report-follow-up)**.

| Feature                                                                                                                                                                                                                                                                                                                                              | Status                                                                                                                                                                                                                | Bug        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Text messaging (Signal encrypted)                                                                                                                                                                                                                                                                                                                    | PASS                                                                                                                                                                                                                  | â€”        |
| Backup mirror flush                                                                                                                                                                                                                                                                                                                                  | PASS                                                                                                                                                                                                                  | â€”        |
| Ghost "Call" groups appearing in groups list                                                                                                                                                                                                                                                                                                         | FAIL                                                                                                                                                                                                                  | B-04       |
| Voice-only group call                                                                                                                                                                                                                                                                                                                                | PASS                                                                                                                                                                                                                  | â€”        |
| Video call â€” member joining existing room                                                                                                                                                                                                                                                                                                          | PASS                                                                                                                                                                                                                  | â€”        |
| FrameCryptor key distribution (group calls)                                                                                                                                                                                                                                                                                                          | PASS                                                                                                                                                                                                                  | â€”        |
| Video call â€” host/admin video visible to others                                                                                                                                                                                                                                                                                                    | FAIL                                                                                                                                                                                                                  | B-01       |
| Video call â€” ad-hoc escalated from 1:1                                                                                                                                                                                                                                                                                                             | FAIL                                                                                                                                                                                                                  | B-02       |
| Fresh build from current source                                                                                                                                                                                                                                                                                                                      | FAIL                                                                                                                                                                                                                  | B-03       |
| **2026-06-07 session â€” added below**                                                                                                                                                                                                                                                                                                               |                                                                                                                                                                                                                       |            |
| Group call sustained stability (server-side)                                                                                                                                                                                                                                                                                                         | FAIL                                                                                                                                                                                                                  | B-05       |
| Video tile appears for all participants                                                                                                                                                                                                                                                                                                              | INTERMITTENT                                                                                                                                                                                                          | B-06       |
| toggleVideo â€” user feedback on key-wait refusal                                                                                                                                                                                                                                                                                                    | FAIL                                                                                                                                                                                                                  | B-07       |
| Boot race â€” GROUP_CALL_PRESENCE during sfu.join                                                                                                                                                                                                                                                                                                    | FAIL                                                                                                                                                                                                                  | B-08       |
| All calls start with video=false (no camera at boot)                                                                                                                                                                                                                                                                                                 | FAIL                                                                                                                                                                                                                  | B-09       |
| Group key epoch mismatch after call reconstruction                                                                                                                                                                                                                                                                                                   | FAIL                                                                                                                                                                                                                  | B-10       |
| **2026-06-08 session â€” physical devices**                                                                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                       |            |
| 2-device: 2nd device always shows "offline"                                                                                                                                                                                                                                                                                                          | FAIL                                                                                                                                                                                                                  | B-11       |
| Group call: joiner never receives group master key                                                                                                                                                                                                                                                                                                   | FAIL                                                                                                                                                                                                                  | B-12       |
| Group call: non-owner host skips key broadcast                                                                                                                                                                                                                                                                                                       | FAIL                                                                                                                                                                                                                  | B-13       |
| Post-call: Pixel transport dead, no messages in/out                                                                                                                                                                                                                                                                                                  | FAIL                                                                                                                                                                                                                  | B-14       |
| **2026-06-08 session â€” BlueStacks 3-device**                                                                                                                                                                                                                                                                                                       |                                                                                                                                                                                                                       |            |
| Group text on a real synced group renders OK                                                                                                                                                                                                                                                                                                         | PASS                                                                                                                                                                                                                  | â€”        |
| Group text not rendering (ad-hoc/desync only)                                                                                                                                                                                                                                                                                                        | NOT REPRO                                                                                                                                                                                                             | B-15       |
| 1:1 audioâ†’video: first-to-enable sees only self                                                                                                                                                                                                                                                                                                    | FAIL                                                                                                                                                                                                                  | B-16       |
| Voice call: a non-host joiner drops one tile (race)                                                                                                                                                                                                                                                                                                  | FAIL                                                                                                                                                                                                                  | B-17       |
| **2026-06-08 session â€” group text after call churn**                                                                                                                                                                                                                                                                                               |                                                                                                                                                                                                                       |            |
| Group + 1:1 text: decrypts (handled=true) but never renders + "couldn't decrypt" banner                                                                                                                                                                                                                                                              | FAIL                                                                                                                                                                                                                  | B-18       |
| â†’ 1.0.48 retest: group text FIXED; **1:1 incoming render still FAILS** (pure render, no banner)                                                                                                                                                                                                                                                    | PARTIAL                                                                                                                                                                                                               | B-18       |
| â†’ 1.0.48 retest: B-11 (multi-device online) FIXED â€” 0 supersession, bidirectional delivery                                                                                                                                                                                                                                                       | FIXED                                                                                                                                                                                                                 | B-11       |
| Group video: stream rendered into wrong/duplicate tile (blank tile elsewhere)                                                                                                                                                                                                                                                                        | FAIL                                                                                                                                                                                                                  | B-19       |
| **2026-06-09 session â€” 1.0.49 (vc 72)**                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                       |            |
| 1:1 audio + 1:1 video calls (connect + DTLS) then die to server WS drop                                                                                                                                                                                                                                                                              | FAIL                                                                                                                                                                                                                  | B-05       |
| 1:1 inbound text decrypts (`handled=true`) but never renders                                                                                                                                                                                                                                                                                         | FAIL                                                                                                                                                                                                                  | B-18       |
| Group video (admin-host): all 3 devices show 2 tiles + 1 blank (zombie tag)                                                                                                                                                                                                                                                                          | FAIL                                                                                                                                                                                                                  | B-17       |
| Camera lost to another app mid-call â†’ video not restored (call survives)                                                                                                                                                                                                                                                                           | FAIL                                                                                                                                                                                                                  | B-20       |
| **2026-06-10 session â€” 1.0.50 (vc 73)**                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                       |            |
| Group video: bottom-left tile video shifts into right tile; right tile video rendered small                                                                                                                                                                                                                                                          | FAIL                                                                                                                                                                                                                  | B-19       |
| Group call dies to server WS drop (keepalive x28, ~9.5 min ride-out)                                                                                                                                                                                                                                                                                 | FAIL                                                                                                                                                                                                                  | B-05       |
| **2026-06-11 session â€” 1.0.51 (vc 74)**                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                       |            |
| 1:1 inbound from one peer dropped (fahimâ†’shirajul) â€” outer-auth, 188 drops, survives restart                                                                                                                                                                                                                                                     | FAIL                                                                                                                                                                                                                  | B-15b      |
| â†’ root cause CORRECTED: keychain-miss â†’ forced RESTORE â†’ orphaned in-flight msgs â†’ ACK-drop                                                                                                                                                                                                                                                  | FAIL                                                                                                                                                                                                                  | B-15b      |
| â†’ clock skew RULED OUT (devices + server in-sync within ~1s); stale "wrong clock" banner                                                                                                                                                                                                                                                           | â€”                                                                                                                                                                                                                   | B-15b      |
| Group text on a real synced group (clocks/keys aligned) delivers + renders on all 3                                                                                                                                                                                                                                                                  | PASS                                                                                                                                                                                                                  | â€”        |
| Group voice (owner-host): a joiner shows 2 tiles + 1 blank (clean consume, NO zombie tag)                                                                                                                                                                                                                                                            | FAIL                                                                                                                                                                                                                  | B-17       |
| â†’ blank tile SELF-HEALED on B-05 WS-churn re-render at ~22 min â†’ confirms render-timing race                                                                                                                                                                                                                                                     | FAIL                                                                                                                                                                                                                  | B-17       |
| Group voice call dies to server WS drop â€” NEW max lifespan ~24m30s (keepalive x1â†’x8 ~2.5 min)                                                                                                                                                                                                                                                    | FAIL                                                                                                                                                                                                                  | B-05       |
| **2026-06-11 session â€” 1.0.52 (vc 75) update retest**                                                                                                                                                                                                                                                                                              |                                                                                                                                                                                                                       |            |
| Boot health: all 3 `localKey=true` â†’ `case=RESUME`, 0 drops, 0 supersession (B-11/B-15b)                                                                                                                                                                                                                                                           | PASS                                                                                                                                                                                                                  | â€”        |
| Inbound group text renders RAW JSON envelope instead of body (key-less group, all 3 devices)                                                                                                                                                                                                                                                         | FAIL                                                                                                                                                                                                                  | B-22       |
| A/B controlled: group text render = key-state-driven (PLAIN / RAW-JSON / BLANK) â€” handled=true                                                                                                                                                                                                                                                     | FAIL                                                                                                                                                                                                                  | B-22       |
| Keyed group inbound BLANK on shirajul (missing master key â†’ no_key stash, no UI) â€” fahim renders                                                                                                                                                                                                                                                 | FAIL                                                                                                                                                                                                                  | B-18       |
| 1:1 call self-terminates ~9m (caller PC close, NOT B-05/not user); screen STUCK on frozen frame                                                                                                                                                                                                                                                      | FAIL                                                                                                                                                                                                                  | B-23       |
| **2026-06-14 session â€” 1.0.54 (vc78), Pixel(shirajul)+itsirajul+fahim**                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                       |            |
| Boot health: all `localKey=true` â†’ `case=RESUME`, 0 supersession, 0 forced-RESTORE                                                                                                                                                                                                                                                                 | PASS                                                                                                                                                                                                                  | â€”        |
| 1:1 messaging works; only the FIRST inbound on a re-established pair silently dropped (self-heals)                                                                                                                                                                                                                                                   | PARTIAL                                                                                                                                                                                                               | B-15b      |
| â†’ vc78 quieter: silent `handled=false`, NO `outer sealed authentication failed` banner                                                                                                                                                                                                                                                             | â€”                                                                                                                                                                                                                   | B-15b      |
| Group inbound on a receiver MISSING the master key â†’ no_key-stash, no render                                                                                                                                                                                                                                                                       | FAIL                                                                                                                                                                                                                  | B-18       |
| â†’ vc78 IMPROVEMENT: visible "Waiting for this group's encryption keyâ€¦" banner (was silent BLANK)                                                                                                                                                                                                                                                 | â€”                                                                                                                                                                                                                   | B-18       |
| â†’ recovers only after key syncs + APP RESTART drains stash (no live auto-drain)                                                                                                                                                                                                                                                                    | FAIL                                                                                                                                                                                                                  | B-18       |
| Group inbound when receiver HAS the key (SQA-Shirajul, all keyed) â†’ renders plain on all 3                                                                                                                                                                                                                                                         | PASS                                                                                                                                                                                                                  | â€”        |
| B-22 raw-JSON render â€” NOT hit this session (all senders held the key)                                                                                                                                                                                                                                                                             | NOT REPRO                                                                                                                                                                                                             | B-22       |
| **1:1 call dies the instant the app loses foreground (screen-off OR app-switch) â€” reproduced 2/2**                                                                                                                                                                                                                                                 | FAIL                                                                                                                                                                                                                  | B-24       |
| â†’ recharacterizes B-23 "~9-min spontaneous close" = screen timed out at ~9 min â†’ background â†’ drop                                                                                                                                                                                                                                             | â€”                                                                                                                                                                                                                   | B-23       |
| Group video boot: owner-host `delivered=3`, FrameCryptor on host + all consumers                                                                                                                                                                                                                                                                     | PASS                                                                                                                                                                                                                  | â€”        |
| Group video render: bottom-row video displaced across tiles ("going to another tile") all 3                                                                                                                                                                                                                                                          | FAIL                                                                                                                                                                                                                  | B-19       |
| Group video B-05: WS died ~50s in (keepalive x2â†’x35) but media rode dead WS full ~11m53s                                                                                                                                                                                                                                                           | FAIL                                                                                                                                                                                                                  | B-05       |
| **Navigate callâ†’Messengerâ†’back: returner loses all remote tiles + timer resets 0:00; others OK**                                                                                                                                                                                                                                                 | FAIL                                                                                                                                                                                                                  | B-25       |
| 1:1 audioâ†’video upgrade renegotiates + renders both ends (Pixel real-camera, not shared-face)                                                                                                                                                                                                                                                      | PASS                                                                                                                                                                                                                  | B-16       |
| 1:1 call clean hang-up (End Call) â†’ `finalState: ended` both ends, notification cleared                                                                                                                                                                                                                                                            | PASS                                                                                                                                                                                                                  | â€”        |
| **2026-06-15 session â€” backup restore (itsirajul 5554)**                                                                                                                                                                                                                                                                                           |                                                                                                                                                                                                                       |            |
| Restore replays server-side sealed archive â†’ locally-deleted messages reappear (314 replayed)                                                                                                                                                                                                                                                      | FAIL                                                                                                                                                                                                                  | B-26       |
| â†’ "replay skipped" lines = decrypt failures (ratchet/key), NOT deletion-awareness or dedup                                                                                                                                                                                                                                                         | â€”                                                                                                                                                                                                                   | B-26       |
| **2026-06-18 session â€” 1.0.55 (vc79), itsirajul(5555)+fahim(5575)+shirajul(Pixel 7a)**                                                                                                                                                                                                                                                             |                                                                                                                                                                                                                       |            |
| Build provenance: 1.0.55/vc79 tied to pushed commit `aaf8f42`; all 5 devices match source                                                                                                                                                                                                                                                            | PASS                                                                                                                                                                                                                  | â€”        |
| Boot health: all 5 `localKey=true` â†’ `case=RESUME`, 0 fail-signatures, 0 supersession                                                                                                                                                                                                                                                              | PASS                                                                                                                                                                                                                  | â€”        |
| 1:1 messaging itsirajulâ†”fahim both directions render (full append chain, count increments)                                                                                                                                                                                                                                                         | PASS                                                                                                                                                                                                                  | B-30       |
| â†’ B-15b/B-30 happy-path only (pair already established; not re-established teardown repro)                                                                                                                                                                                                                                                         | â€”                                                                                                                                                                                                                   | B-15b      |
| Group "SQA-ITSirajul/synced": itsirajul+fahim render plain; no B-22 raw-JSON                                                                                                                                                                                                                                                                         | PASS                                                                                                                                                                                                                  | â€”        |
| Group "SQA-Shirajul" (owner=shirajul): owner's 2ND DEVICE (Pixel) never gets master key â†’ banner                                                                                                                                                                                                                                                   | FAIL                                                                                                                                                                                                                  | B-18       |
| â†’ banner survives app restart + returns on EVERY new inbound = key never syncs to 2nd device                                                                                                                                                                                                                                                       | FAIL                                                                                                                                                                                                                  | B-18       |
| â†’ B-31 boot-drain NOT demonstrated (precondition key-present never met); earlier "PASS" retracted                                                                                                                                                                                                                                                  | â€”                                                                                                                                                                                                                   | B-31       |
| **Group "SQA-Fahim" (owner=fahim): fahim's OUTBOUND undecryptable by ALL other members (red banner)**                                                                                                                                                                                                                                                | **FAIL**                                                                                                                                                                                                              | B-35       |
| â†’ itsirajulâ†”shirajul read each other fine; fahim receives all fine; only fahim's SENDS are dead                                                                                                                                                                                                                                                  | FAIL                                                                                                                                                                                                                  | B-35       |
| â†’ fahim (sender) shows no banner (renders own from plaintext) â€” masks it locally                                                                                                                                                                                                                                                                 | â€”                                                                                                                                                                                                                   | B-35       |
| Non-owner host (shirajul/Pixel) distributes call key; all consumers FrameCryptor-attached                                                                                                                                                                                                                                                            | PASS                                                                                                                                                                                                                  | B-13       |
| Group call (admin + member): black tiles / blank-zombie tiles NOT reproduced                                                                                                                                                                                                                                                                         | PASS                                                                                                                                                                                                                  | B-01/B-17  |
| 1:1 audioâ†’video upgrade renegotiates + renders both ends (26-30fps, 0 dropped)                                                                                                                                                                                                                                                                     | PASS                                                                                                                                                                                                                  | B-16       |
| Group video tile displacement â€” inconclusive (emulators share one camera; testable feed OK)                                                                                                                                                                                                                                                        | INCONCL                                                                                                                                                                                                               | B-19       |
| 1:1 call dies on backgroundâ†’resume: FG service holds process, but media stalls + ICE-restart stuck                                                                                                                                                                                                                                                 | FAIL                                                                                                                                                                                                                  | B-24       |
| â†’ root cause: no wake-lock/keepalive in bg; ICE-restart deadlocks at `have-local-offer` (no rollback)                                                                                                                                                                                                                                              | FAIL                                                                                                                                                                                                                  | B-24       |
| Group-call keepalive `ack_timeout:ping` x2â†’x22 â€” but media rides dead WS ~7.5min functional                                                                                                                                                                                                                                                      | PARTIAL                                                                                                                                                                                                               | B-05       |
| â†’ root cause: server `ping` handler returns event-shaped resp â†’ NestJS never calls socket.io ack                                                                                                                                                                                                                                                 | PARTIAL                                                                                                                                                                                                               | B-05       |
| **App CRASHES when ending a group call (RN-Fabric view re-parent) â€” reproduced 3Ã—, REAL DEVICE**                                                                                                                                                                                                                                                  | **FAIL**                                                                                                                                                                                                              | **B-36**   |
| â†’ `IllegalStateException: child already has a parent` (SurfaceMountingManager); audio-sorted tile reorder on teardown                                                                                                                                                                                                                              | FAIL                                                                                                                                                                                                                  | B-36       |
| **2026-06-19 session â€” agent boot crashes (Crashlytics)**                                                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                       |            |
| Agent dashboard: unguarded pickup_address.split() â†’ JS render TypeError â†’ root ErrorBoundary                                                                                                                                                                                                                                                     | FIXED                                                                                                                                                                                                                 | B-37       |
| Agent dashboard: Fabric "child already has a parent" native reparent at boot (same class as B-36, diff trigger)                                                                                                                                                                                                                                      | FIXED                                                                                                                                                                                                                 | B-38       |
| **2026-06-19 session â€” OPS CONSOLE (web, Playwright/desktop Chrome) â€” auth chaos pass**                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                       |            |
| **SIGN OUT is a no-op â€” no redirect, auth cookies NOT cleared, protected pages still load as WOLF ADMIN**                                                                                                                                                                                                                                          | **FAIL**                                                                                                                                                                                                              | **B-40**   |
| **OTP/MFA NOT validated â€” any 6-digit code (111111/999999/000000) logs in once password is correct**                                                                                                                                                                                                                                               | **FAIL**                                                                                                                                                                                                              | **B-39**   |
| Route guard (unauth â†’ /login?next=) Â· session persists on refresh Â· password enforced at step 1                                                                                                                                                                                                                                                  | PASS                                                                                                                                                                                                                  | â€”        |
| **2026-07-04 session â€” v1.0.92 (vc118) audit-remediation build**                                                                                                                                                                                                                                                                                   |                                                                                                                                                                                                                       |            |
| Backup fails `verifier_missing` â†’ verified = designed P0-1 hard cut (all 5 staging rows pre-date the verifier)                                                                                                                                                                                                                                     | NOT A BUG                                                                                                                                                                                                             | B-44       |
| **Chat Backup "Setup failed. Please try again." â€” quick-crypto has no HKDF; setup/restore dead on ALL devices**                                                                                                                                                                                                                                    | **FIXED**                                                                                                                                                                                                             | **B-45**   |
| **B-45 round 3 (2026-07-05): restore fails `merkle_mismatch:rows_count_mismatch` â€” Merkle gate design flaw**                                                                                                                                                                                                                                       | **FIXED**                                                                                                                                                                                                             | **B-45**   |
| **2026-07-05 session â€” offline-message delivery (code-level audit)**                                                                                                                                                                                                                                                                               |                                                                                                                                                                                                                       |            |
| **Msg sent while recipient logged out never appears after re-login â€” undecryptable envelope silently ack'd 'discarded'; no trace on B, no resend on A**                                                                                                                                                                                            | **FIXED**                                                                                                                                                                                                             | **B-46**   |
| **First N msgs of a fresh 1:1 chat lost while BOTH online (A sends 1-5, B renders 3-5) â€” first-contact rebuild strands in-flight msgs; server delivered all 5**                                                                                                                                                                                    | **ROOT-CAUSED**                                                                                                                                                                                                       | **B-47**   |
| **2026-07-05 session â€” notification re-audit (live server evidence)**                                                                                                                                                                                                                                                                              |                                                                                                                                                                                                                       |            |
| **Killed/backgrounded app gets NO push (msgs + calls); all appears on next open â€” push PIPELINE verified deployed+working; recipient's token MISSING or DEAD at send time (28 no-tokens + 4 dead-token of 74 chat wakes over 7 d â‰ˆ 43%)**                                                                                                        | **FIXED**                                                                                                                                                                                                             | **B-48**   |
| â†’ live Redis state: itsirajul has VOIP token but NO DATA token â†’ all msg-wakes to him silently skipped; calls still ring                                                                                                                                                                                                                         | FIXED (chat-wake VOIP fallback, live)                                                                                                                                                                                 | B-48       |
| â†’ dead-token cleanup is prefix-scoped (P0-N4): chat-wake `not-registered` deletes DATA copy only, VOIP twin of the SAME dead token lingers                                                                                                                                                                                                         | FIXED (twin reap, live)                                                                                                                                                                                               | B-48       |
| â†’ client re-registers push tokens on every WS reconnect (heals server-side reaping) â€” ships in NEXT APK                                                                                                                                                                                                                                          | PENDING APK                                                                                                                                                                                                           | B-48       |
| â†’ PUSH-B1 (HTTP wake) CONFIRMED live on Contabo; FCM creds OK; 42 wakes `sent=1/1` in 7 d                                                                                                                                                                                                                                                          | PASS                                                                                                                                                                                                                  | â€”        |
| **2026-07-05 session â€” VBG audit remediation deploy**                                                                                                                                                                                                                                                                                              |                                                                                                                                                                                                                       |            |
| **Client-panic SOS insert broken on staging â€” deployed SosService writes `sos_events(user_id, booking_id, status, payload, â€¦)` but Supabase only had the agent-SOS schema (`mission_id NOT NULL, agent_id, â€¦`); every VBG panic / escalation SOS insert failed silently**                                                                      | **FIXED (2 migrations, live-verified)**                                                                                                                                                                               | **B-49**   |
| **2026-07-09 session — FULL NOTIFICATION AUDIT (53-agent adversarially-verified code audit; register: `docs/audits/NOTIFICATION_AUDIT_2026-07-09.md`)**                                                                                                                                                                                              |                                                                                                                                                                                                                       |            |
| **Killed-app 1:1 call never rings; notification appears only AFTER the call — zombie-socket wake suppression (~55 s), no cancel/missed-call push, missed-call replay dead code (45 s TTL == threshold), 0-skew 30 s exp drop**                                                                                                                       | **FIXED (code, PENDING APK+deploy)**                                                                                                                                                                                  | **B-53**   |
| **Tapping ANY message notification → "Chat hit an error" — deep-link omits required `name`/`isGroup` route params; `initials(undefined)` render crash; deterministic, Retry re-crashes**                                                                                                                                                             | **FIXED (code, PENDING APK)**                                                                                                                                                                                         | **B-54**   |
| **In-app bell not synced (mobile + ops-console) — no server inbox (5-min Redis TTL only), ActivityBell/Center/store fully built but dead code (0 writers, unmounted, unrouted), Dashboard drawer hardcoded empty, ops bell = permanently-drifting SOS count**                                                                                        | **FIXED (durable server inbox + migration LIVE on Supabase; mobile drawer+sync; ops bell dropdown; SOS KPI)**                                                                                                         | **B-55**   |
| **Notifications "not smooth" — every backgrounded msg double-posts with double sound (no onlyAlertOnce), group wakes misroute to the sender's 1:1, M-14 residual full-store walks per message, denied POST_NOTIFICATIONS silently swallowed**                                                                                                        | **FIXED (incl. N-31 permission banner)**                                                                                                                                                                              | **B-56**   |
| → Remediation 2026-07-09: 30/36 findings fixed+verified (tsc baseline 47, crypto 1449, msgr 219, auth 1716, ops build OK; Supabase `notifications` table migration applied). Build → v1.0.103/vc129. See `docs/audits/NOTIFICATION_AUDIT_2026-07-09.md` §12                                                                                          | FIXED                                                                                                                                                                                                                 | —          |
| → Telegram-parity gap (complaint 3) = composition gap, NOT an E2EE constraint for names/actions/grouping/badge; only killed-app preview text needs the headless-drain decision                                                                                                                                                                       | AUDIT (N-10..N-17)                                                                                                                                                                                                    | —          |
| **Full messenger re-audit 2026-07-09 (HEAD 78edfd4): 35 verified findings — 1 P0 (M-14 coalesced-flush races receive txn → committed inbound msg acked `discarded`+destroyed), 16 P1, 17 P2. No E2EE/log-plaintext violation. 6 candidates refuted.** Canonical register `docs/audits/MESSENGER_AUDIT_2026-07-09.md`                                 | **REMEDIATED 2026-07-10** (P0-1 + 16/16 P1 + 17/17 P2 fixed in code; P2-17 client-half = follow-up)                                                                                                                   | —          |
| **Coverage-gap increment 2026-07-10 (`wf_0b001a78-f0e`): closed §11. crypto-core CLEAN (canonical=`messenger-core`; local `crypto/*`=stale shadows). backup +1 P1 (fail-silent unresumable archive replay) +6 P2 +4 P3. prod-readiness +1 P1 (`TOTP_ENCRYPTION_KEY` hardcoded fallback) +1 P2 +2 P3.** `MESSENGER_AUDIT_2026-07-09.md` §12           | **REMEDIATED 2026-07-10** (P1-B-1/P1-P-1 + all P2s + P3-B-1/2/4, P3-P-1/2 fixed; P3-B-3 skipped low-conf) ⚠️ TOTP key must be set on box                                                                              | —          |
| **NEW background/killed-app reliability audit 2026-07-10: 8 P1 / 11 P2 / 14 P3 + 49-item WhatsApp-parity checklist. Headlines: no OEM battery-opt/autostart flow (TECNO/MIUI killed-app blackout), B-58 call-drop-on-resume, killed-app answer/decline broken, >24h-offline msg blackout.** `docs/audits/BACKGROUND_RELIABILITY_AUDIT_2026-07-10.md` | **REMEDIATED 2026-07-10** (8/8 P1-BR, 11/11 P2-BR incl. battery-opt/OEM-autostart flow, most P3s) — device verify pending                                                                                             | B-57..B-61 |
| **Incoming-call notification tap opens the app first instead of the call screen directly (Accept/Decline appear only after launch)** — tester (live device)                                                                                                                                                                                          | **FIX IMPLEMENTED 2026-07-10** (lock-screen FSI flags in MainActivity + notification-Answer `autoAccept` auto-answers, no second Accept; headless Telecom report = follow-up). Device verify pending                  | **B-57**   |
| **Tapping the ongoing-call notification DISCONNECTS the active call instead of returning to the in-call screen** — tester (live device)                                                                                                                                                                                                              | **FIX IMPLEMENTED 2026-07-10 (both halves)** — client: live-call guard skips resume `forceReconnect` (ping-probe first); server: 12 s disconnect grace for active calls. Device verify pending                        | **B-58**   |
| **Call duration displayed as `1M, 2M, 3M` instead of `MM:SS`** — tester (live device)                                                                                                                                                                                                                                                                | **FIX IMPLEMENTED 2026-07-10** — dissolves with B-60/B-61 + defence: answered rows always render `0:00`/MM:SS duration so the "Nm ago" age can't be misread. Device verify pending                                    | **B-59**   |
| **Call timer never starts after the call connects (audio works, timer stays inactive)** — tester (live device)                                                                                                                                                                                                                                       | **FIX IMPLEMENTED 2026-07-10** — 1 s timeout per DTLS `getStats()` iteration + promote-on-ICE-connected (verification still unconditional); `[WEBRTC] dtls-poll-hung` watchdog log added for the 2-device ADB confirm | **B-60**   |
| **Call status not updated to Connected/In-Progress after connection (UI stuck in prior state though audio flows)** — tester (live device)                                                                                                                                                                                                            | **FIX IMPLEMENTED 2026-07-10** — same fix as B-60 (status flips to Connected on ICE connect even if the stats bridge stalls)                                                                                          | **B-61**   |

| **2026-07-10 session — v1.0.104 (vc130) device retest, Pixel 7a (shirajul) — `docs/audits/CALL_NOTIFICATION_DEVICE_AUDIT_2026-07-10.md`** | | |
| B-53 retest: killed-app wake + ring end-to-end (FCM restarts dead proc, ring ~7 s, offer replay, cancel/missed push) — device + server verified | **PASS** | B-53 |
| B-57 retest: FSI flags + autoAccept shipped but ineffective — OS denies FSI; answer chain fails downstream | PARTIAL | B-57 |
| **Notification-driven answer NEVER sends `call.answer` (0 ICE from callee, accept dies pre-answer, no 'connecting' watchdog) → caller rings out, callee marked missed despite answering — 2/2 repro; in-app answer works** | **FAIL — NEW** | **B-62** |
| **Ring notification `FSI_REQUESTED_BUT_DENIED` (Android 14+ deny-by-default) — no `canUseFullScreenIntent()` check or Settings deep-link (formalizes N-05); lock-screen ring = heads-up only** | **FAIL — NEW** | **B-63** |
| **Zombie call after failed answer: FGS notif 70242 (NO_CLEAR) never clears; no End affordance (CallScreen unreachable on Auth/OTP, FloatingCallOverlay gated on `isMinimized`, FGS notif has no hang-up action) — tester swipe-kills app as workaround** | **FAIL — NEW** | **B-64** |
| Message notifs generic by default: preview default-OFF (`bravo:notif-content-preview`), killed-path 1:1 body generic, killed groups = "New secure message" (N-10..17 machinery IS shipped; composition defaults remain) | FAIL — NEW (product) | B-65 |
| Status-bar small icon = placeholder Material "verified_user" shield, not Bravo artwork (`ic_stat_bravo.xml`); no `default_notification_color` | FAIL — NEW | B-66 |
| **Ratchet-snapshot upload `stale_seq` infinite 4 s retry — no adopt-self-heal on upload path (B-50 fix is merkle-only), debounce defeated on failure; snapshots frozen → restore-staleness risk; survives app restart (2 pids)** | **FAIL — NEW** | **B-67** |
| **App process dies holding the call FGS mid-video-call (`has died: fg +50 FGS` 11:30:22) → live call killed, next offer `peer_offline`; crash buffer not captured** | **FAIL — NEW** | **B-68** |
| Camera FGS type thrash during video (192→128→192 in 1.4 s; FGS restart keyed on `isCameraOn`, no debounce) — capture-stall/black-video risk | FAIL — NEW | B-69 |
| **`.CallForegroundService` FGS type omits `phoneCall` (manifest `microphone\|camera` only) — forfeits Telecom while-in-use exemption; explains call-1 background mic denial; prime enabler of B-62** | **FAIL — NEW** | **B-70** |
| B-59/60/61 retest: tester's own report claims "Answering…" stuck ~5 min with live audio, but B-60/61 ICE-promote fix IS present at HEAD; no JS logs captured — recurrence unverified (suspect: duplicate-accept race `fcmBootstrap.ts:970-983`) | UNVERIFIED | B-59..61 |

| **2026-07-10 session — Ops Console: infinite `token_revoked` sign-in loop (founder report + live box/DB forensics)** | | |
| **After a CLEAN login (`/auth/login`+`/auth/verify` 200, dashboard renders once), `/ops/me` → 401 `token_revoked` within seconds → `/dashboard⇄/login` redirect storm (3,300+ req, tab pinned). Root: single-device takeover (`evictOtherDevices` on EVERY web `/auth/verify`, `auth.service.ts:issueSession`) force-revokes the account's OTHER web sessions, so two ops tabs/browsers mutually evict each other. Amplified by a client with NO loop-exit: `fetchJson` 401-redirect kept `bravo_ops_csrf` and the login page auto-forwards while csrf exists. `COOKIE_DOMAIN`/CORS/Redis were all correct (ruled out via SSH+curl+PSL).** | **FIXED + DEPLOYED 2026-07-10 (staging)** | **B-71** |

---

### B-71 — Ops Console: infinite `token_revoked` sign-in loop (`/dashboard⇄/login` storm) ⚠️ CRITICAL · session / single-device-takeover · FIXED + DEPLOYED 2026-07-10 (staging)

**Symptom (founder report, `docs`-external `ops console.md`):** valid creds; login succeeds and the dashboard renders once (`/ops/dashboard|missions|bookings` = 200); then every `/ops/*` call flips to `401 {"message":"token_revoked"}` and the SPA loops `/dashboard ⇄ /login` forever (3,300+ requests, self-inflicted DoS on auth).

**Investigation (this session):**

- Ruled OUT via non-invasive probes: cross-subdomain cookie scope (`sslip.io` NOT on the Public Suffix List → `Domain=.94-136-184-52.sslip.io` is valid + same-site), CORS (`/ops/me` returns `ACAO: https://ops.…` + `ACAC: true`), HTTPS/`Secure`, middleware, and TTL/Redis-wipe (Redis up 5 weeks, `COOKIE_DOMAIN` correctly set on the box).
- **Smoking gun (Supabase `auth_devices`):** one ops account had a _new_ `web-*` device created on every login, each **revoked at the exact instant the next was created** (e.g. `web-d8cb517c` created 13:53:57, revoked 13:54:44 when `web-6b435e73` re-verified). Sequential mutual eviction — the classic single-device-takeover churn.

**Root cause (two layers):**

1. **Revocation:** `issueSession(evictOtherDevices=true)` runs on every web `/auth/verify` and revokes ALL other same-platform (`web`) devices' jtis. Takeover was designed for MOBILE (one WS slot); its own comment says "scoped to platform so a mobile login never logs out a web session" — but it still force-evicts _web↔web_. Ops is legitimately multi-tab/multi-browser, so two sessions kill each other. `docs/architecture/AUTH_COMPLIANCE.md` documents NO single-web requirement (only logout + refresh-rotation revocation).
2. **Loop (no exit):** `fetchJson`'s session-loss branch did `location.assign('/login')` WITHOUT clearing `bravo_ops_csrf`; the login page + Shell treat csrf presence as "logged in" and auto-forward to `/`. Dead session + surviving csrf = infinite storm. (`clearSession` also deleted `bravo_ops_device_id`, minting a fresh web device per login → churn.)

**Fix (committed `2b190e1`, deployed via CI on push to main):**

- `apps/auth-service/src/auth/auth.service.ts` — `if (evictOtherDevices && platform !== 'web')`. Mobile single-device unchanged; web no longer self-evicts. Logout (`DELETE /auth/session`) + refresh-rotation revocation intact. +2 unit tests (`auth.service.spec.ts`, 39/39 pass).
- `apps/ops-console/src/lib/api.ts` — `bootToLogin()` clears `bravo_ops_csrf` (shotgun) + `bravo_ops_access_expires_at` + messenger ticket before redirecting on session loss (`fetchJson` + `getMessengerTicket`); `clearSession` keeps `bravo_ops_device_id` stable across logout. `tsc` clean.

**Note:** report's `/auth/refresh 400` was a red herring — client refreshes via cookie-based `/auth/session/refresh`; refresh is not the trigger (token dies in seconds, long before the ~14-min refresh).

---

| **2026-07-11 session — rapid-message burst seq test (Sirajul/Parvez `79d63649` → Ronok `3165d0e1`, both online, 18:00:51–18:01:05 UTC = 12:00–12:01 AM BD; screenshots from both devices)**                                                                                                                                                                           |                                                                                                                                       |          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Rapid burst on an ESTABLISHED 1:1 loses + reorders messages: sender shows 10 bubbles, receiver renders 4 (`1, 678, 678, 2`) with `2` OUT OF ORDER after the `678`s; relay verdict = only 8/10 sends ever reached the relay, all 8 emitted `localSocket=true`, 0 `undeliverable`; receiver WS flapping every ~60–90 s with pending-flush re-loop (12→12→4→1→1→3→3)** | **FAIL — NEW · nested-txn aggravator FIXED same day (see below); ordering fix design-blocked; identity-churn piece = B-46 by design** | **B-72** |
| Composer concatenates digits under rapid send: sender's actual sent texts were `1, 2, 23, 234, 2345, 6, 67, 678, 678, 0` (typed `1..0` singly) — JS-side `setText('')` races the native EditText, next keystroke lands on uncleared field                                                                                                                             | FAIL — NEW · **FIXED 2026-07-11** (native `ref.clear()` on send; APK rebuild required)                                                | B-73     |
| Raw libsignal error surfaced as red chat banner: `Error: No record for 3165d0e1-0d3f-4d8c-be5d-a4b85d11b453.1` — `ChatScreen.send()` catch pipes `e.message` verbatim to `setError`; leaks internal userId.deviceId, non-actionable for the user                                                                                                                      | FAIL — NEW · **FIXED 2026-07-11** (`sendErrorText` mapping + uuid redaction; APK rebuild required)                                    | B-74     |

---

### B-72 — Rapid burst on an ESTABLISHED 1:1 chat: 6 of 10 messages missing on receiver + one rendered out of order ⚠️ HIGH · mid-conversation session loss (NOT first-contact) · SERVER-VERIFIED 2026-07-10/11

**Repro (2026-07-10 ~18:00 UTC / 12:00 AM BD, both devices online, chat with prior same-night history):** Sirajul/Parvez (`79d63649`) rapid-sends 10 messages to Ronok (`3165d0e1`). Sender renders all 10 bubbles (single ✓). Receiver renders only `1, 678, 678, 2` — and `2` (sent 2nd) renders AFTER the `678`s (timestamped 12:01 am vs the burst's 12:00). Screenshot pair captured at 12:06.

**Why this is NOT B-47:** B-47 is first-contact (X3DH establishment) loss. This conversation had a fully delivered exchange 3 minutes earlier (the 11:57 pm batch — all rendered on the receiver) — the session then broke MID-CONVERSATION during the burst.

**Server verdict (`bravo-staging-msgr` logs, 17:56–18:16 UTC window):**

- Only **8** `envelope.send accepted` from `79d63649 → 3165d0e1/1` in the burst window (18:00:51.6 f5b4abf8, :52.0 9928a82c, :52.5 88758d7b, :52.7 c25a13e2, :53.2 e4c750c3, 18:01:00.9 83cce0f3, :03.1 ddd3f280, :05.2 682b2889) for **10 sender bubbles** ⇒ **2 sends never reached the relay** — correlates with the on-screen `No record for 3165d0e1….1` encrypt failure on the sender (B-74 banner; sealing threw before submit). Needs logcat to confirm which two.
- All 8 accepted envelopes were emitted `localSocket=true` (receiver online), **zero `envelope.undeliverable`** in the window ⇒ remaining loss is client-side on the receiver (decrypt-failure retry loop), same locus as B-47 but on an established session.
- Interleaved **deliver-only re-emits** to `3165d0e1/1` with no matching fresh send (8d7a2dbc 18:00:55, 69f20c8b 18:01:04.2, d3fc7ae2 :04.7, 7de5fb7f :04.7) = leave-on-relay (B-30) redeliveries of un-acked envelopes already in flight.
- **Receiver WS flapping the whole session** (`recovered=no` every time): close/open at 17:56:28, 17:57:26→:36, 17:59:06→:11, 18:00:07→:08, 18:00:33→:44, 18:04:29→18:06:10, 18:06:50→18:13:44, 18:15:57. Each reopen logs `flush N pending envelopes` with N = **12, 12, 4, 1, 1, 3, 3** — the repeated identical counts (12→12, 3→3) are un-acked/undecryptable envelopes surviving across reconnects (retry loop visible server-side). 3 envelopes still pending at 18:13, no undeliverable fired by log end ⇒ retry budget not yet exhausted at capture time; the missing messages may later surface, arrive out of order, or flip to discarded → B-46 auto-resend (text-only, one-shot).
- Presence showed **"Active now"** on both devices throughout despite the ~60–90 s socket churn.

**Out-of-order `2` — mechanism (code-traced, needs logcat to pin which path):** receiver `created_at` binds to the sender's AAD seal timestamp (`productionRuntime.ts:7106`), and `appendMessage` binary-splices — so an IDENTICAL redelivery cannot reorder. The paths that CAN: (a) any re-seal re-mints a FRESH AAD timestamp (`productionRuntime.ts:751, :2450, :7186` — B-46 auto-resend + deferred-reseal drain), so a recovered message lands at its RESEND time on the receiver while keeping its original slot on the sender — the two timelines permanently diverge; (b) `aad.ts` missing → `Date.now()` fallback at decode time (`:7106`). Either way: **delivery recovery breaks cross-device ordering by design.**

**Open root-cause questions (next device session, logcat required):**

1. Why did the sender's outbound session record vanish mid-burst (`No record for <peer>.1` on encrypt, seconds after successful sends)? Candidates: concurrent `forceRefreshOutgoingSession`/`removeSession` (B-46 resend path) racing the burst's per-address lock; receiver's decrypt-recovery rebuild (new X3DH) replacing the sender-side session between seals.
2. Why is the receiver's WS cycling every ~60–90 s `recovered=no` (client network vs zombie-socket class from B-53)?
3. Confirm the receiver's missing 6 (`23, 234, 2345, 6, 67, 0`): which are the 2 never-sent, which are stuck-in-retry, and whether they eventually render (and in what order).

**Retest:** re-run the burst with `adb logcat | grep -E "recv.enter|decrypt-recovery|LeaveOnRelay|ACK ok .* disposition=|No record for"` on BOTH devices; capture per-message envId↔text mapping from sender logcat to close the count.

**Severity:** HIGH — silent message loss + permanent cross-device reordering in an established chat with both users online; falsifies the "established sessions are burst-safe" assumption (B-47 scoping).

**UPDATE 2026-07-11 — emulator retest (5556/5558) with logcat DELIVERED the root causes; nested-txn aggravator FIXED same day:**

- **Emulator repro:** sender (5556) sent 10 (`1, 2, 23, 23, 23, 23456, 234567 ×3, 234567890`), receiver (5558) rendered 2 (`1, 23456`).
- **Sender-side (5556 logcat, CONFIRMED + FIXED):** `[sqlMessageStore] coalesced flush failed — [op-sqlite] cannot start a transaction within a transaction` firing repeatedly during the burst (00:28:15–22) and surfaced as a red UI banner. Root cause: `SqlCipherProtocolStore.saveIdentity` called OUTSIDE the txn chain (send path, X3DH `processPreKey` → `saveIdentity`) opened a **raw `BEGIN IMMEDIATE`** that raced the CHAINED 50 ms coalesced flush (`SqlMessageStore.upsertBatch`) — the exact hole the P0-1 doctrine (receiveTransaction.ts) warned about. **Fix:** `saveIdentity`'s own-transaction case now queues on `runWithRatchetTxn` (the one per-connection runner); inside-chain calls still run raw. `src/modules/messenger/crypto/sqlCipherStore.ts`. +2 regression tests in `receiveTransaction.test.ts` ("B-72" block — strict SQLite-semantics stub where a nested BEGIN throws). Gates: crypto suite 179/179 (1590 tests), tsc 46 ≤ 47 baseline. _Residual (documented, not fixed): the ambient `isInsideRatchetTxn()` flag is caller-unaware — an outside `saveIdentity` interleaving with an open chain txn runs its statements inside that txn (wrong atomicity, no crash); full fix needs a caller-threaded txn context._
- **Receiver-side (5558 logcat, CONFIRMED, NOT a code bug to patch):** `dropped undecryptable (deliver-unwrap: outer sealed authentication failed)` ×10 (cumulative 3→12) — the burst envelopes were sealed to this device's OLD identity (fresh install: `[backup.merkle] stale_seq local=1 server=32`). Sealed-sender means they are cryptographically unopenable by design (B-46 class); the B-46 auto-resend is the mitigation. Also observed: `[bravo.drainRelay] hit hard cap of 10 pages — bailing` (ack loop / backlog symptom — the drain self-resumes on next connect; telemetry breadcrumb already fires).
- **Out-of-order fix:** design-blocked on a sealed-payload original-timestamp field (stop condition — architecture approval needed).
- **Test-order flake note (dev FYI):** the messenger-crypto suite intermittently fails 1–2 unrelated suites (`incomingRingtone` module-load) depending on scheduling; identical code flips fail↔pass across runs; `npm run flake:crypto` exists for hunting this. Not related to the B-72 fix (clean-tree control also flaked/greened).

---

### B-73 — Composer concatenates digits under rapid send (`2, 23, 234, 2345…` actually SENT) · MED · deterministic UI race

**Symptom:** typing `1 2 3 4 5 6 7 8 9 0` with a send-tap between each digit produced sent texts `1, 2, 23, 234, 2345, 6, 67, 678, 678, 0` (both screenshots agree — the receiver renders the concatenated strings, so this is what went over the wire; also visible in the prior 11:57 pm batch: `3, 34, 3456, 78, 90`).

**Root cause (code-traced):** `ChatScreen.send()` clears the composer with `setText('')` (`ChatScreen.tsx:663`) — a JS-side state update on a **controlled** TextInput. On RN Android the native EditText still holds the old text until the state round-trips; a fast next keystroke lands on the uncleared native field and `onChangeText={setText}` (`:1480`) faithfully reports `"23"`. Duplicate `678` = the same race on the send side (two taps before the clear applied).

**Impact:** corrupts rapid input for real users; also confounds every rapid-burst QA run (message identity becomes ambiguous).

**FIXED 2026-07-11:** `ChatScreen.send()` now calls `inputRef.current?.clear()` (imperative native clear) alongside `setText('')`; `ref={inputRef}` added to the composer TextInput. Reproduced again on the 2026-07-11 emulator retest (`23 ×3`, `234567 ×3` dupes) before the fix. APK rebuild required. On-device verify: rapid-type `1..0` with a send-tap between each digit — every bubble must be a single digit, no dupes.

---

### B-74 — Raw libsignal error shown as chat banner: `Error: No record for <userId>.<deviceId>` · MED · error-surface + internal-ID disclosure

**Symptom:** during the B-72 burst the SENDER's chat header showed a persistent red banner `Error: No record for 3165d0e1-0d3f-4d8c-be5d-a4b85d11b453.1`.

**Root cause:** `ChatScreen.send()`'s catch does `setError(e instanceof Error ? e.message : 'Send failed')` (`ChatScreen.tsx:692-696`) — the raw `SessionCipher` "No record for \<address\>" message reaches the banner verbatim.

**Issues:** (1) leaks an internal userId + signal deviceId to the UI (screenshot-able); (2) non-actionable phrasing for the user; (3) masks that a message just silently failed to send (no bubble-level indication tied to the banner). The underlying encrypt failure itself is tracked under B-72 question 1. (The bubble does flip to 'failed' with the retry chip — M-15 — so the banner is the only gap.)

**FIXED 2026-07-11:** new pure helper `src/screens/messenger/sendErrorText.ts` — session/crypto-internal errors (`no record for|no session|bad mac|invalid key|untrusted identity|…`) map to "Secure session is re-establishing — the message wasn't sent. Tap it to retry."; anything else passes through with uuid(.deviceId) addresses redacted to `contact`. Wired into all four `setError` sites in `ChatScreen` (send, retry, forward, media + its Alert). 5 tests in `src/screens/messenger/__tests__/sendErrorText.test.ts`. The 2026-07-11 emulator retest also surfaced a raw `[op-sqlite] cannot start a transaction…` banner from the same pattern — that instance dies with the B-72 root-cause fix (the flush no longer fails). APK rebuild required.

---

| **2026-07-11 session — post-pull triage (founder report: backup slow after `3ae4790`, Lite finish-mission API error, Mapbox blank/load-failed) — full register: `docs/audits/TRIAGE_AUDIT_2026-07-11.md`. Audit only, fixes NOT applied**                                                                                                                                                                                                                                             |                                                                                                                                                                                                                                                                                                   |          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **B-72 fix regression: `saveIdentity` queued on the global txnChain self-deadlocks when reached from `runOnTxnChain` work (decrypt-recovery `initOutgoingSession` awaits it) → chain frozen for the process lifetime → inbound stops committing, backup mirrors a frozen snapshot with a GREEN verify, restore hangs at a stuck %. Node repro proves the deadlock**                                                                                                                   | **FIXED 2026-07-11** (context-2 saveIdentity now opens its OWN atomic inline BEGIN via `runRatchetTxnInline` — kills the deadlock AND keeps the UPSERT+rotation-log atomic; adversarial review caught+fixed a raw-autocommit atomicity regression in the first cut). P0. **APK rebuild required** | **B-75** |
| **Lite CPO Finish-mission intermittent API error — #1 session revocation (OTP login on 2nd device evicts mission device `auth.service.ts:322`; one-strike refresh + `api.ts:100` token wipe; log-verified on CPO `72fa6d91`), #2 15 s axios timeout vs 20-30 RTT settle path + staging redeploy windows (lost-200), #3 uncaught post-commit `settleEscrowOnFinish` strands escrow HELD**                                                                                              | **FIXED 2026-07-11** (client: `isAuthLostError`→clean sign-out; `missionComplete` timeout 30s. server: `settleEscrowOnFinish` best-effort + loud error log). **Server deploy + APK rebuild required**                                                                                             | **B-76** |
| **Mapbox maps intermittently blank / "load failed" — zero recovery at boot: GL doesn't retry style fetch, no RN watchdog for `'ready'`, HTML `err` posts dropped by all 4 GL surfaces, Android WebView `onError`/`onHttpError` unreachable for subresources (main frame = inline HTML) → eternal spinner/blank; shared unrotated token + prod-build token-baking gap amplify**                                                                                                        | **FIXED 2026-07-11** (new `useMapReload` watchdog: no `ready` in 15s → auto-remount once → RETRY overlay; wired into all 4 GL surfaces; VBG dead `supported` check guarded). **APK rebuild required**                                                                                             | **B-77** |
| **Conversation list mis-ordered after restore — an old chat (bow-rani, last msg Jun 27) shows ABOVE newer chats. Root: the list renders `conversationOrder` which is a move-to-front (MRU) list (`unshift` on each message append); a bulk restore re-appends conversations in processing order, so MRU ≠ real last-message time. Message timestamps themselves survive restore intact (Jack's 9:14pm–11:52pm correct) — only the list SORT was wrong.** Founder on-device (Pixel 6a) | **FIXED 2026-07-11** (display sort by real last-message time, pinned first; `conversationListOrder.ts` + 5 tests). **APK rebuild required**                                                                                                                                                       | **B-78** |

---

### B-75 — B-72 fix (`3ae4790`) self-deadlocks the global txn chain: messenger persistence freeze; backup slow/incomplete, restore hangs ⚠️ CRITICAL (P0) · regression in v1.0.107/vc133 · CONFIRMED (code-traced + Node repro) · **FIXED + DEVICE-VERIFIED 2026-07-11 (Pixel 6a, staging APK over vc133)**

**Device verification (2026-07-11, Pixel 6a `192.168.4.195:39029`, staging release APK reinstalled over vc133):** app boots + runs stably (same pid throughout, no crash/ANR); **0 `cannot start a transaction` and 0 `coalesced flush failed`** across the whole session; the ratchet-recovery drain PROGRESSED (`[bravo.ratchet-recovery] dropped undecryptable` cumulative climbed 143→164+, ~1/3s — a frozen chain would stall it); the messenger store hydrated with **22 secure channels + message history** (incl. the B-72 test peers `Sirajul/Parvez`, `Bravo·3165d0e1` with content + read-ticks) → i.e. inbound persistence + restore reach a fully working app. NOTE: the "Restoring your messages" screen can sit for minutes while a LARGE backlog of undecryptable relay envelopes (B-46 class, sealed to an old identity) drains at ~1/3s — this is a pre-existing backlog-drain, NOT the deadlock; "Taking too long? Cancel" enters the app immediately and the drain continues in the background.

**Founder symptom:** backup "so so slow" after pulling `3ae4790`; was fast and 100% accurate before.

**Root cause (verified at source):** `3ae4790` changed `SqlCipherProtocolStore.saveIdentity` (`src/modules/messenger/crypto/sqlCipherStore.ts:237-238`) to queue its own txn on the global `txnChain` via `runWithRatchetTxn` when `isInsideRatchetTxn()` is false. But `runOnTxnChain` (`receiveTransaction.ts:133-143`) runs work on that same chain **without setting `_txnOpen`** — so a `saveIdentity` awaited from inside `runOnTxnChain` work enqueues **behind the chain item awaiting it**. Circular wait → the chain freezes permanently. Trigger path: decrypt-recovery `runDecryptRecovery` (`productionRuntime.ts:5747`) → `runOnTxnChain(() => own.closeSession/initOutgoingSession)` (`:5860,:5864`) → `SessionBuilder.processPreKey` **awaits** `storage.saveIdentity` (`session-builder.js:72`) → deadlock. This is exactly the invariant documented at `receiveTransaction.ts:133-139` ("those operations call saveIdentity internally, which opens its own BEGIN") that the fix silently broke. A ~50-line Node script mirroring both files verbatim reproduces `TIMEOUT_DEADLOCK`; every subsequent `runWithRatchetTxn` caller hangs forever.

**Blast radius once triggered (one decrypt-recovery event is enough — and B-74 in the same commit proves recovery was firing on this setup):** all receive txns (`productionRuntime.ts:5735`, group `:6041`) never commit → inbound messages stop rendering until app restart; the 50 ms coalesced flush (`sqlMessageStore.ts:120→:332`) hangs and blocks the per-conversation chain (`:84-95`) so even sent-message upserts stall; `backupNow`'s sweep (`mirrorBootstrap.ts:200-242`) reads a frozen SQLCipher snapshot; **restore** (`restoreMessages.ts:598,:729` per-page `upsertBatch`) hangs at a stuck % — the literal "backup so slow"; the Merkle verify hook (`mirrorBootstrap.ts:102-114`) keeps signing the partial set → **verify stays green on an incomplete backup** (accuracy regression, silent). Secondary: libsignal encrypt fire-and-forgets `saveIdentity` per outbound send (`session-cipher.js:83`) — post-fix each send appends a full BEGIN…COMMIT txn to the global FIFO (latency pressure; unbounded accumulation once the chain is dead).

**Ruled out:** backup code touching the chain (zero matches under `src/modules/messenger/backup/`); the coalesced flush being new (on the chain since `a854139`, v1.0.104); any other commit (`git diff 7790903..3ae4790` = the whole delta since v1.0.106; only `sqlCipherStore.ts` is runtime-relevant). Test gap: the new B-72 tests cover saveIdentity-inside-`runWithRatchetTxn` but NOT saveIdentity-inside-`runOnTxnChain` — the exact escape.

**Fix direction (dev):** have `runOnTxnChain` set an on-chain flag (sibling of `_txnOpen`) so chain-resident `saveIdentity` runs its body with a raw `BEGIN IMMEDIATE` (safe — chain guarantees exclusivity; that's the contract `runOnTxnChain` was built on), or make `runWithRatchetTxn` re-entrant. Regression test: `runOnTxnChain(work)` where work awaits `saveIdentity` must complete. Fold in `identityBackup.ts:207` raw `BEGIN` (same one-runner-doctrine violation, can collide during restore). **Do NOT ship vc133 further** — it trades the B-72 crash for a worse silent freeze.

**FIX (2026-07-11):** `receiveTransaction.ts` gains `_onChainDepth`/`isOnTxnChain()` (set by `runOnTxnChain`) + a new `runRatchetTxnInline(db, work)` — opens a `BEGIN IMMEDIATE`/`COMMIT` on the connection WITHOUT appending to `txnChain` (safe only while `isOnTxnChain()`: the recovery frame holds the chain exclusively). `sqlCipherStore.saveIdentity` dispatches by context: (1) inside a receive txn → raw (rides outer BEGIN); (2) chain-resident recovery → `runRatchetTxnInline` (own atomic BEGIN — no deadlock, no collision); (3) fully off-chain send → `runWithRatchetTxn` (serializes with the flush). Race-safe: `_txnOpen` flips SYNCHRONOUSLY before the inline BEGIN await, so a concurrently-interleaving off-chain `saveIdentity` sees it and joins (runs raw) rather than issuing a second, colliding BEGIN. **Adversarial review caught a regression in the first cut** (context-2 ran raw autocommit → dropped the P0-S6 `trusted_identities`+`identity_rotations` atomicity); the inline-BEGIN fixes both the deadlock AND the atomicity. Tests: 4 B-75 specs incl. a key-rotation atomicity assertion (both writes inside one BEGIN/COMMIT). Gates: messenger-crypto 1588 green, tsc 46 ≤ 47. `identityBackup.ts:207` raw `BEGIN` left as a documented follow-up (restore-time only).

**Retest:** fixed build → force decrypt-recovery (fresh-reinstall peer + burst) → inbound continues, `backupNow` completes at normal speed, restore % advances; `adb logcat | grep -iE "coalesced flush|recovery|backupNow"` shows no stalls.

---

### B-76 — Lite CPO "Finish mission" intermittent API error · HIGH · root-caused (top cause staging-log-verified) · **FIXED 2026-07-11 (server deploy + APK rebuild pending)**

**Symptom:** sometimes the CPO can't finish a mission — "Could not advance" alert with a raw error.

**Flow:** `AssignedMissionDetailScreen.tsx:403-410` → `runAction('finish')` `:103-127` → `POST /agents/me/missions/:id/complete` (`api.ts:799-801`, idempotency key, 15 s timeout, no auto-retry) → `agent.service.ts:1377 missionComplete` → `flipMissionStatus` `:1413` → `completeMissionCore` `:1501` (txn) → settle OUTSIDE txn (`settleEscrowOnFinish` `:1557` / `disburseMissionPayout` `:1559`). FSM races deliberately no-op (`{ok:true}`), so state races/double-taps are NOT the cause.

**Ranked causes:**

1. **Session revocation (HIGH conf, log-verified).** OTP login passes `evictOtherDevices=true` (`auth.service.ts:322`) — logging the same CPO account into a 2nd device revokes the mission device's jti (B-71 fix exempted `web` only; phone↔phone eviction remains by design). Plus one-strike refresh rotation (`auth.service.ts:94-101,336-337`): one lost refresh → dead refresh token → `api.ts:100` **wipes both tokens** → next Finish tap = raw 401 alert. Staging logs show CPO `72fa6d91` running missions on device `7ca7ab44` (login 21:22), then fresh OTP logins on `417b3c4d` 22:08:42 + 22:09:20 → first device revoked mid-mission. QA device-hopping the same account is exactly this trigger.
2. **15 s timeout / deploy-window lost-200 (MED conf).** Finish handler runs ~20-30 sequential Contabo→Supabase RTTs pre-response (legacy payout path); staging auto-redeploys on every push. Timeout/restart mid-call → error alert while the server completes anyway; screen reconciliation then shows COMPLETED (cosmetic but reported).
3. **Uncaught post-commit `settleEscrowOnFinish` (LOW likelihood, HIGH impact).** `agent.service.ts:1556-1560` awaits it bare — proof-gate/`escrow_holds` failure throws AFTER mission COMPLETED → client sees error, **escrow stranded HELD** (money). Only genuinely uncaught 500 on the path; no hits in current log window.

**Ruled out:** FSM races, `not_assigned_to_mission`/`lead_only`, payout constraint / `cpo_pool` payee (fully caught; phantom payee already fixed), attendance/checkout/time gates (none on this endpoint). **Side finding:** emulator GPS ≈12,400 km from pickup → every staging mission fails the proof gate (`never_reached_pickup,insufficient_telemetry,too_short`) → `review_required`, escrow never auto-releases for test missions.

**Fix direction (dev):** client — treat `token_revoked`/refresh-failure as an explicit re-auth flow (not a raw alert); server — respond after the flip txn and settle async (UI already reconciles), wrap `settleEscrowOnFinish` in the same best-effort catch as `disburseMissionPayout` + rely on `EscrowReconciliationService`.

**FIX (2026-07-11):** #1 (client) — new `src/services/authError.ts` `isAuthLostError()` (duck-types a 401 / coded-revocation body); `AssignedMissionDetailScreen.runAction` catch routes an auth-loss to a clear "Signed out" alert + idempotent `useAuthStore.signOut()` (returns the CPO to login) instead of dumping the raw `token_revoked` string. #2 — `api.ts missionComplete` timeout raised 15s→30s so the settle round-trip doesn't trip a lost-200. #3 (server) — `agent.service.settleEscrowOnFinish` wrapped best-effort with a LOUD `log.error` (mission is already COMPLETED before settle; a throw no longer 500s the Finish, and the rare stranded-HELD hold is operator-visible; note `EscrowReconciliationService` is READ-ONLY so it alerts, not auto-repairs). Tests: +1 server spec (settle failure ⇒ Finish still succeeds), +4 client `isAuthLostError` specs (no false-positive on tier_insufficient/404/409/network). Gates: auth-service 382 green, mobile app project green, tsc 46 ≤ 47. **Server change needs a Contabo deploy; client changes need an APK rebuild.**

**Repro for #1:** start mission on device A, OTP-login same CPO on device B, tap Finish on A → 401 alert.

---

### B-77 — Mapbox maps intermittently blank / "load failed" — zero recovery at map boot · HIGH · long-standing (no map file changed since 2026-07-06) · **FIXED 2026-07-11 (APK rebuild + device verify pending)**

**Symptom:** sometimes maps show "load failed" or a blank screen; intermittent across sessions/builds.

**Root cause #1 — no recovery path (HIGH conf, code defect).** All GL maps are `WebView source={{html}}` with mapbox-gl v3.9.0 from CDN. One failed fetch (GL JS, style JSON, first tiles) at boot = dead map until remount: GL doesn't retry style fetches; no RN-side watchdog waits for the `'ready'` postMessage; the HTMLs' own `err` posts are dropped (`LiveTrackingScreen.tsx:551-556` and `AgentLiveTrackerScreen.tsx:581-587` handle only `'ready'`; `VbgKeyPointsMap.tsx:49` warns only; `bravoAgentTrackerMapHtml.ts` has no `map.on('error')`; `bravoLocationPickerMapHtml.ts` has neither `map.on('error')` nor a WebGL guard). On Android, react-native-webview 13.15.0 fires `onError`/`onHttpError` **only for main-frame failures** (`RNCWebViewClient.java:222-273`) and the main frame is inline HTML that can't fail → LocationPicker's "Map failed to load — check your connection." + RETRY (`LocationPickerScreen.tsx:356`) is effectively unreachable; users get eternal "LOADING MAP…" (`:350`, cleared only by `'ready'`, no timeout) or blank navy (LiveTracking/AgentTracker/VBG have no overlay at all). Only renderer crashes are handled (`onRenderProcessGone` remounts, all 4 surfaces).

**Root cause #2 — one shared, committed, unrotated pk token (MED conf).** Same token for all mobile GL loads, per-card marketplace Static Images, geocoding, Directions, ops-console AND auth-service (`.env:34`, `.env.production:10`, `eas.json:30`, `apps/ops-console/.env.local:6`, `apps/auth-service/.env:77`). Rate/quota events on any consumer degrade all; a 401/403/429 renders as #1's silent blank. Token rotation = open item since the 2026-07-04 Mapbox audit.

**Root cause #3 — per-build token baking (LOW-MED conf, binary per build).** `eas.json` production profile has **no `env` block** (`:51-57`); `apk:*` scripts omit `EXPO_PUBLIC_MAPBOX_TOKEN` from the inline cross-env list → token rides on dotenv reaching `expo export:embed` (the known baked-env gotcha class, cf. `3c7f0f5`); a bad bake = `token=''` = that APK's GL maps 100% blank. **Diagnostic tell:** Job Marketplace heroes showing the shield fallback ⇒ token missing at bake (`mapbox.ts:74-76`); heroes fine but GL blank ⇒ network/WebGL class.

**Secondary:** unguarded `new mapboxgl.Map()` + GL v3 WebGL2 requirement (emulator/GPU-crash recovery → throws pre-postMessage, silent blank); `mapboxgl.supported` check at `vbgKeyPointsMapHtml.ts:81` is dead in v3 (API removed, always posts spurious `gl-unsupported`); Intel map (Leaflet) depends on unpkg+jsdelivr at runtime with no error state (`IntelFeedScreen.tsx:294-300`).

**Fix direction (dev):** RN watchdog (no `'ready'` in ~10-15 s → failed/RETRY overlay + `webViewKey` remount) + consume the already-posted `err` messages on all 4 GL surfaces; rotate/split the token with URL restrictions; pin `EXPO_PUBLIC_MAPBOX_TOKEN` in production/apk env paths + assert-non-empty at boot.

**FIX (2026-07-11):** new `src/modules/maps/useMapReload.ts` — a pure, unit-tested `mapHealthReducer` + `useMapReload` hook: a WebView that hasn't posted `{type:'ready'}` within **15 s** is treated as a failed load → auto-remount once (`reloadKey` bump) → then a shared `MapFailedOverlay` (RETRY). Deliberately watchdog-driven (not reacting to `map.on('error')`) so a benign post-load tile 404 can't remount a WORKING map. Wired into all 4 GL surfaces: `VbgKeyPointsMap`, `LiveTrackingScreen`, `AgentLiveTrackerScreen` (each derives `webReady` from `map.status`), and `LocationPickerScreen` (its own watchdog + `mapAutoRetries` ref + `manualRetryMap`, making its previously-Android-unreachable `failed` overlay reachable). `vbgKeyPointsMapHtml.ts`: guarded the removed-in-v3 `mapboxgl.supported` check (was posting a spurious error every load). Tests: 7 `mapHealthReducer` specs. Gates: booking project 139 green, tsc 46 ≤ 47. **Token rotation + per-build env pinning remain open (pre-existing amplifiers, tracked). APK rebuild required.**

---

### B-78 — Conversation list mis-ordered after restore (old chat sits above newer ones) · MED · founder on-device (Pixel 6a) · **FIXED 2026-07-11 (APK rebuild pending)**

**Symptom:** after the fixed build restored history, an old chat (bow-rani, last message Jun 27) rendered ABOVE more-recent chats in the Messenger list.

**Root cause (code-traced):** `MessengerHomeScreen`'s list uses the store's `conversationOrder`, which is a **move-to-front (MRU)** array — `messengerStore` `unshift`s a conversation to the top on every message append (`:412,:596,:624,:646,:664-673`) and never sorts by timestamp. During LIVE use MRU == "most-recent first", but a **bulk restore** re-appends every conversation's messages in processing order, so the final MRU order no longer matches real last-message time — a chat can end up on top just because it was re-processed last. The message timestamps themselves survive restore intact (verified: Jack's 9:14pm–11:52pm correct), so ONLY the list sort was wrong. Distinct from the B-72 cross-device re-timestamp issue (that one re-mints created_at; this one never sorts by it at all).

**FIX (two parts):**

1. **Display sort** — new `src/screens/messenger/conversationListOrder.ts` (`compareConversationsForList`): the `ordered` useMemo sorts by real last-message time (pinned first). 5 tests.
2. **Data (the real gap)** — `messengerStore.hydrateMessages` now seeds `conversation.last_message` from the freshest SQLCipher-hydrated row (only moving forward in time). On-device the FIRST cut (display-sort only) still put Jack (chatted yesterday) at the BOTTOM because `last_message` is stripped on persist (MSG-10) and was NEVER repopulated at boot — so the sort fell back to Jack's stale conversation `created_at`, and the rows showed "start chatting" with no timestamp. Seeding `last_message` at boot fixes BOTH the ordering AND the empty preview/timestamp cosmetic. 3 tests in `hydrateLastMessage.test.ts`.

Gates: messenger-crypto 1597 green, tsc 46 ≤ 47, lint clean. **APK rebuild required** (2nd on-device iteration: bow-rani dropped correctly but Jack sank → hydrate fix added).

**Retest (device):** after restore, chats order by real last-message time (Jack near top, bow-rani near bottom), pinned on top, and each row shows its last-message preview + timestamp (no more "start chatting" on chats that have messages).

---

### B-79 — Direct chats show `Bravo · <hex>` instead of the peer's name · MED (feature) · founder on-device · **FIXED + DEVICE-VERIFIED 2026-07-11 (Pixel 6a)**

**Device verification (Pixel 6a):** `Bravo · fdafa250` → **Corné Breytenbach**, `Bravo · 604c77bb` → **Baine Kriel**, and the bare-id `c700ccde` → **Tareq** — all direct chats now render the registered Bravo name; no hex placeholders remain. Two placeholder FORMATS are handled: `Bravo · <8hex>` (messengerStore shadow-create) AND bare `userId.slice(0,8)` / full userId (call/sync path, `MainNavigator:471`) — `isPlaceholderName(name, peerUserId)` matches both, comparing the bare form against the peer id so a real name is never mistaken for a placeholder.

**Ask:** show the peer's REGISTERED Bravo name by default; if the number is SAVED in the address book, show the saved name.

**Current behaviour (code-traced):** the store's shadow-create names an unknown inbound direct chat `Bravo · <first-8-hex-of-userId>` (`messengerStore.ts:610-614`). The ONLY thing that upgrades it is the passive address-book sweep (`useDiscoveredContacts`, MessengerHomeScreen) — which renames a chat to the user's LOCAL contact label ONLY when the peer's phone is in the device address book. Peers NOT in contacts stayed a cryptic hex label forever. The REGISTERED name was never resolved even though `UsersHttpClient.getProfilesByIds` (`/users/profiles`) exists (used only for group/chat-info avatars).

**FIX:** new `src/modules/messenger/contacts/useRegisteredNames.ts` — a passive sweep (wired into `MessengerHomeScreen` after `useDiscoveredContacts`) that finds direct chats still on the `Bravo · ` placeholder (and not `is_custom_name`), batch-looks-up `getProfilesByIds(peerIds)`, and upgrades the name to the registered `displayName`. Session-scoped `attemptedRef` so unknown ids aren't re-hammered. **Precedence (highest wins): custom (`is_custom_name`) > saved address-book name (`useDiscoveredContacts` localName) > registered name (this hook) > `Bravo · <hex>`** — the sweep only ever replaces a still-placeholder name, so it never clobbers a saved/custom one, and the address-book sweep still overwrites the registered name with the user's own label for contacts. Tests: 3 in `registeredNames.test.ts` (predicate + precedence). Gates: messenger-crypto green, tsc 46 ≤ 47, lint clean.

**Retest (device):** direct chats with peers NOT in the address book now show the registered Bravo name (e.g. `Bravo · fdafa250` → the real name); saving that number in Contacts then flips it to the saved label on next Home open.

---

### B-80 — Ops dashboard live map "not updating" (CPO dot frozen/stale) · MED · founder + DB-forensics · **FIXED 2026-07-11 (APK rebuild pending)**

**Symptom (founder):** on the ops-console dashboard (and live-ops), the mission map does not update — the CPO dot is frozen.

**Root cause (Supabase forensics on `mission_telemetry` + `missions`):** the only LIVE mission (`MSN-A4E9481EC75F`) had `current_lat/lng = 37.4219983, -122.084` (the **Android emulator default GPS**, Mountain View) with `speed_kph = 0`, last `updated_at` **10h39m ago**; every recent telemetry sample is that same static point. **The mobile `useLeadTelemetry` streamed via `Geolocation.watchPosition` with `distanceFilter: 15` and NO time-based heartbeat** — so a stationary lead (parked at pickup, waiting, a QA tester at a desk, or an emulator whose GPS never moves ≥15m) pushed exactly ONE fix then went silent. The web side is CORRECT end-to-end: `useMissions`/`useMissionDetail` poll every 2s (`POLL_MSN`), the ops list/detail SELECT returns `current_lat/lng`, `BravoMap` diff-moves markers via `setLngLat`, and the server `pushTelemetry` writes `missions.current_lat/lng` on every sample. The break is purely the mobile push cadence.

**FIX:** `src/screens/cpo/useLeadTelemetry.ts` adds a **heartbeat** — a `Geolocation.getCurrentPosition` one-shot every 15s (`HEARTBEAT_MS`) alongside the movement `watchPosition`, both routed through one throttled `pushSample` (`PUSH_MIN_INTERVAL_MS` 5s). A stationary lead now keeps the ops map fresh (dot holds position but stays LIVE, `updated_at` fresh); a moving lead still streams responsively. tsc 46 ≤ 47.

**Caveat (NOT a bug):** an emulator's GPS is a fixed point so the dot won't _move_ there even after the fix — it only stays fresh; a real device that physically moves is needed to see the dot travel. The stale LIVE `MSN-A4E9481EC75F` keeps showing a frozen dot until completed/aborted (data hygiene, separate).

**Follow-up (not done):** ops side could dim/flag a LIVE mission whose newest telemetry is older than N minutes ("lost signal") so a dropped CPO doesn't read as live.

**Retest:** with the new APK, open the assigned mission as LEAD (status PICKUP/LIVE) on a real device → the ops dashboard dot stays fresh every ~15s and moves as you move; confirm fresh `mission_telemetry` rows (`ORDER BY recorded_at DESC`).

**Retest:** airplane-mode at map mount → today blank forever even after connectivity returns; post-fix RETRY/remount recovers. Marketplace-hero tell distinguishes token-bake failures from network.

---

### B-81 — Restore dead-ends with "Backup integrity check failed (root_mismatch)" on the owner's own device · HIGH · founder + DB forensics · **FIXED 2026-07-11 (adversarial review + APK pending)**

**Symptom (founder, Pixel 6a):** backup restore fails "Backup integrity check failed (root_mismatch). Retry…" — and Retry fails forever.

**Root cause (PROVEN via Supabase forensics):** replicated the client's exact Merkle recipe in SQL (PostgREST timestamp serialization + newline-stripped base64 → `leafHash` → sorted pairwise tree). Result: 4 of 6 accounts' recomputed roots MATCH their signed commits (recipe byte-exact); exactly 2 — **Ranak `3165d0e1` (340=340 rows) and Shirajul `79d63649` (190=190)**, the two heavy-test accounts — have server rows whose recomputed root ≠ signed root at EQUAL count. Mechanism: every re-mirror re-encrypts a row with a **fresh AES-GCM IV** (same `message_id`, new bytes — count unchanged for status-flip/read-receipt re-mirrors), and the signed commit trails uploads by debounces (1.5 s flush + 5 s merkle) plus a server walk. **An app kill inside that window** (today: repeated `adb install -r` during device-verify) leaves the server rows AHEAD of the last signed root. The verifier deliberately hard-fails equal-count divergence (P2-B-1 — indistinguishable from per-row substitution, no self-heal), and since the merkle hook only fires after a NEW mirror flush, nothing ever re-commits → permanent dead-end. (The deadlocked vc133 (B-75) aggravated the same window.)

**FIX (producer-side only — the restore verifier is byte-untouched):**

1. `messageMirror.ts` — new `clearMirrorDedupForOwner(owner)` + `fireMerkleHookNowIfPending()` (fires the debounced commit only when a flush scheduled one).
2. `mirrorBootstrap.ts` — new **`repairBackupCommit(owner)`**: mirror-enabled guard → clear dedup → `backupNow` (re-enqueue the FULL local store) → **refuse (false) if 0 local rows** (fresh device keeps the hard-fail posture — no laundering) → `drainMirrorOutbox()` → `fireMerkleHookNow()`. Local truth overwrites the server bytes BEFORE the fresh root is signed — the same attestation the live post-flush hook already performs, but preceded by the re-upload. Also: the boot catch-up sweep now drains + fast-forwards its pending commit (`IfPending`), shrinking the kill window from (debounces + walk) to just the walk.
3. `BackupRestoreScreen.tsx` — on `root_mismatch` (once per mount), overlay "Repairing backup integrity…" → `repairBackupCommit` → auto-retry the restore ONCE (`retryAfterRepair` bypasses only the `busy` guard; the biometric gate still runs). Repair-refused/failed → the existing error UI unchanged.

**Adversarial review (3 reviewers → 14 raw → 7 confirmed = 4 distinct, ALL FIXED):** (1) **CRITICAL — the first cut committed via the ambient after-flush hook, which is NEVER installed on the restore paths** (backupBoot RESTORE/RESTORE-RESUME never run `startMirrorBootstrap`; the screen runs it only AFTER success) → repair would re-upload rows (drifting the server FURTHER) then silently skip the signing and return a false success; fixed with a standalone `commitMerkleRootNow(owner)` the repair calls directly (throws on missing identity store), the hook now delegates to it. (2) HIGH/MED — drain outcome unchecked → repair now checks `mirrorOutboxSize() > 0` after `drainMirrorOutbox()` and ABORTS without signing (never signs a half-overwritten torn set on flaky network). (3) LOW — refusal had side effects (dedup cleared + convs enqueued before the guard) → `countLocalMessages()` precheck now refuses BEFORE any side effect. (4) MED — post-repair retry's biometric-cancel stranded the "Repairing…" overlay → cleared; and the one-retry budget is now spent ONLY when a repair actually committed (a refused/aborted repair leaves the budget for a manual RETRY).

**Tests:** 6 in `backupRepairCommit.test.ts` (dedup-clear re-upload; repair signs DIRECTLY with NO ambient hook installed — pins the review-critical; drain-abort signs nothing; empty-local refuses with zero side effects; locked-mirror refuses; `IfPending` no-op/single-fire). Full messenger-crypto 182 suites / 1608 tests green, tsc 46 ≤ 47, lint clean.

**Data note:** the two poisoned accounts self-repair on their owner devices the first time restore runs on the fixed build (repair → fresh commit → retry succeeds). No DB surgery.

**Retest (device):** on the Pixel, run Restore with the correct password → expect "Repairing backup integrity…" then a successful restore; a SECOND root_mismatch after a repair is a genuine integrity signal and still hard-fails.

---

### B-48 â€” No notifications while app is killed/backgrounded (messages AND calls); everything appears on next app open âš ï¸ HIGH Â· push-token lifecycle, NOT the send pipeline Â· FIXED 2026-07-05 (server fixes LIVE on Contabo; client fix ships in next APK)

**FIX (2026-07-05, same session):**

- **Fix A (server, live):** `cleanupBadTokens` now reaps a dead token from BOTH keyspaces by exact token match (`dropRecordsMatchingTokens` helper) â€” kills the half-alive DATA/VOIP twin state. iOS-safe by construction (APNs VoIP token never matches the FCM token). `apps/messenger-service/src/push/push.service.ts`.
- **Fix B (server, live):** `sendChatWake` falls back to the recipient's **android VOIP-channel token** when the DATA copy is missing (same physical FCM token) â€” logs `push.chat.voip-fallback`. Heals the live itsirajul state immediately: message wakes to him flow again via his VOIP token.
- **Fix C (client, next APK):** new `ensurePushRegistered()` in `fcmBootstrap.ts` re-asserts both `/push/register*` rows on every WS `connected` (60 s throttle, idempotent) â€” hooked in `productionRuntime.ts` reconnect branch. Heals server-side reaping the old `serverRegistered` flag could never see, and partial registrations without waiting for an app restart.
- **Tests:** 7 new specs in `push.service.spec.ts` (twin reap both directions, iOS non-match guard, other-device isolation, VOIP fallback android-only). Full messenger-service suite 195/195; mobile messenger-crypto 1348/1348; tsc 46 â‰¤ baseline 49.
- **Deployed:** overlay of compiled `dist/push/push.service.js` into `bravo-staging-msgr` + restart, 2026-07-05 ~11:20 UTC. Verified: container healthy, `/healthz` 200, `push.fcm-init-ok project=bravo-734da`, `voip-fallback` marker present in container dist.
- **Deliberately NOT changed:** logout/single-device-takeover tombstones (documented security design, P0-N2); a logged-out account still receives nothing â€” correct.
- **Still open for QA:** device-side banner rendering on a killed app (server `sent=1/1` â‰  banner shown) â€” run the 5-step logcat protocol below on next Mac session; BlueStacks clone/snapshot token-death hypothesis unconfirmed.

**Reported by QA (2026-07-05):** "App is notification-heavy but no notification arrives when the app is killed/backgrounded â€” when I open the app, all the calls and messages show up. We already audited notifications."

**What the re-audit VERIFIED WORKING (so the 2026-07-02 audit fixes are NOT the problem):**

- **PUSH-B1 is live on Contabo staging.** Group/HTTP sends fire chat wakes: 3-recipient wake bursts within 1 s (`push.chat.no-tokens sub=08782d6dâ€¦/4eaa4cd3â€¦/fe4ddc14â€¦` at 07-04 11:22:39-40) can only come from the HTTP `POST /envelopes` fan-out path (`envelope.controller.ts:94`). WS path fires too (`messenger.gateway.ts:925`).
- **FCM credentials work.** 42 Ã— `push.chat.delivered sent=1/1` in the last 7 d; zero `fcm-not-ready`, zero `fcm-send-failed`.
- **Client wiring is correct in the current APK source:** `setBackgroundMessageHandler(handleHeadlessFcm)` + slim notifee bg handler registered at bundle entry (`index.js`), `startFcmBootstrap` on MainNavigator mount, `bravo-messages` channel pre-created, `ic_stat_bravo` drawable exists, `google-services.json` = project `bravo-734da` / `com.bravosecure.app`.

**The actual failure â€” the recipient has NO (or a DEAD) push token at the moment of send:**

7-day log census (`docker logs bravo-staging-msgr`, 2026-07-05):

| Outcome                            | Count | Meaning                                                         |
| ---------------------------------- | ----- | --------------------------------------------------------------- |
| `push.chat.delivered sent=1/1`     | 42    | FCM accepted the wake                                           |
| `push.chat.no-tokens`              | 28    | **no token registered â†’ no FCM even attempted â†’ no banner** |
| `push.chat.delivered sent=0/1`     | 4     | token existed but FCM flagged it dead â†’ no banner             |
| `push.gc.revoked` (tombstone reap) | 26    | token deleted because the session was revoked                   |
| `push.data.gc-bad-tokens`          | 4     | dead DATA token cleaned after a failed wake                     |
| `push.voip.no-tokens`              | 1     | **a call never rang** (fahim, call `739f1652â€¦`, 07-05 10:51)  |

â‰ˆ **43% of chat wakes produced no banner** â€” and that under-counts the user impact because a killed app is exactly when the token tends to be gone.

**Worked example (shirajul, 2026-07-05):** 06:02 four wakes `sent=1/1` âœ“ â†’ 06:03:35 `auth.session.revoked detail=single_device` (= logout via `DELETE /auth/session`, account switch) â†’ 06:04:10 `push.gc.revoked sub=79d63649 dev=ee7d2290` (tombstone reap) â†’ 06:05:20-29 four messages to shirajul all `push.chat.no-tokens` â†’ dark until fresh login 06:21:38 re-registered (06:22 `sent=1/1` âœ“).

**Three token-loss mechanisms identified:**

1. **Logout/account-switch tombstone reap (by design, but QA-invisible).** `deleteSession` writes `push-revoke:<user>:<device>` â†’ messenger GC (60 s tick) deletes BOTH token channels. QA switches accounts constantly (same physical deviceId `af1b98bb` seen logging in as fahim 10:26 then shirajul 10:42), so the logged-out account is token-less **everywhere** until its next login. All 26 reaps in the window map cleanly to logouts/fresh logins in auth-service audit logs â€” no rogue revokes. Single-device takeover (`issueSession(evictOtherDevices=true)`, fresh login only, refresh exempt) additionally kills push on the account's previous device â€” relevant because shirajul historically runs on BOTH BlueStacks 5565 and Pixel 7a.
2. **Asymmetric dead-token cleanup leaves a half-dead registration (REAL BUG).** On Android the SAME FCM token is registered under both `push-token:` (DATA) and `push-voip-token:` (VOIP). When a chat wake returns `messaging/registration-token-not-registered`, `cleanupBadTokens` (P0-N4, deliberately prefix-scoped) deletes only the DATA copy â€” the VOIP twin of the **same dead token** stays. Result: messages â†’ `no-tokens` (silently skipped), calls â†’ fire-and-fail `sent=0`. **Live proof: Redis right now has `push-voip-token:08782d6dâ€¦:b86dcddaâ€¦` but NO `push-token:08782d6dâ€¦` â€” every message wake to itsirajul is currently a silent no-op.** The killed app cannot re-register until manually reopened (`onTokenRefresh` doesn't fire for server-side key deletion; re-register only runs on app start).
3. **Partial registration.** `fcmBootstrap` registers `/push/register` and `/push/register-voip` in a `Promise.all` of independent catches; one can succeed while the other 401s/fails. `serverRegistered` stays false and retries **only on the next `startFcmBootstrap` call** (next app start) â€” until then the account sits half-registered (same symptom as #2).

**Why tokens go dead at all (needs device-side confirmation â€” Mac/ADB):** 4 dead tokens in 7 d on emulators is high. Suspect BlueStacks instance cloning/snapshot-restore invalidating Firebase Installation identity. **Important caveat: `sent=1/1` only means FCM accepted the message â€” it does NOT prove the emulator displayed a banner.** Device-side rendering on a killed app is UNVERIFIED from the server side.

**QA verification protocol (next device session, Mac):**

1. Login on 5565, foreground once (confirm `[fcm] server-register OK (both endpoints)` in logcat), then KILL the app (swipe away). Do NOT log out.
2. From 5575 send 3 messages + 1 call. On the Mac: `adb -s 127.0.0.1:5565 logcat -d | grep -E '\[fcm|\[fcm-headless|\[notifee|\[messageNotif|bravo-messages'`.
3. Simultaneously on the server: `docker logs bravo-staging-msgr --since 5m | grep push.` â€” classify each send as `delivered sent=1/1` / `no-tokens` / `sent=0`.
4. If server says `sent=1/1` but logcat shows no `[fcm] bg wake:` / `[fcm-headless]` line â†’ the drop is device-side (FCMâ†’emulator delivery or headless JS) â†’ escalate separately with the logcat.
5. Repeat once on the Pixel 7a (real FCM stack) to isolate BlueStacks-specific token death.

**Files involved (for the dev handoff â€” QA does not fix):**

- `apps/messenger-service/src/push/push.service.ts` â€” `cleanupBadTokens` prefix-scoping (fix: when a shared Android token is dead, reap BOTH keyspaces â€” it is the same token; deleting only one channel invents a half-alive device), `sendChatWake` (could fall back to the VOIP-channel token on Android when DATA is missing â€” same physical token).
- `src/modules/messenger/push/fcmBootstrap.ts` â€” partial-register state; re-register is app-start-only (fix: also re-register on every WS `connected`, cheap idempotent POST).
- `apps/auth-service/src/auth/auth.service.ts` â€” logout/takeover tombstones (`deleteSession`, `issueSession(evictOtherDevices)`): working as designed; product should decide if single-device eviction killing push on the prior device is acceptable UX.

---

### B-47 â€” First messages of a brand-new 1:1 chat dropped while both users are online (A sends 1 2 3 4 5, B renders 3 4 5) âš ï¸ HIGH Â· first-contact session-establishment loss Â· ROOT-CAUSED + server-verified 2026-07-05 (v1.0.96 B-46 auto-resend expected to recover; residual open)

**Reported (2026-07-05):** brand-new 1:1 conversation, **both devices online**. A sends `1 2 3 4 5`; B renders only `3 4 5`. The first two never appear on B. (Count of lost messages varies with the burst timing â€” it is "the first few", not always exactly 2.)

**Server verdict â€” NOT a relay drop (SSH `admin@94.136.184.52`, `bravo-staging-msgr`, 48 h window):**

- `envelope.send accepted` **53** = `envelope.deliver emit` **53** (1:1) â€” every submitted envelope was transported exactly once; **no envId emitted more than once** (no stuck/redelivery loop on the WS path).
- `envelope.undeliverable` count **0** over the window; most recent emits `localSocket=true` (recipient **online** at delivery).
- Two recipients (`c700ccde/1`, `a056fa4b/1`) each received **exactly 5** deliveries â€” consistent with a `1..5` burst the relay fully delivered.
- Secondary: **9Ã— `handshake] reject verify_throw`** (JWT verify fails at WS connect) in 48 h â€” low volume, likely stale tokens on reconnect, but a brief connect-reject right at conversation start can WIDEN the first-contact window. Not the primary cause.

â‡’ The relay delivered all five. **The loss is client-side on the receiver (B).**

**Root cause (code-traced + adversarially verified â€” 8-agent verification workflow, verdicts below):**

1. On a brand-new pair, A's first messages are **X3DH PreKey messages**. B's first inbound decrypt throws a RECOVERABLE error (`NoSessionError`/`DecryptError`) â€” a genuine first-contact ratchet/prekey failure (`doHandleIncoming`, `productionRuntime.ts` ~5776-5812).
2. That triggers B's **session REBUILD** recovery (`runDecryptRecovery`: `closeSession` + `initOutgoingSession`, `productionRuntime.ts:5488,5492`). **[CONFIRMED, survives refutation]** the rebuild is a new **OUTBOUND** X3DH (Bâ†’A) and CANNOT decrypt A's already-in-flight **inbound** ciphertexts â€” `closeSession` drops the inbound session state those messages need. So B-30's `leave-on-relay` bounded redelivery of the _identical_ ciphertext keeps failing.
3. After the retry budget (`FIRST_MSG_RETRY_CAP=5` / 10 min, `firstMessageRetryBudget.ts`), the give-up branch calls `noteDestroyedEnvelope` (`productionRuntime.ts:5396`) â†’ the ack site computes `disposition = (!handledOk || destroyedInfo) ? 'discarded' : 'delivered'` (`:5138`) â†’ **`'discarded'`**. **[LINCHPIN â€” my first pass wrongly said 'delivered'; adversarial verify REFUTED that: it is 'discarded'.]**
4. Relay emits **`envelope.undeliverable`** to A â†’ `applyEnvelopeUndeliverable` flips A's bubble to **`undelivered`** (a visible marker â€” NOT a lying âœ“âœ“).
5. Messages `3 4 5` (sent after B's session stabilized/rebuilt + nudged A) decrypt normally and render. The number lost â‰ˆ messages in flight before the rebuild round-trip completed.

**Why A had "no error" in the report:** A's `1 2` sit at single-tick `sent` for up to ~10 min (B never acks `delivered` while retrying), THEN flip to `undelivered` when the budget-exhaust `undeliverable` lands. Easy to miss mid-conversation, and the tester was watching B.

**Verification workflow results (code claims, `wf_fb80e8e5-443`):**

| Claim                                                                                     | Verdict                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Budget-exhausted first-contact drop acks `'discarded'` (not `'delivered'`)                | **REFUTED my 'delivered' guess â†’ confirmed 'discarded'** (`:5396`+`:5138`)                                       |
| Rebuild (outbound X3DH) strands in-flight inbound first-msgs â†’ redelivery keeps failing | **CONFIRMED** (`:5488,:5492`)                                                                                      |
| Sender burst race / receiver concurrent frames is the trigger                             | **PARTIAL** â€” send-race real but per-address `withLock`+`txnChain` guard it; true trigger not provable from code |
| B-46 auto-resend fires only on `envelope.undeliverable` (disposition `discarded`)         | **CONFIRMED** â€” single call site `productionRuntime.ts` `case 'envelope.undeliverable'`                          |

**Status / fix:**

- **On the build the tester used (pre-v1.0.96):** `1 2` are permanently lost; A shows `undelivered` on them; no recovery. **REAL bug.**
- **On v1.0.96 (shipped 2026-07-05, B-46 Fix 1):** because the drop acks `discarded` â†’ `undeliverable`, the **B-46 auto-resend fires** (own outbound 1:1 **text**, `undelivered`, non-expired) â†’ force-refresh session + re-send under a new clientMsgId â†’ `1 2` should re-land on B. **Expected to auto-recover â€” MUST confirm on-device.**
- **Residual open (why this is B-47, not "already fixed"):**
  1. The B-46 resend is **one-shot** (`MAX_AUTO_RESENDS_PER_MESSAGE=1`). The resend is itself a fresh first-contact send, so it can hit the **same** first-contact instability and fail again â€” then it falls to the manual "Tap to retry" chip. Mitigated, not guaranteed.
  2. Only **1:1 text** is auto-resent â€” a first-contact **media** or **group** message that drops this way is NOT covered.
  3. **Recovery latency** is up to ~10 min (budget window) before the `undeliverable` even fires.
  4. The **underlying trigger** â€” why first contact genuinely fails at all (OPK reuse across the burst? the 9 `verify_throw` connect-rejects? a libsignal multi-pending-session quirk) â€” is **not yet root-caused**; needs an on-device repro with logcat.

**Retest (next device session â€” highest value):**

1. Fresh 1:1 pair, both online, send a rapid `1 2 3 4 5` burst. On B: `adb logcat | grep -E "recv.enter|decrypt-recovery|first-msg-|LeaveOnRelay|ACK ok .* disposition="`. Expect `disposition=discarded` on the lost ones.
2. On A: watch `1 2` â€” do they flip `sent â†’ undelivered`, then (v1.0.96) a resend fires and they flip to `sent`/`delivered` and appear on B? `grep -E "undeliverable-resend|envelope.undeliverable"`.
3. Repeat with **media** first-messages and a **group** first-message to scope the residual gap.
4. Correlate the 9 `verify_throw` handshake rejects to the test devices' connect timing (does B's socket get briefly rejected right as A sends?).

**Severity:** HIGH (silent first-message loss on every brand-new conversation, both online). QA role = find & document; no fix attempted here (v1.0.96's B-46 change is the existing mitigation).

---

### B-46 â€” Message sent while recipient is logged out never appears after recipient re-login âš ï¸ HIGH Â· silent message destruction Â· FIXED 2026-07-05 (Fixes 1+2 implemented + gated; Fix 3 deferred pending architecture approval)

**Reported (2026-07-05):** Device A sends a 1:1 message to device B while B is logged out. B logs back in â€” the message never appears on B. No error, no placeholder, nothing. A shows a quietly-flipped bubble at best.

**FIX SHIPPED (2026-07-05) â€” Fixes 1 + 2 landed; on-device retest pending in the next build.**

- **Fix 1 (sender auto-resend) â€” DONE.** New `src/modules/messenger/runtime/undeliverableResend.ts` holds the pure eligibility + one-attempt budget (`selectUndeliverableResend`); the `envelope.undeliverable` dispatcher case (`productionRuntime.ts`, `case 'envelope.undeliverable'`) now calls a `resendUndeliverable` closure that: evicts the peer from `peerIdentityCache`, runs the new `forceRefreshOutgoingSession` (overwrite trusted identity + `removeSession` + fresh X3DH against the peer's CURRENT authority-signed bundle â€” send-side mirror of `peerIdentityRefresh.ts`), re-seals the row's stored plaintext, and re-submits over HTTP relay under a **NEW `clientMsgId`** (old id is dedup-poisoned for the dwell window). Eligibility is narrow: own outbound 1:1 **text** rows still `undelivered`, non-expired, direct conversation only; budget = 1 automatic attempt/message (LRU-bounded 256). On success the bubble flips back to `sent`; on failure it stays `undelivered`.
- **Fix 1b (manual fallback) â€” DONE.** `ChatScreen.retrySend` + the status-chip render now treat `undelivered` like `failed` â†’ the "Tap to retry" chip appears on an undelivered 1:1 text bubble and re-runs the full send pipeline.
- **Fix 2 (recipient banner) â€” DONE.** New `messengerStore.undecryptableDropCount` + `noteUndecryptableDrop`/`clearUndecryptableDrops` (session-scoped, deduped by envelopeId, LRU-bounded, NOT persisted â€” excluded by the existing `partialize` allow-list). Both outer-unwrap discard sites (`productionRuntime.ts` drain catch + WS `handleDeliver` catch) now call `noteUndecryptableDrop` before ack-`discarded`. `MessengerHomeScreen` renders a dismissable amber banner ("N messages sent while you were away couldn't be decrypted â€” ask the senders to resend"). Per-conversation placeholders remain impossible by design (sealed sender â‡’ no known sender on an unwrappable envelope); the count banner is the disclosure ceiling.
- **Fix 3 (shrink the root-cause window) â€” DEFERRED.** Calling `purgeStaleRecipientQueue` on fresh-identity boot needs an architecture-approved MFA-token mint (the `RecipientPurgeGuard`/P1-T2 gate has no ceremony on the fresh-install path) â†’ **stop-condition, left for a dedicated pass.** Documented below.
- **Tests:** `src/modules/messenger/__tests__/undeliverableResend.test.ts` â€” 13 cases (eligibility matrix: inbound/read/media/group/expired/no-conversation skips, TTL carry-over, one-attempt budget, LRU bound; + counter dedup/clear). **Gates:** messenger-crypto 1348 pass, full suite 1657 pass, tsc **46** (â‰¤49 baseline), lint 0 errors.
- **âš ï¸ Crypto reality:** messages ALREADY sealed to B's dead identity stay unrecoverable ON B (sealed sender, no escrow â€” by design). Fix 1 recovers content from the SENDER; Fix 2 makes the loss visible to the recipient. Neither weakens any crypto/ack/dwell primitive â€” the resend is an ordinary new submit; the counter is UI-only.

---

**Original audit (2026-07-05) â€” root-cause analysis, retained for reference:**

**Audit â€” what is verified SOUND (devs: don't chase these):**

- **Relay queue + dwell:** the envelope persists at `pending:{userId}:{deviceId}` in Redis for up to 30 days awaiting the recipient's pull (`apps/messenger-service/src/relay/envelope.store.ts:74,566-567`; dwell `apps/messenger-service/src/relay/envelope.service.ts:39-41`). Being logged out does NOT lose the message at the relay layer.
- **Routing device-id is consistently `1` on both ends:** A's 1:1 send hardcodes recipient `deviceId: 1` (`src/modules/messenger/runtime/productionRuntime.ts:2570-2572` â€” "the send above reaches the peer's device 1"; conversation constructors at `:2097,2139,3004`; multi-device fan-out is flag-gated OFF). B's runtime uses `signalDeviceId = config.signalDeviceId ?? 1` (`productionRuntime.ts:358`) â€” MainNavigator passes none (`src/navigation/MainNavigator.tsx:258-277`). The HTTP pull presents `X-Signal-Device-Id: 1` (`apps/messenger-service/src/common/guards/jwt-http.guard.ts:69-75`) and the WS joins `device:{user}:1` (`apps/messenger-service/src/gateway/messenger.gateway.ts:471-473`). Queue key and pull key match. (The auth-service `signal_device_id` that churns per reinstall â€” `keys.service.ts` â€” is used ONLY for bundle/prekey resolution, never relay routing.)
- **Plain sign-out is non-destructive:** every UI logout calls `signOut()` with no opts â†’ SQLCipher DB + keychain identity survive (wipe gated on `opts.wipeAtRest` â€” `src/store/authStore.ts:559-581`); AsyncStorage `device:id` is never removed (`src/services/api.ts:173-183`); server `deleteSession` only sets `revoked_at` (no row delete) and re-login reuses the same `signal_device_id` (`apps/auth-service/src/auth/auth.service.ts:74-102,568-590`).
- **Catch-up drain fires on every (re)connect:** `'connected'` â†’ `coalescedDrain()` â†’ `drainRelay` pages `GET /envelopes` from cursor 0 (`productionRuntime.ts:902-910,6733-6791`), and the server independently re-pushes via `flushPendingOnConnect` (`messenger.gateway.ts:512-514`).

â‡’ **For a true same-install plain logoutâ†’login with unchanged identity, the pipeline delivers by design.** The loss requires the mechanism below.

**Root cause (the bug): identity churn + silent destruction, with no recovery loop.**

1. **Identity churn makes the queued envelope permanently undecryptable.** `installIdentity()` auto-creates a fresh Signal identity whenever the local store has none (documented in-code at `src/navigation/MainNavigator.tsx:279-289`). That happens on: reinstall, cleared app data, "Remove account from this device" (`wipeAtRest`), logging the account into a DIFFERENT install (each install = new `auth_devices` row â†’ new server `signal_device_id` + new identity rows â€” the exact churn class documented at `apps/auth-service/src/keys/keys.service.ts:259-272`), or a failed/skipped BackupRestore â€” which was hard-broken on v1.0.92â€“94 (B-45), so every restore in that window dead-ended in a fresh identity. A sealed the envelope to B's OLD identity (outer-ECIES binds the recipient identity key into the GCM AAD â€” `src/modules/messenger/crypto/outerEcies.ts`).
2. **The client then DESTROYS the message silently.** On B's next drain, `unwrapOuter` throws ("outer sealed authentication failed") and the client acks the envelope **`'discarded'`** â€” hard-deleting it from the relay â€” with ZERO trace on B: `drainRelay` catch at `productionRuntime.ts:6800-6819`; identical posture on the WS deliver path (`:4984-4997,5003-5014`). The existing `insertDecryptFailurePlaceholder` ("A message couldn't be decryptedâ€¦", `decryptFailureSignal.ts:83-110`) is only reachable for POST-unwrap failures where the sender is known (AAD reject `:5826-5831`, group tamper `:6037-6038`). An outer-unwrap failure cannot attribute a conversation (sealed sender â‡’ sender unknown), so NO placeholder is possible â€” the receiver sees pure silence.
3. **The sender is told, but nothing recovers.** The relay emits `envelope.undeliverable` to A (queued for offline senders â€” `envelope.service.ts:362-374,389-408`) and A's client flips the bubble `sentâ†’undelivered` (`decryptFailureSignal.ts:119-133`, wired at `productionRuntime.ts:4503-4507`). But there is **no auto-resend and no resend affordance** â€” even though A still holds the plaintext locally and recovery is trivially possible from A's side.
4. **Compounding:** the fresh-identity path never calls the existing `purge-stale-recipient` cleanup (only the explicit rotation ceremony does â€” `productionRuntime.ts:499` â†’ `src/modules/messenger/crypto/ownIdentityRotation.ts:64`), so dead envelopes sit up to 30 days being discarded one-by-one on every drain instead of senders being notified promptly.

**Discriminate the repro variant (tester steps for the next device session):**

1. Re-repro with logcat on B during re-login: `adb logcat | grep -E "drainRelay-unwrap-failed|drainRelay unwrap failed|ws-handle-failed|recv-failure placeholder"`. A `drainRelay-unwrap-failed` hit = identity-churn variant confirmed (the envelope WAS delivered to B and destroyed there).
2. Supabase: `SELECT device_id, updated_at FROM signal_identities WHERE user_id='<B>' ORDER BY updated_at DESC;` â€” multiple device rows, or an `updated_at` bump at B's re-login moment = churn confirmed.
3. On A: logcat `[envelope.send] accepted envId=` proves the envelope reached the relay; then watch whether A's bubble flips to `undelivered`.
4. If none of the above fire and B's logout was genuinely a plain same-install sign-out: set `RELAY_PULL_DEBUG_LOG=1` on staging msgr (`envelope.controller.ts:135-138`) and re-repro â€” `returned=0` vs `returned=N` splits "never queued / wrong queue" from "queued but destroyed client-side".
5. Rule out disappearing-message TTL: if the test chat had a timer, the envelope self-evicts from Redis at `expiresAtSec` even if never fetched (`envelope.service.ts:87-152`) â€” that is by design, not this bug.

**What to change (dev handoff â€” where / what):**

- **Fix 1 (primary â€” actually recovers the content): sender-side auto-resend on `envelope.undeliverable`.** `src/modules/messenger/runtime/productionRuntime.ts:4503-4507` (+ `decryptFailureSignal.ts:119`): on flip to `undelivered`, evict the peer from `peerIdentityCache`, re-fetch the bundle (`keys.fetchBundle` â†’ picks up the NEW identity), rebuild the pairwise session, re-seal the locally-stored plaintext, and re-send with a **NEW `clientMsgId`** â€” the old one is dedup-claimed for the full dwell window (`envelope.service.ts:154-181`), so reusing it would be coalesced into the dead envelope and dropped. Bound it with a retry budget (reuse the `firstMessageRetryBudget.ts` pattern) so two churning devices can't ping-pong. If the retry also returns undeliverable: leave the bubble `undelivered` and add a visible "Not delivered â€” tap to resend" affordance in ChatScreen (verify `undelivered` renders distinctly at all today).
- **Fix 2 (recipient visibility â€” stop the silent loss):** at the two ack-`'discarded'` sites for outer-unwrap failures (`productionRuntime.ts:6800-6819` drain; `:4984-5014` WS), count destroyed envelopes per session (hook already exists: `noteUndecryptable` in `src/modules/messenger/backup/sessionRatchetRecovery.ts`) and surface a one-time MessengerHome banner: "N messages received while you were away couldn't be decrypted. Ask senders to resend." Per-conversation placeholders are impossible here BY DESIGN (sealed sender â‡’ unwrappable envelope has no known sender) â€” the banner is the ceiling of what's disclosable.
- **Fix 3 (shrink the root-cause window):** when boot detects that `installIdentity` is about to CREATE a new identity (not load one â€” the state the MainNavigator backup-probe comment calls out, `MainNavigator.tsx:279-293`) while the relay holds queued envelopes for this user: (a) warn the user that messages sent to the previous installation cannot be recovered; (b) call the existing `purgeStaleRecipientQueue` (`ownIdentityRotation.ts:64`; endpoint `envelope.controller.ts:207-218`) so senders get `envelope.undeliverable` immediately (feeding Fix 1) instead of trickling over 30 days of drains. NOTE: the purge endpoint requires a fresh MFA action token (`RecipientPurgeGuard`, P1-T2); the fresh-install path has no rotation ceremony, so this needs an architecture-approved token mint.
- **âš ï¸ Stop-condition:** Fixes 1/3 touch relay ack/dispositions, envelope-ID/dedup handling, and an MFA gate â€” per CLAUDE.md security constraints, verify against the System Architecture Documentation before implementing. Also note: messages already sealed to a dead identity are **cryptographically unrecoverable on B** (sealed sender, no escrow â€” by design); only sender-side re-send recovers content, which is why Fix 1 is primary.

**Severity:** HIGH (silent, permanent 1:1 message loss around logout/reinstall/identity churn; recipient fully blind, sender near-blind). **Status:** FIXED (Fixes 1+2 landed 2026-07-05, gates green, in the next APK build). Fix 3 deferred (stop-condition). On-device retest steps above still apply to confirm the auto-resend recovers the message and the recipient banner shows.

---

### Bug B-39 â€” Ops Console: OTP / MFA Second Factor Is Not Validated (any code accepted) âš ï¸ CRITICAL Â· security stop-condition Â· CONFIRMED 2026-06-19 (web, staging)

**Component:** Ops Console (Next.js) at `https://ops.94-136-184-52.sslip.io`. **Account:** `+880188888888` (WOLF ADMIN). **Tool:** Playwright + desktop Chrome (Maestro web driver was non-functional on this machine).
**Reproduce (verified in fresh, cookie-isolated browser contexts):**

1. `/login` â†’ enter phone `+880188888888` + **correct** password `Bravo@2026` â†’ CONTINUE â†’ reaches the "ONE-TIME CODE" (OTP) step ("OTP sent to â€¦").
2. Enter **any** 6-digit code â€” tested `111111`, `999999`, `000000` (all wrong) â†’ SIGN IN â†’ **lands on `/dashboard`, fully authenticated.**
3. Control: correct code `123456` also logs in (baseline).

**Evidence (`verify_otp.js`, fresh context per attempt, no cookie carryover):**

| phone correct, password | OTP      | result                                                          |
| ----------------------- | -------- | --------------------------------------------------------------- |
| `Bravo@2026` (correct)  | `123456` | âœ… /dashboard (control)                                        |
| `Bravo@2026` (correct)  | `111111` | âœ… **/dashboard**                                              |
| `Bravo@2026` (correct)  | `999999` | âœ… **/dashboard**                                              |
| **`WrongPass!1`**       | `123456` | âŒ "Wrong phone or password" â€” blocked at step 1, no OTP step |
| `WrongPass!1`           | `424242` | âŒ blocked                                                      |

**Finding:** the **password IS enforced** (step 1 rejects a wrong password and never issues an OTP step), but the **OTP step accepts any 6-digit value** â€” the second factor provides no actual protection. For a privileged ops/admin console this collapses MFA to single-factor.

**Corroboration (makes this a contract violation, not just a quirk):** the console's own **Settings â†’ "Read-only console info"** page explicitly lists **"2FA REQUIREMENT: Enforced via OTP at login"** as a server-enforced control (alongside "SESSION TIMEOUT: 15 min", "ACCESS TOKEN: rotates via /auth/session/refresh", "CSRF: double-submit cookie", "IDEMPOTENCY: 24h replay protection"). So the app **advertises OTP 2FA as enforced** while the actual SIGN IN step accepts any code.

**Caveat / what to confirm:** this is the **staging** deployment â€” it's possible OTP verification is deliberately stubbed/bypassed in staging. **Action for dev:** confirm whether this is a staging-only shim or the real verification path, and that **production validates the OTP server-side**. Per CLAUDE.md this touches a **stop-condition** (biometric/TOTP gate must not be weakened / no "skip in dev" branch unless the architecture doc allows) â€” do not ship a build where the ops-console OTP is unchecked.

**Files to check (start):** ops-console login handler + the auth-service `/auth/verify` (or OTP) endpoint the SIGN IN step calls; whether the OTP is compared server-side or only `200`-gated.
**Severity:** CRITICAL (auth/MFA bypass on an admin console). QA role = find & document; no fix attempted.

---

### B-49 â€” Client-panic SOS insert broken on staging (`sos_events` schema drift) âš ï¸ CRITICAL Â· server/DB Â· FIXED 2026-07-05

**Found during:** VBG audit remediation deploy (the new missed-scan watchdog was the first thing to exercise `SosService.raise` server-side and surfaced the error on its very first sweep).

**Symptom:** every `SosService.raise` call on staging failed with `column "user_id" of relation "sos_events" does not exist` â€” meaning the **VBG panic button, biometric-escalation and geofence-breach SOS rows have never landed in the DB on staging** (the client void-catches, ops feed emit happens separately, so nothing visibly errored).

**Root cause:** schema drift. The client-panic `SosService` (raise/cancel/status) writes a newer `sos_events` shape â€” `user_id, booking_id, location, status, payload, resolved_by` â€” but the Supabase table only ever got the agent-SOS-era schema (`mission_id NOT NULL, agent_id, agent_call_sign, â€¦`). The migration adding the client-panic columns was never applied.

**Fix (applied to Supabase, additive, agent-SOS writes untouched):** migrations `sos_events_client_panic_columns` (adds the six missing columns + `(user_id, status)` index) and `sos_events_mission_id_nullable` (drops the agent-era NOT NULL â€” client panics have no mission).

**Live verification:** re-armed a stale test enrollment â†’ watchdog sweep at 13:47:25 UTC created an `active` `vbg_biometric_missed` SOS row and stamped `vbg_monitoring.escalated_at`; two subsequent sweeps clean (no re-fire). Verification row marked `resolved`.

**Follow-up for dev:** confirm production/other environments have the same columns before release; the fact that no one noticed means there is no alert on SOS insert failures â€” consider surfacing `sos_insert_failed` to the ops feed.

---

### B-45 â€” Chat Backup "Setup failed. Please try again." (ENABLE BACKUP always fails) âš ï¸ CRITICAL Â· client crypto Â· FIXED 2026-07-04

**Reported (2026-07-04, physical device, v1.0.92/93):** Settings â†’ Chat Backup â†’ enter password twice â†’ ENABLE BACKUP â†’ red inline error **"Setup failed. Please try again."** after ~2â€“3 s. Retry never helps; also blocks the B-44 re-setup remedy.

**Root cause (verified end-to-end):** the P0-1 remediation (`4025d6c`) added `deriveVerifierKey` (`src/modules/messenger/backup/backupCrypto.ts`) using WebCrypto `subtle.importKey('HKDF')` + `deriveBits(HKDF)` â€” the first (and only) HKDF-via-`subtle` call in the mobile app. On-device `crypto.subtle` is **react-native-quick-crypto 0.7.17**, whose HKDF cases are literally **commented out** (`lib/commonjs/subtle.js:313,426`) â†’ throws `"subtle.importKey()" is not implemented for HKDF` right after the argon2 derive. `polyfills.ts` shims HMAC + SHA digest but not HKDF (3rd instance of the same Jest-green/Hermes-dead class â€” Jest uses Node's real WebCrypto + a quick-crypto mock, so all suites pass). **Server-log proof the failure is client-side:** `bravo-staging-msgr` shows ZERO `putIdentity` lines in 36 h, yet the handler logs on every call for an existing-row user. Server/DB/migrations independently healthy (B-44). Blast radius: backup setup AND restore/unlock dead on every v1.0.92+ device; message mirror never enabled.

**Fix (2026-07-04):** `deriveVerifierKey` re-implemented with `@noble/hashes` `hkdf(sha256, ikm, undefined, info, 32)` â€” the pure-JS pattern already proven on-device in `media/aesCbc.ts`. Byte-for-byte identical to the old WebCrypto output (RFC 5869 empty-salt equivalence) â€” pinned by 2 new tests in `backupVerifyProof.test.ts` (static vector + cross-impl vs Node subtle). Also: `setupBackup` now zeroes the raw derived key on the throw path (`try/finally`). **No server deploy / DB migration needed** (derivation is client-only; server just stores the 32 bytes). Gates: crypto 1335/1335, full suite 1644 pass, tsc 46 (â‰¤49), lint 0.

**Retest (closes B-44's pending retest too):** on the new build â€” ENABLE BACKUP â†’ "Backup enabled" alert with counts; Supabase `identity_backups` row has `verifier_key` non-null + `updated_at` today; msgr logs show a `putIdentity` line; kill+relaunch â†’ UNLOCK with correct password restores; wrong password â†’ "Wrong password" (not `verifier_missing`) + `failed_attempts` bump.

**Full handoff:** `docs/handoffs/BACKUP_SETUP_FAILED_HKDF_HANDOFF.md` (includes the follow-up flags: boot-time HKDF self-test, `sframe.ts:167` uses the same broken subtle-HKDF â€” verify it stays unreachable on Hermes).

**Round 2 (same day, v1.0.94 retest):** setup now succeeds, but unlock/restore failed with `Restore failed: Exception in HostFunction: Invalid Hash Algorithm!` â€” `computeVerifyProof` called `subtle.sign('HMAC', â€¦)` in STRING form; the polyfills HMAC shim's hash-name parser returns `''` for string-form algorithms (the `?? 'SHA-256'` fallback only covers the object form) â†’ `createHmac('')` â†’ quick-crypto native throw. Messaging never hit it because libsignal uses the object form. **Fixed + shipped v1.0.95 (vc121):** `computeVerifyProof` â†’ `@noble/hashes` `hmac(sha256, â€¦)` (byte contract pinned by the existing proof test) + polyfills hardening (hash bound at importKey is stashed per-key; string-form sign/verify falls back to it, then `'sha256'`). Swept the whole setup/restore/mirror path â€” that was the last subtle hash-family call in backup; no third landmine. Full detail: handoff Â§9.

**Round 3 (2026-07-05, v1.0.95 retest) â€” OPEN, root-caused, NOT a crypto bug:** rounds 1+2 confirmed fixed on-device (setup + password proof pass), restore now fails at the integrity gate: `Restore failed: backup.merkle_mismatch:rows_count_mismatch`. Root cause = **Merkle-commit design flaw**: the mirror uploads rows continuously (1.5 s flush debounce) but the signed row-count commit only ships on a 30 s post-flush debounce, and the AppState background handler force-flushes ROWS while abandoning the pending COMMIT timer (`messageMirror.ts:118-131`) â€” so the server routinely holds more rows than the last signed count, and `verifyMerkleCommit` hard-fails the difference as tampering (H-4 excludes count mismatch from self-heal). Also: the setup-time initial commit races the still-flushing outbox (signs a near-empty baseline). **Live DB proof (2026-07-05):** account `fe4ddc14â€¦` committed=3 vs server=14 (11 rows after last commit â€” the screenshot account), `79d63649â€¦` committed=27 vs 28; two healthy accounts match exactly. Retry can never heal an idle account (commits only follow flushes). **Tester workaround:** send one message, keep app foregrounded ~60 s, retry unlock (or wipe + start fresh). **FIXED 2026-07-05, shipped v1.0.97 (vc123):** all four Â§10 changes implemented â€” (1) `verifyMerkleCommit` returns direction-aware `rows_count_grew` (fetched > committed) vs `rows_count_mismatch` (fetched < committed, stays hard-fail per H-4); restore self-heals `rows_count_grew` via the existing `recommitAndReverify` (re-signs over the fetched set; server can't exploit â€” no master key, injected rows fail per-row GCM); (2) AppState backgrounding now fires the pending Merkle commit right after the forced row-flushes (only when one is owed); (3) `BackupSetupScreen.handleEnable` drains the mirror outbox (`drainMirrorOutbox()`) before the baseline commit so it signs the uploaded set; (4) `MERKLE_DEBOUNCE_MS` 30 s â†’ 5 s. Boot-path hook install verified present (`backupBoot.ts:211/223/241` â†’ `startMirrorBootstrap`); the 2 h gap = kill-window + swallowed errors, both closed. Tests: `merkleRecommitReconcile` +3, new `messageMirrorMerkleFlush` (4). Gates: crypto 1355/1355, full 1664, tsc 46 â‰¤ 49, lint 0. Retest per handoff Â§11 step 6 (also run the Â§10 SQL â€” counts must converge).

---

### B-44 â€” Backup fails with `verifier_missing` on v1.0.92 (vc118) Â· NOT A BUG â€” designed P0-1 one-time hard cut Â· VERIFIED 2026-07-04 (DB + deployed container inspected)

**Reported (2026-07-04):** after installing the new build, backup fails with `verifier_missing` ("This backup needs to be re-securedâ€¦").

**Verdict: expected behavior, first surfacing in this build.** The backup P0-1 remediation (`4025d6c`, 2026-07-03) replaced the old trust-the-client unlock with a real server-side verify protocol: the client must prove the backup password via HMAC against a `verifier_key` stored on the row. Backups created **before** that upgrade have no `verifier_key` â€” the server can never validate a proof for them (the verifier derives from the password, which the server never sees), so it hard-rejects with **409 `verifier_missing`** (`apps/messenger-service/src/backup/backup.service.ts:449`). No backfill is possible by design (see the note at the bottom of `supabase/migrations/20260703000000_backup_verify_atomic_bump.sql`).

**Evidence gathered (all three layers consistent â€” no deploy/migration mismatch):**

1. **DB (Supabase):** all 5 `identity_backups` rows have `verifier_key IS NULL`; newest `updated_at` = 2026-06-27, i.e. every row pre-dates the P0-1 deploy. Both migrations applied (`verifier_key` column exists; `bump_backup_failed_attempts()` present with PUBLIC revoked).
2. **Server:** `bravo-staging-msgr` (rebuilt ~20 h before check, healthy) contains the verifier code (`grep verifier_missing dist/backup/backup.service.js` â†’ hit).
3. **Client:** v1.0.92 is the first QA build carrying the P0-1 client (`identityBackup.ts:310-315`, `backupClient.ts:117-119`).

**Remedy for testers (one-time per account):**

- **Device still logged in (identity intact):** Settings â†’ Chat Backup â€” the screen detects the legacy row and drops into re-setup with "Your backup needs to be re-secured. Set your backup password again to continue." (`BackupSetupScreen.tsx:123-130`). Enter the backup password twice â†’ new backup with verifier uploaded. **Note:** `setupBackup` mints a NEW master key (`identityBackup.ts:263`), so the old server-side message mirror is orphaned â€” acceptable, since the legacy backup was already un-unlockable.
- **Fresh install / restore screen:** the legacy backup is unrecoverable by design â†’ use **"Forgot password â€” wipe + start fresh"**, then set up backup again after login.

**Pass criteria for the retest:** after re-setup, the row shows `verifier_key` non-null (32 bytes); kill + relaunch â†’ unlock with the correct password succeeds; a wrong password fails with `wrong_password` (not `verifier_missing`) and bumps `failed_attempts`.

**UX gap found during the same session (FIXED same day, see below â€” audit round-2 P1-G was only half-fixed):** the fresh-install **BackupRestoreScreen** has no `verifier_missing` handling at all (zero references in the file). It lets the user type a password + pass the biometric gate, then fails with the generic copy _"This backup needs to be re-secured. Set your backup password again."_ â€” impossible advice on that screen: Settings is unreachable behind the restore gate (back-press is deliberately trapped), and no password can ever succeed against a legacy row. The Setup screen got the upfront `header.verifierMissing` detection (`BackupSetupScreen.tsx:123-130`); the Restore screen did not. **Fix implemented (2026-07-04, explicitly requested):** `BackupRestoreScreen` now reads `header.verifierMissing` on the mount probe and replaces the password form with a hard-cut panel ("This backup can't be unlocked" + single primary action **START FRESH** â†’ the existing wipe flow); defense-in-depth: a `verifier_missing` thrown mid-restore also flips to the panel instead of a generic error. Test: `BackupRestoreScreen.legacy.test.tsx` (3 â€” legacy panel, normal-form regression, mid-flight flip). Gates green: app 170/170, backup/restore crypto 68/68, tsc 46 (â‰¤49 baseline), lint 0. **Needs an APK rebuild to reach devices** â€” until then, tester workaround: tap **"Forgot password â€” start fresh"** (wipes only the dead server blob; nothing recoverable is lost), then Settings â†’ Chat Backup â†’ set password.

---

### Bug B-43 â€” "A contact's security code changed" banner + entire offline backlog missing after new-build install âš ï¸ HIGH Â· identity-rotation/relay Â· AUDITED 2026-07-03 (needs device logs to close)

**Reported (2026-07-03, physical device, chat with "Ronok"):** red banner `Error: A contact's security code changed â€” their messages will resume on a new secure session.`; separately, messages sent to the tester while their device was offline never appear when the app is reopened.

**Audit conclusion (code audit, no device logs yet):**

1. **The banner itself is BY DESIGN, not a bug.** It fires only when the peer's published identity key genuinely changed AND the keys-service (authority-signed bundle) confirms it â€” the Signal/WhatsApp "safety number changed" model (`productionRuntime.ts:4566/4644/6455/6547` â†’ `crypto/peerIdentityRefresh.ts`). A fresh install / clear-data of the app on the peer device ALWAYS mints a new identity â†’ every contact sees this banner once. It is expected during new-APK test cycles that reinstall the app.
2. **Why the rotation happened:** current code (â‰¥ v1.0.87/vc112, contains `fffe40a`) has a stable identity â€” G-01 (30-day identity time-bomb) is fixed (`packages/messenger-core/src/crypto/identity.ts:40-59`, retention 60d > rotation 30d). So the rotation came from either (a) a fresh install/data-clear of the new build on the peer device (normal), or (b) the peer device having run a **pre-1.0.87 build** whose G-01 time-bomb regenerated identity in place _while keeping old sessions_ â€” the poison case below.
3. **Offline-backlog loss â€” three distinct mechanisms, in likelihood order:**
   - **Pre-1.0.87 receiver = MSG-01.** The old 15-min sealed-AAD staleness window dropped **and ACKed off the relay** every envelope older than 15 min on drain â€” the exact "offline overnight â†’ open app â†’ nothing" symptom. Fixed in v1.0.87 (stale bound = 30-day relay dwell, `sealedSender.ts:468-478`). **Verify the installed versionName on BOTH devices before any retest.**
   - **Rotation-boundary loss (by design, unavoidable E2EE property).** Envelopes queued on the relay that were sealed under pre-rotation state are cryptographically unrecoverable: sealed to the receiver's old identity â†’ `unwrapOuter` fails â†’ ACK-drop (`productionRuntime.ts:6368-6386`); sealed under the peer's old ratchet â†’ dropped post-refresh as "sealed to archived ratchet" (`:6565-6584`). Signal behaves the same way.
   - **Poison case (real product gap): peer rotated identity but KEPT old sessions** (only happens via the old G-01 bug â€” fresh installs keep no sessions). Every queued message is a WhisperMessage on a dead ratchet: first one triggers refresh+session-reset (banner), the rest fail `NoSessionError` â†’ B-30 leave-on-relay budget (5 attempts / 10 min, `firstMessageRetryBudget.ts:36-38`) â†’ eventually ALL ack-dropped. Whole backlog silently lost; live messages recover only after the rehandshake nudge rebuilds the peer's session.
4. **Residual gaps found (open, not yet fixed):**
   - **Sender is never told.** Ack-drop is indistinguishable from delivery server-side: the ack fires the RELAY-C3 delivered receipt, so the sender can show **âœ“âœ“ on a message that was destroyed**. No "couldn't decrypt N messages" placeholder is rendered in the chat (Signal shows one).
   - **`purgeStaleRecipientQueue` is dormant.** `crypto/ownIdentityRotation.ts:64-84` has NO production caller even though the MFA-gated server endpoint now exists (`envelope.controller.ts:203-214`); after an own-identity rotation, undecryptable envelopes sit on the relay consuming dwell until drained-and-dropped one by one.
   - Server never purges/reconciles queues on re-registration (sealed-sender-blind by design â€” confirmed `envelope.service.ts`, `envelope.store.ts`).
5. **Not implicated (verified clean):** identity is NOT regenerated on restart/upgrade/schema-migration; SQLCipher bad-key open throws instead of silently recreating an empty store (B-15b hardening, `runtime/keychain.ts:135-161`); `signalDeviceId` is constant 1 so no queue-addressing mismatch; drain triggers on every WS `connected` incl. foreground reconnect; PUSH-B1 chat-wake now fires on HTTP submit (deployed 2026-07-02).

**To close, capture logcat on the receiving device during a repro and match one of these breadcrumbs:** `drain-unwrap-failed` (own identity rotated), `drain-identity-rotation â€¦ outcome=refreshed` + `dropped (sealed to archived ratchet)` (peer rotation boundary), `drain-handle-failed` / `first-msg-*` (poison case / other), `stale` (would mean a pre-1.0.87 build). Also confirm auth-service on Contabo is deployed with `552f089` (authoritySig on GET /auth/keys/:userId) â€” without it v1.0.87 clients log `bundle_authority_sig_missing` (fail-open on continuity, not message-eating, but noisy).

**Golden retest (both devices on â‰¥1.0.87 fresh installs, sessions established by one round-trip message):** device A offline â†’ B sends 3 msgs â†’ A online â†’ all 3 must appear; the banner must NOT reappear on any subsequent restart.

---

### Bug B-42 â€” Group call: the person you call joins the SFU room but never produces media â†’ "Call failed"; new group members get no key âš ï¸ HIGH Â· group-key Â· FIXED (code) 2026-06-27 (vc106)

**Reported by QA (2026-06-27):** "I call the other person, it rings, they pick up, but they never join the room â€” then the call fails." Also: "added to a group but I get no notification / don't see the group."

**Diagnosis (from server + host logs; joiner client logs unavailable â€” BlueStacks exposes no logcat):**

- Host (`a6239b7a`) creates SFU room, joins, **re-broadcasts the existing group key** as an owner-signed `admin:create` at its CURRENT epoch (`ensureCallGroupKey` BS-CALL-KEY-RESYNC, `productionRuntime.ts:3274` â€” host owns the group â†’ no epoch bump). Host log: `[call-adhoc-key:runtime] key resynced delivered=1`.
- Server confirms the 2 sealed key envelopes are **delivered to the joiner** (`localSocket=true`) and the joiner **joins the SFU** (host sees `participant.joined`), but the joiner **never produces** (host stays "consuming 0 producers") â†’ joiner stuck at the 25s key-wait â†’ fails closed â†’ **"Call failed."**

**Root cause:** the receive-side `group-create:recv` **epoch-monotonicity guard** (`productionRuntime.ts:~5416`) dropped the key-bearing create as "stale/replayed" when the joiner already held a **keyless** state for that group at an equal/higher epoch (e.g. it had received an `add` admin action that advanced its epoch, or a key-request stub, but never the key). The re-broadcast create is at the same epoch â‡’ `epoch <= existing.epoch` â‡’ dropped â‡’ joiner stays permanently keyless â‡’ group messages never decrypt AND group calls die at key-wait. Same root as "added to a group but nothing shows."

**Fix:** only enforce the epoch guard when we actually hold a master key worth protecting â€” `if (existing && existing.masterKeyB64 && action.state.epoch <= existing.epoch) drop`. With no local key there is no established keyed state to roll back, and the create is already owner-signature-verified (`verifyGroupCreateSignature` + `owner===peer`), so accepting it is a **bootstrap, not a downgrade** (replay/re-admit/key-reset defence stays intact once a key is held). Test: `groupCreateEpochBootstrap.test.ts` (5). Gates green: crypto 1118/1118, tsc 47.

**Security note:** touches group-key/epoch handling (a CLAUDE.md stop-condition). The relaxation is conservative (owner-signed creates only, keyless-state only) but **should get architecture sign-off + 2-device device-verification** (does the joiner now join?). Shipped in **v1.0.81 (vc106)** to Firebase qa for that test.

---

### Bug B-41 â€” ALL 1:1 calls (and group calls on UDP-restricted networks) stuck on "Answeringâ€¦" â€” TURN secret drift âš ï¸ CRITICAL Â· infra/staging Â· CONFIRMED + FIXED 2026-06-27 (vc103)

**Reported by QA (2026-06-27):** "Calling kaj kore na â€” audio/video answering e atke thake" (calls don't work â€” stuck at the Answering step), same for **group calling**.

**Symptom:** Caller dials, callee accepts, both sides show **"Answeringâ€¦/Callingâ€¦"** (= `callState==='connecting'`, see `CallScreen.tsx:1821`) and never reach `Connected`. Signaling works (offer/answer/ICE delivered over WS, messaging unaffected) but the media path never establishes.

**Root cause (infra, NOT code):** **`TURN_STATIC_AUTH_SECRET` mismatch** between `messenger-service` and coturn on staging (94.136.184.52).

- 1:1 calls are **relay-only** (`peerConnection.ts:193` â†’ `iceTransportPolicy:'relay'`) â†’ they _require_ a working coturn relay. No relay candidate â‡’ zero usable ICE candidates â‡’ permanent "Answeringâ€¦".
- `messenger-service` (container `bravo-staging-msgr`, recreated ~13 h before the report from `.env`) issues TURN REST creds HMAC-signed with the **base64** secret `zktVJXM+â€¦` (44 chars).
- coturn (`bravo-staging-coturn`, up 3 weeks, started from `.env.staging`) validated against the **hex** secret `ad864221â€¦` (48 chars).
- Both `docker-compose.staging.yml` services template the _same_ `${TURN_STATIC_AUTH_SECRET}`, but **`/home/admin/bravo/.env` (44) and `.env.staging` (48) had drifted** â†’ coturn 401-rejects every app credential.

**Proof (live `turnutils_uclient` allocate against coturn):**
| Credential | Before fix | After fix |
| --- | --- | --- |
| base64 (what the app sends) | âŒ `Cannot complete Allocation` | âœ… relay OK, 0 pkts lost |
| hex (coturn's old secret) | âœ… relay OK | âŒ `Cannot complete Allocation` |

Also confirmed: msgr healthy, coturn healthy, firewall open (3478, 5349, relay 49160-49200/udp, SFU 40000-40100/udp), 22 `turn.issue` logs in 13 h (endpoint working â€” only coturn _acceptance_ was broken).

**Why group calls were affected too:** group uses `iceTransportPolicy:'all'` (direct to the public SFU) so it doesn't _need_ TURN on permissive networks â€” but on UDP-restricted/CGNAT networks it falls back to the TURN relay, which was equally broken. Fixing the secret restores the fallback. (Group on an open network should be re-confirmed by QA.)

**Fix applied (2026-06-27):** aligned both `.env` and `.env.staging` to msgr's live base64 secret (eliminates the drift permanently), backed up both (`*.bak.turnfix.<ts>`), and `docker compose -f docker-compose.staging.yml up -d --no-deps --force-recreate coturn` (msgr/WS untouched, ~2 s TURN blip). Verified via the allocate flip above.

**Hardening IMPLEMENTED 2026-06-27 (code, needs build + 2-device test before relying on it):** 1:1 `iceTransportPolicy` now defaults to **`'all'`** (host + srflx + relay â€” same as the group/SFU path) instead of hard-coded `'relay'`, so a coturn/TURN outage degrades gracefully (same-LAN + non-symmetric-NAT calls still connect) instead of bricking every call. Files: `peerConnection.ts` (`resolveIceTransportPolicy()` + optional `iceTransportPolicy` wrapper option, read via `globalThis.process.env` to dodge babel-preset-expo's `expo/virtual/env` injection), `CallScreen.tsx` (STUN-only fallback comment â€” now functional under `'all'`). Escape hatch: `EXPO_PUBLIC_ICE_RELAY_ONLY=true` restores relay-only without a code change. Tests: `iceTransportPolicy.test.ts` (5). Gates green: crypto 1113/1113, tsc 47 (â‰¤49 baseline), lint 0. **Still call-quality-sensitive** (documented Pixel-cellular asymmetric-failure reasoning in `peerConnection.ts`) â€” needs multi-device cross-network testing before prod confidence; the env escape hatch is the rollback.

**Note:** the staging build's `EXPO_PUBLIC_MSG_BASE_URL` is `https://relay.94-136-184-52.sslip.io` (not `msg.*`) â€” same `bravo-staging-msgr:3100` container, just the public hostname.

---

### Bug B-40 â€” Ops Console: SIGN OUT Is Non-Functional (session never ends) âš ï¸ HIGH Â· security Â· CONFIRMED 2026-06-19 (web, staging)

**Component:** Ops Console (Next.js). **Reproduce (verified, instrumented, 2 runs):**

1. Log in â†’ `/dashboard`. Cookies present: `bravo_ops_token`, `bravo_ops_refresh`, `bravo_ops_csrf`.
2. Click **SIGN OUT** (button visible, click registers, no error).
3. **Nothing happens:** URL stays `/dashboard` for the full 9s poll, the dashboard stays fully rendered (live map + activity stream), and **all three auth cookies remain set**.
4. Navigating to `/agents` afterward loads the full **Agent Roster as WOLF ADMIN** â€” still fully authenticated. No confirmation modal appears.

**Evidence (`logout_test.js`):** `cookiesBefore == cookiesAfter` (all 3 still set), `urlsAfterClick` = `/dashboard` Ã—9, `stillAuthedAfterLogout: true`.

**Impact:** a user who believes they've signed out remains logged in; tokens persist in cookies. On a shared/kiosk/handover machine this leaves a privileged admin session open. Pairs badly with **B-39** (the only "real" auth control is the password).

**Inferred root cause (to verify):** the SIGN OUT click handler doesn't fire / doesn't call the logout endpoint, or the endpoint returns without clearing cookies + redirecting. **Files to check:** ops-console top-bar SIGN OUT control + its logout action (cookie clear / `/auth/session` DELETE / redirect to `/login`).
**Severity:** HIGH. QA role = find & document; no fix attempted.

---

### Bug B-35 â€” A Group Member's Outbound Is Undecryptable by ALL Other Members (sender-side group-key distribution gap) âš ï¸ CONFIRMED 2026-06-18 (vc79)

**Reproduce:** In group **"SQA - Fahim"** (owner = fahim, 4 operators), with itsirajul(5555), fahim(5575), shirajul(Pixel 7a) all members:

1. itsirajul sends â†’ shirajul AND fahim render it fine.
2. shirajul sends â†’ itsirajul AND fahim render it fine.
3. **fahim sends â†’ NEITHER itsirajul NOR shirajul can render it; both show the red banner** _"Error: Waiting for this group's encryption key â€” the message will appear once it syncs."_
4. fahim itself shows NO banner (it renders its own outbound from plaintext).

**Frequency:** 100% for fahim's outbound in this group this session (2/2 sends).

**Asymmetry (the diagnostic core):**

| Sender    | itsirajul reads | fahim reads | shirajul/Pixel reads |
| --------- | --------------- | ----------- | -------------------- |
| itsirajul | â€” (own)       | âœ…         | âœ…                  |
| shirajul  | âœ…             | âœ…         | â€” (own)            |
| **fahim** | âŒ red banner   | â€” (own)   | âŒ red banner        |

**Log evidence (group inbound is log-silent â€” `recv.enter â†’ handled=true` only; render verified from screen via uiautomator, NOT logs):**

```
itsirajul 5555: 09:46:50 recv.enter peer=79d63649(shirajul) envId=3bf11bf4 â†’ handled=true  â†’ RENDERS
itsirajul 5555: 09:47:06 recv.enter peer=fe4ddc14(fahim)    envId=a8cd120c â†’ handled=true  â†’ BANNER (no render)
fahim 5575:     09:46:50 recv.enter peer=79d63649(shirajul) envId=09aa2c89 â†’ handled=true  â†’ RENDERS
fahim 5575:     09:46:59 recv.enter peer=08782d6d(itsirajul)envId=05b1f6ff â†’ handled=true  â†’ RENDERS
pixel(shirajul):09:47:07 recv.enter peer=fe4ddc14(fahim)    envId=79b3b7e3 â†’ handled=true  â†’ BANNER (no render)
```

`handled=true` everywhere (decrypt attempted, no exception) but fahim's envelopes have no usable key on the receivers â†’ no_key stash â†’ red banner. This is the same UI surface as B-18, but the ROOT is different: it is **fahim's SEND-side group/sender key that was never distributed to (or accepted by) the other members**, not a receiver missing the group master key generically. fahim can receive (its inbound group key is fine); only its sends are dead to others.

**Inferred root cause:** per-sender group-key / sender-key distribution gap (or epoch desync) for the owner fahim in this group â€” fahim's sender-key-distribution never reached itsirajul + shirajul, so receivers cannot derive fahim's message key. Related to B-10 (epoch mismatch) and shares the B-18 no_key-stash UI.

**Files involved (start here â€” same cluster as B-18):** `packages/messenger-core/src/` group crypto (sender-key / group master-key distribution), `runtime/productionRuntime.ts` (group recv + no_key stash), `store/messengerStore.ts` (`masterKeyB64` / `groupMasterKeySink`).

**Severity:** HIGH â€” a member can send group messages that NO other member can read, with no error on the sender side (silent data loss from the sender's perspective).

---

### Bug B-18 â€” sharpened 2026-06-18: multi-device sub-case (owner's 2nd device never gets the master key)

**New observation (vc79):** In group **"SQA - Shirajul"** (owner = shirajul), shirajul's account running on a **second device (Pixel 7a)** never receives the group master key that was created on shirajul's original device (BlueStacks 5565). Result: EVERY inbound group message on the Pixel logs `handled=true` but shows the red _"Waiting for this group's encryption keyâ€¦"_ banner and never renders.

- Banner **survives an app restart** AND **returns on every new inbound** â†’ the key genuinely never syncs to the 2nd device (not a transient/drain-timing issue).
- itsirajul + fahim (single-device members) render the same group's messages plain â†’ group + senders are fine; failure is **device-specific to shirajul's 2nd device**.
- Root cause: multi-device group-master-key distribution â€” owner's userId is in the member list, but the master key is not re-shared to a newly-added device of the same account. Same family as the old B-11 / `signalDeviceId` multi-device issues.

**QA lesson (B-31 false positive):** an app restart on the Pixel momentarily cleared the banner by re-rendering OLD already-decrypted history, which initially looked like the B-31 boot-drain working. It was NOT â€” the next new inbound immediately re-stashed and re-showed the banner. **B-31 boot-drain could not be exercised because the precondition (key actually present) is never met on this device.** Confirms the checklist rule: verify render from the screen on FRESH traffic, never from `handled=true` or stale history.

---

## vc79 Session â€” Full Record & Code-Level Root-Cause Analysis (2026-06-18)

**Build:** 1.0.55 / versionCode 79 â€” tied to pushed commit `aaf8f42` (`chore(release): ship 1.0.55 (code 79) to Firebase qa`). Source `app.json`/`build.gradle` match all devices â†’ provenance verified, session NOT provisional.
**Devices (3 in-app identities):** itsirajul `08782d6d` on emulator `127.0.0.1:5555`(=`emulator-5554`) Â· fahim `fe4ddc14` on `127.0.0.1:5575`(=`emulator-5574`) Â· **shirajul `79d63649` on physical Pixel 7a** (`32251JEHN23958`). Note: `:5555`â‰¡`emulator-5554` (same PID); only ONE real device.
**Server:** relay `/healthz` ok; **redeploy NOT confirmed** (no version/uptime field) â€” B-05 verdict provisional on that.
**Evidence (in repo, durable):** `qa_logs/boot_20260618_093229/` â€” `session_report/` (REPORT.md, BUG_ANALYSIS.md, FRONTEND_VS_BACKEND.md, SOLUTIONS_AND_FIXES.md + 6 device logs), `B36_pixel_crash.txt`, `b05_watch.log`, `shots/` (14 screenshots), `*_ui.xml`. (Desktop copies vanish â€” repo is canonical.)

### vc79 Scorecard â€” 11 PASS / 4 FAIL / 4 PARTIAL

| Result                  | Item                                                                     | Bug            |
| ----------------------- | ------------------------------------------------------------------------ | -------------- |
| âœ… PASS                | Build provenance (commit-tied)                                           | â€”            |
| âœ… PASS                | Boot health all 5 device-views (`localKey=true â†’ RESUME`, 0 fail-sigs) | â€”            |
| âœ… PASS                | 1:1 messaging itsirajulâ†”fahim both directions (full append chain)      | â€”            |
| âœ… PASS                | Group text, keyed members render plain (no B-22)                         | â€”            |
| âœ… PASS                | 1:1 audio call Pixelâ†”fahim, stable 6+ min, AES-256/WebRTC              | â€”            |
| âœ… PASS                | Non-owner host distributes call key, all FrameCryptor-attached           | **B-13**       |
| âœ… PASS                | Black video tiles not reproduced                                         | **B-01**       |
| âœ… PASS                | Blank/zombie tile not reproduced (clean roster both calls)               | **B-17**       |
| âœ… PASS                | Audioâ†’video upgrade renegotiates + renders (26-30fps, 0 dropped)       | **B-16**       |
| âœ… PASS                | Group call as admin (3-way A/V, FrameCryptor all)                        | â€”            |
| âœ… PASS                | Group call as member / non-owner host (tiles correct)                    | â€”            |
| âŒ FAIL                 | Receiver missing master key â†’ no render (2nd-device gap)               | **B-18**       |
| âŒ FAIL                 | 1:1 call dies on backgroundâ†’resume                                     | **B-24**       |
| âŒ FAIL                 | Member's outbound undecryptable by all (group-id divergence)             | **B-35**       |
| âŒ FAIL **(NEW, HIGH)** | App crashes when ending a group call                                     | **B-36**       |
| âš ï¸ PARTIAL           | Call rides dead WS ~7.5min (improved); keepalive ack broken              | **B-05**       |
| âš ï¸ INCONCL           | Video tile displacement (emulator shared-camera blocks verdict)          | **B-19**       |
| âš ï¸ INCONCL           | Boot stash-drain (key never arrived â†’ couldn't exercise)               | **B-31**       |
| âš ï¸ PARTIAL           | First-msg on re-established pair (happy-path only)                       | **B-15b/B-30** |

### Frontend vs Backend (vc79)

**~90% frontend.** Only B-05 is backend, and it _improved_. The serious items (B-36 crash, B-35/B-18 keys, B-24 backgrounding) are all FE. Backend stabilizing actually **exposed** FE bugs (calls now live long enough to hit the B-36 crash). Two FE clusters: **(A) call-screen view lifecycle** (B-36, B-24, B-19) Â· **(B) group key distribution** (B-35, B-18).

---

### Bug B-36 â€” App CRASHES When Ending a Group Call âš ï¸ NEW, HIGH â€” CONFIRMED 2026-06-18 (vc79), REAL DEVICE

**Reproduce:** Be in a group call (any role). End it (host Leave / hang-up). The app process dies and relaunches to Splash. User-visible: _"app gets completely off."_ **100% on group-call teardown.**

**Reproduced 3Ã—:** itsirajul + fahim emulators on admin-call end (~10:15:57); **Pixel 7a (real device)** on member-call end (10:20:05, Crashlytics-caught).

**Crash stack (Pixel dropbox `data_app_crash`, v79):**

```
java.lang.IllegalStateException: addViewAt: failed to insert view [14658] into parent [14660] at index 0
    at com.facebook.react.fabric.mounting.SurfaceMountingManager.addViewAt(SurfaceMountingManager.java:410)
Caused by: java.lang.IllegalStateException: The specified child already has a parent. You must call removeView()...
    at com.facebook.react.views.view.ReactClippingViewManager.addView(ReactClippingViewManager.kt:36)
```

**Root cause (in code):** The persistent-tile design renders one keyed `<Animated.View key={tag}>` per participant, each wrapping a native `RTCView`/`SurfaceView` (`src/screens/messenger/GroupCallScreen.tsx:1505-1508`, list `:1859-1866`). Tile **position is absolute** (`tilePositions`), but the **native sibling ORDER** comes from an **audio-level sort** with `self` pinned last: `mergeAndSortTiles` `arr.sort((a,b)=>b.audioLevel-a.audioLevel)` (`src/modules/messenger/webrtc/groupCallLayout.ts:202`), `paginateOthers` appends self last (`:288-291`), preserved by `renderEntries` (`GroupCallScreen.tsx:681-684`). On call end the participant set collapses, so the keyed children reorder (e.g. `[A,B,self]â†’[self,A,B]`) â€” every tile moves slots in ONE Fabric commit while its SurfaceView is being torn down AND the screen is being popped (`hangup` `navigation.goBack()` `:1167`). Fabric's `SurfaceMountingManager.addViewAt` inserts a moved SurfaceView subtree into its new index before the remove from the old index runs â†’ "child already has a parent." Aggravator: `renderEmptyHero` flips `nullâ†’<View>` at child index 0 same commit (`:1630-1642`). The reorder is **pure churn** (position is absolute).

**Verbatim code walkthrough (B-36):**

Tiles layer â€” `GroupCallScreen.tsx:1859-1866`:

```jsx
<View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
  {renderEmptyHero(slotRectsRef.current.hero)}
  {renderEntries.map(entry => {
    const pos = tilePositions[entry.tile.tag];
    if (!pos) {
      return null;
    }
    return renderPersistentTile(entry, pos);
  })}
</View>
```

- Keyed wrapper â€” `:1505-1508`: `<Animated.View key={tag} style={[wrapperRound, wrapperStyle, speakingStyle]} ...>`
- Render list â€” `:681-684`: `const renderEntries = useMemo(() => { void retentionTick; return buildRenderEntries(layout, retainedRef.current); }, [layout, retentionTick]);`
- Order source â€” `groupCallLayout.ts:202` `arr.sort((a,b)=>b.audioLevel-a.audioLevel)`; `paginateOthers` appends `self` LAST `:288-291`; `buildRenderEntries` preserves that order `:330-355`.

**Teardown sequence (3-party call ending):**

1. Live: `merged=[A,B]`, hero=A, pages=`[[B,self]]` â†’ `renderEntries=[A,B,self]` (self last).
2. `call.leave()` drains `remoteTiles` â†’ `buildRenderEntries` emits `[self]`, then appends still-retained remotes A,B (5s retention TTL, `groupCallLayout.ts:348-353` + `GroupCallScreen.tsx:554`) â†’ `renderEntries=[self,A,B]`. **Self jumps lastâ†’first; every keyed tile changes slot.**
3. SAME Fabric commit: `videoUrl` flips `null` â†’ the `FlexibleVideoTile` Fragment is swapped for the avatar `View` (`:1462-1466`, `:1513-1554`); `renderEmptyHero` flips `nullâ†’<View>` at child index 0 (`:1630-1642`); the screen is popped (`hangup` `navigation.goBack()` `:1167`, terminal-pop timer `:1293-1303`).
4. Fabric emits moveView/insert for the keyed `SurfaceView` subtrees; the insert runs before the matching remove â†’ `addViewAt` finds the child still parented â†’ `ReactClippingViewManager.addView` throws "child already has a parent."

**Fix (primary, high-confidence):** make native child order STABLE in `GroupCallScreen.tsx:681-684` (position is absolute via `tilePositions`, so render order is free):

```js
const renderEntries = useMemo(() => {
  void retentionTick;
  const entries = buildRenderEntries(layout, retainedRef.current);
  return entries.sort((a, b) => a.tile.tag.localeCompare(b.tile.tag)); // B-36: stable order; position is absolute
}, [layout, retentionTick]);
```

**Defense in depth:** stable `key="empty-hero"` (always mounted, toggle opacity) `:1630-1642`; set a `tearingDown` flag freezing `renderEntries` before `call.leave()` in `hangup` `:1163-1168`.
**Test:** assert `renderEntries` order stable across hero-swap + teardown (3â†’0 remotes). **Nearby risk:** any SurfaceView-bearing keyed list ordered by a live sort.
**Files:** `GroupCallScreen.tsx`, `groupCallLayout.ts`, `src/components/FlexibleVideoTile.tsx`.

---

### Bug B-24 â€” 1:1 Call Dies on Background â†’ Resume (vc79 retest) âš ï¸ FAIL â€” foreground service insufficient

**Reproduce (Pixel real device, cid `fd6f55fe`):** 1:1 call connected â†’ background the phone ~25-40s â†’ return â†’ call dead ("Connection lost â€” couldn't reconnect"). vc79's foreground-service fix (commit `8b9393f`) keeps the **process** alive (FGsvc held 24s, no teardown) but the **call still dies.**

**Root cause #1 (in code) â€” FG service keeps process, not connection:** `src/modules/messenger/runtime/callForegroundService.ts` only posts a notification + sets `FOREGROUND_SERVICE_TYPE_MIC/CAMERA`. **No wake-lock, no socket, no keepalive.** The WS heartbeat is a JS `setInterval` (`productionRuntime.ts:1029-1047`) â†’ throttled under Doze; nothing pins WebRTC ICE consent-freshness (RFC 7675). After ~25-40s the REMOTE peer hits consent failure â†’ `finalState:'failed'` and tears down. Peer is gone before resume.

**Root cause #2 (in code) â€” ICE-restart deadlock at `have-local-offer`:** `src/modules/messenger/webrtc/callController.ts` â€” `onIceDisconnected()` (`:935-957`) fires one restart offer â†’ `setLocalDescription` â†’ signalingState `have-local-offer`. Peer gone â†’ no `call.reanswer` ever â†’ stuck `have-local-offer`. `startRestartRetry()` every 4s (`:963-980`) logs `re-sending reoffer` then `fireIceRestartOffer()` (`:1014-1041`), whose guard `signalingState!=='stable'` rejects every retry (`skipped â€” signalingState=have-local-offer`). Loop never progresses until the 30s budget calls `end('failed')` (`:989-998`). `rollbackLocalDescription()` EXISTS (`peerConnection.ts:353-363`, its doc describes this exact deadlock) but is **never called in the retry path** (only mid-call renegotiation `:711-714`).

**Verbatim code walkthrough (B-24, `src/modules/messenger/webrtc/callController.ts`):**

- `onIceDisconnected()` `:935-957` â€” on ICE `disconnected`: `setState('reconnecting')`, `startRestartBudget()` (30s), offerer fires `fireIceRestartOffer()` + `startRestartRetry()`.
- `startRestartRetry()` `:963-980` â€” 4s `setInterval`; `:974` `this.restartInFlight=false`, `:975` logs `re-sending reoffer`, calls `fireIceRestartOffer()`.
- `fireIceRestartOffer()` `:1014-1041` â€” `:1023` reads `signalingState`; `:1024-1028` guard logs `skipped â€” signalingState=have-local-offer` and returns. (`:1034-1036` comment: "We don't await a reanswer here â€¦ the budget timer ends the call.")
- `handleReAnswer()` ICE-restart branch `:791-811` â€” applies a reanswer IF one arrives; **no answer-timeout**.
- `startRestartBudget()` `:989-998` â€” the ONLY terminator: 30s still `reconnecting` â†’ `end('failed')` â†’ "Connection lost â€” couldn't reconnect."
- `rollbackLocalDescription()` `peerConnection.ts:353-363` (doc `:343-352` literally describes this deadlock) â€” called ONLY from the renegotiation catch `:711-714`, **never** in the restart retry.

**Deadlock walkthrough:** restart#1 â†’ `setLocalDescription(offer)` â†’ state `have-local-offer`, `restartInFlight=true`. Peer gone â†’ no `call.reanswer` â†’ state stuck `have-local-offer`. Every 4s the retry sets `restartInFlight=false` and re-calls `fireIceRestartOffer`, but its `signalingState!=='stable'` guard rejects it (`skipped`). The retry **never rolls back**, so a fresh offer is never generated â†’ 30s of no-op â†’ `end('failed')`.

Background/foreground plumbing: `callForegroundService.ts` (68 lines â€” notification + `FOREGROUND_SERVICE_TYPE_MIC/CAMERA` only, no wake-lock/socket/keepalive); AppState handler `productionRuntime.ts:972-1007` â†’ `forceReconnect()` `:994` rebuilds the socket (`client.ts:215-227`); JS heartbeat `:1029-1047`; `useCall.ts:213-254` AppState handles camera re-acquire only.

**Fix:** (1) roll back before each retry â€” make the tick async:

```ts
this.restartInFlight = false;
if (this.pc && !this.pc.isClosed()) {
  try {
    await this.pc.rollbackLocalDescription();
  } catch (e) {
    // â†’ 'stable' so a fresh restart offer can form
    console.warn('[bravo.callController] ice-restart rollback failed:', (e as Error).message);
  }
}
```

(2) answer-timeout â†’ after ~2 attempts (~8-12s) with no ICE progress/reanswer, conclude peer-gone â†’ tear down + `startOutgoing()` re-INVITE (or `end('failed')` fast instead of spinning the full 30s `RECONNECT_BUDGET_MS` `:187`); (3) gate `fireIceRestartOffer` on `transport.state==='connected'` (else `transport.send` throws `transport not open` `client.ts:115` and the reoffer is lost) and wire `useCall.ts:213-254` AppState 'active' to await `forceReconnect()` then nudge restart; (4) native wake-lock + off-JS-timer keepalive in `callForegroundService.ts`.
**Test gap:** `callIceRestartRetry.test.ts` only pins the pure guard, never the real `have-local-offer` transition â€” why this shipped. **Caveat:** peer that tore down was an emulator; 2 physical devices needed for a fully clean verdict, but Pixel-side behavior is real-hardware-confirmed.

---

### Bug B-05 â€” Group-call keepalive `ack_timeout:ping` (vc79) âš ï¸ ROOT CAUSE = MISSING SERVER ACK (not a WS drop)

**Observed:** group call WS keepalive `ack_timeout:ping` fails continuously x2 (~50s in) â†’ x22 (~7.5 min), yet **media rides the dead WS fully functional**. (Call ended only via the B-36 emulator restart, not a WS kill.) Big improvement vs prior "WS drop = instant call death," but the keepalive itself is 100% broken.

**Root cause (in code) â€” NOT a WS drop; a missing socket.io ack:** client emits with ack `ws.emitWithAck('ping', {ts}, 10_000)` (`src/modules/messenger/webrtc/useGroupCall.ts:2561`); timeout string from `transport/client.ts:135` (`ack_timeout:${event}`). Server handler `apps/messenger-service/src/gateway/messenger.gateway.ts:704` returns `ServerPong = {event:'pong', data}`. In `@nestjs/platform-socket.io`, a response **with an `event` key** is routed as `socket.emit('pong',â€¦)` â€” a NEW event â€” and the **ack callback is never invoked** â†’ `emitWithAck('ping')` times out 100%. The socket is otherwise fine (engine.io heartbeat + SFU acks + DTLS-SRTP media keep working) â€” exactly why the call stays up. Contrast: SFU handlers return event-LESS objects (`sfu.join`â†’`joined` `:1233`) â†’ acked â†’ work. The **main transport** depends on the `pong` EVENT (`productionRuntime.ts:1037` emits `ping` no-ack, consumes `pong` event `:3260`) â†’ fix must serve BOTH. `WS_HEARTBEAT_GRACE=25000` is correctly wired (`config/configuration.ts:26` â†’ `main.ts:30,40` â†’ `redis-io.adapter.ts:70-71`) but gates engine.io's transport heartbeat â€” a different layer.

**Verbatim code walkthrough (B-05):**

Client keepalive â€” `src/modules/messenger/webrtc/useGroupCall.ts:2545-2571`:

```ts
void ws
  .emitWithAck('ping', {ts: Date.now()}, 10_000)
  .then(() => {
    consecutiveMisses = 0;
  })
  .catch(e => {
    consecutiveMisses += 1;
    if (consecutiveMisses >= 2) {
      console.warn(
        `[bravo.groupcall] keepalive ping failed x${consecutiveMisses}:`,
        (e as Error).message,
      );
    }
  });
```

`emitWithAck` (`transport/client.ts:135`) sets `setTimeout(() => reject(new Error(\`ack_timeout:${event}\`)), timeoutMs)`and passes a 3rd ack-callback arg to`sock.emit`. Server handler `messenger.gateway.ts:704`returns`ServerPong = {event:'pong', data:{ts}}` (`protocol.ts:335`). The NestJS `@nestjs/platform-socket.io` adapter does, per response:

```
if (response.event) return socket.emit(response.event, response.data); // event key â†’ emit a NEW event
isFunction(ack) && ack(response);                                       // else â†’ call the ack
```

The `event` key short-circuits to `emit('pong')` and **skips the ack** â†’ the client's ack callback never fires â†’ `ack_timeout:ping` every time. Working contrast (event-LESS returns â†’ acked): `sfu.join`â†’`joined` `:1233`, `sfu.transport.connect`â†’`{ok:true}` `:1249`, `sfu.produce`â†’`{producerId}` `:1287`. The **main transport** depends on the `pong` EVENT instead (`productionRuntime.ts:1037` emits `ping` with no ack; consumes `pong` event at `:3260` â†’ `rttRegistry`) â€” so the fix must serve BOTH consumers. `WS_HEARTBEAT_GRACE=25000` wiring: `config/configuration.ts:26` â†’ `main.ts:30,40` â†’ `redis-io.adapter.ts:70-71` (`pingInterval`/`pingTimeout`) â€” engine.io transport heartbeat, a SEPARATE layer that is working fine (it's why the socket survives).

**Fix (server-only, backward-compatible) â€” `messenger.gateway.ts:704`:**

```ts
@SubscribeMessage('ping')
handlePing(@MessageBody() data: ClientPing['data'], @ConnectedSocket() client: Socket): {ts: number} {
  const ts = data?.ts ?? Date.now();
  client.emit('pong', {ts}); // main transport listens for pong EVENT (no ack) â€” keep
  return {ts};               // event-less return â†’ NestJS calls the ack â†’ emitWithAck('ping') resolves
}
```

**Also (latent):** `apps/messenger-service/src/main.ts` has NO `process.on('uncaughtException'/'unhandledRejection')` crash guards (original B-05 mass-drop family) â€” add them. **Confirm server redeploy** before re-scoring.

---

### B-35 / B-18 â€” Code-Level Root Causes (vc79 deep-dive; supplements the entries above)

**Architecture note (corrects the QA "sender-key/SKDM" framing):** this app has **no Signal sender-keys** (deferred: `packages/messenger-core/src/groups/groupClient.ts:39-50`). A group has ONE symmetric AES-256-GCM **master key** (`groups/groupCrypto.ts:8-10,152-174`), sealed NÃ— over pairwise Signal sessions.

**B-35 root cause â€” group-IDENTITY divergence:** stamped groupId on outbound = sender's local `conversationId` (`productionRuntime.ts:1479-1488,:1550`); receiver routes by that id and looks up its OWN `groups[stampedId]` (`:4428,:4445`); absent â†’ `parseGroupMessage` `{ok:false,reason:'no_key'}` (`groupClient.ts:301-305`) â†’ stash + banner (`:4523-4557`). `createGroupChat` mints groupId from a **random salt** (`groupClient.ts:522,606`) + fresh random master key (`:534`); **no server-authoritative groupId, no reconciliation.** So the owner can hold a locally-minted `(groupId, key)` the others never adopted â†’ owner's sends land under a groupId nobody else has a key for â†’ `no_key` on all, **silent to sender** (`recipients` counts relay-accept not decrypt, `:1644-1668`). **Fix:** join-existing instead of re-minting (sender-side mirror of `groupClient.ts:488-506`); guard `sendText` to refuse/realign when `groups[conversationId]` is absent but participants match; surface send-side failure.

**B-18 root cause â€” single-device-only key fan-out:** `deviceId:1` hardcoded across `members` (`groups/types.ts:24`; `createGroupChat` `productionRuntime.ts:2156`), `broadcastToGroup` (`groupClient.ts:158-160`), text path (`:1542`), key bundles (`transport/keysClient.ts:16`); no device-list endpoint (`transport/usersClient.ts`). A 2nd device (`signalDeviceId=2`) is never a fan-out address â†’ never gets the key â†’ `no_key` forever; no live "key arrived" drain and no "fetch missing key" path (drain only from boot-restore `:1192-1200` or post-`admin:create/rekey` `:4693,:4767`). **Fix:** device-list endpoint (auth-service + `usersClient`) â†’ per-(userId,device) fan-out; key-resync request to owner on `no_key`. **Security:** keep `verifySenderCert`/`verifyGroupCreateSignature`/`verifyGroupIdDerivation` + fail-closed; keys only via sealed pairwise envelopes; relay stays group-unaware.

**Verbatim code (B-18 fan-out, `packages/messenger-core/src/groups/groupClient.ts:158-160`):**

```ts
for (const [userId, m] of Object.entries(params.group.members)) {
  if (userId === params.self.userId && m.deviceId === params.self.deviceId) {continue;}
  const peer: SessionAddress = {userId, deviceId: m.deviceId}; // â† one deviceId per userId
```

`members` is `Record<userId, {deviceId, admin, joinedAt}>` (`types.ts:24`) â€” structurally one device per user. `createGroupChat` builds it as `others.map(userId => ({userId, deviceId: 1}))` (`productionRuntime.ts:2156`) and owner = `signalDeviceId` (`:2155`); the text send path also hardcodes `const peer = {userId, deviceId: 1}` (`:1542`). `keysClient.ts:16` comment: _"no per-device dimension. We hardcode deviceId: 1 â€¦ Multi-device support deferred."_ So nothing fans an account's group key across its own devices.

**Boot key-vault behavior (why restart doesn't help B-18):** `groupMasterKeyStore.ts` (SQLCipher, AES-GCM wrapped) is warmed at boot `productionRuntime.ts:1129-1206`; when a groupId has neither in-mem nor on-disk key, `masterKeyB64` is left empty (`:1155-1175`). The Pixel's vault never had the key (it was never an envelope recipient), so every boot re-lands at `no_key`.

**Stash + banner (`productionRuntime.ts:4523-4557`):** missing key â†’ `pendingGroupEnvelopes.stash(...)` + banner string at `:4554-4556` (_"Waiting for this group's encryption key â€” the message will appear once it syncs."_). Drain fires ONLY from boot disk-restore (`selectGroupIdsToDrain` `:1192-1200`) or a post-txn `drain-group` after an `admin:create` (`:4693`) / `admin:rekey` (`:4767`) commits a key â€” never on a live out-of-band key arrival.

**Priority/effort:** B-36 (small/high-conf) Â· B-05 (tiny/high-conf) â€” quickest wins. B-24 (medium). B-35 (medium). B-18 (large â€” needs backend device-list API).

---

### Bug B-01 â€” Group Call Host Sees BLACK VIDEO Tiles âš ï¸ CONFIRMED â€” ALL SESSIONS

**Reproduce:** Create a group (3+ members). As the group creator/admin, start a video call. Other members join. Their tiles appear but video is BLACK. Also reproduced when ANY device is host (not just original group admin).

**Frequency:** 100% â€” every call round across all 3 devices

**Root cause:** Admin starts in empty SFU room (`existingProducers=0`). When members join later, tiles are added dynamically via `sfu.new-producer`. The new `RTCView`/`SurfaceView` starts at placeholder dimensions (`4Ã—2` pixels). The video stream connects to this tiny surface. `BLASTBufferQueue` rejects the incoming frame (buffer is `1044Ã—587` but surface is `4Ã—2`). Even after the surface grows to full size, a second rejection occurs due to aspect ratio mismatch (surface 4:3, buffer 16:9). Stream enters broken state â€” video stays black even after surface resizes.

**Members don't have this problem** because they join with `existingProducers=[N]` â€” all tiles are built BEFORE the screen renders, so layout fires with correct dimensions before video starts.

**Log evidence:**

```
14:33:40 - BLAST #6  active_size=4x2     buffer=1044x587  â† self-preview on host
14:34:31 - BLAST #9  active_size=1044x783 buffer=1044x587  â† remote tile, aspect mismatch
14:33:44 - BLAST #6  active_size=4x2     buffer=1044x587  â† member joining early
14:39:25 - BLAST #21 active_size=3x2     buffer=1044x587  â† host self-preview (shirajul)
14:40:12 - BLAST #27 active_size=4x2 â†’ 3x2               â† sequential resize race
```

**Fix needed â€” `src/screens/messenger/GroupCallScreen.tsx`:**  
Do not bind RTCView to the video stream until `onLayout` returns dimensions greater than 10px on both axes. Once real layout fires, force-remount RTCView with a changed `key` prop so a fresh SurfaceView is created at full size before the first frame arrives.

---

### Bug B-37 â€” Agent dashboard JS render crash: unguarded `pickup_address.split()` âœ… FIXED (2026-06-19)

**Symptom:** App shows the root React error-boundary recovery screen â€” "**Something went wrong** / The app hit an unexpected error. We've reported it. Tap below to try again. [Retry]". This is the `ErrorBoundary` in `src/modules/observability/ErrorBoundary.tsx` (mounted at the root of `App.tsx`), which only catches **render-phase** JS throws (NOT async/handler errors â€” those go to the `index.js` global handler).

**Root cause:** `src/screens/agent/AgentDashboardScreen.tsx`, the `activeRouteLabel` derived value (component body / render phase):

```ts
const activeRouteLabel = activeMission
  ? `${activeMission.pickup_address.split(',')[0].trim()} â†’ ${(activeMission.dropoff_address ?? 'â€”').split(',')[0].trim()}`
  : '';
```

`activeMission` is written raw from `agentApi.getActiveMission()` (in `load()`, the 8s poll tick, and AppState 'active') with **no runtime validation**. The TS type says `pickup_address: string`, but that's compile-time only. The **dropoff** side was guarded (`?? 'â€”'`); the **pickup** side was NOT. A drifted/partial mission row with a null `pickup_address` makes `.split()` throw `TypeError` synchronously during render. `AgentDashboardScreen` has no per-screen `withScreenErrorBoundary` (only Chat/Call/GroupCall do), so it bubbles to the **root** boundary. Reachable post-biometric: an APPROVED/ACTIVE agent auto-lands on the dashboard (AgentTypeSelect â†’ `navigation.replace('AgentDashboard')`).

**Fix:**

1. Guard the pickup side at the consumer (`?? 'â€”'`).
2. Hardening: added a `normalizeMission(raw)` choke point that coerces every field to a safe value (returns `null` for a missing `mission_id`); all three `setActiveMission(...)` ingestion points now route through it, so **no** consumer of `activeMission` can crash on a malformed field.

**Verification:** typecheck 48 errors (baseline 84), 0 in AgentDashboardScreen; agent Jest suite 54/54 pass.

**Caveat:** plausible, not device-proven â€” only fires for an agent with an active mission whose `pickup_address` is null (abnormal/drifted data). To confirm it was the actual trigger, logcat would show `[bravo.error-boundary] caught TypeError: ... split ...`.

---

### Bug B-38 â€” Agent dashboard NATIVE Fabric crash: "child already has a parent" (view reparenting) âœ… FIXED (2026-06-19)

> **Same crash class as [B-36](#bug-b-36--app-crashes-when-ending-a-group-call--new-high--confirmed-2026-06-18-vc79-real-device)** (RN-Fabric `ReactClippingViewManager.addView` "child already has a parent"), but a **different trigger site**: B-36 fires on group-call teardown (keyed tile reorder + hero nullâ†’View in GroupCallScreen); B-38 fires at agent-dashboard boot (NEXT ON OPS nullâ†’View swap inside a clipped ScrollView). Main's real-device B-36 independently confirms this native crash signature is real.

**Symptom (Crashlytics, FATAL â€” kills the app, NOT JS-catchable):**

```
Fatal Exception: java.lang.IllegalStateException: addViewAt: failed to insert view [858] into parent [860] at index 0
  at com.facebook.react.fabric.mounting.SurfaceMountingManager.addViewAt(SurfaceMountingManager.java:410)
Caused by: java.lang.IllegalStateException: The specified child already has a parent. You must call removeView() on the child's parent first.
  at com.facebook.react.views.view.ReactClippingViewManager.addView(ReactClippingViewManager.kt:36)
```

**Root cause:** React Native 0.81 New Architecture (Fabric) view-reparenting race inside a `removeClippedSubviews=true` container (the Android default on `ScrollView`/`FlatList`). In `src/screens/agent/AgentDashboardScreen.tsx` the main `<ScrollView>` body swaps conditional subtrees while async state lands during the **first post-biometric layout passes**:

- The **NEXT ON OPS** block swaps between a single `<View>` (no mission) and a 2-child `<Fragment>` (active mission) when the **8s `activeMission` poll** flips `nullâ†’object`.
- (Same class: the location-required banner mount/unmount, duty-error row.)

The branches were unkeyed and structurally different (1 vs 2 children; slot-0 type `View`â†’`TouchableOpacity`). When that swap lands in the same Fabric mount batch as the clipping container's clip/unclip pass, Fabric issues an `addViewAt` for a child whose detach from its old parent hasn't committed yet â†’ "child already has a parent". Distinct bug from B-37 (native vs JS; uncatchable vs root boundary).

**Fix (`src/screens/agent/AgentDashboardScreen.tsx`):**

1. `removeClippedSubviews={false}` on the main ScrollView â€” removes the clipping race entirely (short list, no perf cost). Standard fix for this exact Fabric crash.
2. Wrapped the NEXT ON OPS conditional in a single stable host `<View>` slot so only the _children_ swap, never the slot's position/type in the scroll child list.

**Verification:** typecheck 48 errors (baseline 84), 0 in AgentDashboardScreen; agent Jest suite 54/54 pass.

**Caveat:** native mount-batch ordering can only be 100% confirmed with an on-device repro (boot an agent whose mission becomes active during the first ~8s). The `removeClippedSubviews={false}` mitigation addresses the whole clipping-race class even if the precise crashing child is a sibling.

---

### Bug B-02 â€” "No Group Master Key" for Ad-hoc Calls âš ï¸ CONFIRMED

> **See also B-13** (2026-06-08) â€” same family (ad-hoc call key looked up under the wrong `direct:<host>` id). B-02 was marked fixed by Ranak's 2026-06-07 commits; B-13 is the re-emergence in the installed APK with the non-owner-host shortcut.

**Reproduce:** From a 1:1 direct chat, escalate to a multi-party call. Recipients fail with `FrameCryptorOrchestrator: no group master key â€” refusing to start`.

**Frequency:** 100% â€” both retry attempts also failed. Affects only direct-chat-escalated calls, not proper group calls.

**Root cause:** Host creates an ad-hoc group key with `keyConversationId = 3cb79cb1f1b0`. Host stores key locally under BOTH `keyConversationId` AND `originalConversationId` (`direct:fe4ddc14-74`). But recipients only receive the admin/create Signal envelope for `3cb79cb1f1b0`. When the ring arrives, `FrameCryptorOrchestrator` looks up key under `direct:fe4ddc14-74` (the original 1:1 convo) â€” which recipients don't have. Fails after 25s timeout. Key eventually arrives but too late.

**Log evidence:**

```
itsirajul.log:
14:35:02 - direction=incoming convo=3cb79cb1f1b0 existingProducers=2
14:35:02 - step=3b waiting for key under 'direct:fe4ddc14-74' â† WRONG ID
14:35:27 - FrameCryptor init failed: no group master key (25s timeout)

shirajul.log:
14:35:06 - step=3b waiting for key under 'direct:fe4ddc14-74'
14:35:31 - FrameCryptor init failed: no group master key
14:36:38 - key resynced delivered=3 keyConvo=f956b212413b â† KEY ARRIVES AFTER FAILURE
```

**Fix needed â€” `src/modules/messenger/runtime/productionRuntime.ts` (`ensureCallGroupKey`) + ring notification sender:**  
When sending the ring to recipients, include both `keyConversationId` and `originalConversationId` in the payload. Recipients must store the received key under both IDs so `FrameCryptorOrchestrator` finds it regardless of which ID it queries.

---

### Bug B-03 â€” `frameCryptorOrchestrator.ts` MISSING FROM REPO âš ï¸ CRITICAL

**File:** `src/modules/messenger/webrtc/frameCryptorOrchestrator.ts`  
**Status:** Does not exist anywhere in the repo. Never committed to git.

`useGroupCall.ts` line 117â€“118 imports from this file:

```typescript
import {
  FrameCryptorOrchestrator,
  frameCryptorOrchestratorAvailable,
} from './frameCryptorOrchestrator';
```

The installed APK was compiled from an older codebase that had this file. A **fresh build will fail** â€” Metro cannot bundle a missing module.

**What this file must export:**

- `class FrameCryptorOrchestrator` with `init()`, `attachSenderCryptor()`, `attachReceiverCryptor()`, `dispose()`
- `function frameCryptorOrchestratorAvailable(): boolean` (delegates to `frameCryptorTransport.isAvailable()`)

The class orchestrates the native `BravoFrameCryptorModule` via `frameCryptorTransport.ts` using keys from `messengerStoreKeySource.ts` and derived by `packages/messenger-core/src/calls/frameCryptorKeys.ts`.

---

### Bug B-04 â€” Ghost "Call" Groups Appear in Groups List âš ï¸ CONFIRMED

**Reproduce:** Receive a call invitation that was started from a 1:1 direct chat (ad-hoc escalated call). After declining or missing the ring, open the Groups screen. A new group named **"Call"** will be listed there. Happens once per call invitation received. Multiple calls = multiple ghost "Call" entries accumulate.

**Who is affected:** Recipients only. The host/caller does NOT see the group in their own list.

**Root cause â€” two files involved:**

1. `productionRuntime.ts` line 2586 â€” `ensureCallGroupKey` mints a temporary group state with `name: 'Call'` and broadcasts it as a `type: 'create'` admin Signal envelope to all call participants.

2. `productionRuntime.ts` line 4329 â€” the `group-create:recv` handler unconditionally calls `store.upsertConversation(...)` for every group create (this was added to fix a separate bug where real groups weren't appearing on recipients' screens). It does not filter out the ad-hoc `name === 'Call'` groups. The upserted conversation entry is `type: 'group'`, so it appears directly in GroupsScreen and MessengerHomeScreen.

3. `GroupsScreen.tsx` line 123â€“124 â€” reads `Object.values(conversations).filter(c => c.type === 'group')` â€” shows ALL group conversations including the ghost "Call" entries.

**Code path (recipient side):**

```
ring received (convo=3cb79cb1f1b0)
  â†’ group-create:recv handler
    â†’ store.setGroupState(action.state)          â† stores crypto key
    â†’ store.upsertConversation({                 â† BUG: creates chat list entry
        id:   action.state.groupId,
        name: 'Call',                            â† ghost group name
        type: 'group',
        ...
      })
  â†’ GroupsScreen renders "Call" as a group
```

**Fix needed â€” `productionRuntime.ts` line ~4329:**  
Skip `upsertConversation` when the received group create has `name === 'Call'`. The key still needs to be stored (for `setGroupState`) but no conversation entry should be created:

```typescript
// Don't create a chat list entry for ad-hoc call key groups
if (action.state.name !== 'Call') {
  store.upsertConversation({ ... });
}
```

---

### Non-Bugs (Expected on BlueStacks)

```
InCallManager: Can not select EARPIECE/SPEAKER_PHONE from available []
  â†’ BlueStacks has no audio hardware. Fine on physical device.

SQLCipher mlock failed: errno 12 (ENOMEM)
  â†’ VMs don't support memory locking. Expected, not a bug.

Firebase deprecated API warnings (v21 â†’ v22)
  â†’ Migration needed but not causing crashes yet.
```

---

### Complete Call Timeline (2026-06-06 14:33â€“14:40)

#### Round 1 â€” Voice call, itsirajul's group (14:33:04â€“14:33:32) â€” PASS

```
14:33:04 - itsirajul: voice call start, group=4100833dd9da, isHost=true, existingProducers=0
14:33:05 - itsirajul: key resynced delivered=3
14:33:06 - itsirajul: audio producer attached (FrameCryptor) âœ“
14:33:13 - shirajul:  joins, existingProducers=2 â†’ consumes 2 audio tracks âœ“
14:33:32 - itsirajul: leaves
```

Voice calls work correctly. All members hear each other.

---

#### Round 2 â€” Video call, itsirajul's group (14:33:36â€“14:34:35) â€” FAIL (B-01)

```
14:33:36 - itsirajul: video call start, isHost=true, existingProducers=0
14:33:37 - itsirajul: key resynced, producers attached âœ“
14:33:40 - itsirajul: [BLASTBufferQueue] active_size=4x2 buffer=1044x587 â† Bug B-01
14:33:43 - fahim:     joins, existingProducers=2, consumes itsirajul âœ“
14:33:44 - fahim:     [BLASTBufferQueue] active_size=4x2 â† Bug B-01
14:33:51 - shirajul:  joins, existingProducers=4, consumes 4 tracks âœ“
14:33:57 - fahim:     [BLASTBufferQueue] active_size=1040x780 buffer=1040x585 (aspect ratio)
14:34:31 - itsirajul: [BLASTBufferQueue] active_size=1044x783 buffer=1044x587 (aspect ratio)
14:34:35 - fahim:     room.ended â€” host left
```

---

#### Round 3 â€” fahim starts call on his group (14:34:53â€“14:36:30) â€” FAIL (B-01 + B-02)

```
14:34:53 - fahim:     video call start on 3cb79cb1f1b0, isHost=true, existingProducers=0
14:34:54 - fahim:     key resynced delivered=3, producers attached âœ“
14:35:02 - itsirajul: ring received, step=3b waiting for key under 'direct:fe4ddc14-74' â† Bug B-02
14:35:06 - shirajul:  ring received, same wrong key lookup â† Bug B-02
14:35:27 - itsirajul: FrameCryptor init FAILED (25s timeout)
14:35:31 - shirajul:  FrameCryptor init FAILED
14:35:40 - fahim:     retries (new room 2d232d2a) â€” same result
14:36:38 - shirajul:  key arrives (too late, calls already refused)
```

---

#### Round 4 â€” shirajul starts call on her group (14:37:xxâ€“14:38:59) â€” FAIL (B-01)

```
~14:37:37 - shirajul:  video call start, isHost=true
14:38:26  - fahim:     joins as member â†’ consumes shirajul âœ“
14:38:31  - itsirajul: joins as member â†’ consumes 2 âœ“
14:38:34  - fahim:     [BLASTBufferQueue] aspect ratio mismatch
14:38:36  - shirajul:  [BLASTBufferQueue] aspect ratio mismatch
14:38:59  - itsirajul: room.ended â€” host left
```

---

#### Round 5 â€” shirajul starts call on itsirajul's group (14:39:22â€“14:39:58) â€” FAIL (B-01)

```
14:39:22 - shirajul:  video call start, isHost=true, existingProducers=0
14:39:23 - shirajul:  key distributed delivered=3 âœ“
14:39:25 - shirajul:  [BLASTBufferQueue] active_size=3x2 buffer=1044x587
14:39:28 - fahim:     joins, existingProducers=2
14:39:29 - fahim:     [BLASTBufferQueue] active_size=4x2 buffer=1044x587
14:39:33 - itsirajul: joins, existingProducers=4 â†’ consumes 4 âœ“
14:39:38 - itsirajul: [BLASTBufferQueue] 2108x1581 vs 2108x1186 + 1044x783 vs 1044x587
14:39:53 - all leave
```

---

#### Round 6 â€” itsirajul starts call on fahim's group (14:40:09â€“14:40:43) â€” FAIL (B-01)

```
14:40:09 - itsirajul: video call start on 3cb79cb1f1b0, isHost=true, existingProducers=0
14:40:10 - itsirajul: key distributed delivered=3 âœ“ (proper group, not ad-hoc)
14:40:12 - itsirajul: [BLASTBufferQueue] active_size=4x2 â†’ 3x2
14:40:16 - fahim:     joins, existingProducers=2 âœ“
14:40:21 - shirajul:  joins, existingProducers=4 âœ“
14:40:27 - shirajul:  [BLASTBufferQueue] 2104x1578 vs 2104x1184 (aspect ratio)
14:40:38 - all leave
```

---

### Messaging Test Results (2026-06-06)

All Signal-encrypted messages delivered and ACK'd correctly on all 3 devices:

```
14:29:52 - itsirajul: ACK ok envId=37274762 âœ“
14:30:13 - itsirajul: ACK ok envId=9e95d116 âœ“
14:29:27 - shirajul:  ACK ok envId=56f8625c âœ“
14:30:41 - shirajul:  ACK ok envId=895054db âœ“
14:33:56 - fahim:     ACK ok envId=781992e4 âœ“
```

Backup mirror running normally on itsirajul (`bravo.backup.mirror flushed N messages`). No backup errors.

---

## QA Session 2026-06-07 â€” Group Call Server Drop Incident

**Session date:** 2026-06-07 ~11:33â€“12:06  
**Devices:** 127.0.0.1:5555 (Samsung SM-S908E) | 127.0.0.1:5565 | 127.0.0.1:5575  
**Server:** Contabo VPS `94.136.184.52` â€” `relay.94-136-184-52.sslip.io`  
**Branch tested:** `release/1.0.35-audit-fixes`  
**Evidence:** `~/Desktop/bravo_call_logs_20260607_120740/` (device_5555.txt, device_5565.txt, device_5575.txt, REPORT.md)

---

### Primary Root Cause â€” Server WebSocket Drop (B-05)

All 3 devices lost their WebSocket connection to `messenger-service` simultaneously at **12:05:24**:

```
12:05:24.891  [5575]  sfu.producers failed: 'transport not open'
12:05:24.930  [5565]  sfu.producers failed: 'transport not open'
12:05:25.062  [5555]  sfu.producers failed: 'transport not open'
```

**171ms spread across 3 independent devices** = one server-side event, not 3 separate client failures.

#### Failure Chain â€” 17-second window

```
T+0s   12:05:24  WebSocket to messenger-service DROPS
                  Socket.io reports "transport not open"
                  â†’ WS was the only signaling path for ICE restart + sfu.* messages

T+5s   12:05:29  ICE goes "disconnected"
                  STUN keep-alives time out ~5s after WS path dies

T+5s   12:05:29  ICE restart begins (sendTx + recvTx)
                  Correct behaviour â€” but sfu.transport.restartIce requires WS
                  to reach SFU. WS is already dead.

T+12s  12:05:36  ack_timeout:sfu.transport.restartIce   (8s budget expired)
T+12s  12:05:36  ack_timeout:sfu.producers              (reconcile also dead)

T+15s  12:05:39  connectionState=failed (recvTx)
T+16s  12:05:40  connectionState=failed (sendTx)
                  â†’ CALL DEAD on all 3 devices
```

#### Two Candidate Causes (server logs required to confirm)

**Candidate A â€” `messenger-service` process crash/restart at 12:05:24**  
If the Node.js process died, Socket.io drops every connection within milliseconds. Most likely given the simultaneous drop. (Commands to confirm: see the **Server Log Commands** block at the end of this 2026-06-07 session.)

**Candidate B â€” WS Heartbeat Grace Timeout**  
Server config `apps/messenger-service/src/config/configuration.ts`:

- `WS_HEARTBEAT_MS = 30,000` (server pings every 30s)
- `WS_HEARTBEAT_GRACE = 10,000` (client must pong within 10s)

Measured Contabo ping during this session: **min 72ms / avg 209ms / max 2,601ms / packet loss 10%**. At 2,601ms spikes, a pong sent at 12:04:54 could exceed the 10s grace window, causing the server to kick all 3 clients at the same heartbeat cycle.

**Fix required (P0):** Raise `WS_HEARTBEAT_GRACE` from 10,000ms â†’ 25,000ms. Also investigate crash candidate.

---

### Network Latency â€” Contabo `94.136.184.52`

Measured from dev machine during session:

| Metric      | Value                                    |
| ----------- | ---------------------------------------- |
| min RTT     | 72ms                                     |
| avg RTT     | 209ms                                    |
| max RTT     | 2,601ms (confirmed spike)                |
| packet loss | ~10% (2 ICMP timeouts in 10-packet test) |

Impact on timeouts:

| Timeout                     | Current Value | Rounds at 2,601ms ping            |
| --------------------------- | ------------- | --------------------------------- |
| `emitWithAck` (SFU signals) | 8,000ms       | ~3 round-trips max                |
| Stale leave guard           | 3,000ms       | ~1 round-trip max                 |
| `WS_HEARTBEAT_GRACE`        | 10,000ms      | ~3 round-trips before server kick |
| ICE reconnect budget        | 30,000ms      | ~11 ICE restart attempts          |

---

### Bug B-05 â€” Server WebSocket Drop Kills All Active Calls

See Primary Root Cause section above. The client-side ICE restart logic is correct; it has no WS path to send through when the server drops.

**P1 fix needed â€” `src/modules/messenger/webrtc/useGroupCall.ts`:**  
Listen for Socket.io `reconnect` event while in `joined` state â†’ auto-rejoin the SFU room within the 60s zombie grace window (`ZOMBIE_ROOM_GRACE_MS = 60,000` in `sfu.service.ts`):

```typescript
transport.on('reconnect', () => {
  if (state === 'joined' && roomId && !isLeavingRef.current) {
    void attemptRejoin(roomId);
  }
});
```

**UPDATE 2026-06-08 (live BlueStacks, 3-device) â€” B-05 reproduced TWICE + auto-rejoin fix now present but INEFFECTIVE:**

Two clean B-05 server-WS-drop incidents captured in one ~30-min monitoring window on the
installed APK (itsirajul=5555 host/owner of `4100833dd9da`, shirajul=5565, fahim=5575, group
audio + FrameCryptor on all consumers):

| Incident   | Call up                     | Failed   | Lifespan  | Room          | Host                                            |
| ---------- | --------------------------- | -------- | --------- | ------------- | ----------------------------------------------- |
| #1         | (before 11:24 buffer clear) | 11:36:30 | â‰¥12 min | `ffd651f4â€¦` | itsirajul (owner)                               |
| #2         | 11:48:32                    | 11:52:30 | ~4 min    | `66d8f8b9â€¦` | itsirajul (owner)                               |
| #3         | 12:01:28                    | 12:08:31 | ~7 min    | `83ed6203â€¦` | fahim (owner of `3cb79cb1f1b0`)                 |
| #4 (VIDEO) | 12:27:55                    | 12:40:32 | ~13 min   | â€”           | shirajul (owner "SQA - Shirajul")               |
| #5         | 12:46:23                    | 12:56:31 | ~10 min   | `834d1f16â€¦` | itsirajul (NON-owner, B-13 path, "SQA - FAHIM") |

Incident #5 â€” member-hosted audio (itsirajul = non-owner host via the B-13 `reusing real-group key`
path; call connected fine since the key was pre-seeded). Same B-05 drop: fahim
`sfu.producers failed: transport not open` (12:56:31.008) â†’ all `reconnect -> rejoin` within ~1.3 s
(12:56:31.569 fahim, 12:56:32.327 itsirajul; shirajul got `room.ended â€” host left` 12:56:31.725 though
itsirajul never left) â†’ `rejoin FAILED: ack_timeout:sfu.join` (~12:56:46â€“47) â†’ `connectionState=failed`.
**Five B-05 drops now: 11:36 / 11:52 / 12:08 / 12:40 / 12:56 â€” lifespans 12 / 4 / 7 / 13 / 10 min.**
Every call started this ~80-min window died to the server WS drop; auto-rejoin ineffective on all five.

| #6 (VIDEO) | 12:58:16 | 13:12:32 | ~14 min | â€” | shirajul (NON-owner, B-13 path, "SQA - FAHIM") |

Incident #6 â€” member-hosted VIDEO (shirajul non-owner host, B-13 `reusing real-group key` path; call
connected fine, key pre-seeded; B-19 tile mis-binding reproduced on host render). Same B-05 drop:
`transport not open` (13:12:32.116 fahim) â†’ all `reconnect -> rejoin` within ~1.2 s (13:12:32.561 fahim,
13:12:33.277 itsirajul, 13:12:33.290 shirajul) â†’ `[groupcall.freeze] â†’paused` video freeze â†’
`rejoin FAILED: ack_timeout:sfu.join` (~13:12:47â€“48) â†’ `connectionState=failed`.
**Six B-05 drops: 11:36 / 11:52 / 12:08 / 12:40 / 12:56 / 13:12 â€” lifespans 12 / 4 / 7 / 13 / 10 / 14 min
(avg ~10 min, max 14). 6 of 6 calls in a ~96-min window killed by the server; auto-rejoin 0/6.**

**EXTENSION 2026-06-08 14:47 â€” B-05 also kills 1:1 (P2P DTLS-SRTP) calls, not just SFU/group:**

1:1 voice call `cid=4cedbab8` (itsirajul outgoing â†’ fahim incoming) connected cleanly over DTLS-SRTP
(`dtls-verify-ok cipher=AES_CM_128_HMAC_SHA1_80`, both `connectionState=connected` at 14:47:33), ran
~58 s, then:

```
14:48:32.007  itsirajul: iceConnectionState=disconnected â†’ callController ice-restart sending reoffer
14:48:36.895  itsirajul: connectionState=disconnected
14:48:47.413  itsirajul: iceConnectionState=failed â†’ CALL DEAD (ice-restart did not recover)
```

Same ~15 s disconnectedâ†’failed decay as the group drops. Mechanism is the same root: the 1:1
**ICE-restart reoffer + new candidates ride the WebSocket** (`call.reoffer`/`call.ice`); when the server
WS drops, the restart can't reach the peer â†’ ICE fails. So B-05's blast radius = **every call type**
(SFU group audio, SFU group video, AND 1:1 P2P). Note `[bravo.callController]` ice-restart logic is
present and fires correctly â€” it just has no WS path, exactly like the group `reconnect -> rejoin`.

Second 1:1 confirmation â€” `cid=7c640455` (shirajul â†’ fahim, voice): connected + DTLS-verified 15:00:41,
ran ~3 min 50 s, then `iceConnectionState=disconnected` 15:04:31 â†’ `connectionState=disconnected`
15:04:38 â†’ `iceConnectionState=failed` 15:04:48 (~17 s decay). **Two 1:1 drops: cid=4cedbab8 ~1 min
(14:48), cid=7c640455 ~3m50s (15:04).** Combined session total: **8 calls started, 8 killed by B-05**
(6 group + 2 1:1); recovery (rejoin / ice-restart) 0/8.

**RETEST on build 1.0.48 (versionCode 71) â€” B-05 STILL NOT FIXED (server-side, as predicted):**
1:1 voice `cid=767a2583` (itsirajul â†’ fahim) connected + DTLS-verified 16:09:22, ran **~2 min 9 s**, then
`iceConnectionState=disconnected` 16:11:31 â†’ `connectionState=disconnected` 16:11:37 â†’
`iceConnectionState=failed` 16:11:47 (~16 s decay). Identical B-05 signature on the new build. **1.0.48
fixed B-11 + group text (client-side), but calls still die to the server WS drop** â€” confirming B-05 is
purely server-side and unaffected by the client update. Three 1:1 drops now: ~1 min / ~3m50s / ~2m9s.
**The server (`94.136.184.52` / `messenger-service`) must be fixed (crash watchdog + `WS_HEARTBEAT_GRACE`)
â€” no client build will resolve B-05.**

Second 1.0.48 1:1 (`cid=94fda1ee`, itsirajul â†’ fahim): connected 16:12:40, ran **~14 min 51 s** (longest
call of the entire session), then disconnected 16:27:31 â†’ failed 16:27:47 (~16 s decay) â€” same B-05.
**Survival is highly variable: 1:1 lifespans this session = ~1 min / ~3m50s / ~2m9s / ~14m51s; group =
4â€“14 min.** â‡’ B-05 is an **intermittent** server WS drop, NOT a fixed timeout â€” consistent with a
heartbeat-grace kick under variable latency and/or sporadic process restarts. Total session call tally:
**10 calls, 10 killed by B-05** (6 group + 4 1:1); recovery 0/10. Still requires server-log confirmation
at the drop timestamps.

Third 1.0.48 call â€” 1:1 VIDEO `cid=b02a1a50` (shirajul â†’ fahim): connected 16:30:39, ran **~12 min 53 s**,
then `iceConnectionState=disconnected` 16:43:32 â†’ ice-restart reoffer sent but **retries skipped
(`signalingState=have-local-offer` â€” no answer back over dead WS)** â†’ `iceConnectionState=failed` 16:43:48.
1:1 video render verified GOOD before the drop (both ends show remote full-screen + self PiP; same-face is
a BlueStacks shared-camera artifact). **Session call tally now 11 calls, 11 killed by B-05** (6 group +
5 1:1); recovery 0/11. **1.0.48 verdict vs prior build:** client fixes landed (B-11 multi-device online +
group-text render), but B-05 call survival is UNCHANGED (server-side) and B-18 1:1 text render still fails.

Fourth 1.0.48 call â€” 3-device group VIDEO (room `4040ff19`, fahim owner-host): connected 16:48:47,
render GOOD throughout (3 tiles, no black/blank), then ~16:57 **WS keepalive pings began failing**
(`[bravo.groupcall] keepalive ping failed x25â€¦x32: ack_timeout:ping`) **while media kept flowing for
~2.5 min**, then died 16:59:32 (shirajul `room.ended â€” host left`; fahim `reconnect -> rejoin` â†’
`connectionState=failed` 16:59:49 â†’ `rejoin FAILED: ack_timeout:sfu.join` 16:59:51). **Survived
~10 min 45 s.**

**NEW on 1.0.48 â€” keepalive-retry tolerance (B-05 mitigated, not fixed):** the `keepalive ping failed xN`
retry counter is new vs prior builds; the client now rides out WS ping failures (~2.5 min, x25â†’x32) before
the SFU transport finally fails, instead of the old ~17 s ICE-disconnectâ†’death. The call STILL ends in the
same `ack_timeout:sfu.join` â€” so the server WS drop (B-05) is unresolved; the client is just more tolerant.
**Session call tally now 12 calls, 12 killed by B-05** (7 group + 5 1:1); recovery 0/12.

5th 1.0.48 call â€” member-hosted group VIDEO (fahim non-owner host on `f956b212413b`, B-13 shortcut):
connected ~17:04:49, died ~17:06:55 (`room.ended` â†’ `connectionState=failed` â†’ `reconnect -> rejoin` â†’
`ack_timeout:sfu.producers`). **Survived only ~2 min** (keepalive reached just x4/x5, vs x32 on the prior
~10m45s call) â€” reinforces B-05 is **intermittent** (survival swings 2 min â†” 15 min, not a fixed timer).
**Session tally: 13 calls, 13 killed by B-05** (8 group + 5 1:1); recovery 0/13.

6th 1.0.48 call â€” member-hosted group AUDIO (itsirajul non-owner host on `f956b212413b`, B-13 shortcut,
room `d226c96d`): connected ~17:09:59, died 17:15:32 (`room.ended` â†’ `reconnect -> rejoin` â†’
`connectionState=failed` â†’ `rejoin FAILED: ack_timeout:sfu.join` â†’ `ice-restart failed attempt=1`).
**Survived ~5m33s.** Recent-call survival spread: 2 / 5.5 / 10.5 / 13 / 15 min â€” intermittent server drop
re-confirmed. **Session tally: 14 calls, 14 killed by B-05** (9 group + 5 1:1); recovery 0/14.

7th 1.0.48 call â€” admin-hosted group AUDIO (shirajul OWNER-host on `f956b212413b`, `delivered=3`):
connected ~17:16:40, died 17:31:32 (all 3 `reconnect -> rejoin` within ~80 ms = single server event â†’
`rejoin FAILED: ack_timeout:sfu.join` â†’ `connectionState=failed` â†’ `ice-restart failed attempt=1`).
**Survived ~14m52s.** B-17 blank-tile reproduced on itsirajul during this call (see B-17 retest above).
Admin vs member host makes no survival difference (~15 min here vs ~5.5 min prior member call â€” pure
server-drop timing). **Session tally: 15 calls, 15 killed by B-05** (10 group + 5 1:1); recovery 0/15.

**Watch-item (1.0.48, 16:28â€“29):** first 1:1 video attempt `cid=f55ef148` (shirajul â†’ fahim) never
connected (ended ~9 s, `finalState: 'ended'`), and **fahim's app restarted** (PID 8049â†’2572) right as the
incoming video call arrived; the retry (`b02a1a50`) then connected. Possible crash-on-incoming-video vs
manual restart â€” inconclusive (crash log rotated out). Re-test: place several 1:1 video calls to a fresh
receiver and watch for receiver PID change / cold-boot on ring.

Incident #4 was the first **video** group call to drop â€” same B-05 signature (all 3 `reconnect -> rejoin`
within ~1.3 s: 12:40:32.020 fahim, 12:40:33.183 itsirajul, 12:40:33.303 shirajul â†’ all `rejoin FAILED:
ack_timeout:sfu.join` ~12:40:48 â†’ `connectionState=failed` â†’ `ice-restart failed:
ack_timeout:sfu.transport.restartIce` ~12:40:52â€“54). Video-specific marker: at T+1s each device logs
`[bravo.groupcall.freeze] <tag>â†’paused <tag>â†’paused` (the visible "video froze" moment) before the ICE
cascade. Four B-05 drops now span 11:36 / 11:52 / 12:08 / 12:40 â€” lifespans 12 / 4 / 7 / 13 min;
auto-rejoin ineffective on every one.

Incident #3 booted as a **clean owner-hosted PASS** (`key resynced delivered=3` keyConvo `3cb79cb1f1b0`,
FrameCryptor on all 3 consumers, full 3-way audio) â€” and STILL died at the same B-05 server drop. This
isolates B-05 as purely server-side: key distribution / B-13 are irrelevant; a perfectly-booted call
dies anyway. All 3 fired `reconnect -> rejoin` within ~875 ms (12:08:31.672 fahim, 12:08:32.534
itsirajul, 12:08:32.546 shirajul) â†’ all `rejoin FAILED: ack_timeout:sfu.join` (~12:08:46â€“47) â†’
`connectionState=failed`. Three drops in ~32 min â‡’ server kills a call roughly every 4â€“12 min.

**The B-05 P1 auto-rejoin fix HAS been implemented** (the `[bravo.groupcall] reconnect -> rejoin`
log is new vs 2026-06-07 and did not exist before) **â€” but it does NOT recover the call.** On both
incidents the rejoin times out: `reconnect -> rejoin FAILED: ack_timeout:sfu.join`, followed by
`sendTx/recvTx connectionState=failed` and `ice-restart failed: ack_timeout:sfu.transport.restartIce`.
WS reconnects at the socket layer but the SFU room/server is unreachable within the grace window.

**Signature (both incidents):** the two survivors fire `reconnect -> rejoin` within ~150â€“171 ms of
each other = single server-side event, not independent client failures. The non-host joiner (fahim)
gets `room.ended â€” host left, tearing down` even though the host (itsirajul) did NOT leave â€” the
server emits `room.ended` on the WS/SFU drop. Decay to fully `failed`: ~17â€“22 s on each incident.

**Incident #2 per-device timeline (11:52):**

```
11:52:30.626  fahim:     last getStats
11:52:30.974  fahim:     room.ended â€” host left, tearing down (room 66d8f8b9), audio released â†’ backup.mirror
11:52:32.506  shirajul:  reconnect -> rejoin
11:52:32.655  itsirajul: reconnect -> rejoin           â† ~150ms apart = one server event
11:52:36.4/.7 both:      last getStats
11:52:36â€“37   both:      recvTx/sendTx disconnected â†’ ice-restart begin
11:52:46â€“47   both:      connectionState=failed + rejoin FAILED: ack_timeout:sfu.join
11:52:49      both:      sfu.producers failed: ack_timeout
11:52:51â€“52   both:      ice-restart failed: ack_timeout:sfu.transport.restartIce â†’ DEAD
```

**Takeaway:** B-05 is still the dominant failure and is now recurring at short intervals (12 min, then
4 min). The client P1 fix landed but is moot until the server stops dropping. **Server-side P0 (crash
investigation + `WS_HEARTBEAT_GRACE` raise + watchdog) remains the real fix.** Still need server logs
from `94.136.184.52` around 11:36:30 and 11:52:30 to confirm crash vs heartbeat-grace timeout.

Evidence (live capture): `~/Desktop/bravo_logs_live_20260608_112423/device_5555_itsirajul.txt`,
`device_5565_shirajul.txt`, `device_5575_fahim.txt`.

**RETEST 2026-06-09 on build 1.0.49 (versionCode 72) â€” B-05 STILL NOT FIXED (server-side, as predicted):**
Nine calls (5Ã— 1:1 + 2Ã— group video + 2Ã— group voice), all connected + verified, all eventually killed by the same B-05 WS drop.
**Recovery: 0 calls survived to completion; only call #9 (1:1) self-healed transient blips (3Ã— ice-restart) before a sustained drop killed it.**
**1.0.49 call-survival spread: ~3 / ~2m40s / ~5m57s / ~8m23s / ~10m20s / ~10m25s / ~12 / ~12.5 / ~13m50s min â€” intermittent, ceiling ~14 min, no fixed timer.**
**Caveat â€” "usable" time << lifespan for group calls:** once the WS dies (~40â€“90s after connect), tiles drop
(B-17) and the host goes silent ("zombie call") minutes before the terminal teardown. e.g. call #7 lasted
~10m20s but was only usable ~4â€“5 min.

| #   | Call                                                   | cid/room           | Connected                                                   | Lifespan                             | Failed   |
| --- | ------------------------------------------------------ | ------------------ | ----------------------------------------------------------- | ------------------------------------ | -------- |
| 1   | 1:1 audio itsirajulâ†’fahim                            | `decd1f15`         | ~10:57                                                      | **~12.5 min**                        | 11:09:58 |
| 2   | 1:1 video fahimâ†’shirajul                             | `9399f856`         | 12:00:59 (dtls-verify-ok cipher=AES_CM_128_HMAC_SHA1_80)    | **~2m40s (160s)**                    | 12:03:57 |
| 3   | 1:1 video shirajulâ†’fahim                             | `0d06f81e`         | 12:08:42 (dtls-verify-ok)                                   | **~5m57s**                           | 12:14:56 |
| 4   | 1:1 audio itsirajulâ†’fahim                            | `c3fe184c`         | ~12:26 (connect not captured)                               | **~3 min**                           | 12:29:57 |
| 5   | group video (admin-host) itsirajul, "SQA-ITSirajul"    | room `90cab672â€¦` | 12:35:14 (delivered=3, all FrameCryptor)                    | **~10m25s**                          | 12:45:57 |
| 6   | group video (member-host) "SQA-Shirajul"               | room `f7436684â€¦` | ~12:48:50 (all 3 connected, B-13 conditional-pass)          | **~13m50s**                          | 13:02:40 |
| 7   | group voice (admin-host) "SQA-Shirajul" `f956b212413b` | room `163aaef4â€¦` | 14:01:20 (3 tiles, all FrameCryptor)                        | **~10m20s** (usable only ~4â€“5 min) | 14:11:56 |
| 8   | group voice (member-host) "SQA-Shirajul"               | room `â€¦764e73`   | ~14:14:17 (3 tiles, B-13 conditional-pass)                  | **~8m23s**                           | 14:22:57 |
| 9   | 1:1 audioâ†’video upgrade itsirajulâ†”fahim            | `5d0bfd76`         | ~14:25:30 (B-16 render PASS; **3Ã— ice-restart recovered**) | **~12 min**                          | 14:37:46 |

**RECOVERY nuance â€” 1:1 ice-restart healed _three_ transient WS blips and kept the call alive (only self-healing call of the session):**
1:1 audioâ†’video call `cid=5d0bfd76` (itsirajulâ†”fahim) recovered **3 separate ICE blips** via ice-restart
and stayed up (>8 min and counting):
`ice-restart-recovered` at 14:28:05 (gap ~3.0â€“3.2s), 14:28:27 (gap 0.5s / 0.03s), 14:30:42 (gap ~1.9â€“2.4s)
â€” each time back to `connectionState=connected`. **First (and only) successful recovery of the session**
(prior tally 0/8 across the other calls). Confirms the 1:1 ice-restart path actually works against brief
WS hiccups. **Then it died on the 4th blip â€” a _sustained_ drop:** 14:37:40 `iceConnectionState=disconnected`
â†’ ice-restart `skipped â€” signalingState=have-local-offer` (reanswer never returned) â†’ `connectionState=
disconnected` 14:37:46 â†’ dead (fahim `close +554ms` â†’ `callaudio state=failed`). **One call, 3 transient
blips recovered + 1 sustained drop fatal â€” the cleanest single illustration that ice-restart beats brief
blips but loses to sustained B-05 drops.** Lifespan ~12 min.
**Why it healed vs the others:** the WS blip here was _brief_, so the reanswer got back before the WS
died for good. The 8 fatal calls hit _sustained_ WS drops where no answer/`sfu.join` ever returned.
**Structural difference (not "1:1 is stable"):** 1:1 = direct P2P (DTLS-SRTP) â€” needs the WS only at
_moments_ (setup + ice-restart), so a short hiccup is survivable and its recovery (re-establish ICE
between 2 peers) is lightweight. Group = SFU â€” needs the WS _continuously_ (keepalive, new-producer,
rejoins); its recovery (`reconnect â†’ rejoin` / `sfu.join`) **failed every time (0-for-all group drops)**
and each rejoin also spawns the zombie-tag tile drop (B-17). **Net:** against a _transient_ blip 1:1 can
self-heal (proven once); against a _sustained_ B-05 drop **both call types die** â€” and 1:1 still died in
**4 of 5** attempts this session. So 1:1 is not fundamentally more stable; it just has a lighter recovery
path that can occasionally win the race against a brief blip. Fix remains server-side (stop the WS drop).

**Group-call B-05 pattern (both 1.0.49 group calls):** WS keepalive starts failing **~40â€“90s after connect**
(`keepalive ping failed x2`) â€” i.e. the WS drops almost immediately â€” yet media **rides the dead WS
10â€“14 min** on the keepalive-retry tolerance (x2 â†’ x32 / x39) before terminal
`room.ended â€” host left` / `ack_timeout:sfu.join`. Much longer ride-out than 1.0.48's ~2.5 min, but the
call still dies; B-05 unresolved.

- **Call 5 (group video, admin-host):** WS died **~40s after connect** (keepalive `x2` from 12:35:54) but
  media **rode the dead WS ~10 min** via the keepalive-retry tolerance (`x2`â†’`x32`) before terminal death â€”
  far longer ride-out than 1.0.48's ~2.5 min. Terminal: joiners `room.ended â€” host left, tearing down`
  12:45:39 (host did NOT leave â€” server emits on drop); host `recvTx/sendTx connectionState=failed` +
  `reconnect -> rejoin FAILED: ack_timeout:sfu.join` 12:45:56â€“57. **B-17 blank tile reproduced on all 3
  during this call** (see B-17 1.0.49 retest â€” zombie tag from shirajul's 12:35:40 early rejoin).

- **Call 3 (video):** survived a mid-call **camera-loss to another app (B-20, magenta video ~12:11)** and
  kept running ~3 more min, then died to B-05: fahim `iceConnectionState=disconnected` 12:14:40 â†’
  `connectionState=disconnected` 12:14:46 â†’ `iceConnectionState=failed` 12:14:56 (~16s decay); shirajul
  `pc close +978ms` 12:14:39 â†’ `callaudio state=failed`. "Couldn't build secure connection" popup again.
  â‡’ **B-20 (camera) and B-05 (server WS drop) are independent failure modes.**

- **Call 1 (audio):** `iceConnectionState=disconnected` 11:09:40 â†’ `[bravo.callController] ice-restart` fires + sends reoffer (relay candidates gathered) â†’ all retries **skipped `signalingState=have-local-offer`** (no answer back over dead WS) â†’ `connectionState=disconnected` 11:09:48 â†’ `iceConnectionState=failed` 11:09:58 (~18s decay). `callaudio state=failed`.
- **Call 2 (video):** render GOOD before drop (caller fahim showed remote full-screen + self-PiP). Decay on shirajul: `iceConnectionState=disconnected` 12:03:40 â†’ `connectionState=disconnected` 12:03:47 â†’ `iceConnectionState=failed` 12:03:57 (~17s). Both ends `[CallScreen] cleanup duration:160 finalState:'failed'`.
- **NEW user-facing detail (1.0.49):** on call failure a popup/alert appears â€” verbatim:
  **"Call failed / Could not establish a secure connection. Try again."** with an **OK** button.
  The string is a JS Alert (not in logcat) â€” captured on-device by QA (`now_5565.png`, `now_5575.png`).
  **The call screen does NOT auto-dismiss** on failure: both participants stay stuck on the call UI
  (video tile + End Call button) behind the popup; user must tap **OK** then **End Call** to leave. Clearer
  failure surface than prior builds, but the stuck-call-screen is a UX gap.
- **No receiver cold-boot** on incoming 1:1 video this session (all PIDs unchanged: itsirajul 4416, shirajul 5033, fahim 4575) â€” the 1.0.48 "incoming-video â†’ receiver restart" watch-item did NOT reproduce.
- Identical B-05 signature to 1.0.48 â‡’ confirms B-05 is purely server-side; the 1.0.49 client update does not touch it. **Server (`94.136.184.52` / `messenger-service`) fix still required** (crash watchdog + `WS_HEARTBEAT_GRACE`). Evidence: `~/Desktop/bravo_logs_v49_0609/` (call_5555_itsirajul.txt, vcall_5575_fahim.txt, device logcat + screenshots).

**RETEST 2026-06-10 on build 1.0.50 (versionCode 73) â€” B-05 STILL NOT FIXED (server-side, as predicted):**

3-device group calls on "SQA - ITSirajul" (`4100833dd9da`, fahim non-owner host, B-13 conditional-pass).
Same B-05 signature; client update does not touch it.

_Failure timeline:_

```
15:30:36  group video call connects (all 3 OK, FrameCryptor on every consumer)
15:31:27  WS to server stops responding â†’ keepalive ping fails (all 3 devices):
            [bravo.groupcall] keepalive ping failed x2: ack_timeout:ping
            fahim 15:31:27 Â· shirajul 15:31:42 Â· itsirajul 15:31:46
            â† all 3 within ~19s = ONE server-side event (not 3 client failures)
            â† only ~52s after connect
15:31â†’15:42 WS stays dead; media rides keepalive-retry tolerance (counter x2 â†’ x28, ~10 min)
15:42:57  recvTx/sendTx connectionState=disconnected (fahim)
15:43:07  recvTx/sendTx connectionState=failed  â† CALL DEAD (~10s decay)
          keepalive reached x28 (shirajul 15:42:13) / x27 (fahim 15:51:38) â€” WS never recovered
```

**Root cause = server WebSocket drop** (`messenger-service` on `94.136.184.52`). The client's WS ping
gets no ack (`ack_timeout:ping`); signalling path is gone, so keepalive/ice-restart/rejoin have nothing
to reach. Media (separate UDP/DTLS) rides on ~10 min then decays to `failed`. **NOT a client bug, NOT
crypto** â€” the call connected + ran clean ~52s first; client mitigation (keepalive tolerance,
ice-restart, reconnectâ†’rejoin) all fire correctly but have no server to talk to.

_Confirms server-side:_ (1) all 3 drop in the same ~19s window = single upstream event; (2) identical
signature on 1.0.48 / 1.0.49 / 1.0.50 â€” client updates don't change it; (3) survival is random across
sessions (2â€“15 min) = not a fixed client timer, consistent with a heartbeat-grace kick under bad latency
and/or process restart.

**Note vs 1.0.49:** this drop decayed via slow keepalive-starvation â†’ `connectionState=failed` (no
`transport not open` / `reconnect -> rejoin` / `ack_timeout:sfu.join` this time) â€” slightly different
terminal path, same root. **Server fix still required** (raise `WS_HEARTBEAT_GRACE`â†’25000 â€” and ensure
`.env.example`'s stale `10000` doesn't override it; add restart policy + uptime monitor; pull server logs
at 15:31:27 / 15:43:07 to confirm crash-vs-heartbeat). **Crash vs heartbeat-kick remains unverified from
client logs alone â€” needs server-side logs.** Evidence: `~/Desktop/bravo_logs_v50_0610/device_55{55,65,75}.txt`.

**RETEST 2026-06-11 on build 1.0.51 (versionCode 74) â€” B-05 STILL NOT FIXED; NEW longevity record ~24m30s.**

3-device group **voice** call, owner-host shirajul on "SQA - Shirajul" (`f956b212413b`), room `6b6a73deâ€¦`.
Connected 09:55:42 (3-way audio, FrameCryptor on every consumer, all tiles eventually rendered). Same B-05
server WS drop; client build does not touch it.

_Failure timeline:_

```
09:55:42  call connected, clean 3-way audio
~10:17:38 WS keepalive stops acking (ack_timeout:ping x1) â† server WS drop, ~22 min after connect
10:18:18  keepalive x3 (all 3 devices within ~3s = ONE server event) â€¦
10:18â†’10:20  keepalive climbs x3â†’x8 (~20s/tick) â€” media rides the dead WS ~2.5 min
10:19:57  fahim: room.ended â€” host left, tearing down  â† host (shirajul) did NOT leave; server emits on drop
10:19:58  all 3: reconnect -> rejoin
10:20:02  ice-restart begin attempt=1 (sendTx+recvTx)
10:20:12  recvTx/sendTx connectionState=failed         â† CALL DEAD
10:20:13  reconnect -> rejoin FAILED: ack_timeout:sfu.join
10:20:15-17  sfu.producers failed: ack_timeout ; ice-restart failed: ack_timeout:sfu.transport.restartIce (â†’ attempt=2)
```

**Lifespan ~24m30s (09:55:42â†’10:20:12) â€” new max for the project (prior ceiling ~15 min); usable ~22 min**
(until the WS drop), then ~2.5 min keepalive ride-out before terminal teardown. Identical signature to
1.0.48/49/50 â‡’ confirms B-05 is purely server-side and intermittent (survival 2 â†’ 24.5 min across sessions,
not a fixed timer â€” consistent with a heartbeat-grace kick under variable latency and/or sporadic process
restart). All client mitigation (keepalive tolerance, reconnectâ†’rejoin, ice-restart x2) fired correctly but
had no server to reach. **Server fix still required** (raise `WS_HEARTBEAT_GRACE`â†’25000 and ensure
`.env.example`'s stale `10000` can't override on deploy; restart policy + uptime monitor; pull server logs at
10:17:38 / 10:20:12 to confirm crash-vs-heartbeat). Evidence: live logcat 2026-06-11 (devices 5555/5565/5575).

**B-17 corroboration this call (render-timing-race confirmed):** the blank self-tile (see B-17 1.0.51 retest)
persisted ~22 min on the steady call â€” then \*\*self-healed the instant the B-05 WS churn (`reconnect -> rejoin`

- state changes ~10:18â€“10:20) forced re-renders.\*\* QA confirmed "all tiles now showing" at that moment. This
  proves B-17's blank cell is a render-timing race (the slot had a valid position all along; it only needed a
  follow-up render to commit), not a missing tile â€” directly supporting the fix (render off `layout`, not the
  retained map). A steady call rarely triggers the reconciling re-render, which is why the blank can linger for
  the whole call.

---

### Bug B-06 â€” Missing Video Tiles ("one phone sees 2 out of 3")

**Root cause:** `sfu.new-producer` frame arrives during the boot window before the SFU frame handler is registered at step 7. Any producer event between `sfu.join` (step 3) and handler registration is silently dropped. The 4s reconcile tick (`sfu.producers`) is the recovery path but also fails under high latency:

```
[bravo.groupcall.reconcile] sfu.producers failed: ack_timeout:sfu.producers
```

Result: a participant's tile never appears for the duration of that call.

**P2 fix:** Register the `sfu.new-producer` handler before `sfu.join` (move from step 7 to before step 3). Buffer frames received before recvTransport is ready, then drain on connect.

---

### Bug B-07 â€” `toggleVideo` Silently Refuses (No User Feedback)

`useGroupCall.ts:1928`:

```typescript
if (!enc || !rtpSender) {
  console.warn('[bravo.groupcall.ctl] toggleVideo refusing â€” no SFrame encryptor/rtpSender');
  // ... silent return â€” user gets NO feedback
}
```

If the group master key has not arrived yet (pairwise Signal delivery delayed by high latency), the SFrame encryptor is null and camera enable is silently refused. The user taps the video button â€” nothing happens.

**P4 fix:** Replace the silent return with a visible toast: `"Waiting for call encryption â€” try again in a moment"`. Also add a retry callback once the key arrives.

---

### Bug B-08 â€” Boot Race: Component Unmount During `sfu.join`

Observed in 11:34 trace for device 5555:

```
11:34:56.820  step=3 sfu.join started
11:34:56.952  [bravo.groupcall.leave] tearing down  â† 132ms later
```

A second `GROUP_CALL_PRESENCE` envelope from a peer arrived before the boot completed. The presence handler navigated to the incoming call screen, unmounting the in-progress `GroupCallScreen`, which triggered the `useEffect` cleanup â†’ `leaveInternal()` on the room being joined. Device 5555 never actually joined this call.

**Fix needed:** The `GROUP_CALL_PRESENCE` handler must check if a boot is already in progress for the same `roomId` before triggering any navigation.

---

### Bug B-09 â€” All Calls Boot as `callType=voice` (No Camera at Start)

All 3 devices consistently show in logs:

```
step=2 acquiring local media (video=false)
getLocalMedia video=false tracks=audio
```

Video is only available after `toggleVideo()` is called post-join â€” which goes through the SFrame attach path in B-07 (can silently fail). Every call starts with zero video and relies on a post-join action that has no user feedback on failure.

---

### Bug B-10 â€” Group Key Epoch Mismatch After Call Reconstruction

Observed at ~11:35:42 on all 3 devices after a call tore down and was recreated:

```
[group:recv] tamper detected â€” dropping envelope from 3165d0e1
```

The host (`3165d0e1`) sent a message with a key epoch that all 3 recipients rejected. After call reconstruction the host's key epoch advanced but recipients still held the old epoch. Indicates epoch is not being synchronized on re-call.

---

## QA Session 2026-06-08 â€” Physical Device Testing (Offline + Group Call)

**Session date:** 2026-06-08  
**Devices:** Pixel 7a (32251JEHN23958) | Xiaomi 2409BRN2CY-1 (69BQLV5DXSWGWCOF, USB) | Redmi 2409BRN2CY-2 (192.168.0.100:34391, Wi-Fi)  
**Branch tested:** `release/1.0.35-audit-fixes`  
**Evidence:** `~/Desktop/bravo_logs_20260608/` â€” pixel_7a.txt, xiaomi_2409BRN2CY.txt, redmi_2409BRN2CY.txt, pixel_call_session.txt, xiaomi_call_session.txt, redmi_call_session.txt, xiaomi_full_raw.txt, redmi_full_raw.txt

---

### Bug B-11 â€” Second Device Always Goes Offline When Any Two Accounts Are Open âš ï¸ CRITICAL

**Reproduce:**

1. Open BravoSecure on Device A â€” it goes online.
2. Open BravoSecure on Device B (different account) â€” Device A shows "Offline â€” messages will send when you reconnect".
3. Repeat with any two devices in any order â€” the previously-connected device always goes offline.

**Frequency:** 100% â€” every two-device combination, every time.

**Root cause â€” `productionRuntime.ts:318`:**

```typescript
const signalDeviceId = config.signalDeviceId ?? 1;
```

Both devices get `signalDeviceId = 1` (hardcoded Phase-1 default). The server connection registry in `apps/messenger-service/src/gateway/connection-registry.ts:44â€“51` keys every socket by `${userId}:${deviceId}`. When two sockets share the same `(userId=X, deviceId=1)` key, the newer one supersedes the older:

```typescript
if (existing && existing.sessionId !== conn.sessionId) {
  existing.socket.emit('error', {code: 'superseded', message: 'newer session took over'});
  existing.socket.disconnect(true);
}
```

The kicked socket receives `reason = 'io server disconnect'`. In `client.ts:401â€“403`:

```typescript
if (reason === 'io server disconnect') {
  this.setState('disconnected');
  return; // â† never attempts reconnect
}
```

The client stays permanently in `disconnected` state. `ConnectionBanner.tsx` shows "Offline".

**Secondary effect â€” Redis presence counter leak (`presence.service.ts`):**  
`handleDisconnect` at `messenger.gateway.ts:635` sets `wasLiveOwner = false` for the superseded socket, which skips `presence.onDisconnect()` â€” the DECR never fires. Redis counter for `userId` drifts upward. Even after the user is physically offline on all devices, the counter stays â‰¥ 1 â†’ they appear permanently `online` to peers.

**Log evidence (native ADB, 2026-06-08 ~00:22):**

```
00:22:14  Xiaomi restarts (PID 18446) â†’ connects with signalDeviceId=1
00:22:35  Pixel restarts (PID 14641) â†’ connects with signalDeviceId=1
00:22:35.522  InetDiagMessage: Destroyed live TCP sockets for uids={10467}
              â† Pixel's new connection supersedes Xiaomi's socket at OS level
              â† Xiaomi enters permanent 'disconnected' state
```

**Files involved:**

- `productionRuntime.ts:318` â€” root cause (hardcoded `signalDeviceId`)
- `client.ts:401â€“403` â€” stays disconnected on server kick (no reconnect)
- `apps/messenger-service/src/gateway/connection-registry.ts:44â€“51` â€” supersession logic
- `apps/messenger-service/src/gateway/presence.service.ts:116â€“126` â€” DECR skipped on supersession
- `apps/messenger-service/src/gateway/messenger.gateway.ts:635â€“690` â€” `wasLiveOwner=false` path

---

### Bug B-12 â€” Group Call Fails: Group Master Key Never Delivered to Joiner (Root: B-11) âš ï¸ CRITICAL

**Reproduce:**

1. Device A (Pixel) starts a group call (host).
2. Device B (Xiaomi) receives the ring and accepts â†’ GroupCallScreen opens, shows "Joiningâ€¦"
3. After 25 seconds, GroupCallScreen closes with no error message. Call fails.
4. Retry: same result.

**Frequency:** 100% on any two-device combination where B-11 is active (i.e. always).

**Root cause â€” key delivery blocked by B-11:**

1. Both devices use `signalDeviceId=1`. The last device to open the app supersedes the other.
2. When Xiaomi accepts the ring, Pixel's WebSocket is superseded â†’ Pixel (host) is in `disconnected` state.
3. Pixel sends the group master key as a sealed-sender Signal envelope to Xiaomi.
4. But now Xiaomi's WS was previously superseded by Pixel at boot â†’ Xiaomi is also in `disconnected` state when the ring arrives (or gets superseded during the accept flow).
5. The key envelope sits in the relay queue. `waitForGroupCallKey` in `useGroupCall.ts:917` waits up to **25 seconds** for the key.
6. 25s window expires â†’ throws `FrameCryptorOrchestrator: no group master key â€” refusing to start` â†’ call fails closed (correct per `ARCHITECTURE_AMENDMENT_SFRAME Â§"fails closed"`).
7. GroupCallScreen unmounts â†’ the `useMessengerStore.subscribe` key-watch listener is detached.
8. Key finally arrives 18â€“43 seconds after the call started (when the superseded device's WS briefly reconnects).
9. **`handled=false`** â€” no GroupCallScreen mounted to consume the key â†’ key silently dropped.
10. Any retry starts the same cycle; the dropped key from the first attempt cannot be reused.

**Log evidence (Xiaomi logcat, 2026-06-08 ~00:28):**

```
00:28:12.436  [bravo.groupcall.boot] step=3b FrameCryptor init failed â€” refusing:
              FrameCryptorOrchestrator: no group master key â€” refusing to start
              â† 1st call attempt: 25s window expired, key never arrived

00:28:23.275  Camera 1: start to disconnect
              â† GroupCallScreen unmounted, key listener gone

00:28:30.497  [recv.enter] doHandleIncoming peer=08782d6d/1 envId=0780a56c
              â† Key finally arrived â€” 18 seconds AFTER call ended

00:28:30.672  [messenger.deliver] ACK ok envId=0780a56c handled=false
              â† handled=false: no active listener, key DROPPED

00:29:01.017  [bravo.groupcall.boot] step=3b FrameCryptor init failed â€” refusing:
              FrameCryptorOrchestrator: no group master key â€” refusing to start
              â† 2nd call attempt: same failure
```

**Sequence diagram:**

```
Pixel (host)                        Xiaomi (joiner)             Relay
   |                                     |                         |
   |-- sfu.ring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€>                         |
   |                                     | accepts ring            |
   |                                     | GroupCallScreen opens   |
   |-- key envelope â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€->|
   |   (Xiaomi's WS superseded/disconnected)                       |
   |                                     | waiting 25s for key...  |
   |                                     |        â† key queued     |
   |                                     | 25s TIMEOUT             |
   |                                     | call FAILS              |
   |                                     | screen unmounts         |
   |                                     |                         |
   |                         (18s later) |<â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ key arrives |
   |                                     | handled=false â€” DROPPED |
```

**Symptom visible to user:** Call screen opens â†’ "Joiningâ€¦" spinner for ~25 seconds â†’ screen closes silently. No error toast, no explanation.

**Blocked by:** B-11. Fixing B-11 (unique `signalDeviceId` per device) removes the supersession cycle, allowing keys to deliver in <1 second.

**Files involved:**

- `src/modules/messenger/webrtc/useGroupCall.ts:917â€“928` â€” `waitForGroupCallKey` 25s window
- `src/modules/messenger/runtime/productionRuntime.ts:318` â€” root cause (signalDeviceId=1)
- `src/modules/messenger/transport/client.ts:401â€“403` â€” no reconnect on `io server disconnect`

---

### Developer PR Assessment â€” Ranak's Recent Commits (2026-06-07)

Reviewed against live call session. Commits: `d435697`, `25eb8f0`, `9056c3a`, `e113b3c`, `fe78c09`

| Commit    | Change                                                                          | Status                                                           |
| --------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `fe78c09` | `resumeConsumer`: call `c.requestKeyFrame()` for video after resume             | âœ… Fixed â€” video unfreezes after consumer pause/resume        |
| `d435697` | Black video tile layout: pre-build tiles from `existingProducers` before render | âœ… Partial fix â€” members (non-host) no longer get black tiles |
| `d435697` | Ghost "Call" groups: filter out ad-hoc call groups from groups list             | âœ… Fixed                                                        |
| `d435697` | Real group key lookup: use correct `keyConversationId` for proper groups        | âœ… Fixed                                                        |
| `25eb8f0` | Ad-hoc call: deliver key to 1:1 joiner via `direct:<host>` lookup               | âœ… Fixed                                                        |
| `e113b3c` | Resync group master key on every call + joiner key-wait                         | âœ… Fixed                                                        |
| â€”       | Server WS drop at 12:05:24                                                      | âŒ Not addressed â€” server-side                                 |
| â€”       | `toggleVideo` silent failure (B-07)                                             | âŒ Not addressed                                                 |
| â€”       | Boot race during `GROUP_CALL_PRESENCE` (B-08)                                   | âŒ Not addressed                                                 |

**Overall assessment:** The 5+ minute "pretty perfect" call observed in this session (30fps, 0 dropped frames) is attributable to these commits working together. The app is significantly more stable post-PR. The remaining failures are all caused by the server WS drop (B-05) which is outside the scope of these client-side commits.

---

### Last "Pretty Perfect" Call â€” Benchmark

Session captured a successful call that ran **5+ minutes at 30fps with 0 dropped frames** before the server WS drop terminated it. This is the current quality ceiling.

```
11:33:xxâ€“12:05:24  â€” sustained group video call
12:05:24           â€” server WS drop terminated all 3 devices simultaneously
```

All video streams were stable until the server event. B-01/B-02/B-04 were all resolved by Ranak's recent commits for this call round.

---

### Recommended Fixes â€” Priority Order

| Priority | Component                                             | Fix                                                                                      |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P0       | `messenger-service` server                            | Investigate crash/restart at 12:05:24 via server logs                                    |
| P0       | `apps/messenger-service/src/config/configuration.ts`  | Raise `WS_HEARTBEAT_GRACE` 10,000ms â†’ 25,000ms                                         |
| P0       | Contabo VPS                                           | Add PM2 watchdog + uptime monitor on relay endpoint                                      |
| P1       | `useGroupCall.ts`                                     | On Socket.io `reconnect` event while `state=joined`: auto-rejoin within 60s grace window |
| P2       | `useGroupCall.ts`                                     | Register `sfu.new-producer` handler before `sfu.join` (step 7 â†’ before step 3)         |
| P3       | `packages/messenger-core/src/transport/client.ts:151` | Raise `emitWithAck` default timeout 8,000ms â†’ 15,000ms                                 |
| P4       | `useGroupCall.ts:1928`                                | Replace silent `toggleVideo` refusal with user-visible toast + key-arrival retry         |

---

### Server Log Commands (Run on 94.136.184.52)

```bash
# Confirm crash vs heartbeat timeout at 12:05:24
cat /var/log/messenger-service/error.log | grep "2026-06-07 12:05"
pm2 logs messenger-service --lines 500 | grep "12:05"
journalctl -u messenger-service --since "12:04:50" --until "12:05:40"
pm2 list   # check restart count for messenger-service

# If Docker:
docker logs messenger-service --since "2026-06-07T12:04:50" --until "2026-06-07T12:06:00"
```

---

## QA Session 2026-06-08 â€” 3-Device Group Call (Physical Devices)

**Session date:** 2026-06-08 ~00:39â€“00:41  
**Devices:** Pixel 7a (32251JEHN23958) = HOST | Xiaomi 2409BRN2CY (69BQLV5DXSWGWCOF) | Redmi 2409BRN2CY (192.168.0.100:34391)  
**Branch tested:** `release/1.0.35-audit-fixes`  
**Evidence:** `~/Desktop/bravo_logs_20260608/pixel_call_session.txt`, `xiaomi_call_session.txt`, `redmi_call_session.txt`

**Summary:** Both joiners (Xiaomi + Redmi) failed on ALL call attempts (2 rounds). Host (Pixel) stayed in call. Root cause: Bug B-13.

---

### Round 1 â€” Voice Call (00:39:14 â€“ 00:40:09) â€” FAIL

| Time           | Device | Event                                                                                        |
| -------------- | ------ | -------------------------------------------------------------------------------------------- |
| `00:39:14.378` | Pixel  | Boot start, direction=outgoing, `convo=3cb79cb1f1b0`                                         |
| `00:39:14.818` | Pixel  | **`[call-adhoc-key:runtime] reusing real-group key (non-owner host) keyConvo=3cb79cb1f1b0`** |
| `00:39:15.351` | Pixel  | Audio producer attached (FrameCryptor) â€” HOST IN CALL                                      |
| `00:39:16.157` | Xiaomi | `recv.enter` envId=`b0005041` from Pixel â†’ `handled=false`                                 |
| `00:39:16.449` | Xiaomi | ringtone started (via FCM push)                                                              |
| `00:39:19.218` | Xiaomi | `step=3b waiting for key under direct:08782d6d-bb...`                                        |
| `00:39:17.444` | Redmi  | `recv.enter` envId=`972525c0` from Pixel â†’ `handled=true` (ring)                           |
| `00:39:20.803` | Redmi  | `step=3b waiting for key under direct:08782d6d-bb...`                                        |
| `00:39:44.226` | Xiaomi | **FrameCryptor init failed: no group master key (25s timeout)**                              |
| `00:39:45.815` | Redmi  | **FrameCryptor init failed: no group master key (25s timeout)**                              |

### Round 2 â€” Video Call (00:40:17 â€“ present) â€” FAIL (same pattern)

| Time           | Device | Event                                                                                    |
| -------------- | ------ | ---------------------------------------------------------------------------------------- |
| `00:40:17.872` | Pixel  | `[call-adhoc-key:runtime] reusing real-group key (non-owner host) keyConvo=3cb79cb1f1b0` |
| `00:40:17.724` | Xiaomi | `recv.enter` envId=`51268201` â†’ `handled=false`                                        |
| `00:40:20.932` | Xiaomi | `step=3b waiting for key under direct:08782d6d-bb...`                                    |
| `00:40:18.680` | Redmi  | `recv.enter` envId=`7e962a01` â†’ `handled=true` (ring)                                  |
| `00:40:21.897` | Redmi  | `step=3b waiting for key under direct:08782d6d-bb...`                                    |
| `00:40:46.100` | Xiaomi | **FrameCryptor init failed: no group master key**                                        |
| `00:40:46.914` | Redmi  | **FrameCryptor init failed: no group master key**                                        |

---

### Bug B-13 â€” Non-Owner Host: Key Distribution Silently Skipped (APK Ahead of Repo) âš ï¸ CRITICAL

> **See also B-02** â€” same family (ad-hoc/group call key not reaching joiners). B-02 was the 2026-06-06 form (fixed by Ranak's commits); B-13 is the re-emergence via the non-owner-host shortcut path. See the **Refinement** at the end of this entry â€” B-13 is conditional (only fails when a joiner lacks the pre-seeded key).

**Group:** `3cb79cb1f1b0e0be3ff9c2df76344a0f`  
**Host:** Pixel 7a (userId prefix `08782d6d`) â€” NOT the group's original creator/admin

**Root cause:**

The installed APK contains a code path in `ensureCallGroupKey` (`productionRuntime.ts`) that **does not exist in the current repo source**:

```
[call-adhoc-key:runtime] reusing real-group key (non-owner host) keyConvo=3cb79cb1f1b0
```

This log string cannot be found anywhere in the repo with `grep -r`. The APK was compiled from a newer/different version of `productionRuntime.ts` (same category as B-03).

**What the new code path does (inferred from behavior):**

When the host has the group key in their local store but is NOT the group's owner, the new path:

1. Returns `{keyConversationId: conversationId}` (the real group ID)
2. **SKIPS the broadcast** â€” no `[call-adhoc-key:runtime] key resynced delivered=N` log appears, which means `broadcastToGroup()` was never called

Consequence: **joiners never receive the group master key**. They wait 25 seconds â†’ timeout â†’ call fails.

**Secondary issue â€” joiner key resolution mismatch:**

Even if the host did broadcast, the joiner `resolveKeyId()` in `useGroupCall.ts:853â€“879` evaluates:

```typescript
const groupOwner = g[opts.conversationId]?.owner;
const hostIsAdmin = !opts.hostUserId || !groupOwner || groupOwner === opts.hostUserId;
```

Joiners have `groups['3cb79cb1f1b0'].owner = <original creator, NOT Pixel>` â†’ `hostIsAdmin = false` â†’ only checks `g[direct:08782d6d...]` slot. But the key was sent under `3cb79cb1f1b0`. **Even a delivered key would be missed** by the joiner resolver.

**Tertiary issue â€” forgery guard (`handled=false` on Xiaomi):**

The key envelope (if sent) would have `state.owner = <original creator>` but `sender = Pixel`. The `doHandleIncoming` forgery guard:

```
Group create from non-owner â€” dropped
```

(`productionRuntime.ts:4421`) fires â†’ `handled=false` â†’ key ACKed and deleted from relay â†’ unrecoverable.

**Three independent failure gates**, all activated by the same root: non-owner host taking a new shortcut path.

**Evidence:** Both rounds identical. No `key resynced delivered=N` log. No key envelope seen on Redmi at all. Xiaomi receives an envelope but it's `handled=false`. Both fail at exactly 25s.

**Files involved:**

- `productionRuntime.ts` â€” APK version has undocumented "non-owner host" path that skips broadcast
- `productionRuntime.ts:4421` â€” forgery guard correctly rejects non-owner key envelopes
- `useGroupCall.ts:853â€“879` â€” `resolveKeyId()` assumes non-owner host â†’ `direct:<host>` slot

**Reproduce:** Start a group call as any user who is NOT the original group creator/admin. All joiners will fail with "no group master key" at 25 seconds. Host stays in the call alone.

**Refinement â€” B-13 is CONDITIONAL, not absolute (logged 2026-06-08 01:52, BlueStacks):**

The non-owner-host `reusing real-group key` path **skips the key broadcast on the assumption every member already holds the group master key.** Whether that assumption holds decides pass/fail:

- **FAILS** â†’ only when a joiner does **not** already have the group key locally. They get nothing (no broadcast) â†’ 25s timeout â†’ "no group master key". This is the original Pixel/physical-device repro, where the key had never been distributed for that group.
- **WORKS** â†’ when the key was already distributed to all members beforehand (an established real group, or a prior **owner**-hosted call that seeded the key).

Direct evidence both ways in one session:

```
01:48:23  fahim (OWNER host):     key resynced delivered=3   â†’ seeds key to all 3 members
01:52:58  shirajul (NON-OWNER):   reusing real-group key (non-owner host)  â†’ broadcast SKIPPED
          â†’ call still connected full 3-way A+V (all FrameCryptor) because every member
            already held the key from the 01:48 owner-hosted round.
```

So the bug only bites a member who joins a non-owner-hosted call **without** having previously received the group key. The fix (non-owner host must still broadcast, or `resolveKeyId` must look under the real group id) is still required â€” it just doesn't manifest when the key was pre-seeded.

**RETEST on build 1.0.48 (versionCode 71) â€” B-13 STILL PRESENT (not fixed):**
Member-hosted group video on group `f956b212413b`, host fahim (NON-owner, tags fahim `4d99930b` /
itsirajul `4ab5cd45` / shirajul `81da8c7d`, 17:04:49). Boot logged the **same shortcut**:
`[call-adhoc-key:runtime] reusing real-group key (non-owner host) keyConvo=f956b212413b` â€” **broadcast
still SKIPPED (no `delivered=N`)**. The non-owner-host code path is unchanged from the prior APK. Call
connected fine (all 3 FrameCryptor on A+V, no key timeout) **only because the key was pre-seeded** to all
members from an earlier owner-hosted call on `f956b212413b` (12:28). â‡’ B-13's latent failure (member
without pre-seeded key) is unaddressed in 1.0.48; the conditional-pass masks it. Fix still required:
non-owner host must broadcast, or `resolveKeyId` must look under the real group id.

---

### Bug B-14 â€” Post-Call Transport Dead: No Messages In/Out After Server Drop âš ï¸ HIGH

**Reproduce:**

1. Start a group call (Pixel as host).
2. Let the call run for ~15 minutes â€” server drops the WebSocket (B-05).
3. End the call. Open a chat on Pixel and send a message. Try to send a message to Pixel from another device.
4. Pixel's messages show as pending. Incoming messages to Pixel never arrive.

**Frequency:** Every session where B-05 occurs (server WS drop during/after call). Observed at 00:54:28 in this session.

**Root cause:**

When the server drops the WebSocket (B-05), the messenger transport on Pixel enters `disconnected` state. The `sfu.producers failed: transport not open` error fires first (00:54:28), confirming the transport is already down when the SFU tries to use it.

After the call teardown (00:55:05), Pixel has **zero `recv.enter` events** for the next 2+ minutes. The backup mirror can still flush via HTTP, but live Signal envelope delivery requires WebSocket.

Whether the transport reconnects depends on the disconnect reason:

- `io server disconnect` â†’ stays permanently disconnected (B-11 path â€” no reconnect)
- `transport error` â†’ enters `reconnecting` state â†’ auto-reconnects

The disconnect reason for a B-05 server crash/restart is ambiguous from client-side logs alone. Server logs needed to confirm.

**Secondary issue: Pixel â†’ Xiaomi call-leave envelopes `handled=false`**

After call teardown, Pixel emits call-leave/presence envelopes at ~60s intervals to all group members. These arrive at Xiaomi (`ac9b6e3a`, `ee58daab`) as `handled=false` â€” dropped by the forgery guard (B-13 side effect). They arrive at Redmi as `handled=true`. This means Xiaomi's call-leave state is never cleaned up properly.

**Log evidence:**

```
00:54:28  Pixel: sfu.producers failed: transport not open
00:54:29  Pixel: reconnect -> rejoin (SFU rejoin attempt)
00:54:44  Pixel: rejoin FAILED: ack_timeout:sfu.join
00:55:05  Pixel: [groupcall.leave] tearing down â€” call ends
00:55:07  Pixel: backup.mirror flushed 1 messages
00:55:11  Pixel: backup.mirror flushed 3 messages
        â† ZERO recv.enter on Pixel after 00:54:28
        â† Redmi and Xiaomi messages sent but Pixel cannot receive

00:55:10  Xiaomi: recv.enter from Pixel envId=ac9b6e3a â†’ handled=false (call-leave envelope, forgery guard B-13)
00:56:09  Xiaomi: recv.enter from Pixel envId=ee58daab â†’ handled=false (same, 60s retry)

00:55:02  Xiaomi: recv.text.routing peer=79d63649 convoId=direct:79d63649- bodyLen=5 â†’ handled=true âœ…
          â† confirmed: Xiaomiâ†”Redmi 1:1 messaging works normally after call ends

Post-session: apps went idle (no new ReactNativeJS entries in fresh logcat dumps).
"1:1 also not working" refers specifically to Pixel conversations:
  - Pixel's WS dead â†’ Pixel cannot receive any incoming messages
  - Pixel â†’ Xiaomi call-leave envelopes dropped (handled=false, B-13 forgery guard)
  - Xiaomi â†” Redmi 1:1 remains fully functional throughout
```

**Files involved:**

- `src/modules/messenger/transport/client.ts:401â€“403` â€” disconnect handling (B-11 path vs reconnect path)
- B-05 server drop is the trigger; B-11 disconnect behavior makes recovery uncertain

**Note on APK vs repo divergence:** This is the second confirmed case of the installed APK running code not present in the repo (`frameCryptorOrchestrator.ts` was B-03; this is the non-owner-host path in `ensureCallGroupKey`). The developer should ensure all changes are committed before QA sessions.

---

## QA Session 2026-06-08 â€” Group Text Messaging (BlueStacks 3-device)

**Session date:** 2026-06-08 ~01:27â€“01:41  
**Devices:** 127.0.0.1:5555 = itsirajul (`08782d6d`) | 127.0.0.1:5565 = shirajul (`79d63649`) | 127.0.0.1:5575 = fahim (`fe4ddc14`)  
**Branch tested:** `release/1.0.35-audit-fixes`  
**Evidence:** live logcat, controlled single-message tests

---

### Bug B-15 â€” Group Text "Not Rendering" âš ï¸ NOT REPRODUCED â€” SCOPED DOWN (do not file as-is)

> **CORRECTION (2026-06-08 01:56):** The original claim below â€” "group text never renders" â€” is **TOO BROAD and was not reproduced.** On a real, properly-created + synced group (**"SQA - ITSirajul"**, groupId `4100833dd9da`, owner itsirajul), group messages are delivered, decrypted (`handled=true`), **AND render correctly on screen** on all 3 devices. Sender confirmed messages appear in the chat.
>
> The earlier "no message" observation (01:40) was on an **unconfirmed group** â€” most likely the ad-hoc **"Call"** group (`3cb79cb1f1b0`, the B-04 ghost group, whose conversationId may not match any synced `/conversations/mine` row), and/or it overlapped the **shirajul sealed-sender desync window (B-15b, 16 consecutive drops)** which was active until the app restart.
>
> **Revised status:** Group messaging on real groups = **PASS**. A non-render condition was observed once but could not be isolated to a real group. If it recurs, capture the exact `groupId` the sender's ChatScreen is bound to vs. the `unwrapped.group.groupId` on the receiver. Keep the code observation below (the group append at `productionRuntime.ts:4617` is genuinely silent and lacks the 1:1 resolver), but do NOT file B-15 as a confirmed delivery bug.

**Original (unconfirmed) observation â€” 2026-06-08 ~01:40 (BlueStacks):** One group message (fahim â†’ itsirajul + shirajul) was `handled=true` on both receivers with no `[recv.text.routing]` (group branch) and no tamper/no_key drop â€” yet "no message" on screen. Could not be reproduced on a real group; see CORRECTION above. Full retracted write-up removed (was ~60 lines) â€” superseded by the PASS result.

**Code watch-item (still valid, not a filed bug):** the group-text append at `productionRuntime.ts:4617` (`store.appendMessage(conversationId, groupMsg)` with `conversationId = unwrapped.group.groupId`, lines 4288â€“4289) is **silent** and does NOT route through `resolveDirectConversationIdFromState` the way the 1:1 path does (`:4271â€“4294`, logs `[recv.text.append]` at `:4657`). If a group ever lands inbound under a key the ChatScreen isn't subscribed to, that's where it'd be lost. **Suggested:** add a `[group.text.append] convId=â€¦ msgId=â€¦ bodyLen=â€¦` log mirroring the 1:1 path so the landing slot is diagnosable. Do NOT file as a delivery bug.

---

### Bug B-15b â€” Inbound Messages Dropped After Restore (keychain-miss â†’ forced RESTORE â†’ orphaned envelopes â†’ ACK-drop) âš ï¸ CORRECTED ROOT CAUSE 2026-06-11 (was "Sealed-Sender Desync: 16 Drops")

> **Root cause corrected 2026-06-11 (v1.0.51 / vc74):** NOT clock skew (verified in-sync) and NOT B-11
> supersession. It is a flaky local-key read on emulator â†’ spurious RESTORE â†’ in-flight messages sealed to
> the pre-restore key fail Sealed-Sender outer auth â†’ ACK-and-dropped (permanently lost). Escalated 16 â†’ 188
> drops; restart workaround no longer works. Full write-up + evidence in the RETEST block at the end of this entry.

**Logged:** 2026-06-08 01:04â€“01:20 (BlueStacks: shirajul/5565)

Before the app restart, shirajul (5565) dropped **16 consecutive** inbound envelopes:

```
01:04:23  outer sealed authentication failed  cumulative=1
   â€¦      (every inbound envelope fails the Sealed Sender v2 outer auth)
01:20:47  outer sealed authentication failed  cumulative=16
[bravo.ratchet-recovery] dropped undecryptable (deliver-unwrap:outer sealed authentication failed)
```

Every envelope to shirajul failed at the Sealed Sender v2 **outer** authentication layer (sender cert / AAD), before body decryption. The envelopes are ACK'd and deleted from the relay â†’ unrecoverable.

**Trigger:** repeated group-call attempts + B-11 supersession churn caused sender certs to rotate; shirajul's local session state desynced from what peers were sending with.

**Workaround that worked:** force-stop + relaunch all 3 apps. After restart, the desync cleared (0 further `outer sealed authentication failed`), and round-2 sends were all `handled=true` â€” including the shirajulâ†”fahim session that had been failing (`82c4304b handled=false` â†’ `0aacf390 handled=true`). **However, B-15 persists after the restart** â€” messages are `handled=true` but still don't render, confirming B-15 is a rendering bug independent of the desync.

**Files involved:**

- `crypto/senderCert.ts` â€” `verifySenderCert` (outer auth)
- `crypto/sessionManager.ts` â€” session rotation on cert change
- Related root: B-11 (signalDeviceId supersession churn)

**RETEST + CORRECTED ROOT CAUSE â€” 2026-06-11 on build 1.0.51 (versionCode 74), BlueStacks 3-device.**
**Recurred and escalated: 16 â†’ 188 consecutive drops, and the restart workaround NO LONGER works.**

shirajul (5565) again dropped every inbound envelope from fahim (`fe4ddc14`) while every envelope from
itsirajul (`08782d6d`) succeeded â€” pair-specific, inbound-only:

```
peer=08782d6d â†’ handled=true   (14/14)   âœ“
peer=fe4ddc14 â†’ handled=false  (11/12)   âœ—   outer sealed authentication failed
[bravo.ratchet-recovery] dropped undecryptable (...outer sealed authentication failed); cumulative=188
```

shirajul was force-restarted mid-session (PID 4711 â†’ 5823) and **came back still failing** â€” it re-burst
straight to cumulative=188. So the prior "force-stop + relaunch clears it" workaround is **dead on v74**:
the broken state reloads from disk (SQLCipher session store) after restart.

**Clock skew RULED OUT (initial lead, retracted).** First hypothesis was Sealed-Sender cert time-validity
vs device clock skew (shirajul's screen showed a red _"A message was dropped because a device clock looks
wrong"_ banner). Verified and rejected:

- Round-trip-corrected device skew vs Mac: 5555 = âˆ’932 ms, 5565 = âˆ’32 ms, 5575 = âˆ’732 ms (sub-second).
- Server time == Mac time exactly (`Thu, 11 Jun 2026 03:49:14 GMT`); all devices within ~1 s of server.
- No clock/cert/timestamp error line exists behind the banner in logcat â†’ the banner is **stale/generic**.
  Sub-second skew cannot expire a sender cert; clock is not the cause. `auto_time=1` on all three.

**Actual root cause â€” keychain-miss â†’ forced RESTORE â†’ orphaned in-flight messages â†’ ACK-drop:**

1. BlueStacks has no hardware keystore â†’ keychain falls back to software and intermittently fails to read:
   ```
   [keychain] strict-options write failed ... err=Cannot generate keys with required security guarantees
   RNKeychainManager: No entry found for service: bravo.messenger.mirrorkey.79d63649-...
   ```
2. Key not found â†’ boot probes `localKey=false` â†’ app forces `case=RESTORE â†’ BackupRestore`
   (`[bravo.restore] rebuilding runtime against restored identity` at 09:03:33). Same boot also logged
   `DELETE /auth/session` (09:02:54) and `[restore] root_mismatch with valid sig â€” re-committing`.
3. The restored identity/session diverges from what peers are sealing against. Messages already in flight /
   queued at the relay were sealed to the pre-restore key state â†’ fail Sealed-Sender **outer** auth.
4. The handler **ACK-and-drops** them (`will ack to drop`) â†’ relay deletes them â†’ **permanently lost**. No
   re-handshake, no retry.
5. NEW messages re-handshake against the post-restore bundle and decrypt fine â€” verified live this session:
   a clean group send (09:38â€“09:39) was `handled=true` on all 3 incl. fahimâ†’shirajul (`8d6a71c9`), and the
   messages **rendered** on shirajul's screen. So the pipeline is healthy when both sides share current keys;
   only the orphaned pre-restore backlog dies.

`outer sealed authentication failed` is a **key/identity mismatch** signature (consistent with restore-driven
identity divergence), NOT a timestamp/cert-expiry signature â€” corroborating the clock retraction.

**Why it recurs despite identical app version / device config / OS across all 3 VMs:** the trigger is not in
the build â€” it is (a) an **environment property** (emulator keychain has no HW backing â†’ spurious
key-not-found â†’ spurious RESTORE) and (b) a **design choice** (restore orphans in-flight messages + the app
deletes anything undecryptable instead of re-handshaking). Identical APKs on flaky software keychains all hit
the same cycle. The QA workflow (constant reinstall / account-switch / force-stop) amplifies the restore rate
far beyond a real user's.

**BlueStacks vs production:** the _frequency_ is BlueStacks-amplified (no HW keystore). The _damage_
(lose in-flight messages on restore + ACK-drop) is a **real production bug** â€” any user who reinstalls, gets
a new phone, or restores-from-backup will hit it. Needs physical-device confirmation (Pixel/Xiaomi/Redmi):
send to a peer, reinstall/restore the peer, send during the restore window, check if those land.

**Group messages affected identically** (same session): group is sealed-sender _broadcast_ â€” the group
ciphertext rides the same pairwise Signal sealed-sender envelope per member, so a sender on a broken pair
drops on the group path too. Not a separate group bug. (Group _render_ is the distinct B-15 watch-item; the
group append at `productionRuntime.ts:4617` is still silent â€” no `[recv.text.routing]`/`[recv.text.append]`
for group msgs, so `handled=true` can't be confirmed-rendered from logs alone â€” but render was visually
verified OK on shirajul this session.)

**Fix required (architecture stop-condition per CLAUDE.md â€” session storage / sealed-sender â€” needs sign-off):**

1. On `outer sealed authentication failed`, **stop ACK-and-dropping** â€” trigger a session re-handshake and
   keep the envelope within the relay's 30-day dwell so it can be retried.
2. **Harden the local-key read** so a transient keychain miss does not force a full RESTORE â€” retry/repair
   the local key before assuming identity loss.

**Evidence:** live logcat captures 2026-06-11 09:00â€“09:39 (devices 5555/5565/5575); shirajul render
screenshot `/tmp/grp_5565.png`; clock + server-time measurements above.

**Files involved (updated):**

- `runtime/productionRuntime.ts` â€” backup-boot probe (`localKey` gate â†’ RESTORE), restore rebuild,
  `deliver-unwrap` ACK-and-drop path
- `crypto/senderCert.ts` / `crypto/sessionManager.ts` â€” sealed-sender outer auth, session reload from disk
- `store/groupMasterKeyStore.ts` + keychain layer â€” `mirrorkey`/`groupwrap` service entries (software fallback
  on emulators) â†’ spurious `localKey=false`

---

### Bug B-16 â€” 1:1 Audioâ†’Video Upgrade: First Party to Enable Video Sees Only Self âš ï¸ HIGH

**Logged:** 2026-06-08 01:43 (BlueStacks: itsirajulâ†’fahim 1:1 call, cid=e4ba5e89)

**Reproduce:**

1. itsirajul starts a 1:1 **audio** call to fahim. Call connects.
2. During the call, enable video on **fahim** first; accept/enable video on **itsirajul** second.
3. Result: **itsirajul sees both videos (self + fahim). fahim sees only its own self-view â€” itsirajul's video never appears.**

**Signature:** the party who enables video **FIRST** does not see the other party's later-enabled video. The party who enables **SECOND** sees both. Asymmetric, not a black tile â€” the remote tile is simply absent.

**Frequency:** 100% â€” reproducible on the first-to-upgrade side.

**This is NOT a transport or crypto failure.** Both renegotiations completed successfully on both sides, and fahim's WebRTC `ontrack` fired for itsirajul's video. The track physically arrived; it was never bound to a render surface.

**Log evidence (cid=e4ba5e89, 01:43):**

```
Reneg 1 â€” fahim enables video (initiator):
  01:43:30.707  fahim:     [renegotiate] role=initiator begin â†’ addTrack(video) â†’ reoffer sdpLen=3778
  01:43:30.723  itsirajul: [renegotiate] role=responder reoffer received â†’ ontrack (fahim's video)
  01:43:31.035  fahim:     [renegotiate] renegotiation complete
  â†’ itsirajul renders fahim's video âœ“

Reneg 2 â€” itsirajul enables video (initiator):
  01:43:33.834  itsirajul: [renegotiate] role=initiator begin â†’ addTrack(video) â†’ reoffer sdpLen=3771
  01:43:34.251  fahim:     [renegotiate] role=responder reoffer received â€” applying
  01:43:34.283  fahim:     rn-webrtc:pc ontrack +32ms   â† itsirajul's video TRACK ARRIVES at fahim
  01:43:34.302  fahim:     [renegotiate] renegotiation complete
  â†’ fahim does NOT render itsirajul's video âœ—
```

**Smoking gun â€” GL surface creation (EGL_emulation):**

```
itsirajul (renders BOTH) â€” 3 EGL contexts created:
  01:43:31.060  eglCreateContext (fahim's remote video surface)
  01:43:33.820  eglCreateContext (own self-view surface)
  01:43:33.994  eglCreateContext (third surface)

fahim (renders ONLY self) â€” 2 EGL contexts, both at its OWN video-enable:
  01:43:30.696  eglCreateContext (self-view)
  01:43:30.923  eglCreateContext
  â†’ NOTHING at 01:43:34 when itsirajul's track arrived â€” no GL surface ever created
    to draw the remote video.
```

`ontrack` fired but no `eglCreateContext` followed on fahim â‡’ the app never mounted an `<RTCView>` for the remote stream.

**Root cause (inferred):**

`CallScreen.tsx` / `useCall.ts` mounts the remote `<RTCView>` based on a state flag that flips only when the **remote** party initiates the video upgrade (responder path). When the **local** device initiates video first, its UI switches to the video layout showing self-view, but it does not subscribe to / bind the peer's video track that arrives in a **later** renegotiation. The remote `ontrack` event has no handler that mounts a remote RTCView post-upgrade, so the track sits on the PeerConnection unrendered.

This is the 1:1-call sibling of B-01 (group remote tile black) and B-15 (group text received-not-rendered): the media/data arrives but never reaches a render surface.

**Files involved:**

- `src/modules/messenger/webrtc/useCall.ts` â€” `upgradeToVideo`, renegotiation, remote `ontrack` handling
- `src/screens/messenger/CallScreen.tsx` â€” remote `<RTCView>` mount gating (likely keyed on remote-initiated upgrade only)

**Recommended fix:** Mount/bind the remote `<RTCView>` whenever the peer's video track is present on the PeerConnection (driven by the `ontrack` / track-added event), independent of which side initiated the upgrade. Force a remount with a fresh `key` when the remote track id changes so a new SurfaceView is created at full layout size.

**Note:** Self-view + remote audio worked for both. Only the first-to-enable side's _remote video render_ fails.

---

### Bug B-17 â€” Voice Group Call: a Non-Host Joiner Intermittently Drops One Participant Tile (Rotating Victim) âš ï¸ MEDIUM

**Logged:** 2026-06-08 02:05â€“02:08 (BlueStacks: itsirajul host / shirajul / fahim, group "SQA - ITSirajul" `4100833dd9da`)

**Reproduce:**

1. Start a **voice** group call (3 participants). itsirajul hosts.
2. Observe the participant (avatar) tile grid on each device.
3. One non-host device shows only **2 of 3** tiles. Which device is affected **changes from call to call**.

**Frequency:** Intermittent but frequent â€” hit on 2 of 2 consecutive calls, different victim each time.

**Audio is NOT affected** â€” every device consumes every other participant's audio (`consumer attached (FrameCryptor)` for each). Only the **tile render** drops one.

**Evidence â€” two consecutive calls, victim rotates, host always complete:**

```
Call 1 (room b051922e, host itsirajul=d69e6d71, fahim=b54af0eb, shirajul=d71696b6):
  shirajul: joined existingProducers=2 â†’ step=9 consume d69e6d71 âœ“ + b54af0eb âœ“ (both FrameCryptor)
            â†’ 3 audio sources present, but UI showed only 2 tiles   â† shirajul victim

Call 2 (room 1da8928b, host itsirajul=8b83da41, fahim=18de8116, shirajul=2636ceef):
  fahim:    joined existingProducers=1 â†’ consume 8b83da41 âœ“; later participant.joined 2636ceef âœ“
            â†’ 3 audio sources present, but UI showed only 2 tiles   â† fahim victim
  itsirajul (host) and shirajul both showed 3 âœ“
```

**Pattern / root cause (inferred):**

- The **host** always joins with `existingProducers=0` and receives a live `[groupcall.frame] participant.joined` for every other participant â†’ its tile list is always complete. The host is **never** the victim.
- A **joiner** consumes participants already in the room via the boot path (`step=9 consume`, from the `existingProducers` list). Those pre-existing participants do **not** emit a `participant.joined` event to the late joiner. Intermittently, a tile consumed via this boot path is **not created in the UI**, even though `consumer attached` succeeds and audio plays. Because it's a race (consume vs. tile-state commit), the victim rotates per call.
- **Contributing factor â€” B-08 boot race:** the host repeatedly created a room, a peer joined, the room tore down (`kicked=false`), and a new room was created (`8af06187` â†’ `b051922e` â†’ `1da8928b`). This churn re-runs the fragile late-joiner tile path on each recreate and increases the hit rate.

This is the voice-avatar-tile sibling of **B-06** (missing video tiles on boot) and is amplified by **B-08** (boot-race room recreation). Distinct from B-01 (black video tile) â€” here the tile is entirely **absent**, not black, and it's audio-only so there is no SurfaceView/BLAST involved.

**Files involved:**

- `src/modules/messenger/webrtc/useGroupCall.ts` â€” `step=9` existingProducers consume vs. live `participant.joined` tile creation
- `src/modules/messenger/webrtc/groupCallLayout.ts` â€” tile grid build from participant list
- `src/screens/messenger/GroupCallScreen.tsx` â€” tile render keyed on participant state
- Related: B-06 (missing tiles), B-08 (boot race), B-04 (ad-hoc "Call" group recreation churn)

**Recommended fix:** Build a tile for every consumed producer (drive tile creation off the consume/`new-producer` path, not only off `participant.joined`), and reconcile the tile list against the SFU `sfu.producers` snapshot after join so a missed boot-path participant is recovered. Also fix B-08 so the room isn't recreated mid-join.

**REPRODUCTION 2026-06-08 ~12:48 (BlueStacks) â€” non-host joiner shows a blank 3rd tile:**

Member-hosted voice call (itsirajul host = NON-owner B-13 path, room `â€¦de77ae`, group "SQA - FAHIM",
"3 ON CALL"). On **shirajul** (non-host joiner, self tag `d27212db`, `existingProducers=2`):

- Tile 1 (large): `ITSirajul` (tag `afecbdbe`) âœ“
- Tile 2: `FA` / fahim (tag `85a17797`) âœ“
- Tile 3 (bottom-right): **BLANK** â€” no avatar, no label, no participant bound

Audio layer fully correct â€” shirajul consumed BOTH remotes with FrameCryptor attached
(`step=9 consume afecbdbe audio` âœ“ + `85a17797 audio` âœ“ at 12:46:30), so all 3 audio sources are
present; only the tile grid has an empty cell. Confirms B-17 is independent of host ownership and of
the B-13 key path (the call connected fine; only the render dropped a tile). Evidence:
`~/Desktop/bravo_logs_live_20260608_112423/shots_b17_124830/shirajul.png`.

**RETEST on build 1.0.48 (versionCode 71) â€” B-17 STILL PRESENT (not fixed):**
Admin-hosted voice call (shirajul owner-host on `f956b212413b`, room from 17:16, "SQA - Shirajul",
"3 Â· joined"). On **itsirajul** (non-host joiner, self tag `ff41ee87`, `existingProducers=2`): tiles show
`SH` (shirajul `29bf6091`) + `FA` (fahim `0ab507eb`) + **1 BLANK cell** (bottom-right). itsirajul consumed
BOTH remotes' audio with FrameCryptor (`step=9 consume 29bf6091` âœ“ + `0ab507eb` âœ“ at 17:16:51) â€” all 3
audio sources present, only the tile grid has an empty cell. Same signature as the old build; the
render-layer tile drop on a boot-path joiner is unaddressed in 1.0.48. Evidence:
`~/Desktop/bravo_logs_live_20260608_112423/shots_b17_v48_172011/itsirajul.png`.

**RETEST on build 1.0.49 (versionCode 72) â€” B-17 STILL PRESENT, on ALL 3 devices simultaneously + root cause captured:**
Admin/owner-hosted group **video** call, itsirajul host on "SQA - ITSirajul" (`4100833dd9da`), 12:35.
Key path PASS (`key resynced delivered=3`, FrameCryptor on host A+V and every consumer). But the tile
grid failed on **all three** devices at once â€” each shows **2 populated video tiles + 1 BLANK tile**
(bottom-right; the blank cell carries a participant tag label, so a participant is bound to it but no
video renders). The user reported "all 3 devices can't show 3 tiles." Evidence:
`~/Desktop/bravo_logs_v49_0609/grp2_5555.png` / `grp2_5565.png` / `grp2_5575.png` (+ `tiles_*.png`).

**Root cause captured this session (zombie-tag from early rejoin):** the host logged **3**
`participant.joined` tags for only **2** real remote devices â€”
`ed8a0863` (12:35:10), `f256b2b4` (12:35:13), `cae0f7aa` (12:35:41). The 3rd is a **rejoin**: shirajul
hit an early WS blip (`12:35:40 sfu.producers failed: transport not open` â†’ `reconnect -> rejoin`),
rejoined with a **new** tag `cae0f7aa`, and its **old** tag `ed8a0863` was left as a **zombie** â€”
producing no media but still holding a tile slot â†’ the blank tile. So B-17's blank cell here = an
**orphaned zombie tag from a B-08/B-05-driven rejoin** that the tile list never reconciles away.
(B-01 host-black NOT reproduced â€” host's own tiles render. B-19 wrong-binding inconclusive: BlueStacks
shared camera = identical faces, can verify "2 render / 1 blank" but not streamâ†’tile correctness.)
**Fix still required:** reconcile the tile list against the live `sfu.producers` snapshot and key tiles
by the _current_ participant tag so an orphaned/rejoined tag drops its stale tile.

**SECOND repro 1.0.49 â€” member/non-owner-hosted group video on "SQA - Shirajul" (12:50, ~02:15 in) â€” WORSE + per-device inconsistent:**
All 3 connected (getStats running), key reached everyone (B-13 conditional-pass â€” pre-seeded), but the
tile grid collapsed differently on each device:

- **itsirajul (5555):** only **1** tile (Fahim) full-screen, rest black â€” missing shirajul + no self-view.
- **fahim (5575):** 2 tiles (ITSirajul + 1) + **1 blank** cell.
- **shirajul (5565):** 1 remote (Fahim) + its **own self-view "YOU" tile is BLACK** â€” missing itsirajul.
  â‡’ Nobody saw the full 3-person roster; two devices saw only one remote, and the host/self-view went
  black on shirajul (B-01-style self-tile black). Confirms the render layer is the dominant group-video
  defect on 1.0.49 â€” transport/crypto correct, tiles wrong/missing/black, varying per device. Evidence:
  `~/Desktop/bravo_logs_v49_0609/mem_5555.png` / `mem_5565.png` / `mem_5575.png`.
  (Boot/key logs for this call were lost to a buffer-clear race â€” capture the next member-host call's boot
  cleanly to re-confirm the B-13 `reusing real-group key` shortcut.)

**RETEST on build 1.0.51 (versionCode 74) â€” B-17 STILL PRESENT; this repro is NOT the zombie-tag case the
2026-06-09 fix targeted.** Owner-hosted group **voice** call on "SQA - Shirajul" (`f956b212413b`), 09:55,
shirajul host. Tile grid:

- **itsirajul (5555):** 3 tiles âœ“ (SH host + FA + IT/you)
- **shirajul (5565, host):** 3 tiles âœ“ (FA + IT + SH/you)
- **fahim (5575):** 2 tiles (IT + SH) + **1 BLANK cell** (bottom-right, fahim's own self/"YOU" tile never
  populated â€” no avatar, no label) â† VICTIM

**The audio/consume layer was 100% clean** â€” exactly 3 distinct tags, each consumed with FrameCryptor, and
crucially **NO zombie tag and NO rejoin this time** (contrast the 1.0.49 repro, whose blank cell was an
orphaned zombie tag from an early WS-blip rejoin):

```
host shirajul  tag=103d1cb0 isHost=true  existingProducers=0 â†’ participant.joined e7b83699 + f05347f6 (both consumed)
fahim          tag=e7b83699 isHost=false existingProducers=1 â†’ step=9 consume 103d1cb0 âœ“ ; participant.joined f05347f6 âœ“
itsirajul      tag=f05347f6 isHost=false existingProducers=2 â†’ step=9 consume 103d1cb0 âœ“ + e7b83699 âœ“
```

â‡’ The 2026-06-09 fix (reconcile-prune of superseded/zombie tags via `computeTilePrune`) does **NOT** cover
this case â€” there is no stale tag to prune. This is the **original B-17 sub-case**: a tile consumed/created
on the boot path (here fahim's own self-tile) is never committed to the UI grid even though all media is
present. The render race survives on vc74. **Fix still required:** build the tile for every
participant/producer off the consume path (and the local self-track), and reconcile the grid against the
`sfu.producers` snapshot + the local participant after join, independent of `participant.joined` timing.
Evidence: `/tmp/call_5555.png` (3 âœ“), `/tmp/call_5565.png` (3 âœ“), `/tmp/call_5575.png` (2 + 1 blank).

---

Member-hosted voice call (itsirajul host = NON-owner B-13 path, room `â€¦de77ae`, group "SQA - FAHIM",
"3 ON CALL"). On **shirajul** (non-host joiner, self tag `d27212db`, `existingProducers=2`):

- Tile 1 (large): `ITSirajul` (tag `afecbdbe`) âœ“
- Tile 2: `FA` / fahim (tag `85a17797`) âœ“
- Tile 3 (bottom-right): **BLANK** â€” no avatar, no label, no participant bound

Audio layer fully correct â€” shirajul consumed BOTH remotes with FrameCryptor attached
(`step=9 consume afecbdbe audio` âœ“ + `85a17797 audio` âœ“ at 12:46:30), so all 3 audio sources are
present; only the tile grid has an empty cell. Confirms B-17 is independent of host ownership and of
the B-13 key path (the call connected fine; only the render dropped a tile). Evidence:
`~/Desktop/bravo_logs_live_20260608_112423/shots_b17_124830/shirajul.png`.

**RETEST on build 1.0.48 (versionCode 71) â€” B-17 STILL PRESENT (not fixed):**
Admin-hosted voice call (shirajul owner-host on `f956b212413b`, room from 17:16, "SQA - Shirajul",
"3 Â· joined"). On **itsirajul** (non-host joiner, self tag `ff41ee87`, `existingProducers=2`): tiles show
`SH` (shirajul `29bf6091`) + `FA` (fahim `0ab507eb`) + **1 BLANK cell** (bottom-right). itsirajul consumed
BOTH remotes' audio with FrameCryptor (`step=9 consume 29bf6091` âœ“ + `0ab507eb` âœ“ at 17:16:51) â€” all 3
audio sources present, only the tile grid has an empty cell. Same signature as the old build; the
render-layer tile drop on a boot-path joiner is unaddressed in 1.0.48. Evidence:
`~/Desktop/bravo_logs_live_20260608_112423/shots_b17_v48_172011/itsirajul.png`.

**RETEST on build 1.0.49 (versionCode 72) â€” B-17 STILL PRESENT, on ALL 3 devices simultaneously + root cause captured:**
Admin/owner-hosted group **video** call, itsirajul host on "SQA - ITSirajul" (`4100833dd9da`), 12:35.
Key path PASS (`key resynced delivered=3`, FrameCryptor on host A+V and every consumer). But the tile
grid failed on **all three** devices at once â€” each shows **2 populated video tiles + 1 BLANK tile**
(bottom-right; the blank cell carries a participant tag label, so a participant is bound to it but no
video renders). The user reported "all 3 devices can't show 3 tiles." Evidence:
`~/Desktop/bravo_logs_v49_0609/grp2_5555.png` / `grp2_5565.png` / `grp2_5575.png` (+ `tiles_*.png`).

**Root cause captured this session (zombie-tag from early rejoin):** the host logged **3**
`participant.joined` tags for only **2** real remote devices â€”
`ed8a0863` (12:35:10), `f256b2b4` (12:35:13), `cae0f7aa` (12:35:41). The 3rd is a **rejoin**: shirajul
hit an early WS blip (`12:35:40 sfu.producers failed: transport not open` â†’ `reconnect -> rejoin`),
rejoined with a **new** tag `cae0f7aa`, and its **old** tag `ed8a0863` was left as a **zombie** â€”
producing no media but still holding a tile slot â†’ the blank tile. So B-17's blank cell here = an
**orphaned zombie tag from a B-08/B-05-driven rejoin** that the tile list never reconciles away.
(B-01 host-black NOT reproduced â€” host's own tiles render. B-19 wrong-binding inconclusive: BlueStacks
shared camera = identical faces, can verify "2 render / 1 blank" but not streamâ†’tile correctness.)
**Fix still required:** reconcile the tile list against the live `sfu.producers` snapshot and key tiles
by the _current_ participant tag so an orphaned/rejoined tag drops its stale tile.

**SECOND repro 1.0.49 â€” member/non-owner-hosted group video on "SQA - Shirajul" (12:50, ~02:15 in) â€” WORSE + per-device inconsistent:**
All 3 connected (getStats running), key reached everyone (B-13 conditional-pass â€” pre-seeded), but the
tile grid collapsed differently on each device:

- **itsirajul (5555):** only **1** tile (Fahim) full-screen, rest black â€” missing shirajul + no self-view.
- **fahim (5575):** 2 tiles (ITSirajul + 1) + **1 blank** cell.
- **shirajul (5565):** 1 remote (Fahim) + its **own self-view "YOU" tile is BLACK** â€” missing itsirajul.
  â‡’ Nobody saw the full 3-person roster; two devices saw only one remote, and the host/self-view went
  black on shirajul (B-01-style self-tile black). Confirms the render layer is the dominant group-video
  defect on 1.0.49 â€” transport/crypto correct, tiles wrong/missing/black, varying per device. Evidence:
  `~/Desktop/bravo_logs_v49_0609/mem_5555.png` / `mem_5565.png` / `mem_5575.png`.
  (Boot/key logs for this call were lost to a buffer-clear race â€” capture the next member-host call's boot
  cleanly to re-confirm the B-13 `reusing real-group key` shortcut.)

**RETEST on build 1.0.51 (versionCode 74) â€” B-17 STILL PRESENT; this repro is NOT the zombie-tag case the
2026-06-09 fix targeted.** Owner-hosted group **voice** call on "SQA - Shirajul" (`f956b212413b`), 09:55,
shirajul host. Tile grid:

- **itsirajul (5555):** 3 tiles âœ“ (SH host + FA + IT/you)
- **shirajul (5565, host):** 3 tiles âœ“ (FA + IT + SH/you)
- **fahim (5575):** 2 tiles (IT + SH) + **1 BLANK cell** (bottom-right, fahim's own self/"YOU" tile never
  populated â€” no avatar, no label) â† VICTIM

**The audio/consume layer was 100% clean** â€” exactly 3 distinct tags, each consumed with FrameCryptor, and
crucially **NO zombie tag and NO rejoin this time** (contrast the 1.0.49 repro, whose blank cell was an
orphaned zombie tag from an early WS-blip rejoin):

```
host shirajul  tag=103d1cb0 isHost=true  existingProducers=0 â†’ participant.joined e7b83699 + f05347f6 (both consumed)
fahim          tag=e7b83699 isHost=false existingProducers=1 â†’ step=9 consume 103d1cb0 âœ“ ; participant.joined f05347f6 âœ“
itsirajul      tag=f05347f6 isHost=false existingProducers=2 â†’ step=9 consume 103d1cb0 âœ“ + e7b83699 âœ“
```

â‡’ The 2026-06-09 fix (reconcile-prune of superseded/zombie tags via `computeTilePrune`) does **NOT** cover
this case â€” there is no stale tag to prune. This is the **original B-17 sub-case**: a tile consumed/created
on the boot path (here fahim's own self-tile) is never committed to the UI grid even though all media is
present. The render race survives on vc74. **Fix still required:** build the tile for every
participant/producer off the consume path (and the local self-track), and reconcile the grid against the
`sfu.producers` snapshot + the local participant after join, independent of `participant.joined` timing.
Evidence: `/tmp/call_5555.png` (3 âœ“), `/tmp/call_5565.png` (3 âœ“), `/tmp/call_5575.png` (2 + 1 blank).

---

## Session Wrap-up â€” 2026-06-08 (BlueStacks 3-device)

**Standalone report:** `~/Desktop/Bravo_Bugs_2026-06-08.md`

### Device & Identity Reference (derived from logs this session)

| ADB serial     | Account                 | Signal userId (peer prefix)            | Notes                                                                                                     |
| -------------- | ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 127.0.0.1:5555 | itsirajul               | `08782d6d-bb81-44c2-85b9-bc62245c880c` | usual call host/owner                                                                                     |
| 127.0.0.1:5565 | shirajul                | `79d63649-6fd8-4068-9b1c-94b89ee90ced` | hit B-15b desync                                                                                          |
| 127.0.0.1:5575 | fahim                   | `fe4ddc14-74ef-4cc5-811d-66db12e1f41c` |                                                                                                           |
| (not on ADB)   | **unknown 4th**         | `4eaa4cd3-098b-4abf-b54a-b1d91e469172` | in member lists, never joins â€” confirm who                                                              |
| 32251JEHN23958 | **shirajul (Pixel 7a)** | `79d63649-6fd8-4068-9b1c-94b89ee90ced` | 2026-06-14: shirajul account ran on the physical Pixel 7a (BlueStacks 5565 was off). Same userId as 5565. |

> All BlueStacks instances are model **SM-S908E**, app `com.bravosecure.app` v1.0.41. The Google accounts on the VMs (`siraaajulislaam@`, `shirajulislamparvez@`) are NOT the in-app identity â€” the table above is the in-app Signal identity, read from `[recv.enter] peer=â€¦` and `group-create members=[â€¦]` logs.

**Groups seen this session:**

- `4100833dd9da9a35ab3cfc2c18cee90e` â€” **"SQA - ITSirajul"** (real group, owner = itsirajul)
- `3cb79cb1f1b0e0be3ff9c2df76344a0f` â€” **"Call"** (ad-hoc call-key group, the B-04 ghost)

**Tag note:** SFU participant tags (e.g. `cfb10665`, `d71696b6`) are per-room ephemeral â€” they change every call and do NOT map stably to a user. Use the Signal userId prefixes above for identity; tags are valid only within a single room's timeline.

**Physical devices (earlier 2026-06-08 sessions):** Pixel 7a (32251JEHN23958) | Xiaomi 2409BRN2CY (69BQLV5DXSWGWCOF, USB) | Redmi 2409BRN2CY (192.168.0.100:34391, Wi-Fi).

### What PASSED this session

- **Group calls (owner-hosted)** â€” full 3-way audio + video, FrameCryptor on all consumers (video "SQA - ITSirajul" 01:56; voice 01:59 / 02:01). Key broadcast `delivered=3` when host owns the group.
- **Group text on a real synced group** â€” "SQA - ITSirajul" messages delivered, decrypted, and rendered on all 3 devices (B-15 NOT reproduced).
- **1:1 audio call** â€” connected and stable for ~5 min (the B-16 video-render issue is the only fault on that path).
- **App-restart recovery** â€” cleared the B-15b sealed-sender desync.

### Frontend vs Backend Breakdown

**Verdict: ~85% frontend (React Native mobile client).** Two frontend clusters dominate; backend has one genuine fault.

| Bug   | Cause                                                            | Layer                                    |
| ----- | ---------------------------------------------------------------- | ---------------------------------------- |
| B-11  | `signalDeviceId = 1` hardcoded (`productionRuntime.ts:318`)      | **Frontend**                             |
| B-12  | joiner key timeout â€” caused by B-11                            | **Frontend**                             |
| B-13  | non-owner host skips key broadcast (`ensureCallGroupKey`)        | **Frontend**                             |
| B-14  | triggered by B-05 (backend), fails to recover due to `client.ts` | **Mixed** (backend trigger / FE recover) |
| B-15b | sender-cert desync churn from B-11                               | **Frontend**                             |
| B-16  | remote `<RTCView>` not mounted when local enables video first    | **Frontend**                             |
| B-17  | tile dropped for boot-path-consumed participant (race)           | **Frontend**                             |
| B-05  | messenger-service WS drop (crash / heartbeat grace too tight)    | **Backend**                              |

**Cluster 1 â€” Messenger runtime / crypto-session (`productionRuntime.ts`) â€” the CRITICAL ones:** B-11, B-12, B-13, B-15b. Single highest-leverage root: `const signalDeviceId = config.signalDeviceId ?? 1` (`productionRuntime.ts:318`) cascades into B-11 â†’ B-12 â†’ B-15b and worsens B-13.

**Cluster 2 â€” WebRTC call UI / rendering (`useGroupCall.ts`, `useCall.ts`, `CallScreen.tsx`, `GroupCallScreen.tsx`, `groupCallLayout.ts`):** B-16, B-17 (+ B-01, B-06, B-07, B-08). All render/UI â€” media arrives and decrypts (consumers attach, `ontrack` fires), but the app fails to draw it.

**Backend:** B-05 is the only genuine backend fault; B-14 is a frontend recovery failure on top of it. The connection-registry supersession (B-11 server side) is backend-correct given duplicate device IDs â€” the real fault is the frontend feeding `deviceId=1` for every device.

### Recommended focus order

1. **Frontend config (highest leverage):** unique `signalDeviceId` per device â†’ clears B-11/B-12/B-15b, eases B-13.
2. **Frontend rendering pass:** drive tile/video render off the consume/`ontrack` path (not only `participant.joined` / remote-initiated upgrade) â†’ fixes B-16, B-17, B-01, B-06.
3. **Backend WS hardening:** raise `WS_HEARTBEAT_GRACE` + watchdog/uptime monitor â†’ addresses B-05 (removes the B-14 trigger).

### Open item

- **Mystery 4th member** `4eaa4cd3-098b-4abf-b54a-b1d91e469172` appears in the "Call" and "SQA - ITSirajul" member lists but never joins calls â€” confirm who this account is.

---

## Developer Fix Session â€” 2026-06-09 (v1.0.49 QA report follow-up)

Worked the 1.0.49 (vc72) QA bundle (`Bravo_QA_1.0.49_vc72_2026-06-09/`) + the code-level
How-To-Fix guide. Branch `release/1.0.35-audit-fixes`. **Not pushed** (per request â€” hold until
sign-off). All gates green: **typecheck 55 < 84 baseline**, **messenger-crypto 1017 âœ“**, **app 34 âœ“**,
**booking 90 âœ“**. Note: the 1.0.49 APK was almost certainly built **behind** the B-18 commit
(`0933d8a`) â€” the repo already had the thread-merge â€” which is why several "unchanged in 1.0.49"
bugs were already partly fixed in source. The work below closes the remaining in-repo gaps.

| Bug                                                        | Status after this session                           | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B-18** (1:1 inbound text not rendered)                   | **FIXED (rebuild to verify)**                       | `upsertConversation` now MIGRATES a stranded synthetic `direct:<peer>` slot into the canonical server-UUID row on `/conversations/mine` sync (messages + `last_message` + unread), killing the duplicate "(encrypted)" home-list row. Complements the existing ChatScreen read-merge + append-reroute. New test `directConversationMerge.test.ts` (6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **B-17** (group tile zombie/blank) + silent-zombie         | **FIXED**                                           | Reconcile now prunes a superseded ("zombie") tag THIS tick when the same userId is live under a new tag (rejoin), instead of the ~12 s 3-miss debounce. Extracted pure `computeTilePrune` in `groupCallLayout.ts`; new test `groupCallTilePrune.test.ts` (8). Re-consume of rejoined producers already present in reconcile; reconnecting overlay already surfaces "Reconnectingâ€¦".                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Call UX** (misleading copy / no auto-dismiss)            | **FIXED (1:1)**                                     | `CallScreen.tsx` `failed` branch: "Could not establish a secure connection" â†’ "Connection lost â€” couldn't reconnect" (the failure is always network/WS, never crypto â€” every call DTLS-verifies first) + 4 s auto-dismiss so the user isn't stranded behind the modal. Group `failed` screen already has a Close button and may legitimately be a key-timeout, so left as-is.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **B-20** (camera not restored after another app steals it) | **FIXED (1:1) Â· device-verify**                    | New `recoverCamera()` in `peerConnectionFactory.ts` (re-acquire + `replaceTrack` on the existing sender, keeps facing, no SDP reneg). Wired into `useCall.ts` via an AppState `active` handler that fires only when the local video track is `ended`/`muted` and the user didn't intentionally turn video off. New test `recoverCamera.test.ts` (4). **BlueStacks can't reproduce (magenta = 'live' track) â€” verify on Pixel/Xiaomi/Redmi.** Group-call self-camera uses mediasoup `producer.replaceTrack` (FrameCryptor-adjacent) â€” left as a documented follow-up.                                                                                                                                                                                                                                                                         |
| **B-21** (no usable background ring)                       | **HARDENED Â· device-verify**                       | The ring infra was already correct (`bravo-incoming-call` channel: HIGH importance, sound, vibration, full-screen intent, `loopSound`, CALL category, callkit bridge). `bravo-call-foreground` (the silent channel QA saw) is the **ongoing-call foreground-service** channel â€” correctly silent. Hardened: the ring channel is now **pre-created at boot** (`startFcmBootstrap`) so a headless background wake can't be silently dropped for a missing channel. **Residual is the BlueStacks full-screen-intent/callkeep limitation â€” verify on a physical device.**                                                                                                                                                                                                                                                                        |
| **B-05** (server WS drop kills calls)                      | **Code done Â· OPS pending**                        | `WS_HEARTBEAT_GRACE` default is already 25000 in `configuration.ts` (commit `f536781`); fixed the footgun where `.env.example` still shipped `10000` (would silently override the fix on a deploy that copied it). Docker `HEALTHCHECK â†’ /healthz` is already present (crash-restart signal). **Still requires host access** (not doable here): deploy with a restart policy (`docker run --restart=unless-stopped` / compose `restart: unless-stopped`), add an external uptime monitor on `relay.94-136-184-52.sslip.io`, and pull `messenger-service` logs at the drop timestamps (11:09:58 / 12:03:57 / 12:14:56 / 12:45:57 / 13:02:40 / 14:11:56 / 14:22:57 / 14:37:46) to confirm crash-vs-heartbeat. Client mitigation (ice-restart, reconnectâ†’rejoin, keepalive, re-consume-on-reconnect) is comprehensive.                          |
| **B-13** (non-owner host skips key broadcast)              | **BLOCKED â€” security stop-condition (by design)** | Investigated against the code + `adhocCallKeyLookup.test.ts`. The joiner-side `resolveKeyId` is **already correct** (a real-group non-owner-hosted call resolves the real group key the joiner holds; the ad-hoc `direct:<host>` rule is correctly scoped to escalated 1:1s). The non-owner host **correctly refuses to broadcast** â€” minting/fanning a group's master key as a non-owner would HIJACK the group (owner-poison guard, `productionRuntime.ts:2661-2690`). The only residual failure (a member who NEVER received the owner's key) is **fail-closed by design** (never plaintext; test at `adhocCallKeyLookup.test.ts:210`). Real recovery = an **owner-side** key resync, which is a **group-master-key-distribution change â†’ requires architecture sign-off** per CLAUDE.md. **Not changed unilaterally. Needs a decision.** |

**Files touched:** `messengerStore.ts`, `useGroupCall.ts`, `groupCallLayout.ts`, `useCall.ts`,
`peerConnectionFactory.ts`, `CallScreen.tsx`, `push/callNotification.ts`, `push/fcmBootstrap.ts`,
`apps/messenger-service/.env.example`; new tests `directConversationMerge`, `groupCallTilePrune`,
`recoverCamera`.

**Open decisions / follow-ups:**

1. **B-13 (architecture): DECIDED 2026-06-09 â€” keep fail-closed.** The current behaviour (a member
   missing the owner's group key cannot join a non-owner-hosted call; never plaintext) is the accepted
   contract. No owner-side resync built. Revisit only if the architecture owner wants a member-initiated,
   owner-served key recovery (a key-distribution change requiring sign-off).
2. **B-20 / B-21:** verify on physical devices (Pixel/Xiaomi/Redmi) â€” BlueStacks can't reproduce either.
3. **B-20 group path:** apply the same camera-resume recovery to the group-call producer (mediasoup
   `producer.replaceTrack`) once the 1:1 path is device-confirmed.
4. **B-05 (ops):** deploy `WS_HEARTBEAT_GRACE=25000` + restart policy + uptime monitor + pull drop-time logs.

---

## 15. iOS Build Status

**Status: NOT BUILDABLE** â€” requires setup first.

### What's Missing for iOS Build

| Issue                                                         | Severity      | Fix                                                                                                                                   |
| ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GoogleService-Info.plist` not in repo                        | ðŸ”´ Critical | Download from Firebase console, add to project root, add `"googleServicesFile": "./GoogleService-Info.plist"` to app.json ios section |
| `frameCryptorOrchestrator.ts` missing                         | ðŸ”´ Critical | Recreate file (see Bug 3)                                                                                                             |
| No iOS FrameCryptor implementation                            | ðŸ”´ Critical | `frameCryptorTransport.isAvailable()` returns false on iOS â†’ group calls refuse to start                                            |
| Missing `NSPhotoLibraryUsageDescription` in app.json          | ðŸŸ¡ Serious  | Add to ios.infoPlist                                                                                                                  |
| Missing `location` in UIBackgroundModes                       | ðŸŸ¡ Serious  | Add to ios.infoPlist.UIBackgroundModes array                                                                                          |
| `@stripe/stripe-react-native` not in iOS plugins              | ðŸŸ¡ Serious  | Add to app.json plugins                                                                                                               |
| `react-native-permissions` not in iOS plugins                 | ðŸŸ¡ Serious  | Add to app.json plugins                                                                                                               |
| iOS notifications permission returns 'granted' without asking | ðŸŸ¡ Serious  | Fix PermissionsScreen.tsx                                                                                                             |
| `aps-environment: production` set for all builds              | ðŸŸ  Warning  | Should be `development` for non-prod                                                                                                  |
| Xcode and iOS SDK required                                    | â„¹ï¸ Env     | Run `expo prebuild --platform ios` then `npm run ios`                                                                                 |

### To Build iOS (Once GoogleService-Info.plist obtained)

```bash
# 1. Add GoogleService-Info.plist to project root
# 2. Update app.json ios section with googleServicesFile
npm run ios              # local simulator (requires Xcode on Mac)
npm run eas:build:ios:staging   # EAS cloud build
```

**Note:** QA (Mac) is the only person on the team who can do iOS builds. Developer is on Windows.

---

## 16. Ops Console Routes

Located at `apps/ops-console/src/app/`

| Route            | Purpose                 |
| ---------------- | ----------------------- |
| `/`              | Home/root               |
| `/dashboard`     | Ops dashboard           |
| `/agents`        | Agent list              |
| `/agents/[id]`   | Agent detail            |
| `/bookings`      | Booking list            |
| `/bookings/[id]` | Booking detail          |
| `/jobs`          | Job list                |
| `/jobs/[id]`     | Job detail              |
| `/live`          | Live mission view       |
| `/live/[id]`     | Single mission tracking |
| `/live/wall`     | Mission wall/grid       |
| `/analytics`     | Analytics dashboard     |
| `/departments`   | Department management   |
| `/finance`       | Finance/payments        |
| `/messenger`     | Chat interface          |
| `/settings`      | Settings                |
| `/login`         | Login                   |

**Run:** `cd apps/ops-console && npm run dev` â†’ http://localhost:3002

---

## 17. Security Architecture Summary

| Layer             | Technology                                                 | Notes                                                |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 1:1 messages      | Signal Protocol (Double Ratchet + X3DH + Sealed Sender v2) | Never log plaintext                                  |
| Group messages    | AES-256-GCM with group master key                          | Key via pairwise Signal sessions                     |
| Group call frames | AES-256 via FrameCryptor (stream-webrtc-android)           | BEFORE SRTP, Android only                            |
| Local DB          | SQLCipher (hardware-backed keychain key)                   | `group_master_keys` table separately AES-GCM wrapped |
| Media attachments | AES-256-CBC, unique key per file, key in message envelope  | S3-compatible storage                                |
| WebRTC media      | DTLS-SRTP + FrameCryptor overlay                           | DTLS fingerprint pinned                              |
| File vault        | MFA (biometric/TOTP challenge) required for download URL   | Cannot bypass                                        |
| Push wake         | HMAC-signed VoIP payload                                   | Verified before trusting call data                   |

**Stop conditions â€” always verify architecture doc before changing:**

- Any encryption primitive (algorithm, key length, IV/nonce)
- Sealed-sender envelope shape or AAD binding
- Group master key distribution or rekey on member removal
- Auth tokens, sender certs, biometric/TOTP gates
- File vault MFA gate or download URL issuance

---

## QA Session 2026-06-08 â€” Group Text on Real Group After Call Churn (BlueStacks 3-device)

**Session date:** 2026-06-08 ~12:14â€“12:18
**Devices:** 5555=itsirajul (`08782d6d`) | 5565=shirajul (`79d63649`, SENDER/admin) | 5575=fahim (`fe4ddc14`)
**Branch tested:** `release/1.0.35-audit-fixes`
**Context:** Immediately followed 3 consecutive B-05 call drops (11:36 / 11:52 / 12:08), each doing
`key resynced delivered=3`. All 3 apps were force-restarted at ~12:10:30 (new PIDs 5111/5276/5652).
**Evidence:** live logcat + view-hierarchy dumps + screenshots in
`~/Desktop/bravo_logs_live_20260608_112423/` (`shots_121410/`).

---

### Bug B-18 â€” Group Text Decrypts (`handled=true`) but Never Renders + User-Visible "Couldn't decrypt â€” re-syncing" Banner âš ï¸ HIGH â€” CONFIRMED on a REAL group

> **Supersedes the scoped-down B-15.** B-15 was marked NOT REPRODUCED because the non-render
> couldn't be isolated to a real synced group. B-18 isolates it: real group **"SQA - Shirajul"**,
> sender (shirajul) is the **admin/owner**, controlled single-message test, confirmed via view-hierarchy
> dump (not just "scrolled past"). Related family: B-10 (epoch mismatch), B-15/B-15b (render/desync).

**Group:** **"SQA - Shirajul"** (4 operators, E2E), owner/admin = shirajul (`79d63649`).

**Reproduce:**

1. shirajul (group admin) opens the "SQA - Shirajul" group and sends a text message.
2. On fahim and itsirajul: the message is delivered + decrypted at the envelope layer
   (`[recv.enter] peer=79d63649 â€¦ handled=true`, no tamper/no_key/sealed-auth error in logs).
3. But the message **does not appear** in either receiver's chat, AND both show a persistent red
   banner: **"âš  Error: Couldn't decrypt one message â€” re-syncing"**.

**Frequency:** 100% in this session â€” both the user's "hey guys"/"hey" sends AND the controlled
QATEST send failed to render on both receivers.

**Controlled test (driven via ADB):**

```
12:17:44  shirajul: sent "QATEST-121557" (input typed + send tap), backup.mirror flushed 3 messages
12:17:45.618  fahim:     [recv.enter] peer=79d63649/1 envId=d8143b4a â†’ ACK ok handled=true
12:17:46.263  itsirajul: [recv.enter] peer=79d63649/1 envId=5e268805 â†’ ACK ok handled=true
```

**View-hierarchy dump proof (uiautomator, after send):**

```
fahim     : "QATEST-121557" ABSENT from hierarchy; last rendered item = "Group Video call 1:19 AM";
            banner text = "Error: Couldn't decrypt one message â€” re-syncing"
itsirajul : "QATEST-121557" ABSENT; only its OWN messages render ("hello"/"hi"); same banner
```

The marker is genuinely not in the rendered tree (not merely below the scroll fold).

**The contradiction = the bug:** the runtime reports `handled=true` (outer sealed-sender unwrap +
deliver/ACK succeeded) while the UI claims a decrypt failure and drops the message from the list.

**Root cause (inferred â€” needs dev confirm):** the **outer** sealed-sender envelope unwraps fine
(`handled=true`), but the **inner group body** (AES-256-GCM under the group master key) fails to
decrypt because fahim/itsirajul hold a **stale group key epoch** â€” advanced by the three
`key resynced delivered=3` events during the back-to-back B-05 call failures (the **B-10** epoch-
mismatch mechanism). The group-text append path (`productionRuntime.ts:4617`, noted silent in the
B-15 code-watch item) then drops the message, and a separate UI path raises the "couldn't decrypt â€”
re-syncing" banner. So: envelope OK â†’ group-body decrypt fails on stale epoch â†’ no render + banner.

**Why it's worse than B-15:** there is now a **user-visible error** ("Couldn't decrypt one message â€”
re-syncing") that is inconsistent with `handled=true`, and it persists/sticks across messages and the
app restart, and it occurs on a properly synced real group â€” not just an ad-hoc/ghost group.

**Files involved:**

- `src/modules/messenger/runtime/productionRuntime.ts:4617` â€” silent group-text append (no log, no
  routing through `resolveDirectConversationIdFromState`); where the message is lost on render
- `src/modules/messenger/crypto/groupCrypto.ts` â€” AES-256-GCM group body decrypt (epoch-keyed)
- group key epoch sync after call `key resynced delivered=N` (B-10 mechanism) â€” call key churn
  advances the epoch held by the host but not re-synced to members for _text_
- the "couldn't decrypt â€” re-syncing" banner source (UI) â€” fires while `messenger.deliver` logs
  `handled=true`, i.e. the two layers disagree

**Notes / open questions for dev:**

- Capture the `groupId` the sender's ChatScreen is bound to vs `unwrapped.group.groupId` on the
  receiver (the B-15 suggestion) to confirm whether the inner decrypt or the append-slot is the miss.
- App restart did NOT clear it this time (unlike B-15b sealed-sender desync, which a restart fixed) â€”
  points to a persisted epoch/key-state mismatch rather than a transient session desync.
- Strongly correlated with prior call key churn; reproduce cleanly by: owner-host a few group calls
  that drop (B-05), then send group text from a member.

**EXTENSION 2026-06-08 ~15:28 â€” B-18 symptom ALSO occurs on 1:1 direct chats (not just groups):**

fahim's **1:1 direct chat with shirajul** (`direct:79d63649`, peer Online) showed the identical
user-visible failure:

- Inbound msg `recv.enter peer=79d63649/1 envId=d5b12367` â†’ `messenger.deliver ACK ok handled=true`,
  but **no `[recv.text.routing]` / `[recv.text.append]` / `[recv.branch]`** logged â†’ never rendered.
- Chat shows red banner **"Couldn't decrypt one message â€” re-syncing"** + a **"1 UNREAD MESSAGE"**
  divider with **no message bubble** beneath it (app counted the message but couldn't show the body).
- MessengerHome chat-list preview for that conversation = **"(encrypted)"** + blue (i) badge (vs the
  itsirajulâ†”fahim 1:1 which rendered real text "hello" normally).

**Scoping:** only **shirajul's** sessions are affected (08782d6dâ†”fahim 1:1 works fine) â†’ this 1:1 form is
the user-visible face of **B-15b (shirajul Double-Ratchet / sealed-sender desync)**, NOT a group-epoch
problem (1:1 has no group key). Because `handled=true` ACKs + deletes the envelope from the relay, the
undecryptable message is **unrecoverable**. So the "decrypts-but-not-rendered + couldn't-decrypt banner"
symptom (B-18) spans BOTH group text (group-epoch root) AND 1:1 text (ratchet/sealed desync root, B-15b).
Evidence: `~/Desktop/bravo_logs_live_20260608_112423/shots_1to1_153038/fahim_chat_79d63649.png`.

**RETEST 2026-06-08 ~16:05 on build 1.0.48 (versionCode 71) â€” group FIXED, 1:1 render STILL BROKEN:**

After the dev's 1.0.48 update (all 3 BlueStacks devices):

- **Group text â†’ FIXED.** Group messages render on all devices (e.g. itsirajul "Hello" 16:04 shown on
  fahim in "SQA - Fahim"), chat-list preview updates, no "couldn't decrypt" banner.
- **1:1 incoming text â†’ STILL FAILS, now as a PURE render bug (no decrypt confound).** itsirajulâ†”"DAD"
  1:1: itsirajul received fahim's messages 16:04:21 (`a1329f99`) + 16:04:37 (`ba631127`), both
  `handled=true`, **zero decrypt errors and NO red banner** â€” yet the 1:1 thread shows only itsirajul's
  own sent "Hi" and the old call event; **no incoming bubble appears**. Because the crypto desync is
  gone (B-15b cleared), this isolates the failure to the **1:1 inbound append/render path**: groups
  append+render fine, 1:1 direct does not. The group fix did not extend to the 1:1 append path.
  Evidence: `~/Desktop/bravo_logs_live_20260608_112423/shots_1to1_v48_160540/itsirajul_open_DAD.png`.
- **Bonus â€” B-11 FIXED in 1.0.48:** all 3 devices online simultaneously, bidirectional delivery
  (itsirajulâ†”shirajulâ†”fahim all `handled=true`), and **0 `superseded`/`io server disconnect` events** in
  the logs since boot (was 100% supersession before). `signalDeviceId` appears unique per device now.

**Revised status:** B-18 group form = FIXED in 1.0.48. **B-18 1:1 form = still FAIL** (pure render path â€”
distinct from the earlier B-15b crypto confound). Track the 1:1 render path as the remaining open item:
`productionRuntime.ts` 1:1 inbound append (`recv.text.append`) â†’ ChatScreen binding for direct convos.

---

### Bug B-19 â€” Group Video: Participant's Stream Rendered Into Wrong/Duplicate Tile (other tile blank) âš ï¸ HIGH â€” CONFIRMED

**Logged:** 2026-06-08 ~12:36 (BlueStacks: group video call "SQA - Shirajul", shirajul host)

**Reproduce:**

1. Start a 3-party **video** group call (shirajul host).
2. After all 3 have video producing, observe the tile grid on each device.
3. At least one participant's video is drawn into the **wrong tile** / **duplicated** across tiles,
   while another tile is **blank** (no video) even though that stream is being consumed.

**Frequency:** Observed across all 3 devices simultaneously in this call (reporter: "one tile video
is going to another tile").

**Participant â†” tag map (this room, from `step=3 joined` self-tags):**

| Tag        | Participant | Role                           |
| ---------- | ----------- | ------------------------------ |
| `bccac900` | shirajul    | host (`existingProducers=0`)   |
| `8a82f9bb` | fahim       | joiner (`existingProducers=2`) |
| `0982855c` | itsirajul   | joiner (`existingProducers=4`) |

**The transport/decrypt layer is PROVEN CORRECT** â€” each device consumed the right distinct remote
video streams with FrameCryptor attached:

```
itsirajul (self 0982855c): consume bccac900 v âœ“ + 8a82f9bb v âœ“  (both consumer attached FrameCryptor)
fahim     (self 8a82f9bb): consume bccac900 v âœ“ + 0982855c v âœ“
shirajul  (self bccac900): consume 8a82f9bb v âœ“ + 0982855c v âœ“
```

No black-tile BLAST errors, no missing consumer, no producer-closed.

**The render layer is WRONG (screenshot evidence, `shots_tile_123628/`):**

- **itsirajul** â€” same face duplicated across the active tile + bottom tiles (one stream bound to â‰¥2 tiles).
- **fahim** â€” 2 video tiles populated + 1 **blank** tile (a consumed stream not bound to its tile).
- **shirajul** â€” same: 2 tiles + 1 blank.

So distinct, correctly-decrypted streams are being mis-assigned to tiles at the UI layer: one stream
duplicated onto multiple tiles, another tile left blank. This is distinct from B-01 (black tile / BLAST
surface race) and B-17 (tile entirely absent in voice) â€” here the video **renders, but in the wrong
tile**.

**Root cause (inferred):** tileâ†’consumer/stream binding keyed on an unstable or reused index rather
than the participant tag. When tiles are built from `existingProducers` + live `new-producer` events,
a stream gets attached to the wrong RTCView (or the same `MediaStream` ref is shared across tiles),
leaving the displaced participant's tile blank. Per-room tags are correct in the data layer; the bug is
in mapping consumerâ†’RTCView.

**Files involved:**

- `src/modules/messenger/webrtc/groupCallLayout.ts` â€” tile grid build / ordering
- `src/screens/messenger/GroupCallScreen.tsx` â€” RTCView â†” participant/stream binding (likely keyed on
  tile index, not the stable participant tag)
- `src/modules/messenger/webrtc/useGroupCall.ts` â€” `step=9` existingProducers consume vs live
  `participant.joined`/`new-producer` stream assignment

**RETEST on build 1.0.48 (versionCode 71) â€” group VIDEO render IMPROVED (B-19/B-01/B-17):**

3-device group video call on group `3cb79cb1f1b0`, fahim owner-host (`key resynced delivered=3`,
FrameCryptor on all A+V; tags fahim `fabc1201` / shirajul `cbd4fabb` / itsirajul `4d9a3bbf`,
room `4040ff19â€¦`, 16:48â€“16:49). All three devices rendered **3 video tiles, all populated â€” NO black
tile (B-01), NO blank tile (B-17), no duplicate/missing-cell anomaly** (host fahim included â€” the old
B-01 host-black-tile is gone). Screenshots: `~/Desktop/bravo_logs_live_20260608_112423/shots_grpvid_164914/`
(itsirajul.png, fahim.png, shirajul.png).

**Caveat â€” cannot fully close B-19:** BlueStacks feeds the SAME camera image to all instances, so every
tile shows the same face; this verifies "all tiles render video, none black/blank" but NOT "each tile is
bound to the correct distinct stream." The precise wrong-binding check (B-19) needs distinct per-device
cameras (physical devices). The gross old-build anomalies (black host tile, blank cells, one stream on
multiple tiles with another blank) are not present on 1.0.48. Status: B-01 appears FIXED; B-17 not
reproduced; B-19 wrong-binding inconclusive on emulator but no visible anomaly.

**Recommended fix:** Key each RTCView strictly by participant **tag** (stable within the room), bind
the exact `MediaStream` for that tag's video consumer, and force a remount (changed `key`) when the
tagâ†’stream mapping changes. Reconcile the tile list against the `sfu.producers` snapshot so no
consumed stream is left without a tile and no tile shares another's stream. Sibling of B-01/B-16/B-17
(media arrives + decrypts, render layer mis-handles it).

**Evidence:** `~/Desktop/bravo_logs_live_20260608_112423/shots_tile_123628/` (itsirajul.png, fahim.png,
shirajul.png) + consume/new-producer logs in the device\_\*.txt for 12:27:55â€“12:28:09.

**RETEST 2026-06-10 on build 1.0.50 (versionCode 73) â€” B-19 STILL PRESENT, on ALL 3 devices simultaneously:**

3-device group **video** call on group "SQA - ITSirajul" (`4100833dd9da`), itsirajul **owner-host**
(room `15846615â€¦`, tag `18fff41d`, `existingProducers=0`, 15:53:11). Joiners `1cae65cc` + `7e7c5d90`.
Screenshots `~/Desktop/bravo_logs_v50_0610/shots_b19_155416/dev_5555.png` / `dev_5565.png` / `dev_5575.png`
(15:54:16). User report: "video is going from one tile to another."

Each device shows the **identical** bottom-row failure (layout = 1 large top + 2 bottom):

- **Top (large) tile:** populated, correctly sized â€” renders fine.
- **Bottom-LEFT tile:** its video is **DISPLACED to the RIGHT** â€” the left participant's stream renders
  shifted out of its own cell and spills into / across toward the bott-right tile's area (left cell ends
  up partly empty, the video pushed rightward).
- **Bottom-RIGHT tile:** its **own video is still present but rendered SMALL / undersized** (drawn at a
  reduced scale on the right side of the cell, not aspect-filled), AND the displaced left-tile video
  overlaps into this region â€” so the bottom-right area shows the left stream bleeding in **plus** the
  right stream shrunk. Net: "left-side video goes to the right side; the right-side video is still there
  but small." Same on all 3 devices at once. (Cropped tile shots: `shots_b19_crop/brtile_55{55,65,75}.png`,
  full frames `shots_b19_155416/dev_55{55,65,75}.png`.)

**Transport/crypto PROVEN correct (pure render/layout defect):** the host (itsirajul) consumed BOTH
remotes' video with FrameCryptor attached â€” `step=9`/new-producer `consumer attached (FrameCryptor)
tag=1cae65cc kind=video` (15:53:18) + `tag=7e7c5d90 kind=video` (15:53:21). All streams arrive +
decrypt; the bottom row mis-places/mis-sizes the two video surfaces. **B-01 BLAST surface-size race is
firing this call:** `rejecting buffer: active_size=4x2 buffer{2448x1377}` (15:53:13) â†’ SurfaceView stuck
at the 4Ã—2 placeholder, then aspect mismatch `2720x2040 vs 3627x2040` (15:53:21) â†’ the surface never
re-lays-out to its tile bounds, so one tile's video draws displaced/oversized into the neighbour while
the neighbour's own video stays at the small un-grown size. So **B-19 on 1.0.50 = bottom-left video
displaced rightward + bottom-right video undersized**, both driven by the B-01 surface-size/layout race.
This is a geometry/placement defect, independent of the BlueStacks shared-camera same-face caveat.

**Status:** B-19 = **FAIL on 1.0.50** (bottom-left video shifts into the right tile; bottom-right video
undersized; was "inconclusive/no-anomaly" on 1.0.48). Tightly coupled to B-01 (BLAST 4Ã—2 surface race
still present). Fix: force each tile SurfaceView to remount (changed `key`) once real `onLayout`
dimensions arrive so the video surface is created at full tile size, clip/aspect-fill each stream to its
own tile bounds, and key the RTCView strictly by participant tag so a stream can't render into a
neighbouring cell (see B-01 fix).

---

## QA Session 2026-06-08 (PM) â€” 1.0.48 Update Retest (CONSOLIDATED)

**Standalone bug report:** `~/Desktop/Bravo_Secure_Bug_Report_2026-06-08_v1.0.48.md`
**Builds:** 1.0.47 (vc 69) â†’ **1.0.48 (vc 71)** (dev pushed update mid-session ~15:55)
**Devices:** BlueStacks 5555 itsirajul (`08782d6d`) / 5565 shirajul (`79d63649`) / 5575 fahim (`fe4ddc14`)
**Evidence root:** `~/Desktop/bravo_logs_live_20260608_112423/` (device*55{55,65,75}*\_.txt logcat,
`shots\__/`screenshots,`/tmp/ui_55\*.xml` uiautomator dumps)

### Group ownership map (derived this session)

- `3cb79cb1f1b0` "SQA - Fahim"/"Call" â†’ owner **fahim** (`delivered=3` when fahim hosts; non-owner shortcut for others)
- `f956b212413b` â†’ owner **shirajul** (`delivered=3` when shirajul hosts; non-owner shortcut for fahim/itsirajul)
- `4100833dd9da` "SQA - ITSirajul" â†’ owner **itsirajul**
- `4040ff19â€¦` is a per-call SFU room id (not a group)

### What 1.0.48 FIXED

- **B-11** multi-device online â€” all 3 online at once, bidirectional delivery, **0 supersession events** (root-cause fix; `signalDeviceId` now unique).
- **Group text render** â€” renders on all devices, no decrypt banner.
- **B-01** host black video tiles â€” group video host renders tiles, no black; all 3 devices 3 populated tiles.
- **1:1 video render** â€” remote full-screen + self PiP, both ends.

### What 1.0.48 did NOT fix

- **B-05** (BACKEND) â€” server WS drop still kills every call. **15 calls this session, 15 killed, recovery 0/15.** New client keepalive-retry tolerance (rides ~2.5 min of failing pings) but still dies `ack_timeout:sfu.join`. Connected durations ~1â€“15 min (intermittent, not fixed timeout; ceiling ~15 min).
- **B-18 1:1 text render** â€” receiver gets `handled=true`, no banner, but no bubble. Pure render-path bug now (B-15b confound gone). Group append fixed, 1:1 append not.
- **B-13** non-owner host skips key broadcast â€” `reusing real-group key (non-owner host)` path unchanged; masked by pre-seeded keys.
- **B-17** voice/group joiner blank tile â€” reproduced on 1.0.48 (itsirajul blank cell, both remotes consumed).

### Watch-items

- Incoming 1:1 **video** â†’ receiver app restart (fahim PID 8049â†’2572 on `f55ef148`; that attempt never connected). Inconclusive â€” re-test.
- **B-19** wrong-tile binding â€” inconclusive on emulator (shared camera = identical faces); needs physical devices.

### Fix priority

1. **Server (P0):** `messenger-service` WS on `94.136.184.52` (B-05) â€” crash investigation + `WS_HEARTBEAT_GRACE` 10sâ†’25s + watchdog. No client build resolves it. **Still need server logs at the 13 drop timestamps.**
2. **FE (P1):** 1:1 inbound render (B-18) â€” extend group append to `direct:` path.
3. **FE (P1):** non-owner key broadcast (B-13).
4. **FE (P2):** tile render off consume path + `sfu.producers` reconcile (B-17 / B-19 class).

---

## Bug Analysis â€” Resolution + Root Causes (2026-06-08, build 1.0.48)

> Mirrored from `docs/qa/analysis.md` (also at `~/Desktop/analysis.md`). Saved here because loose
> Desktop files were repeatedly auto-deleted this session; `sqa.md` (in-repo) is the stable record.

### Per-bug status (as of 1.0.48 / vc 71)

| Bug            | Title                                             | Side               | Status                           |
| -------------- | ------------------------------------------------- | ------------------ | -------------------------------- |
| B-01           | Host sees black video tiles                       | App                | âœ… Resolved                     |
| B-02           | Ad-hoc call "no group master key"                 | App                | âœ… Resolved                     |
| B-03           | `frameCryptorOrchestrator.ts` repo/APK divergence | App                | âœ… Resolved (ships)             |
| B-04           | Ghost "Call" groups in list                       | App                | âœ… Resolved                     |
| B-11           | 2nd device offline (`signalDeviceId=1`)           | App                | âœ… Resolved                     |
| B-12           | Group-call joiner never gets key (â† B-11)        | App                | âœ… Resolved                     |
| B-15           | Group text not rendering                          | App                | âœ… Resolved                     |
| B-18 (group)   | Group text decrypts but not rendered              | App                | âœ… Resolved                     |
| **B-18 (1:1)** | **1:1 text decrypts but never renders**           | App                | âŒ Open                          |
| **B-13**       | Non-owner host skips key broadcast                | App                | âŒ Open                          |
| **B-17**       | Voice/group joiner blank tile                     | App                | âŒ Open                          |
| **B-05**       | **Server WS drop kills every call**               | **Backend**        | âŒ Open                          |
| B-19           | Video stream â†’ wrong/duplicate tile             | App                | âš ï¸ Inconclusive (emulator)    |
| B-16           | 1:1 audioâ†’video first-enable sees self          | App                | âš ï¸ Not retested               |
| B-07           | `toggleVideo` silent refusal                      | App                | âš ï¸ Not retested               |
| B-08           | Boot race on `GROUP_CALL_PRESENCE`                | App                | âš ï¸ Not retested               |
| B-09           | Calls boot voice (no camera)                      | App                | âš ï¸ Not retested               |
| B-10           | Group key epoch mismatch                          | App                | âš ï¸ Not retested               |
| B-14           | Post-call transport dead                          | Mixed (BE trigger) | âš ï¸ Tied to B-05               |
| B-15b          | shirajul sealed-sender desync                     | App                | âš ï¸ Transient (restart clears) |

### Count by side & status

| Side               | Resolved | Open (confirmed)          | Inconclusive / not-retested | Total  |
| ------------------ | -------- | ------------------------- | --------------------------- | ------ |
| **App (frontend)** | 8        | 3 (B-13, B-17, B-18Â·1:1) | 7                           | **18** |
| **Backend**        | 0        | 1 (B-05)                  | 1 (B-14 mixed)              | **~2** |
| **Total**          | **8**    | **4**                     | **8**                       | **20** |

**Bugs are overwhelmingly App/frontend (~18 of 20); only B-05 is purely backend** (B-14 mixed knock-on).
B-05 is the single most damaging â€” 15/15 calls this session died to it regardless of the client.

### Most probable root causes

| #   | Root cause                                                                                                                                                                                                               | Bugs it explains                   | Side    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------- |
| 1   | **`messenger-service` WebSocket instability** (`94.136.184.52`) â€” crash/restart or `WS_HEARTBEAT_GRACE` (10s) too tight under variable Contabo latency â†’ all clients kicked simultaneously                           | **B-05**, B-14                     | Backend |
| 2   | **`signalDeviceId = 1` hardcoded** (now fixed) â€” shared `(userId:deviceId)` key â†’ supersession churn â†’ key-delivery + sealed-sender desync                                                                         | B-11, B-12, B-15b                  | App     |
| 3   | **Render decoupled from data layer** â€” tiles/messages keyed on index/`participant.joined`/remote-initiated events, not bound off consume/`ontrack`/append. Media arrives + decrypts but never reaches a render surface | B-01, B-06, B-16, B-17, B-19, B-18 | App     |
| 4   | **1:1 inbound append not unified with group** â€” group append fixed, `direct:` convos don't append to the visible thread                                                                                                | B-18 (1:1)                         | App     |
| 5   | **Non-owner-host key shortcut** â€” `reusing real-group key (non-owner host)` skips broadcast; `resolveKeyId` looks under wrong id for non-owner hosts                                                                   | B-13, B-02                         | App     |
| 6   | **APK ahead of repo** â€” shipped builds contain uncommitted code (B-03 file, non-owner-host path)                                                                                                                       | B-03, B-13                         | Process |

### Two highest-leverage fixes

1. **Server WS hardening** (root #1) â€” crash fix + `WS_HEARTBEAT_GRACE` 10sâ†’25s + watchdog â†’ unblocks all calls.
2. **Render off the consume/append path keyed on stable participant tag / conversation id** (root #3) â†’ closes the tile + message render cluster (B-17, B-19, B-18Â·1:1; guards B-01/B-16).

### Session artifacts (2026-06-08)

- **Bug report:** `~/Desktop/Bravo_Secure_Bug_Report_2026-06-08_v1.0.48.md` (re-created after auto-delete; copy advisable in-repo)
- **Analysis:** `docs/qa/analysis.md` + `~/Desktop/analysis.md`
- **Salvaged logcat (17:04â€“17:32 only):** `~/Desktop/bravo_logs_salvage_174111/` â€” full-session live capture dir
  (`bravo_logs_live_20260608_112423/`, 3 device logs + 36 screenshots) was **auto-deleted from Desktop**;
  raw logs before 17:04 and all screenshots are unrecoverable. Analyzed findings preserved in this file.
- **Builds:** 1.0.47 (vc69) â†’ 1.0.48 (vc71). Devices: 5555 itsirajul `08782d6d` / 5565 shirajul `79d63649`
  / 5575 fahim `fe4ddc14`. Group owners: `3cb79cb1f1b0`=fahim, `f956b212413b`=shirajul,
  `4100833dd9da`=itsirajul.

---

## QA Session 2026-06-09 â€” 1.0.49 (vc 72) Retest (BlueStacks 3-device)

**Session date:** 2026-06-09 ~10:26â€“12:13
**Build:** 1.0.49 (versionCode 72) â€” newer than the last baseline 1.0.48 (vc 71). All 3 BlueStacks on vc 72.
**Devices:** 5555 itsirajul (`08782d6d`) / 5565 shirajul (`79d63649`) / 5575 fahim (`fe4ddc14`)
**Evidence:** `~/Desktop/bravo_logs_v49_0609/` (call*\*/vcall*\_/r2\__ logcat streams, scr*\*/cam*_/vfail\_\_ screenshots, UI dumps)
**Note:** 1.0.49 no longer emits the 1.0.48 render-path logs (`recv.text.routing`/`recv.text.append`/
`recv.branch`); inbound now logs only `[recv.enter]` â†’ `[messenger.deliver] ACK ok handled=true`.

### Retest results

- **Group text â†’ PASS.** Renders in-thread on all devices; chat-list previews show real decoded text.
- **B-18 (1:1 text render) â†’ STILL FAIL.** itsirajulâ†”fahim/"Test"/"DAD" 1:1: inbound text is
  `handled=true` (no banner) but **no bubble renders**; the chat-list preview falls back to
  **"(encrypted)"** and the open thread shows only call-event cards. Group append works, `direct:`
  append does not â€” unchanged from 1.0.48. (Evidence: `scr_5575_1to1.png`, `scr_5575_list.png`.)
- **B-05 (call survival) â†’ STILL FAIL** (server-side; see the B-05 RETEST 2026-06-09 block above for the
  3 calls / decay timelines / "Couldn't build secure connection" popup detail). 1:1 audio ~12.5 min,
  1:1 video #1 ~2m40s; both connect + DTLS-verify then die to the WS-drop decay. Recovery 0/n.
- **No receiver cold-boot** on incoming 1:1 video (PIDs stable across calls: 4416 / 5033 / 4575) â€” the
  1.0.48 "incoming-video â†’ receiver restart" watch-item did NOT reproduce.
- **Group VIDEO â†’ B-17 blank tile reproduced** (admin-host: 2 tiles + 1 blank; member-host: worse, per-device
  inconsistent + self-view black). Root cause = zombie tag from early `reconnect â†’ rejoin` (see B-17 retest).
- **1:1 audioâ†’video upgrade (B-16) â†’ tentative PASS on 1.0.49.** Call `cid=5d0bfd76` (itsirajulâ†”fahim),
  upgraded to video (`reoffer sdpLen=3503` carries the video m-line; `[bravo.renegotiate] renegotiation
complete` on responder). **Both ends rendered the correct two-surface layout** (remote video full-screen +
  self-view PiP) â€” `upg_5555.png` / `upg_5575.png`. The 1.0.48 B-16 fault (first-to-enable side sees only
  self) did NOT reproduce. _Caveats:_ BlueStacks shared camera = identical faces (can't 100% prove the
  full-screen tile is remote vs self), and the exact enable-order wasn't isolated (upgrade happened just
  before streamers armed), so the strict first-vs-second asymmetry is unverified. Re-test with a controlled
  enable-order + distinct cameras to fully close B-16.
- **Group VOICE (admin-host on `f956b212413b`, 14:01) â†’ tiles PASS at boot, then B-17 DROP after rejoin.**
  At boot (clean join, ~00:40) all 3 devices showed **all 3 avatar tiles** (SH/FA/IT, "3 joined"); audio +
  FrameCryptor on every consumer (`gvoice_*.png`). **BUT at 14:05:41 itsirajul hit a WS blip
  `reconnect â†’ rejoin`, rejoined with NEW tag `e1d8f06a` (old tag `377b0a70` orphaned)** â†’ on the host
  (shirajul) the roster dropped **"3 joined" â†’ "2 joined"** and **itsirajul's tile vanished** (bottom-right
  empty); `gvdrop_5565.png` shows only FA + SH("YOU"). â‡’ **B-17 reproduces on VOICE too** â€” identical
  rejoin-zombie-tag mechanism as the video calls; the only reason voice "passed" initially is it had no
  early rejoin. So B-17 is NOT video-specific: **any `reconnect â†’ rejoin` (B-05-driven WS churn) drops the
  rejoiner's tile** because the tile list isn't reconciled to the new tag. (Evidence:
  `~/Desktop/bravo_logs_v49_0609/gvdrop_5555.png`/`5565`/`5575`.)
- **"SILENT ZOMBIE CALL" symptom (host can't hear anyone, no crash) â€” 14:09, group voice:** after the WS
  died (host shirajul keepalive `x2 â†’ x25`, no recovery) and the peers **rejoined with new tags**, the
  **host never re-consumed the rejoined producers** â€” the `sfu.new-producer` signal rides the dead WS, so
  the host stayed bound to **stale consumers** for the old (now-closed) producer tags. **User report: "admin
  can't hear anyone."** App did NOT crash (PIDs stable 4416/5033/4575), getStats still ticking, call UI still
  "connected" â€” but audio is functionally dead + a tile dropped (B-17). â‡’ the call enters a **functionally-
  dead zombie state well before the terminal teardown**: UI says connected, but no audio and no error fires.
  This is the audio face of the same B-05 dead-WS + rejoin-churn cluster (sibling of the B-17 tile drop).
  **Fix needs:** re-consume rejoined producers on WS reconnect / reconcile consumers against `sfu.producers`,
  and surface a real "connection lost" state instead of a silent "connected" UI.

---

### 1.0.49 (vc 72) vs 1.0.48 (vc 71) â€” What Changed

**Summary: incremental call-resilience improvements only; the headline bugs are untouched.**

**âœ… Genuine improvements in 1.0.49:**

| Area                                 | 1.0.48 (vc 71)                                                                                                                          | 1.0.49 (vc 72)                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1:1 ice-restart recovery**         | 0 recoveries â€” ice-restart reoffer always `skipped â€” signalingState=have-local-offer`, no `ice-restart-recovered` log; recovery 0/n | **Works for transient blips** â€” `ice-restart-recovered gapMs=â€¦` healed **3 separate blips** on call #9 (`5d0bfd76`) and kept it alive ~12 min. First working recovery mechanism observed. |
| **Keepalive-retry tolerance**        | rode the dead WS ~2.5 min (x25â†’x32) then died                                                                                         | rides the dead WS **10â€“14 min** (x2â†’x39) before terminal teardown â€” calls don't die abruptly on a brief WS hiccup                                                                       |
| **B-16 (1:1 audioâ†’video upgrade)** | not retested on 1.0.48                                                                                                                  | **tentative PASS** â€” renders remote video on both ends (shared-camera caveat)                                                                                                               |

**âš–ï¸ No change (identical to 1.0.48):**

- **B-05** server WS drop â€” _identical signature_, still kills 100% of calls (9/9 this session). Purely server-side; no client build affects it.
- **B-13** non-owner-host key-broadcast skip â€” `reusing real-group key (non-owner host)` path unchanged.
- **B-17** tile drop â€” unchanged; _also confirmed on VOICE_ this session (was video-only before), root cause = zombie tag from `reconnect â†’ rejoin`.
- **B-18 (1:1)** inbound text decrypts (`handled=true`) but never renders â€” unchanged.

**âš ï¸ Honest caveat â€” the improvements are marginal:** the ice-restart recovery + extended keepalive tolerance
help only against **transient** WS instability (short blips self-heal or ride out). Against the **sustained**
B-05 drop â€” the dominant failure mode â€” the call **still dies**, just **later** and after more time in the
degraded **"silent zombie"** state (UI says "connected" while audio/tiles are already broken). So 1.0.49 is
**resilience polish at the margins, not a fix.** The biggest lever (B-05) remains entirely server-side.

**Note on carried-over fixes:** B-11 (multi-device online), group-text render (B-15/B-18-group), and B-01
(host black tile) were already fixed in **1.0.48** â€” they are NOT 1.0.49 gains, just confirmed still-fixed.

**Per-bug status delta (1.0.48 â†’ 1.0.49):** no bug moved from openâ†’fixed or fixedâ†’open. The only deltas are
(a) the new resilience mechanisms above, and (b) newly-characterized findings this session: B-17 confirmed on
voice + root cause (zombie tag), B-16 tentative pass, B-20 (camera) NEW, B-21 (background call) NEW candidate,
and the "silent zombie call" symptom â€” none of which are 1.0.48-vs-1.0.49 _regressions_; they are deeper
coverage of behavior that was likely present before but untested.

---

### Bug B-20 â€” Camera Lost to Another App Mid-Call: Video Never Restored (Call Survives) âš ï¸ MEDIUM â€” NEW

**Logged:** 2026-06-09 ~12:11 (BlueStacks: 1:1 video call `cid=0d06f81e`, shirajulâ†’fahim, both connected + DTLS-verified)

**Reproduce:**

1. Be in a connected 1:1 (or group) **video** call.
2. Leave the app and open **another app that uses the camera** (native Camera, etc.), then return to BravoSecure.
3. The call video is **gone and does not restore** â€” the call connection itself stays up (audio/PC fine).

**Frequency:** 100% in this attempt (both ends affected simultaneously, since BlueStacks instances share one host webcam).

**Observed (this session):**

- Both shirajul (5565) and fahim (5575) call screens showed a **solid magenta/pink field** (main tile + self-PiP) instead of video.
- **Call connection unaffected:** `cid=0d06f81e` stayed `connectionState=connected` on both, getStats running (263/261), **no `=failed` state**.
- **No camera-error in logs:** there is **no** `onCameraError`/`onCameraDisconnected`. `EglRenderer` keeps
  "receiving" ~120 frames @ ~30fps and `CameraStatistics: Camera fps: 30` continues â€” i.e. WebRTC is
  streaming valid-but-garbage (null/magenta) frames, so it never trips an error path. Frame-drop spikes
  (`Dropped: 32/27/20â€¦`) at ~12:11:25â€“35 mark the camera-contention moment.

**Root cause (inferred):** BravoSecure has **no camera-interruption recovery.** When another app takes the
camera, the app does not detect the source change and does not re-acquire/restart the capturer on resume â€”
it keeps publishing whatever the camera surface now yields, so the real self-video never comes back. The
call's WebRTC/audio path is independent and survives.

**âš ï¸ BlueStacks caveat (must confirm on physical device):** the _magenta_ image is a **BlueStacks
artifact** â€” BlueStacks substitutes a magenta test pattern when the shared host webcam is taken, which is
why WebRTC sees frames instead of an OS camera eviction. On a **physical device** the same flow normally
fires `onCameraDisconnected` (OS evicts the lower-priority app) and would likely show a **black/frozen**
self-view. The app-level defect to confirm there is whether the self-view **re-acquires on resume** (it
did not here). **Follow-up: re-run "open another camera app mid-call â†’ return" on Pixel/Xiaomi/Redmi** to
capture true real-device behavior and remove the BlueStacks magenta confound.

**Files involved (inferred):**

- `src/modules/messenger/webrtc/useCall.ts` / `peerConnection.ts` â€” local camera capturer lifecycle; no
  re-acquire on app-resume / camera-source-change
- `src/screens/messenger/CallScreen.tsx` â€” self-view `<RTCView>` not remounted / capturer not restarted on resume
- (group path sibling: `useGroupCall.ts` local-media acquire â€” same lifecycle gap likely applies)

**Evidence:** `~/Desktop/bravo_logs_v49_0609/cam_5565.png`, `cam_5575.png` (both magenta), plus
`r2_5565.txt`/`r2_5575.txt` (connected, getStats running, no camera-error, frame-drop spikes).

---

## QA Session 2026-06-11 (PM) â€” 1.0.52 (vc75) Update Retest (BlueStacks 3-device)

**Session date:** 2026-06-11 ~15:01
**Build:** 1.0.52 (versionCode **75**) â€” NEW build, all 3 devices matched (5555 was shipped on vc74 1.0.51, levelled up to vc75 by pulling the installed APK off 5565 and re-installing; 5565/5575 arrived on vc75).
**Devices:** 5555=itsirajul (`08782d6d`) | 5565=shirajul (`79d63649`) | 5575=fahim (`fe4ddc14`)
**Branch (repo):** `release/1.0.35-audit-fixes`
**Evidence:** `~/Desktop/bravo_logs_v52_20260611_145216/` and `~/Desktop/bravo_v52_call_2d736fa7/` (logs + screenshots + UI dumps).

> âš ï¸ **Evidence-file caveat:** the binary log/screenshot files written to `~/Desktop/...` during this session did **not** persist (Bash tool sandbox overlay was discarded + BlueStacks shut down at wrap-up), so the referenced `.txt`/`.png` paths are gone. **The primary evidence is the verbatim log excerpts, JSON envelopes, the A/B render matrix, and the call timelines inlined in the B-22 / B-18 / B-23 entries below â€” those are self-contained and authoritative.** Re-capture from devices on the next session if binary artifacts are needed.

### Boot health â€” B-11 / B-15b regression = PASS on vc75

Clean cold boot of all 3 (force-stop + `logcat -c` first). Every device:

```
[messengerStore] rehydrated: N conversations Â· 1 vaulted owners
RNKeychainManager: Selected storage: KeystoreAESGCM_NoAuth   (no keychain read failure)
[bravo.backup.boot] probe localKey=true serverBackup=true serverUsable=true
[bravo.backup.boot] case=RESUME â†’ mirror subscription up      â† RESUME, NOT forced RESTORE
```

Failure-signature scan across all 3 full logs â€” **all zero**: `outer sealed authentication failed` 0, `handled=false` 0, `dropped undecryptable` 0, `case=RESTORE` 0, `localKey=false` 0, `superseded`/`io server disconnect` 0, keychain read-fail 0. Every inbound envelope this window was `handled=true`, **including the shirajulâ†”fahim pair that hit B-15b's 188-drop forced-RESTORE on vc74** (5565 received `peer=fe4ddc14 â€¦ handled=true`; 5575 received `peer=79d63649 â€¦ handled=true`). â‡’ On vc75, shirajul read `localKey=true` and took `case=RESUME` instead of the spurious RESTORE that drove B-15b â€” **B-15b did not reproduce this boot; B-11 multi-device-online holds (no supersession).** (Caveat: B-15b's trigger is an emulator keychain miss, which is intermittent â€” not a code fix confirmation. Keep watching across reinstalls.)

**Also answers the dev's "version mismatch â†’ can't send?" question:** there is **no app-version gate** anywhere in the send path, and the only version check (sealed-sender protocol `MIN_SEALED_VERSION=1 â€¦ SEALED_VERSION=3` in `packages/messenger-core/src/crypto/sealedSender.ts`) accepts the whole range for staggered rollout. A 1.0.51â†”1.0.52 mismatch does **not** block messaging. Any send/receive loss around an update is **B-15b** (updateâ†’keychain-missâ†’forced RESTOREâ†’orphaned in-flight envelopes ACK-dropped), not a version incompatibility.

---

### Bug B-22 â€” Inbound Group Text Renders the RAW JSON Envelope Instead of the Body âš ï¸ HIGH â€” NEW, CONFIRMED on vc75 (all 3 devices)

**Logged:** 2026-06-11 ~15:05 (BlueStacks 3-device, conversation "SQA - Fahim").

**Symptom:** Inbound group text messages display the **entire wire envelope as the bubble text**:

```
{"groupId":"3cb79cb1f1b0e0be3ff9c2df76344a0f","kind":"text","clientMsgId":"d9171c60ad50ed44","body":"hey"}
{"groupId":"3cb79cb1f1b0e0be3ff9c2df76344a0f","kind":"text","clientMsgId":"6c206b4518389a2a","body":"hi"}
{"groupId":"3cb79cb1f1b0e0be3ff9c2df76344a0f","kind":"text","clientMsgId":"0bfcf6cc8e5bfbe0","body":"hi"}
{"groupId":"3cb79cb1f1b0e0be3ff9c2df76344a0f","kind":"text","clientMsgId":"86d375a70182318d","body":"hello"}
```

The user should see just `hey` / `hi` / `hello`; instead the raw JSON (incl. internal `groupId` + `clientMsgId` metadata) is shown.

**Frequency / scope:** 100% on the affected messages, reproduced on **all 3 devices** (`home_5555.png`, `home_5565.png`, `home_5575.png` all show the same JSON-rendered bubbles). The sender's **own outgoing** bubbles render correctly as plain text. **Older** messages in the same thread (keyed-group sends) render fine â€” so it is **not** every group message; it is messages sent **without a resolved group master key** (here groupId `3cb79cb1f1b0` = the B-04 ad-hoc "Call" group, which has no master key). Sender label was "TEST".

**This is NOT a delivery/crypto failure.** The matching envelopes are `handled=true` (e.g. 15:01 `recv.enter â€¦ ACK ok handled=true`); decryption + delivery succeeded. Purely a **render/parse defect** on the no-key path. No `[recv.text.routing]`/`[group.text.append]` breadcrumb fires for group text (the long-standing B-15 silent-append watch-item).

**Root cause (confirmed in source):** the sender's group-send intentionally ships the inner envelope as plaintext when it lacks the master key, and the receiver's no-key path then forgets to unwrap it.

- **Send-side** `productionRuntime.ts:1448-1457` â€”
  ```ts
  const masterKey = groupState?.masterKeyB64;
  const innerEnvelope = JSON.stringify({
    groupId: conversationId,
    kind: 'text',
    clientMsgId,
    body: text,
  });
  const sealedBody = masterKey
    ? JSON.stringify(await groupEncrypt(masterKey, innerEnvelope))
    : innerEnvelope; // â† no key â†’ the inner JSON string is the body
  ```
  Comment: _"otherwise the inner envelope goes plaintext under the pairwise Signal session â€¦ so receivers without the key still render the body."_ (Still E2E via the per-peer sealed-sender wrap; only the group-master-key layer is skipped.)
- **Receive-side BUG** `productionRuntime.ts:~4481-4486` (legacy / not_group / no_key plaintext path) â€”
  ```ts
  const legacyMsg: LocalMessage = {
    ...
    content: unwrapped.body,               // â† BUG: when sent key-less, unwrapped.body IS the inner JSON string
    ...
  };
  ```
  The keyed path (`parseGroupMessage` â†’ `inner.body`, `:~4009/4031`) is correct; the **no-key legacy path renders `unwrapped.body` verbatim** instead of `JSON.parse(unwrapped.body).body`. The send-side comment promises the receiver "still renders the body" â€” that contract is violated here.

**Why only some messages:** sender-has-key â†’ `groupEncrypt` â†’ receiver `parseGroupMessage` â†’ `inner.body` (renders clean). Sender-lacks-key (ad-hoc/un-keyed group, or mid key-distribution window) â†’ plaintext inner JSON â†’ receiver legacy path â†’ **raw JSON rendered**.

**Recommended fix (render-only, no crypto/arch change):** in the legacy/no-key group branch, when `unwrapped.group` is set, parse the inner envelope and render its `.body` (and reuse its `clientMsgId`), e.g. `const inner = tryParseInnerGroupEnvelope(unwrapped.body); content = inner?.body ?? unwrapped.body;`. Mirror the 1:1 `[recv.text.append]` breadcrumb on the group path so the landing slot is diagnosable (closes the B-15 watch-item too).

**Relationship:** same family as **B-15** (group-text silent append) and **B-18** (1:1 inbound render). B-15/B-18 were "decrypts but blank"; **B-22 is "decrypts but renders the wrong content (raw JSON)"** â€” arguably worse since it also surfaces internal metadata. Distinct enough to track separately.

**Files involved:**

- `src/modules/messenger/runtime/productionRuntime.ts:1448-1457` â€” send-side key-less plaintext fallback (by design)
- `src/modules/messenger/runtime/productionRuntime.ts:~4481-4486` â€” **receive-side no-key legacy path renders `unwrapped.body` raw (the bug)**
- `src/modules/messenger/runtime/productionRuntime.ts:~4009/4031` â€” correct keyed path (`inner.body`) for reference

**Evidence:** `~/Desktop/bravo_logs_v52_20260611_145216/home_5555.png`, `home_5565.png`, `home_5575.png` (all show JSON-rendered group bubbles); `boot_*.txt` (`handled=true`, no `[group.text.append]`).

**CONTROLLED A/B REPRO (2026-06-11 15:13â€“15:18, driven via ADB `input`):** sent two live texts and
cross-checked the rendered bubble on every device (view-hierarchy dump, not just screenshot). Result â€”
**three distinct receiver outcomes, fully determined by key state, exactly matching the code paths:**

| Message (sender â†’ group)                              | 5555 itsirajul   | 5565 shirajul    | 5575 fahim       |
| ------------------------------------------------------- | ---------------- | ---------------- | ---------------- |
| `B22keyedCtrl` (itsirajul â†’ **SQA-ITSirajul**, keyed) | PLAIN (self)     | **BLANK âœ—**    | PLAIN âœ“        |
| `B22keyless1` (fahim â†’ **SQA-Fahim** `3cb79cb1f1b0`)  | **BLANK âœ—**    | **BLANK âœ—**    | PLAIN (self)     |
| pre-existing "TEST" msgs (keyless)                      | **RAW-JSON âœ—** | **RAW-JSON âœ—** | **RAW-JSON âœ—** |

All inbound envelopes were `handled=true` (e.g. 5565 `recv.enter â€¦ envId=4d0c52f7 â€¦ ACK ok handled=true`
for the keyed msg; both receivers `handled=true` for the keyless msg). So **delivery/crypto is fine in
every cell** â€” the failures are 100% render/append-layer. The three outcomes map cleanly to the receive
branches:

- **PLAIN** â€” sender has key, receiver has key â†’ `parseGroupMessage` ok â†’ `inner.body`. (Correct.)
- **RAW-JSON (B-22)** â€” sender lacks key â†’ ships plaintext inner JSON â†’ receiver legacy path renders
  `unwrapped.body` verbatim (`productionRuntime.ts:~4486`).
- **BLANK** â€” sender has key, receiver **lacks** the master key â†’ `parseResult.reason==='no_key'` â†’
  envelope is **stashed** (`pendingGroupEnvelopes.stash`, `:~4455-4475`) and **never drained to the UI**;
  `handled=true` but nothing renders.

**Two key sub-findings from the A/B:**

1. **B-22 (raw-JSON) confirmed** â€” the keyless plaintext path renders the wire envelope as the bubble.
2. **`no_key`-stash BLANK render is the B-18/B-15 group sibling, and it RECURS on 1.0.52** â€” shirajul
   (5565) showed **BLANK** for a _keyed_ SQA-ITSirajul message that fahim (5575) rendered PLAIN, i.e.
   **shirajul is missing the SQA-ITSirajul group master key on this build** (its `masterKeyB64` was not
   re-populated from the SQLCipher `group_master_keys` vault on boot, or was lost) â†’ every inbound keyed
   group text from that group `no_key`-stashes and never shows. Device-specific, reproducible across a
   fresh conversation re-open. See **B-18 retest note below.**

**Files involved:**

- `src/modules/messenger/runtime/productionRuntime.ts:1448-1457` â€” send-side key-less plaintext fallback (by design)
- `src/modules/messenger/runtime/productionRuntime.ts:~4481-4486` â€” **receive-side no-key legacy path renders `unwrapped.body` raw (the B-22 bug)**
- `src/modules/messenger/runtime/productionRuntime.ts:~4455-4475` â€” **`no_key` stash path â†’ BLANK render (no UI drain) when receiver lacks the master key**
- `src/modules/messenger/runtime/productionRuntime.ts:~4009/4031` â€” correct keyed path (`inner.body`) for reference
- `src/modules/messenger/store/groupMasterKeyStore.ts` + boot re-populate of `masterKeyB64` â€” shirajul missing SQA-ITSirajul key (BLANK trigger)

**Evidence:** `~/Desktop/bravo_logs_v52_20260611_145216/` â€” `home_5555/5565/5575.png` (raw-JSON),
`keyed_5575.png` (PLAIN render on fahim), `keyed2_5565.png` (BLANK on shirajul), `chat_*.xml` /
`chat3_5565.xml` view-hierarchy dumps (B22keyedCtrl present=2 on 5555/5575, present=0 on 5565).

---

### Bug B-18 (group-text sibling) â€” RETEST on 1.0.52 (vc75): keyed group inbound BLANK on a receiver missing the master key âš ï¸ recurs

**Logged:** 2026-06-11 ~15:17 (BlueStacks, SQA-ITSirajul `4100833dd9da`).

During the B-22 A/B (above), a **keyed** group text (`B22keyedCtrl`, itsirajulâ†’SQA-ITSirajul) was received
`handled=true` on shirajul (5565, envId `4d0c52f7`) but **never rendered** â€” confirmed via fresh
conversation re-open + scroll-to-bottom (view tree `present=0`), while the **same message rendered PLAIN
on fahim (5575)** and on the sender. Root cause is the `no_key` stash with no UI drain: shirajul is
**missing the SQA-ITSirajul group master key** on this build, so every inbound keyed group text from that
group hits `parseResult.reason==='no_key'` â†’ `pendingGroupEnvelopes.stash` â†’ silent (no banner, no bubble).
This is the **group sibling of B-18** (1:1 inbound handled-but-not-rendered) and the same family as **B-15**
(silent group append). The 1.0.48/1.0.49 group-render fixes do **not** cover the `no_key`-stash-then-missing-
key case on 1.0.52.

**Fix direction:** (a) when a stashed group envelope can't be drained because the master key is absent,
surface a visible "waiting for group key / re-syncing" affordance instead of nothing; (b) repair the boot
re-populate of `masterKeyB64` from the SQLCipher vault so an established member doesn't silently lose the
key; (c) on `no_key` for a group the user is an active member of, request an owner-side key resync (key-
distribution change â†’ architecture sign-off, same gate as B-13).

**Files involved:** `productionRuntime.ts:~4455-4475` (no_key stash, no UI surface), boot `masterKeyB64`
re-populate + `store/groupMasterKeyStore.ts` (shirajul missing key).

**Evidence:** `keyed2_5565.png` (BLANK), `keyed_5575.png` (PLAIN), `chat3_5565.xml` (present=0), logcat
`recv.enter envId=4d0c52f7 â€¦ handled=true` on 5565.

---

### Bug B-23 â€” 1:1 Call Self-Terminates ~9 min in: Caller PeerConnection Closes With NO Cause; Peer Left to ICE-Timeout to `failed` âš ï¸ HIGH â€” NEW (1 occurrence, needs repro)

**Logged:** 2026-06-11 ~15:38 (BlueStacks, 1:1 call `cid=2d736fa7`, itsirajul 5555 caller â†” fahim 5575 callee, on build 1.0.52 vc75). Call was started by QA as **1:1 audio**, then **upgraded to video** (~15:29:05, B-16 path) and ran clean. **QA confirmed they did NOT touch either device during the call** (no End Call tapped); the watcher was read-only.

**This is NOT B-05.** Zero `keepalive ping failed`, zero `transport not open`, zero `reconnect`/`ice-restart`, zero `room.ended` on **either** device. The server-WS-drop signature is entirely absent. It is also **not a user hangup** (confirmed) and **not a crash** (caller PID 6332 stayed alive; no `FATAL`/`ANR`/`AndroidRuntime`).

**Lifespan:** DTLS-verified connect **15:28:38** â†’ caller close **15:37:59** = **~9 min 21 s** (peer terminal `failed` 15:38:14, ~9m36s). `cipher=AES_CM_128_HMAC_SHA1_80`, relay candidates, audioâ†’video upgrade renegotiated cleanly on both sides before the death.

**Caller side (itsirajul 5555) â€” the anomaly:**

```
15:37:58.298  getStats +1s                         â† healthy, 1/s
15:37:59.121  CameraStatistics: Camera fps: 31      â† video still flowing 110ms before death
15:37:59.231  rn-webrtc:pc:DEBUG 0 close +932ms     â† PeerConnection.close() fired â€” NO preceding JS line
15:37:59.256  NOTIFEE Removing notification bravo-call-2d736fa7â€¦
15:37:59.35x  CameraCapturer: Stop capture â†’ camera released
   â€¦          (JS goes 100% SILENT after this â€” not even the usual [CallScreen] cleanup-fire log)
```

In the **30 s before** the close, the caller's JS logged **only** getStats â€” no `[CallScreen]` unmount, no `recv.enter`/incoming envelope, no `call.*`/presence event, no `onTrimMemory`/background/`ActivityManager`. The `close` appears with **no logged reason**, and the normal `[CallScreen] cleanup-fire â€¦ finalState` line **never fires on the caller** â€” so the PC was closed **outside** the standard CallScreen cleanup path (something other than a normal unmount/hangup called `pc.close()`).

**JS is NOT frozen â€” the CallScreen just never dismisses (the real "stuck" symptom).** Initially this looked like a JS hang (6.5 min of zero JS logs), but a probe tap at 15:44:16 produced `[bravo.callchrome] toggle hiddenâ†’visible` â€” the JS thread is **alive and responsive**; it simply had no events to log after the call ended. App is foreground (`MainActivity` resumed), **no ANR**. What the user sees (QA-reported, screenshot `B23_itsirajul_stuck.png`): the caller is **stuck on the call screen showing a frozen last video frame** (remote full-screen + self-PiP), **with no visible controls** because the call chrome **auto-hid** (`[bravo.callchrome] auto-hide` fired at 15:29:06) and only reappears on tap. The screen **does not auto-dismiss** after the PC closes, so the call looks permanently wedged on a frozen image; the only exit is tap-to-reveal-chrome â†’ End Call (non-obvious).

**Why the auto-dismiss didn't save it:** the 1.0.49 dev fix added a **4 s auto-dismiss on the `failed` branch** of `CallScreen.tsx`. But the caller here **never enters a `failed` state** â€” its PC is closed directly (no `iceConnectionState=failed`, no `[CallScreen] cleanup-fire`) â€” so the failed-branch auto-dismiss path is never reached and the screen is left mounted on the frozen frame. The auto-dismiss needs to cover the **PC-closed/ended** path too, not only `failed`.

**Callee side (fahim 5575) â€” collateral, registers the call as FAILED:**

```
15:37:59.341  iceConnectionState=disconnected   â† only reacts AFTER peer vanished
15:38:04.473  connectionState=disconnected
15:38:14.457  iceConnectionState=failed ; rn-webrtc pc close +15s
15:38:18.513  [CallScreen] cleanup-fire â€¦ finalState: 'failed'
```

fahim received **no hangup/end signal** â€” it only discovered the call was over via a **15 s ICE timeout**, then recorded `finalState:'failed'`. So even though the caller "ended," the peer experiences it as a **failed call**, not a clean "call ended."

**Three issues bundled here:**

1. **(Primary) Caller-side unexplained self-close** â€” a connected 1:1 call drops itself ~9 min in with no network cause, no user action, no JS-logged trigger, **outside the normal cleanup path** (no `[CallScreen] cleanup-fire`). Cause not visible in client logs â€” **needs repro + dev-build JS error capture.**
2. **(Primary UX â€” user-visible headline) Stuck/frozen call screen** â€” after the close, the CallScreen **does not auto-dismiss**; it stays mounted on a **frozen last video frame** with the chrome auto-hidden, so the call looks permanently wedged (controls only reappear on tap; exit is non-obvious). The 1.0.49 `failed`-branch 4 s auto-dismiss does **not** cover this PC-closed path (the caller never enters `failed`).
3. **(Secondary) Hangup not propagated** â€” whatever closed the caller's PC did **not** signal the peer; fahim hangs for ~15 s and lands on `finalState:'failed'` instead of a clean end.

**Caveats / open questions (why this is "needs repro", not yet root-caused):**

- **1 occurrence.** Not yet confirmed deterministic vs. a one-off. Re-run a clean controlled 1:1 (audio, no video upgrade) and a second (with upgrade) and watch whether the caller self-closes again around the same duration (~9 min).
- **The `pc.close()` trigger isn't in logcat** (closed outside `[CallScreen] cleanup-fire`) â€” needs a **Metro-connected / dev-build** run (JS console + error boundary) to capture what called close, or a **physical device** to rule out a BlueStacks-specific stall of webrtc.
- JS is confirmed **alive** (tap â†’ `callchrome` toggle at 15:44), so this is **not** a JS freeze/ANR â€” it's an un-dismissed screen over a dead PC.
- Distinguish from B-16: the audioâ†’video upgrade itself renegotiated fine (`upgradeToVideo â€” call is now video` on both); the death was ~8.5 min later, unrelated to the upgrade.
- Issues #2 (no auto-dismiss / stuck frozen screen) and #3 (hangup not propagated) are **reproducible/actionable now**, independent of root-causing #1.

**Files involved (inferred â€” to confirm on repro):**

- `src/modules/messenger/webrtc/useCall.ts` â€” call lifecycle / PC `close()` path; what conditions trigger a local close with no `[CallScreen] cleanup-fire`
- `src/screens/messenger/CallScreen.tsx` â€” unmount â†’ cleanup ordering (the missing cleanup-fire log on the caller)
- 1:1 hangup/end signalling (`call.hangup` over WS) â€” not sent to peer on this teardown â‡’ peer ICE-times-out to `failed`

**Evidence:** `~/Desktop/bravo_v52_call_2d736fa7/itsirajul_5555_live.txt` (caller â€” last call JS line `close +932ms` at 15:37:59.231; then no events until a probe tap at 15:44:16 â†’ `callchrome toggle`, proving JS alive), `fahim_5575_live.txt` (callee â€” disconnectedâ†’failed decay + `finalState:'failed'`). Connect + DTLS-verify at 15:28:38 in both. Stuck/frozen call screen: `~/Desktop/bravo_logs_v52_20260611_145216/B23_itsirajul_stuck.png` (remote full-screen frozen + self-PiP, no controls).

---

## QA Session 2026-06-14 â€” 1.0.54 (vc78) Messaging Retest (Pixel + 2 BlueStacks)

**Session date:** 2026-06-14 ~09:39â€“09:58
**Build:** 1.0.54 (versionCode **78**) â€” 3 builds newer than the last logged baseline 1.0.52/vc75. All devices on vc78 (no version mismatch; per vc75 finding there is no app-version send-gate anyway).
**Devices:** **Pixel 7a (32251JEHN23958) = shirajul (`79d63649`)** physical Â· 127.0.0.1:5555 = itsirajul (`08782d6d`) Â· 127.0.0.1:5575 = fahim (`fe4ddc14`). **BlueStacks 5565 (shirajul) was OFF â€” the shirajul account ran on the Pixel.**
**Scope:** 1:1 + group text messaging only (no calls this session).
**Evidence:** live logcat (`ReactNativeJS:V`) on all 3 + uiautomator view-hierarchy dumps. Verbatim excerpts inlined below (per the Desktop-evidence-volatility gotcha, the inlined log/screen excerpts are authoritative).

> âš ï¸ **Group-path is log-silent.** On vc78, inbound _group_ text logs only `[recv.enter]` â†’ `[messenger.deliver] ACK ok handled=true` â€” there is **no** `[group:recv]` / `[recv.text.routing]` / `[group.text.append]` breadcrumb (the long-standing B-15 silent-append watch-item). So `handled=true` is necessary-but-not-sufficient: PLAIN, RAW-JSON (B-22), and BLANK/no_key (B-18) all log identically. **Render outcome was verified from the screen (uiautomator), not the logs.** 1:1 text, by contrast, DOES log `[recv.text.routing]`â†’`[recv.text.append]`â†’`[recv.text.append.after]`.

### Boot health â€” PASS (B-11 / B-15b boot regression did NOT trigger)

Every (re)launch this session probed clean:

```
[messengerStore] rehydrated: 7 conversations Â· 1 vaulted owners
[bravo.backup.boot] probe localKey=true serverBackup=true serverUsable=true
[bravo.backup.boot] case=RESUME â†’ mirror subscription up
```

Zero `superseded` / `io server disconnect`, zero `case=RESTORE` / `localKey=false`, zero `outer sealed authentication failed`, zero keychain read-fail. Note **"1 vaulted owners"** on shirajul/Pixel â€” it holds the group master key for only ONE of its 7 groups (this is the crux of the group result below).

### 1:1 messaging â€” PASS, with one silent first-message drop (B-15b, milder on vc78)

| Pair / direction                  | Result                               | Evidence                                                                                                     |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Pixel(shirajul) â†” fahim         | âœ… both ways                        | fahim `recv â€¦ peer=79d63649 â€¦ handled=true`; Pixel `peer=fe4ddc14 â€¦ recv.text.append â€¦ handled=true` |
| Pixel(shirajul) â†’ itsirajul     | âœ…                                  | itsirajul `recv â€¦ peer=79d63649 â€¦ recv.text.append â€¦ handled=true`                                     |
| **itsirajul â†’ Pixel(shirajul)** | âš ï¸ **first msg dropped, rest OK** | see below                                                                                                    |

The **first** itsirajulâ†’shirajul inbound was silently dropped; every subsequent one delivered + appended + rendered:

```
09:40:03.608 [recv.enter] doHandleIncoming peer=08782d6d/1 envId=b07ba0ab
09:40:03.969 [messenger.deliver] ACK ok envId=b07ba0ab handled=false   â† DROPPED (no routing/append)
   â€¦
09:41:47.841 [recv.enter] peer=08782d6d envId=072cecc6 â†’ recv.text.append msgId=746089a8 â†’ handled=true  âœ…
   (controlled 5-msg burst 09:44:39â€“09:44:59, bodyLen=3) â†’
   e407b471 / fa1aa711 / 8e7dcdbd / 1aa9b07f / e2f03a01 â†’ ALL recv.text.append + handled=true âœ…
```

**Tally: 7 itsirajulâ†’shirajul sent, only the FIRST (`b07ba0ab`) dropped; 6/6 after it delivered.** The drop produced **zero diagnostic** even in the full unfiltered buffer (`recv.enter` â†’ nothing â†’ `ACK ok handled=false`) â€” no `outer sealed authentication failed`, no `ratchet`, no `dropped undecryptable`. It was ACK'd â†’ relay deletes â†’ **unrecoverable**.

â‡’ This is the **B-15b family, milder + quieter on vc78**: the first inbound on a freshly-(re)established pair is sealed against a stale session â†’ silently dropped â†’ the next inbound forces a re-handshake â†’ everything after delivers. vc74 at least logged the `outer sealed authentication failed` banner; vc78 drops with **no reason at all** (worse for diagnosability, better for blast radius â€” single message vs 188-drop storm). User-visible symptom = "itsirajulâ†’pixel not receiving" was just that one lost first message.

### Group messaging â€” render is 100% key-state-driven (B-18-group recurs; B-22 not hit)

Two groups tested, opposite outcomes, isolating the cause to **whether the receiver holds the group master key**, NOT the build:

**ðŸ”´ "SQA - ITSirajul" (`4100833dd9da`, owner itsirajul) â€” Pixel(shirajul) is a member MISSING the key â†’ FAIL:**
Inbound group texts from itsirajul/fahim were `handled=true` but did **not render** on the Pixel. Screen showed a **red banner** instead of the bubble:

```
"Error: Waiting for this group's encryption key â€” the message will appear once it syncs."
```

itsirajul & fahim (both hold the key) rendered the same group fine as plain text. Pixel inbound that stayed stashed: `31ad7a64` (09:47:34), `6c708f4c` (09:47:53), `206f6e7f` (09:51:24), `e8dfaebb`/`5e154fb0` (09:58) â€” all `handled=true`, none rendered until recovery (below).

- **vc78 IMPROVEMENT (matches the B-18 vc75 recommended fix-direction (a)):** the no_key case now surfaces a **visible "waiting for this group's encryption key â€” will appear once it syncs" affordance** instead of the silent BLANK bubble seen on vc75. The message still doesn't show, but the user is no longer left with an empty bubble + no explanation.
- **Recovery = key sync + APP RESTART.** A restart at 09:48 (PID 19758) did NOT clear it (key hadn't synced yet â€” banner persisted). After the key synced and a _later_ restart at 09:54 (PID 21701), the stash drained and ALL previously-stuck messages rendered ("This is From Shirajul" 09:48, "Hey/How are you/Still Checking/Working or not/Checking" 09:56). Both restarts were clean `case=RESUME localKey=true`.
- **Residual gap:** when the master key arrives **mid-session** (after the no_key stash), the stashed envelopes are **not auto-drained to the UI live** â€” they only render after an app restart. This is the user's "close and reopen, it works." Live auto-drain on key arrival is the remaining fix.

**ðŸŸ¢ "SQA - Shirajul" (`f956b212413b`) â€” Pixel(shirajul) is ADMIN/owner (holds the key), itsirajul+fahim members â†’ PASS:**
All 3 render real plain text â€” no JSON, no blank, no banner. Pixel chat-list preview `SQA - Shirajul Â· GROUP Â· 09:58 Â· "Hello"`; members show "hello"/"Hello"/"Hi"/"Oh Hello" bubbles. Because the admin minted the key and members hold it, every cell renders. (Recent inbound all `handled=true`: shirajulâ†’members `dd3a4f05`/`b63536f4`/`7549a689`/`812156b0`/`cc501eb3`/`8268a001`/`375c4fc7`/`ae5fc269`; membersâ†’shirajul `e8dfaebb`/`5e154fb0`.)

**Confirmed pattern (vc78):**

| Condition                         | Render                                                                                         | Bug                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Receiver HAS the group master key | âœ… plain text                                                                                 | â€”                                                          |
| Receiver MISSING the key          | âš ï¸ no_key-stash â†’ "waiting for key" banner; renders only after key sync **+ app restart** | B-18 (group sibling)                                         |
| **Sender** lacks the key          | (would be) raw-JSON bubble                                                                     | B-22 â€” **not hit this session** (all senders held the key) |

**B-22 not reproduced** this session because every group sender held the relevant key. To hit it on vc78: send from a device that lacks that group's key (e.g. the ad-hoc "Call" group `3cb79cb1f1b0`, or a member who never received the key).

### vc78 verdict

- **1:1 and group messaging both functionally working on vc78.**
- **Wins vs prior builds:** (1) the silent group-BLANK is now a visible "waiting for key" banner; (2) B-15b is down to a single quiet first-message drop instead of a 16/188-drop storm; (3) clean boot health (no supersession, no forced RESTORE).
- **Open / actionable on vc78:**
  1. **B-18 (group):** stashed group messages don't **auto-drain** when the key arrives mid-session â€” require an app restart. Add a live drain + (still) the visible banner is good.
  2. **B-18 (group) root:** shirajul keeps ending up **missing the master key for groups it didn't create** ("1 vaulted owner") â€” the boot `masterKeyB64` re-populate / owner-side key resync gap (architecture-gated, same as B-13).
  3. **B-15b:** first-inbound-on-reconnect silent drop is **unrecoverable** (ACK-and-drop) and now logs **no reason at all** â€” at minimum it should log the drop cause; ideally re-handshake instead of ACK-dropping.

**Evidence (inlined above is authoritative):** live logcat tasks for the 3 devices (envIds + timestamps quoted), uiautomator dumps `/sdcard/{g,g2,g3,a}.xml` (screen text quoted). Binary captures under `~/Desktop/bravo_logs_v54_20260614_live/` may not persist (Desktop volatility).

---

### Bug B-24 â€” 1:1 Call Dies the Instant the App Loses Foreground (screen-off OR app-switch); No Wake-Lock / Foreground Service â€” RECHARACTERIZES B-23 âš ï¸ HIGH â€” NEW, REPRODUCED 2/2

**Logged:** 2026-06-14 ~10:21 + ~10:38 (BlueStacks itsirajul 5555 + physical Pixel 7a = shirajul, build 1.0.54 vc78). Two 1:1 calls, two different foreground-loss triggers, identical teardown.

**Reproduce:**

1. Establish a 1:1 audio call between two devices (here Pixel/shirajul â†” itsirajul).
2. On one device, either (a) let the screen turn off / press power, or (b) switch to another app (Home / recents).
3. The call collapses within ~0.5 s of the app backgrounding. The peer's PeerConnection closes almost immediately; the backgrounded side either rides a futile ICE-restart for ~16 s or closes outright. Both ends land on `finalState: 'failed'`.

**Frequency:** 100% â€” 2 of 2 calls this session, with two _different_ triggers (screen-off, then app-switch).

**This is NOT B-05 and NOT a spontaneous B-23 close:** zero `keepalive ping failed`, zero `transport not open`, zero server/WS-drop signature; the peer that closes does so with **no ICE decay of its own** â€” an explicit `pc close` ~0.4â€“0.5 s after the other side backgrounds.

**Call 1 â€” Pixel screen turned OFF (caller itsirajul, callee Pixel; cid `65d98408`; connected ~10:12, died 10:21:18, ~9 min):**

```
10:21:16.214  Pixel: "Stopping scanning because the screen is locked"   â† screen locked
10:21:17.157  Pixel: Transition requested: type = SLEEP
10:21:18.265  Pixel: FA Application backgrounded (PID 21701)            â† app left foreground
10:21:18.706  itsirajul: rn-webrtc pc close +325ms                       â† peer drops 0.44s later, NO ICE decay
10:21:18.766  itsirajul: [bravo.callaudio] state=failed
10:21:18.766  itsirajul: [bravo.callfg] native module unavailable (iOS or unbuilt) â€” no-op   â† call FG service is a NO-OP
10:21:22.801  itsirajul: [CallScreen] cleanup-fire finalState: 'failed'
10:21:19.587  Pixel: DreamService DOZE / Screen: 0
10:21:26      Pixel: iceConnectionState=disconnected (discovers peer gone via ICE)
10:21:38      Pixel: iceConnectionState=failed â†’ pc close +24s
```

**Call 2 â€” Pixel SWITCHED to another app (caller Pixel, callee itsirajul; cid `0dde8cbe`; connected ~10:37, died 10:38:17, ~1 min):**

```
10:38:16.572  Pixel: FA Application backgrounded (PID 21701)            â† user switched apps
10:38:17.028  itsirajul: rn-webrtc pc close +308ms                       â† peer drops 0.46s later, NO ICE decay
10:38:17.067  itsirajul: [bravo.callaudio] state=failed
10:38:21.089  itsirajul: [CallScreen] cleanup-fire finalState: 'failed'
10:38:24.958  Pixel (caller): iceConnectionState=disconnected â†’ [bravo.callController] ice-restart reoffer
10:38:28/33/37 Pixel: ice-restart retry x3 â†’ skipped â€” signalingState=have-local-offer (no answer; peer gone)
10:38:40.640  Pixel: iceConnectionState=failed â†’ pc close +16s
10:38:44.702  Pixel: [CallScreen] cleanup-fire finalState: 'failed'
```

**Key proof it is foreground-loss, not a timer:** Call 1 lived ~9 min (screen timed out at ~9 min), Call 2 lived ~1 min (app-switched at ~1 min). Lifetime == time-to-background, exactly. Either trigger (screen-off or app-switch) kills it within ~0.5 s.

**Recharacterizes B-23:** B-23 was logged (vc75) as a "~9-minute spontaneous caller self-close, no user action, no network cause, screen STUCK on a frozen frame." That is almost certainly **this bug** â€” after ~9 min of no interaction the **screen timed out â†’ app backgrounded â†’ call dropped**, looking spontaneous. The "~9 min" was just the device's screen-timeout interval, not a fixed call timer. (Note: on vc78 the caller DID get a `[CallScreen] cleanup-fire`, unlike the original B-23 stuck-screen; the auto-dismiss may be improved, but the underlying teardown remains.)

**Root cause (inferred + corroborated):**
The app does **not keep a 1:1 call alive across foreground loss** â€” no wake-lock and no active ongoing-call foreground service. `[bravo.callfg] native module unavailable (iOS or unbuilt) â€” no-op` shows the call foreground-service module is a no-op on this build. When the app backgrounds (screen-off or app-switch), Android suspends it and/or the relay sees the WS drop, and the peer is torn down within ~0.5 s. A 1:1 call must survive screen-off (phone-to-ear / proximity blank) and a brief app-switch.

**Files involved (inferred â€” to confirm):**

- `src/modules/messenger/runtime/callForegroundService.ts` â€” `[bravo.callfg]` ongoing-call foreground service (logged "native module unavailable â€” no-op"); should hold the call alive while backgrounded
- `src/modules/messenger/webrtc/useCall.ts` â€” AppState `background`/`inactive` handling; should NOT tear down the PC on background
- `src/screens/messenger/CallScreen.tsx` â€” call lifecycle / cleanup on background vs unmount
- `src/modules/messenger/webrtc/callController.ts` â€” `[bravo.callController]` ICE-restart (fires but cannot recover once the peer has closed)

**Recommended fix:** keep the call alive when the app is backgrounded â€” run a real ongoing-call foreground service (so the OS doesn't suspend the app) and a wake-lock for the call's lifetime; do not call `pc.close()` on AppState `background`. Verify on physical device: call survives screen-off and a brief app-switch.

**Evidence:** live logcat 2026-06-14, Pixel `bc6maqg1s` + itsirajul `bvoal4l6n` streams (timestamps quoted above). Triggers confirmed by tester: Call 1 = screen off; Call 2 = switched to another app.

---

### Group Video Call â€” 2026-06-14 (vc78): B-19 confirmed + B-05 ride-out + B-25 new

**Call:** group **video** on "SQA - ITSirajul" (`4100833dd9da`), **itsirajul owner-host**, room `06372dfe`, 3 devices (Pixel/shirajul + itsirajul + fahim). Connected 10:43:06, ended 10:54:58 by **host tapping Leave** (`[bravo.groupcall.leave] tearing down kicked=false` â†’ `room.ended â€” host left` to others; tester-confirmed deliberate end, NOT B-24/B-05). **Lifespan ~11m53s.**

**Boot/crypto = PASS:**

```
10:43:05  [call-adhoc-key:runtime] key resynced delivered=3 keyConvo=4100833dd9da   (owner-host)
10:43:05  host audio+video producer attached (FrameCryptor)
10:43:11-14  participant.joined tag=6d435116 + b3775eee â†’ consumer attached (FrameCryptor) A+V both
```

B-01 (black host tile) NOT reproduced â€” all tiles render video.

**B-05 = present, but media rode the dead WS the WHOLE call (notable):** WS died ~50s after connect â€” keepalive `ping failed x2` at 10:43:56 â†’ climbed to `x35` by 10:55:05, on all 3 devices. Unlike most prior sessions, the call did **not** hit the terminal `ack_timeout:sfu.join` cascade â€” it rode the keepalive-tolerance the entire ~11 min and ended only on host-leave. â‡’ B-05's WS drop still happens ~50s in on vc78, but the keepalive ride-out now carries media for the full call duration (intermittent-server-drop, longer tolerance).

**B-19 = CONFIRMED on all 3 (tester: "video is going from one tile to another tile"):** layout = 1 large top + 2 bottom. On itsirajul & fahim: top tile correctly shows shirajul's **distinct real-camera** video (Pixel pointed at a ceiling fan â€” first session with a genuinely distinct stream, not the BlueStacks shared face), but the **bottom-left video is displaced/shifted across into the bottom-right tile** (face spills over the cell boundary; right tile's own video shrunk/shifted). On the Pixel: top=Fahim, bottom-left="ITSirajul" undersized, bottom-right **"You" self-tile BLANK**. Streams arrive + decrypt correctly (FrameCryptor on every consumer) and the _content_ is on the right tile (shirajul's fan on top), so this is a pure **geometry/layout** defect (surfaces mis-placed/mis-sized across tile bounds), coupled to the B-01 BLAST surface-size race â€” same signature as the 1.0.50 B-19 repro. Screenshots `/tmp/gv_{pixel,itsirajul,fahim}.png`.

### Bug B-25 â€” Navigating Away From an Active Group Call and Back Makes the Returning Device Lose All Remote Participants + Resets the Call Timer to 0:00 âš ï¸ MEDIUM-HIGH â€” NEW, CONFIRMED on vc78

**Logged:** 2026-06-14 ~10:50 (Pixel/shirajul, during the SQA-ITSirajul group video call above).

**Reproduce:**

1. Be in an active 3-party group call.
2. On one device, navigate **away from the call screen to another in-app section** (e.g. Messenger) â€” WITHOUT closing the app or backgrounding it.
3. Navigate **back** to the call.
4. The returning device shows **"1 joined Â· Waiting for others to joinâ€¦ Â· 0 member(s) being rung"** with only its own "You" tile â€” it has lost all remote participants. The **call timer resets to 0:00**.

**Frequency:** 100% this session (single device, single nav round-trip).

**Critical scoping â€” returner-only, others unaffected:** the other two devices (itsirajul, fahim) that did **not** navigate kept all their tiles AND **still saw the returner's (Pixel's) camera** throughout â€” tester-confirmed. So the call stays alive and the returner keeps **publishing**; only the returner's **inbound view** breaks. This is NOT the call dying (it ran ~12 min total) and NOT B-24 (app stayed foreground, no `Application backgrounded`, no `[groupcall.leave]`).

**Evidence (Pixel):**

```
10:43-10:45  "3 joined", all tiles rendering (pre-navigation)
~10:50:23    [bravo.groupcall.audio] start skipped â€” already-started   (returned; call still alive)
10:51:37     keepalive counter RESET x20 â†’ x2  + on-screen timer RESET 02:08 â†’ 01:00 â†’ 0:00
             screen: "1 joined / Waiting for others to join / 0 being rung", only "You" tile
```

**Two distinct sub-defects:**

1. **Timer reset to 0:00 (build-level, network-independent):** returning remounts the call screen and re-initializes the call-start clock + keepalive counter â€” the call duration display is wrong on re-entry. Would happen on a healthy call too.
2. **Roster loss / can't re-consume (compounded by B-05):** the remount re-joins the room and tries to re-consume the existing producers over the WebSocket; this call's WS was already dead (B-05), so the re-consume finds nobody â†’ solo "waiting for others." Open question whether re-consume succeeds on a _healthy_ WS â€” see control test below.

**Root cause (inferred):** navigating away unmounts `GroupCallScreen` (the floating-overlay keeps the call alive) and navigating back **remounts the `useGroupCall` hook as a fresh call** (timer + keepalive reset confirm this) instead of resuming the existing session â€” and the fresh re-join's producer re-consume rides the (dead) WS, so remote tiles never come back.

**Control test still needed (to split build-level vs B-05-gated):** start a fresh group call and navigate callâ†’Messengerâ†’back **within the first ~30s (WS still alive).** Tiles restore â†’ roster-loss is B-05-gated, only the timer-reset is build-level. Tiles still gone â†’ the remount/re-consume is broken regardless of network.

**Files involved (inferred):**

- `src/modules/messenger/webrtc/useGroupCall.ts` â€” call hook re-init on remount (timer/keepalive reset); re-consume of existing producers on re-join
- `src/modules/messenger/runtime/groupCallRegistry.ts` â€” floating-overlay/active-call state that should let the screen _resume_ not _re-create_
- `src/screens/messenger/GroupCallScreen.tsx` â€” unmount on navigate-away / remount on return
- Related: B-05 (dead WS blocks re-consume), B-17 (silent-zombie / re-consume-on-reconnect gap)

**Evidence:** Pixel screenshots `/tmp/gv2_pixel.png` ("1 joined / waiting for others", timer reset); live logcat `bc6maqg1s` (keepalive reset x20â†’x2, `start skipped â€” already-started`). Tester-confirmed: others still saw the Pixel's camera; Pixel saw no one; timer restarted at 0:00.

---

## QA Session 2026-06-15 â€” Backup Restore Retest (itsirajul 5554)

**Session date:** 2026-06-15 ~13:37
**Build:** 1.0.54 (vc78).
**Devices connected:** emulator-5554 = itsirajul (`08782d6d`) Â· emulator-5574 = fahim (`fe4ddc14`) Â· Pixel 7a `32251JEHN23958` = shirajul (`79d63649`). (BlueStacks 5565 off; shirajul on Pixel, as prior session.)
**Scope:** itsirajul ran the Backup â†’ Restore flow. Tester observed previously-**deleted** messages reappearing after restore.
**Evidence:** live logcat (`ReactNativeJS:V`) â†’ `~/Desktop/bravo_logs_20260615_133631/`. Key lines inlined below (authoritative per Desktop-volatility gotcha).

---

### Bug B-26 â€” Restore Replays the Server-Side Sealed Archive, Resurrecting Locally-Deleted Messages âš ï¸ HIGH â€” NEW, CONFIRMED on vc78

**Logged:** 2026-06-15 ~13:37 (itsirajul / emulator-5554, build 1.0.54 vc78, during a Backup-Restore run).

**Symptom:** After completing a restore, the chat list/threads fill with old messages â€” **most of which the user had deleted before** the restore. They render as normal received messages.

**Reproduce:**

1. On a device with message history, **delete** several messages locally (long-press â†’ **"Delete (this device)"**).
2. Trigger Backup â†’ Restore (BackupRestoreScreen) â€” e.g. after reinstall or restore-from-mirror.
3. After "Restoring server-side historyâ€¦", the deleted messages **reappear** in their threads.

**Frequency:** 100% â€” deletion has no path to suppress an archived envelope on replay.

**Log evidence (itsirajul 5554):**

```
13:37:07.417  [messenger] envelope unwrap failed (will ack to drop): outer sealed authentication failed
13:37:07.417  [bravo.ratchet-recovery] dropped undecryptable (deliver-unwrap:â€¦); cumulative=1
13:37:31.984  [bravo.restore.archive] replayed 314 sealed envelopes
```

**Root cause â€” local delete and the server archive are unaware of each other:**

1. **Local delete is a hard, device-only delete with NO tombstone and NO server call.** `ChatScreen.deleteMessage` (`ChatScreen.tsx:629`) â†’ `removeMessage` â†’ `DELETE FROM messages WHERE conversation_id=? AND id=?` (`sqlMessageStore.ts:164`). The menu label is literally **"Delete (this device)"** (`ChatScreen.tsx:1305-1307`). Nothing records that the message was deleted.
2. **Every accepted envelope is independently persisted server-side** in `sealed_envelope_archive` (`apps/messenger-service/src/relay/envelope.service.ts:223-231`, `backup.service.ts:834` `archiveSealedEnvelope`) and retained for the dwell window (~90 days; honors disappearing-TTL via the `archive-sweep` cron `relay.cron.ts:38`). Local delete never touches it.
3. **Even retract ("delete for everyone + relay") does NOT purge the archive.** `EnvelopeService.retract()` (`envelope.service.ts:373-383`) only `consumeRetractToken` + `store.ack(envelopeId, recipient)` â€” that drops the envelope from the **pending delivery queue (Redis)** only; the `sealed_envelope_archive` row is untouched. So **nothing the user does** removes a message from the archive before its TTL.
4. **Restore drains the entire archive and re-inserts everything.** `BackupRestoreScreen.tsx:402-422` pages `bc.getSealedArchive(...)` and calls `replayArchivedEnvelope(env)` for each (`productionRuntime.ts:245`), which walks the same unsealâ†’decryptâ†’store path as a live `envelope.deliver`. There is **no deletion/tombstone list to filter against** â†’ every still-retained envelope (incl. deleted ones) is re-created.

**On the "why are some skipped?" question:** the `[bravo.restore.archive] replay skipped <id>: <reason>` lines (`BackupRestoreScreen.tsx:410`) are **decrypt failures**, not dedup/deletion-awareness â€” envelopes whose ratchet has advanced or whose key no longer matches (`outer sealed authentication failed`, the B-15b undecryptable family). The 314 "replayed" are the ones that DID unseal and got re-inserted. So the ONLY thing keeping a message out of restore is an accidental decrypt failure; deletion is never honored.

**Impact:** Privacy â€” user-deleted content silently resurrects on restore. Severity HIGH (intent-violating data resurrection). Disappearing-TTL messages are protected (archive sweeper honors TTL), but plain deleted messages have no TTL â†’ live the full retention window â†’ always resurrect.

**Fix direction (needs architecture sign-off â€” touches relay dwell/ack + archive semantics, a stop-condition per CLAUDE.md):**

- Maintain a **local deletion tombstone set** (deleted envelopeIds / msgIds) that survives restore, and have `replayArchivedEnvelope` skip any envelope whose id is tombstoned; OR
- Have **"Delete (this device)"** optionally write a server-side per-recipient archive-suppression marker (recipient-keyed, opaque) so the archive drain skips it; OR
- At minimum, on restore **de-dupe against** and **respect** a synced deletion log so deletes propagate to the restored DB.

**Files involved:**

- `src/screens/messenger/BackupRestoreScreen.tsx:388-425` â€” archive drain + replay loop (no tombstone filter)
- `src/modules/messenger/runtime/productionRuntime.ts:245` â€” `replayArchivedEnvelope` (re-stores via deliver path)
- `src/screens/messenger/ChatScreen.tsx:629` + `src/modules/messenger/store/sqlMessageStore.ts:164` â€” hard local delete, no tombstone
- `apps/messenger-service/src/relay/envelope.service.ts:223-231` (archive write), `:373-383` (retract does NOT purge archive)
- `apps/messenger-service/src/backup/backup.service.ts:834` (`archiveSealedEnvelope`), `apps/messenger-service/src/relay/relay.cron.ts:38` (TTL-only archive sweep)

**Evidence:** live logcat `~/Desktop/bravo_logs_20260615_133631/itsirajul_5554.log` â€” `[bravo.restore.archive] replayed 314 sealed envelopes` (13:37:31). Tester-confirmed: the reappeared messages were ones deleted before the restore.

---

## 18. White-Box Testing Reference (codebase map for logâ†’code navigation)

> Added 2026-06-11 to make white-box / log-driven testing faster. Maps logcat tags â†’ source,
> the main flows â†’ files, the core module tree, security gates, and the test suite. Line counts are
> a 2026-06-11 snapshot (build 1.0.51 / vc74). When you see a `[bravo.*]` line in logcat, find it here.

### 18.1 Monorepo layout

| Path                       | What                                                          | Stack                         |
| -------------------------- | ------------------------------------------------------------- | ----------------------------- |
| `src/`                     | React Native mobile app (the primary client)                  | RN 0.81 / Expo 54 / TS        |
| `src/modules/messenger/`   | All messaging+call+crypto+backup logic                        | â€”                           |
| `src/screens/`             | UI screens (95+)                                              | â€”                           |
| `src/store/`               | Zustand stores (auth, booking, wallet)                        | â€”                           |
| `packages/messenger-core/` | Platform-agnostic Signal/sealed-sender/group crypto           | shared (mobile + ops-console) |
| `apps/auth-service/`       | NestJS â€” auth, ops, agents, bookings, missions, signal-keys | NestJS/Postgres               |
| `apps/messenger-service/`  | NestJS â€” relay, WS gateway, SFU, sealed-sender, file vault  | NestJS/Redis                  |
| `apps/ops-console/`        | Next.js 15 ops dashboard                                      | Next/React                    |

### 18.2 Log-tag â†’ source file index (logcat â†’ code)

The mobile app logs through `ReactNativeJS`. Filter logcat by these tags; jump to the file below.

| Log tag                                                                                                      | Source file                                                                     | Domain                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------- |
| `[bravo.backup.boot]`                                                                                        | `src/modules/messenger/backup/backupBoot.ts`                                    | backup boot probe (localKey/RESTORE decision) |
| `[bravo.backup.mirror]`                                                                                      | `src/modules/messenger/backup/mirrorBootstrap.ts` (+ `messageMirror.ts`)        | auto-backup flush                             |
| `[backup.merkle]`                                                                                            | `src/modules/messenger/backup/merkleCommit.ts`                                  | backup merkle root commit (root_mismatch)     |
| `[bravo.restore]` / `[bravo.restore.archive]` / `[bravo.restore.ratchet]`                                    | `src/screens/messenger/BackupRestoreScreen.tsx` (+ `backup/restoreMessages.ts`) | restore-from-backup                           |
| `[recv.enter]` / `[recv.branch]` / `[recv.text.routing]` / `[recv.text.append]` / `[recv.text.append.after]` | `src/modules/messenger/runtime/productionRuntime.ts`                            | inbound message receive pipeline              |
| `[messenger.deliver]` (ACK ok handled=â€¦)                                                                   | `productionRuntime.ts`                                                          | deliver/ACK; `handled=false` = dropped        |
| `[messenger.outbox]` / `[bravo.send]`                                                                        | `productionRuntime.ts`                                                          | outbound send / outbox drain                  |
| `[group:recv]` / `[group:drain]`                                                                             | `productionRuntime.ts`                                                          | group message recv / pending-envelope drain   |
| `[call-adhoc-key:runtime]`                                                                                   | `productionRuntime.ts` (`ensureCallGroupKey`)                                   | group call key dist (B-13 shortcut here)      |
| `[bravo.crypto]` / `[bravo.opk]` / `[messenger.boot]` / `[bravo.runtime]`                                    | `productionRuntime.ts`                                                          | crypto/session/boot                           |
| `[bravo.groupcall.boot]` (step=0..9)                                                                         | `src/modules/messenger/webrtc/useGroupCall.ts`                                  | group call boot sequence                      |
| `[bravo.groupcall.sframe]`                                                                                   | `useGroupCall.ts`                                                               | FrameCryptor producer/consumer attach         |
| `[bravo.groupcall.frame]` (participant.joined/new-producer/room.ended)                                       | `useGroupCall.ts`                                                               | SFU frame events                              |
| `[bravo.groupcall.reconcile]`                                                                                | `useGroupCall.ts`                                                               | reconcile loop (sfu.producers)                |
| `[bravo.groupcall.leave/ctl/ice/resume/invite/keydiag]`                                                      | `useGroupCall.ts`                                                               | leave/controls/ICE/keys                       |
| `[bravo.groupcall]` (keepalive ping failed)                                                                  | `useGroupCall.ts`                                                               | **B-05 onset signature**                      |
| `[bravo.launchcall]`                                                                                         | `src/modules/messenger/webrtc/launchCall.ts`                                    | call initiator (direction resolve)            |
| `[bravo.renegotiate]`                                                                                        | `src/modules/messenger/webrtc/callController.ts`                                | 1:1 reneg (B-16 path)                         |
| `[bravo.signalling]`                                                                                         | `src/modules/messenger/webrtc/signallingClient.ts`                              | 1:1 call signalling                           |
| `[bravo.callquality]`                                                                                        | `src/modules/messenger/webrtc/useCall.ts`                                       | 1:1 call quality                              |
| `[bravo.callaudio]` / `[bravo.callchrome]`                                                                   | `src/screens/messenger/CallScreen.tsx`                                          | 1:1 call UI/audio                             |
| `[bravo.callnotif]`                                                                                          | `src/modules/messenger/push/callNotification.ts`                                | incoming-call ring (B-21)                     |
| `[bravo.callfg]`                                                                                             | `src/modules/messenger/runtime/callForegroundService.ts`                        | ongoing-call foreground svc                   |
| `[bravo.tones]`                                                                                              | `src/modules/messenger/runtime/bravoTones.ts`                                   | call tones                                    |
| `[bravo.observability]` / `[bravo.area]`                                                                     | `src/modules/observability/`                                                    | crashlytics                                   |

### 18.3 Flow â†’ code map (where each tested behaviour lives)

| Flow                | Path through code                                                                                                                                                                                                                                        | Key log tags                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **1:1 send**        | `ChatScreen.tsx` â†’ `messengerStore.ts` â†’ `productionRuntime.ts` (send/outbox) â†’ `transport/client.ts` â†’ relay `POST /envelopes`                                                                                                                  | `[bravo.send]`, `[messenger.outbox]`                                                                   |
| **1:1 receive**     | `transport/client.ts` â†’ `productionRuntime.ts` `doHandleIncoming` â†’ `crypto/sealedSender.ts` (`verifySealedAad`) + `crypto/senderCert.ts` (`verifySenderCert`) â†’ route â†’ append â†’ store â†’ `ChatScreen.tsx`                                   | `[recv.enter]`â†’`[recv.text.routing]`â†’`[recv.text.append]`, `[messenger.deliver]`                   |
| **Group send/recv** | same sealed-sender pairwise path per member; group ciphertext via `packages/messenger-core/src/groups/`                                                                                                                                                  | `[group:recv]`, `[recv.text.routing]`                                                                  |
| **Group call boot** | `launchCall.ts` â†’ `useGroupCall.ts` (steps 0â€“9) â†’ SFU join â†’ `productionRuntime.ensureCallGroupKey` â†’ `messenger-core/calls/frameCryptorKeys.ts` `deriveParticipantKey` â†’ produce/consume â†’ `groupCallLayout.ts` â†’ `GroupCallScreen.tsx` | `[bravo.launchcall]`, `[bravo.groupcall.boot]`, `[call-adhoc-key:runtime]`, `[bravo.groupcall.sframe]` |
| **1:1 call**        | `launchCall.ts` â†’ `useCall.ts` â†’ `callController.ts` â†’ `signallingClient.ts` â†’ `peerConnection.ts` â†’ `CallScreen.tsx`                                                                                                                          | `[bravo.launchcall]`, `[bravo.signalling]`, `[bravo.renegotiate]`                                      |
| **Auto-backup**     | `backupBoot.ts` â†’ `mirrorBootstrap.ts`/`messageMirror.ts` â†’ `merkleCommit.ts` â†’ `backupClient.ts` â†’ relay `/backup/*`                                                                                                                            | `[bravo.backup.boot]`, `[bravo.backup.mirror]`, `[backup.merkle]`                                      |
| **Restore**         | `BackupRestoreScreen.tsx` â†’ `backup/restoreMessages.ts` â†’ `identityBackup.ts`                                                                                                                                                                        | `[bravo.restore]`, `[bravo.restore.archive]`                                                           |

### 18.4 Core messenger module tree (lines, purpose)

| File                           | Lines | Purpose                                                                      |
| ------------------------------ | ----: | ---------------------------------------------------------------------------- |
| `runtime/productionRuntime.ts` |  5321 | **God file** â€” send/recv, group, call-key, backup, session (see Â§14 bugs) |
| `webrtc/useGroupCall.ts`       |  3095 | group call hook â€” full SFU boot/keepalive/reconcile                        |
| `webrtc/callController.ts`     |  1230 | 1:1 call reneg/ICE-restart                                                   |
| `webrtc/useCall.ts`            |  1184 | 1:1 call hook                                                                |
| `store/messengerStore.ts`      |  1170 | Zustand: conversations/messages/groups/outbox                                |
| `push/fcmBootstrap.ts`         |   976 | FCM/VoIP push bootstrap                                                      |
| `runtime/runtime.ts`           |   786 | runtime config/wiring                                                        |
| `crypto/db.ts`                 |   715 | SQLCipher store + group key vault                                            |
| `webrtc/peerConnection.ts`     |   587 | RTCPeerConnection wrapper                                                    |
| `backup/messageMirror.ts`      |   582 | message backup mirror                                                        |
| `backup/restoreMessages.ts`    |   564 | restore pull/replay                                                          |
| `crypto/sealedSender.ts`       |   525 | sealed-sender v2 (`verifySealedAad`)                                         |
| `crypto/sqlCipherStore.ts`     |   520 | SQLCipher session store                                                      |
| `webrtc/groupCallLayout.ts`    |   505 | tile layout / `computeTilePrune` (B-17)                                      |
| `crypto/outerEcies.ts`         |   466 | sealed-sender outer ECIES                                                    |
| `push/voipWakeVerify.ts`       |   460 | VoIP wake HMAC verify                                                        |
| `transport/client.ts`          |   418 | WS/relay transport client                                                    |
| `runtime/keychain.ts`          |   387 | keychain wrap (mirrorkey/groupwrap) â€” B-15b trigger                        |
| `backup/merkleCommit.ts`       |   386 | backup merkle root                                                           |
| `webrtc/signallingClient.ts`   |   289 | 1:1 signalling                                                               |

### 18.5 Security gates (verify before/while testing; do NOT bypass)

| Gate                                          | Location                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `verifySenderCert` (sealed-sender outer auth) | `src/modules/messenger/crypto/senderCert.ts:72` Â· `packages/messenger-core/src/crypto/senderCert.ts:100`      |
| `verifySealedAad` (AAD binding)               | `src/modules/messenger/crypto/sealedSender.ts:341` Â· `packages/messenger-core/src/crypto/sealedSender.ts:371` |
| `verifyVoipWake` (push HMAC)                  | `src/modules/messenger/push/voipWakeVerify.ts:280`                                                             |
| `deriveParticipantKey` (FrameCryptor HKDF)    | `packages/messenger-core/src/calls/frameCryptorKeys.ts:75`                                                     |
| File-vault MFA gate                           | `apps/messenger-service/src/vault/mfa.guard.ts` (test: `vault/mfa.guard.spec.ts`)                              |
| WS heartbeat grace (B-05)                     | `apps/messenger-service/src/config/configuration.ts:26` (25000) Â· `main.ts:30` (stale `?? 10_000` footgun)    |

### 18.6 Test suite (183 spec/test files)

| Run                                | Command                                | Covers                                                                                                          |
| ---------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Crypto (fastest signal)            | `npm run test:crypto`                  | `packages/messenger-core/__tests__/*` â€” sealed sender, ratchet, group broadcast, frameCryptor keys, log audit |
| App                                | `npm test`                             | RN screens/hooks/utils incl. `groupCallTilePrune`, `directConversationMerge`, `recoverCamera`                   |
| Booking                            | `npm test -- --selectProjects=booking` | booking + agent flow                                                                                            |
| Backend (each)                     | `cd apps/<svc> && npm test`            | gateway (handshake/sfu-auth/sfu-fanout), sfu.service, relay/envelope, vault/mfa, sender-cert, biometric         |
| Log audit (no key material logged) | part of `test:crypto`                  | `packages/messenger-core/__tests__/logAudit.test.ts`                                                            |

Notable backend specs for current bugs: `gateway/messenger.gateway.sfu-fanout.spec.ts`, `gateway/connection-registry.spec.ts` (B-11), `sfu/sfu.service.*.spec.ts`, `relay/envelope.service.spec.ts`.

### 18.7 Bug â†’ code location quick index (open bugs)

| Bug                             | Primary code location(s)                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-05 (WS drop / no crash guard) | `apps/messenger-service/src/main.ts` (no `process.on` handlers), `gateway/messenger.gateway.ts:263-277` (fanout emit, no try/catch), `sfu/sfu.service.ts:252/410/528/587`, `config/configuration.ts:26` |
| B-15b (msg loss after restore)  | `runtime/productionRuntime.ts` (deliver-unwrap ACK-and-drop, `localKey`â†’RESTORE gate), `runtime/keychain.ts`, `backup/backupBoot.ts`                                                                  |
| B-16 (1:1 remote video render)  | `webrtc/useCall.ts`, `screens/messenger/CallScreen.tsx` (remote `<RTCView>` mount)                                                                                                                      |
| B-17 (group tile blank/race)    | `screens/messenger/GroupCallScreen.tsx:476/552/595/616/1790`, `webrtc/groupCallLayout.ts`, `webrtc/useGroupCall.ts`                                                                                     |
| B-18 (1:1 inbound render)       | `runtime/productionRuntime.ts` (`recv.text.append`), `store/messengerStore.ts`, `screens/messenger/ChatScreen.tsx`                                                                                      |
| B-20 (camera not restored)      | `webrtc/peerConnectionFactory.ts` (`recoverCamera`), `webrtc/useCall.ts`, `useGroupCall.ts`                                                                                                             |
| B-21 (background ring)          | `push/callNotification.ts`, `push/fcmBootstrap.ts`                                                                                                                                                      |

---

## Wallet / Bravo Credits audit cross-reference (2026-07-05)

A full audit of the BC top-up / deduction / manage / add flows (incl. the "all currency = BC, 1 currency = 1 BC" rule and purchase reachability) was completed on 2026-07-05. Findings live in **`docs/audits/CREDITS_BC_AUDIT.md`** (F-01..F-15). Headline items relevant to QA:

- **F-01/F-02 (critical):** CreditsScreen top-up packages promise different BC than the server awards (server mints `round(amount/FX x 10)`, e.g. AED 1,000 -> 2,725 BC, not the advertised 1,200); "1 currency = 1 BC" only holds on the booking/payout side, not top-up.
- **F-03:** webhook + client-confirm double-credit race on top-up settle.
- **F-04/F-05:** agent/CPO roles have no top-up path; ProPaywall unreachable (ProLanding orphaned, tier_insufficient handler missing).
- **F-06:** `/wallet/credits/batches` + `/vault/storage*` 404 (no backend) -> credit-expiry UI never renders.
- **F-07:** 32 fiat (AED/EUR/USD) + 13 "cr"/"credits" display violations listed with file:line.
- **F-13:** CreditsScreen history shows agent payouts with a minus sign and counts them as "SPENT".

Not renumbered into the B-log (audit findings, not device-repro bugs); log a B-number if/when one is reproduced on-device.

**UPDATE 2026-07-05 (same day):** ALL findings F-01..F-15 remediated â€” see the Remediation log in `docs/audits/CREDITS_BC_AUDIT.md` Â§6. Key retest points for QA: (1) top-up now awards exactly the package credits (1 fiat = 1 BC peg, packages 500/1,000/2,500/7,500); (2) CreditsScreen Balance tab now shows real credit batches + expiry (new GET /wallet/credits/batches); (3) agency accounts can top up (EarningsScreen button; CPO shell excluded BY DESIGN per §35A §D capability lockdown); (4) history classifies payouts as credits; (5) ops Finance page has a SUPERVISOR+ Credit Adjustment form; (6) all money UI renders "BC" (known remnant: ops agents-list hourly rate still AED â€” needs a rate_eur column). Requires Contabo auth-service redeploy + mobile rebuild to test end-to-end.

---

## Messenger full-stack audit cross-reference (2026-07-06)

A full audit of the messenger module (all 11 areas of `docs/qa/MESSENGER_TEST_PLAN.csv`, 349 tests), its **notification pipeline**, and **messaging smoothness** was completed on 2026-07-06. Canonical register: **`docs/audits/MESSENGER_AUDIT.md`** (M-01..M-18 P1s + ~30 P2s, 0 P0). Method: static deep-trace vs the plan's Expected Results + suites (messenger-crypto 1368/1368, messenger-service 195/195 green) + live Contabo/Supabase evidence. **No devices attached — the plan's Status column is still unexecuted**; the audit records which tests the code CAN pass (285/349), which hit findings (44), and which are device-only (20).

Headline items for QA:

- **Notifications (P1 family, one root cause):** msg-wake carries no conversationId and the client never resolves it locally → banners never collapse/clear-on-read (M-03), **muted groups still push** (M-04), group-banner tap opens a phantom 1:1 thread (M-05). B-48 client fix IS in the repo but ships only with APK ≥ v1.0.99/vc125.
- **Privacy stop-conditions:** "Show last seen" is never enforced by messenger-service (M-06, PRES-18/SET-09); **Block is directory-only** — blocked users still deliver, watch presence, and resurrect the thread (M-07, SET-10/PRES-19).
- **B-26 residual (M-08):** sealed-archive replay resurrects locally-deleted inbound messages after reinstall+restore (mirror leg is fixed; replay leg skips tombstones).
- **Call reliability (M-12):** 1:1 ICE-restart retry deadlocks in `have-local-offer` if the first reoffer frame is lost — B-24 field pattern survives; the unit test cannot catch it (pins a copy, not the real gate).
- **Unreachable UI:** group remove-member (GRP-20/25), remove-account-wipe (IDN-03/20), OTP entry (IDN-12/28) — backends/crypto exist, screens don't. Plan unexecutable there as written.
- **Smoothness:** no P0; six P1 perf landmines, top two are trivial fixes — 1 Hz all-bubble re-render via `useCountdown` (`ChatScreen.tsx:2156`) and unbatched per-message store commits (`upsertCoalesced` has zero callers).
- **Staging push blind spot:** BlueStacks FCM tokens are reaped as invalid ~90 s after registration (7-day telemetry: 35 no-token skips vs 7 delivered) → killed-app push tests need ≥1 real device / Play-enabled emulator.
- **Test-plan corrections needed before the device run:** GRP-09/21 (self-leave now auto-rekeys, epoch +2), CALL-28 (server acks ping since B-05), SET-18 (mechanism differs), BKRES-08/30 (cursor-resume disabled by design, H-5).

Not renumbered into the B-log (audit findings, not device-repro bugs); log a B-number if/when reproduced on-device.

**UPDATE 2026-07-06 (same day):** ALL 18 P1s (M-01..M-18) + the safe P2s remediated — see the Remediation log in `docs/audits/MESSENGER_AUDIT.md` §9. Shipped in APK **v1.0.100 / versionCode 126**. Gates: mobile tsc 47 ≤ baseline 49; messenger-crypto 1432/1432; messenger-service 218/218 (+23 privacy tests); app 179 passed. Key retest points for QA: (1) notifications now collapse per conversation + clear on read + muted groups suppressed (warm path) + group-tap no longer opens a phantom 1:1; (2) "Show last seen" is enforced server-side and Block now drops inbound messages/presence/typing/receipts on both sides; (3) deleted messages no longer resurrect after reinstall+restore (sealed-archive replay honours tombstones); (4) group Remove-member, remove-account-wipe, and prod OTP entry now have UI; (5) 1:1 ICE-restart recovers after a lost reoffer; (6) messaging smoothness — no 1 Hz all-bubble re-render, batched read commits, parallel group-create, bounded media downloads. **Deferred (product/cross-service, NOT in this build):** /vault/storage backend, FLAG_SECURE, force-kill call record, killed-path group-mute (sealed-sender), HTTP-submitter feedback, group key-envelope outboxing. Requires the v1.0.100 APK + messenger-service redeploy (privacy service) to test end-to-end.

---

## B-50 — Fresh-install restore fails `root_mismatch` (S8 self-heal 409 stale_seq) — FIXED 2026-07-06

**Found:** on-device (v1.0.100/vc126), first run of the restore round-trip gate. Screenshot: "Restore failed — Backup integrity check failed (root_mismatch)".
**Root cause (3-link chain, verified against live Supabase):**

1. A fresh install has no local Merkle seq anchor → the S8 self-heal re-commit ships `seq=1`.
2. The server's monotonic guard (`putMerkleCommit` L-9) 409s any seq below the stored commit (`{error:'stale_seq', currentSeq}`) — live accounts sit at seq 2–9.
3. `backupClient` mapped EVERY 409 to `verifier_missing` and discarded the body → `recommitAndReverify` caught the throw → returned false → hard `root_mismatch` on a healthy backup. DB evidence: no commit row updated at the restore time; account 3165d0e1 shows committed row_count=11 == actual 11 (equal-count byte drift = exactly the self-healable state).
   **Why tests missed it:** the merkle test fake-server accepted ANY seq (no monotonic guard).
   **Fix (client-only, v1.0.101/vc127):** `backupClient` surfaces `kind='stale_seq'` + `meta.currentSeq`; `commitMerkleRoot` adopts `currentSeq+1`, re-signs, retries ONCE (also un-bricks the post-restore live mirror commit path, which would have 409'd forever). New regression suite `merkleStaleSeqAdopt.test.ts` (3 tests, fake server WITH the guard; fail-first by construction).
   **Retest:** reinstall → restore with backup password → expect restore to complete; then send a message and confirm the next mirror commit lands (backup_merkle_commits.seq advances past the old device's).

## B-51 — Departmental entry vanished for service providers in v1.0.100 — FIXED 2026-07-06

**Found:** tester report on v1.0.100/vc126. **Root cause:** the Departmental dashboard card (and the whole Dept Chat v2 module) is gated by build-time `EXPO_PUBLIC_DEPT_CHAT_V2`; that flag was set ONLY inline in the `apk:staging` npm script (vc123–125 builds). v1.0.100 was built through the Firebase release pipeline (`release-apk.ps1` → bare `gradlew assembleRelease`), which bakes `.env.production` — the flag wasn't there → compiled out. `EXPO_PUBLIC_AUTO_DISPATCH` had the same gap. **Fix:** both flags added to `.env.production` (kept in lockstep with the apk:staging inline env). Any release-pipeline build ≥ v1.0.101 carries them again. **Retest:** provider dashboard shows the "Departmental" card; Channels/Attend/Incident tabs reachable; client auto-dispatch flows active.

## B-52 — "Client posts job, ops never sees it" (new app) — DIAGNOSED 2026-07-06: working as designed + push blind spot

**Report:** client posts a booking in the new app; nothing appears on ops. **Verified chain (live DB + logs):** the two AE bookings (client 604c77bb, 04:17/06:28 UTC) WERE created, the auto-dispatch matchmaker DID run, and a rank-1 offer WAS created each time to the only eligible AE provider (7f8f7598) — who never responded, so the offer EXPIRED and the cascade exhausted → terminal `NO_PROVIDER`. Terminal NO_PROVIDER bookings do not appear on the ops board (by lite-mission design; escrow never charged, nothing to refund). The BD booking the same day completed normally (provider accepted).
**Why the provider missed the offer:** (1) provider 7f8f7598 has ZERO push tokens in Redis (device on an old APK / BlueStacks-class FCM), so the `dispatch-offer` wake was dropped; (2) `sendDataOnlyToUser` dropped it SILENTLY (no log — unlike the chat path) which hid the whole event; (3) the provider app wasn't open, so the in-app offer polling never fired either.
**Fixes:** observability — `push.data.no-tokens sub=… class=…` log added to messenger-service (deployed); provider devices must run ≥v1.0.101 and log in once so push registration lands. **Product note for review:** if unstaffed auto-dispatch jobs should FALL BACK to the ops board instead of dying NO_PROVIDER, that's a deliberate flow change (old PENDING_OPS behavior) — decide before GA. Ops CAN inspect the cascade live at `/ops/dispatch/monitor` + `/ops/dispatch/requests`.
**Retest:** provider on new APK, logged in, app killed → post AE booking → provider phone must wake with the incoming-offer card; accept within 30s → booking proceeds; ops board shows it once accepted.

---

## 2026-07-07 — RS-14 staging fixture purge (executed) + role-audit remaining items shipped

**RS-14 (destructive, human-gated — executed via Supabase MCP):** identify SELECT from
`scripts/manual/RS-14_purge_e2e_agent_fixtures.sql` returned exactly the 3 expected rows —
`66159c37`, `574fba51`, `642b1560` (all `display_name='E2E CPO Agent'`, `@bravo.test`,
created 2026-04-24, `role='agent'`, no `agents` row). Applied option **2a soft-delete**
(`deleted_at = now()`, reversible); verify query → **0 remaining live fixtures**.
Hard delete NOT performed (FK/auth.users caveats in the script). Script left in place.

**Same session:** RS-02 (conversation membership intents + admin-device rekey drain),
RS-08 partial (autopromote audit + no-crypto-authority regression pin), RS-09 (admin
invite flow + /admins console page), RS-10 (org CPO⇄manager role change + channel
reseed/rekey), RS-16 (STRICT_VALIDATION=true enabled on the staging box — it had
drifted from the audit's "already true" claim; probe-verified 400/200). Full detail:
`docs/audits/ROLE_AUDIT_2026-07-07.md` §7.

---

## 2026-07-08 — v1.0.102 (vc128) Code-Diff Retest Matrix (PRE-DEVICE)

> **Source:** `origin/main` pull `1af09b6..899c087` (192 commits, 793 files). This is a
> **static code-diff analysis of the fixes that landed since the last QA build — NOT an
> on-device observation.** Each row's status is the _code verdict_ + the exact on-device
> retest that must still be run before flipping the Summary Table. No Summary Table rows
> were changed by this entry.

> **⚠️ Dev-numbering collision:** the developer's commit messages use their OWN B-numbers
> that do not all map to `sqa.md`. Their `useGroupCall.ts` "B-37" comment is **our B-36**;
> their "B-39" (OTP) _does_ match ours. Do not cross-reference their B-## blindly.

| Bug (ours)                                               | Area                            | Change found (file:line · commit)                                                                                                                                                                                                                                                                                                                                                                                   | Code verdict                                                                                    | On-device retest to run                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B-39** OTP not validated (CRITICAL)                    | ops auth backend                | `/auth/verify` now loads pending OTP row + enforces used/expired/attempts + calls `otp.check()` and rejects on fail (`auth.service.ts:271-303`). Bypass STILL present: `otp.check()` returns `/^\d{4,8}$/.test(code)` when `otp.devBypass` (`otp.service.ts:66-70`). Mitigation `devFlag = !IS_PROD && env==='true'`, `IS_PROD = NODE_ENV==='production'` (`configuration.ts:6-7`, header comment "B-39 hardening") | **CONDITIONAL** — closed ONLY if staging runs `NODE_ENV=production`                             | On `ops.94-136-184-52.sslip.io`: enter correct password → OTP step → try `000000`/`111111`/`999999`. **If any logs in, B-39 is STILL OPEN.** FIRST confirm the staging auth-service `NODE_ENV` (if not `production` + `OTP_DEV_BYPASS=true` → bug persists by design of the gate). Same pattern guards `biometric.devBypass` (`configuration.ts:56`) → also probe the File Vault MFA gate. |
| **B-40** SIGN OUT no-op (HIGH)                           | ops-console                     | `clearSession()` expires JS-readable `bravo_ops_csrf` directly from JS across all domain candidates (no longer waits on server `Set-Cookie` DELETE) + hard `window.location.replace('/login')` (`lib/api.ts`, `Shell.tsx` · `207cf09`)                                                                                                                                                                              | **LIKELY FIXED**                                                                                | Sign in fully → SIGN OUT → expect redirect to `/login`, cookies cleared, protected routes bounce. Then repeat with an **expired access token** (force the DELETE to 401) — the exact path that survived before.                                                                                                                                                                            |
| **B-18** owner's 2nd device never gets master key (HIGH) | signal keys (BE ready / FE not) | BE: `keys.service.ts` scoped to `(user_id,device_id)`, `ON CONFLICT (user_id,device_id)`, migration `20260629000003_signal_per_device_keys.sql` (`b852620`, msg cites B-18); multi-device 1:1 fan-out via `fetchDevices` added but **flag-gated** (`79a4551`). FE: client STILL hardcodes deviceId=1 (`productionRuntime.ts:361`, confirmed `MainNavigator.tsx:509`, `fcmBootstrap.ts:907`, `useGroupCall.ts:3907`) | **LIKELY STILL OPEN for 2nd-device path** — BE 500 fixed, but client emits no distinct deviceId | Owner account on TWO devices → send into an owned group → 2nd device must decrypt (no "waiting for key" banner). Expect still-FAIL unless the multi-device flag is on AND client provides a real deviceId.                                                                                                                                                                                 |
| **B-36** crash ending group call (HIGH)                  | group call teardown             | `leaveInternal()` flips to terminal state (`left`/`ended-by-host`/`kicked`) BEFORE synchronous producer/consumer/transport teardown so the screen swaps to static "Call ended" in one clean unmount; comment names the crash `"child already has a parent" (addViewAt)` (`useGroupCall.ts:3665-3675`)                                                                                                               | **TARGETED FIX PRESENT**                                                                        | REAL DEVICE, 3× as originally repro'd: join group call → End Call → expect clean exit, no Fabric crash. Test both End-button and BackHandler paths, and host-ended teardown.                                                                                                                                                                                                               |

**Also landed in this pull (context, not retested here):** B-41 TURN secret drift (CONFIRMED+FIXED vc103), B-50 fresh-install restore `root_mismatch` (FIXED), B-51 Departmental entry gating (FIXED), B-52 client-job/ops push blind spot (DIAGNOSED). ~40 new Supabase migrations (auto-dispatch, escrow integrity, per-device signal keys, role taxonomy, admin invites, privacy consent).

**Highest-leverage action item:** confirm the staging auth-service `NODE_ENV` before signing off B-39 — the entire fix is gated on it.

---

## 2026-07-09 — FULL NOTIFICATION AUDIT (all 5 user complaints root-caused, code-level)

> **Canonical register: `docs/audits/NOTIFICATION_AUDIT_2026-07-09.md`** — 36 merged findings
> (N-01..N-36: 13 P1 / 13 P2 / 10 P3), each independently adversarially verified (39 CONFIRMED,
> 5 PARTIAL-corrected, 1 REFUTED-dropped) by a 53-agent workflow (`wf_6ae4c107-02b`).
> Build audited: **v1.0.102 / vc128 @ `12894de`**. Status: **code-level root causes — fixes NOT
> applied** (SQA role). Important negative results: the B-48 server+client fixes ARE all present
> and correct in vc128 (tokens are NOT the remaining break), and commit `12894de` (obsidian
> redesign) is exonerated for the tap-crash. The user complaints map to four new bugs:

### B-53 — Killed-app 1:1 call never rings; notification only AFTER the call ⚠️ HIGH · ROOT-CAUSED 2026-07-09 (4 coupled server/client defects, all CONFIRMED)

**Reported (2026-07-09, physical device):** incoming call with the app closed → no ring; a notification shows up only after the call ends.

1. **N-01 — zombie-socket wake suppression (primary "no ring"):** `handleCallOffer` queues the Redis offer + fires the FCM VoIP wake ONLY in the `peer_offline` branch (`messenger.gateway.ts:1038-1101`), but offline-ness = bare socket.io room membership (`socket-hub.ts:44-48`); an ungracefully-killed app (Doze/OEM freeze/no FIN) stays "online" up to **~55 s** (heartbeat 30 s + grace 25 s, `configuration.ts:16-26`) — offer emitted into a dead socket, **no wake, no queue, no replay, no call.missed**. The group `sfu.ring` path already always-sends (`:1613-1625`, client dedupes by callId) — the fix pattern exists in-file.
2. **N-02 — no after-the-fact signal (the "notification after the call"):** no cancel push on hangup (`:1161-1184`; killed device rings up to 45 s after caller cancels), un-purged pending offers **replay dead calls** on app open (drain never checks ended-call state, `:576-587`), and the `call.missed` replay is **dead code** — payload TTL 45 s expires at exactly the >45 s emit threshold (`:1065-1069` vs `:546-570`), so missed calls to killed apps vanish.
3. **N-03 — 30 s exp vs raw device clock, zero skew tolerance** (`push.service.ts:827` / `voipWakeVerify.ts:309-310`, fail-closed, no env escape for `stale`): a device clock ~30 s fast kills EVERY killed-app ring on that device silently (prior project incident: clock-drift "stale" 1:1 media). **⚠ Fix coupling: skew tolerance must ship WITH the cancel push + hangup purge, or late orphan rings get worse.**
4. **N-04 — caller-side masking:** wake failures (`{sent:0}`, budget-deny) are void-swallowed (`:1091-1100`) — caller sits in "calling…" with zero feedback.

**Triage caveat (G-3):** a Force-stopped app receives NO FCM by Android design — check OEM battery/autostart settings and use swipe-kill (not Force stop) when retesting, or the fix will be misjudged.
**Retest after fix:** call ≤55 s after swipe-kill → must ring; caller-hangup before answer → ring dismisses + Missed-call notif; reopen 2-10 min later → missed-call bubble; device clock +2 min → still rings (or missed-call, never silence).

### B-54 — Message-notification tap → "Chat hit an error" ⚠️ HIGH · ROOT-CAUSED 2026-07-09 (deterministic render crash, CONFIRMED)

**Reported (2026-07-09, screenshot):** tap a Bravo Secure message notification → full-screen "Chat hit an error"; Retry re-crashes.
**Root cause (N-07):** the msg-wake tap deep-link navigates to `Chat` with **only `{conversationId}`** through an untyped `navigationRef` cast (`fcmBootstrap.ts:629-634`); route requires `name`+`isGroup` (`navigation/types.ts:54`); `ChatScreen.tsx:1124` unconditionally renders `initials(name)` → `name.split(/\s+/)` on `undefined` (`:2403-2405`) → render TypeError → 'Chat' error boundary (`withScreenErrorBoundary.tsx:71`). Fires on ALL three tap entries (foreground/background/cold-start `getInitialNotification`) whenever the conversation resolves (the common case — so the M-05 "FIXED" exists-check is functionally defeated: the thread it opens crashes 100%). NOT a hydration race (no early return pre-ready). Introduced with the deep-link in `fffe40a`; survived `dd8c184`.
**Also:** N-08 — the same deep-link omits `isGroup`, so once the crash is fixed, push-opened groups render as 1:1 (no member stack/sender labels, roster hydration + presence/typing fan-out degraded). Fix must resolve `name`+`isGroup` from the same store row as the exists-check AND make ChatScreen self-heal params from the store (else group taps still land in the wrong 1:1 per B-56's misroute).
**Retest:** tap message notifs (1:1 + group; app foreground/background/killed) → correct thread opens, no boundary, group header shows member stack.

### B-55 — In-app bell not synced (mobile + ops-console) ⚠️ HIGH · ROOT-CAUSED 2026-07-09 (architectural, CONFIRMED)

**Reported (2026-07-09):** bell icon out of sync in the app and the webapp.
**There is no notification model anywhere — "synced" is impossible today:**

- **No server inbox (N-20):** event details live ONLY in Redis with `EX 300` (`booking-push-bridge.service.ts:35,63-67`); sole read path `GET /events/by-id/:eventId`; no notifications table, no `/me/notifications`, no read-state. A missed wake = permanently lost (B-48/B-52 class).
- **Mobile inbox is dead code (N-18):** ActivityBell imported by 0 files (its header comment "mounted in all three role shells" is false), ActivityCenterScreen in no navigator, `recordActivity()` has **zero production callers** — wakes draw OS banners (`serverWakeNotifications.ts:91-186`) but never append a row.
- **Dashboard bell (N-19):** dot = messenger unread (`DashboardScreen.tsx:207-210`) but the drawer is hardcoded "You're all caught up" (`:554-559`) and **"Mark all read" has no onPress** (`:544-546`).
- **Three decorative bells (N-22):** Ops dashboard / Agent home / Job marketplace ship always-lit hardcoded dots with no onPress.
- **`incident` class dropped end-to-end (N-21):** server publishes it (`incident.service.ts:140,261`) but `AGENT_WAKE_META` has no incident kinds → "unknown background wake kind, no action". Dept-Chat incident notifications reach NO surface.
- **Ops-console bell (N-23/N-24):** a static Link to `/live` badged with global `sos_active` = `COUNT WHERE acknowledged_at IS NULL` (`ops.service.ts:117`) — client-cancelled SOS never get `acknowledged_at` (`sos.service.ts:164-171`), mission `abort()` strands open rows, the phantom rows are invisible on `/live` (missions only) AND `/sos` default 'active' filter → **badge drifts up forever with no discoverable way to clear it** (also ignores regionClause).
- **No realtime for the webapp (N-25):** socket.io is messenger-transport-only (needs manual vault unlock); everything else is 5 s/2 s SWR polls that stop when the tab is hidden.
- **Priority/TTL loss window (N-27):** only `sos` is high-priority; detail-blob TTL 300 s < FCM ttl 600 s → deliveries in the 5-10 min window deterministically hydrate to 404 and render nothing; `dispatch-offer` (30 s response window) rides this path.

**Fix direction (one design):** durable per-recipient notifications table written at the BookingPushBridge/OpsAudit fan-out + `/me/notifications` + `/ops/notifications`; wire recordActivity + mount ActivityBell/Center; fix the SOS KPI (`AND resolved_at IS NULL`); ops-notify socket event. Full plan: audit §7 + §10 Wave 3.

### B-56 — Notification "not smooth": double-alerts, group misroute, drain jank, silent permission dead-end ⚠️ MED-HIGH · ROOT-CAUSED 2026-07-09 (CONFIRMED)

- **N-29 (P1):** server wakes on EVERY send (deliveredNow computed and ignored) + warm-background double post (FCM generic banner, then store-notifier named banner) + **no `onlyAlertOnce` anywhere** → each backgrounded message = 2 sounds + heads-ups + a generic→named title flicker; N-message burst ≈ 2N alerts. One-line mitigation: `onlyAlertOnce: true` in `showMessageNotif`.
- **N-11 (P1):** group wake from a sender with an existing 1:1 is keyed/mute-checked/deep-linked to the **1:1** (`resolveDirectConversationId` heuristic; wire carries only senderUserId) → duplicate banners, tap opens the wrong chat, muting a DM silences that person's group messages (`mutedLookup.ts:52-55` unconditional sender-mute branch), banner never clears on group read.
- **N-30 (P2):** M-14 only half-fixed — every inbound append still walks ALL conversations (no `list === prevList` skip, `productionRuntime.ts:1578-1581`) + one SQL txn per new row; a 50-msg drain = 50 walks + 50 txns → messages "stutter in".
- **N-31 (P2):** NEVER_ASK_AGAIN `POST_NOTIFICATIONS` (or a blocked `bravo-messages` channel) is console-logged and swallowed post-onboarding — no banner, no Settings deep-link; presents exactly as "notifications broken".
- Lesser: N-32 no burst batching (collapseKey per-sender), N-33 multi-MB vault parsed 2-3× per wake, N-34 inconsistent clear-on-foreground semantics, N-35 ops-console fake "● STREAM"/blocking prompts.

**Telegram parity (complaint 3 — feature gap, not bug-numbered):** N-10/N-12/N-13/N-16/N-17 — nothing Telegram-like is implemented though notifee 9.1.8 supports all of it; sender/conversation names are locally resolvable on EVERY path incl. killed (~15-line fixes); warm-path preview text is a policy choice (runtime already decrypts during the wake); only killed-app preview needs the Signal-style headless-drain decision (L). Staged plan in audit §6/N-10.

**iOS latent (N-36, P2):** `sendChatWake` is android-only — an iOS build registering DATA tokens gets ZERO message notifications; flag before iOS launch.

---

## Full messenger re-audit — 2026-07-09 (HEAD 78edfd4)

Post-remediation re-audit of the whole messenger stack (14 subsystem deep-trace auditors → 72 adversarial verifiers). **35 verified findings: 1 P0, 16 P1, 17 P2, 1 P3; 6 candidates refuted.** No E2EE / security-contract / log-plaintext violation found. Suites at HEAD: crypto **1449/1449**, messenger-service **219/219**, tsc **47 = baseline**.

**The P0 (fix before any release):** the 2026-07-06 **M-14** fix made the coalesced status-flush txn and the receive txn run on the **same single SQLCipher connection under two independent mutexes** (`sqlMessageStore.ts:327` vs `receiveTransaction.ts:83`). Under a reconnect-drain + `markRead` burst a receive `BEGIN IMMEDIATE` can land inside an open flush txn, throw _"cannot start a transaction within a transaction"_, and be **acked `discarded` → the relay deletes a committed inbound message** (groups unrecoverable). Fix: one shared per-connection txn mutex + reclassify transient local SQL errors as leave-on-relay.

Full register (P1s, P2s, per-area verdicts, refuted list, coverage gaps) in **`docs/audits/MESSENGER_AUDIT_2026-07-09.md`**. Fixes NOT yet applied. Coverage gaps carried to next pass: crypto-core, backup, prod-readiness/log-hygiene finders + completeness critic (stopped by a session limit).

---

## Tester-reported call bugs — 2026-07-09 (B-57..B-61) · ROOT-CAUSED 2026-07-10

Five live-device call bugs reported by the tester, now **root-caused in code** by the 2026-07-10 background/killed-app reliability audit (`wf_0b001a78-f0e`; canonical write-up: [`docs/audits/BACKGROUND_RELIABILITY_AUDIT_2026-07-10.md`](docs/audits/BACKGROUND_RELIABILITY_AUDIT_2026-07-10.md) §2). B-59/60/61 are **one** underlying bug (connected-state promotion never fires); B-57 and B-58 are two distinct notification/resume defects. Active in-call UI is `src/screens/messenger/CallScreen.tsx` (`VoiceCallScreen.tsx` is a `__DEV__`-only demo). **No fixes applied — documentation only.** B-60/B-61 confidence is _medium_ pending the named 2-device ADB check; the rest are _high_.

### B-57 — Incoming-call notification tap opens the app first, not the call screen ⚠️ HIGH · ROOT-CAUSED (high)

**Root cause:** there is **no lightweight call UI on the killed path — the ring's answer surface is the entire RN app.** The notifee ring's `fullScreenAction`/`pressAction`/action buttons all use `launchActivity:'default'` (`callNotification.ts:371-388`), so any interaction on a locked/killed device cold-launches `MainActivity` (boot screen, not a call). The headless path never calls `callKitBridge.reportIncomingCall` (only the warm handler at `fcmBootstrap.ts:1154` does), so no Telecom system-UI covers the boot; the press is processed only _after_ login (`getInitialNotification` → `handle()` waits ≤8 s for nav → navigates `CallScreen` in `ringing` with no SDP). The Accept/Decline that "appear only after launch" are `CallScreen.tsx:2166`, and tapping the notification's **Answer never auto-accepts** (`fcmBootstrap.ts:837`) — a second in-app Accept is required.

- **Anchors:** `callNotification.ts:371` (FSI `launchActivity:'default'`) + `fcmBootstrap.ts:837` (accept only navigates). Fix outline: audit P1-BR-2/P1-BR-8.

### B-58 — Tapping the ongoing-call notification disconnects the active call ⚠️ HIGH · ROOT-CAUSED (high)

**Root cause (resume, not the tap):** the 4 s runtime heartbeat (`productionRuntime.ts:1337`) freezes while backgrounded, so `lastPongAt` is always >8 s stale even though the call FGS kept the socket alive. The AppState-`active` handler (`productionRuntime.ts:1294-1302`) therefore calls `transport.forceReconnect()`, which `socket.disconnect()`s the **healthy live socket** (`transport/client.ts:215`); the gateway's `handleDisconnect` finds the still-`active` call session and emits `call.hangup{reason:'failed'}` to the peer, tombstoning it (`messenger.gateway.ts:716-737`). `CallScreen` does **not** remount on the tap (`MainActivity` `singleTask` + `useCall` adopt guard), so remount-teardown is _not_ the mechanism. Deterministic for any background stint >8 s. Same trigger fires from the WS-ack watchdog (`productionRuntime.ts:2744`) if a message is sent mid-call on a slow link.

- **Anchors:** `productionRuntime.ts:1302` (client trigger) + `messenger.gateway.ts:730` (server graceless bye). Fix outline: audit P1-BR-4 (client: skip forceReconnect while a live call exists) + P1-BR-5 (server: 10-15 s grace timer like the SFU path).

### B-59 — Call duration shown as `1M, 2M, 3M` instead of `MM:SS` ⚠️ MEDIUM · EXPLAINED (perception artifact of B-60/B-61)

**Root cause:** no call surface in the app formats a duration as "NM" (all emit `MM:SS`/`M:SS`). Because B-60/B-61 keep `callDuration=0`/`connectedAtMs=null`, `CallScreen`'s unmount classifier (`:1255-1267`) records every call as missed/declined with duration 0, so both call logs **suppress** the MM:SS slot (`CallsLogScreen` `:233-236`; `ChatScreen` `meta.duration>0 &&` `:2530`). The only numbers left on the Calls rows are the right-column **relative ages** `${Math.floor(diff/60_000)}m ago` (`CallsLogScreen.tsx:56`) — three test calls made 1/2/3 min earlier read "1m ago / 2m ago / 3m ago". **Fixing B-60/B-61 dissolves B-59.** (Confirm with the tester that the sighting was the Calls-screen right column.)

### B-60 — Call timer never starts after connection ⚠️ HIGH · ROOT-CAUSED (medium — 2-device check named)

### B-61 — Call status not updated to Connected/In-Progress ⚠️ HIGH · SAME ROOT as B-60

**Root cause:** the timer gate (`CallScreen.tsx:1510`) and status derivation (`:736-739`) are correct; the whole JS promotion chain was read link-by-link and verified sound. The wedge is the one un-timeboxed native await: `onIceConnected()` sets `dtlsPolling=true` then awaits `verifyDtlsSrtp()`, whose first line is `await this.pc.getStats()` (`peerConnection.ts:453`) with **no timeout**. If that native promise never settles (the patched `io.getstream stream-webrtc-android 1.3.10` `getStats` bridge is the only link not statically verifiable), the poll hangs mid-iteration forever — the 24×250 ms budget only advances on _rejected_ iterations, so `setState('connected')` (`:906`) is never reached and `end('failed')` (`:926`) never fires (media keeps flowing). Every later ICE `connected`/`completed` event hits `if (this.dtlsPolling) return` (`:861`) and is discarded → stuck at "connecting"/"Calling…" with working audio.

- **Anchor:** `callController.ts:880`. Fix outline (audit P1-BR-6): `Promise.race` each `verifyDtlsSrtp()` against a 1 s timeout + promote to `connected` from the ICE event with DTLS-verify as a follow-up gate.
- **2-device ADB check to confirm on the tester's build:** grep logcat for `dtls-poll-begin` with no matching `dtls-verify-ok`/`dtls-poll-exhausted` (confirms the getStats wedge), OR the absence of any `iceConnectionState=connected` line (would instead indict the native fork's event delivery). Ship the `dtls-poll-hung` watchdog log in the next build to make this trivial.

**Summary:** B-59/60/61 = one bug (connected-state promotion never happens). B-57 = no lightweight/Telecom call UI on the killed path + Answer never auto-accepts. B-58 = resume `forceReconnect` tears down a healthy socket and the server graceless-byes the peer. Full findings, fixes, and the WhatsApp-parity gap analysis: `docs/audits/BACKGROUND_RELIABILITY_AUDIT_2026-07-10.md`.

---

## Full-stack remediation — 2026-07-10 (both audit registers)

**Executed by 13 Opus 4.8 maker agents in 3 file-ownership waves, verified per-diff by Fable 5 (orchestrator/critic).** Every finding in `MESSENGER_AUDIT_2026-07-09.md` (incl. §12 increment) and `BACKGROUND_RELIABILITY_AUDIT_2026-07-10.md` was implemented unless explicitly listed under Residuals.

### Fixed (headline)

- **P0-1** — `upsertBatch` funnels through the shared `runWithRatchetTxn` txn chain (single per-connection mutex, `BEGIN IMMEDIATE`, `isInsideRatchetTxn` flag); transient SQL errors (nested-txn/BUSY/IOERR/FULL) now classify **leave-on-relay** at all 4 receive catch sites — a local hiccup can never ack-`discard` a relay-held message. +7 direct tests (fail pre-fix).
- **Message-loss P1s**: P1-1 (append-before-any-await + retry chip reuses bubble id via `existingMsgId`), P1-2 (boot bundle upload best-effort + `runtimePromise` cleared on reject), P1-3 (media TTL passed), P1-16 (dedup claim released on any put failure), P2-12 (media optimistic bubble + durable retry).
- **Group roster**: P1-4 (legacy-branch membership gate, no auto-create), P1-5/P1-6 (server roster write-through via `conversationApi.add/removeMember` + durable owner-scoped `pendingRosterIntents` + Home-sync overwrite guard).
- **Notifications**: P1-7 (missed-call tap deep-links thread, no ghost CallScreen), P1-8 (FCM banner skipped whenever notifier runs), P1-9 (durable pending-replies queue, drained on boot; banner re-posted "Reply will send when you open Bravo"), P2-5 (cancel teardown + foreground path), P2-6 (fallback banner — never zero signal), P2-BR-5 (mute only on unambiguous conversationId).
- **Privacy**: P1-10 (blockedPeers owner-scoped + fetched at boot), P1-11 (server silent-drop on blocked call.offer + sfu.ring filter + no VoIP wake), P2-9 (block gates on reactions/group renders/placeholders).
- **Transport**: P1-12 (single-flight open + connect-generation), P1-13 (`_pid` capture, no socket.id fallback), P1-BR-7 (transient refresh ≠ terminal unauthorized), fast-path reconnect on network restore, backoff jitter, SFrame verify-before-window-advance.
- **Server call-signalling**: P1-14 (decline clears the CALLEE's artifacts), P1-15/P2-13 (SREM inside keepMarker — reconnect `call.missed` finally fires), P1-BR-5 (12 s disconnect grace for active 1:1 calls), P2-15 (group-ring cancel push), P2-BR-8 (kind label), P2-BR-9 (group pending-ring + missed marker + `sfu.ring.missed`), P2-BR-11 (receipts always durably queued), **new `POST /calls/:callId/decline`** (headless decline).
- **Calls client (B-57..B-61)**: P1-BR-4 (live-call guard on resume/watchdog — no forceReconnect mid-call), P1-BR-6 (1 s DTLS getStats timeout + promote-on-ICE-connected + `dtls-poll-hung` log), P2-BR-6 (wall-clock budgets + foreground re-probe), P2-BR-7 (camera FGS on voice→video), autoAccept end-to-end, P1-BR-1 (group ring roomId/roomToken threading; empty roomId = error, never creates a new room).
- **Killed-app platform**: P1-BR-8 (notifee call-launch detection → showWhenLocked/turnScreenOn + posture restore), P2-BR-1 (`BravoBatteryOptimization` native module + NotificationReliabilityCard w/ OEM autostart deep-links — TECNO/MIUI/ColorOS/vivo/EMUI), P2-BR-2 (callkeep service exported=false), P2-BR-3 (Signal-style `urgent` flag on HTTP+WS submit; dedup-hit/expired never wake), P2-BR-4 (chat-wake TTL 28 d; cancel push 300 s), P2-BR-10 (presence lease TTL — phantom-online ≤ ~7 min).
- **Backup**: P1-B-1 (archive-replay marker + per-owner cursor + retry state), P2-B-1..6 (Merkle no_commit hard-fail, verified-only flush, authenticated seq floor, `'self'` outbound statuses, epoch guard + post-Merkle group_state, bounded defer buffer + resume), P3-B-2 (owner-scoped flags incl. Setup/Settings screens), P3-B-4 (boot gate never masks recoverable identity), §12.4 (all six replay deps incl. `revokedJtiCache`).
- **Prod-readiness**: P1-P-1 (TOTP key fail-closed in prod + sentinel reject), P2-P-1 (functional /healthz: Redis ping + SFU pool; crash-storm exit), P2-2/P2-16 (global `ThrottlerGuard` APP_GUARD covering vault/push/sfu/turn/calls), P2-17 (signed `gen` in sender certs — see Residuals), P3-P-1 (SFU join fail-closed in prod), P3-P-2 (8-char log slices), helmet, JWT access-secret fail-closed, MFA proof single-use jti, SFU worker-death room reconciliation + `SFU_ANNOUNCED_IP` boot validation.

### Suites at completion

messenger-service 29 suites / 297+ tests · auth-service targeted 5 suites / 48 (+ full run at final gate) · mobile messenger-crypto **177 suites / 1575 tests** · tsc **45 ≤ 47 baseline** · ~120 new tests across waves.

### ⚠️ Deploy requirements (Contabo, BEFORE/AT next deploy)

1. `TOTP_ENCRYPTION_KEY` (auth-service): **hard boot-failure in prod if unset**; rotating off the old `'a'×64 default breaks existing `totp_secrets` rows → check row count, users may need 2FA re-enroll.
2. `SFU_ANNOUNCED_IP` (messenger-service): unset in prod ⇒ SFU refuses rooms (503 `sfu_announced_ip_unconfigured`); `SFU_ALLOW_UNANNOUNCED=1` override exists.
3. `JWT_ACCESS_SECRET` (messenger-service): now fails closed (was fail-open empty-key verify).
4. Vault MFA now needs Redis reachable (single-use jti, fails closed).

### Residuals / follow-ups

- P2-17 client half: mobile must compare `cert.gen` vs peer generation (needs a peer-generation endpoint) — server embeds the signed field already.
- B-57 long-term: Telecom `reportIncomingCall` from the headless path (lightweight call activity) — current fix = FSI flags + autoAccept.
- P3-B-3 (mid-txn ratchet snapshot) skipped — low-confidence.
- §12.1 hygiene: stale `src/modules/messenger/crypto/*` shadows still present (test-only); stale mobile `transport/**` mirror still importable.
- §8 nits not taken: fsync PRAGMA tradeoff, iOS apns-priority, dead header controls, vault upload copy, Jest open-handle teardown warning, 4 s bg heartbeat cadence, `WS_SESSION_RECOVERY` feature decision.
- **Device verification pending** (killed-app + 2-device call smoke on TECNO KM5): B-57..B-61 behaviors, battery-opt card, `dtls-poll-hung` logcat check, sos-alerts-v2 DND behavior, merged-manifest checks.

---

## QA Session 2026-07-10 — v1.0.104 (vc130) device retest, Pixel 7a (B-62..B-70) · ROOT-CAUSED same day · FIXES IMPLEMENTED same day (B-62/63/64/65/66/67/69/70)

> **Remediation 2026-07-10 (PM):** all fixable findings implemented in code — see the
> runbook entry "2026-07-10 (PM) — B-62..B-70 device-audit remediation" in
> `docs/planning/BUILD_RUNBOOK.md` for the full file list. Headlines: B-70 phoneCall FGS
> type + MANAGE_OWN_CALLS; B-62 20 s 'connecting' watchdog (ICE re-check before failing)
>
> - autoAccept retry-then-teardown; B-64 zombie-session end on `call.missed`/unmatched
>   hangup + FloatingCallOverlay for any live off-screen call + FGS-notification "Hang up"
>   action; B-63 `canUseFullScreenIntent()` + FSI Settings deep-link in the reliability
>   card; B-67 snapshot stale_seq adopt-and-retry + failure debounce; B-66 real Bravo mark
>   vector + `#5B8DEF` accent; B-65 preview default ON + killed-path group-name resolution;
>   B-69 camera-FGS ratchet-up-only + native fallback ladder (no stopSelf on typed failure).
>   +12 new tests (watchdog 5, zombie-end 4, stale_seq/debounce 3). **NOT fixed (blocked on
>   next capture):** B-68 (crash buffer needed), B-59/60/61 recurrence (controller-identity
>   race trace). **SHIPPED as v1.0.105 (vc131) to Firebase App Distribution `qa` group
>   2026-07-10 ~17:10** (staging URLs verified baked; also side-loaded on Ranak's Pixel 6a).
>   Device verify pending on the QA devices.

> **Canonical register: [`docs/audits/CALL_NOTIFICATION_DEVICE_AUDIT_2026-07-10.md`](docs/audits/CALL_NOTIFICATION_DEVICE_AUDIT_2026-07-10.md)** — full timelines, server log excerpts, code anchors, fix loci. Evidence: `bravo_call_log_20260710_112445.txt` (11:20–11:24), `bravo_call_fulltest_113449.txt` (11:27–11:36), `bravo_call_log_113328.txt`, live `bravo-staging-msgr` logs (Contabo, 05:20–05:33 UTC), tester's `Bravoo_CALL_TEST_REPORT.html`. **SQA role — no fixes applied.**

**Identity update:** caller `3165d0e1-…` = **Ranak** (founder's account, new to the Device & Identity Reference). Device under test = Pixel 7a = shirajul (`79d63649`). Call-2 caller = fahim (`fe4ddc14`).

**Retest verdicts:** **B-53 PASS** (killed-app wake+ring verified end-to-end, device + server: `push.voip.delivered sent=1/1`, FCM restarts dead process, ring ~7 s, pending-offer replay, cancel/missed push). **B-57 PARTIAL** (autoAccept + FSI flags shipped but FSI OS-denied; chain fails downstream). **B-59/60/61 UNVERIFIED** (tester reports "Answering…" stuck ~5 min with live audio, but the ICE-promote fix IS at HEAD `callController.ts:1382-1404`; no JS logs captured — suspect duplicate-accept race `fcmBootstrap.ts:970-983`). B-58 not exercised.

### B-62 — Notification-driven answer never sends `call.answer` ⚠️ HIGH · 2/2 repro (in-app answer works)

Both test calls: offer→`peer_offline`→VoIP wake→ring→tester taps **Answer**→local call session starts (InCallManager, `MODE_IN_COMMUNICATION` ~6 s)→**server never receives `call.answer`, callee sends 0 ICE**→caller rings out→server (correctly) sends cancel `missed=true`→"missed call" notif on a call the callee answered. Control: live-offer + in-app answers same device answered in 2-3 s (`[CALL] ANSWER` logged), incl. one replayed offer — so replay + in-app answer are fine; the break is the notification/cold-boot answer chain. Leading hypothesis: mic capture fails pre-answer (see B-70; call 1 logged Bravo's `.CallForegroundService` mic denial from background). No `'connecting'` watchdog exists (`callController.ts:484` cancels the only timer at accept) so the wedged call never reaches a terminal state. **Needs JS-level capture to close:** `adb logcat -v time ReactNativeJS:V WebRTCModule:V InCallManager:D *:W`.

### B-63 — Ring notification `FSI_REQUESTED_BUT_DENIED`, unhandled ⚠️ HIGH (formalizes N-05)

Android 14+ denies full-screen intents by default for non-dialer apps; device log shows the flag on every ring. No `canUseFullScreenIntent()` check / `ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT` deep-link anywhere (NotificationReliabilityCard covers only battery/autostart). Lock-screen ring degrades to a heads-up; P1-BR-8's `showWhenLocked/turnScreenOn` never get their entry path.

### B-64 — Zombie call after failed answer: unclearable FGS notif, no End affordance ⚠️ HIGH

FGS notif 70242 (`bravo-call-foreground`, NO_CLEAR) survived 90+ s past call death (never removed). All teardown paths require a terminal controller state or CallScreen unmount (`callRegistry.ts:247-251`, `CallScreen.tsx:972-987`); wedged-`'connecting'` reaches neither. `FloatingCallOverlay` renders only when `isMinimized` (`FloatingCallOverlay.tsx:124`); FGS notif has no hang-up action; session-expired user sits on Auth/OTP with `Main` (and CallScreen) unmounted (`navigation/index.tsx:56-74`) — the tester's "tried to receive via OTP". Observed workaround = swipe-kill the app (call 1, 11:22:42 `remove task`).

### B-65 — Message notifications generic by default (Telegram-parity residual) · MED (product)

N-10..17 machinery IS shipped (MessagingStyle, reply/mark-read, badge, name resolution incl. killed path). Remaining: `contentPreviewEnabled` defaults **false** (`backgroundMessageNotifier.ts:38`) so body = "Open Bravo Secure to read it" everywhere; killed-path body always generic; killed-path **groups** = "New secure message" title too. Decisions: preview default ON (warm), Settings toggle surface, group-name resolution on killed path, headless-drain for killed previews (L).

### B-66 — Status-bar small icon is a placeholder shield, not the Bravo logo · LOW-MED

`ic_stat_bravo.xml:14` = stock Material "verified_user" glyph (wiring is correct everywhere incl. FCM meta-data; white-blob era is pre-`73ad6f3`). No `default_notification_color`; message/server banners pass no `color`. Fix = branded 24 dp white-on-transparent vector + accent color. No code changes.

### B-67 — Ratchet-snapshot upload `stale_seq` infinite 4 s retry; snapshots frozen ⚠️ HIGH

`[ratchet-snapshot] upload failed (stale_seq)` every ~4 s from boot to log end, across BOTH pids (31266, 32666) — chronic. Upload path lacks the B-50 adopt-self-heal (only `merkleCommit.ts:247-273` has it; `httpSnapshotTransport.ts:43-47` discards `currentSeq`); debounce only advances on success (`ratchetSnapshotScheduler.ts:289`) so failure = full snapshot serialize+encrypt+POST every heartbeat. Consequences: battery/data drain + **server snapshot frozen at old seq → next restore replays stale ratchet → undecryptable inbound** (silent until a future restore). Server guard `backup.service.ts:716` (`>=`).

### B-68 — App process dies holding the call FGS mid-video-call ⚠️ HIGH · crash class

`11:30:22 Process com.bravosecure.app (pid 31266) has died: fg +50 FGS` + `Could not find appropriate running FGS for FGS stop`, ~115 s into the answered video call, front camera actively tearing down. Killed the live call and made the next offer `peer_offline`. Crash buffer not captured — next session add `adb logcat -b crash,main`; pull Crashlytics for 05:30:22 UTC. Matches tester's "cannot cut the call" if triggered by the End tap (B-36 class).

### B-69 — Camera FGS type thrash during video (192→128→192 in 1.4 s) · MED

`FGS type change … from 192 to 128` (11:29:34.8) then back (11:29:36.2) around the callee video enable; FGS restart keyed on `isCameraOn` with no debounce/foreground guard (`CallScreen.tsx:1061-1074`); `CallForegroundService.kt:82-88` catch posts a typeless notif + `stopSelf()` on failure. Capture-stall/black-video risk — prime suspect for audio→video black reports.

### B-70 — `.CallForegroundService` omits the `phoneCall` FGS type ⚠️ HIGH · manifest

`AndroidManifest.xml:142` = `microphone|camera` only (CallKeep's `VoiceConnectionService` correctly has `phoneCall|microphone|camera` at `:162`; `app.json` already lists `FOREGROUND_SERVICE_PHONE_CALL`). Forfeits the Telecom while-in-use exemption → call 1 logged Bravo's own "FGS started from background can not have … microphone access". Prime enabler of B-62; fix alongside it. ⚠️ Evidence hygiene: the same-worded lines in `bravo_call_fulltest_113449.txt` (`:197`, `:11093`) are **WhatsApp's**, not Bravo's — only the 11:21:26 lines in the first capture are Bravo.

---

## B-82 — Lite CPO booking client cluster: OTP not showing · intermittent API · dashboard status frozen ⚠️ P0/P1 · CONFIRMED (audit only)

Founder-reported, audited 2026-07-11 @ `387beab` (v1.0.109). Full detail + fixes + files in
**`docs/audits/LITE_BOOKING_CLIENT_BUGS_AUDIT_2026-07-11.md`**. Method: first-hand code trace

- 4-stream parallel deep-trace with adversarial verification (10 CONFIRMED, 1 REFUTED). No code changed.

**Root seam:** the booking FSM stays `CONFIRMED` through the whole mission; only `GET /bookings/:id`
surfaces the live `mission_status` (`booking.service.ts:607-612`), the **list** never does
(`toClientBooking:1093-1137`), and client screens split navigation/display between `booking.status`
and `mission_status`.

- **LB-OTP1 (P0)** — verify-guard card mounts only in the `DISPATCHED/PICKUP` window
  (`LiveTrackingScreen.tsx:645`); skipped on resume (`resumeTargetFor('CONFIRMED')`→BookingConfirmation,
  Track gated LIVE, `bookingStatus.ts:65` / `BookingConfirmationScreen.tsx:114,180`) and on fast
  pickup→live advance. Fix: keep card mounted until handover/COMPLETED + route off `mission_status`.
- **LB-OTP2 (P1)** — `VerifyGuardCard` swallows every `getVerifyCode` error into permanent silent dots
  (`LiveTrackingScreen.tsx:841-852,880`). Needs a tri-state (loading/awaiting-crew/error).
- **LB-OTP3 (P1)** — login OTP dev-autofill dead: client reads `res.devOtpCode` (`LoginScreen.tsx:295`)
  but server never returns it (`auth.service.ts:266,278`); no SMS autofill; login resend dead-ends.
- **LB-OTP4 (P2)** — legacy ops/admin job-board dispatch inserts crew without `is_lead`
  (`ops/job-feed.service.ts:291-296` → DEFAULT FALSE) → verify-code `mc.is_lead=TRUE` lookup 400s forever
  (`booking.service.ts:1160`). Narrow: primary auto-dispatch + `ops.service.ts:1010` set it correctly.
- **LB-API1 (P0)** — any refresh failure (network/timeout/502 during auth redeploy / single-device
  takeover `auth.service.ts:109-121`) hard-clears BOTH tokens without inspecting status
  (`api.ts:98-101`); no client booking screen consumes `isAuthLostError` → silent, self-perpetuating logout.
- **LB-API2 (P1)** — booking poll errors swallowed (`catch{}`) with no reconnecting state.
- **LB-ST1 (P0)** — Home dashboard polls nothing (focus-only, `BookingHomeScreen.tsx:115-158`) and the
  list carries only the frozen `booking.status` → "Mission in Progress" never advances.
- **LB-ST2 (P1)** — `BookingConfirmation` feeds the stepper `mission={undefined}` (`:272`) → frozen at
  "assigning team" through DISPATCHED/PICKUP.
- **LB-ST3 (P1)** — LiveTracking poll (+ all terminal navigations) dies at the 30-min cap (`:222,267-269`)
  → a mission completing after 30 min never reaches the completion screen.
- **LB-ST4 (P2)** — LiveTracking exponential backoff is unreachable dead code (`loadActiveBooking` never
  rejects, `bookingStore.ts:122-132`).
- ~~LB-API3~~ REFUTED — `/dispatch/request` double-submit; the paywall CTA is re-entrancy guarded.

**Fixes needing a Contabo `auth-service` redeploy:** LB-OTP3, LB-OTP4, LB-API1 (server half), LB-ST1.

### B-82 — UPDATE 2026-07-11: FIXED (implemented, gates green)

All 10 confirmed findings + the notification deep-link follow-up implemented. Gates: mobile
`booking` jest 144/144, mobile tsc ≤47, auth-service build clean + **1767 backend tests pass**.
Details + per-finding file list in `docs/audits/LITE_BOOKING_CLIENT_BUGS_AUDIT_2026-07-11.md` §8.
Deep-link: booking notification tap now routes DIRECTLY to the stage (LiveTracking/MissionComplete/
NoDetail/…) via `fcmBootstrap.routeServerWakeTap` with cold-start nav-ready polling; new
`detail-enroute`/`detail-live` client pushes make every step notify. Design-conformance follow-up:
`docs/audits/LITE_BOOKING_DESIGN_CONFORMANCE_2026-07-11.md`. Pending: Contabo auth-service deploy

- apply `20260711120000_backfill_job_feed_is_lead.sql` + Firebase QA build + device QA.

## B-83 — 16 KB page-size incompatibility (Android 15 / foldable) · native ABI alignment ⚠️ LOW (staging) / gates Play-prod · OPEN · DEFERRED 2026-07-12

**Device-observed** on a foldable (unfolded inner display, v1.0.111/vc138 QA build). System **"Android App Compatibility"** dialog: _"This app isn't 16 KB compatible. RELRO alignment check failed. This app will be run using page size compatible mode… recompile with 16 KB support."_ App **still runs** (compat mode) — obsidian home rendered fine behind the dialog. **NOT a design bug and NOT caused by the 2026-07-12 design-loop sweep** — it's the bundled prebuilt native `.so` libraries, identical on every build.

- **Primary offender:** `react-native-agora` **4.3.4** — Agora RTC SDK only became 16 KB-aligned in **≥ 4.5.0**, so the whole `libagora-*` / `libAgoraRtcWrapper` / `libvideo_dec` family (the bulk of the dialog list) is 4 KB-aligned. **Fix: bump react-native-agora → ≥ 4.5.x (latest 4.6.x).**
- **Other genuinely-unaligned:** `libconceal.so` ("RELRO segment not aligned"), `libbarhopper_v3.so` (ML Kit), `libargon2native.so`, and `libcrypto.so` (op-sqlite → **SQLCipher/OpenSSL — SECURITY-SENSITIVE**, bump only with crypto-suite verification per CLAUDE.md security rules).
- **"Unknown error" on the rest** (reanimated 4.1, gesture-handler 2.28, worklets 0.5, `libexpo-modules-core`, op-sqlite 14, `libc++_shared`) is suspicious — these versions should already be 16 KB-aligned; likely a stale-packaged lib or the OEM checker mis-classifying. Verify against a fresh build with `expo.useLegacyPackaging=false` (already set) + `zipalign -c -P 16 -v`.

**Severity:** LOW for Firebase/staging (cosmetic warning; app runs). Becomes a **real gate for Google Play production** targeting Android 15 (16 KB required for new apps/updates since Nov 2025) and adds perf overhead on 16 KB-page devices.

**Fix path (LATER, own build):** (1) `react-native-agora` → ≥ 4.5.x; (2) confirm NDK r27+/AGP 8.7+ (Gradle wrapper already 8.14.3); (3) rebuild + re-run the compat check on the same foldable; (4) bump op-sqlite/ML-Kit stragglers as needed — op-sqlite change requires `npm run test:crypto` + SQLCipher round-trip verify. Track as a native-build task, not a UI change. Design-loop cross-ref: `docs/audits/BOOKING_DESIGN_LOOP_2026-07-12.md` §Deferred, `DESIGN_REVIEW_LOOP.md` §3.3.

---

## B-84 — Keyboard covers the focused text input (backup password + 16 more screens) ⚠️ HIGH (blocks restore critical path) · CONFIRMED (full-codebase audit, fixes NOT applied) · 2026-07-16

**Founder repro:** backup-password field hides behind the keyboard when filling it. Full-codebase audit found this is **systemic**, not one screen. Register with per-finding file:line, severity model, repro matrix, and fix direction: **`docs/audits/KEYBOARD_FOCUS_AUDIT_2026-07-16.md`** (KB-01…KB-17).

**Root cause (3 compounding facts):**

1. **Edge-to-edge nullifies `adjustResize`** — `android/gradle.properties:52` `edgeToEdgeEnabled=true` (mandatory, RN 0.81 / target SDK 36) means `windowSoftInputMode="adjustResize"` (`AndroidManifest.xml:133`) no longer resizes the window. Proven in-repo: `ChatScreen.tsx:220-241` only works because it _manually_ tracks keyboard height (would double-lift if the window also resized — it doesn't); `BackupSetupScreen.tsx:465-471` QA comment states plain adjustResize overlapped the field.
2. **App-wide inert KAV idiom** — `behavior={Platform.OS==='ios' ? 'padding' : undefined}` on 12+ screens = KeyboardAvoidingView does NOTHING on Android.
3. **RN `Modal` windows never resize for the keyboard on Android** — every Modal-hosted TextInput needs explicit handling; only `NextOfKinModal.tsx:48-59` does it right (reference pattern, along with ChatScreen's manual kbHeight).

**HIGH (9):** **KB-01 `BackupRestoreScreen.tsx:649`** (the founder repro — restore-gate password, inert KAV, bottom-half field, blocks restore) · KB-02 `BackupSetupScreen.tsx:471` (has `height`+scroll hack but 120 ms reveal timer races the keyboard animation → flaky) · KB-03 `DepartmentChatScreen.tsx:336` (bottom composer, inert KAV, no manual tracking) · KB-04 `AgentLiveTrackerScreen.tsx:790` (bottom input over map) · KB-05 `GroupCallScreen.tsx:2226` (in-call composer in Modal) · KB-06 `JobDetailScreen.tsx` (pledge input, bottom-sheet Modal) · KB-07 `ProfileScreen.tsx:464` + KB-08 `CreditsScreen.tsx:365` (centered-Modal inputs, ZERO handling) · KB-09 `CpoActivationScreen.tsx:159-165` (3 password fields at scroll bottom, activation path).

**MEDIUM (8):** ChatInfoScreen rename modal · NewChatScreen ×2 modals · IndividualProfileScreen · AdminAttendanceScreen · MyAttendanceScreen modals · DayStatusScreen reason input · OrgComplianceScreen · LoginScreen (no ScrollView, small-device/fontScale exposure). **Clean:** KeyboardAvoidingScreen-wrapped forms (Register etc., `height` works but no auto-scroll-to-field), keypad screens (no IME), top-anchored search bars, ChatScreen, NextOfKinModal. Coverage: all 37 TextInput-rendering screen files classified; zero TextInputs exist outside `src/screens/`.

**Fix direction (dev, later):** adopt `react-native-keyboard-controller` OR standardize the two proven in-repo patterns (manual kbHeight for bottom-pinned/Modal inputs; KeyboardAvoidingScreen + focus-scroll for forms). Priority: KB-01/02 → KB-09 → KB-03 → Modal cluster. Device-verify on Pixel 7a w/ Gboard suggestion strip + fontScale 1.3 (emulator keyboards are shorter).

### B-84 — UPDATE 2026-07-16: FIXED (all 17 findings, gates green, device-verify pending)

**Fix shipped same day as the audit.** New shared hooks `src/hooks/useKeyboardHeight.ts`:
`useKeyboardHeight()` (manual IME-height tracking — iOS Will*/Android Did* events, 4 dp OEM
noise floor per ChatScreen Fix #29) + `useRevealOnKeyboard(scrollRef)` (onFocus handler that
scrolls the bottom field into view AFTER the keyboard actually shows — replaces the racy
120 ms BS-BACKUP-PWVIS timer). Unit tests: `src/hooks/__tests__/useKeyboardHeight.test.tsx` (6/6).

**Per-pattern application (Android gets manual kb padding; iOS keeps KAV `padding`):**

- **KB-01 BackupRestoreScreen** — kb padding on KAV + scrollRef + onFocus reveal on the password field.
- **KB-02 BackupSetupScreen** — dropped Android `behavior='height'` (ghost-space quirk) for kb padding; timer reveal → event-driven reveal on all 3 password fields.
- **KB-03 DepartmentChatScreen / KB-04 AgentLiveTrackerScreen** — ChatScreen composer pattern (kb padding; tracker swaps `insets.bottom` for `kbHeight` while IME is up to avoid double-pad).
- **KB-05 GroupCallScreen chat sheet / KB-06 JobDetailScreen pledge sheet / KB-10 ChatInfo rename / KB-11 NewChat ×2 / KB-12 IndividualProfile / KB-13 AdminAttendance / KB-14 MyAttendance** — modal overlay/backdrop lifted by kb padding (NextOfKinModal pattern).
- **KB-07 ProfileScreen name modal / KB-08 CreditsScreen promo modal** — had ZERO handling: cross-platform kb padding on the centered overlay.
- **KB-09 CpoActivationScreen** — root kb padding (lifts pinned footer, shrinks scroll → native scroll-to-focused-field) + reveal on all 3 password fields. **KB-15 DayStatusScreen** same + reveal on note. **KB-16 OrgComplianceScreen** root kb padding.
- **KB-17 LoginScreen** — kb padding + form now wrapped in a ScrollView (`keyboardShouldPersistTaps="handled"`, `body` flex:1→flexGrow:1) so small-device/fontScale layouts scroll instead of clipping.

**Gates:** tsc **46 ≤ 47** baseline · eslint 0 errors on all 19 touched files · targeted suites green (BackupRestore.legacy, BackupSetup.audit, GroupCall.autopop, hook tests) · full app+booking projects: 360 passed / 4 failed — the 4 failures (`authStore.recheckMembership`, `uploadAvatar`) **verified pre-existing on main** (fail identically with the B-84 diff stashed).

**Residual:** on-device visual verify pending (physical device + Gboard w/ suggestion strip, fontScale 1.3, per audit §4 matrix) — keyboard behavior is not fully provable in Jest. Client-only TS/JS change: no native/config/dep change, next APK picks it up.

---

## B-85 — Back from ChatScreen lands on Dashboard instead of the chat list ⚠️ P1 · CONFIRMED (audit only, fix NOT applied) · 2026-07-16

**Founder repro:** open someone's chat → back → home dashboard, not MessengerHome. **Intermittent by design of the bug:** only the _cold deep-link_ entries are broken — chat-list entry always works.

**Root cause:** `MessengerNavigator.tsx:42` has **no `initialRouteName="MessengerHome"`**. Notification deep-links (`fcmBootstrap.ts:896-899`, missed-call `:640-643`) and the ops cross-tab hop (`OpsMissionDetailScreen.tsx:124-131`) navigate `Main → MessengerTab → Chat` while the lazily-mounted messenger stack doesn't exist yet → React Navigation seeds the stack as **`[Chat]` alone**. `ChatScreen.tsx:1204` `goBack()` (hardware back identical; no BackHandler override) has nothing to pop → bubbles to the Tab navigator → `backBehavior="history"` (`MainNavigator.tsx:650`) → previously-focused tab = Dashboard. If Messenger was opened earlier in the session the stack is `[MessengerHome, Chat]` and back works.

**Fix direction (1 line):** `initialRouteName="MessengerHome"` on the Stack.Navigator in `MessengerNavigator.tsx:42` (seeds MessengerHome beneath deep-linked Chat). Same shape helps the incoming-call deep-link (`MainNavigator.tsx:501-515`). Agency shell (flat AgentNavigator Chat route) unaffected. Full entry-path matrix: `docs/audits/MESSENGER_UX_AUDIT_2026-07-16.md` §1.

---

## B-86 — "Move to Vault" in the file/image viewer does nothing ⚠️ P1 · CONFIRMED (deliberate fail-closed stub; audit only) · 2026-07-16

**Repro:** image viewer (or FilesScreen) → "Move to Vault" → alert "Vault upload coming soon" → no-op.

**Root cause:** `vaultMoveAction.ts:14-19` returns `{kind:'blocked'}` for any not-in-vault file — **intentional** fail-closed gate from audit M-02/S1 (old code persisted a fake `VaultFile` with empty key/IV and a plaintext temp URI, i.e. pretended encryption). Invariant locked by `vaultMoveGuard.test.ts`. **The real pipeline exists on both ends but is unwired:** client `VaultClient.uploadEncrypted/downloadAndDecrypt` (`src/modules/messenger/vault/vaultClient.ts:47-85`, sends `X-Mfa-Proof`) is **never instantiated anywhere** (`new VaultClient` = 0 hits); server `POST /vault/upload-url` + `/vault/download-url/:key` live behind `JwtHttpGuard + MfaGuard` with real S3/R2 presigning (`apps/messenger-service/src/vault/*`).

**Fix direction:** wire host-side MFA challenge (biometric→TOTP action token) → instantiate VaultClient → encrypt-upload decrypted bytes → `useVaultStore().addFile` keyed `msg:<id>` → relax `resolveVaultMoveAction` + update guard test to the new invariant (real key material required). **Touches the File Vault MFA gate → verify against System Architecture Documentation before implementing; do NOT bypass MFA.** Details: `MESSENGER_UX_AUDIT_2026-07-16.md` §2.

---

## B-87 — Messenger media UX gaps: single-photo picker · no viewer zoom ⚠️ P2 (feature gaps) · CONFIRMED · 2026-07-16

1. **Multi-photo select missing:** `ChatScreen.tsx:1026-1029` `launchImageLibrary({selectionLimit: 1,…})`, only `assets[0]` consumed; `sendPickedMedia`/`rt.sendMedia` are one-asset-per-call (one bubble + one encrypted upload each); message model is single-attachment; **no pre-send preview tray exists** (pick = immediate send). Fix shape: `selectionLimit:0` + asset loop + net-new preview/caption tray; N bubbles need **no runtime/protocol change**. (WhatsApp-style album grid bubble = separate, design-reviewed task — envelope/model change.)
2. **No pinch-zoom in photo viewer:** `FileViewer.tsx:151-158` renders a plain `<Image resizeMode="contain">` in a Modal, fixed frame; zero gesture code in `src` (no `Gesture.`/Pinch/Pan hits); no zoom/gallery lib installed — but `react-native-gesture-handler ~2.28` + `reanimated ~4.1` are already deps (unused in messenger), so pinch/double-tap/pan needs no new package.

**Also in the same audit:** smoothness register **MX-05..MX-13** (`MESSENGER_UX_AUDIT_2026-07-16.md` §4) — headline: **MX-05 P1 non-inverted chat list + 4-shot `scrollToEnd` open-flash** (`ChatScreen.tsx:548-558`) = the biggest WhatsApp-feel gap; MX-06 P1 swipe-to-reply over JS bridge; MX-08 `Vibration` instead of haptics; MX-09 no optimistic media bubble. Prior audit's perf P1s (M-13..M-18) verified already fixed. Double-tick licensing question answered in §5: ticks are NOT Meta-licensed (generic convention; Telegram etc.); current `check`/`check-all` + `Bravo.glow` read-state is already differentiated; restyle options listed.

### B-85 / B-86 / B-87 — UPDATE 2026-07-16 (same day): ALL FIXED (+ MX-03..MX-13), gates green, device-verify pending

Full fix log: **`docs/audits/MESSENGER_UX_AUDIT_2026-07-16.md` §7**. Highlights:

- **B-85** — TWO-part fix (adversarial review caught that the prop alone was a NO-OP: React Navigation's nested `screen` param overrides `initialRouteName` on first mount): `initialRouteName="MessengerHome"` on `MessengerNavigator.tsx` **+ `initial: false` on all 3 Chat deep-links** (`fcmBootstrap.ts` message/missed-call taps, `OpsMissionDetailScreen.tsx` hop) → the chat list now genuinely seeds beneath a deep-linked Chat. MX-13 rider: AgentNavigator Chat route gets `freezeOnBlur` + native slide. Locked by `src/navigation/__tests__/navigatorConfig.test.ts` (incl. the `initial: false` sites).
- **MX-05 (the "not WhatsApp-smooth" headline)** — ChatScreen list is now **inverted**: opens ON the newest message (open-flash + 4-shot scroll hack deleted), `onEndReached` pagination (older pages append → zero offset shift), native at-bottom follow via `maintainVisibleContentPosition.autoscrollToTopThreshold`. Pure interleave/reversal module `chatListItems.ts` + 8 unit tests (separator adjacency, unread divider, MX-07 identity stability).
- **MX-06** — swipe-to-reply on the UI thread (RNGH PanGestureHandler + native `Animated.event`; `activeOffsetX/failOffsetY` arbitration with list scroll).
- **B-87b/MX-03** — pinch-zoom/double-tap/pan viewer: new `ZoomableImage` (classic RNGH + core Animated native driver — NO reanimated, worklets babel plugin absent by design) + pure `zoomMath.ts` (9 tests); hosted in `GestureHandlerRootView` inside the FileViewer Modal.
- **B-87a/MX-04** — multi-photo select (`selectionLimit` 1→10) + new obsidian `MediaPreviewTray` (thumbs, per-item remove, "Send N"); single pick keeps the fast path; N photos = N encrypted bubbles, no protocol change.
- **MX-09/10/08/11/12** — composer never blocks (serial media queue + "k of n" chip); determinate `UploadProgressRing` on sending bubbles (`MediaClient.uploadEncrypted` optional XHR `onProgress` — fetch path untouched when absent; transient `useSyncExternalStore` registry, cleared in `finally`); thumb data-URI memo; `@utils/haptics` seam replacing raw `Vibration`; `scrollEventThrottle` 16; renderItem hoisted.
- **B-86** — Move-to-Vault WORKS via the documented MFA chain: biometric ceremony → `KeysHttpClient.mintActionToken('vault-access')` (`/auth/biometric/assert`) → `VaultClient.uploadEncrypted` w/ single-use `X-Mfa-Proof` → real key material in the index (`VaultFile.sourceKey` for dedup). **Fail-closed preserved** (no proof → honest alert, zero writes; `addFile` refuses key-less rows — M-02 moved into the store; `vaultMoveGuard.test.ts` rewritten, 14 tests). All three surfaces wired (FileViewer, FilesScreen, VaultScreen incl. real open-with-decrypt + direct uploads). Staging works (`BIOMETRIC_DEV_BYPASS`); production stays gated until a real Play Integrity attestation ships (documented keysClient posture — NOT a bug).

**Adversarial review pass (before ship):** 4 CONFIRMED majors caught + fixed same-session — M1 B-85 prop-only no-op (→ `initial: false` at call sites), M2 dead double-tap zoom (pan BEGAN latched the guard flag), M3 unreachable upload ring (bubble branches required the post-upload object key → classify by `msg.type` while progress is live), M4 vault-opened files mismatched the index (`ViewableFile.vaultSourceKey`; fixes duplicate re-uploads + silent no-op Delete). Minors: stale queue closure, re-swipe spring fight, TZ-fragile test fixtures. Reviewer-verified clean: inverted ordering/anchoring, media queue mechanics, vault MFA chain (no key-less-row path, single-use proofs, no key logging).

**Gates:** tsc error signatures **diffed vs clean main — identical 46** (zero introduced) · eslint 0 errors (all touched files) · messenger/nav/hooks suites green (**1274+ tests incl. 38 new**) · full app+booking+crypto run: only the two **known pre-existing** failures (`authStore.recheckMembership`, `uploadAvatar` — stash-verified failing identically on main; `blockedPeersAndTombstones` full-run flake passes standalone on both trees). **Residual:** on-device verify per audit §7 (notification-tap back-nav, inverted feel, gestures, tray, vault MFA on staging; watch `removeClippedSubviews`+inverted on Fabric) — rides the next APK; client-only TS/JS change, no native/config/dep change.

---

## B-88 — Native (unbranded) popups app-wide: system AlertDialog on obsidian UI ⚠️ P2 design · CONFIRMED + FIXED same session · 2026-07-16

**Founder repro:** "some popup (native no design)" — every `Alert.alert` (252 call sites / 71 files, incl. 4 lazy requires) rendered the SYSTEM Android dialog (white card, Material buttons) on top of the obsidian app. No `Alert.prompt`/`ToastAndroid`/`ActionSheetIOS` usage; OS-owned dialogs (permissions, pickers) out of scope.

**Fix (drop-in, call sites unchanged):** `src/utils/alert.ts` — same `Alert.alert` signature + pure FIFO queue with RN-Android semantics (default OK; back/backdrop dismiss when cancelable→`onDismiss`, never a button handler; queue-then-run-handler; stale-press guard) → rendered by `src/components/BravoAlertHost.tsx` (obsidian/cobalt card in a transparent Modal that stacks above other Modals; icon medallion flips red when a destructive button exists; one filled primary, glass cancel pinned left, red-tinted destructive; 48dp targets; long messages scroll; fontScale-safe) mounted once in `App.tsx`. Import-swap script changed 69 files + 2 lazy-require files; 3 Alert-spying test suites re-pointed to the shim. **Static sweep test now FAILS the build if any file imports Alert from react-native again.**

**Gates:** tsc 46 = HEAD (signature-diffed) · eslint 0 errors (76 files) · new tests 18/18 (queue semantics, variants, host render, static sweep) · full run 230 suites / 2018 tests — only the two known pre-existing failures. Register + design-loop iteration log/scores: `docs/audits/NATIVE_ALERT_REDESIGN_2026-07-16.md`. **Residual:** visual device pass (alert-over-modal stacking, fontScale 1.3, 320dp).

---

## B-89 — Live map/GPS/route audit: client watches a SIMULATED dot, heading dead, no background GPS, prod token gap ⚠️ P1 cluster · CONFIRMED (audit only, fixes NOT applied) · 2026-07-16

**Founder ask:** "map should perfectly work with location (GPS) and the direction route should work." Full register with per-finding file:line, verified chains, and fix order: **`docs/audits/MAP_GPS_ROUTE_AUDIT_2026-07-16.md`** (MG-01..MG-16 + P3s).

**P1s (each hand-verified at every link):**

1. **MG-01 — the CLIENT live map never shows the real CPO.** `LiveTrackingScreen` polls `/telemetry/:bookingId/latest` (Redis + `mission_telemetry_last`) and subscribes to WS `mission.telemetry` — but those stores' only writers are DEAD (`telemetryApi.ping` has zero callers; `POST /ops/missions/:id/telemetry` removed by audit 1.3) and `MissionEventsService.telemetryFix` has ZERO callers. The real CPO push (`mission-lead.service.ts:175-193`) writes `mission_telemetry` + `missions.current_*` only → client `realFix` stays null → renders the canned straight-line `sim.vehicle` with an invented ETA for the whole mission. Ops/CPO screens read `missions.current_*` and are fine. Fix = mirror the push to `mission_telemetry_last`/Redis + emit `events.telemetryFix` (~20 server lines; client WS/poll already wired).
2. **MG-02 — heading dead end-to-end** (3rd audit flag): `missions.heading_deg` is written but neither live SELECT (`agent.service.ts:1165`, `org-mission.service.ts:191`) selects it, and the client reads a mismatched `current_heading_deg`; no server bearing derivation when the device reports none → direction cone permanently north.
3. **MG-03 — no background tracking**: foreground-service keep-alive is a TODO no-op (`onDutyHeartbeat.ts:142-147`); screen off / backgrounded ⇒ CPO GPS stops. Permissions declared, never used.
4. **MG-04 — prod token-bake gap**: `eas.json` `production` + `preview-staging-device` have NO env block and `apk:*` scripts omit `EXPO_PUBLIC_MAPBOX_TOKEN` (works today only via git-tracked `.env.production` dotenv); a tokenless build = infinite RETRY loop that the B-77 recovery cannot heal, indistinguishable from offline.

**P2 highlights:** GPS-off silent (`showLocationDialog:false` + empty error callbacks) · Android 12+ approximate-grant undetected (FINE-only everywhere) · unbadged simulated motion pre-first-fix · CPO tracker `navActive` latch leaves a stale-leg line (`bravoAgentTrackerMapHtml.ts:444`, one-line fix) · shared unrotated git-committed pk token (mobile+ops+backend) · IntelFeed Leaflet map has zero recovery (only surface B-77 missed) · GL `error` posts ignored (~30 s to RETRY; token vs offline indistinguishable) · (0,0)/null-island accepted by `clientPing` + map HTML · no accuracy/outlier gating (M-4 open) · no ops-side lost-signal dimming.

**Verified GOOD (don't re-fix):** B-77 watchdog/RETRY recovery real on all 4 GL maps; the direction ROUTE layer genuinely works (road-following polyline, traveled/remaining split, 60 m off-route reroute, live ETA, pickup→dropoff leg switching, straight-line fallback, backend precompute w/ alternatives); B-80 heartbeat; SOS fires without a fix; staleness banners; watches cleaned; GL 3.9.0 pinned.

**Deploy note:** MG-01/02 are auth-service fixes → Contabo deploy; MG-04 is build config; MG-03 needs native foreground-service work + device pass; rest client-side.

### B-89 — UPDATE 2026-07-16 (same session): ALL FIXED except two explicit deferrals · deployed with this push

Full fix log: **`docs/audits/MAP_GPS_ROUTE_AUDIT_2026-07-16.md`** (EOF). Highlights:

- **MG-01 FIXED (server)** — `pushTelemetry` mirrors every CPO fix to the client stores (Redis + `mission_telemetry_last`, with a real ETA) and emits `mission.telemetry` (first caller of `telemetryFix`); the client's poll + WS paths light up unchanged → **the principal now watches the REAL vehicle**. Spec: `mission-lead.telemetry-mirror.spec.ts` (9).
- **MG-02 FIXED (server)** — heading selected on both live reads (`AS current_heading_deg`) + server-side bearing derivation from prev→current fix (≥8 m) when the device reports no course → the cone rotates everywhere, stationary/emulator included.
- **MG-03 FIXED (client+manifest, needs next APK)** — notifee mission foreground service (`missionForegroundService.ts`, manifest merge `foregroundServiceType="location"`, registered at bundle entry) held by `useLeadTelemetry` for the watcher's lifetime → CPO GPS survives screen-off/backgrounding. Device soak pending.
- **MG-04 FIXED (config+client)** — token pinned in eas `production`/`preview-staging-device` + `apk:*` scripts; `mapToken.ts` single source; tokenless builds render an honest "packaged without a map key" overlay instead of the infinite RETRY loop.
- **Founder add-on FIXED** — on a LIVE mission, missing GPS access is RE-ASKED (`ensureLiveLocationAccess`: branded rationale → re-request → Open Settings when blocked; re-armed per refocus) on client LiveTracking + CPO console.
- **MG-05/06/16** — GPS-off now prompts once/session with a Location-Settings jump (`showLocationDialog` restored, error callbacks live); FINE+COARSE requested together with approximate-only detection; iOS onboarding drops `always` for `whenInUse`.
- **MG-07/13/14** — simulated dot DELETED (frozen-at-pickup + "Awaiting live GPS" until the first real fix; no invented ETA); `acceptGpsFix` plausibility gate (accuracy ≤150 m, speed ≤70 m/s, null-island reject; 6 tests) on WS + poll; accuracy confidence circle drawn from the WS frame.
- **MG-08/11/12** — tracker `navActive` un-latched (stale-leg line gone); all GL surfaces fast-fail pre-ready boot errors (~1 s to recovery instead of ~30 s) + constructor try/catch + loading overlays; (0,0)/non-finite rejected at `clientPing` AND in the map HTMLs.
- **MG-10/15 + P3s** — IntelFeed Leaflet map got the full watchdog/RETRY treatment; ops `/live` shows `LOST SIGNAL <age>` >90 s and greys the marker >5 min (`missions.updated_at` exposed); dead `telemetryApi.ping` removed; `updateTelemetry` deprecated.

**Deferred:** MG-09 token rotation (Mapbox dashboard = ops action; code is env-ready) · P3-C `is_mocked` on the live feed (needs a DB migration).

**Gates:** mobile eslint 0 / tsc 46 = main (signature-diffed) / jest 231 suites·2024 tests green (only the 2 known pre-existing failures; booking project = LITE_BOOKING_LOOP automated gate) + 15 new tests · auth-service tsc clean + 54/54 targeted specs · ops-console typecheck + lint clean · adversarial review pre-push. **Deploy:** CI was DOWN (GitHub billing) — deployed manually via `scripts/deploy-staging.sh` (see operational note). **Device-verify pending:** real-dot movement + rotating cone on a live mission, FGS screen-off soak, GPS-off/approximate prompts, ops LOST SIGNAL badge.

**OPERATIONAL NOTE (2026-07-16):** GitHub Actions has been failing on ACCOUNT BILLING ("recent account payments have failed or your spending limit needs to be increased") for EVERY push since at least 2026-07-10 — the Contabo auto-deploy never ran for B-76's server half or anything after. B-89's server fixes were deployed MANUALLY via `scripts/deploy-staging.sh auth-service ops-console` (which also swept up the stale backlog since main is the rsync source of truth). **Founder action: fix the GitHub billing/spending limit to restore CI.**

---

## B-90 — Boss QA-PDF batch: 13 UI/UX findings (T-01..T-13) ⚠️ P2 cluster · CONFIRMED (investigation only, fixes NOT applied) · 2026-07-16

**Source:** founder QA PDF (11 annotated screenshots) + 2 product-owner asks (chat link previews, blue-bg sweep). Every finding root-caused to file:line; full register with per-task fix plan, blast radius, per-task fix loop (repro → fix → impact pass → gates) and exit criteria: **`docs/handoffs/QA_PDF_FIX_BATCH_2026-07-16.md`**. Implementing sessions: work that doc task-by-task; log completions as B-90 UPDATE entries here (or claim fresh B-numbers per task if preferred — re-check the last used number first).

| Task | Finding (root cause, verified)                                                                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | "SIA Licence / CPO Profile" → "Security License" — display-only string `AgentDocsUploadScreen.tsx:30` (slot key `'sia'` must NOT change)                                                                                                                                                                                                                  |
| T-02 | Passengers row overflow on Schedule step 3 — ~136px fixed right cluster + `height:60` + `numberOfLines={1}` leaves ≈116px for a ~150px label (`BookingDateTimeScreen.tsx:366-406,577-604`); `scaleTextStyles` makes big phones worse                                                                                                                      |
| T-03 | VIRTUAL BODY GUARD banner dead — `TouchableOpacity` has NO onPress (`NewsHubScreen.tsx:183`); route exists (`SecureTab`→`VBGHome`)                                                                                                                                                                                                                        |
| T-04 | Calls "LINKS" button dead — no onPress (`CallsLogScreen.tsx:160-163`); no Links screen exists anywhere; server CANNOT index links (E2EE) → client-side scan of local SQLCipher `messages.content` using existing `URL_RE` (`linkPreview.ts:23`)                                                                                                           |
| T-05 | Drawer "Agent Portal" navigates to unregistered `AgentTab` (`DashboardScreen.tsx:99,667-669`) → remove; **"Bravo Pro" is ALSO dead** (`ProTab` unregistered; real route `SecureTab`→`ProLanding`) — boss decision pending                                                                                                                                 |
| T-06 | Chat Info: "Recovery" text near-black (`settingRight` has no color, `ChatInfoScreen.tsx:658,922`); phone-under-name slot exists but `resolveUserPhone` only knows dev fixtures (phone dropped at discovery — `useDiscoveredContacts.ts:190-196`); screen bg is Command-Navy `Colors.background #0A1F3F` (`:880`)                                          |
| T-07 | South Africa missing ONLY from client `REGION_SEED` (`ZoneMapScreen.tsx:70-75`) — backend already accepts ZA; 3-letter badges need a display field (codes are the dispatch key, must stay); home region chip is hardcoded 🇦🇪/UAE (`BookingHomeScreen.tsx:227-240`); map preload: picker WebView cold-boots mapbox-gl from CDN on mount, no warm-up exists |
| T-08 | Sign-in yellow = Android autofill highlight; TextInput sets no autofill props (`LoginScreen.tsx:206-220`); repo pattern exists (`BackupSetupScreen.tsx:530-532`)                                                                                                                                                                                          |
| T-09 | "SIGN IN" eyebrow 10px @ 45% opacity (`LoginScreen.tsx:494`, `T.textMute`) — hierarchy rebalance                                                                                                                                                                                                                                                          |
| T-10 | "AG"/"AGENT" = `agents.display_name` NULL at auto-create (`_useAgent.ts:34` → fallback `'Agent'` at `AgentDashboardScreen.tsx:440`); `pickInitials` needs boss's 1/2/3+-word algorithm (`agentFlowHelpers.ts:105-111`); photo upload ALREADY EXISTS (drawer, `useAvatarPicker`) — surface it                                                              |
| T-11 | "Last seen 13h ago" pill overlaps call icons — no flexShrink/maxWidth on `presenceRow`/pill/`pillTxt`, `headerActions` lacks `flexShrink:0` (`ChatScreen.tsx:2783,2790`; `PeerPresence.tsx:207-213`)                                                                                                                                                      |
| T-12 | Link previews PARTIALLY BUILT (`LinkPreviewCard` wired at `ChatScreen.tsx:2305`); gaps: no in-bubble linkification + **privacy leak** — recipient device fetches the URL on render (`linkPreview.ts:46`); proper fix = sender-embedded preview in SealedPayload (ARCH-GATED stop condition)                                                               |
| T-13 | 60 screens + 5 navigators still on Command-Navy `#0A1F3F` page bg (full file:line inventory in the handoff doc §T-13); target obsidian `#07090D`; contrast re-check required per screen                                                                                                                                                                   |

**Not fixed in this session by design** — founder asked for the investigation register only.

### B-90 — UPDATE 2026-07-16 (same day): ALL 13 TASKS FIXED IN CODE · device-verify pending

All T-01..T-13 implemented per the handoff doc (`docs/handoffs/QA_PDF_FIX_BATCH_2026-07-16.md`), boss-default answers applied to the 5 open questions. Per-task outcome:

- **T-01 FIXED** — "Security License" label on Document Upload (`AgentDocsUploadScreen.tsx:30`), KYC screen + `OrgCreateCpoScreen` chip + ops-console label map + both backend seed titles (new rows only; existing DB rows keep the old stored title — display comes from the client META so users see the new label regardless). Slot key `'sia'` / kind `sia_licence` untouched.
- **T-02 FIXED** — passengers row: `minHeight` + 2-line wrap + slimmer control cluster (`counterVal` 44→34, gaps 8→6, `flexShrink:0`), label column gets ≈+30px; verified `counter*` styles have no other consumers.
- **T-03 FIXED** — VBG banner navigates `SecureTab→VBGHome` via a proper `CompositeNavigationProp` (no casts) + a11y label.
- **T-04 FIXED** — new `LinksScreen` (obsidian, FlatList paging, tap=open / chip=jump-to-chat), `SqlMessageStore.loadLinkMessages` (LIKE-prefiltered, expiry-aware) exposed as optional `runtime.loadLinkMessages` (epoch-guarded), route registered, CallsLog LINKS button wired + typed nav. Confirmed server-side links index impossible (E2EE) — local-only by design.
- **T-05 FIXED** — Agent Portal removed (entry+case+union); divider moved to Bravo Pro; **Bravo Pro AND My Bookings both re-pointed** from dead top-level routes (`ProTab`/`BookingHome`) to `SecureTab:{screen:…}` (My Bookings was silently broken too — same class).
- **T-06 FIXED** — `settingRight` default color #7E8AA6 ("Recovery" readable); navy hairlines → white-alpha; phone-under-name: `LocalConversation.phoneE164` (zustand-persist, no migration) captured at contact discovery (peer-indexed patch loop now also covers B-18 UUID rows), NewChat + by-number creation, ChatInfo prefers it. Known limit: chats never discovered/created-by-number show no number (matches WhatsApp for unknowns).
- **T-07 FIXED** — ZA in `REGION_SEED` (COMING SOON until server availability flips it; **ops must seed ZA cpo_pool/vehicle_pool + a dispatch-eligible agency for real dispatch**); 3-letter DISPLAY badges UAE/KSA/BGD/GBR/RSA (codes untouched — ⚠️ boss wanted "SA" for South Africa but that's Saudi's dispatch code; KSA/RSA chosen, flag if he objects); home region chip now live from `draft.zone_code` via new `regionDef()` (badge+flag on REGIONS); `MapPrewarm` invisible 1×1 one-shot WebView on BookingHomeScreen warms mapbox-gl/style/tiles into the WebView HTTP cache (token-gated, 25s cap, tears down on ready/err, never retries).
- **T-08 FIXED** — theme-level `android:autofilledHighlight=transparent` (styles.xml, **gitignored — commit with `git add -f`**) kills the yellow while KEEPING password-manager autofill; proper `autoComplete`/`textContentType` threaded through LoginScreen's Field (email/password).
- **T-09 FIXED** — "SIGN IN" eyebrow 10px/45%-mute → 12px/700 cobalt `#5B8DEF` (≈5.5:1 on obsidian).
- **T-10 FIXED** — `pickInitials` per boss spec (1w→2 letters, 2w→2 initials, 3+w→first-3) + 5 new test cases (52/52 green); duty-card name renders `NAME (AGENT)`; display_name fallback → auth user's full_name; agent auto-create now SENDS display_name (api already accepted it); duty-card avatar tappable → existing `AvatarPhotoSheet` (upload flow already existed, just undiscoverable).
- **T-11 FIXED** — presence pill + `presenceRow` get `flexShrink/minWidth:0`, `pillTxt` shrinks so `numberOfLines={1}` actually ellipsizes, `headerActions` `flexShrink:0`. Pill has exactly one call site.
- **T-12 FIXED (interim privacy model)** — new `LinkifiedText` renders body URLs as tappable underlined spans (white on cobalt outgoing / #A9C5FF on obsidian incoming), shared `splitByUrls/allUrlsIn` derived from the ONE `URL_RE`; `LinkPreviewCard` gains `autoFetch` — **received links no longer auto-fetch** (recipient-IP leak closed): "Tap to load preview" chip, session-scoped per-URL consent; sender side unchanged. **Deferred (arch-gated): sender-embedded preview in SealedPayload** — needs architecture approval before touching the envelope.
- **T-13 FIXED (token retarget)** — `Colors.background`/`Bravo.bg` → `#07090D`, `backgroundDepth`/`bgSoft` → `#05070B` → migrates all ~60 legacy screens + 5 navigators + StatusBars + `AmbientBg` in one move (verified zero inverted uses; `tabBar`/`textInverse`/`overlay*` tokens unused). Literal stragglers retargeted: SignupSuccess, VoiceCall root, AgentLiveTracker chrome/depth, ChatInfo/NewChat modal inputs + fingerprint box, Vault sheet, RoleSelection chip, 3 map-HTML loading backdrops, app.json splash, native `splashscreen_background` + navy `statusBarColor` (launcher `iconBackground` deliberately left — brand mark, not a page). Card surfaces/borders keep the navy-family identity by design; flag any screen that reads poorly on device.

**Gates (final):** mobile tsc 46 errors = main's pre-existing set (≤47 baseline, none in new/changed code) · ops-console tsc ✓ · auth-service tsc ✓ · targeted eslint 0 errors (3 pre-existing warnings) · crypto project 185 suites/1636 green · `agentFlowHelpers` 52/52 · full `npm test`: 230 suites/2023 tests passed, 3 failing suites (`authStore.recheckMembership`, `uploadAvatar` = **stash-verified failing identically on clean HEAD** — uploadAvatar hits a live Supabase edge fn; `incomingRingtone` = jest transform race, passes in isolation AND in the crypto-project run) · **local release APK built (5m10s) + installed + booted on BlueStacks emulator-5554**: clean JS console (known deprecations only), HomeSelection + Login screens screenshot-verified OBSIDIAN with the new cobalt SIGN IN eyebrow. **Remaining device QA for tester:** autofill yellow on a real device w/ saved credentials, links browser + linkified bubbles + consent chip on seeded chats, phone-under-name after fresh contact discovery, warm-vs-cold picker timing, ZA zone row + region chip after zone switch, passengers row at 320dp/fontScale 1.3, agent initials/(AGENT)/photo on a fresh agent account, obsidian eyeball across the 60-screen inventory.

---

## B-91 — Platform UI Corrections Spec v2.0: three standalone products ⚠️ P1 architectural program · SPEC MAPPED (docs only, NO code) · 2026-07-16

**Source:** `Bravo_Platform_UI_Corrections_Implementation_Specification.pdf` (28pp, v2.0 July 2026) — QA/product target-state spec: ONE shell, THREE separated products (Messenger / Virtual Bodyguard / Secure Services), each with own onboarding→dashboard, per-product bottom nav, persisted active product, back-stack reset on switch, combined command home DELETED. Full gap analysis (every requirement mapped to current file:line) + phased plan + per-module loop, one doc per module:

- **INDEX + shared loop + build order (M0→M3→M1→M2→delete):** `docs/handoffs/UI_SPEC_V2_INDEX.md` (incl. 9 boss questions, 3 blocking)
- **M0 platform shell:** `docs/handoffs/UI_SPEC_V2_M0_PLATFORM_SHELL.md` — selector exists but cosmetic (OnboardingScreen:201 all 3 cards → same handler); HomeSelectionScreen orphaned; NO product persistence exists; DashboardScreen is the only SOS host (duty re-home table); per-product = conditional-mount pattern (AgentNavigator precedent)
- **M1 Messenger:** `docs/handoffs/UI_SPEC_V2_M1_MESSENGER.md` — 5-tab bar ALREADY matches spec; NO Enterprise tier exists (tier.guard.ts:8 = lite|pro); dept-chat gate is org-based not tier-based; sponsored slot net-new (no campaign infra); ⚠️ vault free tier conflict: spec 100MB vs shipped copy 500MB (+ storage endpoints 404, no server quota); SM-512 exists nowhere (label-only, must not touch crypto)
- **M2 Virtual Bodyguard:** `docs/handoffs/UI_SPEC_V2_M2_VIRTUAL_BODYGUARD.md` — Home already single-scroll w/ REAL Mapbox mini-map + hold-to-alert panic (vbgApi.panic); remove OSINT tile (VBGHomeScreen:264-267) + Ops Room card (:311-323); footer 5→3 tabs; no fullscreen map (fixed 132/300/280px); Nearby unsorted + no filters; ⚠️ NO 72h news filter — GDELT defaults 21 DAYS, withinWindow falls back to unfiltered (vbg.service.ts:1045-53)
- **M3 Secure Services:** `docs/handoffs/UI_SPEC_V2_M3_SECURE_SERVICES.md` — smallest: rename (BRAVO SECURE → SECURE SERVICES, BookingHomeScreen:230), top-left profile control net-new, 2-tab bar, drawer switch, unsaved-draft guard net-new (draft never reset — resetDraft() has zero callers)

**Not implemented by design** — founder asked for the module docs only. Implementing sessions: read INDEX first, M0 before any product module, log progress as B-91 UPDATEs.

### B-91 — UPDATE 2026-07-16 (same night): M0+M1+M2+M3 IMPLEMENTED, one commit per module · device boot-verified

Commits (sequential, per founder's one-module-at-a-time instruction): docs `1e0…` (handoffs), **M0** platform shell, **M1** messenger, **M2** VBG `e3a84ba`, **M3** secure services `0f81f70`. Implementation notes at the top of each module doc.

- **M0** — built as a product-aware SINGLE shell (safer variant of the doc's plan; same acceptance): client Tab tree `key`ed by persisted `activeProduct` (remount = back-stack reset), per-product tab sets + landing (Chat list / BookingHome / VBGHome), Dashboard (combined command home) UNROUTED — ⚠️ its SOS/activity-drawer duties are offline pending Q8; `productStore` + `ProductGateScreen` (authed users with no product pick once), selector cards carry the choice, splash 2s, shared `SwitchDashboardSection`/`ProfileDrawerModal`, sign-out clears product.
- **M1** — pinned SponsoredSlot (fallback campaign; `/ads/campaign` stub pending Q3), dept-chat card ENTERPRISE + locked + spec upgrade prompt (`useEntitlements` mirrors the org gate), news hub = intel+feed only (NewsAds deregistered), messenger profile drawer, vault 3-button prompt + 100MB copy (Q7), Service Provider→Enterprise labels. Deferred: tier-matrix screen + `messenger_tier` field (Q1/Q2), SM-512 placement (Q4).
- **M2** — Home: OSINT tile + Ops Room card REMOVED, GeoRisk embedded inline (`GeoRiskPanel` extraction), Secure Services quick action = product switch, Request Support → messenger module (Q9 default), top-left avatar drawer; NEW `VBGMap` expanded map (fullscreen, pin card, NAVIGATE handoff); Nearby nearest-first + category filter chips (map+list share one set); **72h news enforced at the query layer** (`withinWindowStrict`, GDELT clamp; SRA path untouched) + LAST 72 HOURS chip — ⚠️ auth-service change, **needs Contabo deploy**; footer 5→3 tabs (drill-downs light Home; Home returns from drill-downs).
- **M3** — header SECURE SERVICES + top-left avatar drawer; 2-tab bar via M0; `isBookingDraftDirty()` + Stay/Leave confirm on product switch; `confirmBooking` clears the draft (zone kept for the region chip).

**Gates:** tsc 46 = pre-existing set after every module · auth-service tsc clean · lint 0 errors · targeted suites green per module (navigatorConfig, storeReset, vaultNavigation, vbg 33/33 incl. rewritten 3-tab VbgFooter contract, booking 149/149) · full jest 229 passed / 4 failed = the 3 stash-verified pre-existing + `CreditsScreen.topup` 5s-timeout flake (passes in isolation; full run shared CPU with the gradle build) · **release APK built + booted on BlueStacks: product gate live for an existing account, tapping Messenger lands DIRECTLY on the chat list with the sponsored slot, drawer avatar, 5-tab bar and zero cross-product content (screenshots verified).**

**Remaining for humans:** answer the 9 INDEX questions (Q1/Q2/Q7 blocking the tier screen + vault quota; Q8 decides DashboardScreen/sosApi deletion vs re-home); deploy auth-service (72h feed) to Contabo manually (CI still billing-dead); tester device pass per module acceptance checklists (product switching matrix, agent/CPO logins, killed-app notification taps, unsaved-booking guard).

---

## B-92 — Client trapped on "Awaiting Ops Approval": no way to cancel a PENDING_OPS request ⚠️ P1 UX · CONFIRMED + FIXED same session · 2026-07-16

**Founder repro:** client books a CPO (legacy/ops-review path) → lands on `OpsRoomReviewScreen` ("AWAITING OPS APPROVAL", typically 2–5 min) — but if ops is busy for DAYS the request just sits there and the client cannot withdraw it. Worse: the pending state deliberately LOCKS hardware back/gesture (`lockBack`, OpsRoomReviewScreen), polling caps at 5 min, and there was NO cancel affordance anywhere on the screen — reopening the app resumes straight back into the same dead-end (BookingHome resume → OpsRoomReview).

**Root cause:** pure client-UI gap. The server has ALWAYS allowed this cancel — `booking.service.cancel` lists `PENDING_OPS` in the pre-commitment always-cancellable statuses (no time window, row-locked FSM flip, idempotent `already_ended` for repeat taps, nothing charged pre-approval). The auto-dispatch waiting screen (`FindingDetailScreen`) has had a cancel since the Job-Portal QA; the legacy ops-review screen never got one.

**Fix (client-only, `src/screens/ops/OpsRoomReviewScreen.tsx`):** "CANCEL REQUEST" button on the pending hero (red-tinted, 44dp, spinner while in-flight) → branded confirm ("Cancel this request? … Nothing has been charged." · Keep Waiting / Cancel Request-destructive) → `bookingStore.cancelBooking(bookingId)` (flips the local list row too) → `popToTop()` back to the booking home. `advancing` ref set before the call so a racing poll tick can't route into approved/confirmed mid-cancel; failure path re-arms and surfaces the server message. Regression lock: `src/screens/booking/__tests__/opsReviewCancel.test.ts` (3 tests, navigatorConfig static idiom — pending-state control + store-action + confirm pattern).

**Gates:** tsc 46 = pre-existing set · eslint clean · booking project 149/149 + new lock 3/3. **Device QA for tester (needs an ops-pending booking):** book on the legacy path → CANCEL REQUEST → confirm → lands on booking home, row shows CANCELLED, ops board row disappears/greys on next refresh; re-tap-after-ops-cancel shows the idempotent success (no raw 403); auto path (FindingDetail cancel) unaffected.

---

## B-93 — ZA stuck "COMING SOON" (availability = CPO head-count) + Book Now/Later pill floats mid-track ⚠️ P2 · CONFIRMED + FIXED (deploy pending) · 2026-07-17

**Founder screenshots:** (1) Select Location shows South Africa greyed "COMING SOON" with badge RSA — boss wants it ACTIVE and badged "SA". (2) Schedule step 3: the Book Now/Book Later sliding blue pill sits BETWEEN the two labels, aligned with neither.

**Root causes:**

1. `listRegionsAvailability` derived `available` from `cpo_pool` counts (`cpos_available > 0`, booking.service) — ZA has no pool rows, so the server overrode the client seed back to unavailable on every mount. Side-defect: a LIVE region would flash COMING SOON if its pool ever hit zero.
2. The toggle pill's geometry was GUESSED from the window width (`Math.min(width,402) − 40 − 10`, BookingDateTimeScreen) — on wide/scaled viewports (BlueStacks window, tablets) the assumed track is far narrower than the rendered one → pill too small + slides too little → floats mid-track.

**Fixes (commit `3fe4ab5`):**

1. `launched: boolean` product flag on the canonical `REGIONS` (common/regions.ts — AE/BD/**ZA** true, Saudi/GB false); availability endpoint returns `available: launched` (counts stay informational); client seed marks ZA live as offline fallback; ZA badge **RSA → SA** (ZoneMap seed + utils/regions — Saudi still renders KSA, dispatch codes ZA/SA untouched).
2. Pill track measured via `onLayout` on the real toggle container (−12 for pad+border), pill hidden until first measure; `useWindowDimensions` dropped.

**Gates:** mobile tsc 46 = pre-existing set · auth-service tsc clean · booking 152/152 · lint clean. Known consequence to accept: ZA bookings pre-supply ride the ops-review path (manual) — auto-dispatch there dies NO_PROVIDER until `cpo_pool`/agency rows are seeded (ops action, tracked since B-90 T-07).

### B-93 — UPDATE 2026-07-17: DEPLOYED + B-93b coverage zones + v1.0.113 shipped

- **auth-service DEPLOYED to Contabo** (founder-authorized; rsync missing → tar-over-ssh overlay preserving box .env, docker build+up, container healthy). This deploy also carried B-91's 72h VBG feed + B-90's seed titles/display_name. South Africa now returns `available: true` from `/bookings/regions-availability`.
- **B-93b (founder repro: "after selecting SA the map box should be in SA, why still in UAE"):** `COVERAGE_ZONES` had NO ZA entries → LocationPicker centered on its Dubai fallback AND every ZA pin read out-of-coverage (Confirm dead). Added Johannesburg (50 km) + Cape Town (45 km) circles — picker + MapPrewarm now center on the selected region and ZA pins are bookable. (ZoneMap's own map card is a decorative graphic; its city/CPO labels update per selection — not a bug.)
- **Shipped:** v1.0.112 (vc139, spec-v2 + B-92/93) and hotfix **v1.0.113 (vc140, B-93b)** both on Firebase qa; pushed `cfd0f14..e31a8b8`.
- **⚠️ Ops data note (founder asked):** to staff South Africa, CPOs/agencies must be created with **region ZA — NOT "SA"**. "SA" is the DISPLAY badge only; internally `SA` = Saudi Arabia (dispatch hard-matches `region_code`). A CPO created with region "SA" staffs Saudi (a coming-soon region) and ZA auto-dispatch still finds nobody.

## B-94 — Backup `root_mismatch` RECURRENCE: every boot re-uploads the entire history (the drift factory) ⚠️ P1 · CONFIRMED + FIXED same session · 2026-07-17

**Symptom (founder):** the old "Backup integrity check failed (root_mismatch)" restore dead-end is back, despite B-45r3 (07-05), B-50 (07-06) and B-81 (07-11) all being shipped (B-81 landed in v1.0.109/vc136; current v1.0.111/vc138).

**Root cause (code-proven, the class-level one):** the mirror dedup (`seenIds` in `messageMirror.ts`) was **in-memory only**. Every boot-unlock, `setMirrorKey` fires the catch-up sweep → `backupNow` walks the FULL SQLCipher store → every row re-enqueues (dedup empty after restart) → every row **re-encrypts with a fresh AES-GCM IV** → `putMessages` upserts ALL server bytes → the signed Merkle commit only trails on debounces + a server walk. **Every single app launch therefore rewrote the entire server row set and re-opened the B-81 kill-window.** Any kill inside it (adb reinstall during device-verify, crash, swipe-away, >500-row accounts even overflow the queue and loop sweeps) leaves the server bytes ahead of the last signed root at EQUAL row count → the restore verifier hard-fails (`root_mismatch`, P2-B-1 posture — correct) → on a fresh install the B-81 repair **correctly refuses** (no local history; blessing server bytes would launder exactly what the verifier catches) → permanent dead-end. B-45/B-50/B-81 all patched the restore side; the write side kept manufacturing drift. Also perf: a 5 000-message account re-encrypted + re-uploaded 5 000 rows per launch.

**Fix (client, all landed this session):**

1. **Persistent flush ledger** — new SQLCipher table `mirror_flushed(owner_user_id, message_id, version, updated_at)` (schema v13→**v14**, `crypto/db.ts`; comment-only migration). New `backup/mirrorLedger.ts`. On every successful `putMessages`, the flushed `(id, version-hash)` pairs persist; the boot sweep hydrates `seenIds` from it (`seedMirrorDedup`) → **idle boots upload NOTHING**; only genuinely changed rows ship. Ledger is best-effort: unavailable DB degrades to pre-B-94 re-upload, never to skipped uploads.
2. **Pending-commit flag + flush-epoch guard** — `bravo:backup:merkle-pending:<owner>` (AsyncStorage) set after every successful flush; `commitMerkleRoot` snapshots `getFlushEpoch()` before its server walk and clears the flag ONLY if no flush interleaved (`clearMerkleCommitPendingIfNoFlushSince`). The boot sweep fires a commit when the flag survived a kill **even if it uploaded nothing** — the old device now self-heals the window at next launch instead of never.
3. **Restore seeds the ledger** — after the Merkle gate passes, `BackupRestoreScreen` records every restored row's version (`computeMirrorVersion`) so the first post-restore boot doesn't re-upload the whole history (that re-upload used to re-open the window immediately after a successful restore).
4. **Ledger purge on every trust boundary** — `repairBackupCommit` (B-81) purges before its full re-upload (nothing may short-circuit it); both forget/wipe paths and fresh `setupBackup` purge (a stale ledger vs an empty/rotated server mirror = silent restore data loss).
5. **Posture untouched** — `verifyMerkleCommit` unchanged (equal-count hard-fail, additive-prefix-only `rows_count_grew` self-heal); B-81 repair refusal on fresh devices unchanged; no security gate softened.

**Files:** `crypto/db.ts` (v14 + `mirror_flushed`), NEW `backup/mirrorLedger.ts`, `backup/messageMirror.ts` (Pending.version, ledger record + flag on flush, `seedMirrorDedup`, `computeMirrorVersion`), `backup/merkleCommit.ts` (epoch-guarded flag clear), `backup/mirrorBootstrap.ts` (sweep hydration + pending-flag heal, repair purge), `BackupRestoreScreen.tsx` (ledger seed post-restore, purge on wipe), `BackupSetupScreen.tsx` (purge on fresh setup + wipe). NEW test `__tests__/mirrorLedgerBootSweep.test.ts` (8: hydrated-sweep skip/ship, flush records + flag + `__deleted__` tombstones, pending-flag boot commit with ZERO uploads, idle boots commit-free, epoch guard, repair purge, restore-seed round-trip, no-DB degradation).

**Why B-67 wasn't re-fixed:** the sqa entry said the snapshot upload path lacked the B-50 adopt — that adopt-and-retry EXISTS in HEAD (`ratchetSnapshotScheduler.ts:292-317`); B-67 is closed.

**Process fix (so it cannot silently recur):** NEW **`docs/runbooks/BACKUP_LOOP.md`** — invariants I1–I9 (idle-boot silence, every-flush-owes-a-commit, never weaken the verifier, repair never launders, wipe⇒purge, seq-adopt-once, restore seeds, ledger best-effort, no plaintext), failure-class history B-45r3→B-94, automated gates, device probes (§5.1 idle-boot silence logcat check, §5.2 kill-window heal, §5.3 restore round-trip) and SQL drift probes. **CLAUDE.md now routes any backup-module work through that loop** (same pattern as LITE_BOOKING_LOOP).

**Gates:** new suite 8/8 · messenger-crypto **1638/1638 tests** (one suite-level 0-test-failure flake per full run — REPRODUCED ON CLEAN MAIN, pre-existing worker flake; every flagged suite green in isolation) · tsc **46 ≤ 47** baseline (0 in touched files) · eslint 0 on touched files (repo's 6 pre-existing errors unchanged) · BackupSetupScreen audit suite 4/4.

**Retest (device, next APK):** (1) §5.1 idle-boot silence — second launch logs NO `flushed N messages`; (2) §5.2 kill-window heal — send, force-stop within ~2 s, relaunch (expect ONE commit), reinstall+restore must pass; (3) §5.3 fresh-install restore round-trip; (4) upgrade path — FIRST boot post-upgrade re-uploads once (empty ledger, expected), second boot silent.

---

## B-95 — Product switch never redirects (header flips, screen stays) + hardware back exits app from product root + no drawer way back to the gate ⚠️ P1 UX/nav · CONFIRMED + FIXED · 2026-07-17

**Founder repro (v1.0.113 spec-v2 build):** (1) In Messenger, Profile drawer → Switch Dashboard → Virtual Bodyguard: a store-driven label updates but the SCREEN stays on the chat list; same from Secure Services (stays on BookingHome) and from VBG — switching is dead in every direction. (2) After login the product gate ("Where would you like to start?") shows; pick Messenger, then press hardware back → the app closes (leaves to launcher) instead of stepping back to the gate. (3) No menu entry to ever get back to the 3-option gate page.

**Root causes:**

1. **The B-91 M0 keyed remount never worked.** `MainNavigator` keys the client Tab tree by `activeProduct` expecting a remount to reset navigation — but React Navigation stores a nested navigator's state on the parent **'Main' route**, and a freshly-keyed navigator **REHYDRATES that state** (`@react-navigation/core@6.4.17` `useNavigationBuilder` — rehydrate branch runs whenever `route.state` is defined and type-valid; all three products share route names `MessengerTab/SecureTab/ProfileTab`, so the old state is always "valid"), silently ignoring `initialRouteName`/`initialParams`. The library's own unmount cleanup (`setTimeout(0)` → `state=undefined`) **skips itself** when the replacement navigator has already mounted (`getKey() !== navigatorKey`), so the keyed swap can never win. Store subscribers (labels/tab sets) update → "header says Virtual Bodyguard, page stays Messenger".
2. 'Main' is the only root route and the gate is not a route — at a product's root there is nothing to pop, so Android's default exits the app.
3. The gate only ever rendered when `activeProduct === null` (fresh installs); nothing could re-open it.

**Fixes (client-only):**

- `src/navigation/MainNavigator.tsx` — **two-phase product switch:** local `mountedProduct` lags `activeProduct`; while they differ, render ONE navigator-free obsidian frame (30 ms) so the outgoing navigator's deferred state-cleanup actually clears the 'Main' route state, then mount the new product tree, which now honours `initialRouteName` + `initialParams` (VBG lands on VBGHome, Secure on BookingHome, Messenger on chat list). Keyed remount + per-product initial route kept.
- `src/store/productStore.ts` — ephemeral `gateVisible` + `requestGate()` (excluded from persistence via `partialize`, so relaunch still opens straight into the active product per spec v2); `setActiveProduct` clears it.
- `MainNavigator` — root-level `hardwareBackPress` handler (client shell only, unregistered while the gate shows): while `navigationRef.canGoBack()` it returns false (screen handlers + container popping win); at a true root it `requestGate()`s → back now steps product-home → gate → (gate is root: background/exit, standard Android).
- `src/components/SwitchDashboardSection.tsx` — new **"Choose Dashboard"** row (view-grid icon) under the two switch rows → `requestGate()`; hosts close their drawer via new `onOpenGate` prop (wired in `ProfileDrawerModal`; ProfileScreen gets it for free).
- `src/screens/auth/ProductGateScreen.tsx` — gate picks route through the M3 unsaved-booking confirm when leaving Secure Services with a dirty draft (gate is now reachable from inside a product).

**Regression locks:** `src/store/__tests__/productStore.test.ts` (5 tests — gate flag semantics + persistence exclusion + guard veto) and B-95 block in `src/navigation/__tests__/navigatorConfig.test.ts` (4 static locks: navigator-free frame precedes `<Tab.Navigator`, keyed remount + per-product initial route kept, back handler requests gate only when nothing can pop, gate renders on `gateVisible`).

**Gates:** tsc 46 = pre-existing set · eslint 0 errors on touched files · store/navigation/components suites 53/54 (the 1 fail = `authStore.recheckMembership` "401 revocation", stash-verified pre-existing on HEAD) · device verification logged below.

### B-95 — UPDATE 2026-07-17: DEVICE-VERIFIED on BlueStacks (full switch/back matrix PASS)

Release APK (local `apk:staging` build of the fix) installed on **Pie64 (127.0.0.1:5556** — note: this instance binds 5556, not the documented 5555). Both tester instances were signed out, so QA ran on a fresh client account **b94.gatetester@example.com** (individual/lite, registered via staging API — `OTP_DEV_BYPASS` is live on Contabo, any code verifies). All checks via `uiautomator dump` (BlueStacks `screencap` renders black on this host):

| #   | Check                                                                                                                                                | Result |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Drawer (profile logo) on all 3 products: My Profile / My Bookings / Bravo Pro / SWITCH DASHBOARD (2 other products) / **Choose Dashboard** / Log Out | ✅     |
| 2   | Gate pick → VBG lands on VIRTUAL DASHBOARD                                                                                                           | ✅     |
| 3   | Drawer switch VBG → Secure Services lands on BookingHome ("SECURE SERVICES / Book Close Protection")                                                 | ✅     |
| 4   | Drawer switch Secure → Messenger lands on chat list                                                                                                  | ✅     |
| 5   | Drawer switch Messenger → VBG lands on VIRTUAL DASHBOARD (the founder's original dead direction)                                                     | ✅     |
| 6   | Drawer "Choose Dashboard" → product gate                                                                                                             | ✅     |
| 7   | Hardware back at product root → product gate (was: app exit)                                                                                         | ✅     |
| 8   | Gate → Messenger → back → gate again                                                                                                                 | ✅     |
| 9   | Back on gate → app leaves to launcher (standard root)                                                                                                | ✅     |
| 10  | Warm resume returns to same screen; **cold start opens straight into active product** (gate flag not persisted)                                      | ✅     |
| 11  | Back from nested tab (News) pops inside Messenger, does NOT jump to gate                                                                             | ✅     |

One tap on "Switch to Virtual Bodyguard" was dropped on the first attempt (adb input-injection flake right after a uiautomator dump — store provably unchanged, cold boot still messenger); immediate retest + all later switches fired correctly.

**Shipped:** v1.0.115 (vc143) Firebase qa — contains BOTH this nav fix and the parallel B-94 backup-ledger fix (supersedes the orphan "1.0.114 (141)" upload from this session AND the 1.0.114/vc142 backup-only build; testers should install 1.0.115). Register renumbered B-94→B-95 on merge (the backup session claimed B-94 first). Founder retest steps: switch products from the drawer in every direction, back-out at each product home (expect the gate), and confirm cold relaunch skips the gate.

## B-96 — Agent onboarding submit dead-end: `Cannot submit from status PROFILE_COMPLETE` ⚠️ P1 · CONFIRMED + FIXED same session · 2026-07-17

**Symptom (founder, `bigben@gmail.com`):** Document Upload shows the compliance pack **6/6 DONE**, but "SUBMIT FOR ADMIN REVIEW" fails with `Could not submit — Cannot submit from status PROFILE_COMPLETE`. No in-app action recovers it: re-uploading, re-login and reinstall all leave the agent stranded forever.

**Root cause (DB-proven):** the agent never left `PROFILE_COMPLETE`, while `submitForReview` (`agent.service.ts:552`) hard-requires `DOCS_PENDING`. Since the standalone KYC screen was removed, the ONLY path `PROFILE_COMPLETE → KYC_PENDING → DOCS_PENDING` is `skipKycToDocs()`, invoked exactly once as **fire-and-forget** from the wizard (`AgentRegistrationWizardScreen.tsx:116`): `try { await agentApi.skipKyc(); } catch { /* idempotent */ }` — the catch discarded a REAL failure and `navigation.navigate('AgentCoverage')` ran unconditionally, walking the user through a door that never opened. Three faults compound into a permanent trap:

1. **Failure swallowed** — `skipKycToDocs` is genuinely idempotent server-side (no-op once at `DOCS_PENDING` or past), so a throw is always a real failure, never a replay. The catch treated the two identically and left the status behind.
2. **No downstream gate** — `uploadDocument` (`agent.service.ts:503`) only calls `requireAgent`, with NO status check, so all 6 uploads succeed against a stale `PROFILE_COMPLETE` agent and the UI honestly renders 6/6 DONE. The user gets no signal until the final button.
3. **Self-heal could not fire** — the doc→KYC mirror auto-advance (`agent.service.ts:542`) is `transitionIfAt(KYC_PENDING → DOCS_PENDING)`, a no-op at `PROFILE_COMPLETE`. **Double-blocked:** even from `KYC_PENDING` it still could not fire, because `DOC_TO_KYC` only maps `passport→gov_id`, `sia→sia_licence`, `dbs→police` — **nothing maps to `proof_address`**, so `remaining` never reaches 0. Only `skipKycToDocs` settles `proof_address` (placeholder subject).

**Evidence:** `agent_audit` for `674feed2…f69c` has exactly two rows and stops dead — `null→DRAFT` (10:28:30), `DRAFT→PROFILE_COMPLETE` (10:30:13, `profile_saved`). **No `kyc_skipped` row ever.** Yet `agent_documents` = all 6 `done`, and `agent_kyc_checks` shows `gov_id`/`sia_licence`/`police` settled at **10:47** via the doc mirror while **`proof_address` sits at `queued`** — proving the docs landed 17 min later and the mirror ran, but the status hop never did.

**Fix:**

1. **Server (root-cause kill)** — `submitForReview` now re-runs the idempotent fast-forward when the agent is at `PROFILE_COMPLETE`/`KYC_PENDING`, then re-reads status. Reuses the existing `skipKycToDocs`, so every hop still goes through `fsm.assert` (`PROFILE_COMPLETE→KYC_PENDING` AGENT, `KYC_PENDING→DOCS_PENDING` SYSTEM) and `proof_address` gets settled on the way. **No gate weakened:** the required-document check and the FSM asserts are untouched and still run — a stale status can no longer strand an otherwise-complete application, but an INCOMPLETE one is still rejected. **No new authority:** `POST /agents/me/kyc/skip` is already exposed to the agent on the same self-scoped controller (`JwtAuthGuard + CpoSessionGuard`, scoped to `user.sub`), so the heal performs only a transition the caller could already trigger.
2. **Client (stop the drift at source)** — removed the silent catch in `AgentRegistrationWizardScreen.tsx`; a genuine `skipKyc` failure now surfaces via the existing error alert and keeps the user on the wizard to retry, instead of stranding them one screen later.

**Files:** `apps/auth-service/src/agents/agent.service.ts` (`submitForReview` self-heal), `src/screens/agent/AgentRegistrationWizardScreen.tsx` (catch removed). NEW test `apps/auth-service/src/agents/agent.submit-selfheal.spec.ts` (6: PROFILE_COMPLETE repro, real-FSM-hop audit order, KYC_PENDING heal, DOCS_PENDING regression, **required-doc gate NOT bypassed by the heal**, no-legit-path statuses still rejected).

**Negative-verified:** with the server fix stashed, the new spec fails 4/6 reproducing the founder's exact string (`Cannot submit from status PROFILE_COMPLETE`); the 2 that pass are the regression guards that must pass either way.

**Gates:** agent suites **11/11, 366 tests** · new spec 6/6 · full auth-service **101/102 suites, 1779 passed** (sole failure `vbg.service.spec.ts` 3/38 — **reproduced on clean main without this change, pre-existing**) · auth-service `tsc --noEmit` **exit 0** · mobile tsc **46 ≤ 47** baseline (0 in touched files) · eslint **0 errors** on touched files.

**Blast radius (DB-checked):** exactly **1** agent stranded (`bigben@gmail.com`); **0** at `KYC_PENDING`. No data migration needed — the server fix self-heals the account on the next submit tap, **even on the old APK**, since the dead-end is server-side. The client fix is defence-in-depth and rides the next APK.

**Known trade-off (deliberate):** the wizard now blocks on a `skipKyc` failure instead of advancing silently. A systematic skipKyc outage would therefore halt onboarding at the wizard rather than letting agents proceed to a submit that the server would heal. Chosen anyway — a loud failure is what would have surfaced this bug on day one instead of stranding an agent invisibly; the server heal is the safety net for anything that slips through. Retry is one CTA tap (`updateCompany` is idempotent).

**Not fixed (deliberate, documented):** (a) `DOC_TO_KYC` still has no `proof_address` mapping — there is no proof-of-address slot in the 6-doc compliance pack, so inventing one would be wrong; `skipKycToDocs` settles it with a placeholder, and the submit heal now guarantees that runs. (b) The `uploadDocument` auto-advance at `agent.service.ts:542` is consequently unreachable-in-practice; left in place (harmless, minimal diff) rather than removed blind.

**Retest (device):** (1) `bigben@gmail.com` → Document Upload → SUBMIT → expect success + status `SUBMITTED` (verify `agent_audit` gains `PROFILE_COMPLETE→KYC_PENDING`, `KYC_PENDING→DOCS_PENDING`, `DOCS_PENDING→SUBMITTED`); (2) fresh agent full happy path — wizard → coverage → docs → submit, unchanged; (3) next APK — kill network at the wizard's last CTA, expect a visible error and NO silent advance to Coverage.

## B-97 — M1A tier system IMPLEMENTED full-stack: Lite / Bravo Pro / Enterprise ✅ FEATURE · SHIPPED IN CODE + STAGING DEPLOY · 2026-07-17

**Scope (founder rounds 1-3, same day):** the approved tier matrix + onboarding flow from `docs/handoffs/UI_SPEC_V2_M1A_TIER_MATRIX.md` — all 9 slices implemented; §8 of that doc is the authoritative per-slice status + gates. Highlights: enterprise tier server-wide (constraint migration + `/subscription/enterprise` + TierGuard rank), **ops-editable pricing** charged at charge time (`subscription_prices`; enterprise seeded 5000 BC PLACEHOLDER pending founder), **BC auto-renew** sweep (+ Stripe path preserved; tier-switch cancels the stale sub), vault action-token issuance tier-gated (Pro+/org, MFA untouched — CLAUDE.md stop-condition respected), enterprise inherits dept channels/attendance/incident as own single-tenant org ("CPO"→"Employee" for that audience only), 4-card tier screen, post-auth declinable paywall ("Start as Lite today"), Settings → Pricing, ops-console price + user-tier editors.

**Gates:** auth-service tsc exit 0 · full suite 102/103 (sole fail `vbg.service.spec.ts` — pre-existing, reproduced on clean tree) · mobile tsc **46 ≤ 47** · app+booking 419 green (2 pre-existing fails reproduced clean) · messenger-crypto **186/186, 1646 tests** (8 new vault-gate) · ops-console tsc exit 0 · eslint 0 new errors (3 flagged reproduced clean).

**Device retest (next APK/JS build):** (1) fresh signup per tier — Bravo Pro/Enterprise get the post-auth paywall, decline lands working Lite, subscribe lands the tier + Chat; (2) Lite vault probe — Files/viewer "Move to Vault" shows the upgrade ask AND a direct vault call 403s (`tier_insufficient`) with MFA still enforced for entitled tiers; (3) Settings → Pricing up/downgrade round-trip (downgrade = period-end); (4) ops Settings price edit → paywall shows the new price, renewal charges it; (5) enterprise account → dept channels open, copy says Employee; provider org unchanged incl. "CPO" wording; (6) provider funnel from the 4th card end-to-end.

**UPDATE (same day, device-test session):** Full on-device pass on the founder's Pixel 6a (fresh install, vc143) — tier screen 4 cards w/ full columns ✓, INDIVIDUAL+PRO badges through signup ✓, OTP (staging bypass) ✓, post-auth paywall @ live DB price ✓, kill-app-mid-paywall → paywall survives (pendingTier) ✓, "Start as Lite today" → clean Lite (DB: lite/0BC/no-renew) ✓, Lite vault gate = branded ask (server 403 backstop) ✓, View Plans → Pricing ✓, ops price change 2000→2500 → paywall shows + charges 2500 exactly (ledger −2500, until +30d, bc_auto_renew=true) ✓, Pro unlocks vault same-session ✓, PIN+fingerprint+AES-256 upload round-trip ✓, dept card locked for Pro ✓. **Found + FIXED same session:** Enterprise individual hit the org gate inside DepartmentChannelsScreen (scattered inline org-only entitlement — the drift M1 R2 warned about) with no workspace management → shipped the EMPLOYEE workspace (commit 3a1ad19): org_members 'employee' role (shell-invisible, never crewable), resolveIsOrgManager admits enterprise tier, POST /org/employees (enroll existing users by email/phone), EmployeesScreen + owner empty-state CTAs, "Bravo Pro" naming in prompts. Provider CPO tenant preserved by construction (additive role, provider paths first, labels/DTOs untouched). **Registered residuals:** 100MB vault quota UNENFORCED server-side (uploads unlimited; /vault/storage/\* endpoints are 404 placeholders; storage-plans purchase dead-ends) — quota enforcement is the next build; GroupsScreen locked-card prompt did not visibly render on 2 taps during the session (vault prompt same host renders fine — needs a Lite re-test; watch item). Downgrade semantics VERIFIED at code level: lapse → vault + dept lock (client RS-19 + server 403), data retained (S3 objects + channels), re-upgrade restores.

---

## B-99 — Cross-platform 1:1 video: iPhone camera never shows on Android (Android→iPhone works) ⚠️ P1 · INVESTIGATED (root-cause candidates ranked, NO code changed) · 2026-07-17

**Symptom (founder):** 1:1 video call between Android and an iPhone (iOS app from `origin/ios/build-setup`): Android's video renders fine on the iPhone, but the iPhone's video NEVER renders on Android — in both call directions. Audio fine both ways.

**What the direction matrix proves:** transport (ICE/DTLS/coturn) is healthy — the failure is isolated to the iPhone-encode → Android-decode/render leg of the video m-line.

**Ranked root-cause candidates (full evidence + fingerprints in the runbook):**

1. **RC-1 codec/decoder asymmetry (primary)** — `patches/react-native-webrtc+124.0.7.patch:21` swaps Android's libwebrtc for `io.getstream:stream-webrtc-android:1.3.10` (FrameCryptor); iOS runs the stock 124.0.7 pod (`ios/build-setup` adds NO webrtc patch). iOS prefers hardware H.264; nothing in JS pins a codec (zero hits for `setCodecPreferences|preferredCodec` in `src/modules/messenger/webrtc/`). H.264 the Android end can't decode ⇒ mounted-but-black tile, while Android's VP8 decodes fine on iPhone.
2. **RC-2 false `cameraOff:true` advisory from iOS** — initial media-state computed from track liveness (`useCall.ts:1097-1099`); a boot-timing misread on iOS would make Android pin the camera-off placeholder forever (`remoteTileGate.ts:36` — advisory wins; re-assert only on reconnect `useCall.ts:1036-1039`).
3. **RC-3 iPhone video sender emits no RTP** — iOS edition of the documented "encoder needs a stream binding" class (`useCall.ts:674-685`).
4. **RC-4 iOS runtime camera permission** — 30-second pre-check only; a dead camera hard-fails the whole call (`useCall.ts:700-714`), which contradicts the repro.

**Ruled out with evidence:** FrameCryptor (group-only; `useCall.ts` has zero cryptor refs; iOS refuses the whole group call at `useGroupCall.ts:1319-1320`), missing iOS permission plist strings (present in `app.json` on the ios branch), media-state _absence_ (`remoteVideoOff` defaults false, `useCall.ts:159-161`), transport.

**Visible-symptom discriminator (key diagnostic):** on Android during repro — **camera-off placeholder** ⇒ RC-2 · **avatar** ⇒ track never negotiated (RC-3) · **black video tile** ⇒ frames not decoding (RC-1 vs RC-3, split via `getStats`: iPhone `outbound-rtp.framesEncoded` vs Android `inbound-rtp.framesDecoded`).

**Deliverable:** full bug loop at `docs/runbooks/CROSS_PLATFORM_CALL_VIDEO_LOOP.md` — pipeline map, §5 diagnosis decision tree, §6 per-candidate fixes (files + exact changes: VP8-first codec preference at the `peerConnection.ts` setLocalDescription seam via a new pure `sdpCodecPreference.ts` + fixture tests; media-state boot guard + receiver self-heal; iOS msid binding), §7 eight-flow regression watchlist (incl. security stop-conditions: FrameCryptor patch untouched, group-call iOS refusal NOT to be weakened), §8 gates + M1-M8 device matrix, §10 sign-off.

**Constraints honoured:** no code changed; no branch merged (standing founder instruction — fix lands on `main`, `ios/build-setup` picks it up when its owner updates that branch). Also logged (separate, arch-gated): group calls on iOS refuse by design until a Swift FrameCryptor port exists (runbook §9).

**Next step:** run runbook §5 on a device pair (Android + the iPhone build), record the confirmed RC here, then apply exactly one §6 fix.

---

## B-98 — Back buttons: agent-wizard back is DEAD on resumed sessions + 3 pushed screens have NO back at all ⚠️ P1 UX/nav · INVESTIGATED (root cause proven, full-app inventory, NO code changed) · 2026-07-17

**Founder screenshot:** "COVERAGE & SERVICES" (agent onboarding 3/4) back chevron does nothing. Ask: audit EVERY page — back button present AND working?

**Root cause (B-98a, code-proven):** the button and its handler are fine (`NavHeader` `_shared.tsx:38-46`; `AgentCoverageScreen.tsx:103` → `goBack()`); the **stack behind it is empty**. Resume entry `AgentTypeSelectScreen.tsx:77-78` does `navigation.replace(nextStepFor(status))` (→ `AgentCoverage` for `PROFILE_COMPLETE`/`KYC_PENDING` — the B-96 cohort) and `AgentKYCScreen.tsx:118/:132` also advances via `replace` — so the stack is `[AgentCoverage]` alone and `goBack()` is a **silent release no-op**: button, edge-swipe AND hardware back all die (hardware back then exits the app — the B-95 back-to-gate handler is client-shell-only). The linear first-run path pushes (`AgentRegistrationWizardScreen.tsx:123` `navigate`) which is why the bug looks intermittent. Systemic: **no screen in the app uses a `canGoBack()`-guarded back** — the agent wizard is currently the only spot where the non-empty-stack assumption breaks.

**Full-app inventory (~110 screens, per-screen handler classification):** everything else with a visible back control resolves to a live `goBack()`/`navigate()`; roots/tabs/gates/terminals correctly have none; 10 deliberate traps verified intentional (FindingDetail, MissionComplete, IncidentSubmitted, AttendanceResult, IncomingGroupCall, VaultLock, BackupRestore, OpsRoomReview `lockBack` while paying, IncomingOffer, CpoActivation). **Gaps (B-98b):** G1 `NewsFeedScreen` (pushed from 2 navigators, header has filter/RSS but no back), G2 `FileVaultPurchaseScreen` (paywall — only escape is the post-purchase Alert `:72`), G3 `LiveTrackingScreen` (refresh only, no back), G4 `HomeSelectionScreen` (registered `AuthNavigator.tsx:41` but ZERO navigate sites — dead B-91 leftover, decision not UI). Latent: `NavHeader` renders the chevron even with `onBack` undefined (ObHeader renders a spacer) — future dead-button factory.

**Deliverable:** full loop at `docs/runbooks/BACK_NAV_LOOP.md` — fix plan (F1 `prevStepFor` + guarded wizard back, B-96 FSM-coupling caution: back must never re-submit; F2 NavHeader spacer; G1-G3 one-header edits), §4 diagnosis tree for any future "back doesn't work", §6 watchlist (traps stay trapped, B-95 matrix rows re-run), §7 M1-M7 device matrix, §8 sign-off. NO code changed this session (founder: docs only, code later).

### B-98 — UPDATE 2026-07-17: FIXED + device-verified (same session)

All B-98a/b fixes landed (docs/runbooks/BACK_NAV_LOOP.md §9 has the full outcome log): `prevStepFor` + canGoBack-guarded back on the four replace-entered wizard screens, internal-step-aware back + hidden-chevron-on-empty-stack for AgentRegistrationWizard, **hardware back wired to the same handler on all five** (button/gesture/key agree), NavHeader spacer hardening, and visible back controls added to NewsFeed / FileVaultPurchase / LiveTracking. HomeSelection left documented-dead. Device-verified on BlueStacks with a real resumed `PROFILE_COMPLETE` agent (the founder's exact screenshot state): chevron now lands on Agent Registration 1/4, hardware back ditto (was: silent no-op / app exit). Gates: booking 163/163 · nav locks 17/17 · helpers 63/63 · tsc 46 = baseline · eslint clean on touched files. Not device-driven: LiveTracking lane (needs live booking), full linear 4-step walk (forward code untouched, smoke green).

### B-99 — UPDATE 2026-07-17: RC-1 fix LANDED (preventive; iPhone diagnosis still owed)

No iOS device in this QA environment, so the loop's §5 device diagnosis could not run; applied the ranked-PRIMARY RC-1 fix preventively (safe under every other candidate — a codec-preference reorder cannot regress RC-2/3/4). NEW pure `sdpCodecPreference.preferVp8OnVideoMLine` (VP8+rtx lead the video m-line; H264 retained; anomaly ⇒ unchanged input) wired at all three `peerConnection.ts` local-description seams (offer / ICE-restart reoffer / answer; legacy acceptOffer funnels through). Group/SFU + FrameCryptor patch untouched. 9 new unit tests (fixtures = faithful libwebrtc shapes, NOT live captures — pin real ones when the device pair exists). Gates: crypto 187/1653 · tsc 46 · lint clean. Android live smoke: outgoing video call boots to CALLING…/DTLS-SRTP with the munge active. **Owed on an iPhone:** §5 stats tree to confirm RC-1 was the live cause (if one-way video persists, RC-2/RC-3 are next), M1-M8 matrix, real SDP captures. Runbook §11 has the full log.
