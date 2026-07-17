/**
 * Audit 2026-07-06 M-04 — store-driven warm-path message banners.
 *
 * Sealed sender hides the conversation from a group msg-wake, so group
 * collapse/mute/tap is driven off messengerStore instead: while the app is
 * backgrounded, a NEW inbound message in a non-muted, non-active conversation
 * posts a conv-keyed notifee banner; read/activation and foregrounding cancel
 * it. Store-level tests with notifee + AppState mocked.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  AppState: {
    currentState: 'background',
    addEventListener: jest.fn(() => ({remove: jest.fn()})),
  },
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => 'nid'),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'bravo-messages'),
    deleteChannel:       jest.fn(async () => {}),
    onForegroundEvent:   jest.fn(),
    onBackgroundEvent:   jest.fn(),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

import {AppState} from 'react-native';
import notifee from '@notifee/react-native';
import {useMessengerStore} from '../store/messengerStore';
import {
  startBackgroundMessageNotifier,
  stopBackgroundMessageNotifier,
  setContentPreviewEnabled,
} from '../push/backgroundMessageNotifier';
import {showMessageNotif, dismissMessageNotif} from '../push/callNotification';
import type {LocalConversation, LocalMessage} from '../store/types';

const display = notifee.displayNotification as jest.Mock;
const cancel  = notifee.cancelNotification as jest.Mock;

const flush = async () => {
  await new Promise<void>(r => setImmediate(r));
  await new Promise<void>(r => setImmediate(r));
};

function groupConv(id: string, extra?: Partial<LocalConversation>): LocalConversation {
  return {
    id,
    type:          'group',
    name:          `Group ${id}`,
    participants:  ['peer-1', 'peer-2'],
    unread_count:  0,
    is_muted:      false,
    created_at:    new Date('2026-07-01T00:00:00Z').toISOString(),
    peer:          {userId: '', deviceId: 0},
    session_state: 'established',
    ...extra,
  } as LocalConversation;
}

function inbound(id: string, conversationId: string, extra?: Partial<LocalMessage>): LocalMessage {
  return {
    id,
    conversation_id: conversationId,
    sender_id:       'peer-1',
    type:            'text',
    content:         'super secret plaintext body',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date('2026-07-06T10:00:00Z').toISOString(),
    peer:            {userId: 'peer-1', deviceId: 1},
    ...extra,
  } as LocalMessage;
}

describe('backgroundMessageNotifier (M-04)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AppState as unknown as {currentState: string}).currentState = 'background';
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
  });

  afterEach(() => {
    stopBackgroundMessageNotifier();
  });

  it('posts a conv-keyed banner with a content preview (B-65 default ON) for a new inbound group message while backgrounded', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1', {name: 'Ops Team'}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();

    expect(display).toHaveBeenCalledTimes(1);
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-msg-g1');
    expect(arg.title).toBe('Ops Team');
    expect(arg.data.conversationId).toBe('g1');
    // B-65 — preview default ON (Telegram/WhatsApp parity): the locally-
    // decrypted body IS the banner text (visibility PRIVATE redacts it on a
    // secure lock screen).
    expect(arg.body).toBe('super secret plaintext body');
  });

  it('opt-out (preview disabled) keeps plaintext out of the banner', async () => {
    setContentPreviewEnabled(false);
    try {
      const s = useMessengerStore.getState();
      s.upsertConversation(groupConv('g1', {name: 'Ops Team'}));
      startBackgroundMessageNotifier();
      useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
      await flush();

      expect(display).toHaveBeenCalledTimes(1);
      const arg = display.mock.calls[0][0];
      expect(arg.title).toBe('Ops Team');
      // The privacy guarantee, now opt-in: no plaintext anywhere in the payload.
      expect(JSON.stringify(arg)).not.toContain('super secret plaintext body');
    } finally {
      setContentPreviewEnabled(true); // restore the B-65 default for other tests
    }
  });

  it('suppresses banners for a MUTED conversation', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1', {is_muted: true}));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('suppresses banners for the ACTIVE conversation and for own (self) messages', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().setActiveConversation('g1');
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    useMessengerStore.getState().setActiveConversation(null);
    useMessengerStore.getState().appendMessage('g1', inbound('m2', 'g1', {sender_id: 'self'}));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('suppresses banners while the app is foregrounded (active)', async () => {
    (AppState as unknown as {currentState: string}).currentState = 'active';
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });

  it('cancels the banner when its conversation is activated (read)', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    useMessengerStore.getState().setActiveConversation('g1');
    await flush();
    expect(cancel).toHaveBeenCalledWith('bravo-msg-g1');
  });

  it('cancels all posted banners when the app foregrounds', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    const appStateCb = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (st: string) => void;
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);

    appStateCb('active');
    await flush();
    expect(cancel).toHaveBeenCalledWith('bravo-msg-g1');
  });

  it('does not replay bulk boot hydration as banners', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g2'));
    startBackgroundMessageNotifier();
    useMessengerStore.getState().hydrateMessages({
      g2: [inbound('h1', 'g2'), inbound('h2', 'g2')],
    });
    await flush();
    expect(display).not.toHaveBeenCalled();
    // But a LIVE append after hydration still notifies.
    useMessengerStore.getState().appendMessage('g2', inbound('m3', 'g2', {
      created_at: new Date('2026-07-06T11:00:00Z').toISOString(),
    }));
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after stop()', async () => {
    const s = useMessengerStore.getState();
    s.upsertConversation(groupConv('g1'));
    startBackgroundMessageNotifier();
    stopBackgroundMessageNotifier();
    useMessengerStore.getState().appendMessage('g1', inbound('m1', 'g1'));
    await flush();
    expect(display).not.toHaveBeenCalled();
  });
});

describe('showMessageNotif ids (M-03)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('keys by conversation when resolvable', async () => {
    await showMessageNotif({conversationId: 'c9', senderUserId: 'u9'});
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-msg-c9');
    expect(arg.data.conversationId).toBe('c9');
  });

  it('falls back to a sender-keyed id (bounded stacking) with NO conversationId in tap data', async () => {
    await showMessageNotif({senderUserId: 'u9'});
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-msg-sender:u9');
    expect(arg.data.conversationId).toBeUndefined();
  });

  it('dismissMessageNotif on a direct thread also clears the first-contact sender-keyed banner', async () => {
    await dismissMessageNotif('direct:u9');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-direct:u9');
    expect(cancel).toHaveBeenCalledWith('bravo-msg-sender:u9');
  });
});
