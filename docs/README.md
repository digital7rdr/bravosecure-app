# Bravo Secure — Documentation Index

Project docs live under `docs/`. A few agent- and onboarding-critical files stay at the repo root.

## At repo root (intentional)

| File                      | Purpose                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| [README.md](../README.md) | Onboarding, quick start, repo overview                            |
| [CLAUDE.md](../CLAUDE.md) | Agent rules, security constraints, build commands (authoritative) |
| [AGENTS.md](../AGENTS.md) | Cursor / agent MCP workflow                                       |
| [GEMINI.md](../GEMINI.md) | Gemini agent MCP workflow                                         |
| [sqa.md](../sqa.md)       | Running QA reference, bug log, device identities                  |

## Start here

| Doc                                                                                              | When to read                                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [CODEBASE_MAP.md](CODEBASE_MAP.md)                                                               | First session — surfaces, modules, “go here for X”                                        |
| [architecture/SIGNAL_PROTOCOL_IMPLEMENTATION.md](architecture/SIGNAL_PROTOCOL_IMPLEMENTATION.md) | Signal Protocol step-by-step + 18-section coverage scorecard + verified broken-parts list |
| [architecture/MESSENGER_BACKEND.md](architecture/MESSENGER_BACKEND.md)                           | Crypto, relay, WS gateway deep dive                                                       |
| [architecture/ARCHITECTURE_COMPLIANCE.md](architecture/ARCHITECTURE_COMPLIANCE.md)               | Spec vs implementation (security contract)                                                |
| [qa/QA_PER_BUILD_CHECKLIST.md](qa/QA_PER_BUILD_CHECKLIST.md)                                     | Per-build smoke checklist                                                                 |
| [planning/REMAINING_TODO.md](planning/REMAINING_TODO.md)                                         | Open milestones and deferrals                                                             |

## Directory map

```
docs/
├── CODEBASE_MAP.md          Entry-point hunting tree
├── architecture/            Security, system design, compliance
├── audits/                  Security and feature audits
├── qa/                      Checklists, case studies, bug analysis
├── handoffs/                Developer handoff notes (B-##)
├── planning/                Roadmaps, WBS, deploy plans, costs
├── runbooks/                Ops procedures (migration, key rotation, payments)
├── client-briefs/           Product / client-facing briefs
├── development/             Auth testing flows, fonts, dev notes
├── legal/                   Privacy and onboarding copy
└── openapi/                 Auth + messenger OpenAPI specs
```

## Architecture & compliance

- [architecture/SIGNAL_PROTOCOL_IMPLEMENTATION.md](architecture/SIGNAL_PROTOCOL_IMPLEMENTATION.md) — Signal Protocol implementation map (built/partial/not-built + broken findings)
- [architecture/MESSENGER_BACKEND.md](architecture/MESSENGER_BACKEND.md)
- [architecture/ARCHITECTURE_COMPLIANCE.md](architecture/ARCHITECTURE_COMPLIANCE.md)
- [architecture/AUTH_COMPLIANCE.md](architecture/AUTH_COMPLIANCE.md)
- [architecture/MESSENGER_SPEC_COVERAGE.md](architecture/MESSENGER_SPEC_COVERAGE.md)
- [architecture/FRONTEND.md](architecture/FRONTEND.md)
- [architecture/ARCHITECTURE_AMENDMENT_SFRAME.md](architecture/ARCHITECTURE_AMENDMENT_SFRAME.md)
- [architecture/monorepo-db-schema-setup.md](architecture/monorepo-db-schema-setup.md)

## Audits

- [audits/BACKEND_AUDIT.md](audits/BACKEND_AUDIT.md)
- [audits/BACKUP_RESTORE_AUDIT.md](audits/BACKUP_RESTORE_AUDIT.md)
- [audits/CREDITS_BC_AUDIT.md](audits/CREDITS_BC_AUDIT.md) — Bravo Credits top-up/deduction/manage/add + BC-representation audit (2026-07-05)
- [audits/MESSENGER_AUDIT.md](audits/MESSENGER_AUDIT.md) — full messenger stack vs the 349-test plan + notification pipeline + smoothness audit (2026-07-06)
- [audits/BACKUP_RESTORE_AUDIT_ROUND2.md](audits/BACKUP_RESTORE_AUDIT_ROUND2.md)
- [audits/MESSAGING_AUDIT.md](audits/MESSAGING_AUDIT.md)
- [audits/MESSENGER_AUDIT_FIXES.md](audits/MESSENGER_AUDIT_FIXES.md)
- [audits/WEBAPP_DATA_COVERAGE_AUDIT_2026-07-07.md](audits/WEBAPP_DATA_COVERAGE_AUDIT_2026-07-07.md) — full webapp vs all 91 DB tables: data-coverage matrix, RLS/retention findings, industry-standard benchmark (2026-07-07)

