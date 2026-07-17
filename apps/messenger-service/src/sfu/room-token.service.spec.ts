import {ConfigService} from '@nestjs/config';
import {InternalServerErrorException} from '@nestjs/common';
import {RoomTokenService} from './room-token.service';

const SECRET = 'sfu-room-token-secret-at-least-32-chars-long';

function svc(overrides: Record<string, unknown> = {}): RoomTokenService {
  const cfg: Partial<ConfigService> = {
    get: (k: string): unknown => ({
      'sfu.roomTokenSecret': SECRET,
      ...overrides,
    }[k] as unknown),
  };
  return new RoomTokenService(cfg as ConfigService);
}

describe('RoomTokenService — audit P0-C2', () => {
  it('issued token verifies for the matching (room, user)', () => {
    const s = svc();
    const {token} = s.issue('room-aaa', 'user-bob');
    expect(s.verify(token, 'room-aaa', 'user-bob')).toEqual({ok: true});
  });

  it('different userId fails verify (per-recipient binding)', () => {
    const s = svc();
    const {token} = s.issue('room-aaa', 'user-bob');
    const v = s.verify(token, 'room-aaa', 'user-eve');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('user_mismatch');
  });

  it('different roomId fails verify (per-room binding)', () => {
    const s = svc();
    const {token} = s.issue('room-aaa', 'user-bob');
    const v = s.verify(token, 'room-bbb', 'user-bob');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('room_mismatch');
  });

  it('tampered signature fails verify (HMAC integrity)', () => {
    const s = svc();
    const {token} = s.issue('room-aaa', 'user-bob');
    // Flip the last character of the signature block.
    const parts = token.split('|');
    const last = parts[3];
    parts[3] = last.slice(0, -1) + (last.endsWith('A') ? 'B' : 'A');
    const tampered = parts.join('|');
    const v = s.verify(tampered, 'room-aaa', 'user-bob');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('sig_mismatch');
  });

  it('expired token fails verify', () => {
    const s = svc();
    const {token} = s.issue('room-aaa', 'user-bob', -10); // already expired
    const v = s.verify(token, 'room-aaa', 'user-bob');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('expired');
  });

  it('rotated secret invalidates outstanding tokens', () => {
    const s1 = svc({'sfu.roomTokenSecret': SECRET});
    const {token} = s1.issue('room-aaa', 'user-bob');
    const s2 = svc({'sfu.roomTokenSecret': 'different-secret-32-chars-long-xxxxxx'});
    const v = s2.verify(token, 'room-aaa', 'user-bob');
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('sig_mismatch');
  });

  it('malformed tokens are rejected without crashing', () => {
    const s = svc();
    expect(s.verify('', 'r', 'u').ok).toBe(false);
    expect(s.verify('abc', 'r', 'u').ok).toBe(false);
    expect(s.verify('a|b|c', 'r', 'u').ok).toBe(false);
    expect(s.verify('a|b|c|d|e', 'r', 'u').ok).toBe(false);
  });

  it('throws when secret is not configured', () => {
    const s = svc({'sfu.roomTokenSecret': ''});
    expect(() => s.issue('r', 'u')).toThrow(InternalServerErrorException);
  });

  // Audit row #5 (M1) — default TTL bumped 10m → 30m to absorb iOS
  // PushKit cold-start + Android Doze thaw. Locks the default so a
  // future regression to 600s doesn't silently re-open the "ring
  // frame arrives, recipient wakes 12 min later, sfu.join returns
  // room_token_expired" failure.
  it('default TTL is 30 minutes (M1: PushKit cold-start absorption)', () => {
    const s = svc();
    const before = Math.floor(Date.now() / 1000);
    const {exp} = s.issue('room-aaa', 'user-bob');
    const after = Math.floor(Date.now() / 1000);
    // exp = now + 1800; allow 2-second slop for test scheduling.
    expect(exp).toBeGreaterThanOrEqual(before + 1800);
    expect(exp).toBeLessThanOrEqual(after + 1800);
  });
});
