import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OrgManagerGuard} from '../org/org-manager.guard';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';
import {DepartmentController} from './department.controller';
import {DeptChatAccessGuard} from './dept-chat-access.guard';

/**
 * Department Channels — service-provider org workspace (org-membership gated).
 *
 * Entitlement is by org membership, not individual Pro: `DeptChatAccessGuard`
 * (company account / active org member) replaced the old TierGuard. Manager
 * routes layer `OrgManagerGuard` on top and write `OrgAuditService` rows.
 *
 * OrgManagerGuard + OrgAuditService depend only on the global DatabaseService,
 * so they're provided DIRECTLY here — importing OrgModule would cycle
 * (OrgModule already imports DepartmentModule). AuthModule supplies JwtAuthGuard.
 */
@Module({
  imports:     [AuthModule],
  controllers: [DepartmentController],
  providers:   [DepartmentService, DeptChatAccessGuard, OrgManagerGuard, OrgAuditService],
  // Exported so OpsModule can surface an admin oversight view of channels.
  exports:     [DepartmentService],
})
export class DepartmentModule {}
