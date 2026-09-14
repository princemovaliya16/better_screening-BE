import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ExtractJobInfoDto {
  /** Raw pasted job post / LinkedIn listing / job description text. */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  pastedText!: string;
}
