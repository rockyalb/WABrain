/**
 * Web Push sender for UnifiedPush endpoints: RFC 8291 (aes128gcm) payload encryption and RFC 8292
 * VAPID via the `web-push` package; delivery over fetch so it is injectable and never follows
 * redirects. Every endpoint is re-validated against the SSRF guard right before sending.
 */
import {
  getOrCreateAppState,
  listPushEndpoints,
  markPushDelivered,
  markPushFailed,
  removePushEndpoint,
  type Database,
} from "@wabrain/db";
import webpush from "web-push";
import { encodePayload, type PushPayload } from "./payload.js";
import { assertSafePushEndpoint, type Resolver } from "./ssrf.js";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const VAPID_STATE_KEY = "push.vapid";

/** The server's VAPID key pair, generated on first boot and stored in the database. */
export async function ensureVapidKeys(database: Database): Promise<VapidKeys> {
  return getOrCreateAppState<VapidKeys>(database.db, VAPID_STATE_KEY, () => webpush.generateVAPIDKeys());
}

export interface PushSenderOptions {
  database: Database;
  vapid: VapidKeys;
  /** "mailto:" or "https:" contact for push services. */
  vapidSubject?: string;
  /** Hostname exempt from the private-address check (self-hosted ntfy). */
  allowHost?: string | null;
  resolve?: Resolver;
  fetch?: typeof fetch;
  timeoutMs?: number;
  logger?: PushLogger;
}

export interface DeliveryReport {
  endpoints: number;
  delivered: number;
  removed: number;
  failed: number;
}

const silent: PushLogger = { info() {}, warn() {} };
const TTL_SECONDS: Record<PushPayload["type"], number> = { sync: 3600, review: 7 * 86_400, reminder: 86_400, summary: 12 * 3600 };
const URGENCY: Record<PushPayload["type"], "normal" | "high"> = { sync: "normal", review: "high", reminder: "high", summary: "normal" };

export class PushSender {
  private readonly database: Database;
  private readonly vapidDetails: { subject: string; publicKey: string; privateKey: string };
  private readonly fetchImpl: typeof fetch;
  private readonly logger: PushLogger;
  /** Endpoints that rejected a VAPID Authorization header; they get plain Web Push. */
  private readonly withoutVapid = new Set<string>();

  constructor(private readonly options: PushSenderOptions) {
    this.database = options.database;
    this.vapidDetails = { subject: options.vapidSubject ?? "mailto:wabrain@example.invalid", ...options.vapid };
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger ?? silent;
  }

  get vapidPublicKey(): string {
    return this.vapidDetails.publicKey;
  }

  /** Sends one payload to every active device endpoint. Never throws for delivery failures. */
  async sendToAll(payload: PushPayload): Promise<DeliveryReport> {
    return this.sendSelected(payload);
  }

  /** Sends one payload to one device's endpoint (durable notifications). Never throws for delivery failures. */
  async sendToDevice(payload: PushPayload, deviceId: string): Promise<DeliveryReport> {
    return this.sendSelected(payload, deviceId);
  }

  private async sendSelected(payload: PushPayload, deviceId?: string): Promise<DeliveryReport> {
    const body = encodePayload(payload);
    const endpoints = (await listPushEndpoints(this.database.db)).filter(
      (e) => (deviceId === undefined || e.deviceId === deviceId) && (payload.type !== "sync" || !e.deviceId.startsWith("web:")),
    );
    const report: DeliveryReport = { endpoints: endpoints.length, delivered: 0, removed: 0, failed: 0 };
    await Promise.all(
      endpoints.map(async (endpoint) => {
        const outcome = await this.sendOne(endpoint, body, payload.type);
        report[outcome] += 1;
      }),
    );
    return report;
  }

  private async sendOne(
    endpoint: { id: string; endpoint: string; p256dh: string; auth: string },
    body: string,
    type: PushPayload["type"],
  ): Promise<"delivered" | "removed" | "failed"> {
    try {
      await assertSafePushEndpoint(endpoint.endpoint, { allowHost: this.options.allowHost, resolve: this.options.resolve });
    } catch (error) {
      await markPushFailed(this.database.db, endpoint.id).catch(() => {});
      this.logger.warn("push endpoint rejected by SSRF guard", { endpointId: endpoint.id, reason: (error as Error).message });
      return "failed";
    }
    const subscription = { endpoint: endpoint.endpoint, keys: { p256dh: endpoint.p256dh, auth: endpoint.auth } };
    const vapid = !this.withoutVapid.has(endpoint.id);
    try {
      let status = await this.post(subscription, body, type, vapid);
      if (vapid && (status === 400 || status === 401 || status === 403)) {
        // Some distributors do not accept VAPID; retry once without it and remember.
        const plain = await this.post(subscription, body, type, false);
        if (plain >= 200 && plain < 300) this.withoutVapid.add(endpoint.id);
        status = plain;
      }
      if (status >= 200 && status < 300) {
        await markPushDelivered(this.database.db, endpoint.id);
        return "delivered";
      }
      if (status === 404 || status === 410) {
        await removePushEndpoint(this.database.db, endpoint.id);
        this.logger.info("push endpoint gone; removed", { endpointId: endpoint.id, status });
        return "removed";
      }
      await markPushFailed(this.database.db, endpoint.id);
      this.logger.warn("push delivery failed", { endpointId: endpoint.id, status });
      return "failed";
    } catch (error) {
      await markPushFailed(this.database.db, endpoint.id).catch(() => {});
      this.logger.warn("push delivery error", { endpointId: endpoint.id, error: (error as Error).name });
      return "failed";
    }
  }

  private async post(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    body: string,
    type: PushPayload["type"],
    vapid: boolean,
  ): Promise<number> {
    const details = webpush.generateRequestDetails(subscription, body, {
      vapidDetails: vapid ? this.vapidDetails : null,
      TTL: TTL_SECONDS[type],
      urgency: URGENCY[type],
      contentEncoding: "aes128gcm",
      // A newer sync replaces an undelivered older one at the push service.
      ...(type === "sync" ? { topic: "sync" } : {}),
    } as webpush.RequestOptions);
    const response = await this.fetchImpl(details.endpoint, {
      method: "POST",
      headers: details.headers as Record<string, string>,
      body: details.body as unknown as BodyInit,
      redirect: "manual",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  }
}
