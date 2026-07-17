import {IsUUID, Matches, IsString, MinLength, MaxLength, IsIn} from 'class-validator';

export class VerifyDto {
  @IsUUID()                                userId!:   string;
  @Matches(/^\d{4,8}$/)                    code!:     string;
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
  @IsIn(['ios','android','web'])            platform!: string;
}
