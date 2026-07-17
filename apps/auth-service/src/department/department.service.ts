import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import type {ChannelAccess, ChannelType} from './dto/channel.dto';

export interface ChannelSummary {
  id: string;
  name: string;
  description: string | null;
  department: string | null;
  /** Messenger group conversation id carrying the E2EE posts (null until
   *  an admin device has bootstrapped the Signal group). */
  group_conversation_id: string | null;
  unread_count: number;
  my_role: 'admin' | 'viewer';
  // Dept Chat v2 (Step 12). Channels Hub grouping + badges. Defaults
  // 'department'/'standard' on pre-v2 rows.
  channel_type: 'board' | 'department' | 'incident';
  access: 'standard' | 'read_only' | 'restricted';
  // Creator of the channel — the client uses this to gate owner-only actions
  // (re-provision an orphaned channel, delete the thread).
  created_by: string;
}

/**
 * Department Channels — Phase-1 data layer.
 *
 * E2EE: message CONTENT is NOT stored here. A channel maps to a messenger
 * Signal group (group_conversation_id); posts ride the relay as sealed-
 * sender group envelopes via the existing broadcastToGroup crypto. This
 * service owns only the non-secret metadata: the channel directory,
 * membership + role (admin posts / viewer read-only), the group linkage,
 * and unread tracking. The relay never sees channel plaintext.
 */
@Injectable()
export class DepartmentService {
  private readonly log = new Logger(DepartmentService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OrgAuditService,
  ) {}

  /** Channels the caller is a member of, with the E2EE group linkage. */
  async listChannels(userId: string): Promise<ChannelSummary[]> {
    return this.db.q<ChannelSummary>(
      `SELECT c.id,
              c.name,
              c.description,
              c.department,
              c.group_conversation_id,
              c.channel_type,
              c.access,
              c.created_by,
              m.role AS my_role,
              -- Unread is tracked client-side off the encrypted message store
              -- now (the relay holds the ciphertext); expose 0 here so the
              -- list shape stays stable. The mobile store overlays the real
              -- per-conversation unread from messengerStore.
              0 AS unread_count
         FROM public.department_channel_members m
         JOIN public.department_channels c ON c.id = m.channel_id
        WHERE m.user_id = $1 AND c.archived_at IS NULL
        ORDER BY c.created_at DESC`,
      [userId],
    );
  }

  /** Membership roster for a channel (for the admin device to seed the
   *  Signal group). Throws 403 if the caller isn't a member. */
  async listMembers(userId: string, channelId: string): Promise<{
    members: Array<{user_id: string; role: 'admin' | 'viewer'; role_label: string | null; display_name: string}>;
    my_role: 'admin' | 'viewer';
  }> {
    const role = await this.memberRole(userId, channelId);
    const members = await this.db.q<{user_id: string; role: 'admin' | 'viewer'; role_label: string | null; display_name: string}>(
      `SELECT m.user_id, m.role, m.role_label, u.display_name
         FROM public.department_channel_members m
         JOIN public.users u ON u.id = m.user_id
        WHERE m.channel_id = $1`,
      [channelId],
    );
    return {members, my_role: role};
  }

  /**
   * Register the messenger group an admin's device created for this channel.
   * Admin-only. This is the ONLY place the channel learns its E2EE group id;
   * the group master key itself never reaches the server — it travels member-
   * to-member inside the Signal admin-create envelope.
   */
  async registerGroup(
    userId: string, channelId: string, groupConversationId: string,
  ): Promise<{ok: true; group_conversation_id: string; adopted: boolean}> {
    const role = await this.memberRole(userId, channelId);
    if (role !== 'admin') throw new ForbiddenException('only_admin_can_register_group');
    if (!groupConversationId) throw new ForbiddenException('group_id_required');
    // FIRST-WRITER-WINS (area 6 #2) — a second admin device racing provisioning
    // would otherwise OVERWRITE the first group id, splitting members across two
    // master keys (key divergence → "CPO can't see messages", B-35 class).
    // COALESCE keeps the already-registered id if present, else claims this one —
    // atomic in one UPDATE. RETURNING gives the EFFECTIVE (canonical) id; when it
    // differs from what we tried to register, a prior writer won and the caller
    // must ADOPT the returned id instead of its own freshly-minted group.
    const row = await this.db.qOne<{group_conversation_id: string | null}>(
      `UPDATE public.department_channels
          SET group_conversation_id = COALESCE(group_conversation_id, $2)
        WHERE id = $1 AND archived_at IS NULL
        RETURNING group_conversation_id`,
      [channelId, groupConversationId],
    );
    if (!row) throw new NotFoundException('channel_not_found');
    const effective = row.group_conversation_id ?? groupConversationId;
    return {ok: true, group_conversation_id: effective, adopted: effective !== groupConversationId};
  }

