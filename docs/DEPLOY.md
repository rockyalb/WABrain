# Deploying WABrain

This guide covers two topologies:

- **[Docker Compose](#part-a-docker-compose-everything-on-one-server)**
  (recommended): the self-host bundle in `deploy/` runs **everything on one
  server**, including OpenWA with its Baileys engine, Postgres with pgvector,
  the API, the worker, and optionally ntfy and Caddy. You set up OpenWA and pair
  WhatsApp first, then start the rest.
- **[Railway](#part-b-railway)**: the API, the worker, and Postgres as Railway
  services, next to an OpenWA service in the same project (a new one, or one you
  already run).

The order is always the same: **OpenWA and WhatsApp pairing first**, then
WABrain, then the webhook that connects them, then the setup page.

Day-2 work (backups, restore, upgrades, wiping, secret rotation, revoking
phones) is in [OPERATIONS.md](OPERATIONS.md). The OpenWA key roles and the
connection checks are in [OPENWA_SETUP.md](OPENWA_SETUP.md).

> **Account risk.** OpenWA's Baileys engine is an unofficial WhatsApp client.
> WhatsApp can restrict or ban accounts that use one. Read
> [the risk section in OPERATIONS.md](OPERATIONS.md#whatsapp-account-risk)
> before you pair a real account.

## What runs where

| Component | Holds | Talks to |
| --- | --- | --- |
| OpenWA | The WhatsApp link (Baileys credentials), its own stored messages and media, the OpenWA admin key | WhatsApp; sends signed webhooks to the API |
| API (`deploy/docker/api.Dockerfile`) | Serves the setup page at `/`, `/webhooks/openwa`, `/setup/*`, and `/v1/*` for the app | Postgres; OpenWA with the **read (viewer) key** only |
| Worker (`deploy/docker/worker.Dockerfile`) | Jobs: projection, analysis, media, profiles, reminders, daily summary, history import, Web Push | Postgres; OpenWA (read key); model providers; push distributor |
| Postgres 17 + pgvector | All WABrain data, the job queue (`pgboss` schema), VAPID keys | Only the API and the worker |
| ntfy (optional) | UnifiedPush topics for the Android app | The phone; receives pushes from the API and worker |

The API and the worker both apply database migrations on start
(`RUN_MIGRATIONS=true`, the default). A Postgres advisory lock stops them from
migrating at the same time. For small installs the worker can run inside the
API process (`EMBEDDED_WORKER=true`), so you need one service fewer.

Both processes validate their configuration at start. When a variable is
missing or a secret is weak they exit with code **78** and name the variable
(never its value) in the log.

---

## Part A: Docker Compose (everything on one server)

### A.1 Requirements

- A Linux server with Docker Engine and the Docker Compose v2 plugin, an
  encrypted disk (see [SECURITY.md](SECURITY.md)), and SSH access.
- A DNS name for the API and setup page (`BRAIN_DOMAIN`), and optionally one
  for ntfy (`NTFY_DOMAIN`), both pointing at the server.
- Ports 80 and 443 (TCP, plus 443/UDP for HTTP/3) open for Caddy. Nothing else
  needs to be public: OpenWA and the API are published on `127.0.0.1` only,
  and Postgres sits on an internal network without a host port.

### A.2 Get the code and generate secrets

```bash
git clone https://github.com/rockyalb/WABrain.git wabrain
cd wabrain
deploy/init.sh
```

`init.sh` copies `deploy/.env.example` to `deploy/.env` (mode 600) and fills in
every blank secret: `POSTGRES_PASSWORD`, `OPENWA_WEBHOOK_SECRET`,
`SETUP_BOOTSTRAP_TOKEN`, `APP_ENCRYPTION_KEY`, `OPENWA_API_MASTER_KEY`, and
`OPENWA_API_KEY_PEPPER`. It never overwrites a value that is already set and
never prints one, so it is safe to run again. Keep a copy of `deploy/.env` in
your password manager; see [OPERATIONS.md](OPERATIONS.md#backups).

### A.3 Edit `deploy/.env`

At least:

| Variable | What to put there |
| --- | --- |
| `BRAIN_DOMAIN` | The API and setup page's domain. Caddy requests its certificate |
| `VAPID_SUBJECT` | `mailto:you@example.com` or an `https:` URL |
| `SELF_JID`, `SELF_ALIASES` | Your WhatsApp JID(s) and the names that count as addressing you in groups |
| `NTFY_DOMAIN` | With the `push` profile: ntfy's public domain |
| `COMPOSE_PROFILES` | Add `COMPOSE_PROFILES=push,https` so every `docker compose` command includes ntfy and Caddy without extra flags |

`PUBLIC_BASE_URL` defaults to `https://$BRAIN_DOMAIN` and `TRUST_PROXY` is
`true` in the example file, which is right behind Caddy. Leave
`OPENWA_SESSION_ID` and `OPENWA_READ_API_KEY` empty for now; you create them
in A.4.

Compose reads `deploy/.env` because it sits next to the compose file. All
commands below run from the repository root.

### A.4 Start OpenWA and pair WhatsApp first

Start only the OpenWA service. It needs nothing else from the bundle:

```bash
docker compose -f deploy/docker-compose.yml up -d openwa
docker compose -f deploy/docker-compose.yml logs -f openwa   # wait until it listens on 2785
```

The OpenWA dashboard is published on `127.0.0.1:2785` of the server only
(`OPENWA_PORT`). Reach it through an SSH tunnel from your computer:

```bash
ssh -L 2785:127.0.0.1:2785 you@your-server
```

Then, on your computer:

1. Open `http://127.0.0.1:2785` and sign in with the admin key. It is
   `OPENWA_API_MASTER_KEY` in `deploy/.env`
   (`grep '^OPENWA_API_MASTER_KEY=' deploy/.env` on the server).
2. Create a session, start it, and scan the QR code with WhatsApp on your
   phone: **Settings → Linked devices → Link a device**. Wait until the
   session reports `ready`.
3. Copy the session's **id** (a UUID, not its name).
4. Under **API Keys**, create WABrain's key: role **viewer**, allowed
   sessions = only this session, **no** allowed chats. See
   [OPENWA_SETUP.md, step 2](OPENWA_SETUP.md#2-give-wabrain-read-only-access).

Put the two values into `deploy/.env`:

```dotenv
OPENWA_SESSION_ID=<session uuid>
OPENWA_READ_API_KEY=<viewer key>
```

Pairing on a laptop instead of a server works the same way without the
tunnel: open `http://127.0.0.1:2785` directly.

The setup page links to the dashboard for pairing. In the bundle that link is
`OPENWA_DASHBOARD_URL`, which defaults to `http://127.0.0.1:2785`, so it works
while the tunnel is open on the same port. Keep the tunnel local: exposing the
dashboard publicly would expose the admin login.

### A.5 Start WABrain

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

Without `COMPOSE_PROFILES` in `.env`, pass the profiles explicitly. They are
global flags and go **before** `up`:

```bash
docker compose -f deploy/docker-compose.yml --profile push --profile https up -d --build
```

This builds the API and worker images and starts `postgres`, `api`, `worker`,
and, with the profiles, `ntfy` and `caddy`, next to the `openwa` service that is
already running. After changing `deploy/.env` later, run the same `up -d`
command again to recreate the services that use it. Check them:

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f api worker
curl -fsS https://$BRAIN_DOMAIN/health        # {"ok":true}
```

The profiles:

- **`https`** runs Caddy on ports 80 and 443. It gets a certificate for
  `BRAIN_DOMAIN` (and `NTFY_DOMAIN`) and proxies to the API and ntfy. The
  OpenWA dashboard is deliberately not proxied.
- **`push`** runs ntfy as the UnifiedPush distributor. It denies everything
  except anonymous read/write on the random `up*` topics that UnifiedPush
  uses, and allows logins for users you create yourself.

### A.6 Register the webhook

```bash
deploy/register-webhook.sh
```

The script runs `deploy/scripts/register-webhook.mjs` in a one-off API
container on the compose network. It reads the admin key from
`OPENWA_API_MASTER_KEY` in `deploy/.env` and hands it only to that container,
which mints an operator key scoped to the session that expires in 10 minutes,
registers (or updates) the webhook, and deletes the key again. The running API
and worker never see the admin key.

- The default webhook URL is `http://api:8787/webhooks/openwa`, on the
  internal network. OpenWA keeps its SSRF protection on and allows only the
  `api` host (`SSRF_ALLOWED_HOSTS=api`).
- To use an operator key you created yourself instead of the admin key:
  `OPENWA_OPERATOR_KEY=... deploy/register-webhook.sh` (then revoke it).
- To register the public URL instead (for example when OpenWA runs
  elsewhere): `WEBHOOK_URL=https://$BRAIN_DOMAIN/webhooks/openwa deploy/register-webhook.sh`.
- Extra arguments go to `docker compose`, for example `-p myproject`.
- Re-running it is safe: it updates the existing webhook with the same URL.
  Run it again after rotating `OPENWA_WEBHOOK_SECRET`.

### A.7 Push notifications

With the `push` profile and `NTFY_DOMAIN` set, install the ntfy app on the
phone (F-Droid or the ntfy website) and set its default server to
`https://$NTFY_DOMAIN`. The WABrain app then offers ntfy as its
UnifiedPush distributor.

Set `NTFY_HOST` to `NTFY_DOMAIN` only when that name resolves to a private
address from inside the containers (split DNS, LAN-only servers). Otherwise the
API's SSRF guard rejects push endpoints on private addresses, as it should.

You can skip the `push` profile and use ntfy.sh or any other distributor on
the phone; payloads are encrypted end to end either way.

### A.8 Variants

- **Your own reverse proxy instead of Caddy.** Drop the `https` profile, set
  `PUBLIC_BASE_URL` to the public https URL, keep `API_BIND_ADDRESS=127.0.0.1`
  if the proxy runs on the host (it reaches the API on
  `127.0.0.1:$API_PUBLISH_PORT`), and set `TRUST_PROXY=true` only if the proxy
  sets `X-Forwarded-For`.
- **Embedded worker.** Set `EMBEDDED_WORKER=true` and stop the separate
  worker: `docker compose -f deploy/docker-compose.yml up -d --scale worker=0`.
- **An existing OpenWA elsewhere.** Set `OPENWA_BASE_URL` (and
  `OPENWA_DASHBOARD_URL`) to it and register the webhook with its public
  `WEBHOOK_URL`, as in [B.8](#b8-register-the-webhook). The bundled `openwa`
  service then just idles; stop it with
  `docker compose -f deploy/docker-compose.yml up -d --scale openwa=0`.

---

## Part B: Railway

OpenWA runs as a Railway service with the Baileys engine and a volume on
`/app/data`. You add three services (or two with the embedded worker) to the
**same Railway project and environment** as OpenWA, so they can reach each
other over Railway's private network.

> **What this guide is sure about and what it is not.** Railway services,
> service variables and variable references (`${{Service.VAR}}`), shared
> variables, volumes, generated public domains, the healthcheck path, and
> private networking (`<service>.railway.internal`) are standard Railway
> features. The following have **not** been tested against Railway with this
> repository; they are marked *Unverified* where they come up:
> the Dockerfile cache mounts (see [B.4](#b4-api-service)), the exact name of
> the pgvector template, and whether OpenWA answers on the private network.

### B.1 OpenWA first

- **New OpenWA:** deploy the image `ghcr.io/rmyndharis/openwa` (the version the
  compose bundle pins) as a Railway service with a volume on `/app/data`, a
  public domain on port 2785, and the `openwa` environment from
  `deploy/docker-compose.yml` (`ENGINE_TYPE=baileys`, `BAILEYS_AUTH_DIR`,
  `BAILEYS_SYNC_FULL_HISTORY=true`, `BAILEYS_MARK_ONLINE_ON_CONNECT=false`,
  `STATUS_SEED_ON_READY=false`, `AUTO_START_SESSIONS=true`, `DATABASE_TYPE=sqlite`,
  `STORAGE_TYPE=local`, and a generated `API_MASTER_KEY` and `API_KEY_PEPPER`).
  Then pair WhatsApp in its dashboard as in
  [OPENWA_SETUP.md, step 4](OPENWA_SETUP.md#4-pair-whatsapp-in-the-openwa-dashboard).
- **Existing OpenWA:** switch it to Baileys if it runs another engine
  ([OPENWA_SETUP.md, step 1](OPENWA_SETUP.md#1-switch-an-existing-openwa-to-baileys)).
  If another app already uses the session, **do not re-pair** it and do not
  touch that app's webhook; changing OpenWA variables restarts it for both apps.
- Either way, WABrain gets its **own** webhook on the session and its **own**
  OpenWA API key with the `viewer` role. It never gets the admin key or an
  operator key.

### B.2 Generate the WABrain secrets

Railway needs three generated secrets: `OPENWA_WEBHOOK_SECRET`,
`SETUP_BOOTSTRAP_TOKEN`, and `APP_ENCRYPTION_KEY`. The easiest way is to let
`deploy/init.sh` write them into a temporary file (it never prints them):

```bash
deploy/init.sh /tmp/wabrain-railway.env
grep -E '^(OPENWA_WEBHOOK_SECRET|SETUP_BOOTSTRAP_TOKEN|APP_ENCRYPTION_KEY)=' /tmp/wabrain-railway.env
```

Copy those three values into Railway (B.6), store them in your password
manager, then delete the file: `rm /tmp/wabrain-railway.env`. The other
secrets that `init.sh` generates (`POSTGRES_PASSWORD`, `OPENWA_API_MASTER_KEY`,
`OPENWA_API_KEY_PEPPER`) belong to the compose bundle and are not used on
Railway.

`APP_ENCRYPTION_KEY` encrypts the model-provider keys you enter on the setup
page. If you lose it you have to enter those keys again; keep a copy.

### B.3 Postgres with pgvector

WABrain needs the `vector` and `pg_trgm` extensions. The first migration
runs `CREATE EXTENSION IF NOT EXISTS vector` and `pg_trgm`, which needs a
superuser (the default user of the Railway Postgres images is `postgres`).

Pick one of:

1. **A pgvector template** from Railway's template marketplace (search for
   "pgvector"). *Unverified:* the template's name and Postgres version. It must
   ship the `vector` extension.
2. **An image service**: create an empty service from the Docker image
   `pgvector/pgvector:pg17` (the image the compose bundle uses), attach a
   volume at `/var/lib/postgresql/data`, and set `POSTGRES_USER`,
   `POSTGRES_PASSWORD`, `POSTGRES_DB`, and
   `PGDATA=/var/lib/postgresql/data/pgdata`. The `PGDATA` subdirectory avoids
   `initdb` failing on a volume that is not empty (a fresh volume can contain
   `lost+found`).

Do **not** give this service a public domain. Before you deploy the API, check
that the extensions are available (from the service's shell, or with `psql`
against the database):

```sql
select name, default_version from pg_available_extensions where name in ('vector', 'pg_trgm');
```

Both rows must be present. The plain Railway Postgres service may not ship
`vector`; if the query returns only `pg_trgm`, use one of the options above.
`vector` should be **0.8 or newer**: search then turns on pgvector's
iterative index scan, so searches filtered by person, context, or date still
return enough results. Older versions work, but filtered searches may return
fewer hits. (`pgvector/pgvector:pg17` shipped 0.8.6 when this was written.)

### B.4 API service

1. **New service → GitHub repo**, pointing at this repository and the branch
   you deploy from. Leave the root directory at the repository root: the
   Dockerfiles build the whole pnpm workspace.
2. Tell Railway which Dockerfile to use by setting the service variable
   `RAILWAY_DOCKERFILE_PATH=deploy/docker/api.Dockerfile`.
3. **Healthcheck path:** `/health` (Settings → Deploy). Railway does not use
   the Dockerfile's `HEALTHCHECK`.
4. **Public domain:** generate one (or add your own domain) and point it at
   port **8787**. The image sets `API_PORT=8787`, which wins over the `PORT`
   variable Railway injects, so the domain must target 8787.
5. Set the variables from [B.6](#b6-variables).

*Unverified:* the Dockerfiles use BuildKit cache mounts
(`RUN --mount=type=cache,id=wabrain-pnpm-store,...`). Railway's builder has
its own rules for cache mount ids and may reject these. If the build fails on
a cache mount, remove the `--mount=type=cache,...` part of those `RUN` lines;
the fix belongs in the Dockerfiles, not in Railway settings.

### B.5 Worker service

Either:

- **Separate worker** (recommended once you process real traffic): a second
  service from the same repository with
  `RAILWAY_DOCKERFILE_PATH=deploy/docker/worker.Dockerfile`. It has no HTTP
  port, so give it **no public domain** and no healthcheck path. Its variables
  are in B.6.
- **Embedded worker**: skip this service and set `EMBEDDED_WORKER=true` on the
  API. The API then needs every worker variable as well.

The API's setup page shows the worker as healthy when it has written a
heartbeat within the last two minutes.

### B.6 Variables

Put the variables that the API and the worker share into Railway's **shared
variables** (or set them on both services), so that both processes see the
same model providers and the same encryption key. If they differ, the setup
page shows a different provider configuration from the one the worker uses.

| Variable | API | Worker | Value on Railway |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | yes | A reference to the Postgres service, for example `${{Postgres.DATABASE_URL}}` (use your service's name). For the image service: `postgres://USER:PASSWORD@<service>.railway.internal:5432/DB` |
| `PUBLIC_BASE_URL` | yes | – | `https://<the API's domain>`; goes into the phone pairing QR code, must be https |
| `TRUST_PROXY` | yes | – | `true` (Railway's proxy sets `X-Forwarded-For`; the rate limits need the real client IP) |
| `OPENWA_WEBHOOK_SECRET` | yes | – | From B.2 |
| `SETUP_BOOTSTRAP_TOKEN` | yes | – | From B.2 |
| `APP_ENCRYPTION_KEY` | yes | yes | From B.2 (shared) |
| `OPENWA_BASE_URL` | yes | yes | How the services reach OpenWA, see below (shared) |
| `OPENWA_SESSION_ID` | yes | yes | The session's UUID, see B.7 (shared) |
| `OPENWA_READ_API_KEY` | yes | yes | The viewer key, see B.7 (shared) |
| `OPENWA_DASHBOARD_URL` | yes | – | OpenWA's public https URL. Optional when `OPENWA_BASE_URL` is already that https URL |
| `SELF_JID`, `SELF_ALIASES` | yes | yes | Your JID(s) and name aliases for group mentions (shared) |
| `VAPID_SUBJECT` | yes | yes | `mailto:you@example.com` or an `https:` URL (shared) |
| `NTFY_HOST` | yes | yes | Only for a self-hosted ntfy whose name resolves to a private address |
| `AI_*` | yes | yes | Optional fallback provider settings (shared); the setup page can store them instead |
| `EMBEDDED_WORKER` | yes | – | `true` only when there is no worker service |
| `LOG_LEVEL`, `SESSION_TTL_HOURS`, pipeline timings | optional | optional | See `deploy/.env.example` |

`NODE_ENV=production`, `HOST`, and `API_PORT` are set by the images. Every
variable is documented in [`deploy/.env.example`](../deploy/.env.example).

**Reaching OpenWA (`OPENWA_BASE_URL`).** Prefer the private network:
`http://<openwa-service>.railway.internal:<port OpenWA listens on>`. The read
key then never crosses the internet. *Unverified:* depending on the
environment, Railway's private network may be IPv6-only, and OpenWA must
listen on it. If `GET /setup/openwa/status` reports OpenWA as unreachable,
use OpenWA's public `https://` URL instead; that also makes
`OPENWA_DASHBOARD_URL` unnecessary.

### B.7 Session id and read key

In the OpenWA dashboard (signed in as admin):

1. Open **Sessions** and copy the id of the paired session.
   It is a UUID; OpenWA rejects the session name.
2. Under **API Keys**, create a key with role **viewer**, allowed sessions =
   only that session, and **no** allowed chats (the history import needs the
   session-wide message list). Details and the reasons are in
   [OPENWA_SETUP.md, step 2](OPENWA_SETUP.md#2-give-wabrain-read-only-access).
3. Set `OPENWA_SESSION_ID` and `OPENWA_READ_API_KEY`, and deploy the API and
   the worker.

If `OPENWA_SESSION_ID` is left empty, `GET /setup/openwa/status` lists the
sessions the read key can see, so you can copy the id from there.

### B.8 Register the webhook

`deploy/register-webhook.sh` drives Docker Compose and only works for the
compose bundle. On Railway, run the script it wraps,
`deploy/scripts/register-webhook.mjs`, from your own machine (Node 22, no
dependencies, no `pnpm install` needed). It registers the webhook for
`message.received` and `message.sent` with `retryCount` 5, or updates the
webhook whose URL matches, and never prints a key or secret.

1. In the OpenWA dashboard, create a short-lived key with role **operator**,
   allowed sessions = only the WABrain session, and an expiry of a few
   minutes. (Alternatively give the script the admin key as
   `OPENWA_ADMIN_KEY`; it then mints and deletes a 10-minute operator key
   itself. The operator key route keeps the admin key off your laptop.)
2. Put the values in a private file, so they do not end up in your shell
   history:

   ```dotenv
   # /tmp/wabrain-webhook.env  (chmod 600, delete afterwards)
   OPENWA_BASE_URL=https://<openwa public domain>
   OPENWA_SESSION_ID=<session uuid>
   OPENWA_WEBHOOK_SECRET=<the same value as on the API>
   WEBHOOK_URL=https://<the API's domain>/webhooks/openwa
   OPENWA_OPERATOR_KEY=<the short-lived operator key>
   ```

3. Run it and clean up:

   ```bash
   node --env-file=/tmp/wabrain-webhook.env deploy/scripts/register-webhook.mjs
   rm /tmp/wabrain-webhook.env
   ```

4. Revoke the operator key in the OpenWA dashboard (the script reminds you).

The webhook targets the API's public HTTPS URL, so OpenWA's SSRF protection
stays on. You can also add the webhook by hand in the OpenWA dashboard with the
same URL, both events, and the same secret.

### B.9 First login, providers, history, phone

Continue with [Part C](#part-c-finish-setup-on-the-setup-page). Open the setup
page at `PUBLIC_BASE_URL` itself; the setup API only accepts requests from
that origin.

### B.10 Push on Railway

The Android app receives pushes through a UnifiedPush distributor. Two options:

- **ntfy.sh** (the public ntfy server, the default in the ntfy Android app).
  Nothing to deploy. Push payloads are end-to-end encrypted with the keys the
  phone registers, so ntfy.sh only relays ciphertext. It does see delivery
  metadata such as timing.
- **Your own ntfy** as another Railway service from the image
  `binwiederhier/ntfy` (command `serve`), with a volume for its cache and auth
  database and a public domain. Copy the access-control settings from the
  `ntfy` service in `deploy/docker-compose.yml` (`NTFY_AUTH_DEFAULT_ACCESS=deny-all`,
  `NTFY_AUTH_ACCESS=*:up*:rw`, `NTFY_BEHIND_PROXY=true`, and `NTFY_BASE_URL`
  set to its public URL). Then point the ntfy app on the phone at that server.

Without a distributor the app still syncs every 15 minutes.

---

## Part C: Finish setup on the setup page

Open the setup page at `PUBLIC_BASE_URL` (`https://$BRAIN_DOMAIN` in the
bundle). Always use that exact address: the setup API rejects requests from
any other origin, and its session cookie is `Secure`. Opening the API through
an SSH tunnel on another address does not work for signing in.

1. **Create the owner account.** On the first visit the page asks for a
   password and the setup token, which is `SETUP_BOOTSTRAP_TOKEN`. After the
   owner exists the token has no further use.
2. **Model providers.** Enter the provider, model, and key for each role
   (text, vision, transcription, embedding). Keys are encrypted with
   `APP_ENCRYPTION_KEY` and never shown again. Without
   `APP_ENCRYPTION_KEY`, saving a key fails with 409. Roles you leave empty
   fall back to the `AI_*` variables.
3. **WhatsApp.** The page shows the OpenWA status. Run the connection test
   (`POST /setup/openwa/test`); it uses GET requests only and warns when the
   read key is more powerful than a viewer key. Then follow
   [OPENWA_SETUP.md, step 6](OPENWA_SETUP.md#6-verify-before-importing).
4. **History import.** Check the coverage OpenWA already holds, then start the
   90-day import. Imported history feeds people, contexts, and search; it never
   proposes tasks.
5. **Pair the Android app.** Under phones, create a pairing code. The page
   shows a QR code with a link of the form
   `wabrain://pair?server=<PUBLIC_BASE_URL>&code=<one-time code>`. Scan it in
   the app (or open the link on the phone); the app exchanges the code for its
   own device token (`POST /v1/devices/pair`). The code works once and expires
   after 10 minutes. The server address must be https. Each phone gets its own
   token, which you can revoke on the same page.

The setup screens are connected. An unavailable state reports missing configuration
or a failed connection; use the OpenWA and provider tests to inspect it.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| API or worker restarts with exit code 78 | Invalid configuration. The log names the variable (`PUBLIC_BASE_URL: must be https`, a secret that is too short or looks like a placeholder, a malformed `APP_ENCRYPTION_KEY` or `VAPID_SUBJECT`) |
| Setup page: "Cross-origin request rejected" | The page was opened at an address other than `PUBLIC_BASE_URL` / `SETUP_ORIGIN` |
| Saving a provider key returns 409 | `APP_ENCRYPTION_KEY` is not set on the API |
| OpenWA webhook deliveries fail with 401 | `OPENWA_WEBHOOK_SECRET` differs between the API and the registered webhook; re-run the registration |
| Webhook deliveries fail with 403 "Unexpected OpenWA session" | The webhook belongs to a session other than `OPENWA_SESSION_ID` |
| OpenWA status `unauthorized` | The read key is wrong, revoked, or not allowed for the session |
| OpenWA status `invalid_session_id` | `OPENWA_SESSION_ID` is the session's name instead of its UUID |
| "OpenWA read access is not configured; media will be skipped" in the worker log | `OPENWA_BASE_URL` or `OPENWA_READ_API_KEY` is missing on the worker |
| Worker shown as not running on the setup page | No heartbeat for two minutes: the worker is down, or `EMBEDDED_WORKER` is false and no worker service runs |
