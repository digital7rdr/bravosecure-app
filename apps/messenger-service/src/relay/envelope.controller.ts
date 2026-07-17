import {
  Controller, Post, Get, Body, Query, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {IsString, Matches, MinLength, MaxLength} from 'class-validator';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {Logger} from '@nestjs/common';
import {EnvelopeService} from './envelope.service';
import {PushService} from '../push/push.service';
import {SendEnvelopeDto} from './dto/send-envelope.dto';
import type {StoredEnvelope} from './envelope.types';
import {RecipientPurgeGuard} from './recipient-purge.guard';

/**
 * Declared BEFORE the controller class so the emitted
 * `design:paramtypes` metadata can resolve at module-eval time.
 * Moving this below the @Controller triggers a ReferenceError at
 * boot because class declarations are NOT hoisted like functions.
 */
class RetractDto {
  @IsString() @Matches(/^[0-9a-f-]{36}$/i)
  retractToken!: string;
}

/**
 * Sprint-6 — purge body. `supersededIdentity` is a base64 string the
 * caller knows because they JUST rotated away from it. Validated for
 * shape here; the actual rotation semantics are checked at the service
 * layer (currently just non-empty — see purgeStaleRecipientQueue).
 *
 * Length cap is generous (a libsignal identity pubkey base64 is ~44
 * bytes; a 256-char ceiling absorbs prefixes / future encodings).
 */
class PurgeStaleRecipientDto {
  @IsString() @MinLength(1) @MaxLength(256)
  supersededIdentity!: string;
}

/**
 * HTTP surface for the relay. Mirrors the WS handlers for clients that
 * prefer request/response semantics (backup path, corporate proxies
 * that block WS, etc). Same business logic underneath.
 */
@Controller('envelopes')
// Audit P0-5 — JwtHttpGuard MUST run first so `req.caller` is populated
// before UserThrottlerGuard reads it via `getTracker`. Nest invokes
// guards in array order; do not reorder.
@UseGuards(JwtHttpGuard, UserThrottlerGuard)
export class EnvelopeController {
  private readonly logger = new Logger(EnvelopeController.name);
  constructor(
    private readonly envelopes: EnvelopeService,
    private readonly push:      PushService,
  ) {}

  /**
   * Audit P0-5 — `POST /envelopes` is the highest-volume relay surface
   * and the prime DoS target (one POST = 1 sealed-archive write + 1
   * FCM push + N Redis writes). Tightened cap of 30 sends per 10 s per
   * authenticated user — well above any legitimate keyboard-driven
   * cadence and well below the rate at which a stolen token could
   * torch FCM quota.
   */
  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async send(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: SendEnvelopeDto,
  ): Promise<{envelopeId: string; clientMsgId?: string; deliveredNow: boolean}> {
    // Sealed Sender: we intentionally do NOT pass caller identity into
    // the service — the server must not link the stored envelope to
    // the submitter. The JWT was verified by the guard for rate-limit
    // / abuse purposes only and its scope ends here.
    const res = await this.envelopes.submitEnvelope({
      recipient:    dto.recipient,
      outerSealed:  dto.outerSealed,
      clientMsgId:  dto.clientMsgId,
      expiresAtSec: dto.expiresAtSec,
    });

    // Audit PUSH-B1 (2026-07-02): fire a chat-wake so a backgrounded/killed
    // recipient gets a heads-up banner. The WS handler (envelope.send) does
    // this, but ALL group fan-out and every outbox/reconnect re-send go over
    // THIS HTTP path — so without this call those messages produced no
    // notification at all until the recipient next opened the app. Mirrors
    // the gateway wake: sender id is the authenticated caller (the same
    // metadata the gateway already discloses to sendChatWake for the 1:1
    // path — no new trust boundary, and NOTHING is persisted). Best-effort:
    // a push failure must never fail the accepted send.
    //
    // Audit P2-BR-3 — only wake when the client marked this envelope urgent
    // (default true) AND the relay accepted a fresh, non-expired envelope.
    // `wakeEligible=false` covers a dedup HIT (retried send whose original
    // already woke the device) and an already-expired submit; `urgent=false`
    // covers non-displayable envelopes (reactions, group-control/rekey) that
    // must sync silently rather than banner a killed device.
    if (dto.urgent !== false && res.wakeEligible) {
      void this.push.sendChatWake(dto.recipient.userId, {
        senderUserId: caller.claims.sub,
      }).catch(e => this.logger.warn(`push.chat.dispatch-failed: ${(e as Error).message}`));
    }

    return res;
  }

  /**
   * Audit P0-5 — `GET /envelopes` is hit on every reconnect drain.
   * Looser cap (120 / 10s) because legitimate clients can legitimately
   * pull multiple pages back-to-back on a fresh device with a deep
   * inbox.
   */
  @Throttle({default: {limit: 120, ttl: 10_000}})
  @Get()
  async pull(
    @CurrentCaller() caller: CallerContext,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('bootstrap') bootstrap?: string,
  ): Promise<{envelopes: StoredEnvelope[]}> {
    const afterTs = after ? Number.parseInt(after, 10) || 0 : 0;
    // Restore-after-reinstall fix #4 — `bootstrap=1` raises the cap
    // to relay.maxBootstrapLimit in the service. Defaults stay 50/100
    // for the steady-state catch-up path.
    const isBootstrap = bootstrap === '1' || bootstrap === 'true';
    const lim = limit ? Number.parseInt(limit, 10) || (isBootstrap ? 1000 : 50) : (isBootstrap ? 1000 : 50);
    const envelopes = await this.envelopes.pull(
      {userId: caller.claims.sub, deviceId: caller.signalDeviceId},
      afterTs,
      lim,
      {bootstrap: isBootstrap},
    );
    // Audit P1-T6 — previously logged the caller's userId sub-prefix on
    // every pull. Even a uuid prefix is a per-request PII leak when
    // multiplied across millions of pulls + the rest of the logging
    // context (timestamp, device id) — enough to correlate activity
    // patterns from `docker logs`. The line was a holdover from the
    // initial "verify the relay works" diagnostic period. Gate behind
    // an explicit dev flag so the verbose breadcrumb can be re-enabled
    // for forensic investigation without leaking by default.
    if (process.env['RELAY_PULL_DEBUG_LOG'] === '1') {
      // eslint-disable-next-line no-console
      console.log(`[pull-debug] sub=${caller.claims.sub.slice(0, 8)} sigDev=${caller.signalDeviceId} after=${afterTs} limit=${lim} bootstrap=${isBootstrap} → returned=${envelopes.length}`);
    }
    return {envelopes};
  }

  /**
   * Audit P0-5 — ack mirrors send cadence (one ack per delivered
   * envelope). 60/10s is roomy for a normal drain and well below the
   * cost of an abusive loop.
   */
  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Post(':id/ack')
  @HttpCode(HttpStatus.NO_CONTENT)
  async ack(
    @CurrentCaller() caller: CallerContext,
    @Param('id') envelopeId: string,
    // Audit P0-N9 — body carries the possession-proof token issued
    // in the pull response. Optional during the rollout window so
    // legacy clients still ack pending envelopes; the service emits
    // a warning when the token is missing and rejects when the
    // operator has flipped `relay.requireAckToken=true`.
    // Handoff §3.6(c) — optional ack-outcome. Anything other than the
    // literal 'discarded' (missing, junk, legacy clients) is treated as
    // 'delivered' so old clients keep today's behavior.
    @Body() body?: {ackToken?: string; disposition?: string},
  ): Promise<void> {
    await this.envelopes.ack(
      {userId: caller.claims.sub, deviceId: caller.signalDeviceId},
      envelopeId,
      body?.ackToken,
      body?.disposition === 'discarded' ? 'discarded' : 'delivered',
    );
  }

  /**
   * M12: sender-initiated retract. The client presents the retract
   * token it received from the submit response. Single-use; replays
   * return `{retracted: false}` idempotently.
   *
   * Does NOT use @CurrentCaller intentionally — the capability token
   * is the only auth needed here. Still gated by JwtHttpGuard at the
   * controller level so anonymous spam is blocked.
   */
  @Post('retract')
  @HttpCode(HttpStatus.OK)
  async retract(@Body() dto: RetractDto): Promise<{retracted: boolean}> {
    return this.envelopes.retract(dto.retractToken);
  }

  /**
   * Sprint-6 — purge queued envelopes addressed to the caller's
   * superseded identity. Called by the client immediately after
   * `installIdentity` publishes a new identity; the queued envelopes
   * are unrecoverable on the client at this point so leaving them on
   * the relay just blocks the drain for 30 days.
   *
   * Authorisation is the JWT (account ownership) + the deviceId from
   * the X-Signal-Device-Id header (only the caller's queue is touched).
   * The `supersededIdentity` body field is the possession-proof hint
   * but the relay can't cryptographically check each envelope's outer
   * wrap against it — outerSealed is opaque by design.
   */
  /**
   * Audit P1-T2 — `RecipientPurgeGuard` requires a fresh MFA action
   * token (purpose=`recipient_purge`, max age 5 min) bound to the same
   * sub+device as the access JWT. Closes the "stolen JWT can wipe the
   * legitimate user's inbox" hole — the attacker would need the MFA
   * proof minted by an identity-rotation ceremony, which auth-service
   * only issues to a device that has just completed biometric/TOTP.
   */
  @UseGuards(RecipientPurgeGuard)
  @Post('purge-stale-recipient')
  @HttpCode(HttpStatus.OK)
  async purgeStaleRecipient(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: PurgeStaleRecipientDto,
  ): Promise<{purged: number}> {
    return this.envelopes.purgeStaleRecipientQueue(
      {userId: caller.claims.sub, deviceId: caller.signalDeviceId},
      dto.supersededIdentity,
    );
  }
}
