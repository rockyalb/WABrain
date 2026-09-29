/**
 * ChangeNotifier backed by Web Push.
 *
 * - Durable notifications (Review items, reminders, summaries) are rows written by the producing
 *   transaction (see `notification_events` in @wabrain/db). `flushPending` pushes the due ones
 *   device by device, records a delivery only when the push service accepted it, and leaves failures
 *   for a later retry with backoff. A `review` change event triggers an immediate flush; the
 *   per-minute notify-tick job flushes again, so a failed push is retried even if nothing else
 *   happens. Leases in the database keep the API and worker processes from sending the same one.
 * - `sync` pushes are best effort and coalesced to at most one per interval (default 2 s) per
 *   process: a burst of changes becomes one trailing sync.
 */
import {
  claimNotificationDeliveries,
  finishNotificationDelivery,
  pruneNotifications,
  type ChangeEvent,
  type ChangeNotifier,
  type ClaimedDelivery,
  type Database,
} from "@wabrain/db";
import type { PushPayload } from "./payload.js";
import type { DeliveryReport, PushLogger } from "./sender.js";

export interface PayloadSender {
  sendToAll(payload: PushPayload): Promise<DeliveryReport>;
  /** Required for durable notifications (one delivery row per device). */
  sendToDevice?(payload: PushPayload, deviceId: string): Promise<DeliveryReport>;
}

export interface PushNotifierOptions {
  sender: PayloadSender;
  /** Enables durable notifications; without it Review events are pushed best effort. */
  database?: Database;
  now?: () => Date;
  syncIntervalMs?: number;
  logger?: PushLogger;
  /** Deliveries claimed per round (default 50). */
  batchSize?: number;
}

export interface FlushResult {
  pushed: number;
  failed: number;
}

/** Rounds per flush: bounds one call's work while a backlog drains over later ticks. */
const MAX_ROUNDS = 20;

export class PushNotifier implements ChangeNotifier {
  private readonly sender: PayloadSender;
  private readonly interval: number;
  private readonly logger?: PushLogger;
  private lastSyncAt = 0;
  private syncTimer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly database?: Database;
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(options: PushNotifierOptions) {
    this.sender = options.sender;
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.interval = options.syncIntervalMs ?? 2000;
    this.logger = options.logger;
    this.batchSize = options.batchSize ?? 50;
  }

  async notify(event: ChangeEvent): Promise<void> {
    if (event.type === "sync") {
      this.scheduleSync();
      return;
    }
    // The Review item's notification was stored with it; push it now.
    if (this.durable) {
      await this.flushPending();
      return;
    }
    await this.send({ type: "review", reviewItemId: event.reviewItemId, reviewType: event.reviewType, title: event.title });
  }

  /** Best-effort push to every device (sync hints). Never throws. */
  send(payload: PushPayload): Promise<DeliveryReport | null> {
    return this.track(
      this.sender.sendToAll(payload).catch((error: unknown) => {
        this.logger?.warn("push send failed", { type: payload.type, error: (error as Error).name });
        return null;
      }),
    );
  }

  private get durable(): boolean {
    return Boolean(this.database && this.sender.sendToDevice);
  }

  /**
   * Pushes every due durable notification to each device with an endpoint. A delivery is recorded
   * only when that device's push service accepted it; failures are retried after a backoff.
   */
  flushPending(now = this.now()): Promise<FlushResult> {
    if (!this.durable) return Promise.resolve({ pushed: 0, failed: 0 });
    return this.track(this.deliverPending(now));
  }

  private async deliverPending(now: Date): Promise<FlushResult> {
    const db = this.database!.db;
    const result: FlushResult = { pushed: 0, failed: 0 };
    await pruneNotifications(db, now);
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const batch = await claimNotificationDeliveries(db, now, { limit: this.batchSize });
      const outcomes = await Promise.all(batch.map((delivery) => this.deliverOne(delivery, now)));
      for (const pushed of outcomes) result[pushed ? "pushed" : "failed"] += 1;
      if (batch.length < this.batchSize) break;
    }
    if (result.failed) this.logger?.warn("notification pushes deferred", { ...result });
    return result;
  }

  private async deliverOne(delivery: ClaimedDelivery, now: Date): Promise<boolean> {
    let pushed = false;
    try {
      const report = await this.sender.sendToDevice!(delivery.payload, delivery.deviceId);
      pushed = report.delivered > 0 && report.failed === 0;
    } catch (error) {
      this.logger?.warn("notification push error", { notificationId: delivery.eventId, error: (error as Error).name });
    }
    // Without a recorded outcome the lease expires and the delivery is retried (at least once).
    await finishNotificationDelivery(this.database!.db, delivery, pushed, now).catch((error: unknown) =>
      this.logger?.warn("notification delivery not recorded", { notificationId: delivery.eventId, error: (error as Error).name }),
    );
    return pushed;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    );
    return promise;
  }

  private scheduleSync(): void {
    if (this.syncTimer) return; // A pending trailing sync covers this change.
    const wait = Math.max(0, this.lastSyncAt + this.interval - Date.now());
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.lastSyncAt = Date.now();
      void this.send({ type: "sync" });
    }, wait);
    this.syncTimer.unref?.();
  }

  /** Sends a pending sync now and waits for in-flight pushes (graceful shutdown). */
  async flush(): Promise<void> {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.lastSyncAt = Date.now();
      void this.send({ type: "sync" });
    }
    await Promise.allSettled([...this.inFlight]);
  }
}
