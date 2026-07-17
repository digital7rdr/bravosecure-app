import {OrgMissionService} from './org-mission.service';
import type {DatabaseService} from '../database/database.service';
import type {SystemMessengerService} from '../ops/system-messenger.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {DispatchRoomIntentsService} from '../dispatch/dispatch-room-intents.service';
import {ForbiddenException} from '@nestjs/common';

const ORG = 'org-A';
const MGR = 'mgr-1';

function mk(opts: {
  booking?: Record<string, unknown> | null;
  members?: Array<{member_user_id: string; call_sign: string | null; agent_status: string | null}>;
  busy?: Array<{agent_id: string}>;
  armed?: Array<{cpo_user_id: string}>;
  crewInsertThrows?: boolean;
  resume?: Record<string, unknown> | null;
  resumeCrew?: Array<{agent_id: string; is_lead?: boolean}>;
}) {
  const txQ = jest.fn().mockImplementation((sql: string) => {
    if (/FROM org_members/.test(sql)) return Promise.resolve(opts.members ?? []);
    if (/FROM mission_crew mc/.test(sql)) return Promise.resolve(opts.busy ?? []);
    if (/FROM armed_authorizations/.test(sql)) return Promise.resolve(opts.armed ?? []);
    if (/INSERT INTO mission_crew/.test(sql)) {
      if (opts.crewInsertThrows) return Promise.reject(new Error('duplicate key value violates unique constraint "mission_crew_agent_active_uq" (23505)'));
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  const txQOne = jest.fn().mockImplementation((sql: string) => {
    if (/UPDATE lite_bookings\s+SET status = 'CONFIRMED'/.test(sql)) return Promise.resolve(opts.booking ?? null);
    if (/INSERT INTO missions/.test(sql)) return Promise.resolve({id: 'm1'});
    return Promise.resolve(null);
  });
  const tx = {q: txQ, qOne: txQOne};
  const db = {
    q: jest.fn().mockImplementation((sql: string) =>
      /SELECT agent_id, is_lead FROM mission_crew/.test(sql) ? Promise.resolve(opts.resumeCrew ?? []) : Promise.resolve([])),
    qOne: jest.fn().mockResolvedValue(opts.resume ?? null), // resume lookup (post-commit recovery)
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  const systemMsg = {createMissionOpsRoom: jest.fn().mockResolvedValue({conversation_id: 'conv-1', created: true})} as unknown as SystemMessengerService;
  const bookingPush = {missionDispatched: jest.fn(), crewAssigned: jest.fn()} as unknown as BookingPushBridge;
  const roomIntents = {enqueueRoomIntent: jest.fn().mockResolvedValue(undefined)} as unknown as DispatchRoomIntentsService;
  const config = {get: jest.fn().mockReturnValue(20)} as never;
  const svc = new OrgMissionService(db, systemMsg, bookingPush, roomIntents, config);
  return {svc, db, tx, txQ, txQOne, systemMsg, bookingPush, roomIntents};
}

const OK_BOOKING = {
  id: 'b1', cpo_count: 2, armed_required: false, requirements: {}, region_code: 'AE',
  client_id: 'c1', conversation_id: null, assigned_provider_user_id: ORG,
};
const TWO_MEMBERS = [
  {member_user_id: 'cpo-1', call_sign: 'A1', agent_status: 'ACTIVE'},
  {member_user_id: 'cpo-2', call_sign: 'A2', agent_status: 'APPROVED'},
];

describe('OrgMissionService.assignCrew', () => {
  it('creates one mission + crew (lead is_lead), opens the agency room, enqueues intents, pushes', async () => {
    const {svc, txQ, systemMsg, roomIntents, bookingPush} = mk({booking: OK_BOOKING, members: TWO_MEMBERS});
    const res = await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'});
    expect(res).toEqual({ok: true, mission_id: 'm1', short_code: expect.stringMatching(/^MSN-/), crew: 2, lead_user_id: 'cpo-2'});
    // lead seeded first (slot 0, role LEAD, is_lead true)
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_crew/), ['m1', 'cpo-2', 0, 'LEAD', 'A2', true, false]);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_crew/), ['m1', 'cpo-1', 1, 'CP', 'A1', false, false]);
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO mission_waypoints/), expect.arrayContaining(['m1']));
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO agent_deployment_checks/), expect.arrayContaining(['cpo-1', 'dress', 'm1']));
    // E2EE: AGENCY is the room creator, CPOs are NOT metadata members (rekeyed in via intents)
    expect(systemMsg.createMissionOpsRoom).toHaveBeenCalledWith(expect.objectContaining({creator_user_id: ORG, ops_admin_user_id: ORG, crew_user_ids: []}));
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledTimes(2);
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledWith(ORG, 'b1', 'conv-1', 'cpo-1', 'add', MGR);
    expect(bookingPush.missionDispatched).toHaveBeenCalledTimes(2);
  });

  it('rejects lead not in crew (400) before any DB work', async () => {
    const {svc, txQOne} = mk({booking: OK_BOOKING});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-9'}))
      .rejects.toThrow('lead_not_in_crew');
    expect(txQOne).not.toHaveBeenCalled();
  });

  it('409 booking_not_assignable when the tenant/state gate matches 0 rows (cross-org / already crewed)', async () => {
    const {svc} = mk({booking: null});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('booking_not_assignable');
  });

  it('409 crew_count_mismatch when ids.length != cpo_count', async () => {
    const {svc} = mk({booking: {...OK_BOOKING, cpo_count: 3}, members: TWO_MEMBERS});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('crew_count_mismatch');
  });

  it('400 cpo_not_in_org when a CPO is not an active member of this org', async () => {
    const {svc} = mk({booking: OK_BOOKING, members: [TWO_MEMBERS[0]]}); // only 1 of 2 active
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('cpo_not_in_org');
  });

  it('409 cpo_busy when a CPO is already on a non-terminal mission', async () => {
    const {svc} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, busy: [{agent_id: 'cpo-1'}]});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('cpo_busy');
  });

  it('409 cpo_busy when the crew INSERT races the agent-active unique index (23505)', async () => {
    const {svc} = mk({booking: OK_BOOKING, members: TWO_MEMBERS, crewInsertThrows: true});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('cpo_busy');
  });

  it('409 requirement_unmet_armed when an armed booking has an unauthorized CPO', async () => {
    const {svc} = mk({booking: {...OK_BOOKING, armed_required: true}, members: TWO_MEMBERS, armed: [{cpo_user_id: 'cpo-1'}]});
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('requirement_unmet_armed');
  });

  it('RESUMES the Ops Room + intents when a prior assign crashed post-commit (mission exists, no room)', async () => {
    const {svc, systemMsg, roomIntents} = mk({
      booking: null, // fresh gate 0 rows — the mission already exists
      resume: {mission_id: 'm1', short_code: 'MSN-XYZ', client_id: 'c1', assigned_provider_user_id: ORG},
      resumeCrew: [{agent_id: 'cpo-1', is_lead: true}, {agent_id: 'cpo-2', is_lead: false}],
    });
    const res = await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'});
    expect(res).toEqual({ok: true, mission_id: 'm1', short_code: 'MSN-XYZ', crew: 2, lead_user_id: 'cpo-1'});
    // re-drives the room + (idempotent) intents for the EXISTING crew — no 409.
    expect(systemMsg.createMissionOpsRoom).toHaveBeenCalledWith(expect.objectContaining({creator_user_id: ORG}));
    expect(roomIntents.enqueueRoomIntent).toHaveBeenCalledTimes(2);
  });

  it('LM-B5: a double-confirm with the SAME crew+lead is idempotent (200, existing mission)', async () => {
    const {svc} = mk({
      booking: null,
      resume: {mission_id: 'm1', short_code: 'MSN-XYZ', client_id: 'c1', assigned_provider_user_id: ORG},
      resumeCrew: [{agent_id: 'cpo-2', is_lead: true}, {agent_id: 'cpo-1', is_lead: false}],
    });
    const res = await svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-2'});
    expect(res.mission_id).toBe('m1');
  });

  it('LM-B5: a confirm with a DIFFERENT crew 409s crew_already_assigned', async () => {
    const {svc} = mk({
      booking: null,
      resume: {mission_id: 'm1', short_code: 'MSN-XYZ', client_id: 'c1', assigned_provider_user_id: ORG},
      resumeCrew: [{agent_id: 'cpo-1', is_lead: true}, {agent_id: 'cpo-3', is_lead: false}],
    });
    await expect(svc.assignCrew(ORG, MGR, 'b1', {cpo_user_ids: ['cpo-1', 'cpo-2'], lead_user_id: 'cpo-1'}))
      .rejects.toThrow('crew_already_assigned');
  });
});

