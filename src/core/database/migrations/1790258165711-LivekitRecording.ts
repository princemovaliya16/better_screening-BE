import { MigrationInterface, QueryRunner } from 'typeorm';

export class LivekitRecording1790258165711 implements MigrationInterface {
  name = 'LivekitRecording1790258165711';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "interview_answers" ADD "egressId" character varying`);
    await queryRunner.query(
      `ALTER TABLE "interview_answers" ADD "recordingStartedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_answers" ADD "recordingEndedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "interview_answers" ADD "failureReason" text`);
    await queryRunner.query(
      `ALTER TYPE "public"."interview_answers_status_enum" RENAME TO "interview_answers_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."interview_answers_status_enum" AS ENUM('recording', 'processing', 'failed', 'uploaded', 'transcribed', 'scored')`,
    );
    await queryRunner.query(`ALTER TABLE "interview_answers" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "interview_answers" ALTER COLUMN "status" TYPE "public"."interview_answers_status_enum" USING "status"::"text"::"public"."interview_answers_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_answers" ALTER COLUMN "status" SET DEFAULT 'uploaded'`,
    );
    await queryRunner.query(`DROP TYPE "public"."interview_answers_status_enum_old"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_56add7a37079ebb81df007e073" ON "interview_answers" ("egressId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_56add7a37079ebb81df007e073"`);
    await queryRunner.query(
      `CREATE TYPE "public"."interview_answers_status_enum_old" AS ENUM('uploaded', 'transcribed', 'scored')`,
    );
    await queryRunner.query(`ALTER TABLE "interview_answers" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "interview_answers" ALTER COLUMN "status" TYPE "public"."interview_answers_status_enum_old" USING "status"::"text"::"public"."interview_answers_status_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_answers" ALTER COLUMN "status" SET DEFAULT 'uploaded'`,
    );
    await queryRunner.query(`DROP TYPE "public"."interview_answers_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."interview_answers_status_enum_old" RENAME TO "interview_answers_status_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "failureReason"`);
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "recordingEndedAt"`);
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "recordingStartedAt"`);
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "egressId"`);
  }
}
