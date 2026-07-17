import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber,
  IsObject, IsOptional, IsString, IsUUID, Length, Max, Min,
} from 'class-validator';

// Geotag bounds mirror the lat/lng validation pattern from agent.dto.ts so an
// out-of-Earth coordinate is rejected at the ValidationPipe, not the handler.
export class ClockInDto {
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)
  lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lng?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  accuracy_m?: number;

  // Dept Chat v2 (Step 5): verified check-in against an assigned shift.
  // shift_id is advisory — the server authoritatively resolves today's shift.
  @IsOptional() @IsUUID()
  shift_id?: string;
  // Result of the on-device face PRESENCE check (liveness only). The boolean is
  // the only biometric signal that crosses the wire — never frames/descriptors.
  @IsOptional() @IsBoolean()
  face_ok?: boolean;
  // D6-e — the camera/face step couldn't run (permission denied, no camera).
  // Distinct from face_ok===false so the review queue shows the right reason.
  @IsOptional() @IsBoolean()
  face_unavailable?: boolean;
  // Non-biometric audit metadata: { model, version, confidenceBucket }. 🛑 Must
  // NOT carry raw frames or face descriptors (enforced by the log-audit test).
  @IsOptional() @IsObject()
  face_meta?: Record<string, unknown>;
  // Client hint that this was an offline-queued submission → forces Pending Review.
  @IsOptional() @IsBoolean()
  offline?: boolean;
}

export class ClockOutDto {
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)
  lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  lng?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  accuracy_m?: number;
  // PDF p.5 — face confirmation is required at check-OUT too. Same semantics as
  // ClockInDto: booleans only, never frames/descriptors.
  @IsOptional() @IsBoolean()
  face_ok?: boolean;
  @IsOptional() @IsBoolean()
  face_unavailable?: boolean;
}

// Member disputes their own attendance record (PDF p.8 support route).
export class DisputeSessionDto {
  @IsString() @Length(3, 500)
  note!: string;
}

// Provider edit of a shift (e.g. correcting a forgotten clock-out). Requires a
// reason for the audit trail; flips the row to status='edited'.
export class EditShiftDto {
  @IsOptional() @IsString() clock_in_at?: string;
  @IsOptional() @IsString() clock_out_at?: string;
  @IsString() @Length(3, 280) edit_reason!: string;
}

// ─── Dept Chat v2 · shift CRUD + assignment (Step 4) ─────────────────────────

// Manager creates an expected duty window + geofence centre + radius.
export class CreateShiftDto {
  @IsOptional() @IsString() @Length(1, 120) department?: string;
  @IsOptional() @IsString() @Length(1, 120) site_label?: string;
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  site_lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) site_lng?: number;
  @IsOptional() @IsInt() @Min(10) @Max(10_000) approved_radius_m?: number;
  @IsISO8601() start_at!: string;
  @IsISO8601() end_at!: string;
}

// Manager assigns active org CPOs to a shift. Cross-org ids are rejected at the
// service layer (cpo_not_active_member_of_org), not here.
export class AssignCposDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200)
  @IsUUID('4', {each: true})
  cpo_user_ids!: string[];
}

// Manager clears a Pending Review record (Step 6).
export class ReviewSessionDto {
  @IsIn(['approve', 'reject'])
  decision!: 'approve' | 'reject';
  @IsOptional() @IsString() @Length(1, 500)
  notes?: string;
}

// Manager sets a non-check-in day status for a CPO (Step 6).
export class SetDayStatusDto {
  @IsUUID() cpo_user_id!: string;
  @IsIn(['leave', 'sick_leave', 'off_duty', 'absent'])
  status!: 'leave' | 'sick_leave' | 'off_duty' | 'absent';
  @IsOptional() @IsISO8601() date?: string;
  @IsOptional() @IsString() @Length(1, 500) notes?: string;
}

// Attendance export filters (Step 7). PDF is rendered client-side; the server
// emits CSV. Biometric data is never included.
export class ExportSessionsDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsUUID() cpo_user_id?: string;
  @IsOptional() @IsString() @Length(1, 120) department?: string;
  @IsOptional() @IsUUID() shift_id?: string;
}

// Manager patches a shift's window/site/geofence (all optional; audited).
export class UpdateShiftDto {
  @IsOptional() @IsString() @Length(1, 120) department?: string;
  @IsOptional() @IsString() @Length(1, 120) site_label?: string;
  @IsOptional() @IsNumber() @Min(-90)  @Max(90)  site_lat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) site_lng?: number;
  @IsOptional() @IsInt() @Min(10) @Max(10_000) approved_radius_m?: number;
  @IsOptional() @IsISO8601() start_at?: string;
  @IsOptional() @IsISO8601() end_at?: string;
}
