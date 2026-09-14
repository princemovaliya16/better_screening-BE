import { MigrationInterface, QueryRunner } from 'typeorm';

export class OrgSettingsAiAndNotificationToggles1789381134550 implements MigrationInterface {
  name = 'OrgSettingsAiAndNotificationToggles1789381134550';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "notifyOnInterviewScheduled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "notifyOnRoundDecision" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "weeklyDigestEnabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "productUpdatesEnabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "aiQuestionGenEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "aiResumeParseEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "aiScoringEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "aiSummaryEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "aiEmailDraftingEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."organization_settings_emailtone_enum" AS ENUM('professional', 'friendly', 'concise', 'warm')`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" ADD "emailTone" "public"."organization_settings_emailtone_enum" NOT NULL DEFAULT 'professional'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_settings" DROP COLUMN "emailTone"`);
    await queryRunner.query(`DROP TYPE "public"."organization_settings_emailtone_enum"`);
    await queryRunner.query(
      `ALTER TABLE "organization_settings" DROP COLUMN "aiEmailDraftingEnabled"`,
    );
    await queryRunner.query(`ALTER TABLE "organization_settings" DROP COLUMN "aiSummaryEnabled"`);
    await queryRunner.query(`ALTER TABLE "organization_settings" DROP COLUMN "aiScoringEnabled"`);
    await queryRunner.query(
      `ALTER TABLE "organization_settings" DROP COLUMN "aiResumeParseEnabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" DROP COLUMN "aiQuestionGenEnabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" DROP COLUMN "productUpdatesEnabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" DROP COLUMN "weeklyDigestEnabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" DROP COLUMN "notifyOnRoundDecision"`,
    );
    await queryRunner.query(
      `ALTER TABLE "organization_settings" DROP COLUMN "notifyOnInterviewScheduled"`,
    );
  }
}
