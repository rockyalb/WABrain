#!/usr/bin/env node
// One-time registration of WABrain's signed webhook in OpenWA (Node 22+, no dependencies).
//
// It uses a SHORT-LIVED operator key and never keeps an admin credential around:
//   - OPENWA_OPERATOR_KEY set: that key is used as is (create it in the OpenWA dashboard with role
//     "operator", limited to the session, with an expiry of a few minutes).
//   - otherwise OPENWA_ADMIN_KEY: the script mints an operator key scoped to OPENWA_SESSION_ID that
//     expires in 10 minutes, registers the webhook with it, and deletes it again.
//
// Re-running is safe: an existing webhook for the same URL is updated (events, secret, retries)
// instead of duplicated. Keys and secrets are never printed.
//
// This touches OpenWA configuration only. It sends nothing to WhatsApp, and the brain API and worker
// never get these keys (they only hold the read key, OPENWA_READ_API_KEY).
//
// Environment:
//   OPENWA_BASE_URL        default http://openwa:2785 (the compose service)
//   OPENWA_SESSION_ID      required: the session UUID
//   OPENWA_WEBHOOK_SECRET  required: the same secret the API verifies (at least 32 characters)
//   WEBHOOK_URL            default http://api:8787/webhooks/openwa (internal; OpenWA allows the
//                          "api" host through SSRF_ALLOWED_HOSTS). Use the public HTTPS URL when
//                          OpenWA runs elsewhere, e.g. https://brain.example.com/webhooks/openwa
//   OPENWA_OPERATOR_KEY or OPENWA_ADMIN_KEY

const EVENTS = ["message.received", "message.sent"];
const RETRY_COUNT = 5;
const TEMP_KEY_TTL_MS = 10 * 60_000;

const env = process.env;
const baseUrl = (env.OPENWA_BASE_URL || "http://openwa:2785").replace(/\/+$/, "");
const sessionId = env.OPENWA_SESSION_ID?.trim();
const secret = env.OPENWA_WEBHOOK_SECRET;
const webhookUrl = env.WEBHOOK_URL || "http://api:8787/webhooks/openwa";

function fail(message) {
  console.error(`register-webhook: ${message}`);
  process.exit(1);
}

if (!sessionId) fail("OPENWA_SESSION_ID is required (the session UUID shown in the OpenWA dashboard).");
if (!secret || secret.length < 32) fail("OPENWA_WEBHOOK_SECRET must be set (at least 32 characters); run deploy/init.sh.");
if (!env.OPENWA_OPERATOR_KEY && !env.OPENWA_ADMIN_KEY) fail("set OPENWA_OPERATOR_KEY, or OPENWA_ADMIN_KEY to mint a temporary operator key.");
try {
  new URL(webhookUrl);
} catch {
  fail("WEBHOOK_URL is not a valid URL.");
}

async function call(method, path, key, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "X-API-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    // OpenWA error bodies do not echo keys or secrets; keep only a short message anyway.
    let detail = "";
    try {
      const parsed = JSON.parse(text);
      detail = [parsed.message].flat().filter(Boolean).join("; ");
    } catch {
      detail = text.slice(0, 200);
    }
    throw new Error(`${method} ${path} failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return text ? JSON.parse(text) : null;
}

const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
let tempKeyId = null;

async function operatorKey() {
  if (env.OPENWA_OPERATOR_KEY) return env.OPENWA_OPERATOR_KEY;
  const created = await call("POST", "/api/auth/api-keys", env.OPENWA_ADMIN_KEY, {
    name: `wabrain-webhook-registration-${new Date().toISOString().slice(0, 19)}`,
    role: "operator",
    allowedSessions: [sessionId],
    expiresAt: new Date(Date.now() + TEMP_KEY_TTL_MS).toISOString(),
  });
  tempKeyId = created.id;
  console.log(`Created a temporary operator key (${created.keyPrefix}…, expires in 10 minutes).`);
  return created.apiKey;
}

async function removeTempKey() {
  if (!tempKeyId) return;
  try {
    await call("DELETE", `/api/auth/api-keys/${encodeURIComponent(tempKeyId)}`, env.OPENWA_ADMIN_KEY);
    console.log("Deleted the temporary operator key.");
  } catch (error) {
    console.error(`Could not delete the temporary operator key (it expires on its own): ${error.message}`);
    process.exitCode = 1;
  }
}

try {
  const key = await operatorKey();
  const existing = (await call("GET", `${sessionPath}/webhooks`, key)) ?? [];
  const match = existing.find((hook) => hook.url === webhookUrl);
  const settings = { events: EVENTS, secret, retryCount: RETRY_COUNT };
  if (match) {
    await call("PUT", `${sessionPath}/webhooks/${encodeURIComponent(match.id)}`, key, { ...settings, active: true });
    console.log(`Updated webhook ${match.id} -> ${webhookUrl} (${EVENTS.join(", ")}).`);
  } else {
    const created = await call("POST", `${sessionPath}/webhooks`, key, { url: webhookUrl, ...settings });
    console.log(`Registered webhook ${created.id} -> ${webhookUrl} (${EVENTS.join(", ")}).`);
  }
  if (env.OPENWA_OPERATOR_KEY) console.log("Revoke the operator key in the OpenWA dashboard now; WABrain does not need it.");
} catch (error) {
  console.error(`register-webhook: ${error.message}`);
  process.exitCode = 1;
} finally {
  await removeTempKey();
}