describe('OrgMissionService.listMissions', () => {
  it('groups rows into needs_crew / active / recent', async () => {
    const rows = [
      {booking_id: 'b1', booking_status: 'CONFIRMED', mission_id: null, mission_status: null, crew: []},
      {booking_id: 'b2', booking_status: 'CONFIRMED', mission_id: 'm2', mission_status: 'LIVE', crew: []},
      {booking_id: 'b3', booking_status: 'COMPLETED', mission_id: 'm3', mission_status: 'COMPLETED', crew: []},
    ];
    const db = {q: jest.fn().mockResolvedValue(rows)} as unknown as DatabaseService;
    const svc = new OrgMissionService(db, {} as never, {} as never, {} as never, {get: () => 20} as never);
    const out = await svc.listMissions(ORG);
    expect(out.needs_crew.map(r => r.booking_id)).toEqual(['b1']);
    expect(out.active.map(r => r.booking_id)).toEqual(['b2']);
    expect(out.recent.map(r => r.booking_id)).toEqual(['b3']);
  });
});

describe('OrgMissionService.getMissionEscrow (SP-MISSION-DETAIL · IDOR)', () => {
  it('returns the agency escrow view (payout + status, no client refund leg) when the org owns the booking', async () => {
    const {svc, db} = mk({resume: {status: 'HELD', basis: null, currency: 'AED', gross_credits: 800, to_provider_credits: 700, platform_fee_credits: 100}});
    const res = await svc.getMissionEscrow(ORG, 'b1');
    expect(res).toMatchObject({status: 'HELD', to_provider_credits: 700, platform_fee_credits: 100});
    expect(res).not.toHaveProperty('to_client_credits');
    const sql = (db.qOne as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(/assigned_provider_user_id = \$2/);
  });

  it('throws ForbiddenException when the booking is not the caller org', async () => {
    const {svc} = mk({resume: null}); // no escrow row AND ownership check misses
    await expect(svc.getMissionEscrow(ORG, 'b-foreign')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
