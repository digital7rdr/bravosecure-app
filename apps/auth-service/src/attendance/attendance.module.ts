import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OrgModule} from '../org/org.module';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {AttendanceController} from './attendance.controller';
import {AttendanceService} from './attendance.service';
import {AttendanceRollupService} from './attendance-rollup.service';

/**
 * Attendance module — provider-managed CPO shift clock-in/out.
 *
 * AuthModule supplies JwtAuthGuard; OrgModule exports OrgManagerGuard (the
 * provider-scoped routes). DatabaseService is global.
 */
@Module({
  imports:     [AuthModule, OrgModule],
  controllers: [AttendanceController],
  providers:   [AttendanceService, AttendanceRollupService, DeptChatV2Guard],
  exports:     [AttendanceService],
})
export class AttendanceModule {}
