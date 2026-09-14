import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { EmailTone } from '../entities/organization-settings.entity';

export class UpdateOrganizationSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aiInterviewEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(180)
  defaultRoundDurationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultTimezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyOnEvaluationReady?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyOnNewApplication?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyOnInterviewScheduled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  notifyOnRoundDecision?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  weeklyDigestEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  productUpdatesEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aiQuestionGenEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aiResumeParseEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aiScoringEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aiSummaryEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aiEmailDraftingEnabled?: boolean;

  @ApiPropertyOptional({ enum: EmailTone })
  @IsOptional()
  @IsEnum(EmailTone)
  emailTone?: EmailTone;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emailSignature?: string;
}
