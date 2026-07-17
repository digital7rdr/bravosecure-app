import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {DatabaseService} from '../../database/database.service';
import type {AccessClaims} from '../../auth/jwt.service';

export type SubscriptionTier = 'lite' | 'pro' | 'enterprise';

/** Tier ordering — Enterprise is a superset of Pro (M1A matrix), so a
 *  handler gated `@RequireTier('pro')` accepts Enterprise callers. */
const TIER_RANK: Record<SubscriptionTier, number> = {lite: 0, pro: 1, enterprise: 2};

export interface TierRow {
  subscription_tier: string;
  pro_active_until: string | Date | null;
}

/**
 * Effective tier: a paid tier only counts while its paid window is open.
 * `pro_active_until` doubles as the generic paid-until for enterprise
 * (M1A D-3). NULL = permanent comp grant (RS-17) and keeps its tier;
 * a lapsed window is Lite NOW (RS-19), without waiting for the sweep.
 */
export function effectiveTierOf(row: TierRow | null | undefined): SubscriptionTier {
  if (!row) return 'lite';
  const tier = row.subscription_tier;
  if (tier !== 'pro' && tier !== 'enterprise') return 'lite';
  const until = row.pro_active_until;
  if (until === null) return tier;
  return new Date(until).getTime() > Date.now() ? tier : 'lite';
}

export function tierSatisfies(actual: SubscriptionTier, required: SubscriptionTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

export const REQUIRED_TIER_KEY = 'required_tier';

/**
 * Audit fix 0.8 — restrict a handler to users on a specific subscription
 * tier. Pro-only flows (currently AI Itinerary booking creation) attach
 * `@RequireTier('pro')` so the auth-service backstops the client-side
 * paywall — a Lite client hitting the endpoint directly gets
 * `403 tier_insufficient`.
 *
 * Q3 follow-up: extend the Pro-endpoint list once product/engineering
 * agree which flows go behind the paywall (premium pricing tiers,
 * multi-CPO bookings, advanced reports). The decorator is generic; only
 * the application points expand.
 *
 * Example:
 *   @Post('parse-itinerary')
 *   @RequireTier('pro')
 *   parseItinerary(...) {...}
 */
export const RequireTier = (tier: SubscriptionTier) =>
  SetMetadata(REQUIRED_TIER_KEY, tier);

/**
 * TierGuard — verifies that the JWT subject's `public.users.subscription_tier`
 * matches the `@RequireTier(...)` annotation. Reads live from the DB on
 * every call rather than trusting a JWT claim, so a downgrade takes
 * effect on the NEXT request (not after token expiry — could be 24h).
 *
 * Apply AFTER JwtAuthGuard so `req.user` is already populated.
 */
@Injectable()
export class TierGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<SubscriptionTier | undefined>(
      REQUIRED_TIER_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true;       // handler isn't tier-gated

    const req = ctx.switchToHttp().getRequest<{user?: AccessClaims}>();
    const claims = req.user;
    if (!claims) throw new ForbiddenException('not_authenticated');

    const row = await this.db.qOne<{subscription_tier: string; pro_active_until: string | null}>(
      `SELECT subscription_tier, pro_active_until
         FROM public.users
        WHERE id = $1 AND deleted_at IS NULL`,
      [claims.sub],
    );
    if (!row) throw new ForbiddenException('tier_insufficient');
    // RS-19 — a lapsed paid window (pro_active_until in the past) is effectively
    // Lite, mirroring the booking itinerary gate, so a stale paid column can't
    // slip past this guard before the hourly sweep flips it. NULL = permanent
    // comp grant (RS-17) and keeps its tier. Ranked comparison: Enterprise
    // satisfies a 'pro' requirement (M1A matrix superset rule).
    if (!tierSatisfies(effectiveTierOf(row), required)) {
      throw new ForbiddenException('tier_insufficient');
    }
    return true;
  }
}
