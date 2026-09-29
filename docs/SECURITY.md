# Security and privacy

WABrain is a single-owner service. Its trust boundaries are WhatsApp →
OpenWA → signed intake → database/worker → configured model providers, and the
owner browser/paired Android devices → authenticated API. OpenWA and the host
administrator are trusted: a compromised gateway can forge incoming evidence,
and a compromised host can read the stored conversations.

## Intake and model boundary

- Verify OpenWA HMAC over the exact request bytes, validate the payload, and
  deduplicate by session and event key before analysis. Off chats, one-time
  codes, view-once media, and status updates are filtered before storage.
- All message, filename, OCR, transcript, quote, and document content is
  untrusted evidence. Models propose structured actions; deterministic rules
  enforce ownership, evidence, ambiguity, calibration, and Review. Prompt
  injection fixtures include non-English examples; they cannot establish perfect
  resistance to every model or input.
- The adapter permits GET reads only. WABrain has no WhatsApp send,
  react, edit, delete, read-receipt, presence, or group-management capability.
  Use a session-scoped viewer key; never configure an OpenWA master key in the
  brain API, worker, or phone. Pair WhatsApp in the OpenWA dashboard.
- Provider configuration selects where bounded text, images, and audio are
  sent. Hosted providers receive that content; local compatible providers are
  supported. Provider tests also make real model calls. Stored provider keys
  are encrypted using `APP_ENCRYPTION_KEY`; environment secrets depend on host
  protection. Logs redact configured secrets and do not log message bodies.

## API, browser, and device boundary

Owner passwords are hashed. The setup page uses expiring HttpOnly, Secure,
SameSite=Strict cookies with origin checks and a restrictive content policy.
Configure a bootstrap token before exposing an uninitialized installation.
Login, bootstrap, and the minimal session-state endpoint are public; operational
setup routes require the owner session. Device pairing consumes a short-lived,
one-use code; subsequent app endpoints require a revocable bearer token whose
server-side representation is hashed. `/health` reveals only health status.
Startup validates configuration and rejects weak production secrets.

Login, pairing, webhooks, media, and expensive setup operations are rate limited.
User-supplied push endpoints are checked against SSRF rules; only the explicitly
configured ntfy host may bypass the private-address restriction. Provider and
OpenWA addresses are trusted owner configuration, not arbitrary chat links.
Review decisions, configuration changes, pairing, and deletions are audited.

Android stores its token through the Keystore-backed store. Push uses Web Push
encryption, contains task summaries rather than raw message bodies, and has a
generic lock-screen version. Alerts blocked by notification permissions remain
pending for later synchronization until their server expiry. Revocation prevents
future API access; it cannot erase data already cached on a disconnected phone.

## Media, storage, and operations

Media downloads have byte/time/type limits. Raw media is held temporarily in
memory and discarded after processing; derived text remains. PDFs use a text
layer first, with capped rendered-page vision fallback, worker-thread timeout,
and page/pixel/output limits. A worker thread is **not an OS security sandbox**;
its heap setting does not bound native/WASM allocations. Run the service with
container/host resource limits and keep parsers updated. Hostile-PDF memory
exhaustion has not been proven impossible.

PostgreSQL retains accepted messages indefinitely until deletion. Use host disk
encryption and encrypted backups, protect the encryption key separately, and
perform a restore drill. The Compose Node services run non-root, with read-only
filesystems and no capabilities; the database is on an internal network.
Chat/person deletion removes associated stored data. The application wipe keeps
minimal Off-chat identifiers so excluded conversations do not silently resume;
see [OPERATIONS.md](OPERATIONS.md) for precise wipe and uninstall scope.

CI includes dependency review and secret scanning. Real-device behavior,
provider quality, host encryption, and a real restore drill remain deployment
checks; automated tests do not replace them.

Unofficial WhatsApp clients may violate WhatsApp terms or lead to account action.
This project is intended for the owner's own account and data, not unsolicited
messaging or surveillance.
