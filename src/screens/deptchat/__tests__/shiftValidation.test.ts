import {validateShiftDraft} from '../shiftValidation';

/**
 * Step 21 — the shift editor's Save guard. These mirror the runbook acceptance
 * (radius > 0, start < end, >= 1 CPO) and the server's createShift/assignCpos
 * invariants, so an invalid draft can never reach the API.
 */
const base = {startMs: 1_000, endMs: 2_000, selectedCount: 1, hasCoords: false, radius: 150};

describe('validateShiftDraft (Step 21)', () => {
  it('accepts a valid draft', () => {
    expect(validateShiftDraft(base)).toBeNull();
    expect(validateShiftDraft({...base, hasCoords: true, radius: 150})).toBeNull();
  });

  it('rejects end <= start', () => {
    expect(validateShiftDraft({...base, endMs: 1_000})).toMatch(/end time/i);
    expect(validateShiftDraft({...base, startMs: 5_000, endMs: 2_000})).toMatch(/end time/i);
  });

  it('rejects zero CPOs selected', () => {
    expect(validateShiftDraft({...base, selectedCount: 0})).toMatch(/at least one CPO/i);
  });

  it('rejects a non-positive radius only when a geofence centre is set', () => {
    expect(validateShiftDraft({...base, hasCoords: true, radius: 0})).toMatch(/radius/i);
    // No coords => radius is irrelevant (server skips the radius check).
    expect(validateShiftDraft({...base, hasCoords: false, radius: 0})).toBeNull();
  });
});
