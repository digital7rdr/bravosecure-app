import {Controller, Post, Body, UseGuards, HttpCode, Req} from '@nestjs/common';
import type {Request} from 'express';
import {TotpService}       from './totp.service';
import {JwtAuthGuard}      from '../common/guards/jwt-auth.guard';
import {CurrentUser}       from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {TotpVerifyDto}     from './dto/totp-verify.dto';

function ip(req: Request) {
  return ((req.headers['x-forwarded-for'] as string|undefined)?.split(',')[0]?.trim()) ?? req.ip ?? 'unknown';
}

@Controller('auth/totp')
export class TotpController {
  constructor(private readonly totp: TotpService) {}

  @UseGuards(JwtAuthGuard)
  @Post('setup')
  setup(@CurrentUser() user: AccessClaims, @Req() req: Request) {
    return this.totp.setup(user.sub, user.deviceId, ip(req));
  }

  @Post('verify')
  @HttpCode(200)
  verify(@Body() dto: TotpVerifyDto, @Req() req: Request) {
    return this.totp.verify(dto, ip(req));
  }
}
