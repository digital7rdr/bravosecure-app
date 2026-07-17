import {Controller, Get, Post, Body, Query, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {NotificationsService} from './notifications.service';

/**
 * N-20 — durable notification inbox API, scoped to the authenticated recipient.
 *   GET  /me/notifications?since=<iso>&limit=<n>  — recent rows (newest first)
 *   POST /me/notifications/read {ids:[...]} | {all:true}
 *
 * Payloads are metadata-only (class/kind/booking/mission ids); the client maps
 * kind → display title (same map the FCM wake path uses). See NotificationsService.
 */
@Controller('me/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessClaims,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<{notifications: Array<{
    id: string; eventClass: string; kind: string;
    bookingId?: string; missionId?: string; createdAt: string; read: boolean;
  }>}> {
    const rows = await this.svc.list(user.sub, {
      sinceIso: since,
      limit: limit ? Number(limit) : undefined,
    });
    return {
      notifications: rows.map(r => ({
        id:         r.id,
        eventClass: r.event_class,
        kind:       r.kind,
        bookingId:  r.booking_id ?? undefined,
        missionId:  r.mission_id ?? undefined,
        createdAt:  r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        read:       r.read_at != null,
      })),
    };
  }

  @Post('read')
  async read(
    @CurrentUser() user: AccessClaims,
    @Body() body: {ids?: string[]; all?: boolean},
  ): Promise<{ok: true}> {
    if (body?.all) {
      await this.svc.markAllRead(user.sub);
    } else if (Array.isArray(body?.ids)) {
      await this.svc.markRead(user.sub, body.ids);
    }
    return {ok: true};
  }
}
