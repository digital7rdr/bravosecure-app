/**
 * B-88 — branded replacement for React Native's `Alert.alert`.
 *
 * The native Android AlertDialog renders in the SYSTEM theme (white
 * card, purple Material buttons) on top of the obsidian app — 248 call
 * sites shipped that clash. This module keeps the EXACT `Alert.alert`
 * signature so call sites don't change; only their import line does:
 *
 *   import {Alert} from '@utils/alert';   // was: from 'react-native'
 *
 * The queue here is PURE (no react-native imports) so it stays
 * unit-testable in a node env; `BravoAlertHost` (mounted once in
 * App.tsx) subscribes and renders the obsidian/cobalt dialog inside a
 * transparent RN Modal — which stacks above any other open Modal on
 * Android, matching how the native dialog floated above everything.
 *
 * Semantics mirror RN Android:
 *   - no buttons → single "OK"
 *   - back / backdrop dismisses when `options.cancelable` (default true,
 *     as in RN Android) and fires `options.onDismiss` — button onPress
 *     handlers are NOT called on a dismiss.
 *   - alerts issued while one is visible queue FIFO.
 */

export interface BravoAlertButton {
  text?:    string;
  onPress?: () => void;
  style?:   'default' | 'cancel' | 'destructive';
}

export interface BravoAlertOptions {
  cancelable?: boolean;
  onDismiss?:  () => void;
}

export interface BravoAlertRequest {
  id:       number;
  title:    string;
  message?: string;
  buttons:  BravoAlertButton[];
  options?: BravoAlertOptions;
}

let nextId = 1;
let queue: BravoAlertRequest[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* one bad subscriber mustn't break the rest */ }
  }
}

export function subscribeAlerts(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The alert currently on screen (head of the queue), or null. */
export function currentAlert(): BravoAlertRequest | null {
  return queue[0] ?? null;
}

function show(
  title: string,
  message?: string,
  buttons?: BravoAlertButton[],
  options?: BravoAlertOptions,
): void {
  queue = [...queue, {
    id:      nextId++,
    title:   String(title ?? ''),
    message: message === undefined || message === null ? undefined : String(message),
    buttons: buttons && buttons.length > 0 ? buttons : [{text: 'OK'}],
    options,
  }];
  notify();
}

/** A button was pressed — advance the queue, THEN run its handler (so a handler that opens another alert queues cleanly). */
export function pressAlertButton(id: number, button: BravoAlertButton): void {
  if (queue[0]?.id !== id) {return;}
  queue = queue.slice(1);
  notify();
  try { button.onPress?.(); } catch { /* caller's handler threw — the dialog must still close */ }
}

/**
 * Backdrop tap / hardware back. Only acts when the request is
 * cancelable (RN Android default: true); fires onDismiss, never a
 * button handler — mirrors the native dialog.
 */
export function dismissCurrentAlert(): void {
  const current = queue[0];
  if (!current) {return;}
  if (current.options?.cancelable === false) {return;}
  queue = queue.slice(1);
  notify();
  try { current.options?.onDismiss?.(); } catch { /* best-effort */ }
}

/** Test seam. */
export function _resetAlertsForTest(): void {
  queue = [];
  notify();
}

export type AlertButtonVariant = 'primary' | 'secondary' | 'cancel' | 'destructive';

/**
 * Pure presentation mapping (unit-tested):
 *   - cancel      → glass button
 *   - destructive → red-tinted button
 *   - default     → cobalt; when several defaults exist, only the LAST
 *                   is the filled primary (one-primary-action rule)
 *   - axis: ≤2 buttons side-by-side (cancel pinned left), 3+ stacked
 */
export function resolveAlertLayout(buttons: BravoAlertButton[]): {
  axis: 'row' | 'column';
  items: Array<{button: BravoAlertButton; variant: AlertButtonVariant}>;
} {
  const lastDefaultIdx = buttons.reduce(
    (acc, b, i) => ((b.style ?? 'default') === 'default' ? i : acc), -1);
  const items = buttons.map((button, i) => {
    const style = button.style ?? 'default';
    const variant: AlertButtonVariant =
      style === 'cancel' ? 'cancel'
      : style === 'destructive' ? 'destructive'
      : i === lastDefaultIdx ? 'primary'
      : 'secondary';
    return {button, variant};
  });
  if (items.length <= 2) {
    // Cancel reads left in a row (native Android order).
    items.sort((a, b) => (a.variant === 'cancel' ? -1 : 0) - (b.variant === 'cancel' ? -1 : 0));
    return {axis: 'row', items};
  }
  return {axis: 'column', items};
}

/** Drop-in for `import {Alert} from 'react-native'`. */
export const Alert = {
  alert: show,
};
