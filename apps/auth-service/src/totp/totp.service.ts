import {Injectable, NotFoundException, BadRequestException} from '@nestjs/common';
import {DatabaseService}     from '../database/database.service';
import {AuditService}        from '../kafka/audit.service';
import {TotpCryptoService}   from '../common/services/totp-crypto.service';
import {AuthService}         from '../auth/auth.service';
import {RedisService}        from '../redis/redis.service';
import type {TotpVerifyDto}  from './dto/totp-verify.dto';

import type {UserRow} from '../auth/auth.service';

@Injectable()
export class TotpService {
  // P0-V2 — RFC 6238 §5.2 throttling. 10 wrong codes per 15-min window
  // → 15-min lock. Backup codes count too — there are only ~10 of them,
  // so a brute-forcer who exhausts the TOTP space can't pivot to
  // unlimited backup-code guessing.
  private static readonly TOTP_LOCKOUT_THRESHOLD = 10;
  private static readonly TOTP_LOCKOUT_SECONDS   = 15 * 60;

  constructor(
    private readonly db:          DatabaseService,
    private readonly audit:       AuditService,
    private readonly totpCrypto:  TotpCryptoService,
    private readonly authService: AuthService,
    private readonly redis:       RedisService,
  ) {}

  // ── Setup — generate secret, encrypt, persist, return QR + backup codes ──
  async setup(userId: string, deviceId: string, ip: string) {
    const user = await this.db.qOne<{email:string}>(
      `SELECT email FROM public.users WHERE id=$1`, [userId]);
    if (!user) throw new NotFoundException('user_not_found');

    const {secret, uri}         = this.totpCrypto.generateSecret(user.email);
    const encrypted              = this.totpCrypto.encryptSecret(secret);
    const {plain, hashes}        = this.totpCrypto.generateBackupCodes();

    await this.db.q(
      `INSERT INTO public.auth_totp_secrets (user_id,secret_encrypted)
       VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_encrypted=EXCLUDED.secret_encrypted, verified_at=NULL`,
      [userId, encrypted],
    );

    await this.db.q(`DELETE FROM public.auth_totp_backup_codes WHERE user_id=$1`, [userId]);
    for (const hash of hashes) {
      await this.db.q(
        `INSERT INTO public.auth_totp_backup_codes (id,user_id,code_hash)
         VALUES (gen_random_uuid(),$1,$2)`,
        [userId, hash],
      );
    }

    await this.audit.emit({event_type:'auth.totp.setup', user_id:userId, device_id:deviceId, ip, outcome:'success'});
    return {uri, backupCodes: plain};
  }

  // ── Verify — TOTP code or backup code → tokens ───────────────────────────
  async verify(dto: TotpVerifyDto, ip: string) {
    // P0-V2: per-userId attempt counter + lockout. The endpoint is
    // unauthenticated by design (TOTP IS the auth step), so per-account
    // throttling — not per-IP — is the only effective gate against a
    // botnet brute-forcing the 6-digit code. RFC 6238 §5.2. Return the
    // same shape as `totp_invalid` so the lockout state doesn't leak
    // via response timing or code differences.
    if (await this.redis.isTotpLocked(dto.userId)) {
      await this.audit.emit({event_type:'auth.totp.verify' as const, user_id:dto.userId, device_id:dto.deviceId, ip, outcome:'failure', detail:'locked'});
      throw new BadRequestException('totp_invalid');
    }

    const row = await this.db.qOne<{secret_encrypted:Buffer; verified_at:Date|null}>(
      `SELECT secret_encrypted,verified_at FROM public.auth_totp_secrets WHERE user_id=$1`,
      [dto.userId],
    );
    if (!row) throw new BadRequestException('totp_not_setup');

    let ok = false;

    if (/^\d{6}$/.test(dto.code)) {
      const secret = this.totpCrypto.decryptSecret(row.secret_encrypted);
      ok = this.totpCrypto.verifyCode(secret, dto.code);
    }

    if (!ok && dto.code.length === 8) {
      const hash   = this.totpCrypto.hashBackupCode(dto.code);
      const backup = await this.db.qOne<{id:string}>(
        `SELECT id FROM public.auth_totp_backup_codes
          WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL`,
        [dto.userId, hash],
      );
      if (backup) {
        await this.db.q(`UPDATE public.auth_totp_backup_codes SET used_at=now() WHERE id=$1`, [backup.id]);
        ok = true;
      }
    }

    if (!ok) {
      // P0-V2: bump the per-userId counter and lock at the threshold.
      const failures = await this.redis.incrTotpFailures(dto.userId);
      if (failures >= TotpService.TOTP_LOCKOUT_THRESHOLD) {
        await this.redis.lockTotp(dto.userId, TotpService.TOTP_LOCKOUT_SECONDS);
      }
      await this.audit.emit({event_type:'auth.totp.verify' as const, user_id:dto.userId, device_id:dto.deviceId, ip, outcome:'failure', detail:'invalid_code'});
      throw new BadRequestException('totp_invalid');
    }

    // P0-V2: success resets the counter so a legit user who fat-fingered
    // one code doesn't carry a half-spent budget into the next session.
    await this.redis.clearTotpFailures(dto.userId);

    if (!row.verified_at) {
      await this.db.q(`UPDATE public.auth_totp_secrets SET verified_at=now() WHERE user_id=$1`, [dto.userId]);
    }

    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164
         FROM public.users WHERE id=$1 AND deleted_at IS NULL`,
      [dto.userId],
    );
    if (!user) throw new NotFoundException('user_not_found');

    const session = await this.authService.issueSession(user, dto.deviceId, dto.platform);
    await this.audit.emit({event_type:'auth.totp.verify' as const, user_id:dto.userId, device_id:dto.deviceId, ip, outcome:'success'});
    return {user, ...session};
  }
}
