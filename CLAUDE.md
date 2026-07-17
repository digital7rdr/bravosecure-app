<!-- SQA context pointer -->

## QA / Bug / Testing tasks → read `sqa.md` FIRST

**For any QA, bug-investigation, ADB-logcat, or device-testing task, read `sqa.md`
at the repo root before doing anything else.** It is the running SQA reference and
bug log, and it is NOT auto-loaded into context. It contains:

- The full bug log (B-01 … B-17) with status, root cause, log evidence, and files involved.
- The **Device & Identity Reference** (BlueStacks serial ↔ account ↔ Signal userId) and group IDs.
- ADB setup/log-capture commands, the Frontend/Backend breakdown, and per-session timelines.

When you log a new bug or finding during a session, append it to `sqa.md` (keep the
summary table and bug numbering consistent). The tester is an SQA engineer who finds and
documents bugs and does NOT implement fixes unless explicitly asked.

---

## Lite CPO booking module → run `docs/runbooks/LITE_BOOKING_LOOP.md`

**Whenever you work on the Lite (auto-dispatch) CPO booking module — client booking screens,
agency/service dispatch, CPO mission, escrow/payout, or booking notifications — read and run
[`docs/runbooks/LITE_BOOKING_LOOP.md`](docs/runbooks/LITE_BOOKING_LOOP.md) as part of the
task.** It is the module-specific verification loop (a companion to the root `LOOP.md`) that
proves the whole flow is workable across all three actors before you call a change done:

- **Client:** book → cancel while waiting → resume/navigate freely → notification at every step →
  team (verify) code shows → money deducted accurately.
- **Agency (service):** receive offer → assign CPO → monitor mission → smooth top-up / payout.
- **CPO:** receive assigned job → run live mission → real-time GPS → mission control (pickup/go-live/complete).

Run it at the **start** (baseline) and **after** any change (regression), including its
automated gates, SQL/data probes, notification matrix, and the B-82 regression watchlist. The
trigger-file list is at the top of that doc. Do not mark a Lite-booking change complete until
its §7 sign-off criteria hold (or you state which lane you could not exercise and why).

---

## Messenger backup / restore / Merkle → run `docs/runbooks/BACKUP_LOOP.md`

**Whenever you work on the messenger backup module — the mirror pipeline, Merkle
commits/verification, restore/repair flows, ratchet snapshots, backup screens, or
`apps/messenger-service/src/backup/**` — read and run
[`docs/runbooks/BACKUP_LOOP.md`](docs/runbooks/BACKUP_LOOP.md) as part of the task.**
The `root_mismatch` restore dead-end shipped FIVE times (B-45r3, B-50, B-67, B-81, B-94)
because each fix patched a symptom while the write side kept manufacturing drift; that
runbook is the contract that keeps the class dead:

- The **§2 invariants** (I1–I9): idle boots upload nothing (persistent `mirror_flushed`
  ledger), every flush owes a commit (pending flag + flush-epoch guard), the verifier is
  never weakened, repair never launders, server wipes purge the ledger, seq 409s adopt
  once — check every one against your diff.
- The **§4 automated gates** (backup/merkle Jest suites first, then the full crypto
  project) and the **§5 device/data probes** (idle-boot silence check, kill-window heal,
  fresh-install restore round-trip, SQL drift probes).
- New `root_mismatch` sighting? §3 first: ask "what wrote server bytes without a covering
  commit?" — do NOT soften `verifyMerkleCommit` (CLAUDE.md security stop-condition).

Do not mark a backup change complete until its §6 sign-off criteria hold (or you state
which check you could not exercise and why).

---

## UI / Design / frontend tasks → read `DESIGN_REVIEW_LOOP.md` FIRST

**For any task that changes, adds, or reviews a screen, component, layout, interaction,
visual style, colour/theme, or user flow, read `DESIGN_REVIEW_LOOP.md` at the repo root
before doing anything else.** It is the running design-review operating procedure and is
NOT auto-loaded. It defines:

- The iterate-until-clean loop (analyze → design → audit → improve → re-audit → stress-test).
- The **mandatory audit categories** (UX, responsive, safe-area/platform, accessibility,
  states, performance) and the **device/breakpoint matrix** (320→430dp, foldables, tablets,
  fontScale ≥ 1.3, real test devices).
