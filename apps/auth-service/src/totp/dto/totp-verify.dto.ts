import {IsUUID, IsString, MinLength, MaxLength, IsIn} from 'class-validator';

export class TotpVerifyDto {
  @IsUUID()                                   userId!:   string;
  @IsString() @MinLength(6) @MaxLength(10)    code!:     string;
  @IsString() @MinLength(1) @MaxLength(128)   deviceId!: string;
  @IsIn(['ios','android','web'])              platform!: string;
}
