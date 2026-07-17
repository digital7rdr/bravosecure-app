/**
 * Pure decision helpers for the Pro paywall flow, extracted so the
 * branching logic can be unit-tested without mounting the screen or
 * Stripe (mirrors booking/creditMath.ts).
 */
import axios from 'axios';

/**
 * Did a failed `subscribeToPro()` fail specifically because the wallet was
 * short on Bravo Credits? Only then do we fall through to the card top-up;
 * any other error means "stay on Lite, surface the message".
 */
export function isInsufficientCreditsError(e: unknown): boolean {
  if (!axios.isAxiosError(e)) {return false;}
  const code = (e.response?.data as {message?: string} | undefined)?.message;
  return code === 'insufficient_credits';
}

export type PaywallOutcome =
  | {kind: 'subscribed'}            // tier flipped to pro
  | {kind: 'topup-then-subscribe'}  // short on BC → charge card, retry
  | {kind: 'cancelled'}             // user dismissed PaymentSheet → stays Lite, silent
  | {kind: 'stay-on-lite'; reason: string}; // failure → stays Lite, surface reason

/**
 * Resolve what the paywall should do after the FIRST subscribe attempt.
 * Keeps the screen's effect free of branching it can't easily test.
 */
export function outcomeForSubscribeError(e: unknown): PaywallOutcome {
  if (isInsufficientCreditsError(e)) {
    return {kind: 'topup-then-subscribe'};
  }
  return {
    kind: 'stay-on-lite',
    reason: e instanceof Error ? e.message : 'Please try again.',
  };
}
