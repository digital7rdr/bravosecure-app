import {Body, Controller, Get, Headers, HttpCode, Post, Req, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {StripeClient} from '../wallet/stripe.client';
import {SubscriptionService, type SubscribeResult} from './subscription.service';

/**
 * Subscription REST surface (all routes under /subscription).
 *
 * POST /subscription/pro            — debit Pro price in BC + flip tier; pass
 *                                      {auto_renew:true} to also create a
 *                                      Stripe recurring subscription.
 * POST /subscription/pro/cancel     — stop auto-renew (keep paid period).
 * POST /subscription/stripe-webhook — Stripe invoice / subscription events.
 */
@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscription: SubscriptionService,
    private readonly stripe: StripeClient,
  ) {}

  // A paid mutation — throttle to blunt accidental double-submit storms.
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @Post('pro')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async subscribePro(
    @CurrentUser() user: AccessClaims,
    @Body() body: {auto_renew?: boolean},
  ): Promise<SubscribeResult> {
    return this.subscription.subscribeToPro(user.sub, {autoRenew: body?.auto_renew === true});
  }

  // M1A — Messenger Enterprise (individual paid tier; the service-provider
  // org tenant is a separate funnel and does not subscribe here).
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @Post('enterprise')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async subscribeEnterprise(
    @CurrentUser() user: AccessClaims,
    @Body() body: {auto_renew?: boolean},
  ): Promise<SubscribeResult> {
    return this.subscription.subscribeToTier(user.sub, 'enterprise', {autoRenew: body?.auto_renew === true});
  }

  @Post('pro/cancel')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async cancelAutoRenew(@CurrentUser() user: AccessClaims): Promise<{cancelled: boolean}> {
    return this.subscription.cancelAutoRenew(user.sub);
  }

  /** M1A/S9 — live tier prices in BC (ops-editable, charged at charge time). */
  @Get('prices')
  @UseGuards(JwtAuthGuard)
  async prices(): Promise<{pro: number; enterprise: number}> {
    return this.subscription.getPrices();
  }

  /**
   * Stripe → server webhook for subscription lifecycle (invoice.paid,
   * invoice.payment_failed, customer.subscription.deleted). Public — relies
   * on HMAC signature verification, not JWT. Must receive the raw body
   * (rawBody:true in main.ts).
   */
  @Post('stripe-webhook')
  @HttpCode(200)
  async stripeWebhook(
    @Req() req: Request & {rawBody?: Buffer},
    @Headers('stripe-signature') signature?: string,
  ): Promise<{received: true}> {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const event = this.stripe.verifyWebhook(raw, signature);
    await this.subscription.handleSubscriptionEvent(event);
    return {received: true};
  }
}
