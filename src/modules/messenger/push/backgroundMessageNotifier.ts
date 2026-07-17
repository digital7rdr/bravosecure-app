/**
 * M-04 (audit 2026-07-06) — store-driven message banners for the WARM
 * background path.
 *
 * Sealed sender means a msg-wake FCM frame names only the sender, so a GROUP
 * message can never be resolved to its conversation from the push payload —
 * which broke per-conversation collapse, mute suppression, and tap routing
 * for groups. But on the warm path the messenger runtime DOES decrypt the
 * message into messengerStore. This module subscribes to the store and,
 * while the app is backgrounded/inactive, posts a conv-keyed notifee banner
 * for each NEW inbound message in a non-muted, non-active conversation —
 * giving groups correct collapse + mute + tap. The banner text stays generic
 * ('New message'); the title is the conversation's display name, which is
 * allowed because it is derived locally from the store, never from the wire.
 *
 * The killed-app path cannot run this (no runtime, no decrypt), so killed
 * group wakes stay generic sender-keyed banners — documented residual gap.
 *
 * Idempotent start; stopped (and its banners cleared) on sign-out via
 * stopFcmBootstrap.
 */
import {AppState, Platform} from 'react-native';
import type {NativeEventSubscription} from 'react-native';

type StoreModule = typeof import('../store/messengerStore');
type StoreState  = ReturnType<StoreModule['useMessengerStore']['getState']>;

let running = false;
let unsubStore: (() => void) | null = null;
let appStateSub: NativeEventSubscription | null = null;

// N-10/N-16 — message-content previews in notifications are a privacy choice.
// B-65 (tester 2026-07-10: "notification does not say what is going on — like
// Telegram"): default is now ON, matching Signal/WhatsApp/Telegram — the
// preview is locally decrypted, rendered with visibility PRIVATE (redacted on
// a secure lock screen), and never comes from the wire. Users can opt out via
// Messenger settings ('0'); a previous explicit opt-in ('1') still reads as on.
// Cached so the store subscriber (sync) can read it without an await per message.
const PREVIEW_PREF_KEY = 'bravo:notif-content-preview';
let contentPreviewEnabled = true;
async function loadPreviewPref(): Promise<void> {
  try {
    const AsyncStorage = (require('@react-native-async-storage/async-storage') as {default: {getItem(k: string): Promise<string | null>}}).default;
    contentPreviewEnabled = (await AsyncStorage.getItem(PREVIEW_PREF_KEY)) !== '0';
  } catch { contentPreviewEnabled = true; }
}
/** Settings toggle updates the live cache so the change takes effect at once. */
export function setContentPreviewEnabled(v: boolean): void { contentPreviewEnabled = v; }
// Last message id observed at the tail of each conversation — the "already
// seen" watermark that separates live arrivals from boot hydration replay.
const lastTailByConvo = new Map<string, string>();
// Conversations with a banner posted by THIS module (so foreground/read
// cleanup only cancels what we own).
const postedConvos = new Set<string>();

function isBackgrounded(): boolean {
  const s = AppState.currentState;
  return s === 'background' || s === 'inactive';
}

/** N-29/N-11 — lets the FCM background handler skip its own (generic /
 *  mis-keyed) banner when this store-driven notifier is alive to draw the
 *  correct conv-keyed one, avoiding a double banner for the same message. */
export function isBackgroundMessageNotifierRunning(): boolean {
  return running;
}

// P2-6 — monotonic count of banners this notifier has actually posted. The FCM
// warm-background handler skips its own banner when the notifier is running, then
// pulls; it snapshots this before the pull and, if it hasn't advanced afterwards
// (Doze pull failed, or the message was for the active thread), posts a fallback
// so a real message can never produce ZERO signal. Incremented synchronously at
// the top of post() so it reflects the store-subscriber's decision by the time
// the pull promise resolves.
let messagePostedGeneration = 0;
export function getMessagePostedGeneration(): number { return messagePostedGeneration; }

