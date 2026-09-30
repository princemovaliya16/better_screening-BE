import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { createWriteStream } from 'fs';
import { mkdir, rename, rm } from 'fs/promises';
import { dirname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getEnv, getEnvBoolean, getEnvNumber } from '@config/env';

/**
 * Thin wrapper around an S3-compatible client (works against real S3 or self-hosted
 * MinIO — see docker-compose.yml). Two logical buckets: resumes and interview
 * recordings, each with its own env-configured bucket name.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({
      endpoint: getEnv('STORAGE_ENDPOINT'),
      region: getEnv('STORAGE_REGION', 'us-east-1'),
      credentials: {
        accessKeyId: getEnv('STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: getEnv('STORAGE_SECRET_ACCESS_KEY'),
      },
      forcePathStyle: getEnvBoolean('STORAGE_FORCE_PATH_STYLE', true),
    });
  }

  private defaultTtl(): number {
    return getEnvNumber('STORAGE_SIGNED_URL_TTL_SECONDS', 900);
  }

  async getSignedUploadUrl(bucket: string, key: string, contentType: string): Promise<string> {
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.client, command, { expiresIn: this.defaultTtl() });
  }

  async getSignedDownloadUrl(bucket: string, key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: this.defaultTtl() });
  }

  /** Small buffered upload — for files the backend handles directly rather than via
   * a presigned browser upload (e.g. a future server-side resume ingestion path). */
  async upload(bucket: string, key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return key;
  }

  /** Streams an object to a local file. Writes to `<destPath>.part` and renames into
   * place, so a reader of `destPath` (e.g. the transcription service on the shared
   * audio folder) never sees a partial file. */
  async downloadToFile(bucket: string, key: string, destPath: string): Promise<void> {
    const { Body } = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!(Body instanceof Readable)) throw new Error(`Empty or unreadable object: ${key}`);
    await mkdir(dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;
    try {
      await pipeline(Body, createWriteStream(partPath));
      await rename(partPath, destPath);
    } catch (err) {
      await rm(partPath, { force: true });
      throw err;
    }
  }

  get recordingsBucket(): string {
    return getEnv('STORAGE_BUCKET_RECORDINGS');
  }

  get resumesBucket(): string {
    return getEnv('STORAGE_BUCKET_RESUMES');
  }
}
