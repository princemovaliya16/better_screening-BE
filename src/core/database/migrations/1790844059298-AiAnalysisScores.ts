import { MigrationInterface, QueryRunner } from 'typeorm';

export class AiAnalysisScores1790844059298 implements MigrationInterface {
  name = 'AiAnalysisScores1790844059298';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "interview_summaries" ADD "scoreReasons" jsonb`);
    await queryRunner.query(`ALTER TABLE "interview_summaries" ADD "speechMetrics" jsonb`);
    await queryRunner.query(
      `ALTER TABLE "interview_question_analyses" ADD "dimensionScores" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "interview_question_analyses" DROP COLUMN "dimensionScores"`,
    );
    await queryRunner.query(`ALTER TABLE "interview_summaries" DROP COLUMN "speechMetrics"`);
    await queryRunner.query(`ALTER TABLE "interview_summaries" DROP COLUMN "scoreReasons"`);
  }
}