// N-10 — a short, locally-derived preview. Content is E2EE but on the WARM
// path it is already decrypted into the live store, so a lock-screen-redacted
// (visibility PRIVATE) preview is safe — Android hides it on a secure lock
// screen and shows it once unlocked, matching Signal/Telegram default UX.
function previewForNotif(msg: {type?: string; content?: string}): string | undefined {
  if (msg.type === 'image') {return '📷 Photo';}
  if (msg.type === 'file')  {return '📎 Attachment';}
  if (msg.type === 'audio') {return '🎤 Voice message';}
  if (msg.type === 'video') {return '📹 Video';}
  const s = (msg.content ?? '').replace(/\s+/g, ' ').trim();
  if (!s) {return undefined;}
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

async function post(
  conversationId: string,
  opts: {title?: string; body?: string; senderName?: string; badgeCount?: number},
): Promise<void> {
  messagePostedGeneration++; // P2-6 — bump synchronously so the pull caller can detect "a banner was drawn"
  try {
    const {showMessageNotif} = require('./callNotification') as typeof import('./callNotification');
    postedConvos.add(conversationId);
    await showMessageNotif({
      conversationId,
      title: opts.title,
      body: opts.body,
      senderName: opts.senderName,
      badgeCount: opts.badgeCount,
      actions: true, // N-10 — runtime is alive on this path: Reply + Mark-read work
    });
  } catch (e) {
    console.warn('[bgMsgNotifier] post failed:', (e as Error).message);
  }
}

async function dismiss(conversationId: string, memberUserIds?: string[]): Promise<void> {
  postedConvos.delete(conversationId);
  try {
    const {dismissMessageNotif} = require('./callNotification') as typeof import('./callNotification');
    // P3 — pass member ids so a killed-app GROUP banner (keyed by its sender,
    // since the group was unresolvable headless) is cleared on read too.
    await dismissMessageNotif(conversationId, memberUserIds);
  } catch (e) {
    console.warn('[bgMsgNotifier] dismiss failed:', (e as Error).message);
  }
}

async function cancelAllPosted(): Promise<void> {
  for (const cid of Array.from(postedConvos)) {
    await dismiss(cid);
  }
}

function onStoreChange(state: StoreState, prev: StoreState): void {
  // Opening a thread clears its banner immediately (read == activation). P3 —
  // run this even when WE didn't post the banner, so a killed-path sender-keyed
  // GROUP banner is cleared on read; pass the conversation's members so those
  // sender-keyed ids are cancelled.
  const active = state.activeConversationId;
  if (active && active !== prev.activeConversationId) {
    const conv = state.conversations[active];
    const memberIds: string[] = [];
    if (conv?.peer?.userId) {memberIds.push(conv.peer.userId);}
    for (const p of conv?.participants ?? []) { if (p) {memberIds.push(p);} }
    void dismiss(active, memberIds);
  }
  if (state.messages === prev.messages) {return;}
  for (const [cid, list] of Object.entries(state.messages)) {
    if (list === prev.messages[cid]) {continue;}
    const tail = list[list.length - 1];
    if (!tail) {continue;}
    const seenTail = lastTailByConvo.get(cid);
    lastTailByConvo.set(cid, tail.id);
    // Why: a conversation materializing with MANY rows at once is SQLCipher
    // boot hydration, not a live arrival — replaying it as banners would
    // spray stale notifications after a background boot.
    if (seenTail === undefined && !(cid in prev.messages) && list.length > 1) {continue;}
    if (tail.id === seenTail) {continue;}
    if (!tail.sender_id || tail.sender_id === 'self') {continue;}
    if (!isBackgrounded()) {continue;}
    if (cid === active) {continue;}
    if (state.conversations[cid]?.is_muted) {continue;} // M-04 — muted stays silent
    // N-10 — Telegram-style preview + sender name (groups), all locally
    // derived. N-17 — badge = total unread across conversations.
    const conv = state.conversations[cid];
    const isGroupConv = conv?.type === 'group' || conv?.type === 'ops_channel';
    const senderName = isGroupConv
      ? (state.groupMemberNames?.[cid]?.[tail.sender_id] ?? undefined)
      : (conv?.name ?? undefined);
    const badgeCount = Object.values(state.conversations).reduce(
      (n, c) => n + (c.unread_count || 0), 0,
    );
    // Preview text only when the user opted in (default off → name-only banner,
    // no plaintext in the notification).
    const body = contentPreviewEnabled
      ? previewForNotif(tail as {type?: string; content?: string})
      : undefined;
    void post(cid, {
      title: conv?.name,
      body,
      senderName: body ? senderName : undefined,
      badgeCount,
    });
  }
}

export function startBackgroundMessageNotifier(): void {
  if (running || Platform.OS !== 'android') {return;}
  running = true;
  void loadPreviewPref();
  try {
    const {useMessengerStore} = require('../store/messengerStore') as StoreModule;
    // Baseline the watermarks so nothing already in the store notifies.
    for (const [cid, list] of Object.entries(useMessengerStore.getState().messages)) {
      const tail = list[list.length - 1];
      if (tail) {lastTailByConvo.set(cid, tail.id);}
    }
    unsubStore = useMessengerStore.subscribe((state, prev) => {
      try { onStoreChange(state, prev); } catch (e) {
        console.warn('[bgMsgNotifier] change handler failed:', (e as Error).message);
      }
    });
    appStateSub = AppState.addEventListener('change', st => {
      if (st === 'active') {void cancelAllPosted();}
    });
    console.log('[bgMsgNotifier] started');
  } catch (e) {
    running = false;
    console.warn('[bgMsgNotifier] start failed:', (e as Error).message);
  }
}

export function stopBackgroundMessageNotifier(): void {
  if (!running) {return;}
  running = false;
  unsubStore?.();
  unsubStore = null;
  appStateSub?.remove();
  appStateSub = null;
  void cancelAllPosted();
  lastTailByConvo.clear();
}
