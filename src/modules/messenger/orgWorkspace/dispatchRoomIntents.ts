/**
 * Auto-dispatch Ops Room — membership-intent drain (agency device).
 *
 * SECURITY (E2EE stop-condition): the server holds NO group key, so it cannot
 * rekey on its own. When an agency assigns/removes a CPO to a booking's Ops Room,
 * the server records a metadata change + a pending intent. THIS function — run on
 * the agency's device (the room creator/admin that holds the group key) — drains
 * those intents and performs the sanctioned, rekeying runtime actions:
 *   - add    → runtime.addGroupMember     (wraps planAddAndRekey)
 *   - remove → runtime.removeGroupMember  (wraps planRemoveAndRekey)
 * then acks the intent so it isn't replayed. Until this runs, a removed CPO still
 * holds the old master key — so drain it promptly (on agency dashboard focus).
 *
 * The runtime methods already enforce admin authorisation, the per-group lock, and
 * the remove-then-rekey ordering; this layer only sequences intents and maps
 * add/remove → the right call. It never touches key material. Mirrors
 * orgWorkspace/membershipIntents.ts (department channels) scoped to booking rooms.
 */
import {dispatchApi} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';

export interface DrainResult {
  processed: number;
  skipped: number;   // intents for not-yet-provisioned rooms
  failed: number;
}

export async function drainDispatchRoomIntents(): Promise<DrainResult> {
  const result: DrainResult = {processed: 0, skipped: 0, failed: 0};

  const {data} = await dispatchApi.listRoomIntents();
  if (!data.intents.length) {return result;}

  const runtime = await getMessengerRuntime('production');

  // BOOTSTRAP PASS (MISSION-GROUP area 5) — the Ops Room conversation id is
  // minted server-side, so the group master key is NEVER created by the normal
  // createGroupChat path. Until this device (the agency that owns each room)
  // holds local GroupState, addGroupMember throws "unknown group" and every CPO
  // add-intent loops `pending` forever. Bootstrap each distinct room ONCE here
  // (with the client as the initial non-agency member) before applying the
  // adds. ensureAssignedGroup is idempotent — a no-op if the group already
  // exists locally, so re-running every drain is safe and never re-keys.
  if (runtime.ensureAssignedGroup) {
    const bootstrapped = new Set<string>();
    for (const intent of data.intents) {
      if (!intent.conversation_id || bootstrapped.has(intent.conversation_id)) {continue;}
      bootstrapped.add(intent.conversation_id);
      try {
        await runtime.ensureAssignedGroup({
          groupId: intent.conversation_id,
          name:    intent.conversation_title ?? 'Mission Ops Room',
          members: intent.client_id ? [intent.client_id] : [],
        });
      } catch {
        // Transient bootstrap failure — leave the intents pending; the next
        // drain retries. Not counted as a per-intent failure here.
      }
    }
  }

  for (const intent of data.intents) {
    // A room whose Signal group hasn't been bootstrapped on this device yet has no
    // epoch to rekey — leave the intent pending; it'll apply once the group exists.
    if (!intent.conversation_id) {
      result.skipped++;
      continue;
    }
    try {
      if (intent.action === 'remove') {
        if (!runtime.removeGroupMember) {result.skipped++; continue;}
        await runtime.removeGroupMember({
          groupId: intent.conversation_id,
          removedUserId: intent.member_user_id,
        });
      } else {
        if (!runtime.addGroupMember) {result.skipped++; continue;}
        // Phase-1 peers live on signal deviceId=1 (multi-device lands later).
        await runtime.addGroupMember({
          groupId: intent.conversation_id,
          newMember: {userId: intent.member_user_id, deviceId: 1},
        });
      }
      // Only ack AFTER the rekey broadcast succeeded — a failed rekey leaves the
      // intent pending so the next drain retries it (at-least-once).
      await dispatchApi.ackRoomIntent(intent.id);
      result.processed++;
    } catch {
      // addGroupMember/removeGroupMember are safe to retry — a member already
      // in/out of the group throws and we leave the intent pending. Never ack on failure.
      result.failed++;
    }
  }
  return result;
}
