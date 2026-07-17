import {missionAction, missionActionView} from '../missionAction';

describe('missionAction — lead-only context-aware mission control (Step 21)', () => {
  it('maps each lead state to its single next transition', () => {
    expect(missionAction('DISPATCHED', true)).toBe('start');
    expect(missionAction('PICKUP', true)).toBe('go-live');
    expect(missionAction('LIVE', true)).toBe('finish');
  });

  it('gives a non-lead NO advance action in any state (read-only ride-along)', () => {
    for (const st of ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED']) {
      expect(missionAction(st, false)).toBe('none');
    }
  });

  it('gives the lead no advance from SOS / terminal / unknown states', () => {
    expect(missionAction('SOS', true)).toBe('none');
    expect(missionAction('COMPLETED', true)).toBe('none');
    expect(missionAction('ABORTED', true)).toBe('none');
    expect(missionAction('', true)).toBe('none');
    expect(missionAction(null, true)).toBe('none');
  });

  it('is case-insensitive', () => {
    expect(missionAction('live', true)).toBe('finish');
  });

  it('view: only Finish demands a deliberate swipe-to-confirm', () => {
    expect(missionActionView('DISPATCHED', true)).toMatchObject({label: 'Start mission', confirm: false});
    expect(missionActionView('PICKUP', true)).toMatchObject({label: 'Go live', confirm: false});
    expect(missionActionView('LIVE', true)).toMatchObject({label: 'Finish mission', confirm: true});
    expect(missionActionView('LIVE', false).action).toBe('none');
  });
});
