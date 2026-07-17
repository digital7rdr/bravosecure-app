/**
 * B-31 — boot-time selection for draining an undrained group envelope stash.
 *
 * A group text that arrives before its master key is durably stashed
 * (`pendingGroupEnvelopes`) and rendered fail-closed (the `no_key` / `tamper`
 * branch in productionRuntime). That stash is normally drained by the admin
 * create/rekey post-txn `drain-group` request. But once that admin envelope is
 * ACKed off the relay it is never redelivered — so a stash row left undrained
 * across a restart has nothing to re-trigger it. The key is on disk and the
 * message IS decryptable, yet it never renders.
 *
 * The boot key-restore path now re-runs the EXISTING per-row drain
 * (`drainPendingGroup` → `replayGroupSealedDecode`) for every group whose
 * master key we just restored into memory. This helper is that selection — and
 * the fail-closed gate:
 *
 *   - Scenario A (the fix): the key is on disk → the group carries a
 *     `masterKeyB64` after the merge → selected → drained → the stashed message
 *     renders.
 *   - Scenario B (UNCHANGED, fail-closed): the member never persisted / lost
 *     the key → no `masterKeyB64` → NOT selected → the row stays stashed behind
 *     its banner. Re-seeding a truly-lost key is an owner-side resync — a
 *     group-master-key-distribution change, a CLAUDE.md stop-condition decided
 *     fail-closed (sqa.md B-26(a) 2026-06-11, B-13 2026-06-09). This helper
 *     MUST NOT request or distribute keys; it only filters by what is already
 *     on this device.
 */

/** Group ids whose master key is already on this device (Scenario A only). */
export function selectGroupIdsToDrain(
  groups: Record<string, {masterKeyB64?: string}>,
): string[] {
  return Object.entries(groups)
    .filter(([, gs]) => !!gs.masterKeyB64)
    .map(([gid]) => gid);
}