  /**
   * Ops oversight view — every (non-archived) channel with member + post
   * counts. Admin-only surface (the ops console AdminGuard gates the route);
   * no membership filter, no message bodies, so it's safe for oversight
   * without exposing channel content.
   */
  async listChannelsForOps(): Promise<Array<{
    id: string;
    name: string;
    department: string | null;
    description: string | null;
    channel_type: 'board' | 'department' | 'incident';
    access: 'standard' | 'read_only' | 'restricted';
    member_count: number;
    provisioned: boolean;
    created_at: string;
  }>> {
    return this.db.q(
      `SELECT c.id,
              c.name,
              c.department,
              c.description,
              c.channel_type,
              c.access,
              (SELECT COUNT(*)::int FROM public.department_channel_members m WHERE m.channel_id = c.id) AS member_count,
              -- Post content is E2EE on the relay, not in this DB. Surface
              -- whether the encrypted group has been bootstrapped instead.
              (c.group_conversation_id IS NOT NULL) AS provisioned,
              c.created_at
         FROM public.department_channels c
        WHERE c.archived_at IS NULL
        ORDER BY c.created_at DESC`,
    );
  }

  // ─── Org workspace seeding (Phase 3) ─────────────────────────────────
  //
  // Called when a service-provider org is approved/activated. Creates the
  // default channel set for the org and seeds membership from its active
  // org_members. group_conversation_id stays NULL — the admin device
  // bootstraps the Signal group lazily (makeNewGroup → registerGroup), so
  // no key material is ever created server-side.
  // Announcements is a board/read_only channel so the Departmental Home "latest
  // announcement" card (PDF p.3) has a source on a fresh org — without it the
  // card is empty until a manager hand-creates a board channel.
  private static readonly DEFAULT_CHANNELS: Array<{
    name: string; department: string; channel_type?: ChannelType; access?: ChannelAccess;
  }> = [
    {name: 'Announcements', department: 'General', channel_type: 'board', access: 'read_only'},
    {name: 'Operations', department: 'Operations'},
    {name: 'Intel',      department: 'Intel'},
    {name: 'CPO Roster', department: 'Roster'},
  ];

