import {Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {CurrentOrgManager} from '../org/current-org-manager.decorator';
import {DeptChatAccessGuard} from './dept-chat-access.guard';
import {DepartmentService, type ChannelSummary} from './department.service';
import {
  CreateChannelDto, ConfigureChannelDto, RegisterGroupDto, AddMemberDto, UpdateMemberRoleDto,
} from './dto/channel.dto';

/**
 * Department Channels REST surface (all routes under /department).
 *
 * METADATA ONLY — message content is end-to-end encrypted and rides the
 * messenger relay as Signal group envelopes (not this service). These routes
 * manage the channel directory, membership/role, and the E2EE group linkage.
 *
 * Entitlement: `DeptChatAccessGuard` admits the service-provider company
 * account + active org members (CPOs/managers) — the workspace is an ORG
 * feature, NOT an individual-Pro perk (it replaced the old `@RequireTier('pro')`
 * gate that locked every Lite org member out of their own seeded channels).
 * JwtAuthGuard runs first so the guard sees a populated user. Manager-only
 * routes (create/configure/archive) add OrgManagerGuard on top.
 */
@Controller('department')
@UseGuards(JwtAuthGuard, DeptChatAccessGuard)
export class DepartmentController {
  constructor(private readonly dept: DepartmentService) {}

  @Get('channels')
  async listChannels(@CurrentUser() user: AccessClaims): Promise<{channels: ChannelSummary[]}> {
    return {channels: await this.dept.listChannels(user.sub)};
  }

  @Get('channels/:id/members')
  async listMembers(
    @CurrentUser() user: AccessClaims,
    @Param('id') channelId: string,
  ) {
    return this.dept.listMembers(user.sub, channelId);
  }

  // ─── Manager channel management (Step 18; OrgManagerGuard on top) ──────
  //
  // Create/configure/archive are org-level actions (no channel to be admin of
  // yet), so they require OrgManagerGuard — the company account or an active
  // manager — in ADDITION to the class-level entitlement guard. No crypto
  // change: create seeds metadata + membership (group bootstrapped lazily on
  // first open); tightening access rekeys CPOs out via removeMember.

  /** Every channel of the manager's org (incl. archived) for the manage screen. */
  @Get('manage/channels')
  @UseGuards(OrgManagerGuard)
  async listManagedChannels(@CurrentOrgManager() manager: OrgManagerContext) {
    return {channels: await this.dept.listOrgChannels(manager.org_user_id)};
  }

  @Post('channels')
  @HttpCode(200)
  @UseGuards(OrgManagerGuard)
  createChannel(
    @Body() dto: CreateChannelDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.dept.createChannel(manager.org_user_id, manager.user_id, dto);
  }

  @Patch('channels/:id')
  @UseGuards(OrgManagerGuard)
  configureChannel(
    @Param('id') channelId: string,
    @Body() dto: ConfigureChannelDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.dept.configureChannel(manager.org_user_id, manager.user_id, channelId, dto);
  }

  @Post('channels/:id/archive')
  @HttpCode(200)
  @UseGuards(OrgManagerGuard)
  archiveChannel(
    @Param('id') channelId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.dept.archiveChannel(manager.org_user_id, manager.user_id, channelId);
  }

  /**
   * Register the messenger group the admin's device created for this channel.
   * The group master key never reaches the server — only the conversation id.
   */
  @Post('channels/:id/group')
  @HttpCode(200)
  async registerGroup(
    @CurrentUser() user: AccessClaims,
    @Param('id') channelId: string,
    @Body() dto: RegisterGroupDto,
  ): Promise<{ok: true}> {
    return this.dept.registerGroup(user.sub, channelId, dto.group_conversation_id);
  }

  // ─── Membership management (admin-only; enqueues an E2EE rekey intent) ──

  @Post('channels/:id/members')
  @HttpCode(200)
  async addMember(
    @CurrentUser() user: AccessClaims,
    @Param('id') channelId: string,
    @Body() dto: AddMemberDto,
  ): Promise<{ok: true}> {
    return this.dept.addMember(user.sub, channelId, dto.user_id, dto.role ?? 'viewer', dto.role_label);
  }

  @Delete('channels/:id/members/:userId')
  @HttpCode(200)
  async removeMember(
    @CurrentUser() user: AccessClaims,
    @Param('id') channelId: string,
    @Param('userId') memberUserId: string,
  ): Promise<{ok: true}> {
    return this.dept.removeMember(user.sub, channelId, memberUserId);
  }

  /** Change a member's access: viewer (read-only) ↔ admin (can post). Admin-only. */
  @Patch('channels/:id/members/:userId/role')
  @HttpCode(200)
  async updateMemberRole(
    @CurrentUser() user: AccessClaims,
    @Param('id') channelId: string,
    @Param('userId') memberUserId: string,
    @Body() dto: UpdateMemberRoleDto,
  ): Promise<{ok: true}> {
    return this.dept.updateMemberRole(user.sub, channelId, memberUserId, dto.role);
  }

  /** Delete the channel — creator-only (distinct from archive). */
  @Delete('channels/:id')
  @HttpCode(200)
  async deleteChannel(
    @CurrentUser() user: AccessClaims,
    @Param('id') channelId: string,
  ): Promise<{ok: true}> {
    return this.dept.deleteChannel(user.sub, channelId);
  }

  /** Owner-only: clear the E2EE group linkage so the owner can re-provision an
   *  orphaned channel (recovery for "explicit peer address" on send). */
  @Post('channels/:id/reset-group')
  @HttpCode(200)
  async resetGroup(
    @CurrentUser() user: AccessClaims,
    @Param('id') channelId: string,
  ): Promise<{ok: true}> {
    return this.dept.resetGroup(user.sub, channelId);
  }

  // The admin device drains these and broadcasts the matching add/remove +
  // rekey on the Signal group (the server holds no key, so it cannot rekey).
  @Get('membership-intents')
  async listIntents(@CurrentUser() user: AccessClaims) {
    return {intents: await this.dept.listMembershipIntents(user.sub)};
  }

  @Post('membership-intents/:intentId/ack')
  @HttpCode(200)
  async ackIntent(
    @CurrentUser() user: AccessClaims,
    @Param('intentId') intentId: string,
  ): Promise<{ok: true}> {
    return this.dept.ackMembershipIntent(user.sub, intentId);
  }
}
