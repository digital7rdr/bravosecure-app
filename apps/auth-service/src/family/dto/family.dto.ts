import {IsInt, IsOptional, IsString, Matches, Min, Max} from 'class-validator';

export class InviteMemberDto {
  // E.164 — same shape the messenger contact lookup normalises to.
  @Matches(/^\+\d{6,15}$/, {message: 'phoneE164 must be E.164'}) phoneE164!: string;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
}

export class SetSpendLimitDto {
  // null clears the cap (unlimited within the holder's balance).
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
}

export class InviteActionDto {
  @IsString() inviteId!: string;
}
