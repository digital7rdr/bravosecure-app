import {Module} from '@nestjs/common';
import {AuthModule}       from '../auth/auth.module';
import {FamilyController} from './family.controller';
import {FamilyService}    from './family.service';

@Module({
  imports:     [AuthModule],   // JWT guard machinery
  controllers: [FamilyController],
  providers:   [FamilyService],
  exports:     [FamilyService], // BookingModule uses resolvePayer; auth uses linkPendingInvitesByPhone
})
export class FamilyModule {}
