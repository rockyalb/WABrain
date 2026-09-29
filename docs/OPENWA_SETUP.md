# OpenWA setup

WABrain reads WhatsApp through the `rmyndharis/OpenWA` gateway. There are
two setups, both described step by step in [DEPLOY.md](DEPLOY.md):

- **Compose bundle (recommended):** the `openwa` service in
  `deploy/docker-compose.yml`, which already runs with the settings from step 1
  (skip that step).
- **An OpenWA you run elsewhere** (for example on Railway), possibly shared with
  another app that uses the same WhatsApp session.

This document covers the OpenWA side: the engine, the key roles, the webhook,
pairing, and the checks.

## 1. Switch an existing OpenWA to Baileys

Set these variables on the existing OpenWA service:

```dotenv
ENGINE_TYPE=baileys
BAILEYS_AUTH_DIR=/app/data/baileys
BAILEYS_SYNC_FULL_HISTORY=true
```

Make sure `/app/data` is the mounted persistent volume. Stop the current session
before changing the engine, deploy the new variables, then start and inspect it
from the OpenWA dashboard.

The compose bundle additionally sets `BAILEYS_MARK_ONLINE_ON_CONNECT=false`
(otherwise the phone stops showing notifications while OpenWA is connected) and
`STATUS_SEED_ON_READY=false` (eager status reads can get a freshly linked
device unlinked). If another app shares the OpenWA service, change these only
together with that app, because they restart OpenWA for both.

The whatsapp-web.js and Baileys authentication folders are different. An
existing Chromium session does not create Baileys credentials, so plan for a
fresh linked-device QR/pairing step when switching this account. Keep the old
session data until the Baileys connection and history coverage are verified.

## 2. Give WABrain read-only access

OpenWA API keys have one of three roles: `viewer` < `operator` < `admin`
(`src/modules/auth/entities/api-key.entity.ts` in `rmyndharis/OpenWA`). Every
route WABrain reads needs only a valid key, so it gets a **viewer** key.
An `operator` key can send, react, delete, and manage the session, and an
`admin` key can also create keys; WABrain must hold neither.

| What | Role needed | Who uses it |
| --- | --- | --- |
| `GET /api/health` | none (public) | setup checks |
| `GET /api/sessions`, `GET /api/sessions/:id` | viewer | setup checks |
| `GET /api/sessions/:id/chats` | viewer | setup checks, history import |
| `GET /api/sessions/:id/messages` | viewer, **without** a chat allowlist | history import |
| `GET /api/sessions/:id/messages/:chatId/:messageId/media` | viewer | worker (media) |
| `GET /api/sessions/:id/qr` (pairing QR code) | operator | the OpenWA dashboard only |
| `POST /api/sessions/:id/webhooks` | operator | the one-time step 3 |
| creating API keys | admin | you, in the OpenWA dashboard |

Create the key in the OpenWA dashboard under **API Keys** (signed in with the
admin key):

- **Role:** `viewer`.
- **Allowed sessions:** only the WABrain session. A key limited to one
  session gets `401` for every other session.
- **Allowed chats:** leave empty. OpenWA refuses the session-wide message list
  (`403`) to a key with a chat allowlist, and the history import needs it.
- **Allowed IPs:** optional; the address the WABrain API and worker
  connect from.

Then set, on the WABrain API and worker:

```dotenv
OPENWA_BASE_URL=http://openwa:2785          # how the server reaches OpenWA
OPENWA_SESSION_ID=0a941dac-...              # the session's id (a UUID), not its name
OPENWA_READ_API_KEY=...                     # the viewer key
OPENWA_DASHBOARD_URL=https://openwa.example.com   # optional, see step 4
```

