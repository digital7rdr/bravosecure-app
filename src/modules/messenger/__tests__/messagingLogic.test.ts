import {
  isGroupConversation,
  reactionRecipients,
  typingAffectedConversationIds,
  readReceiptAccepted,
  TypingWatchdog,
  TYPING_WATCHDOG_MS,
  type MessagingStateLike,
} from '@/modules/messenger/runtime/messagingLogic';

/**
 * Runtime decision logic extracted from productionRuntime so the audited
 * receive/send branches are testable without standing up the full
 * runtime. Covers the HIGH fixes (reaction fan-out, typing routing) and
 * the MEDIUM fixes (typing watchdog, group read-receipt ownership).
 */

const OWN = 'user-self';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const EVE = 'user-eve';

function state(conversations: MessagingStateLike['conversations'], groups: MessagingStateLike['groups'] = {}): MessagingStateLike {
  return {conversations, groups};
}

describe('isGroupConversation', () => {
  it('is true for explicit group / ops_channel types', () => {
    expect(isGroupConversation(state({g: {type: 'group'}}), 'g')).toBe(true);
    expect(isGroupConversation(state({g: {type: 'ops_channel'}}), 'g')).toBe(true);
  });
  it('is true when a local GroupState exists', () => {
    expect(isGroupConversation(state({g: {}}, {g: {}}), 'g')).toBe(true);
  });
  it('is false for a direct chat even with two participants', () => {
    expect(isGroupConversation(state({d: {type: 'direct', participants: [OWN, ALICE]}}), 'd')).toBe(false);
  });
  it('is true for an untyped row with >1 participant (legacy fallback)', () => {
    expect(isGroupConversation(state({g: {participants: [ALICE, BOB]}}), 'g')).toBe(true);
  });
});

describe('reactionRecipients (BS-RX1 — group reaction fan-out)', () => {
  const peer = {userId: ALICE, deviceId: 1};

  it('returns just the peer for a direct chat', () => {
    const s = state({d: {type: 'direct', participants: [OWN, ALICE]}});
    expect(reactionRecipients(s, 'd', OWN, peer)).toEqual([{userId: ALICE, deviceId: 1}]);
  });

  it('fans out to EVERY group member except self', () => {
    const s = state({g: {type: 'group', participants: [OWN, ALICE, BOB]}});
    const out = reactionRecipients(s, 'g', OWN, peer);
    expect(out).toEqual([
      {userId: ALICE, deviceId: 1},
      {userId: BOB, deviceId: 1},
    ]);
    // The bug was that only ONE member received the reaction.
    expect(out.length).toBe(2);
  });

  it('falls back to the passed peer when a group has no resolved members yet', () => {
    const s = state({g: {type: 'group', participants: [OWN]}}); // only self
    expect(reactionRecipients(s, 'g', OWN, peer)).toEqual([peer]);
  });
});

describe('typingAffectedConversationIds (BS-TY1)', () => {
  it('includes synthetic + canonical direct ids, deduped', () => {
    const s = state({'uuid-1': {type: 'direct', participants: [OWN, ALICE]}});
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'uuid-1');
    expect(out).toContain('direct:user-alice');
    expect(out).toContain('uuid-1');
  });

  it('collapses to one id when synthetic === canonical (no UUID row yet)', () => {
    const out = typingAffectedConversationIds(state({}), ALICE, 'direct:user-alice', 'direct:user-alice');
    expect(out).toEqual(['direct:user-alice']);
  });

  it('adds every group the sender participates in', () => {
    const s = state({
      'g1': {type: 'group', participants: [OWN, ALICE, BOB]},
      'g2': {type: 'group', participants: [OWN, BOB]}, // alice NOT a member
    });
    const out = typingAffectedConversationIds(s, ALICE, 'direct:user-alice', 'direct:user-alice');
    expect(out).toContain('g1');
    expect(out).not.toContain('g2');
  });
});

describe('readReceiptAccepted (BS-RR1 — group receipt ownership)', () => {
  it('direct: accepts only the stored peer', () => {
    const s = state({d: {type: 'direct', participants: [OWN, ALICE]}});
    expect(readReceiptAccepted({state: s, conversationId: 'd', receipterUid: ALICE, messagePeerUserId: ALICE})).toBe(true);
    expect(readReceiptAccepted({state: s, conversationId: 'd', receipterUid: EVE, messagePeerUserId: ALICE})).toBe(false);
  });

  it('group: accepts ANY member, not just participants[0] (the bug)', () => {
    const s = state({g: {type: 'group', participants: [OWN, ALICE, BOB]}});
    // Outbound group rows store peer = participants[0] (= OWN/ALICE placeholder),
    // but a receipt from BOB (not the first member) must still be accepted.
    expect(readReceiptAccepted({state: s, conversationId: 'g', receipterUid: BOB, messagePeerUserId: ALICE})).toBe(true);
    expect(readReceiptAccepted({state: s, conversationId: 'g', receipterUid: ALICE, messagePeerUserId: ALICE})).toBe(true);
  });

  it('group: rejects a non-member receipter', () => {
    const s = state({g: {type: 'group', participants: [OWN, ALICE, BOB]}});
    expect(readReceiptAccepted({state: s, conversationId: 'g', receipterUid: EVE, messagePeerUserId: ALICE})).toBe(false);
  });
});

describe('TypingWatchdog (BS-TY2)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('fires onExpire after the window when not cleared (dropped stop frame)', () => {
    const wd = new TypingWatchdog();
    const onExpire = jest.fn();
    wd.arm('c1', onExpire);
    expect(wd.isArmed('c1')).toBe(true);
    jest.advanceTimersByTime(TYPING_WATCHDOG_MS + 1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(wd.isArmed('c1')).toBe(false);
  });

  it('does NOT fire when cleared before the window (stop frame / message arrived)', () => {
    const wd = new TypingWatchdog();
    const onExpire = jest.fn();
    wd.arm('c1', onExpire);
    wd.clear('c1');
    jest.advanceTimersByTime(TYPING_WATCHDOG_MS + 1);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('re-arming resets the window (does not double-fire)', () => {
    const wd = new TypingWatchdog(1000);
    const onExpire = jest.fn();
    wd.arm('c1', onExpire);
    jest.advanceTimersByTime(600);
    wd.arm('c1', onExpire); // re-arm at 600ms
    jest.advanceTimersByTime(600); // 1200ms total, but only 600ms since re-arm
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500); // now 1100ms since re-arm
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('tracks timers per conversation independently', () => {
    const wd = new TypingWatchdog();
    const a = jest.fn(); const b = jest.fn();
    wd.arm('a', a);
    wd.arm('b', b);
    wd.clear('a');
    jest.advanceTimersByTime(TYPING_WATCHDOG_MS + 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
