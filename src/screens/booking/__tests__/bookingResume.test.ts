import {resumeTargetFor, liveTargetFor} from '../bookingStatus';

// LB-OTP1 / LB-ST2 — the booking FSM stays CONFIRMED for the whole mission, so
// resume/deep-link routing must key off mission_status (when present), not just
// booking.status. Regression guard for the "verify code / status frozen on
// resume" class of bugs.
describe('resumeTargetFor — mission-aware routing', () => {
  it('routes a plain CONFIRMED (no mission yet) to BookingConfirmation', () => {
    expect(resumeTargetFor('b1', 'CONFIRMED')).toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
  });

  it('routes CONFIRMED-with-a-live-mission straight to LiveTracking', () => {
    for (const ms of ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']) {
      expect(resumeTargetFor('b1', 'CONFIRMED', ms)).toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    }
  });

  it('does NOT divert to LiveTracking for a mission that ended (ABORTED/COMPLETED)', () => {
    expect(resumeTargetFor('b1', 'CONFIRMED', 'ABORTED')).toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
    // COMPLETED booking is terminal → no resume target.
    expect(resumeTargetFor('b1', 'COMPLETED', 'COMPLETED')).toBeNull();
  });

  it('keeps the pre-mission booking states intact', () => {
    expect(resumeTargetFor('b1', 'DISPATCHING')).toEqual({screen: 'FindingDetail', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'PENDING_OPS')).toEqual({screen: 'OpsRoomReview', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'LIVE')).toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'NO_PROVIDER')).toEqual({screen: 'NoDetail', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'CANCELLED')).toBeNull();
  });

  it('liveTargetFor reads both fields off a booking object', () => {
    expect(liveTargetFor({id: 'b1', status: 'CONFIRMED', mission_status: 'PICKUP'}))
      .toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    expect(liveTargetFor({id: 'b1', status: 'CONFIRMED', mission_status: null}))
      .toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
  });
});