On Railway, `OPENWA_BASE_URL` is OpenWA's private address
(`http://<openwa-service>.railway.internal:<port>`) or its public `https://`
URL; see [DEPLOY.md, A.6](DEPLOY.md#a6-variables).

`OPENWA_SESSION_ID` is also the only session whose webhooks are accepted. If
you leave it empty, `GET /setup/openwa/status` lists the sessions the key can
see so you can copy the id. Never use the OpenWA admin key or an operator key
as `OPENWA_READ_API_KEY`.

## 3. Register signed events

Registering the webhook needs the `operator` role. The repository ships a
script for it, `deploy/scripts/register-webhook.mjs`, which registers
`message.received` and `message.sent` with `retryCount` 5, updates the
webhook instead of duplicating it when the URL already exists, and never
prints a key:

- **Compose bundle:** run `deploy/register-webhook.sh`. It mints an operator
  key scoped to the session that expires in 10 minutes, registers the webhook
  at `http://api:8787/webhooks/openwa` on the internal network (OpenWA allows
  only the `api` host through `SSRF_ALLOWED_HOSTS`), and deletes the key. See
  [DEPLOY.md, B.6](DEPLOY.md#b6-register-the-webhook).
- **Railway:** run the `.mjs` script from your own machine with a short-lived
  operator key and the API's public webhook URL. See
  [DEPLOY.md, A.8](DEPLOY.md#a8-register-the-webhook).

Or do it by hand, in the OpenWA dashboard or with a temporary operator key
limited to the session with a short expiry:

```bash
curl -X POST "$OPENWA_BASE_URL/api/sessions/$OPENWA_SESSION_ID/webhooks" \
  -H "X-API-Key: $OPENWA_OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://brain-api.example.com/webhooks/openwa",
    "events": ["message.received", "message.sent"],
    "secret": "REPLACE_WITH_THE_SAME_LONG_RANDOM_SECRET",
    "retryCount": 5
  }'
```

The same secret goes in WABrain as `OPENWA_WEBHOOK_SECRET`. After the
webhook is registered, revoke the temporary operator key; WABrain never
needs it at runtime.

## 4. Pair WhatsApp in the OpenWA dashboard

OpenWA serves the pairing QR code only to `operator` keys
(`GET /api/sessions/:id/qr`), and an operator key can also send messages. So
WABrain does not show the QR code itself: `GET /setup/openwa/qr` returns
a link to the OpenWA dashboard's **Sessions** page, and the setup page shows
the pairing steps. Start the session there and scan the QR code with WhatsApp
(**Settings → Linked devices → Link a device**).

The link comes from `OPENWA_DASHBOARD_URL`, or from `OPENWA_BASE_URL` when
that is an `https://` address. An internal address such as
`http://openwa:2785` is not reachable from a browser. In the compose bundle
the dashboard is published on the server's `127.0.0.1:2785` only, and
`OPENWA_DASHBOARD_URL` defaults to `http://127.0.0.1:2785`, so the link works
through an SSH tunnel: `ssh -L 2785:127.0.0.1:2785 you@your-server`. Sign in
there with `OPENWA_API_MASTER_KEY` from `deploy/.env`. Do not publish the
dashboard on a public address.

## 5. Check the connection from the setup page

- `GET /setup/openwa/status` reports whether OpenWA answers, the session's
  state (`created`, `qr_ready`, `ready`, `disconnected`, ...), the linked
  account, and what is wrong when something is (for example
  `unauthorized` for a wrong, revoked, or wrongly scoped key, or
  `invalid_session_id` when `OPENWA_SESSION_ID` is a name instead of the id).
- `POST /setup/openwa/test` runs these checks, all with GET requests: OpenWA
  reachable, key accepted for the session, WhatsApp linked, chats readable,
  stored messages readable. It also warns when the key is more powerful than
  it should be: when it can reach an operator-only route (the webhook list; the
  answer is discarded) or can see other sessions.

The role check leaves one "Insufficient permissions" entry in OpenWA's audit
log each time the test runs with a correct viewer key. That entry is expected.

## 6. Verify before importing

1. Confirm OpenWA reports `ready` on the Baileys engine.
2. Send an inbound test message and verify a `202` webhook delivery.
3. Send a message from the phone and verify `message.sent` is captured too.
   Outgoing messages are analyzed like incoming ones and can create, update,
   and close tasks.
4. Retry the same webhook and verify it is deduplicated.
5. Inspect the earliest timestamp returned by OpenWA's stored-message endpoint.
6. Test one image, voice note, and PDF through the stored-media endpoint.

Only after those checks should the 90-day history import and model analysis
be enabled. Imported history feeds people, contexts, and search; it never
proposes tasks.
