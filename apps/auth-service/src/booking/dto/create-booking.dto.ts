import {IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min} from 'class-validator';

/** Legacy-compatible location payload. */
export class LocationDto {
  @IsNumber() latitude!: number;
  @IsNumber() longitude!: number;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() label?: string;
}

/** POST /bookings — create a new Lite booking (DRAFT → PENDING_OPS in one call). */
export class CreateBookingDto {
  @IsIn(['transfer', 'timeslot', 'itinerary'])
  type!: 'transfer' | 'timeslot' | 'itinerary';

  @IsNotEmpty() pickup!: LocationDto;

  @IsOptional() dropoff?: LocationDto;

  @IsString() @IsNotEmpty()
  start_time!: string;

  @IsOptional() @IsInt() @Min(1) @Max(24)
  duration_hours?: number;

  @IsArray() @IsString({each: true})
  add_ons!: string[];

  @IsIn(['card', 'bravo_credits', 'corporate'])
  payment_method!: 'card' | 'bravo_credits' | 'corporate';

  @IsString() @IsNotEmpty()
  region!: string;

  @IsOptional() @IsString()
  notes?: string;

  // ─── Lite wizard extras (new flow) ───────────────────────────────
  @IsOptional() @IsString()
  region_label?: string;

  @IsOptional() @IsIn(['secure_transfer', 'executive_protection', 'recon_team', 'emergency_extraction'])
  service?: string;

  @IsOptional() @IsIn(['now', 'later'])
  booking_mode?: 'now' | 'later';

  @IsOptional() @IsInt() @Min(1) @Max(16)
  passengers?: number;

  @IsOptional() @IsInt() @Min(1) @Max(4)
  cpo_count?: number;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  vehicle_count?: number;

  @IsOptional() @IsBoolean()
  driver_only?: boolean;

  // ─── Step 22 lawful-basis consent ────────────────────────────────
  // Auto-dispatch shares the client's precise pickup + live location with a
  // third-party agency, so the auto path (POST /dispatch/request) requires
  // explicit, versioned location + terms consent. Optional on the DTO so the
  // legacy ops-mediated path stays byte-for-byte unchanged; the server gates.
  @IsOptional() @IsBoolean()
  location_consent?: boolean;

  @IsOptional() @IsBoolean()
  terms_accepted?: boolean;

  @IsOptional() @IsString()
  location_consent_version?: string;

  @IsOptional() @IsString()
  terms_accepted_version?: string;
}

/** POST /bookings/estimate — price preview (no persistence). */
export class EstimateBookingDto {
  @IsIn(['transfer', 'timeslot', 'itinerary'])
  type!: 'transfer' | 'timeslot' | 'itinerary';

  @IsOptional() @IsInt() @Min(1) @Max(24)
  duration_hours?: number;

  @IsArray() @IsString({each: true})
  add_ons!: string[];

  @IsString() @IsNotEmpty()
  region!: string;

  @IsOptional() @IsInt() @Min(1) @Max(4)
  cpo_count?: number;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  vehicle_count?: number;

  @IsOptional() @IsBoolean()
  driver_only?: boolean;

  @IsOptional() @IsString()
  pickup_time?: string;
}
