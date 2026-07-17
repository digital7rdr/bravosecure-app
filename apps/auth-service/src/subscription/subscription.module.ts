import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {WalletModule} from '../wallet/wallet.module';
import {SubscriptionService} from './subscription.service';
import {SubscriptionController} from './subscription.controller';
import {ProLapseCron} from './pro-lapse.cron';

/**
 * Bravo Pro subscription.
 *
 * - POST /subscription/pro — debit Pro price in BC + flip subscription_tier.
 *
 * Depends on WalletModule for the BC debit (WalletService.debitForFeature)
 * and AuthModule for the JwtAuthGuard.
 */
@Module({
  imports:     [AuthModule, WalletModule],
  controllers: [SubscriptionController],
  providers:   [SubscriptionService, ProLapseCron],
  exports:     [SubscriptionService],
})
export class SubscriptionModule {}
