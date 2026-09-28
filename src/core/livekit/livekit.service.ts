import { Injectable, Logger } from '@nestjs/common';
import {
  AccessToken,
  EgressClient,
  EgressInfo,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  WebhookEvent,
  WebhookReceiver,
} from 'livekit-server-sdk';
import { getEnv, getEnvBoolean } from '@config/env';

/**
 * Thin wrapper around the LiveKit server SDK — rooms, candidate access tokens,
 * per-question Egress recordings (MP4 straight into the S3/MinIO recordings bucket)
 * and webhook verification. Works against the self-hosted server in
 * docker-compose.yml or LiveKit Cloud; only env vars differ.
 */
@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly roomClient: RoomServiceClient;
  private readonly egressClient: EgressClient;
  private readonly webhookReceiver: WebhookReceiver;

  constructor() {
    const apiUrl = getEnv('LIVEKIT_API_URL');
    this.apiKey = getEnv('LIVEKIT_API_KEY');
    this.apiSecret = getEnv('LIVEKIT_API_SECRET');
    this.roomClient = new RoomServiceClient(apiUrl, this.apiKey, this.apiSecret);
    this.egressClient = new EgressClient(apiUrl, this.apiKey, this.apiSecret);
    this.webhookReceiver = new WebhookReceiver(this.apiKey, this.apiSecret);
  }

  /** The URL the candidate's browser connects to (may differ from the server-side API url). */
  get wsUrl(): string {
    return getEnv('LIVEKIT_WS_URL');
  }

  /** Idempotent — LiveKit returns the existing room if it's already open. No
   * maxParticipants cap: the egress recorder joins as a (hidden) participant too, and
   * access is already limited by the single-identity, publish-only candidate token. */
  async ensureRoom(name: string, emptyTimeoutSeconds = 300): Promise<void> {
    await this.roomClient.createRoom({ name, emptyTimeout: emptyTimeoutSeconds });
  }

  /** Disconnects one participant (e.g. the candidate once their round is submitted).
   * Ending their tracks also lets any in-flight egress finish gracefully. */
  async removeParticipant(roomName: string, identity: string): Promise<void> {
    try {
      await this.roomClient.removeParticipant(roomName, identity);
    } catch (err) {
      this.logger.debug(
        `removeParticipant(${roomName}, ${identity}) ignored: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Publish-only token for one room: the candidate can send camera/mic but can't
   * subscribe, send data, or do anything admin-level (e.g. start/stop recordings). */
  async createCandidateToken(opts: {
    roomName: string;
    identity: string;
    name: string;
    ttlSeconds: number;
  }): Promise<string> {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: opts.identity,
      name: opts.name,
      ttl: opts.ttlSeconds,
    });
    token.addGrant({
      room: opts.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: false,
      canPublishData: false,
    });
    return token.toJwt();
  }

  /** Records one participant's camera + mic to a single MP4 at `filepath` in `bucket`. */
  async startParticipantRecording(opts: {
    roomName: string;
    identity: string;
    bucket: string;
    filepath: string;
  }): Promise<EgressInfo> {
    const file = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: opts.filepath,
      disableManifest: true,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: getEnv('STORAGE_ACCESS_KEY_ID'),
          secret: getEnv('STORAGE_SECRET_ACCESS_KEY'),
          region: getEnv('STORAGE_REGION', 'us-east-1'),
          endpoint: getEnv('LIVEKIT_EGRESS_S3_ENDPOINT', getEnv('STORAGE_ENDPOINT')),
          bucket: opts.bucket,
          forcePathStyle: getEnvBoolean('STORAGE_FORCE_PATH_STYLE', true),
        }),
      },
    });
    return this.egressClient.startParticipantEgress(opts.roomName, opts.identity, { file });
  }

  /** Stopping an egress that already ended is not an error for our purposes. */
  async stopEgress(egressId: string): Promise<void> {
    try {
      await this.egressClient.stopEgress(egressId);
    } catch (err) {
      this.logger.warn(
        `stopEgress(${egressId}) failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Current state of one egress — used to reconcile a recording whose webhook never arrived. */
  async getEgress(egressId: string): Promise<EgressInfo | null> {
    const [info] = await this.egressClient.listEgress({ egressId });
    return info ?? null;
  }

  /** Verifies the webhook signature against the raw body; throws if it doesn't match. */
  receiveWebhook(rawBody: string, authHeader: string | undefined): Promise<WebhookEvent> {
    return this.webhookReceiver.receive(rawBody, authHeader);
  }
}