- The **quality gates** (incl. G8 = **no design-system deviation**: the app surface is
  **obsidian** `#07090D` / cobalt `#5B8DEF`; any screen still on the legacy Command-Navy
  palette is a Major to migrate — everything must be consistent).
- How to run it under ultracode (fan-out auditors via the Workflow tool, adversarial verify,
  then fix) and the per-iteration deliverable format + scores.

Design review composes WITH (does not replace) `LOOP.md` — still verify, audit, and risk-review.

---

## Project Instructions

Always read LOOP.md first.

LOOP.md defines your operating procedure.

Every task must follow LOOP.md.

Load these skills before starting:

- skills/android.md
- skills/supabase.md
- skills/ssh.md
- skills/deployment.md
- skills/notification.md

Never skip verification.

Never skip audit.

Never stop after implementation.

## Documentation layout

Most project docs live under **`docs/`** — see [`docs/README.md`](docs/README.md) for the full index.

| Location               | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| Repo root              | `README.md`, `CLAUDE.md`, `AGENTS.md`, `sqa.md` (agent + QA entry points)      |
| `docs/CODEBASE_MAP.md` | Codebase hunting tree (surfaces, modules, file index)                          |
| `docs/architecture/`   | Security, compliance, messenger backend design                                 |
| `docs/audits/`         | Audit reports                                                                  |
| `docs/qa/`             | Checklists, case studies, `analysis.md`                                        |
| `docs/handoffs/`       | Per-bug developer handoff notes                                                |
| `docs/planning/`       | Roadmaps, deploy plan, `REMAINING_TODO.md`                                     |
| `docs/runbooks/`       | Ops procedures — incl. `LITE_BOOKING_LOOP.md` (run when touching Lite booking) |
| `docs/openapi/`        | API specs                                                                      |

---

<!-- code-review-graph MCP tools -->

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool                        | Use when                                               |
| --------------------------- | ------------------------------------------------------ |
| `detect_changes`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context`        | Need source snippets for review — token-efficient      |
| `get_impact_radius`         | Understanding blast radius of a change                 |
| `get_affected_flows`        | Finding which execution paths are impacted             |
| `query_graph`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview` | Understanding high-level codebase structure            |
| `refactor_tool`             | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

---

# Claude Project Context — Bravo Secure

Claude is the primary AI assistant for Bravo Secure and should be treated as the main source of project knowledge. Claude has end-to-end context of the architecture, codebase patterns, business rules, and implementation details across mobile, ops-console, and the backend services.

## Claude responsibilities

- Claude has full context of the project and should be used for most implementation, refactoring, debugging, and documentation tasks.
- Claude is the default assistant for both the React Native mobile client and the Next.js ops console, as well as the NestJS backend services.
- Claude should handle all tasks except those that are explicitly security-sensitive or restricted by the System Architecture Documentation.
- For security-related decisions (encryption, key handling, message routing, access control, sensitive data flows), Claude must refer to the **System Architecture Documentation** as the source of truth and follow the documented constraints exactly.

## Technology stack

- **Mobile (primary stack):** React Native 0.81 + Expo SDK 54, TypeScript 5.9, React 19, Zustand, React Navigation 6, `react-native-webrtc`, `react-native-callkeep`, `@op-engineering/op-sqlite` (with SQLCipher), `@privacyresearch/libsignal-protocol-typescript`, `@react-native-firebase/*`, `react-native-keychain`.
- **Ops Console (secondary stack):** Next.js 15 (App Router), React 19, TypeScript 5.7, SWR, Tailwind, `idb`, `socket.io-client`, `mapbox-gl`, `@privacyresearch/libsignal-protocol-typescript`.
- **Backend services:** NestJS (Node 18+, TypeScript). Two services live under `apps/`:
  - `apps/auth-service` — auth, ops endpoints (`/ops/*`), agents, bookings, missions, payouts, signal-keys.
  - `apps/messenger-service` — relay (HTTP) + WS gateway, sender-cert issuance, sealed-sender envelopes, group messaging, file vault.
