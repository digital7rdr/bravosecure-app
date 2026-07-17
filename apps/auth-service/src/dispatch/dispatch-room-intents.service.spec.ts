import {DispatchRoomIntentsService} from './dispatch-room-intents.service';
import type {DatabaseService} from '../database/database.service';

function mk() {
  const db = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValue(null)};
  const svc = new DispatchRoomIntentsService(db as unknown as DatabaseService);
  return {svc, db};
}

describe('DispatchRoomIntentsService', () => {
  it('enqueueRoomIntent inserts the full row scoped to the agency org', async () => {
    const {svc, db} = mk();
    await svc.enqueueRoomIntent('org-A', 'b1', 'conv-1', 'cpo-1', 'add', 'mgr-1');
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO public\.dispatch_room_intents/),
      ['org-A', 'b1', 'conv-1', 'cpo-1', 'add', 'mgr-1'],
    );
  });

  it('listRoomIntents returns only the caller-org pending intents (scope fused into SQL)', async () => {
    const {svc, db} = mk();
    db.q.mockResolvedValue([{id: 'i1', booking_id: 'b1', conversation_id: 'conv-1', member_user_id: 'cpo-1', action: 'add', created_at: 't'}]);
    const rows = await svc.listRoomIntents('org-A');
    expect(rows).toHaveLength(1);
    expect(db.q).toHaveBeenCalledWith(
      // The service SQL aliases the intents table (i.*) since the booking join landed.
      expect.stringMatching(/WHERE i\.org_user_id = \$1 AND i\.state = 'pending'[\s\S]*ORDER BY i\.created_at ASC/),
      ['org-A'],
    );
  });

  it('ackRoomIntent acks via the conditional UPDATE (exactly-once + org-scope fused)', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValue({id: 'i1'});
    const r = await svc.ackRoomIntent('org-A', 'i1');
    expect(r).toEqual({ok: true});
    expect(db.qOne).toHaveBeenCalledWith(
      expect.stringMatching(/SET state = 'done'[\s\S]*WHERE id = \$1 AND state = 'pending' AND org_user_id = \$2[\s\S]*RETURNING id/),
      ['i1', 'org-A'],
    );
  });

  it('ackRoomIntent 404s when 0 rows match — second ack OR cross-org IDOR (ambiguous)', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValue(null); // already done, unknown id, or wrong org
    await expect(svc.ackRoomIntent('org-OTHER', 'i1')).rejects.toThrow('intent_not_found_or_not_org');
  });
});
