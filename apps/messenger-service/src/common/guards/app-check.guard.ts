import {Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger} from '@nestjs/common';
import type {Request} from 'express';
import * as admin from 'firebase-admin';

/**
 * P0-N9 — Firebase App Check / Apple App Attest token verification.
 *
 * Without this, any caller with a valid JWT can register an attacker-
 * controlled FCM/APNs token in the victim's slot — all subsequent
 * chat-wakes and VoIP-wakes for the victim then ring the attacker's
 * device instead. The JWT only proves "I have an authed account"; it
 * does NOT prove "this request came from the legit Bravo Secure binary
 * on a non-rooted device."
 *
 * App Check tokens are minted by the Firebase / Apple attestation flow
 * on the client and verified by Firebase Admin server-side. Token TTL
 * is short (default 1h), tokens are single-use when consume:true is
 * passed to verifyToken — eliminates replay.
 *
 * Operator mode toggle via env:
 *   APP_CHECK_MODE = 'enforce' (default in prod) — reject missing/invalid.
 *   APP_CHECK_MODE = 'warn-only'                 — log + admit (rollout).
 *   APP_CHECK_MODE = 'disabled'                  — skip the guard entirely.
 *
 * Bootstrap requires `admin.initializeApp()` to have run with a
 * credential that has App Check permissions. Existing FCM init in
 * push.service.ts already does this — we reuse the default app.
 */
@Injectable()
export class AppCheckGuard implements CanActivate {
  private readonly log = new Logger(AppCheckGuard.name);
  private warnedMissingMode = false;

  private get mode(): 'enforce' | 'warn-only' | 'disabled' {
    const raw = (process.env.APP_CHECK_MODE ?? '').toLowerCase();
    if (raw === 'disabled')  return 'disabled';
    if (raw === 'warn-only') return 'warn-only';
    if (raw === 'enforce')   return 'enforce';
    // Default: warn-only until mobile/ops-console ship the AppCheck
    // header end-to-end. Flip to 'enforce' via env once the client side
    // is rolled — `APP_CHECK_MODE=enforce`.
    if (!this.warnedMissingMode) {
      this.log.warn('APP_CHECK_MODE not set — defaulting to warn-only. Set APP_CHECK_MODE=enforce in production once clients ship the X-Firebase-AppCheck header.');
      this.warnedMissingMode = true;
    }
    return 'warn-only';
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.mode === 'disabled') return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = req.header('x-firebase-appcheck') ?? req.header('X-Firebase-AppCheck');

    if (!token || typeof token !== 'string') {
      if (this.mode === 'warn-only') {
        this.log.warn(`[app-check] missing token path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} — admitting under warn-only`);
        return true;
      }
      throw new UnauthorizedException('app_check_missing');
    }

    try {
      // consume:true forces single-use per token — replays fail.
      // Requires Firebase project with App Check enforcement enabled.
      await admin.appCheck().verifyToken(token, {consume: true});
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (this.mode === 'warn-only') {
        this.log.warn(`[app-check] verify failed path=${req.path} caller=${req.caller?.claims?.sub ?? '?'} reason=${msg} — admitting under warn-only`);
        return true;
      }
      throw new UnauthorizedException(`app_check_invalid: ${msg}`);
    }
  }
}
