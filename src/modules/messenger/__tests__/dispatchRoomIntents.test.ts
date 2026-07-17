/**
 * Drain logic for dispatch Ops-Room membership intents → E2EE rekey actions
 * (Step 12). Verifies the security-critical mapping (add → addGroupMember+rekey on
 * deviceId 1, remove → removeGroupMember+rekey), the ack-only-on-success rule, and
 * that rooms with no provisioned group are skipped. Mirrors membershipIntents.test.ts.
 */
import {drainDispatchRoomIntents} from '../orgWorkspace/dispatchRoomIntents';

const mockApi = {
  listRoomIntents: jest.fn(),
  ackRoomIntent: jest.fn(),
};
const mockRuntime = {
  addGroupMember: jest.fn(),
  removeGroupMember: jest.fn(),
  ensureAssignedGroup: jest.fn(),
};

jest.mock('@services/api', () => ({
  dispatchApi: {
    listRoomIntents: (...a: unknown[]) => mockApi.listRoomIntents(...a),
    ackRoomIntent: (...a: unknown[]) => mockApi.ackRoomIntent(...a),
  },
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: async () => mockRuntime,
}));

describe('drainDispatchRoomIntents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.ackRoomIntent.mockResolvedValue({ok: true});
    mockRuntime.addGroupMember.mockResolvedValue({newEpoch: 2});
    mockRuntime.removeGroupMember.mockResolvedValue({newEpoch: 2});
    mockRuntime.ensureAssignedGroup.mockResolvedValue({groupId: 'g1', alreadyExisted: false});
  });

  it('does nothing when there are no intents', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: []}});
    const r = await drainDispatchRoomIntents();
    expect(r).toEqual({processed: 0, skipped: 0, failed: 0});
    expect(mockRuntime.addGroupMember).not.toHaveBeenCalled();
  });

  it('maps add → addGroupMember on deviceId 1 and acks only after success', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(mockRuntime.addGroupMember).toHaveBeenCalledWith({groupId: 'g1', newMember: {userId: 'cpo-2', deviceId: 1}});
    expect(mockApi.ackRoomIntent).toHaveBeenCalledWith('i1');
    expect(r.processed).toBe(1);
  });

  it('maps remove → removeGroupMember (rekey on the post-remove set)', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i2', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-9', action: 'remove', created_at: 't'},
    ]}});
    await drainDispatchRoomIntents();
    expect(mockRuntime.removeGroupMember).toHaveBeenCalledWith({groupId: 'g1', removedUserId: 'cpo-9'});
  });

  it('skips intents for rooms with no provisioned group (nothing to rekey yet)', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i3', booking_id: 'b1', conversation_id: null, member_user_id: 'cpo-3', action: 'add', created_at: 't'},
    ]}});
    const r = await drainDispatchRoomIntents();
    expect(r.skipped).toBe(1);
    expect(mockRuntime.addGroupMember).not.toHaveBeenCalled();
    expect(mockApi.ackRoomIntent).not.toHaveBeenCalled();
  });

  it('MISSION-GROUP — bootstraps the Ops Room group ONCE per room (client as initial member) before the CPO adds', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'MISSION X · OPS ROOM'},
      {id: 'i2', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-3', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'MISSION X · OPS ROOM'},
    ]}});
    const r = await drainDispatchRoomIntents();
    // The server-assigned room is bootstrapped exactly once (not per-intent),
    // with the client as the initial non-agency member — this is what mints the
    // group master key locally so the CPO add-intents stop looping `pending`.
    expect(mockRuntime.ensureAssignedGroup).toHaveBeenCalledTimes(1);
    expect(mockRuntime.ensureAssignedGroup).toHaveBeenCalledWith({
      groupId: 'g1', name: 'MISSION X · OPS ROOM', members: ['client-1'],
    });
    // Both CPO adds still applied + acked after the bootstrap.
    expect(mockRuntime.addGroupMember).toHaveBeenCalledTimes(2);
    expect(r.processed).toBe(2);
  });

  it('MISSION-GROUP — a transient bootstrap failure does not abort the drain', async () => {
    mockRuntime.ensureAssignedGroup.mockRejectedValueOnce(new Error('offline'));
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i1', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-2', action: 'add', created_at: 't', client_id: 'client-1', conversation_title: 'T'},
    ]}});
    const r = await drainDispatchRoomIntents();
    // Bootstrap threw but the add still ran (addGroupMember is independently
    // idempotent/retry-safe); the drain didn't crash.
    expect(mockRuntime.addGroupMember).toHaveBeenCalledTimes(1);
    expect(r).toBeDefined();
  });

  it('does NOT ack when the rekey throws — leaves the intent for retry (at-least-once)', async () => {
    mockApi.listRoomIntents.mockResolvedValue({data: {intents: [
      {id: 'i4', booking_id: 'b1', conversation_id: 'g1', member_user_id: 'cpo-9', action: 'add', created_at: 't'},
    ]}});
    mockRuntime.addGroupMember.mockRejectedValueOnce(new Error('group not bootstrapped'));
    const r = await drainDispatchRoomIntents();
    expect(r.failed).toBe(1);
    expect(mockApi.ackRoomIntent).not.toHaveBeenCalled();
  });
});