- **Shared package:** `packages/messenger-core` — platform-agnostic libsignal wrapper, sealed-sender v2, group crypto, transport protocol types. Mobile is the source of truth; ops-console consumes via `@bravo/messenger-core`. Path aliases (no npm workspaces).
- **Persistence:** Postgres (auth-service), SQLCipher (mobile local), IndexedDB + AES-GCM (ops-console vault), Redis (messenger-service WS adapter).
- **Tooling:** Jest (split projects: `app`, `messenger-crypto`, `booking`), ESLint, Prettier, Husky, `patch-package`, EAS Build, GitHub Actions.

## Security constraints

The screenshot from the System Architecture Documentation is the contract. Do not deviate from it.

- **Do not invent security behavior.** If a behavior isn't documented, ask before implementing.
- **Encryption (locked, do not change without architecture approval):**
  - Signal Protocol via libsignal-typescript — Double Ratchet for message body encryption, X3DH for key agreement, Sealed Sender v2 for metadata protection.
  - Local message store: SQLCipher-encrypted SQLite. Message keys are derived per-session and stored separately from message ciphertext.
  - Media attachments: AES-256-CBC, unique key per file, encrypted locally before upload to S3-compatible storage. Key shipped in-band inside the encrypted message envelope.
  - WebRTC voice/video: PeerConnection established via the signalling service. ICE candidates exchanged over WebSocket. Media encrypted via DTLS-SRTP.
  - Disappearing messages: client-side timer; deletion instruction is also sent to the server to purge the relay cache.
- **Backing service (`messenger-service`) constraints — do not violate:**
  - The relay only transports messages. It stores messages **transiently** until the recipient device fetches. Maximum dwell time: **30 days** (Signal protocol default).
  - Group messaging is via sealed-sender broadcast. Group state (membership, admin list) is encrypted with the group master key and shared via pairwise Signal sessions. The relay does not see group plaintext.
  - The WebSocket gateway handles presence (online/offline dots), typing indicators, and read-receipt fan-out. None of these carry message content.
  - **File Vault MFA:** the files-service enforces a fresh biometric / TOTP challenge before returning download URLs, regardless of valid JWT. Do not bypass this gate.
- **Stop conditions — verify against the architecture reference before proceeding when a change could affect:**
  - Encryption primitives (algorithm, mode, key length, IV/nonce handling)
  - Sealed-sender envelope shape, sender-cert verification, or AAD binding
  - Group master key distribution, rekey on member removal, or epoch handling
  - Auth tokens (JWT, refresh, sender certs), session storage, biometric/TOTP gates
  - Relay dwell semantics, ack/retract tokens, or envelope ID handling
  - File vault MFA gate or any download URL issuance flow
- **Never log plaintext message bodies, decrypted media, key material, or ArrayBuffers that contain key bytes.** A static log-audit test (`packages/messenger-core/__tests__/logAudit.test.ts` and the legacy mobile test) enforces this — do not bypass it by renaming variables.
- **Never weaken transitions:** if a check exists (e.g. `verifySenderCert`, `verifySealedAad`, biometric gate), do not add a "skip in dev" branch unless the architecture doc allows it.

## Build, run, and test commands

All commands are run from the repo root unless noted otherwise.

### Mobile (React Native + Expo)

- Install dependencies: `npm install`
- Run dev server (Metro): `npm start` (or `npm run start:staging`)
- Run on Android: `npm run android` (or `npm run android:staging`)
- Run on iOS: `npm run ios`
- Build release APK (staging): `npm run apk:staging`
- Build release APK (local backend): `npm run apk:local`
- EAS staging build: `npm run eas:build:staging`
- EAS production-style local build: `npm run eas:build:local`

### Ops Console (Next.js)

- Install: `cd apps/ops-console && npm install`
- Dev server: `cd apps/ops-console && npm run dev` (port 3002)
- Production build: `cd apps/ops-console && npm run build`
- Production start: `cd apps/ops-console && npm start`
- Lint: `cd apps/ops-console && npm run lint`
- Typecheck: `cd apps/ops-console && npm run typecheck`

### Backend services

- `apps/auth-service` and `apps/messenger-service` each have their own `package.json` with `npm run start:dev`, `npm run build`, `npm test`. Run them from inside the respective directory.

### Tests

