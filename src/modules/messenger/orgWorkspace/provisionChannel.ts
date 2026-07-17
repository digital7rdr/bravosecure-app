/**
 * Department-channel E2EE provisioning — shared, idempotent helper.
 *
 * A department channel is just metadata until an admin device bootstraps its
 * Signal group (group_conversation_id). This function does exactly that, REUSING
 * the existing crypto primitives unchanged — `runtime.createGroupChat`
 * (makeNewGroup + signed `create` fan-out) + `departmentApi.registerGroup`
 * (first-writer-wins). The group master key NEVER reaches the server; only the
 * conversation id is registered.
 *
 * Why this exists (audit D1-a/f/g, D3-c): provisioning used to be an inline
 * side-effect of tapping a channel, which (a) only ran on the channel list, (b)
 * swallowed errors into a permanent silent "not yet active", and (c) had no path
 * from the create flow. Centralising it lets BOTH the create flow (eager) and the
 * first-open fallback share one tested, honest path.
 *
 * Idempotent: returns the canonical id immediately if already provisioned.
 */
import {departmentApi} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';

export type ProvisionResult =
  | {status: 'ok'; groupConversationId: string}
  | {status: 'already'; groupConversationId: string}
  | {status: 'needs_members'} // can't form a group with only the org account yet
  | {status: 'failed'; message: string};

export async function ensureChannelProvisioned(
  channelId: string,
  channelName: string,
  currentGroupId: string | null | undefined,
): Promise<ProvisionResult> {
  if (currentGroupId) {
    return {status: 'already', groupConversationId: currentGroupId};
  }
  try {
    const {data} = await departmentApi.listMembers(channelId);
    // createGroupChat dedups + strips the caller, then throws if no OTHER member
    // remains — which is exactly the empty-default-channel case (D3-c).
    const memberIds = data.members.map(m => m.user_id).filter(Boolean);
    const rt = await getMessengerRuntime('production');
    // D1-d — allowZeroDelivered: provision (register a STABLE group id) even if no member could
    // be reached yet (they have no Signal keys). Without this, a 0-delivered create threw BEFORE
    // registerGroup ran, so the channel re-forged a fresh master key on every open. Members are
    // keyed in later via add-intents / self-heal. (The "no other member at all" case still throws
    // → surfaced as needs_members below.)
    const {conversationId} = await rt.createGroupChat({name: channelName, members: memberIds, allowZeroDelivered: true});
    await departmentApi.registerGroup(channelId, conversationId);
    // First-writer-wins: a racing admin may already have registered a different
    // group id. Re-fetch the CANONICAL id and adopt it so we never navigate into
    // a fork only we can see.
    let groupConversationId = conversationId;
    try {
      const {data: fresh} = await departmentApi.listChannels();
      groupConversationId =
        fresh.channels.find(c => c.id === channelId)?.group_conversation_id ?? conversationId;
    } catch {
      /* keep our freshly-minted id on a transient refetch failure */
    }
    return {status: 'ok', groupConversationId};
  } catch (e) {
    const message = (e as Error)?.message ?? '';
    // The "no other member" throw is an expected state, not a failure: the admin
    // just needs to add a CPO first. Surface it distinctly so the UI can guide,
    // instead of a silent permanent "not yet active".
    if (/at least one other member/i.test(message)) {
      return {status: 'needs_members'};
    }
    return {status: 'failed', message: message || 'Could not set up channel encryption.'};
  }
}