  async seedOrgWorkspace(orgUserId: string): Promise<{created: number}> {
    // Idempotent: skip if this org already has any channel.
    const existing = await this.db.qOne<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM public.department_channels WHERE org_id = $1`,
      [orgUserId],
    );
    if (existing && existing.n > 0) return {created: 0};

    const members = await this.activeOrgMembers(orgUserId);

    let created = 0;
    for (const def of DepartmentService.DEFAULT_CHANNELS) {
      const channelType: ChannelType = def.channel_type ?? 'department';
      const access: ChannelAccess = def.access ?? 'standard';
      const ch = await this.db.qOne<{id: string}>(
        `INSERT INTO public.department_channels (org_id, name, department, channel_type, access, created_by)
         VALUES ($1, $2, $3, $4, $5, $1)
         RETURNING id`,
        [orgUserId, def.name, def.department, channelType, access],
      );
      if (!ch) continue;
      created++;
      // Standard/read_only channels seed org admin + every member.
      await this.seedChannelMembers(orgUserId, ch.id, access, channelType, members);
    }
    return {created};
  }

  private async activeOrgMembers(orgUserId: string): Promise<Array<{member_user_id: string; member_role: string}>> {
    return this.db.q<{member_user_id: string; member_role: string}>(
      `SELECT member_user_id, member_role FROM public.org_members
        WHERE org_user_id = $1 AND status = 'active'`,
      [orgUserId],
    );
  }

  /**
   * Seed a channel's membership from the org roster, honouring `access`:
   *   - standard / read_only → org admin + every member (managers admin, CPOs viewer).
   *   - restricted / incident → org admin + managers ONLY (CPOs are never added,
   *     so listChannels' membership JOIN never returns the row — Step-12 rule).
   * Direct INSERTs (no rekey intents): the Signal group is bootstrapped lazily by
   * an admin device over the seeded roster, exactly like seedOrgWorkspace.
   */
  private async seedChannelMembers(
    orgUserId: string, channelId: string, access: ChannelAccess, channelType: ChannelType,
    members: Array<{member_user_id: string; member_role: string}>,
  ): Promise<void> {
    // The org account is the channel admin (can post + manage membership).
    await this.db.q(
      `INSERT INTO public.department_channel_members (channel_id, user_id, role)
       VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
      [channelId, orgUserId],
    );
    // Managers-only visibility = restricted access OR an incident channel.
    const managersOnly = access === 'restricted' || channelType === 'incident';
    for (const m of members) {
      const isManager = m.member_role === 'manager';
      if (managersOnly && !isManager) continue;
      await this.db.q(
        `INSERT INTO public.department_channel_members (channel_id, user_id, role, role_label)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [channelId, m.member_user_id, isManager ? 'admin' : 'viewer', isManager ? 'Manager' : 'CPO'],
      );
    }
  }

  // ─── Manager channel management (Step 18) ─────────────────────────────
  //
  // OrgManagerGuard gates these at the controller; the org account/manager
  // resolved there is passed as (orgUserId, managerUserId). NO crypto change —
  // create seeds metadata + membership rows (group bootstrapped lazily on first
  // open); tightening access rekeys CPOs out via the existing removeMember path.

  async createChannel(
    orgUserId: string, managerUserId: string,
    input: {name: string; department?: string; channel_type?: ChannelType; access?: ChannelAccess},
  ): Promise<{id: string; name: string; channel_type: ChannelType; access: ChannelAccess}> {
    const channel_type: ChannelType = input.channel_type ?? 'department';
    const access: ChannelAccess = input.access ?? 'standard';
    const ch = await this.db.qOne<{id: string}>(
      `INSERT INTO public.department_channels (org_id, name, department, channel_type, access, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [orgUserId, input.name, input.department ?? null, channel_type, access, managerUserId],
    );
    if (!ch) throw new BadRequestException('channel_create_failed');
    const members = await this.activeOrgMembers(orgUserId);
    await this.seedChannelMembers(orgUserId, ch.id, access, channel_type, members);
    await this.audit.log(orgUserId, managerUserId, 'channel.create', {
      targetKind: 'channel', targetId: ch.id, metadata: {channel_type, access},
    });
    return {id: ch.id, name: input.name, channel_type, access};
  }

  async configureChannel(
    orgUserId: string, managerUserId: string, channelId: string,
    input: {name?: string; department?: string; channel_type?: ChannelType; access?: ChannelAccess},
  ): Promise<{ok: true}> {
    const current = await this.assertManagesChannel(orgUserId, channelId);

    // Tightening to a managers-only channel is a MEMBERSHIP change, not a bare
    // column flip: remove each CPO viewer through removeMember so a remove+rekey
    // intent is enqueued and the admin device rotates the master key away from
    // them (else a de-scoped CPO keeps the old key — the §0.3/Step-12 seam).
    const newAccess = input.access ?? current.access;
    const newType = input.channel_type ?? current.channel_type;
    const wasManagersOnly = current.access === 'restricted' || current.channel_type === 'incident';
    const nowManagersOnly = newAccess === 'restricted' || newType === 'incident';
    if (!wasManagersOnly && nowManagersOnly) {
      const viewers = await this.db.q<{user_id: string}>(
        `SELECT user_id FROM public.department_channel_members
          WHERE channel_id = $1 AND role = 'viewer'`,
        [channelId],
      );
      const failed: string[] = [];
      for (const v of viewers) {
        try {
          await this.removeMember(orgUserId, channelId, v.user_id);
        } catch (e) {
          // 'member_not_found' = already gone (idempotent retry) → benign. Any
          // other failure means this CPO was NOT rekeyed out.
          if (e instanceof NotFoundException) continue;
          failed.push(v.user_id);
          this.log.warn(`configure-tighten remove failed for ${v.user_id} on ${channelId}: ${(e as Error).message}`);
        }
      }
      // 🛑 Never bare-flip to managers-only while a removal failed — that would
      // leave a de-scoped CPO holding the old group master key. Abort; the
      // already-removed members keep their remove+rekey intents, and a retry
      // (members already gone → benign) converges.
      if (failed.length) throw new BadRequestException('channel_tighten_incomplete');
    } else if (wasManagersOnly && !nowManagersOnly) {
      // D7-b — loosening back to a standard channel must RE-SEED the CPO viewers the earlier
      // tighten rekeyed out, or the channel stays managers-only forever. Re-add via addMember
      // so each gets an add+rekey intent (the admin device redelivers the master key) — a bare
      // membership insert would NOT redeliver the key. Managers are already admins; skip them.
      const members = await this.activeOrgMembers(orgUserId);
      for (const m of members) {
        if (m.member_role === 'manager') continue;
        try {
          await this.addMember(orgUserId, channelId, m.member_user_id, 'viewer', 'CPO');
        } catch (e) {
          this.log.warn(`configure-loosen re-add failed for ${m.member_user_id} on ${channelId}: ${(e as Error).message}`);
        }
      }
    }

    await this.db.q(
      // D7-c — `department` uses an explicit-clear sentinel ('' clears, NULL/absent keeps) so a
      // channel's department CAN be cleared. The other columns keep COALESCE (no clear needed).
      `UPDATE public.department_channels
          SET name         = COALESCE($2, name),
              department    = CASE WHEN $3::text IS NULL THEN department
                                   WHEN $3::text = '' THEN NULL
                                   ELSE $3 END,
              channel_type  = COALESCE($4, channel_type),
              access        = COALESCE($5, access)
        WHERE id = $1 AND org_id = $6`,
      [channelId, input.name ?? null, input.department ?? null,
       input.channel_type ?? null, input.access ?? null, orgUserId],
    );
    await this.audit.log(orgUserId, managerUserId, 'channel.configure', {
      targetKind: 'channel', targetId: channelId,
      metadata: {channel_type: input.channel_type, access: input.access},
    });
    return {ok: true};
  }

  async archiveChannel(orgUserId: string, managerUserId: string, channelId: string): Promise<{ok: true}> {
    await this.assertManagesChannel(orgUserId, channelId);
    await this.db.q(
      `UPDATE public.department_channels SET archived_at = NOW()
        WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
      [channelId, orgUserId],
    );
    await this.audit.log(orgUserId, managerUserId, 'channel.archive', {
      targetKind: 'channel', targetId: channelId,
    });
    return {ok: true};
  }

  /** Every channel of the manager's org (incl. archived), for the manage screen.
   *  Not membership-filtered — a manager governs the whole org. */
  async listOrgChannels(orgUserId: string): Promise<Array<{
    id: string; name: string; department: string | null; description: string | null;
    channel_type: ChannelType; access: ChannelAccess;
    member_count: number; provisioned: boolean; archived: boolean; created_at: string;
  }>> {
    return this.db.q(
      `SELECT c.id, c.name, c.department, c.description, c.channel_type, c.access,
              (SELECT COUNT(*)::int FROM public.department_channel_members m WHERE m.channel_id = c.id) AS member_count,
              (c.group_conversation_id IS NOT NULL) AS provisioned,
              (c.archived_at IS NOT NULL) AS archived,
              c.created_at
         FROM public.department_channels c
        WHERE c.org_id = $1
        ORDER BY (c.archived_at IS NOT NULL), c.created_at DESC`,
      [orgUserId],
    );
  }

  /** Tenant guard rail: load the channel and assert the manager owns its org. */
  private async assertManagesChannel(orgUserId: string, channelId: string): Promise<{org_id: string; channel_type: ChannelType; access: ChannelAccess}> {
    const ch = await this.db.qOne<{org_id: string; channel_type: ChannelType; access: ChannelAccess}>(
      `SELECT org_id, channel_type, access FROM public.department_channels WHERE id = $1`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    if (ch.org_id !== orgUserId) throw new ForbiddenException('org_scope_violation');
    return ch;
  }

  // ─── Membership change + E2EE rekey propagation (Phase 3) ─────────────
  //
  // The server owns ONLY the metadata row + an intent queue. It NEVER holds
  // the group master key, so it cannot rekey. addMember/removeMember write
  // the membership row and enqueue an intent; the admin device drains
  // listMembershipIntents and broadcasts planAddAndRekey / planRemoveAndRekey.
  // Until that broadcast lands the change is eventually-consistent (documented).

  async addMember(
    adminUserId: string, channelId: string, memberUserId: string,
    role: 'admin' | 'viewer' = 'viewer', roleLabel?: string,
  ): Promise<{ok: true}> {
    const r = await this.memberRole(adminUserId, channelId);
    if (r !== 'admin') throw new ForbiddenException('only_admin_can_manage_members');
    // Tenant scope (security): the target must belong to THIS channel's org — the
    // org account itself, or an ACTIVE org_members row. Without this, a channel
    // admin could rekey an arbitrary cross-org / non-org user into the E2EE group,
    // bypassing DeptChatAccessGuard's org-membership entitlement (audit D4-a).
    const ch = await this.db.qOne<{org_id: string}>(
      `SELECT org_id FROM public.department_channels WHERE id = $1 AND archived_at IS NULL`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    if (memberUserId !== ch.org_id) {
      const member = await this.db.qOne<{ok: number}>(
        `SELECT 1 AS ok FROM public.org_members
          WHERE org_user_id = $1 AND member_user_id = $2 AND status = 'active'`,
        [ch.org_id, memberUserId],
      );
      if (!member) throw new ForbiddenException('member_not_in_org');
    }
    await this.db.q(
      `INSERT INTO public.department_channel_members (channel_id, user_id, role, role_label)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id, user_id) DO UPDATE SET role = EXCLUDED.role, role_label = EXCLUDED.role_label`,
      [channelId, memberUserId, role, roleLabel ?? null],
    );
    await this.enqueueIntent(channelId, memberUserId, 'add', adminUserId);
    return {ok: true};
  }

  async removeMember(adminUserId: string, channelId: string, memberUserId: string): Promise<{ok: true}> {
    const r = await this.memberRole(adminUserId, channelId);
    if (r !== 'admin') throw new ForbiddenException('only_admin_can_manage_members');
    if (memberUserId === adminUserId) throw new ForbiddenException('cannot_remove_self');
    const removed = await this.db.qOne<{user_id: string}>(
      `DELETE FROM public.department_channel_members
        WHERE channel_id = $1 AND user_id = $2 RETURNING user_id`,
      [channelId, memberUserId],
    );
    if (!removed) throw new NotFoundException('member_not_found');
    // Enqueue the remove+rekey intent. Without the admin device acting on
    // this, the removed member retains the master key — so this is the
    // security-critical seam. (The rekey itself happens on-device.)
    await this.enqueueIntent(channelId, memberUserId, 'remove', adminUserId);
    return {ok: true};
  }

  private async enqueueIntent(
    channelId: string, memberUserId: string, action: 'add' | 'remove', requestedBy: string,
  ): Promise<void> {
    await this.db.q(
      `INSERT INTO public.channel_membership_intents (channel_id, member_user_id, action, requested_by)
       VALUES ($1, $2, $3, $4)`,
      [channelId, memberUserId, action, requestedBy],
    );
  }

  /** Pending membership intents for channels the caller administers — drained
   *  by the admin device, which broadcasts the corresponding rekey. */
  async listMembershipIntents(adminUserId: string): Promise<Array<{
    id: string; channel_id: string; group_conversation_id: string | null;
    member_user_id: string; action: 'add' | 'remove'; created_at: string;
  }>> {
    return this.db.q(
      `SELECT i.id, i.channel_id, c.group_conversation_id,
              i.member_user_id, i.action, i.created_at
         FROM public.channel_membership_intents i
         JOIN public.department_channels c ON c.id = i.channel_id
         JOIN public.department_channel_members m
           ON m.channel_id = i.channel_id AND m.user_id = $1 AND m.role = 'admin'
        WHERE i.state = 'pending'
        ORDER BY i.created_at ASC`,
      [adminUserId],
    );
  }

  /** Admin device acks it has broadcast the rekey for an intent. */
  async ackMembershipIntent(adminUserId: string, intentId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.channel_membership_intents i
          SET state = 'done', settled_at = NOW()
        WHERE i.id = $1 AND i.state = 'pending'
          AND EXISTS (
            SELECT 1 FROM public.department_channel_members m
             WHERE m.channel_id = i.channel_id AND m.user_id = $2 AND m.role = 'admin'
          )
        RETURNING i.id`,
      [intentId, adminUserId],
    );
    if (!row) throw new NotFoundException('intent_not_found_or_not_admin');
    return {ok: true};
  }