- All tests: `npm test`
- Crypto tests only (fastest signal): `npm run test:crypto`
- Booking flow tests: `npm test -- --selectProjects=booking`
- Changed-only since main: `npm run test:changed`
- Coverage: `npm run test:coverage`
- Mutation tests on crypto (slow): `npm run mutation:crypto`
- Flake-detect crypto suite: `npm run flake:crypto`

### Quality gates

- Typecheck (mobile): `npm run typecheck` — must NOT exceed the baseline error count in `.tsc-baseline.json` (currently **47**). Use `npm run tsc:rebaseline` only when intentionally lowering the count.
- Lint: `npm run lint` (or `npm run lint:fix`)
- Dead code: `npm run deadcode` (knip)
- Audit: `npm run audit:high`
- SBOM: `npm run sbom`
- Bundle size: `npm run size`
- Local CI bundle (fast): `npm run ci:local`
- Full CI bundle: `npm run ci:full`

## Style rules

- **Module system:** ES modules + TypeScript. `import`/`export` only — no `require()` except in legacy patch-package shims.
- **Indentation:** 2 spaces. No tabs.
- **Quotes:** single quotes for strings, double quotes only inside JSX attributes.
- **Naming:**
  - Files: `camelCase.ts` for modules, `PascalCase.tsx` for React components, `kebab-case.sql` for migrations.
  - Functions/variables: `camelCase`. Types/interfaces/classes: `PascalCase`. Constants that are truly immutable global config: `SCREAMING_SNAKE_CASE`.
- **Folder structure:**
  - Mobile UI lives under `src/screens/`, `src/components/`, `src/navigation/`. Stores under `src/store/`. Cross-cutting modules under `src/modules/<domain>/`.
  - Ops Console follows Next.js App Router conventions under `apps/ops-console/src/app/`. Shared lib under `apps/ops-console/src/lib/`.
  - Shared platform-agnostic crypto under `packages/messenger-core/src/`.
- **Imports:** prefer the established path aliases — `@/`, `@screens`, `@components`, `@modules`, `@bravo/messenger-core`. Avoid `../../../` ladders.
- **Comments:** default to writing none. Add a short `// Why:` line only when the reasoning is non-obvious (a workaround, a hidden invariant, a security-relevant decision). Never narrate what the code does.
- **Small, focused changes:** prefer minimal diffs. Don't refactor or rename when the task is a bug fix.
- **Reuse before abstracting:** check for an existing helper, hook, or pattern before introducing a new one.

## Change safety rules

Every change must clear these gates before being considered complete:

1. **Direct test:** the new behavior is exercised by at least one new or modified test.
2. **Regression test:** the most closely related existing flow is re-run (e.g. for a sealed-sender change, run `npm run test:crypto`; for a booking change, run the `booking` Jest project).
3. **Typecheck:** `npm run typecheck` (mobile) and `cd apps/ops-console && npm run typecheck` — neither may exceed its baseline.
4. **Targeted first, broad second:** run the narrow suite first to fail fast, then the wider suite (`npm test`) before declaring done.
5. **No behavior change without a test failing first:** when refactoring, the existing tests must still pass; when fixing a bug, write the failing test first whenever practical.
6. **Verify nearby flows:** for example, a change to `productionRuntime.ts` requires re-running the messenger-crypto suite AND a manual smoke (boot app, send + receive a 1:1, send + receive a group message).
7. **Do not commit on a red gate.** Pre-push hooks enforce typecheck-baseline; do not skip with `--no-verify`.

## UI / feature verification

For UI or frontend changes, type-checking and unit tests verify code correctness, not feature correctness. If you changed a screen or interaction:

- Boot the dev server and exercise the feature.
- Test the golden path AND at least one error path (e.g. offline, denied permission, cancelled flow).
- Check for regressions in adjacent screens (e.g. a change to `LiveTrackingScreen` should not break `DashboardScreen`).
- If the UI cannot be tested in the current environment (e.g. native modules require a device), say so explicitly rather than claiming success.

## Working rule

**When unsure, inspect the codebase first.** Read the established pattern, the architecture documentation, the security reference. Don't guess. The MCP code-review-graph (top of this file) is the fastest way to find the right pattern.

If a task touches anything in the **Security constraints** section above, stop and verify against the System Architecture Documentation before writing code.
