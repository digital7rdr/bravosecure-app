import {BadRequestException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {WalletService} from '../wallet/wallet.service';
import {StripeClient, type StripeEvent} from '../wallet/stripe.client';

/**
 * Paid-tier prices, in Bravo Credits, for one 30-day period.
 *
 * Why constants (not config): product fixed Pro at 2000 BC for the
 * current SKU and the client paywall must show the same number. When the
 * pricing service lands this moves behind it; until then a single source
 * of truth here keeps server + client in lockstep.
 *
 * ⚠️ ENTERPRISE_MONTHLY_BC is a PLACEHOLDER (M1A Q-A — founder has not
 * priced the tier yet). Update here + the client paywall together.
 */
export const PRO_MONTHLY_BC = 2000;
export const ENTERPRISE_MONTHLY_BC = 5000;

export type PaidTier = 'pro' | 'enterprise';

export const TIER_PRICES_BC: Record<PaidTier, number> = {
  pro: PRO_MONTHLY_BC,
  enterprise: ENTERPRISE_MONTHLY_BC,
};

const TIER_LABELS: Record<PaidTier, string> = {
  pro: 'Bravo Pro subscription · 30 days',
  enterprise: 'Bravo Enterprise subscription · 30 days',
};

export interface SubscribeResult {
  subscription_tier: PaidTier;
  /** ISO timestamp the current paid period runs until (now + 30 days). */
  active_until: string;
  charged_credits: number;
  balance: {bravo_credits: number; currency: string};
  /** True when a Stripe auto-renewing subscription was also created. */
  auto_renew: boolean;
}

@Injectable()
export class SubscriptionService {
  private readonly log = new Logger(SubscriptionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly wallet: WalletService,
    private readonly stripe: StripeClient,
  ) {}

  /**
   * Activate (or renew) Pro for one 30-day period by debiting
   * {@link PRO_MONTHLY_BC} Bravo Credits and flipping
   * `public.users.subscription_tier` to `'pro'` — both inside ONE
   * transaction so a failed tier write rolls the debit back and a short
   * balance never half-charges the user.
   *
   * Throws `insufficient_credits` (400) when the wallet is short; the
   * mobile paywall maps that onto the card top-up fallback, identical to
   * the booking pay-with-credits contract.
   *
   * Idempotency note: this is a paid mutation, so callers must guard
   * against double-tap on the client (the paywall already does). We do
   * NOT silently no-op an already-Pro user — renewing extends the period
   * and is an explicit, paid action.
   */
  async subscribeToPro(userId: string, opts: {autoRenew?: boolean} = {}): Promise<SubscribeResult> {
    return this.subscribeToTier(userId, 'pro', opts);
  }

  /**
   * Live per-tier prices in BC — ops-editable (subscription_prices table).
   * Read at CHARGE TIME so a price change applies to every subsequent
   * subscribe/renewal while already-paid periods finish untouched. Falls
   * back to the compiled constants if the table is unreachable/missing.
   */
  async getPrices(): Promise<Record<PaidTier, number>> {
    try {
      const rows = await this.db.q<{tier: PaidTier; price_bc: number}>(
        `SELECT tier, price_bc FROM subscription_prices`,
      );
      const out = {...TIER_PRICES_BC};
      for (const r of rows) {
        if ((r.tier === 'pro' || r.tier === 'enterprise') && Number(r.price_bc) > 0) {
          out[r.tier] = Number(r.price_bc);
        }
      }
      return out;
    } catch (e) {
      this.log.warn(`price table read failed, using defaults: ${e instanceof Error ? e.message : e}`);
      return {...TIER_PRICES_BC};
    }
  }

  async subscribeToTier(
    userId: string,
    tier: PaidTier,
    opts: {autoRenew?: boolean} = {},
  ): Promise<SubscribeResult> {
    const price = (await this.getPrices())[tier];
    const result = await this.db.withTransaction(async tx => {
      const user = await tx.qOne<{id: string; subscription_tier: string; stripe_subscription_id: string | null}>(
        `SELECT id, subscription_tier, stripe_subscription_id FROM public.users
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [userId],
      );
      if (!user) throw new NotFoundException('user_not_found');

      // Debit first — throws insufficient_credits if short, which aborts
      // the transaction before any tier change is persisted.
      const balance = await this.wallet.debitForFeature(
        userId,
        price,
        TIER_LABELS[tier],
        {kind: `${tier}_subscription`, period_days: 30},
        tx,
      );

      // Same-tier renewal EXTENDS the paid window; a tier SWITCH starts a
      // fresh 30-day window (remaining time on the old tier is not converted
      // — the switch is an explicit, replacing purchase). bc_auto_renew
      // mirrors the caller's auto-renew choice: at period end the sweep
      // re-debits BC (Stripe, when configured, renews first and the BC path
      // never double-charges — it only fires with no live Stripe sub).
      const row = await tx.qOne<{pro_active_until: Date}>(
        `UPDATE public.users
            SET subscription_tier = $2,
                bc_auto_renew     = $3,
                pro_active_until  = CASE
                  WHEN subscription_tier = $2 THEN
                    GREATEST(COALESCE(pro_active_until, NOW()), NOW()) + INTERVAL '30 days'
                  ELSE NOW() + INTERVAL '30 days'
                END
          WHERE id = $1
          RETURNING pro_active_until`,
        [userId, tier, opts.autoRenew === true],
      );
      if (!row) throw new BadRequestException('tier_update_failed');

      return {
        balance,
        activeUntil: row.pro_active_until,
        switchedFrom: user.subscription_tier !== tier ? user.subscription_tier : null,
        staleStripeSub: user.subscription_tier !== tier ? user.stripe_subscription_id : null,
      };
    });

    this.log.log(`${tier} subscription activated user=${userId} (-${price} BC)`);

    // A tier switch must not leave the OLD tier's Stripe subscription
    // renewing in the background (it would re-flip the tier and charge the
    // card for the abandoned plan). Cancel it before any new auto-renew.
    if (result.staleStripeSub) {
      if (this.stripe.enabled) {
        await this.stripe.cancelSubscription(result.staleStripeSub).catch(e =>
          this.log.warn(`stale sub cancel failed user=${userId}: ${e instanceof Error ? e.message : e}`),
        );
      }
      await this.db.q(
        `UPDATE public.users
            SET stripe_subscription_id = NULL, pro_renew_status = 'canceled'
          WHERE id = $1 AND stripe_subscription_id = $2`,
        [userId, result.staleStripeSub],
      );
    }

    // Optionally set up Stripe auto-renewal AFTER the BC-funded first period
    // is committed. A failure here must NOT roll back the active period the
    // user already paid for in credits — we just leave auto_renew off.
    let autoRenew = false;
    if (opts.autoRenew && this.stripe.enabled) {
      try {
        autoRenew = await this.enableAutoRenew(userId, tier);
      } catch (e) {
        this.log.warn(`auto-renew setup failed user=${userId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    return {
      subscription_tier: tier,
      active_until: new Date(result.activeUntil).toISOString(),
      charged_credits: price,
      balance: {
        bravo_credits: result.balance.bravo_credits,
        currency: result.balance.currency,
      },
      auto_renew: autoRenew,
    };
  }

  /**
   * Create the Stripe auto-renewing subscription for an already-paid user.
   * Reuses the wallet's Stripe customer (so the saved card carries over).
   * Returns true if the subscription is live. An unconfigured price for the
   * tier throws (caught by the caller → BC-only period, auto_renew=false).
   */
  private async enableAutoRenew(userId: string, tier: PaidTier = 'pro'): Promise<boolean> {
    const wallet = await this.db.qOne<{stripe_customer_id: string | null}>(
      `SELECT stripe_customer_id FROM wallet_balances WHERE user_id = $1`,
      [userId],
    );
    const customerId = await this.stripe.ensureCustomer(userId, wallet?.stripe_customer_id ?? null);
    if (customerId !== wallet?.stripe_customer_id) {
      await this.db.q(
        `UPDATE wallet_balances SET stripe_customer_id = $1 WHERE user_id = $2`,
        [customerId, userId],
      );
    }
    const sub = await this.stripe.createSubscription({
      customerId,
      tier,
      metadata: {user_id: userId, kind: `${tier}_subscription`},
    });
    await this.db.q(
      `UPDATE public.users
          SET stripe_subscription_id = $1, pro_renew_status = $2
        WHERE id = $3`,
      [sub.id, sub.status, userId],
    );
    this.log.log(`auto-renew enabled user=${userId} sub=${sub.id} status=${sub.status}`);
    return sub.status === 'active' || sub.status === 'trialing';
  }

  /** User-initiated cancel: stop EVERY renewal path (Stripe card + BC).
   *  The current paid period (pro_active_until) is honoured — they keep
   *  the tier until it lapses, then the sweep downgrades to Lite. */
  async cancelAutoRenew(userId: string): Promise<{cancelled: boolean}> {
    const row = await this.db.qOne<{stripe_subscription_id: string | null; bc_auto_renew: boolean}>(
      `SELECT stripe_subscription_id, bc_auto_renew FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!row || (!row.stripe_subscription_id && !row.bc_auto_renew)) return {cancelled: false};
    if (row.stripe_subscription_id && this.stripe.enabled) {
      await this.stripe.cancelSubscription(row.stripe_subscription_id).catch(e =>
        this.log.warn(`stripe cancel failed user=${userId}: ${e instanceof Error ? e.message : e}`),
      );
    }
    await this.db.q(
      `UPDATE public.users
          SET stripe_subscription_id = NULL,
              bc_auto_renew          = FALSE,
              pro_renew_status       = 'canceled'
        WHERE id = $1`,
      [userId],
    );
    return {cancelled: true};
  }

  /**
   * Settle a Stripe subscription webhook event. Idempotent per state.
   *
   *  - invoice.paid              → extend pro_active_until 30 days, tier=pro
   *  - invoice.payment_failed    → mark past_due (grace until period end)
   *  - customer.subscription.deleted → downgrade to Lite once the period
   *                                     has lapsed (Stripe ended the sub)
   *
   * The renewal extends the PAID period without debiting BC — the card
   * paid the invoice. (The initial period was BC-funded at subscribe time.)
   */
  async handleSubscriptionEvent(event: StripeEvent): Promise<void> {
    const obj = event.data.object as {
      id?: string;
      subscription?: string;
      customer?: string;
      metadata?: Record<string, string>;
    };
    const userId = obj.metadata?.['user_id'];

    if (event.type === 'invoice.paid') {
      const subId = obj.subscription;
      const uid = userId ?? (await this.userIdForSubscription(subId));
      if (!uid) {this.log.warn(`invoice.paid for unknown sub ${subId}`); return;}
      // A renewal extends the CURRENT paid tier — an enterprise account's
      // renewal must not overwrite it with 'pro'. Invoice events don't
      // reliably carry the subscription's metadata, so trust the row: the
      // sub link belongs to whichever paid tier the account holds (a tier
      // switch cancels + clears the old link in subscribeToTier). A 'lite'
      // row here means the sweep lapsed them early — renewal restores the
      // tier the Stripe sub was created for when metadata says so, else pro.
      const metaTier = obj.metadata?.['kind'] === 'enterprise_subscription' ? 'enterprise' : 'pro';
      await this.db.q(
        `UPDATE public.users
            SET subscription_tier = CASE
                  WHEN subscription_tier IN ('pro','enterprise') THEN subscription_tier
                  ELSE $2
                END,
                pro_renew_status  = 'active',
                pro_active_until  = GREATEST(COALESCE(pro_active_until, NOW()), NOW())
                                    + INTERVAL '30 days'
          WHERE id = $1`,
        [uid, metaTier],
      );
      this.log.log(`paid tier auto-renewed user=${uid} (+30 days via card)`);
      return;
    }

    if (event.type === 'invoice.payment_failed') {
      const uid = userId ?? (await this.userIdForSubscription(obj.subscription));
      if (!uid) return;
      // Don't downgrade yet — Stripe retries; the user keeps Pro until the
      // current period lapses. Just record the failed state for the UI.
      await this.db.q(
        `UPDATE public.users SET pro_renew_status = 'past_due' WHERE id = $1`,
        [uid],
      );
      this.log.warn(`pro renewal payment failed user=${uid}`);
      return;
    }

    if (event.type === 'customer.subscription.deleted') {
      const uid = userId ?? (await this.userIdForSubscription(obj.id));
      if (!uid) return;
      // Stripe gave up (max retries) or the user cancelled. Drop the sub
      // link + downgrade to Lite once the paid period is past. If the
      // period is still in the future, the lapse-sweep handles it later.
      // RS-17 — a NULL pro_active_until is a PERMANENT / comp grant (manual
      // ops grant with no expiry) and is NEVER auto-downgraded, consistent
      // with sweepLapsedPro. Only a non-NULL, already-elapsed period flips
      // to 'lite' here; NULL keeps its tier.
      await this.db.q(
        `UPDATE public.users
            SET stripe_subscription_id = NULL,
                pro_renew_status       = 'canceled',
                subscription_tier      = CASE
                  WHEN pro_active_until IS NOT NULL AND pro_active_until <= NOW()
                  THEN 'lite' ELSE subscription_tier END
          WHERE id = $1`,
        [uid],
      );
      this.log.log(`pro subscription ended user=${uid}`);
      return;
    }
  }

  /**
   * Lapse sweep — downgrade any user whose paid Pro period has elapsed and
   * who is no longer entitled. Run periodically (cron). Two cases:
   *
   *  1. Ordinary lapse — no live auto-renew (stripe_subscription_id IS NULL)
   *     and the paid period has passed. The "never renewed / cancelled and
   *     let it run out" path.
   *  2. RS-18 backstop — a Stripe-linked row whose last known renew status
   *     is 'past_due'/'canceled' AND whose paid period is > 14 days past.
   *     This catches a MISSED `customer.subscription.deleted` webhook, which
   *     would otherwise leave the user Pro forever (case 1 requires a null sub
   *     link, so it never fires for these). The 14-day grace deliberately
   *     exceeds Stripe's smart-retry / dunning window so we only downgrade
   *     AFTER Stripe would itself have given up — a still-recoverable past_due
   *     sub in active retry is NOT prematurely swept. The status filter means a
   *     currently-renewing user (status 'active', future period) matches
   *     NEITHER branch and is never touched.
   *
   *  We do NOT clear `stripe_subscription_id` here. The sweep fires on a
   *  GUESS that the sub is dead; if a later smart-retry succeeds, `invoice.paid`
   *  must still correlate the row via the intact sub link (the invoice carries
   *  no user_id) and re-upgrade to Pro. Nulling the link would break that
   *  self-heal and strand a paying customer on Lite. Only the authoritative
   *  `customer.subscription.deleted` webhook clears the link. Re-sweep is
   *  self-limiting: once tier flips to 'lite' the row no longer matches.
   *
   *  RS-17 — `pro_active_until IS NULL` is an explicit PERMANENT / comp
   *  grant (manual ops grant, no expiry) and is NEVER auto-downgraded here;
   *  both branches require `pro_active_until IS NOT NULL`. Only a paid
   *  action or an explicit ops change can remove such a grant.
   */
  /**
   * M1A/S9 — BC auto-renew sweep. For every paid account whose window just
   * lapsed, that opted into auto-renew, and that has NO live Stripe sub
   * (the card path renews those via invoice.paid — this never double-
   * charges), debit the CURRENT price and extend 30 days. Runs BEFORE
   * sweepLapsedPro each tick: a successful renewal moves the window
   * forward so the downgrade sweep skips the row; a failed debit
   * (insufficient credits) leaves it to lapse normally.
   *
   * Per-row transaction with a re-checked FOR UPDATE lock — a concurrent
   * manual subscribe or second cron instance can't double-debit.
   */
  async renewFromCredits(now: Date = new Date()): Promise<{renewed: number; failed: number}> {
    const due = await this.db.q<{id: string; subscription_tier: PaidTier}>(
      `SELECT id, subscription_tier FROM public.users
        WHERE subscription_tier IN ('pro', 'enterprise')
          AND bc_auto_renew = TRUE
          AND stripe_subscription_id IS NULL
          AND pro_active_until IS NOT NULL
          AND pro_active_until <= $1
          AND deleted_at IS NULL
        LIMIT 200`,
      [now],
    );
    if (due.length === 0) return {renewed: 0, failed: 0};

    const prices = await this.getPrices();
    let renewed = 0, failed = 0;
    for (const u of due) {
      const tier = u.subscription_tier;
      const price = prices[tier];
      try {
        await this.db.withTransaction(async tx => {
          const locked = await tx.qOne<{id: string}>(
            `SELECT id FROM public.users
              WHERE id = $1 AND subscription_tier = $2 AND bc_auto_renew = TRUE
                AND stripe_subscription_id IS NULL
                AND pro_active_until IS NOT NULL AND pro_active_until <= $3
              FOR UPDATE`,
            [u.id, tier, now],
          );
          if (!locked) return; // renewed/changed concurrently — skip
          await this.wallet.debitForFeature(
            u.id, price, `${TIER_LABELS[tier]} · auto-renew`,
            {kind: `${tier}_subscription`, period_days: 30, auto_renew: true}, tx,
          );
          await tx.q(
            `UPDATE public.users
                SET pro_active_until = GREATEST(pro_active_until, NOW()) + INTERVAL '30 days'
              WHERE id = $1`,
            [u.id],
          );
          renewed++;
        });
      } catch (e) {
        failed++;
        this.log.warn(`BC auto-renew failed user=${u.id} tier=${tier}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (renewed > 0) this.log.log(`BC auto-renew sweep: ${renewed} renewed, ${failed} failed`);
    return {renewed, failed};
  }

  async sweepLapsedPro(now: Date = new Date()): Promise<{downgraded: number}> {
    const rows = await this.db.q<{id: string}>(
      `UPDATE public.users
          SET subscription_tier = 'lite'
        WHERE subscription_tier IN ('pro', 'enterprise')
          AND pro_active_until IS NOT NULL
          AND (
                (stripe_subscription_id IS NULL AND pro_active_until <= $1)
             OR (pro_renew_status IN ('past_due', 'canceled')
                 AND pro_active_until < ($1::timestamptz - INTERVAL '14 days'))
          )
        RETURNING id`,
      [now],
    );
    if (rows.length > 0) this.log.log(`paid-tier lapse sweep: ${rows.length} downgraded to lite`);
    return {downgraded: rows.length};
  }

  private async userIdForSubscription(subId: string | undefined): Promise<string | null> {
    if (!subId) return null;
    const row = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE stripe_subscription_id = $1`,
      [subId],
    );
    return row?.id ?? null;
  }
}
