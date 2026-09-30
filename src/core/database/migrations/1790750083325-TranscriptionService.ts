import { MigrationInterface, QueryRunner } from 'typeorm';

export class TranscriptionService1790750083325 implements MigrationInterface {
  name = 'TranscriptionService1790750083325';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."interview_answers_transcriptionstatus_enum" AS ENUM('pending', 'completed', 'failed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "interview_answers" ADD "transcriptionStatus" "public"."interview_answers_transcriptionstatus_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "interview_answers" ADD "transcriptText" text`);
    await queryRunner.query(`ALTER TABLE "interview_answers" ADD "transcriptSegments" jsonb`);
    await queryRunner.query(`ALTER TABLE "interview_answers" ADD "transcriptionError" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "transcriptionError"`);
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "transcriptSegments"`);
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "transcriptText"`);
    await queryRunner.query(`ALTER TABLE "interview_answers" DROP COLUMN "transcriptionStatus"`);
    await queryRunner.query(`DROP TYPE "public"."interview_answers_transcriptionstatus_enum"`);
  }
}
