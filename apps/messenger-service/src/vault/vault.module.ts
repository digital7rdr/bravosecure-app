import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {VaultService} from './vault.service';
import {VaultController} from './vault.controller';
import {VaultAuditLog} from './audit.log';
import {MfaGuard} from './mfa.guard';

@Module({
  imports:     [AuthModule],
  controllers: [VaultController],
  providers:   [VaultService, VaultAuditLog, MfaGuard],
  exports:     [VaultService, MfaGuard],
})
export class VaultModule {}
