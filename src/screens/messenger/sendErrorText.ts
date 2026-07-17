/**
 * sendErrorText (B-74) — map a send-pipeline exception to user-facing banner
 * text. Raw libsignal/session errors (e.g. `No record for <userId>.<deviceId>`)
 * leak internal ids and mean nothing to the user; the bubble already flips to
 * 'failed' with a retry chip (M-15), so the banner only needs a human
 * explanation. Deliberately user-readable pipeline errors (e.g. "group too
 * large to send") pass through, with any raw userId(.deviceId) addresses
 * redacted. Pure → unit-tested.
 */

// Session/crypto-internal failures where the raw message is technician-speak.
const SESSION_ERROR =
  /no record for|no session|session record|bad mac|invalid key|untrusted identity|identity key/i;

// A libsignal address is `<uuid>.<deviceId>`; bare uuids also count.
const UUID_ADDRESS =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.\d+)?/gi;

export const SESSION_REESTABLISH_TEXT =
  'Secure session is re-establishing — the message wasn’t sent. Tap it to retry.';

export function sendErrorText(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : '';
  if (!raw) {return fallback;}
  if (SESSION_ERROR.test(raw)) {return SESSION_REESTABLISH_TEXT;}
  return raw.replace(UUID_ADDRESS, 'contact');
}