## QA & testing

- [qa/QA_PER_BUILD_CHECKLIST.md](qa/QA_PER_BUILD_CHECKLIST.md)
- [qa/QA_RETEST_GUIDE.md](qa/QA_RETEST_GUIDE.md)
- [qa/SQA_BRAVO_LITE_TEST_FLOW.md](qa/SQA_BRAVO_LITE_TEST_FLOW.md)
- [qa/analysis.md](qa/analysis.md) — bug resolution analysis (companion to `sqa.md`)
- [qa/CASE_STUDY_recurring_bugs.md](qa/CASE_STUDY_recurring_bugs.md)
- [qa/CASE_STUDY_frontend_bugs.md](qa/CASE_STUDY_frontend_bugs.md)
- [qa/BUG_FIX_PLAYBOOK.md](qa/BUG_FIX_PLAYBOOK.md)
- [qa/BUGFIX_v1046_NOTES.md](qa/BUGFIX_v1046_NOTES.md)
- [qa/BUGFIX_v1048_v1049_NOTES.md](qa/BUGFIX_v1048_v1049_NOTES.md)

## Developer handoffs

- [handoffs/B-17_GROUP_TILE_RENDER_RACE_HANDOFF.md](handoffs/B-17_GROUP_TILE_RENDER_RACE_HANDOFF.md)
- [handoffs/B-20_B-21_CAMERA_RESTORE_RING_HANDOFF.md](handoffs/B-20_B-21_CAMERA_RESTORE_RING_HANDOFF.md)
- [handoffs/B-25_RESUME_HANDOFF.md](handoffs/B-25_RESUME_HANDOFF.md)
- [handoffs/B-32_CALL_FOREGROUND_SERVICE_HANDOFF.md](handoffs/B-32_CALL_FOREGROUND_SERVICE_HANDOFF.md)

## Planning & ops

- [planning/DEPLOY_PLAN.md](planning/DEPLOY_PLAN.md)
- [planning/WBS.md](planning/WBS.md)
- [planning/REMAINING_TODO.md](planning/REMAINING_TODO.md)
- [planning/RECURRING_COSTS.md](planning/RECURRING_COSTS.md)
- [planning/MESSENGER_ROADMAP.md](planning/MESSENGER_ROADMAP.md)
- [planning/BRAVO_LITE_PROGRESS.md](planning/BRAVO_LITE_PROGRESS.md)

## Runbooks

- [runbooks/CONTABO_MIGRATION_GUIDE.md](runbooks/CONTABO_MIGRATION_GUIDE.md)
- [runbooks/KEY_ROTATION_RUNBOOK.md](runbooks/KEY_ROTATION_RUNBOOK.md)
- [runbooks/BOOKING_TO_PAYMENT.md](runbooks/BOOKING_TO_PAYMENT.md)
- [runbooks/LITE_BOOKING_LOOP.md](runbooks/LITE_BOOKING_LOOP.md) — run when touching Lite booking
- [runbooks/BACKUP_LOOP.md](runbooks/BACKUP_LOOP.md) — run when touching messenger backup (root_mismatch invariants)

## Client briefs

- [client-briefs/MESSENGER_CLIENT_BRIEF.md](client-briefs/MESSENGER_CLIENT_BRIEF.md)
- [client-briefs/FAMILY_HIERARCHY_CLIENT_BRIEF.md](client-briefs/FAMILY_HIERARCHY_CLIENT_BRIEF.md)
- [client-briefs/VIRTUAL_BODYGUARD_CLIENT_BRIEF.md](client-briefs/VIRTUAL_BODYGUARD_CLIENT_BRIEF.md)

## Development

- [development/AUTH_TESTING.md](development/AUTH_TESTING.md)
- [development/FONTS.md](development/FONTS.md)

## Legal & API specs

- [legal/](legal/)
- [openapi/](openapi/)
