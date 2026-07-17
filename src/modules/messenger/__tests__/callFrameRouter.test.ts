import {isCallFrame, CALL_FRAME_EVENTS} from '../runtime/callFrameRouter';

/**
 * Regression for the mid-call upgrade hang: the runtime's
 * `handleServerFrame` dispatcher gate was missing `call.reoffer` and
 * `call.reanswer`, so voice → video upgrades stalled ~8 s then rolled
 * back (the reanswer never reached the dispatcher). The gateway and
 * callDispatcher both already handled the events; only the runtime
 * gate was wrong.
 */
describe('isCallFrame — runtime dispatcher gate', () => {
  describe('initial 1:1 call lifecycle', () => {
    it.each([
      'call.offer',
      'call.answer',
      'call.ice',
      'call.hangup',
    ])('routes %s through the call dispatcher', (eventName) => {
      expect(isCallFrame(eventName)).toBe(true);
    });
  });

  describe('mid-call control / renegotiation', () => {
    it('routes call.media-state (BS-021 peer mute/camera advisory)', () => {
      expect(isCallFrame('call.media-state')).toBe(true);
    });

    it('REGRESSION — routes call.reoffer for voice→video upgrade', () => {
      // Was missing → upgrade hang.
      expect(isCallFrame('call.reoffer')).toBe(true);
    });

    it('REGRESSION — routes call.reanswer for voice→video upgrade', () => {
      // Was missing → upgrade hang.
      expect(isCallFrame('call.reanswer')).toBe(true);
    });
  });

  describe('non-call frames must NOT be routed', () => {
    it.each([
      'envelope.deliver',
      'envelope.accepted',
      'envelope.delivered',
      'envelope.ack',
      'pong',
      'presence',
      'typing',
      'read-receipt',
      // SFU events route through a separate dispatcher.
      'sfu.new-producer',
      'sfu.participant.joined',
      'sfu.participant.left',
      // Bogus / unknown
      'totally.fake.event',
      '',
    ])('does not route %s', (eventName) => {
      expect(isCallFrame(eventName)).toBe(false);
    });
  });

  it('exports the call frame set for callers that want to enumerate', () => {
    expect(CALL_FRAME_EVENTS instanceof Set).toBe(true);
    // Lock in the exact membership so a future delete is caught.
    expect(Array.from(CALL_FRAME_EVENTS).sort()).toEqual([
      'call.answer',
      'call.hangup',
      'call.ice',
      'call.media-state',
      'call.missed',   // SFU-12 — missed-call record on expired offer
      'call.offer',
      'call.reanswer',
      'call.reoffer',
    ]);
  });
});
