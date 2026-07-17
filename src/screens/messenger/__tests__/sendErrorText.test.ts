import {sendErrorText, SESSION_REESTABLISH_TEXT} from '../sendErrorText';

describe('sendErrorText (B-74) — user-facing send-error banner text', () => {
  it('maps the raw libsignal "No record for <address>" to the session message', () => {
    const e = new Error('No record for 3165d0e1-0d3f-4d8c-be5d-a4b85d11b453.1');
    expect(sendErrorText(e, 'Send failed')).toBe(SESSION_REESTABLISH_TEXT);
  });

  it('maps other session/crypto-internal errors to the session message', () => {
    for (const msg of [
      'NoSessionError: no session for peer',
      'Bad MAC',
      'Invalid key length',
      'Untrusted identity key for conversation',
    ]) {
      expect(sendErrorText(new Error(msg), 'Send failed')).toBe(SESSION_REESTABLISH_TEXT);
    }
  });

  it('passes deliberately user-readable pipeline errors through', () => {
    const e = new Error('group too large to send (300 > 250 recipients)');
    expect(sendErrorText(e, 'Send failed')).toBe('group too large to send (300 > 250 recipients)');
  });

  it('redacts a bare uuid/address inside a pass-through message', () => {
    const e = new Error('relay rejected envelope for c700ccde-0e7a-4d4c-b644-076524be9b81.1');
    expect(sendErrorText(e, 'Send failed')).toBe('relay rejected envelope for contact');
  });

  it('falls back for non-Error throws and empty messages', () => {
    expect(sendErrorText('boom', 'Retry failed')).toBe('Retry failed');
    expect(sendErrorText(new Error(''), 'Media send failed')).toBe('Media send failed');
    expect(sendErrorText(undefined, 'Send failed')).toBe('Send failed');
  });
});
