import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomInt, createHash} from 'node:crypto';

@Injectable()
export class OtpService {
  constructor(private readonly config: ConfigService) {}

  generate(): string {
    const len = this.config.get<number>('otp.length') ?? 6;
    const max = 10 ** len;
    return String(randomInt(0, max)).padStart(len, '0');
  }

  hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  async send(to: string, code: string): Promise<void> {
    const ttl = this.config.get<number>('otp.ttlMinutes') ?? 10;

    if (this.config.get<boolean>('otp.devBypass')) {
      // DEV ONLY — OTP send is a no-op. Any code will pass check(). See configuration.ts.
      return;
    }

    if (this.config.get<boolean>('otp.devReturnCode')) {
      // Dev mode: OTP is returned in the API response body — no logging, no SMS.
      return;
    }

    const sid      = this.config.get<string>('twilio.accountSid');
    const tok      = this.config.get<string>('twilio.authToken');
    const verifySid = this.config.get<string>('twilio.verifySid');

    if (sid && tok && verifySid) {
      // Twilio Verify API — preferred: delivers and manages OTP lifecycle via Twilio.
      const {Twilio} = await import('twilio');
      const client = new Twilio(sid, tok);
      await client.verify.v2.services(verifySid).verifications.create({
        to,
        channel: 'sms',
      });
      return;
    }

    // Fallback: Programmable SMS when Verify service SID not provisioned.
    const from = this.config.get<string>('twilio.fromNumber');
    if (!sid || !tok || !from) {
      throw new Error('Twilio credentials not configured (need TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM or TWILIO_VERIFY_SID)');
    }
    const {Twilio} = await import('twilio');
    const client = new Twilio(sid, tok);
    await client.messages.create({
      to,
      from,
      body: `Your Bravo Secure code: ${code}. Valid for ${ttl} minutes.`,
    });
  }

  /**
   * Check a user-submitted OTP against Twilio Verify.
   * Returns true if Twilio marks the verification "approved".
   * Only used when TWILIO_VERIFY_SID is configured (the spec-mandated path).
   */
  async check(to: string, code: string): Promise<boolean> {
    if (this.config.get<boolean>('otp.devBypass')) {
      // DEV ONLY — any non-empty 4-8 digit code passes.
      return /^\d{4,8}$/.test(code);
    }

    const sid       = this.config.get<string>('twilio.accountSid');
    const tok       = this.config.get<string>('twilio.authToken');
    const verifySid = this.config.get<string>('twilio.verifySid');
    if (!sid || !tok || !verifySid) {
      throw new Error('Twilio Verify not configured (TWILIO_VERIFY_SID required for OTP check)');
    }
    const {Twilio} = await import('twilio');
    const client = new Twilio(sid, tok);
    try {
      const res = await client.verify.v2
        .services(verifySid)
        .verificationChecks.create({to, code});
      return res.status === 'approved';
    } catch (e: unknown) {
      // Twilio returns 404 when the verification has expired or already been consumed —
      // treat as a failed check (not a server error).
      const err = e as {status?: number};
      if (err?.status === 404) return false;
      throw e;
    }
  }
}
