import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {WalletService} from '../wallet/wallet.service';
import {StripeClient} from '../wallet/stripe.client';
import {SubscriptionService, PRO_MONTHLY_BC, ENTERPRISE_MONTHLY_BC} from './subscription.service';

// A tx stub whose q/qOne we drive per-test.
const tx = {q: jest.fn(), qOne: jest.fn()};
const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  // withTransaction just runs the callback with our tx stub.
  withTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
const mockWallet = {debitForFeature: jest.fn()};
const mockStripe = {
  enabled: false,
  ensureCustomer: jest.fn(),
  createSubscription: jest.fn(),
  cancelSubscription: jest.fn(),
};

describe('SubscriptionService', () => {
  let svc: SubscriptionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStripe.enabled = false;
    mockDb.q.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: WalletService, useValue: mockWallet},
        {provide: StripeClient, useValue: mockStripe},
      ],
    }).compile();
    svc = module.get(SubscriptionService);
  });

  describe('subscribeToPro', () => {
    it('debits the Pro price and flips the tier in one transaction', async () => {
      const until = new Date('2026-07-03T00:00:00.000Z');
      tx.qOne
        .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite'}) // SELECT ... FOR UPDATE
        .mockResolvedValueOnce({pro_active_until: until});             // UPDATE ... RETURNING
      mockWallet.debitForFeature.mockResolvedValueOnce({bravo_credits: 500, currency: 'BC'});

      const res = await svc.subscribeToPro('u-1');

      expect(mockWallet.debitForFeature).toHaveBeenCalledWith(
        'u-1',
        PRO_MONTHLY_BC,
        expect.stringContaining('Pro'),
        expect.objectContaining({kind: 'pro_subscription'}),
        tx,
      );
      expect(res).toEqual({
        subscription_tier: 'pro',
        active_until: until.toISOString(),
        charged_credits: PRO_MONTHLY_BC,
        balance: {bravo_credits: 500, currency: 'BC'},
        auto_renew: false,
      });
    });

    it('creates a Stripe subscription when auto_renew requested + stripe enabled', async () => {
      const until = new Date('2026-07-03T00:00:00.000Z');
      mockStripe.enabled = true;
      tx.qOne
        .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite'})
        .mockResolvedValueOnce({pro_active_until: until});
      mockWallet.debitForFeature.mockResolvedValueOnce({bravo_credits: 0, currency: 'BC'});
      mockDb.qOne.mockResolvedValueOnce({stripe_customer_id: 'cus_1'}); // wallet lookup
      mockStripe.ensureCustomer.mockResolvedValueOnce('cus_1');
      mockStripe.createSubscription.mockResolvedValueOnce({id: 'sub_1', status: 'active', current_period_end: 0});

      const res = await svc.subscribeToPro('u-1', {autoRenew: true});

      expect(mockStripe.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({customerId: 'cus_1'}),
      );
      expect(res.auto_renew).toBe(true);
    });

    it('keeps the BC-funded period even if auto-renew setup fails', async () => {
      const until = new Date('2026-07-03T00:00:00.000Z');
      mockStripe.enabled = true;
      tx.qOne
        .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite'})
        .mockResolvedValueOnce({pro_active_until: until});
      mockWallet.debitForFeature.mockResolvedValueOnce({bravo_credits: 0, currency: 'BC'});
      mockDb.qOne.mockResolvedValueOnce({stripe_customer_id: 'cus_1'});
      mockStripe.ensureCustomer.mockResolvedValueOnce('cus_1');
      mockStripe.createSubscription.mockRejectedValueOnce(new Error('card_declined'));

      const res = await svc.subscribeToPro('u-1', {autoRenew: true});
      // Pro is still active (BC paid); auto_renew just didn't turn on.
      expect(res.subscription_tier).toBe('pro');
      expect(res.auto_renew).toBe(false);
    });

    it('propagates insufficient_credits and never flips the tier', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite'});
      mockWallet.debitForFeature.mockRejectedValueOnce(
        new BadRequestException('insufficient_credits'),
      );

      await expect(svc.subscribeToPro('u-1')).rejects.toThrow('insufficient_credits');
      // The UPDATE (2nd qOne) must not have run — debit threw first.
      expect(tx.qOne).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown user', async () => {
      tx.qOne.mockResolvedValueOnce(null);
      await expect(svc.subscribeToPro('ghost')).rejects.toThrow(NotFoundException);
      expect(mockWallet.debitForFeature).not.toHaveBeenCalled();
    });
  });

  describe('subscribeToTier — enterprise (M1A)', () => {
    const until = new Date('2026-08-16T00:00:00.000Z');

    it('debits the Enterprise price and flips the tier', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite', stripe_subscription_id: null})
        .mockResolvedValueOnce({pro_active_until: until});
      mockWallet.debitForFeature.mockResolvedValueOnce({bravo_credits: 100, currency: 'USD'});
      const res = await svc.subscribeToTier('u-1', 'enterprise');
      expect(mockWallet.debitForFeature.mock.calls[0][1]).toBe(ENTERPRISE_MONTHLY_BC);
      expect(res.subscription_tier).toBe('enterprise');
      expect(res.charged_credits).toBe(ENTERPRISE_MONTHLY_BC);
      const updateSql = (tx.qOne.mock.calls[1][0] as string).replace(/\s+/g, ' ');
      // Same-tier renewal extends; a switch starts a fresh 30-day window.
      expect(updateSql).toContain('WHEN subscription_tier = $2');
      // Third param mirrors the caller's auto-renew choice into bc_auto_renew (S9).
      expect(tx.qOne.mock.calls[1][1]).toEqual(['u-1', 'enterprise', false]);
    });

    it('a tier SWITCH cancels the old tier\'s Stripe subscription so it cannot renew the abandoned plan', async () => {
      mockStripe.enabled = true;
      tx.qOne
        .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'pro', stripe_subscription_id: 'sub_old'})
        .mockResolvedValueOnce({pro_active_until: until});
      mockWallet.debitForFeature.mockResolvedValueOnce({bravo_credits: 0, currency: 'USD'});
      mockStripe.cancelSubscription.mockResolvedValueOnce(undefined);
      await svc.subscribeToTier('u-1', 'enterprise');
      expect(mockStripe.cancelSubscription).toHaveBeenCalledWith('sub_old');
      // Call order shifted by the getPrices() read (S9) — locate the clear by SQL.
      const clearSql = (mockDb.q.mock.calls as [string, unknown[]][])
        .map(c => (c[0] as string).replace(/\s+/g, ' '))
        .find(sql => sql.includes('stripe_subscription_id = NULL'));
      expect(clearSql).toBeDefined();
      // Guarded clear: only if the row still points at the stale sub.
      expect(clearSql).toContain('stripe_subscription_id = $2');
    });

    it('same-tier renewal does NOT touch any Stripe subscription', async () => {
      mockStripe.enabled = true;
      tx.qOne
        .mockResolvedValueOnce({id: 'u-1', subscription_tier: 'enterprise', stripe_subscription_id: 'sub_live'})
        .mockResolvedValueOnce({pro_active_until: until});
      mockWallet.debitForFeature.mockResolvedValueOnce({bravo_credits: 0, currency: 'USD'});
      await svc.subscribeToTier('u-1', 'enterprise');
      expect(mockStripe.cancelSubscription).not.toHaveBeenCalled();
    });

    it('propagates insufficient_credits without flipping the tier', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'u-1', subscription_tier: 'lite', stripe_subscription_id: null});
      mockWallet.debitForFeature.mockRejectedValueOnce(new BadRequestException('insufficient_credits'));
      await expect(svc.subscribeToTier('u-1', 'enterprise')).rejects.toThrow('insufficient_credits');
      expect(tx.qOne).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleSubscriptionEvent', () => {
    it('extends the period on invoice.paid without clobbering the held paid tier', async () => {
      await svc.handleSubscriptionEvent({
        id: 'evt_1', type: 'invoice.paid',
        data: {object: {subscription: 'sub_1', metadata: {user_id: 'u-1'}}},
      });
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      // M1A — a renewal keeps whichever paid tier the row holds (an
      // enterprise account's card renewal must NOT rewrite it to 'pro');
      // only a swept-to-lite row is restored from the sub's metadata tier.
      expect(sql).toContain("WHEN subscription_tier IN ('pro','enterprise') THEN subscription_tier");
      expect(sql).toContain("INTERVAL '30 days'");
      expect(mockDb.q.mock.calls[0][1]).toEqual(['u-1', 'pro']);
    });

    it('restores the enterprise tier from sub metadata after an early sweep', async () => {
      await svc.handleSubscriptionEvent({
        id: 'evt_1e', type: 'invoice.paid',
        data: {object: {subscription: 'sub_9', metadata: {user_id: 'u-9', kind: 'enterprise_subscription'}}},
      });
      expect(mockDb.q.mock.calls[0][1]).toEqual(['u-9', 'enterprise']);
    });

    it('marks past_due on invoice.payment_failed without downgrading', async () => {
      await svc.handleSubscriptionEvent({
        id: 'evt_2', type: 'invoice.payment_failed',
        data: {object: {subscription: 'sub_1', metadata: {user_id: 'u-1'}}},
      });
      const sql = mockDb.q.mock.calls[0][0] as string;
      expect(sql).toContain("pro_renew_status = 'past_due'");
      expect(sql).not.toContain("'lite'");
    });

    it('drops the sub link and downgrades a lapsed period on subscription.deleted, but never a NULL comp grant', async () => {
      await svc.handleSubscriptionEvent({
        id: 'evt_3', type: 'customer.subscription.deleted',
        data: {object: {id: 'sub_1', metadata: {user_id: 'u-1'}}},
      });
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain('stripe_subscription_id = NULL');
      expect(sql).toContain("'lite'");
      // RS-17: NULL pro_active_until = permanent/comp grant, NOT downgraded.
      // The CASE only flips a non-NULL, already-elapsed period to lite.
      expect(sql).toContain('WHEN pro_active_until IS NOT NULL AND pro_active_until <= NOW()');
      expect(sql).not.toContain('pro_active_until IS NULL OR');
    });
  });

  describe('renewFromCredits (S9 BC auto-renew)', () => {
    it('debits the CURRENT table price and extends the window for a due opted-in account', async () => {
      mockDb.q
        .mockResolvedValueOnce([{id: 'u-1', subscription_tier: 'pro'}])   // due scan
        .mockResolvedValueOnce([{tier: 'pro', price_bc: 2500}, {tier: 'enterprise', price_bc: 6000}]); // getPrices
      tx.qOne.mockResolvedValueOnce({id: 'u-1'}); // FOR UPDATE re-check
      mockWallet.debitForFeature.mockResolvedValueOnce({bravo_credits: 10, currency: 'USD'});
      const res = await svc.renewFromCredits(new Date('2026-08-01T00:00:00Z'));
      expect(res).toEqual({renewed: 1, failed: 0});
      // Charged the ops-edited price (2500), not the compiled default —
      // the founder's "price change applies from the next renewal".
      expect(mockWallet.debitForFeature.mock.calls[0][1]).toBe(2500);
      const dueSql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      // Never renews from BC while a live Stripe sub exists (no double charge).
      expect(dueSql).toContain('stripe_subscription_id IS NULL');
      expect(dueSql).toContain('bc_auto_renew = TRUE');
    });

    it('a failed debit counts as failed and leaves the row for the lapse sweep', async () => {
      mockDb.q
        .mockResolvedValueOnce([{id: 'u-2', subscription_tier: 'enterprise'}])
        .mockResolvedValueOnce([]);
      tx.qOne.mockResolvedValueOnce({id: 'u-2'});
      mockWallet.debitForFeature.mockRejectedValueOnce(new BadRequestException('insufficient_credits'));
      const res = await svc.renewFromCredits(new Date('2026-08-01T00:00:00Z'));
      expect(res).toEqual({renewed: 0, failed: 1});
    });

    it('skips a row whose state changed under the lock (concurrent manual renew)', async () => {
      mockDb.q
        .mockResolvedValueOnce([{id: 'u-3', subscription_tier: 'pro'}])
        .mockResolvedValueOnce([]);
      tx.qOne.mockResolvedValueOnce(null); // re-check misses
      const res = await svc.renewFromCredits(new Date('2026-08-01T00:00:00Z'));
      expect(res).toEqual({renewed: 0, failed: 0});
      expect(mockWallet.debitForFeature).not.toHaveBeenCalled();
    });
  });

  describe('getPrices', () => {
    it('falls back to compiled defaults when the table is unreachable', async () => {
      mockDb.q.mockRejectedValueOnce(new Error('relation missing'));
      await expect(svc.getPrices()).resolves.toEqual({pro: PRO_MONTHLY_BC, enterprise: ENTERPRISE_MONTHLY_BC});
    });

    it('ignores nonsense rows (zero/negative/unknown tier)', async () => {
      mockDb.q.mockResolvedValueOnce([
        {tier: 'pro', price_bc: 0}, {tier: 'gold', price_bc: 9}, {tier: 'enterprise', price_bc: 7000},
      ]);
      await expect(svc.getPrices()).resolves.toEqual({pro: PRO_MONTHLY_BC, enterprise: 7000});
    });
  });

  describe('sweepLapsedPro', () => {
    it('downgrades lapsed pro users, clears the sub link, and preserves NULL-comp + backstop semantics', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'u-1'}, {id: 'u-2'}]);
      const res = await svc.sweepLapsedPro(new Date('2026-08-01T00:00:00Z'));
      expect(res.downgraded).toBe(2);
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      // downgrades to lite … covering BOTH paid tiers (M1A)
      expect(sql).toContain("subscription_tier = 'lite'");
      expect(sql).toContain("subscription_tier IN ('pro', 'enterprise')");
      // … but must NOT null the sub link — invoice.paid needs it to self-heal a
      // recovered dunning payment (RS-18 review fix).
      expect(sql).not.toContain('stripe_subscription_id = NULL');
      // RS-17: a NULL pro_active_until (comp/permanent grant) is never swept
      expect(sql).toContain('pro_active_until IS NOT NULL');
      // ordinary lapse branch: no live sub + period elapsed
      expect(sql).toContain('stripe_subscription_id IS NULL AND pro_active_until <= $1');
      // RS-18 backstop: stripe-linked but past_due/canceled and >14d past period
      expect(sql).toContain("pro_renew_status IN ('past_due', 'canceled')");
      expect(sql).toContain("INTERVAL '14 days'");
      expect(mockDb.q.mock.calls[0][1]).toEqual([new Date('2026-08-01T00:00:00Z')]);
    });
  });
});
