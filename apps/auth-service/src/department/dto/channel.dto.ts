import {IsIn, IsOptional, IsString, IsUUID, Length, MaxLength} from 'class-validator';

// Channels Hub v2 (PDF p.4). Type drives the Board/Department/Incident grouping;
// access drives the read-only/restricted badges + manager-only seeding. These
// mirror the CHECK constraints in 20260629000002_channel_types.sql.
export const CHANNEL_TYPES = ['board', 'department', 'incident'] as const;
export const CHANNEL_ACCESS = ['standard', 'read_only', 'restricted'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export type ChannelAccess = (typeof CHANNEL_ACCESS)[number];

export const MEMBER_ROLES = ['admin', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

// Manager/company-admin creates a channel (OrgManagerGuard). Defaults match the
// migration defaults so an omitted type/access reads as a normal dept channel.
export class CreateChannelDto {
  @IsString() @Length(1, 80)
  name!: string;

  @IsOptional() @IsString() @Length(1, 80)
  department?: string;

  @IsOptional() @IsIn(CHANNEL_TYPES as unknown as string[])
  channel_type?: ChannelType;

  @IsOptional() @IsIn(CHANNEL_ACCESS as unknown as string[])
  access?: ChannelAccess;
}

// Partial update — every field optional; only the supplied ones change
// (COALESCE in the service). Tightening `access` to restricted/incident also
// rekeys non-manager members out via the existing removeMember path.
export class ConfigureChannelDto {
  @IsOptional() @IsString() @Length(1, 80)
  name?: string;

  // D7-c — allow an empty string so the department CAN be cleared (the service treats
  // '' as the explicit-clear sentinel). MaxLength only (no min) instead of Length(1,80).
  @IsOptional() @IsString() @MaxLength(80)
  department?: string;

  @IsOptional() @IsIn(CHANNEL_TYPES as unknown as string[])
  channel_type?: ChannelType;

  @IsOptional() @IsIn(CHANNEL_ACCESS as unknown as string[])
  access?: ChannelAccess;
}

// D4-e — validated bodies for the membership/group endpoints that previously took
// unvalidated inline `@Body() body: {...}` types (registerGroup / addMember / updateMemberRole).
export class RegisterGroupDto {
  @IsString() @Length(1, 200)
  group_conversation_id!: string;
}

export class AddMemberDto {
  @IsUUID()
  user_id!: string;

  @IsOptional() @IsIn(MEMBER_ROLES as unknown as string[])
  role?: MemberRole;

  @IsOptional() @IsString() @MaxLength(60)
  role_label?: string;
}

export class UpdateMemberRoleDto {
  @IsIn(MEMBER_ROLES as unknown as string[])
  role!: MemberRole;
}
