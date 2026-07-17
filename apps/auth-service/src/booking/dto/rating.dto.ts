import {IsArray, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min} from 'class-validator';

/** POST /bookings/:id/rating — client rates the agency that ran a COMPLETED booking. */
export class SubmitRatingDto {
  @IsInt() @Min(1) @Max(5)
  stars!: number;

  @IsOptional() @IsArray() @IsString({each: true}) @Length(1, 40, {each: true})
  tags?: string[];

  // Optional gratuity in credits (non-sensitive). Bounded to keep a fat-fingered tip
  // from draining a wallet; the actual tip charge is out of scope for this step.
  @IsOptional() @IsNumber() @Min(0) @Max(10_000)
  tip?: number;
}
