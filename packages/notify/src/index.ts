/**
 * @wabrain/notify — push notifications to the owner's devices through UnifiedPush endpoints,
 * using Web Push encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292). Payloads never contain raw
 * message text. Also home of the push-endpoint SSRF guard shared with the API.
 */
export { MAX_PAYLOAD_BYTES, encodePayload, type PushPayload } from "./payload.js";
export { PushNotifier, type FlushResult, type PayloadSender, type PushNotifierOptions } from "./notifier.js";
export { PushSender, ensureVapidKeys, type DeliveryReport, type PushLogger, type PushSenderOptions, type VapidKeys } from "./sender.js";
export { UnsafeUrlError, assertSafePushEndpoint, isPrivateAddress, type Resolver } from "./ssrf.js";

import type { Database } from "@wabrain/db";
import { PushNotifier as Notifier } from "./notifier.js";
import { PushSender as Sender, ensureVapidKeys as ensureKeys, type PushLogger as Logger } from "./sender.js";
import type { Resolver as DnsResolver } from "./ssrf.js";

export interface CreatePushOptions {
  now?: () => Date;
  database: Database;
  allowHost?: string | null;
  vapidSubject?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  resolve?: DnsResolver;
  syncIntervalMs?: number;
}

/** VAPID keys (created on first boot), the sender, and the coalescing ChangeNotifier. */
export async function createPush(options: CreatePushOptions): Promise<{ notifier: Notifier; sender: Sender }> {
  const vapid = await ensureKeys(options.database);
  const sender = new Sender({
    database: options.database,
    vapid,
    vapidSubject: options.vapidSubject,
    allowHost: options.allowHost,
    logger: options.logger,
    fetch: options.fetch,
    resolve: options.resolve,
  });
  return { sender, notifier: new Notifier({ sender, database: options.database, now: options.now, logger: options.logger, syncIntervalMs: options.syncIntervalMs }) };
}
