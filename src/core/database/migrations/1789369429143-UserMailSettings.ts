import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserMailSettings1789369429143 implements MigrationInterface {
  name = 'UserMailSettings1789369429143';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_mail_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "userId" uuid NOT NULL, "organizationId" uuid NOT NULL, "signatureName" character varying, "signatureDesignation" character varying, "signatureCompany" character varying, "signaturePhone" character varying, "signatureWebsite" character varying, "gmailEmail" character varying, "gmailRefreshTokenEnc" text, "gmailConnectedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_587a8c5c2d1ac977dfc4168e3b5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_9c552a5fbfc88f310089fbea07" ON "user_mail_settings" ("userId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ea21b97b89d6b694e6a82bd633" ON "user_mail_settings" ("organizationId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_ea21b97b89d6b694e6a82bd633"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_9c552a5fbfc88f310089fbea07"`);
    await queryRunner.query(`DROP TABLE "user_mail_settings"`);
  }
}
