import {EnvelopeController} from './envelope.controller';
import type {EnvelopeService} from './envelope.service';
import type {PushService} from '../push/push.service';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import type {SendEnvelopeDto} from './dto/send-envelope.dto';
import type {SendEnvelopeResult} from './envelope.types';

/**
 * Audit P2-BR-3 — chat-wake gating on POST /envelopes.
 *
 * Every non-displayable envelope (reaction, group-control/rekey, deduped
 * retry, pre-expired send) used to fire a full HIGH-importance "New secure
 * message" wake — phantom sound banners that open to nothing on a killed
 * device. Two gates now apply, and both must hold:
 *
 *   1. Client Signal-style `urgent` flag (default true — legacy clients
 *      that omit it keep today's behavior): `urgent:false` skips the wake.
 *      The flag reveals only "notification-worthy or not" — no content or
 *      kind field ever reaches the relay.
 *   2. Server-detected `wakeEligible` from the submit result: a dedup HIT
 *      (retried send) and an already-expired submit never wake, regardless
 *      of the flag.
 *
 * Unit-tests the controller directly (plain constructor injection) — the
 * guard/DTO-validation layers are out of scope here.
 */

function buildController(result?: Partial<SendEnvelopeResult>) {
  const submitEnvelope = jest.fn().mockResolvedValue({
    envelopeId:   'env-1',
    clientMsgId:  'c-1',
    deliveredNow: false,
    retractToken: 'r-1',
    wakeEligible: true,
    ...result,
  } satisfies SendEnvelopeResult);
  const sendChatWake = jest.fn().mockResolvedValue({sent: 1, stubbed: false});
  const controller = new EnvelopeController(
    {submitEnvelope} as unknown as EnvelopeService,
    {sendChatWake} as unknown as PushService,
  );
  return {controller, submitEnvelope, sendChatWake};
}

const caller = {
  claims: {sub: 'alice-uuid'},
  signalDeviceId: 1,
} as unknown as CallerContext;

function dto(extra: Partial<SendEnvelopeDto> = {}): SendEnvelopeDto {
  return {
    recipient:   {userId: 'bob', deviceId: 1},
    outerSealed: 'x'.repeat(80),
    clientMsgId: 'c-1',
    ...extra,
  } as SendEnvelopeDto;
}

describe('EnvelopeController — audit P2-BR-3 urgent-flag wake gating', () => {
  it('fires the chat wake when urgent is omitted (legacy default) and the submit is wakeEligible', async () => {
    const {controller, sendChatWake} = buildController();
    await controller.send(caller, dto());
    expect(sendChatWake).toHaveBeenCalledTimes(1);
    expect(sendChatWake).toHaveBeenCalledWith('bob', {senderUserId: 'alice-uuid'});
  });

  it('fires the chat wake when urgent is explicitly true', async () => {
    const {controller, sendChatWake} = buildController();
    await controller.send(caller, dto({urgent: true}));
    expect(sendChatWake).toHaveBeenCalledTimes(1);
  });

  it('skips the chat wake entirely when urgent === false (reactions / group-control / rekey)', async () => {
    const {controller, sendChatWake} = buildController();
    const res = await controller.send(caller, dto({urgent: false}));
    expect(sendChatWake).not.toHaveBeenCalled();
    // The submit itself is unaffected — accepted shape returned as usual.
    expect(res.envelopeId).toBe('env-1');
  });

  it('skips the chat wake on a dedup HIT / pre-expired submit (wakeEligible=false) even when urgent', async () => {
    const {controller, sendChatWake} = buildController({wakeEligible: false});
    await controller.send(caller, dto({urgent: true}));
    expect(sendChatWake).not.toHaveBeenCalled();
  });

  it('never forwards the urgent flag into the sealed submit input (metadata-minimal)', async () => {
    const {controller, submitEnvelope} = buildController();
    await controller.send(caller, dto({urgent: false}));
    expect(submitEnvelope).toHaveBeenCalledWith({
      recipient:    {userId: 'bob', deviceId: 1},
      outerSealed:  'x'.repeat(80),
      clientMsgId:  'c-1',
      expiresAtSec: undefined,
    });
    const input = submitEnvelope.mock.calls[0][0] as Record<string, unknown>;
    expect('urgent' in input).toBe(false);
  });
});
