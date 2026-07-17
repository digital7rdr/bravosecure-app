/**
 * P0-T4 + P1-N20 regression locks on `messengerStore.appendMessage`.
 *
 * - P0-T4: a reconnect that re-pushes the same envelope MUST NOT
 *   produce two bubbles. The crypto-layer `seenEnvelopeStore` guards
 *   the ratchet, but a redelivered envelope can still re-enter
 *   `appendMessage` via a different code path; the store itself must
 *   reject it on `envelope_id` even when the local `id` differs.
 * - P1-N20: hydrate sort + prependOlder sort must produce a stable
 *   order when two messages share the same `created_at`.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const CONV = 'direct:alice';

function msg(overrides: Partial<LocalMessage>): LocalMessage {
  return {
    id:              overrides.id ?? 'm1',
    conversation_id: CONV,
    sender_id:       'alice-uuid',
    type:            'text',
    content:         'hi',
    status:          'sent',
    is_encrypted:    true,
    created_at:      overrides.created_at ?? '2026-05-25T12:00:00.000Z',
    peer:            {userId: 'alice-uuid', deviceId: 1},
    ...overrides,
  };
}

beforeEach(() => {
  useMessengerStore.setState({
    conversations: {}, conversationOrder: [], messages: {},
    activeConversationId: null,
  } as never, false);
});

describe('P0-T4 — appendMessage dedups by envelope_id', () => {
  test('two distinct local ids sharing one envelope_id collapse to a single bubble', () => {
    const a = msg({id: 'local-a', envelope_id: 'env-1'});
    const b = msg({id: 'local-b', envelope_id: 'env-1'});  // simulated reconnect-redeliver
    useMessengerStore.getState().appendMessage(CONV, a);
    useMessengerStore.getState().appendMessage(CONV, b);
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
    expect(useMessengerStore.getState().messages[CONV][0].id).toBe('local-a');
  });

  test('distinct envelope_ids stay distinct', () => {
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', envelope_id: 'env-1'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm2', envelope_id: 'env-2'}));
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(2);
  });

  test('missing envelope_id: exact-duplicate (same id+sender+content) is dropped', () => {
    // Same id, same sender_id, same content → P2-N4 content-bound dedup
    // drops the second push.
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', content: 'hi'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', content: 'hi'}));
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(1);
    expect(useMessengerStore.getState().messages[CONV][0].content).toBe('hi');
  });

  test('outbound message without envelope_id is not blocked by an inbound msg that has one', () => {
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'in1', envelope_id: 'env-1'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'out1', sender_id: 'self'}));
    expect(useMessengerStore.getState().messages[CONV]).toHaveLength(2);
  });
});

describe('P1-N20 — appendMessage append order is the comparator-stable order under hydrate', () => {
  test('hydrateMessages sorts equal-ts messages by id ascending', () => {
    const sameTs = '2026-05-25T12:00:00.000Z';
    const m1 = msg({id: 'mZ', created_at: sameTs});
    const m2 = msg({id: 'mA', created_at: sameTs});
    const m3 = msg({id: 'mM', created_at: sameTs});
    useMessengerStore.getState().hydrateMessages({[CONV]: [m1, m2, m3]}, true);
    const ids = useMessengerStore.getState().messages[CONV].map(m => m.id);
    expect(ids).toEqual(['mA', 'mM', 'mZ']);
  });

  test('prependOlderMessages preserves stable order for equal-ts boundary', () => {
    const ts = '2026-05-25T12:00:00.000Z';
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'mB', created_at: ts}));
    useMessengerStore.getState().prependOlderMessages(CONV, [
      msg({id: 'mA', created_at: ts}),
      msg({id: 'mC', created_at: ts}),
    ]);
    const ids = useMessengerStore.getState().messages[CONV].map(m => m.id);
    expect(ids).toEqual(['mA', 'mB', 'mC']);
  });
});

describe('L18 — appendMessage splices an out-of-order (late-drained) message into send-order', () => {
  test('a stashed message that drains late lands in its chronological slot, not the bottom', () => {
    // Two live messages, then a late insert whose send-time created_at falls
    // BETWEEN them — a no_key group message that drained after newer messages.
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm1', envelope_id: 'e1', created_at: '2026-05-25T12:00:01.000Z'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm3', envelope_id: 'e3', created_at: '2026-05-25T12:00:03.000Z'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'm2', envelope_id: 'e2', created_at: '2026-05-25T12:00:02.000Z'}));
    expect(useMessengerStore.getState().messages[CONV].map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  test('in-order appends still go to the end (fast path preserved)', () => {
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'a', envelope_id: 'ea', created_at: '2026-05-25T12:00:01.000Z'}));
    useMessengerStore.getState().appendMessage(CONV, msg({id: 'b', envelope_id: 'eb', created_at: '2026-05-25T12:00:02.000Z'}));
    expect(useMessengerStore.getState().messages[CONV].map(m => m.id)).toEqual(['a', 'b']);
  });
});
