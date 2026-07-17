import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe,
  Patch, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {DatabaseService} from '../database/database.service';
import {SubscriptionService} from '../subscription/subscription.service';
import {IsBoolean, IsIn, IsInt, IsOptional, Max, Min} from 'class-validator';

type OpsReq = Request & {admin: AdminContext};

export class SetTierPriceDto {
  @IsIn(['pro', 'enterprise']) tier!: 'pro' | 'enterprise';
  // Why the cap: a fat-fingered extra zero on a live price is a production
  // incident; 1,000,000 BC is far above any plausible SKU.
  @IsInt() @Min(1) @Max(1_000_000) price_bc!: number;
}

export class SetUserTierDto {
  @IsIn(['lite', 'pro', 'enterprise']) tier!: 'lite' | 'pro' | 'enterprise';
  /** Grant days from now; omit/null = permanent comp grant (RS-17). Ignored for 'lite'. */
  @IsOptional() @IsInt() @Min(1) @Max(3650) days?: number | null;
  @IsOptional() @IsBoolean() clear_auto_renew?: boolean;
}

/**
 * M1A/S9 — ops console pricing + tier administration.
 *
 * Prices are charged AT CHARGE TIME (subscribe + every renewal), so a price
 * change here applies to all future charges — "from next month" for every
 * renewing subscriber — while already-paid periods finish at what they paid.
 *
 * The tier editor backs comp grants and support fixes. It writes exactly the
 * columns the sweeps/guards already honour (RS-17 NULL = permanent grant;
 * RS-19 lapse). ADMIN/SUPERVISOR only.
 */
@Controller('ops/subscription')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
@RequireRoles('SUPERVISOR', 'ADMIN')
export class OpsSubscriptionController {
  constructor(
    private readonly db: DatabaseService,
    private readonly subscription: SubscriptionService,
  ) {}

  @Get('prices')
  async prices() {
    const rows = await this.db.q<{tier: string; price_bc: number; updated_at: string}>(
      `SELECT tier, price_bc, updated_at FROM subscription_prices ORDER BY tier`,
    );
    return {prices: rows};
  }

  @Patch('prices')
  @HttpCode(200)
  async setPrice(@Body() dto: SetTierPriceDto, @Req() req: OpsReq) {
    const row = await this.db.qOne<{tier: string; price_bc: number}>(
      `UPDATE subscription_prices
          SET price_bc = $2, updated_at = NOW(), updated_by = $3
        WHERE tier = $1
        RETURNING tier, price_bc`,
      [dto.tier, dto.price_bc, req.admin.user_id],
    );
    if (!row) throw new BadRequestException('unknown_tier');
    return row;
  }

  @Patch('users/:userId/tier')
  @HttpCode(200)
  async setUserTier(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetUserTierDto,
  ) {
    // A downgrade to lite must also stop a live card renewal — otherwise the
    // next invoice.paid quietly re-upgrades the account ops just demoted.
    if (dto.tier === 'lite') {
      await this.subscription.cancelAutoRenew(userId);
    }
    const row = await this.db.qOne<{id: string; subscription_tier: string; pro_active_until: string | null}>(
      `UPDATE public.users
          SET subscription_tier = $2,
              pro_active_until  = CASE
                WHEN $2 = 'lite' THEN NULL
                WHEN $3::int IS NULL THEN NULL
                ELSE NOW() + ($3::int || ' days')::interval
              END,
              bc_auto_renew = CASE WHEN $4::boolean OR $2 = 'lite' THEN FALSE ELSE bc_auto_renew END
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, subscription_tier, pro_active_until`,
      [userId, dto.tier, dto.days ?? null, dto.clear_auto_renew === true],
    );
    if (!row) throw new BadRequestException('user_not_found');
    return row;
  }
}