  /**
   * Change a member's role (viewer = read-only, admin = can post). Admin-only.
   * Metadata-only — NO rekey: the member already holds the group key; only their
   * post permission changes. (audit D-feature: in-thread access editing.)
   */
  async updateMemberRole(
    adminUserId: string, channelId: string, memberUserId: string, role: 'admin' | 'viewer',
    roleLabel?: string,
  ): Promise<{ok: true}> {
    const r = await this.memberRole(adminUserId, channelId);
    if (r !== 'admin') throw new ForbiddenException('only_admin_can_manage_members');
    const updated = await this.db.qOne<{user_id: string}>(
      `UPDATE public.department_channel_members
          SET role = $3, role_label = COALESCE($4, role_label)
        WHERE channel_id = $1 AND user_id = $2 RETURNING user_id`,
      [channelId, memberUserId, role, roleLabel ?? null],
    );
    if (!updated) throw new NotFoundException('member_not_found');
    return {ok: true};
  }

  /**
   * Delete a channel — ONLY the creator (the person who made the thread). Cascades
   * to members + intents via FK. Distinct from archive (manager hide). (user req.)
   */
  async deleteChannel(userId: string, channelId: string): Promise<{ok: true}> {
    const ch = await this.db.qOne<{created_by: string; org_id: string}>(
      `SELECT created_by, org_id FROM public.department_channels WHERE id = $1`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    if (ch.created_by !== userId) throw new ForbiddenException('only_creator_can_delete');
    await this.db.q(`DELETE FROM public.department_channels WHERE id = $1`, [channelId]);
    await this.audit.log(ch.org_id, userId, 'channel.delete', {targetKind: 'channel', targetId: channelId});
    return {ok: true};
  }

  /**
   * Reset the E2EE group linkage so the OWNER can re-provision a fresh group when
   * the channel is orphaned (owner lost local key state → "explicit peer address"
   * on send). Owner/creator-only. Clears group_conversation_id; the owner device
   * then mints a new group + registers it (server never holds a key). Closes the
   * irreversible-registerGroup gap (audit D4-b) and recovers orphaned channels.
   */
  async resetGroup(userId: string, channelId: string): Promise<{ok: true}> {
    const ch = await this.db.qOne<{created_by: string; org_id: string}>(
      `SELECT created_by, org_id FROM public.department_channels WHERE id = $1 AND archived_at IS NULL`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    if (ch.created_by !== userId && ch.org_id !== userId) {
      throw new ForbiddenException('only_owner_can_reset');
    }
    await this.db.q(
      `UPDATE public.department_channels SET group_conversation_id = NULL WHERE id = $1`,
      [channelId],
    );
    await this.audit.log(ch.org_id, userId, 'channel.reset_group', {targetKind: 'channel', targetId: channelId});
    return {ok: true};
  }

  private async memberRole(userId: string, channelId: string): Promise<'admin' | 'viewer'> {
    const row = await this.db.qOne<{role: 'admin' | 'viewer'}>(
      `SELECT role FROM public.department_channel_members
        WHERE channel_id = $1 AND user_id = $2`,
      [channelId, userId],
    );
    if (!row) throw new ForbiddenException('not_a_channel_member');
    return row.role;
  }
}
