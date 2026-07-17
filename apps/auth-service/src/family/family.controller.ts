import {Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards} from '@nestjs/common';
import {JwtAuthGuard}       from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser}        from '../common/decorators/current-user.decorator';
import type {AccessClaims}  from '../auth/jwt.service';
import {FamilyService}      from './family.service';
import {InviteMemberDto, SetSpendLimitDto} from './dto/family.dto';

/**
 * Family hierarchy endpoints. JWT-guarded + per-user throttled. Holder ops
 * are scoped to the caller as holder; member ops to the caller as member —
 * no endpoint accepts a foreign user id.
 */
@Controller('family')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class FamilyController {
  constructor(private readonly family: FamilyService) {}

  // ── Holder side ──
  @Post('invite')
  invite(@Body() dto: InviteMemberDto, @CurrentUser() user: AccessClaims) {
    return this.family.invite(user.sub, dto.phoneE164, dto.spendLimitCredits ?? null);
  }

  @Get('members')
  members(@CurrentUser() user: AccessClaims) {
    return this.family.listMembers(user.sub).then(members => ({members}));
  }

  /** Credit-usage breakdown (Claude-token-style): total + per-member + recent. */
  @Get('usage')
  usage(@CurrentUser() user: AccessClaims) {
    return this.family.usage(user.sub);
  }

  @Patch('members/:id/limit')
  setLimit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSpendLimitDto, @CurrentUser() user: AccessClaims) {
    return this.family.setSpendLimit(user.sub, id, dto.spendLimitCredits ?? null);
  }

  @Delete('members/:id')
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.revoke(user.sub, id);
  }

  // ── Member side ──
  @Get('membership')
  membership(@CurrentUser() user: AccessClaims) {
    return this.family.myMembership(user.sub).then(membership => ({membership}));
  }

  @Get('invites')
  invites(@CurrentUser() user: AccessClaims) {
    return this.family.invitesFor(user.sub).then(invites => ({invites}));
  }

  @Post('invites/:id/accept')
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.accept(user.sub, id);
  }

  @Post('invites/:id/decline')
  decline(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.decline(user.sub, id);
  }
}
