import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService}       from '@nestjs/config';
import {OtpService}          from './otp.service';

// Mock twilio before any imports so the dynamic import() in send() is intercepted
const mockCreate          = jest.fn().mockResolvedValue({});
const mockVerifyCreate    = jest.fn().mockResolvedValue({});
const mockTwilioClient    = {
  messages: {create: mockCreate},
  verify:   {v2: {services: jest.fn().mockReturnValue({verifications: {create: mockVerifyCreate}})}},
};
const mockTwilioCtor      = jest.fn().mockReturnValue(mockTwilioClient);
jest.mock('twilio', () => ({default: mockTwilioCtor, Twilio: mockTwilioCtor}));

function makeConfig(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'otp.length':        6,
    'otp.ttlMinutes':    10,
    'otp.devReturnCode': false,
    'twilio.accountSid': '',
    'twilio.authToken':  '',
    'twilio.fromNumber': '',
    'twilio.verifySid':  '',
  };
  return {get: jest.fn((k: string) => overrides[k] ?? defaults[k])} as unknown as ConfigService;
}

async function build(cfg: ConfigService): Promise<OtpService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [OtpService, {provide: ConfigService, useValue: cfg}],
  }).compile();
  return module.get(OtpService);
}

describe('OtpService', () => {
  // ── generate ──────────────────────────────────────────────────────────────
  describe('generate()', () => {
    it('returns a 6-digit zero-padded numeric string by default', async () => {
      const svc = await build(makeConfig());
      const code = svc.generate();
      expect(code).toMatch(/^\d{6}$/);
    });

    it('respects a custom otp.length of 4', async () => {
      const svc = await build(makeConfig({'otp.length': 4}));
      expect(svc.generate()).toMatch(/^\d{4}$/);
    });

    it('generates different values on successive calls (probabilistic)', async () => {
      const svc = await build(makeConfig());
      const codes = new Set(Array.from({length: 10}, () => svc.generate()));
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  // ── hash ─────────────────────────────────────────────────────────────────
  describe('hash()', () => {
    it('returns a 64-char lowercase hex string (SHA-256)', async () => {
      const svc = await build(makeConfig());
      expect(svc.hash('123456')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic — same input → same output', async () => {
      const svc = await build(makeConfig());
      expect(svc.hash('000000')).toBe(svc.hash('000000'));
    });

    it('is sensitive to input — different code → different hash', async () => {
      const svc = await build(makeConfig());
      expect(svc.hash('111111')).not.toBe(svc.hash('222222'));
    });
  });

  // ── send — dev bypass ─────────────────────────────────────────────────────
  describe('send() — dev bypass', () => {
    it('returns without throwing when devReturnCode=true (no network)', async () => {
      const svc = await build(makeConfig({'otp.devReturnCode': true}));
      await expect(svc.send('+15555550101', '123456')).resolves.toBeUndefined();
    });
  });

  // ── send — Twilio Verify API path ─────────────────────────────────────────
  describe('send() — Twilio Verify API', () => {
    it('calls verify.v2.services().verifications.create when verifySid is set', async () => {
      mockVerifyCreate.mockResolvedValue({});
      const svc = await build(makeConfig({
        'otp.devReturnCode': false,
        'twilio.accountSid': 'ACtest',
        'twilio.authToken':  'tok',
        'twilio.verifySid':  'VAtest',
      }));
      await expect(svc.send('+15555550101', '123456')).resolves.toBeUndefined();
      expect(mockVerifyCreate).toHaveBeenCalledWith(
        expect.objectContaining({to: '+15555550101', channel: 'sms'}),
      );
    });
  });

  // ── send — SMS fallback path ───────────────────────────────────────────────
  describe('send() — SMS fallback', () => {
    it('calls messages.create when verifySid is blank but SMS credentials are set', async () => {
      mockCreate.mockResolvedValue({});
      const svc = await build(makeConfig({
        'otp.devReturnCode': false,
        'twilio.accountSid': 'ACtest',
        'twilio.authToken':  'tok',
        'twilio.fromNumber': '+19999999999',
        'twilio.verifySid':  '',
      }));
      await expect(svc.send('+15555550101', '123456')).resolves.toBeUndefined();
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({to: '+15555550101', from: '+19999999999'}),
      );
    });
  });

  // ── send — missing credentials ─────────────────────────────────────────
  describe('send() — missing Twilio credentials', () => {
    it('throws when no credentials are configured', async () => {
      const svc = await build(makeConfig({'otp.devReturnCode': false}));
      await expect(svc.send('+15555550101', '123456')).rejects.toThrow(/credentials not configured/i);
    });
  });
});
