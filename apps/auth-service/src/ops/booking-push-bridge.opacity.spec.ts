import {BookingPushBridge} from './booking-push-bridge.service';
import type {RedisService} from '../redis/redis.service';
import type {NotificationsService} from '../notifications/notifications.service';

/**
 * P0-N8 / LB15 static opacity gate. The Redis `push:events` channel payload reaches
 * FCM/APNs in the clear (Google/Apple operate the intermediary), so it must be EXACTLY
 * {userId, eventClass, eventId} — never a bookingId/missionId/offerId/kind. The real
 * detail lives only in Redis behind the JWT-gated encrypted relay. This test fails if any
 * bridge method ever leaks a sensitive id onto the channel.
 */
function mk() {
  const publish = jest.fn().mockResolvedValue(1);
  const set = jest.fn().mockResolvedValue('OK');
  const redis = {client: {publish, set}} as unknown as RedisService;
  // N-20 — the durable inbox write rides alongside publish; it never touches
  // the FCM channel, so channel opacity is unaffected. Mock it here.
  const record = jest.fn().mockResolvedValue(undefined);
  const notifications = {record} as unknown as NotificationsService;
  const svc = new BookingPushBridge(redis, notifications);
  return {svc, publish, set, record};
}
function channelPayload(publish: jest.Mock): Record<string, unknown> {
  const call = publish.mock.calls.find(c => c[0] === BookingPushBridge.CHANNEL);
  if (!call) throw new Error('nothing published to the channel');
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

const SENSITIVE = ['b-booking-123', 'm-mission-456', 'o-offer-789'];

const cases: Array<[string, (s: BookingPushBridge) => Promise<void>]> = [
  ['dispatchOffer',     s => s.dispatchOffer('u1', 'b-booking-123')],
  ['providerAccepted',  s => s.providerAccepted('u1', 'b-booking-123')],
  ['noProvider',        s => s.noProvider('u1', 'b-booking-123')],
  ['agencyNoShow',      s => s.agencyNoShow('u1', 'b-booking-123')],
  ['bookingApproved',   s => s.bookingApproved('u1', 'b-booking-123')],
  ['missionDispatched', s => s.missionDispatched('u1', 'm-mission-456', 'b-booking-123')],
  ['missionAborted',    s => s.missionAborted('u1', 'm-mission-456', 'b-booking-123')],
  ['payoutSettled',     s => s.payoutSettled('u1', 'b-booking-123', 500)],
  ['agentDecided',      s => s.agentDecided('u1', 'APPROVED')],
  ['sosAlert',          s => s.sosAlert(['u1'], 'm-mission-456', 'b-booking-123')],
];

describe('BookingPushBridge — channel opacity (P0-N8)', () => {
  it.each(cases)('%s publishes EXACTLY {userId,eventClass,eventId} — no sensitive id', async (_name, fn) => {
    const {svc, publish, set} = mk();
    await fn(svc);
    // The channel payload carries only the opaque triple.
    const payload = channelPayload(publish);
    expect(Object.keys(payload).sort()).toEqual(['eventClass', 'eventId', 'userId']);
    const raw = JSON.stringify(payload);
    for (const id of SENSITIVE) expect(raw).not.toContain(id);
    // The sensitive detail goes to Redis (push-event:<id>), never the channel.
    expect(set).toHaveBeenCalledWith(expect.stringMatching(/^push-event:/), expect.any(String), 'EX', expect.any(Number));
  });

  it('eventClass stays coarse (one of the allowed category labels)', async () => {
    const allowed = new Set(['agent', 'booking', 'mission', 'payout', 'sos', 'dispatch']);
    for (const [, fn] of cases) {
      const {svc, publish} = mk();
      await fn(svc);
      expect(allowed.has(channelPayload(publish).eventClass as string)).toBe(true);
    }
  });
});
